#!/usr/bin/env node
/**
 * 考試行為偵測對著**真的 Postgres** 跑一次。
 *
 * 合併與去抖動那一半有 66 條單元測試、瀏覽器那一半有
 * `tools/browser-proctor.mjs`，這一支都不重複。它驗的是跨越資料庫
 * 邊界之後還對不對：
 *
 *   · 事件真的寫得進去，而且 `at` 是**伺服器**算的——前端送的是
 *     「幾毫秒之前」，改系統時間偽造不了時刻
 *   · 那條 CHECK（`durationMs >= 0`）真的擋得住
 *   · RLS 真的隔得開兩家補習班。`proctor_events` **沒有 tenantId**，
 *     它靠 attempts → assignments 遞迴掛上去，是最容易漏的那一種；
 *     漏掉的症狀是隔壁補習班看得到你學生的監考記錄，而且沒有任何
 *     錯誤訊息
 *   · **同一間補習班的隔壁同學寫不進你的作答。** RLS 擋不住這個，
 *     擋它的是 `recordProctorEvents` 自己比對 userId——這一條漏了
 *     最沒有症狀：他可以往你的記錄裡塞一百筆「切走」
 *   · 作廢那條路接得上：作廢之後不再收新事件，但**已經記下的證據
 *     一列都不能少**（撤銷與申訴時要拿它對照）
 *   · 老師端的摘要與時間軸來自同一份資料，不會各說各話
 *
 * 跑的是 `lib/proctorDb.ts` 本人（用 esbuild 打包，只把 `@/lib/prisma`
 * 換成 pg-shim），所以這裡跑的判斷與正式環境跑的是同一份。
 *
 * 用法（只需要 Postgres，不需要 Redis、S3、AI）：
 *
 *   su postgres -c "psql -c \"CREATE ROLE yunzhi_proctor LOGIN PASSWORD 'pw' CREATEDB\""
 *   su postgres -c "psql -c 'CREATE DATABASE yunzhi_proctor OWNER yunzhi_proctor'"
 *   su postgres -c "psql -d yunzhi_proctor -c 'CREATE EXTENSION vector'"
 *   su postgres -c "psql -d yunzhi_proctor -c 'CREATE EXTENSION pg_trgm'"
 *   DATABASE_URL=postgresql://yunzhi_proctor:pw@127.0.0.1:5432/yunzhi_proctor \
 *     node tools/e2e-proctor.mjs
 *
 * 遷移用 `packages/db/migrations/*​/migration.sql` 逐支套（見
 * tools/e2e-import.sh），或 `npx prisma migrate deploy`。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { createPgShim } from './pg-shim.mjs';
import {
  exitTenantScope,
  withTenant,
  withoutTenantScope,
} from '../apps/web/lib/tenantContext.mjs';
import { summarizeEvents } from '../apps/web/lib/proctor.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`   \x1b[32m✓\x1b[0m ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`   \x1b[31m✗\x1b[0m ${name}`);
    console.error(`     ${String(e.message).split('\n').slice(0, 5).join('\n     ')}`);
    failed += 1;
  }
}

function section(name) {
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
}

/** bcrypt 格式的假雜湊。長度合法但對不上任何密碼。 */
const HASH = '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar';

// ─────────────────────────────────────────────────────────────
// shim 的補丁
//
// pg-shim 刻意只做被用到的事（見它的檔頭）。`lib/proctorDb.ts` 需要
// 兩樣它沒有的：巢狀的 `select: { user: {...} }`，以及關聯條件
// `where: { attempt: { assignmentId } }`。補在**測試這一側**，
// 不去動三支 e2e 共用的 shim。
// ─────────────────────────────────────────────────────────────

