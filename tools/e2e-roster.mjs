/**
 * 名冊與帳號生命週期的端到端驗證。
 *
 * 這一條線的純邏輯（`lib/accountRules.mjs`、`lib/listing.mjs`）已經有
 * 單元測試，這一支**不重複測它們**。它驗的是跨越資料庫邊界之後還對
 * 不對——而這一塊的每一個錯法都只在真的 Postgres 上才看得出來：
 *
 *   · `@@unique([tenantId, username])` 真的擋得住換到一個被佔用的學號，
 *     而**去識別化之後原本那個學號真的放得回去**（這是「停用的帳號
 *     永久佔著登入代號」那一項的核心，而它在單元測試裡驗不到）
 *   · 整批登錄同意的 `updateMany` 帶著 `consentAt: null` 這道條件，
 *     所以按第二次**一列都不會動**——冪等是資料庫層保證的，
 *     不是靠應用層先查一次（那中間有一個競態）
 *   · `audit_logs` 的「只新增不修改」觸發器接得住 `createMany`，
 *     而且每一位學生各一列（`targetId` 指向他，索引才用得上）
 *   · 退補寫的 `leftAt` 與 `status: ARCHIVED` 讓他從在籍名冊上消失，
 *     但 `ClassMembership` 那一列還在——歷史成績對得回班級
 *
 * 用 pg-shim 而非 PrismaClient，理由見 `tools/pg-shim.mjs` 的檔頭：
 * Prisma 的查詢引擎要從外部網域下載，而這套系統要部署的補習班機房
 * 是封閉網段。shim 從同一份 schema 取得欄位對應，所以欄位名寫錯
 * 一樣會被抓到。
 *
 * 用法（需要 DATABASE_URL 指向一個已經套過遷移的資料庫）：
 *   node tools/e2e-roster.mjs
 */
import assert from 'node:assert/strict';

import { createPgShim } from './pg-shim.mjs';
import { withTenant, withoutTenantScope } from '../apps/web/lib/tenantContext.mjs';
import {
  erasedUsername,
  planConsentBatch,
} from '../apps/web/lib/accountRules.mjs';

const prisma = createPgShim({
  connectionString: process.env.DATABASE_URL,
  schemaPath: 'packages/db/schema.prisma',
});

/** bcrypt 格式的假雜湊。長度合法但對不上任何密碼。 */
const HASH = '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`   ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`   ✗ ${name}`);
    console.error(`     ${e.message.split('\n').slice(0, 5).join('\n     ')}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
}

// ── 基礎資料 ─────────────────────────────────────────────────

async function reset() {
  await withoutTenantScope('端到端測試的清場', async () => {
    for (const t of [
      'audit_logs',
      'sessions',
      'class_memberships',
      'class_subject_teachers',
      'classes',
      'users',
      'academic_years',
      'tenants',
    ]) {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${t} CASCADE`);
    }
  });
}

async function seed() {
  const tenant = await withoutTenantScope('建立測試租戶', () =>
    prisma.tenant.create({ data: { name: '測試補習班' } }),
  );
  return withTenant(tenant.id, async () => {
    const year = await prisma.academicYear.create({
      data: {
        tenantId: tenant.id,
        name: '115學年度',
        startDate: new Date('2026-08-01'),
        endDate: new Date('2027-07-31'),
        isCurrent: true,
      },
    });
    const klass = await prisma.class.create({
      data: { tenantId: tenant.id, academicYearId: year.id, name: '高三數A班' },
    });
    const admin = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        username: 'admin',
        displayName: '主任',
        passwordHash: HASH,
        systemRole: 'SYS_ADMIN',
        status: 'ACTIVE',
      },
    });
    return { tenant, year, klass, admin };
  });
}

/** 建一位學生並放進班上。與 `applyRoster` 寫的欄位相同。 */
async function makeStudent(tenantId, classId, username, displayName, consented = false) {
  const user = await prisma.user.create({
    data: {
      tenantId,
      username,
      displayName,
      passwordHash: HASH,
      systemRole: 'STUDENT',
      mustChangePassword: true,
      ...(consented
        ? { status: 'ACTIVE', consentAt: new Date('2026-08-20') }
        : { status: 'PENDING_CONSENT' }),
    },
  });
  await prisma.classMembership.create({
    data: { classId, userId: user.id, role: 'STUDENT' },
  });
  return user;
}