function adapt(base) {
  return new Proxy(base, {
    get(target, key) {
      const model = target[key];
      if (!model || typeof model !== 'object') return model;

      return new Proxy(model, {
        get(m, op) {
          if (op !== 'findMany' && op !== 'findFirst' && op !== 'count') return m[op];

          return async (args = {}) => {
            const { select, where, ...rest } = args ?? {};
            const flat = await flattenRelation(base, String(key), where);
            // 含關聯的 select 一律整列撈：挑欄位再補外鍵需要知道每個
            // 模型有哪些欄位，而那是 shim 的工作，重寫一遍只會多一份
            // 會分歧的表。撈整列在測試裡沒有成本。
            const plain =
              select && Object.values(select).some((v) => v && typeof v === 'object')
                ? { ...rest, where: flat }
                : { ...rest, where: flat, ...(select ? { select } : {}) };
            const rows = await m[op](plain);
            if (op === 'count') return rows;
            const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
            for (const row of list) {
              if (String(key) === 'attempt' && select?.user && typeof select.user === 'object') {
                row.user = await base.user.findFirst({ where: { id: row.userId } });
              }
            }
            return Array.isArray(rows) ? list : (list[0] ?? null);
          };
        },
      });
    },
  });
}

/**
 * 把 `where: { attempt: { assignmentId } }` 換成 `attemptId: { in: [...] }`。
 *
 * 正式環境走的是 RLS 政策裡那個 EXISTS 子查詢，這裡先撈一次再套——
 * 算出來的集合一樣，而這支測試要驗的是集合對不對，不是計畫長什麼樣。
 */
async function flattenRelation(base, model, where) {
  if (!where || typeof where !== 'object') return where;
  if (model !== 'proctorEvent' || !where.attempt) return where;
  const { attempt, ...rest } = where;
  const ids = (await base.attempt.findMany({ where: attempt })).map((a) => a.id);
  return { ...rest, attemptId: { in: ids } };
}

// ─────────────────────────────────────────────────────────────
// 起手式
// ─────────────────────────────────────────────────────────────

const raw = createPgShim({
  connectionString: process.env.DATABASE_URL,
  schemaPath: 'packages/db/schema.prisma',
});
const prisma = adapt(raw);

const outDir = mkdtempSync(path.join(tmpdir(), 'yz-proctor-e2e-'));
const shimPath = path.join(outDir, 'prisma-shim.mjs');
writeFileSync(shimPath, 'export const prisma = globalThis.__YZ_PROCTOR_PRISMA__;\n');

await build({
  entryPoints: [path.join(ROOT, 'apps/web/lib/proctorDb.ts')],
  outfile: path.join(outDir, 'proctorDb.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@prisma/client'],
  alias: { '@/lib/prisma': shimPath, '@': path.join(ROOT, 'apps/web') },
  plugins: [
    {
      // 租戶脈絡**不可以被打包進去**：`tenantContext.mjs` 裡的
      // AsyncLocalStorage 是模組層級的單例，打包會複製出第二份——
      // 於是這支測試用 `withTenant` 建立的脈絡，bundle 裡的
      // `requireTenant` 看不到，每一個查詢都失敗在「忘記包 withTenant？」。
      name: 'share-tenant-context',
      setup(b) {
        b.onResolve({ filter: /(^|\/)tenantContext\.mjs$/ }, () => ({
          path: pathToFileURL(path.join(ROOT, 'apps/web/lib/tenantContext.mjs')).href,
          external: true,
        }));
      },
    },
  ],
  logLevel: 'silent',
});

globalThis.__YZ_PROCTOR_PRISMA__ = prisma;
const db = await import(pathToFileURL(path.join(outDir, 'proctorDb.mjs')).href);

// ─────────────────────────────────────────────────────────────
// 種子
// ─────────────────────────────────────────────────────────────

const stamp = Date.now();

/**
 * 一家補習班的一條完整動線：老師、兩位學生、科目、卷、任務、兩份作答。
 *
 * 兩家用同一個函式建，是為了讓「A 看不到 B」那一組斷言有意義：兩邊的
 * 形狀一模一樣，只有 tenantId 不同，所以任何一列跨界出現在對方的查詢
 * 結果裡，都只可能是隔離漏了，不會是別的原因。
 */