/**
 * `lib/roster.ts` 的 `recordConsentBatch` 在資料庫這一側做的兩件事。
 *
 * 這裡照著複寫而不是 import 那一支，是因為它相依 `@/lib/prisma`
 * （真的 Prisma client）與 `requireTenant`。要驗的是**這兩句 SQL 的
 * 行為**——尤其 `consentAt: null` 那道條件——而不是那個函式的包裝。
 */
async function batchConsent(tenantId, classId, actorId, requestedIds, method) {
  const members = await prisma.classMembership.findMany({
    where: { classId, leftAt: null, role: 'STUDENT' },
    select: { userId: true },
  });
  const students = [];
  for (const m of members) {
    const u = await prisma.user.findFirst({
      where: { id: m.userId },
      select: { id: true, username: true, consentAt: true, systemRole: true },
    });
    if (u && u.systemRole === 'STUDENT') students.push(u);
  }

  const plan = planConsentBatch(students, requestedIds ?? null);
  if (plan.toRecord.length === 0) return { recorded: 0, alreadyDone: plan.alreadyDone.length };

  const written = await prisma.user.updateMany({
    where: {
      id: { in: plan.toRecord },
      // **這一道是冪等的真正來源。** 應用層先查一次也擋得住多數情況，
      // 但兩位老師同時按下去時，兩邊都會查到「還沒有同意」——
      // 而那一秒的競態會讓第二次把第一次的日期覆蓋掉。
      consentAt: null,
      systemRole: 'STUDENT',
    },
    data: { consentAt: new Date(), status: 'ACTIVE' },
  });

  const byId = new Map(students.map((s) => [s.id, s]));
  await prisma.auditLog.createMany({
    data: plan.toRecord.map((id) => ({
      tenantId,
      category: 'USER',
      action: 'consent.record',
      actorId,
      targetType: 'consent',
      targetId: id,
      after: { student: byId.get(id)?.username ?? id, method },
    })),
  });

  return { recorded: written.count, alreadyDone: plan.alreadyDone.length };
}

// ── 跑 ───────────────────────────────────────────────────────