async function seed(tag, prefix) {
  const tenant = await withoutTenantScope('建立測試用的補習班', () =>
    raw.tenant.create({ data: { name: `${tag} 考試行為 e2e ${stamp}` } }),
  );
  return withTenant(tenant.id, async () => {
    const teacher = await raw.user.create({
      data: {
        tenantId: tenant.id,
        username: `${prefix}-T-${stamp}`,
        displayName: `${tag}的數學老師`,
        systemRole: 'TEACHER',
        passwordHash: HASH,
      },
    });
    const student = await raw.user.create({
      data: {
        tenantId: tenant.id,
        username: `${prefix}-S1-${stamp}`,
        displayName: `${tag}的學生甲`,
        systemRole: 'STUDENT',
        passwordHash: HASH,
      },
    });
    const classmate = await raw.user.create({
      data: {
        tenantId: tenant.id,
        username: `${prefix}-S2-${stamp}`,
        displayName: `${tag}的學生乙`,
        systemRole: 'STUDENT',
        passwordHash: HASH,
      },
    });
    const subject = await raw.subject.create({
      data: { tenantId: tenant.id, code: `MATH_${prefix}`, name: '數學A', gsatFullScore: 100 },
    });
    const paper = await raw.examPaper.create({
      data: {
        tenantId: tenant.id,
        subjectId: subject.id,
        title: `${tag}·第一次段考`,
        status: 'READY',
        createdBy: teacher.id,
      },
    });
    const assignment = await raw.assignment.create({
      data: {
        tenantId: tenant.id,
        paperId: paper.id,
        title: `${tag}·第一次段考`,
        mode: 'EXAM',
        timeLimitMin: 50,
        createdBy: teacher.id,
      },
    });
    const startedAt = new Date(Date.now() - 40 * 60_000);
    const mine = await raw.attempt.create({
      data: {
        assignmentId: assignment.id,
        userId: student.id,
        attemptNo: 1,
        status: 'IN_PROGRESS',
        startedAt,
        expiresAt: new Date(startedAt.getTime() + 50 * 60_000),
      },
    });
    const theirs = await raw.attempt.create({
      data: {
        assignmentId: assignment.id,
        userId: classmate.id,
        attemptNo: 1,
        status: 'IN_PROGRESS',
        startedAt,
        expiresAt: new Date(startedAt.getTime() + 50 * 60_000),
      },
    });
    return { tenant, teacher, student, classmate, subject, paper, assignment, mine, theirs };
  });
}

const A = await seed('本校', 'A');
const B = await seed('隔壁', 'B');

/** 一筆送給伺服器的事件。時刻用「幾毫秒之前」，與前端送的一致。 */
function wire(over = {}) {
  return {
    type: 'TAB_VISIBLE',
    atOffsetMs: 5_000,
    durationMs: 4_000,
    questionOrder: 7,
    meta: null,
    ...over,
  };
}

await withTenant(A.tenant.id, main);

async function main() {
  section('寫得進去');

  await test('一批事件寫進去，時刻由伺服器算', async () => {
    const before = new Date();
    const res = await db.recordProctorEvents(A.mine.id, A.student.id, [
      wire({ atOffsetMs: 10_000, durationMs: 6_000, questionOrder: 14 }),
      wire({ type: 'FULLSCREEN_EXIT', atOffsetMs: 3_000, durationMs: null, questionOrder: 15 }),
    ]);
    assert.equal(res.accepted, 2);
    assert.equal(res.dropped, 0);

    const rows = await raw.proctorEvent.findMany({
      where: { attemptId: A.mine.id },
      orderBy: { at: 'asc' },
    });
    assert.equal(rows.length, 2);
    const [first, second] = rows;
    assert.equal(first.type, 'TAB_VISIBLE');
    assert.equal(first.durationMs, 6_000);
    assert.equal(first.questionOrder, 14);
    // 10 秒前那一筆要落在「現在」之前約 10 秒，而且**不可以是前端
    // 送來的時刻**——前端根本沒送時刻。
    const delta = before.getTime() - new Date(first.at).getTime();
    assert.ok(delta > 5_000 && delta < 20_000, `時刻差了 ${delta}ms，應該接近 10 秒`);
    assert.ok(new Date(second.at) > new Date(first.at), '3 秒前的那一筆要比 10 秒前的晚');
  });

  await test('meta 只留數字，貼上的內容進不了資料庫', async () => {
    await db.recordProctorEvents(A.mine.id, A.student.id, [
      wire({ type: 'PASTE', durationMs: null, meta: { chars: 412, count: 2 } }),
    ]);
    const row = await raw.proctorEvent.findFirst({
      where: { attemptId: A.mine.id, type: 'PASTE' },
    });
    assert.deepEqual(row.meta, { chars: 412, count: 2 });
  });

  await test('時刻夾在這一場的範圍裡——前端說「三小時前」也一樣', async () => {
    const res = await db.recordProctorEvents(A.mine.id, A.student.id, [
      wire({ type: 'LONG_ABSENCE', atOffsetMs: 3 * 60 * 60 * 1000, durationMs: 60_000 }),
    ]);
    assert.equal(res.accepted, 1);
    const row = await raw.proctorEvent.findFirst({
      where: { attemptId: A.mine.id, type: 'LONG_ABSENCE' },
    });
    const at = new Date(row.at).getTime();
    assert.ok(
      at >= new Date(A.mine.startedAt).getTime(),
      '事件跑到考試開始之前了——老師端的時間軸會多出一段不存在的時間',
    );
    // 長度也要跟著夾，否則 `at − durationMs` 一樣會落到開考之前。
    assert.ok(at - row.durationMs >= new Date(A.mine.startedAt).getTime());
  });

  await test('那條 CHECK 真的擋得住負的持續時間', async () => {
    await assert.rejects(
      raw.proctorEvent.create({
        data: { attemptId: A.mine.id, type: 'TAB_VISIBLE', durationMs: -1 },
      }),
      /proctor_events_duration_nonneg/,
    );
    // 合法的那一半也要驗：只驗前半的話，一個把整張表寫壞的錯誤
    // （例如欄位名打錯）也會讓測試通過，因為它一樣會拋例外。
    const ok = await raw.proctorEvent.create({
      data: { attemptId: A.mine.id, type: 'TAB_VISIBLE', durationMs: 0 },
    });
    assert.equal(ok.durationMs, 0);
    await raw.proctorEvent.deleteMany({ where: { id: ok.id } });
  });

  section('隔壁同學寫不進來');

  await test('別人的作答收不下——RLS 擋不住這一條，程式要自己擋', async () => {
    const res = await db.recordProctorEvents(A.mine.id, A.classmate.id, [wire()]);
    assert.equal(res.accepted, 0);
    assert.equal(res.reason, 'CLOSED');
    const n = await raw.proctorEvent.count({ where: { attemptId: A.mine.id } });
    assert.equal(n, 4, '隔壁同學往別人的記錄裡塞了東西');
  });

  await test('不存在的作答 id 不會拋例外，只是收不下', async () => {
    const res = await db.recordProctorEvents('does-not-exist', A.student.id, [wire()]);
    assert.equal(res.accepted, 0);
  });

  section('關掉的作答不再收');

  await test('交卷之後留一段寬限——beacon 常常慢半拍', async () => {
    await raw.attempt.update({
      where: { id: A.theirs.id },
      data: { status: 'SUBMITTED', submittedAt: new Date(Date.now() - 30_000) },
    });
    const res = await db.recordProctorEvents(A.theirs.id, A.classmate.id, [wire()]);
    assert.equal(res.accepted, 1, '交卷後 30 秒到的 beacon 被丟掉了');
  });

  await test('交卷很久之後才來的就不收了', async () => {
    // 20 分鐘前交的。**不可以往前推到開考之前**——那會撞上
    // `attempts_time_ordered`，而那條約束本身是對的。
    await raw.attempt.update({
      where: { id: A.theirs.id },
      data: { submittedAt: new Date(Date.now() - 20 * 60_000) },
    });
    const res = await db.recordProctorEvents(A.theirs.id, A.classmate.id, [wire()]);
    assert.equal(res.accepted, 0);
    assert.equal(res.reason, 'CLOSED');
  });

  await test('一份作答有上限，灌不爆這張表', async () => {
    const attempt = await raw.attempt.create({
      data: {
        assignmentId: A.assignment.id,
        userId: A.student.id,
        attemptNo: 2,
        status: 'IN_PROGRESS',
        startedAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    // 直接把上限灌滿（走 API 要送 25 批，而這裡要驗的是上限本身）。
    const bulk = [];
    for (let i = 0; i < db.MAX_EVENTS_PER_ATTEMPT; i++) {
      bulk.push({ attemptId: attempt.id, type: 'TAB_VISIBLE', durationMs: 2_000 });
    }
    await raw.proctorEvent.createMany({ data: bulk });

    const res = await db.recordProctorEvents(attempt.id, A.student.id, [wire()]);
    assert.equal(res.accepted, 0);
    assert.equal(res.reason, 'FULL');
    const n = await raw.proctorEvent.count({ where: { attemptId: attempt.id } });
    assert.equal(n, db.MAX_EVENTS_PER_ATTEMPT);
    await raw.attempt.deleteMany({ where: { id: attempt.id } });
  });

  section('租戶隔離');

  await test('看不到隔壁補習班的行為記錄', async () => {
    // 先在 B 那邊種幾筆（在 B 的脈絡裡，否則 WITH CHECK 就擋住了）。
    await withTenant(B.tenant.id, () =>
      db.recordProctorEvents(B.mine.id, B.student.id, [wire(), wire({ type: 'PASTE' })]),
    );
    const seen = await raw.proctorEvent.findMany({ where: { attemptId: B.mine.id } });
    assert.equal(seen.length, 0, '知道 id 就查得到隔壁的監考記錄，等於沒有隔離');
  });

  await test('也寫不進隔壁補習班的作答（WITH CHECK）', async () => {
    // 只有 USING 沒有 WITH CHECK 的政策會讓資料寫得進去卻讀不到，
    // 那是最難查的一種資料損壞。
    await assert.rejects(
      raw.proctorEvent.create({
        data: { attemptId: B.mine.id, type: 'TAB_VISIBLE', durationMs: 1_000 },
      }),
      /row-level security|policy/i,
    );
  });

  await test('改不動也刪不掉隔壁的記錄', async () => {
    const del = await raw.proctorEvent.deleteMany({ where: { attemptId: B.mine.id } });
    assert.equal(del.count, 0, '刪掉了隔壁補習班的監考記錄');
    const still = await withoutTenantScope('驗證用：回頭確認隔壁的資料沒被動到', () =>
      raw.proctorEvent.count({ where: { attemptId: B.mine.id } }),
    );
    assert.equal(still, 2);
  });

  await test('沒有租戶脈絡時一列都查不到（fail closed）', async () => {
    await exitTenantScope(async () => {
      const n = await raw.proctorEvent.count({});
      assert.equal(n, 0, `沒設租戶卻查得到 ${n} 列，fail open`);
    });
  });

  await test('隔壁補習班的老師看不到這一班的摘要', async () => {
    const report = await withTenant(B.tenant.id, () =>
      db.assignmentProctorReport(A.assignment.id),
    );
    assert.equal(report.rows.length, 0);
    assert.equal(report.total, 0);
  });

  section('老師端');

  await test('摘要與時間軸來自同一份資料，不會各說各話', async () => {
    const report = await db.assignmentProctorReport(A.assignment.id);
    const timelines = await db.assignmentProctorTimelines(A.assignment.id);
    const row = report.rows.find((r) => r.attemptId === A.mine.id);
    assert.ok(row, '找不到這一份作答');
    const events = timelines.get(A.mine.id) ?? [];
    assert.equal(row.summary.total, events.length);
    // 摘要那一列若與點進去數出來的不一樣，老師不會懷疑程式，
    // 他會懷疑學生。
    assert.deepEqual(row.summary, summarizeEvents(events));
  });

  await test('沒有事件的作答也算進分母——中位數才有意義', async () => {
    const report = await db.assignmentProctorReport(A.assignment.id);
    assert.ok(report.rows.length >= 2, '只回了有事件的那幾份');
    assert.ok(report.silent >= 0);
    assert.equal(report.baseline.students, report.rows.length);
  });

  await test('時間軸按時間排序，而且帶著第幾題', async () => {
    const timelines = await db.assignmentProctorTimelines(A.assignment.id);
    const events = timelines.get(A.mine.id) ?? [];
    assert.ok(events.length >= 3);
    for (let i = 1; i < events.length; i++) {
      assert.ok(
        new Date(events[i].at) >= new Date(events[i - 1].at),
        '時間軸沒有排序，老師看不出「離開的形狀」',
      );
    }
    assert.ok(events.some((e) => e.questionOrder != null), '第幾題掉了');
  });

  await test('全班普遍偏高時，基準線說得出來', async () => {
    // 另外造一份任務，全班八個人每人五次離開——這是熱點斷斷續續的
    // 樣子，而系統要說的是「先看環境」而不是挑一個人出來。
    const noisy = await raw.assignment.create({
      data: {
        tenantId: A.tenant.id,
        paperId: A.paper.id,
        title: `全班網路都很差 ${stamp}`,
        mode: 'EXAM',
        createdBy: A.teacher.id,
      },
    });
    for (let i = 0; i < 8; i++) {
      const u = await raw.user.create({
        data: {
          tenantId: A.tenant.id,
          username: `A-N${i}-${stamp}`,
          displayName: `學生 ${i}`,
          systemRole: 'STUDENT',
          passwordHash: HASH,
        },
      });
      const at = await raw.attempt.create({
        data: {
          assignmentId: noisy.id,
          userId: u.id,
          attemptNo: 1,
          status: 'IN_PROGRESS',
          startedAt: new Date(Date.now() - 30 * 60_000),
        },
      });
      await db.recordProctorEvents(
        at.id,
        u.id,
        Array.from({ length: 5 }, () => wire({ atOffsetMs: 60_000, durationMs: 5_000 })),
      );
    }
    const report = await db.assignmentProctorReport(noisy.id);
    assert.equal(report.baseline.students, 8);
    assert.equal(report.baseline.widespread, true, '全班一致的模式要看得出來');
    assert.equal(
      report.rows.filter((r) => r.standsOut).length,
      0,
      '全班都這樣的時候標記任何一位就是在製造冤案',
    );
  });

  section('作廢那條路');

  await test('作廢之後不再收新的事件', async () => {
    await raw.attempt.update({ where: { id: A.mine.id }, data: { status: 'VOIDED' } });
    const res = await db.recordProctorEvents(A.mine.id, A.student.id, [wire()]);
    assert.equal(res.accepted, 0);
    assert.equal(res.reason, 'CLOSED');
  });

  await test('作廢之後既有的證據一列都不能少', async () => {
    // 撤銷作廢與家長申訴時要拿它對照。作廢的意思是「這一份不算數」，
    // 不是「這件事沒發生過」。
    const n = await raw.proctorEvent.count({ where: { attemptId: A.mine.id } });
    assert.equal(n, 4);
  });

  await test('作廢的那一份仍然出現在老師端，而且看得出已作廢', async () => {
    const report = await db.assignmentProctorReport(A.assignment.id);
    const row = report.rows.find((r) => r.attemptId === A.mine.id);
    assert.ok(row, '作廢之後就從監考記錄裡消失了——那正是要調閱的那一份');
    assert.equal(row.status, 'VOIDED', '畫面要據此顯示「撤銷作廢」而不是「作廢」');
    assert.ok(row.summary.total > 0);
  });

  await test('撤銷作廢之後又收得下了', async () => {
    await raw.attempt.update({ where: { id: A.mine.id }, data: { status: 'IN_PROGRESS' } });
    const res = await db.recordProctorEvents(A.mine.id, A.student.id, [wire()]);
    assert.equal(res.accepted, 1);
  });

  section('刪除的連鎖');

  await test('刪掉作答時，它的行為記錄跟著走，不留孤兒', async () => {
    const attempt = await raw.attempt.create({
      data: {
        assignmentId: A.assignment.id,
        userId: A.student.id,
        attemptNo: 3,
        status: 'IN_PROGRESS',
        startedAt: new Date(),
      },
    });
    await db.recordProctorEvents(attempt.id, A.student.id, [wire()]);
    assert.equal(await raw.proctorEvent.count({ where: { attemptId: attempt.id } }), 1);
    await raw.attempt.deleteMany({ where: { id: attempt.id } });
    const left = await raw.proctorEvent.count({ where: { attemptId: attempt.id } });
    assert.equal(left, 0, '留下了指向不存在作答的記錄');
  });
}

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} 通過，${failed} 失敗\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