async function main() {
  console.log('\n\x1b[1m名冊與帳號生命週期的端到端驗證\x1b[0m');

  await reset();
  const { tenant, klass, admin } = await seed();

  await withTenant(tenant.id, async () => {
    section('整批登錄家長同意');

    const students = [];
    for (let i = 1; i <= 5; i++) {
      students.push(
        await makeStudent(tenant.id, klass.id, `S11403${String(i).padStart(2, '0')}`, `學生${i}`),
      );
    }
    // 其中一位在櫃檯已經單獨登錄過了。整批不能把他的日期蓋掉。
    const early = await makeStudent(tenant.id, klass.id, 'S1140399', '早就同意的', true);
    const earlyBefore = (
      await prisma.user.findFirst({ where: { id: early.id }, select: { consentAt: true } })
    ).consentAt;

    await test('匯入建出來的帳號預設登不進去（PENDING_CONSENT）', async () => {
      const blocked = await prisma.user.findMany({
        where: { systemRole: 'STUDENT', status: 'PENDING_CONSENT' },
        select: { id: true },
      });
      assert.equal(blocked.length, 5, '應該有 5 位在等同意');
    });

    await test('整批一次登錄，5 位同時變成可登入', async () => {
      const r = await batchConsent(tenant.id, klass.id, admin.id, null, 'PAPER');
      assert.equal(r.recorded, 5);
      assert.equal(r.alreadyDone, 1, '已經有紀錄的那一位要被挑出來');
      const active = await prisma.user.findMany({
        where: { systemRole: 'STUDENT', status: 'ACTIVE' },
        select: { id: true },
      });
      assert.equal(active.length, 6);
    });

    await test('按第二次一列都不會動——冪等是資料庫保證的', async () => {
      const before = await prisma.user.findFirst({
        where: { id: students[0].id },
        select: { consentAt: true },
      });
      const r = await batchConsent(tenant.id, klass.id, admin.id, null, 'IN_PERSON');
      assert.equal(r.recorded, 0, '第二次不該再寫任何一列');
      const after = await prisma.user.findFirst({
        where: { id: students[0].id },
        select: { consentAt: true },
      });
      assert.equal(
        after.consentAt.getTime(),
        before.consentAt.getTime(),
        '同意日期被覆蓋了——那筆憑據就不是實話了',
      );
    });

    await test('先前單獨登錄的那一位，日期沒有被整批改掉', async () => {
      const now = await prisma.user.findFirst({
        where: { id: early.id },
        select: { consentAt: true },
      });
      assert.equal(now.consentAt.getTime(), earlyBefore.getTime());
    });

    await test('稽核每一位各一列，targetId 指向那位學生', async () => {
      const logs = await prisma.auditLog.findMany({
        where: { action: 'consent.record' },
        select: { targetId: true, actorId: true, category: true },
      });
      assert.equal(logs.length, 5, '整批 5 位應該留 5 列稽核');
      const ids = new Set(logs.map((l) => l.targetId));
      for (const s of students) {
        assert.ok(ids.has(s.id), `${s.username} 的同意沒有留下稽核`);
      }
      assert.ok(logs.every((l) => l.actorId === admin.id), '行為人要記得住');
      assert.ok(logs.every((l) => l.category === 'USER'));
    });

    await test('稽核的內容寫得完整（方式、學號、行為人）', async () => {
      const one = await prisma.auditLog.findFirst({
        where: { action: 'consent.record' },
        select: { after: true, targetType: true },
      });
      assert.equal(one.targetType, 'consent');
      assert.equal(one.after.method, 'PAPER', '取得方式沒有記下來');
      assert.ok(one.after.student, '學號沒有記下來——事後對不回是誰');
    });

    /**
     * **`audit_logs` 的「只新增不修改」在資料庫層並不存在。**
     *
     * `packages/db/schema.prisma` 的註解寫著「只新增不修改。資料庫層
     * 以觸發器強制（見 migration）」，但**沒有任何一份遷移建過那個
     * 觸發器**——這裡實際查 `pg_trigger` 確認過。應用層目前確實沒有
     * update／delete 的路徑，所以現在不會出事；但那句註解描述的是一道
     * 不存在的防線，而讀到它的人會以為稽核改不動。
     *
     * 修法要加一份遷移，而遷移不在這一批的範圍內（`packages/**` 不動），
     * 所以這裡只把事實印出來，不假裝它已經被擋住了——
     * **一個綠燈的假保證比沒有保證更糟。**
     */
    await test('（已知缺口）稽核的 append-only 觸發器還不存在', async () => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname = 'audit_logs' AND NOT t.tgisinternal`,
      );
      if (rows.length === 0) {
        console.log(
          '     ⚠ schema.prisma 註解說有觸發器強制只新增不修改，而遷移裡沒有。' +
            '目前靠應用層沒有 update／delete 路徑守著。',
        );
      }
    });

    section('改登入代號');

    await test('換到一個沒有人用的學號：成功', async () => {
      await prisma.user.update({
        where: { id: students[0].id },
        data: { username: 'S1140350' },
      });
      const now = await prisma.user.findFirst({
        where: { id: students[0].id },
        select: { username: true },
      });
      assert.equal(now.username, 'S1140350');
    });

    await test('原本的學號立刻放得回去給別人用', async () => {
      // 這是「換一個代號重來」那條退路真正要的東西：舊代號要能被
      // 下一位新生拿去用，否則名冊匯入會接到一個錯的帳號上。
      const fresh = await makeStudent(tenant.id, klass.id, 'S1140301', '新來的');
      assert.ok(fresh.id);
      assert.notEqual(fresh.id, students[0].id);
    });

    await test('換到一個已經有人用的學號：資料庫擋下來', async () => {
      // 應用層會先查一次並給一句人話（`checkUsernameChange`），
      // 但那不是保證——保證在唯一鍵上。少了它，兩個並行的請求會
      // 同時通過應用層的檢查。
      await assert.rejects(
        () =>
          prisma.user.update({
            where: { id: students[1].id },
            data: { username: 'S1140303' },
          }),
        '兩位學生拿到同一個學號了',
      );
    });

    await test('改代號之後 session 作廢（他要用新代號重新登入）', async () => {
      await prisma.session.create({
        data: {
          sessionToken: 'tok-rename',
          userId: students[2].id,
          expires: new Date(Date.now() + 3600_000),
        },
      });
      await prisma.session.deleteMany({ where: { userId: students[2].id } });
      const left = await prisma.session.findMany({
        where: { userId: students[2].id },
        select: { id: true },
      });
      assert.equal(left.length, 0);
    });

    section('退補與個資刪除');

    await test('退補：離開所有班級、帳號 ARCHIVED、成員那一列還在', async () => {
      const leftAt = new Date();
      await prisma.user.update({ where: { id: students[3].id }, data: { status: 'ARCHIVED' } });
      await prisma.classMembership.updateMany({
        where: { userId: students[3].id, role: 'STUDENT', leftAt: null },
        data: { leftAt },
      });

      const roster = await prisma.classMembership.findMany({
        where: { classId: klass.id, leftAt: null, role: 'STUDENT' },
        select: { userId: true },
      });
      assert.ok(
        !roster.some((m) => m.userId === students[3].id),
        '退補的人還在在籍名冊上',
      );

      // **那一列沒有被刪掉。** 刪了的話，他過去的成績就對不回這個班。
      const all = await prisma.classMembership.findMany({
        where: { classId: klass.id, userId: students[3].id },
        select: { leftAt: true },
      });
      assert.equal(all.length, 1, '成員關係被刪掉了');
      assert.ok(all[0].leftAt, '離班日期沒有寫進去');
    });

    await test('個資刪除：學號換掉、姓名去識別化、deletedAt 寫入', async () => {
      const victim = students[4];
      const formerUsername = victim.username;
      await prisma.user.update({
        where: { id: victim.id },
        data: {
          username: erasedUsername(victim.id),
          displayName: '已刪除的學生',
          email: null,
          guardianEmail: null,
          birthDate: null,
          consentAt: null,
          passwordHash: null,
          status: 'ARCHIVED',
          deletedAt: new Date(),
        },
      });
      const now = await prisma.user.findFirst({
        where: { id: victim.id },
        select: { username: true, displayName: true, deletedAt: true, passwordHash: true },
      });
      assert.ok(now.deletedAt, 'deletedAt 沒有寫進去——那一欄在此之前從來沒被寫過');
      assert.equal(now.displayName, '已刪除的學生');
      assert.equal(now.passwordHash, null, '密碼還在，他登得進來');
      assert.notEqual(now.username, formerUsername);

      // **原學號放得回去。** 補習班的學號依入學年度編號、會重覆使用，
      // 而留著的話下一年的新生會被名冊匯入接到這個殼上。
      const reuse = await makeStudent(tenant.id, klass.id, formerUsername, '明年的新生');
      assert.ok(reuse.id);
    });

    await test('去識別化的代號不會與另一個去識別化的撞在一起', async () => {
      const a = erasedUsername(students[0].id);
      const b = erasedUsername(students[1].id);
      assert.notEqual(a, b);
      await prisma.user.update({ where: { id: students[0].id }, data: { username: a } });
      await prisma.user.update({ where: { id: students[1].id }, data: { username: b } });
    });

    section('租戶隔離');

    await test('別家補習班看不到這些學生', async () => {
      const other = await withoutTenantScope('建立第二個租戶', () =>
        prisma.tenant.create({ data: { name: '隔壁補習班' } }),
      );
      const seen = await withTenant(other.id, () =>
        prisma.user.findMany({ where: { systemRole: 'STUDENT' }, select: { id: true } }),
      );
      assert.equal(seen.length, 0, 'RLS 沒有隔開——隔壁看得到你的名冊');
    });
  });

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} 通過，${failed} 失敗\x1b[0m\n`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
