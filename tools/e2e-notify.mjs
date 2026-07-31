/**
 * 通知對真的 Postgres 的端到端驗證。
 *
 * 去重、節流、免打擾的公式本身有 42 個單元測試
 * （apps/web/tests/notify.test.mjs），這一支**不重複測它們**。
 * 它驗的是跨越資料庫邊界之後還對不對，而那正是這個功能唯一會出事的地方：
 *
 *   · `@@unique([tenantId, dedupeKey])` 是不是真的擋得住第二次寫入
 *     ——「只送一次」靠的是資料庫，不是靠「先查有沒有」
 *   · **工作者重跑不會重複送**（同一輪掃描跑十次只有一列）
 *   · QUEUED → SENT 的搶鎖是不是原子的（兩個工作者實例）
 *   · 未接的渠道真的以 SUPPRESSED 落地，而且**一列都不留在 QUEUED**
 *   · 免打擾時段內的通知真的不出現在收件匣裡（`scheduledAt` 在未來）
 *   · 送出失敗真的累加 `retryCount`、真的在上限停手、`failReason` 真的留著
 *   · **退出班級之後不再收到那個班的通知**
 *   · RLS：隔壁補習班的通知不會出現在這家的收件匣裡
 *   · **家長只收得到自己孩子的、而且不含逐題作答或智慧老師的內容**
 *
 * 最後兩項是這一支最重要的斷言。租戶漏了的後果是一家補習班的成績
 * 通知出現在另一家的畫面上；家長那一條漏了的後果是**把一個孩子的
 * 作答內容推給一位未經確認的成年人**——而通知是推出去的，
 * 比一個頁面更難收回來。
 *
 * # 為什麼用 pg-shim 而不是 PrismaClient
 *
 * 理由見 tools/pg-shim.mjs 的檔頭：Prisma 的查詢引擎要從外部網域下載，
 * 而這套系統要部署的補習班機房是封閉網段。shim 從同一份 schema 取得
 * 欄位對應，所以欄位名寫錯一樣會被抓到。
 *
 * # 這一支跑的是正式程式，不是複製品
 *
 * `enqueueMany` / `deliverDue` / `sweepDueSoon` 那幾支直接從
 * `apps/web/lib/notify.mjs` import——與工作者、與網頁端用的是同一份。
 * 所以這裡綠燈代表那一份會動。
 *
 * 唯一沒有被這支跑到的是 `lib/notifyDb.ts` 裡把它們接到 `@/lib/prisma`
 * 的那幾行（那是 TypeScript，端到端測試不編譯 TS），而那幾行由 tsc
 * 與 next build 顧著。
 *
 * 用法（要先有一個套過遷移的資料庫）：
 *   DATABASE_URL=postgresql://… node tools/e2e-notify.mjs
 */
import assert from 'node:assert/strict';

import { createPgShim } from './pg-shim.mjs';
import {
  MAX_PER_WINDOW,
  MAX_RETRY,
  NOTIFICATION_RETENTION_DAYS,
  deliverDue,
  enqueueMany,
  examBusy,
  generateAll,
  inboxPage,
  markRead,
  purgeOldNotifications,
  sweepDueSoon,
  sweepGrading,
  sweepImports,
  sweepOverdue,
  unreadCount,
} from '../apps/web/lib/notify.mjs';
import { GUARDIAN_PAYLOAD_KEYS, render } from '../apps/web/lib/notifyTemplates.mjs';
import { withTenant, withoutTenantScope } from '../apps/web/lib/tenantContext.mjs';

const prisma = createPgShim({
  connectionString: process.env.DATABASE_URL,
  schemaPath: 'packages/db/schema.prisma',
});

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`   ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`   ✗ ${name}`);
    console.error(`     ${e.message.split('\n').slice(0, 8).join('\n     ')}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
}

const HASH = '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ── 建置 ─────────────────────────────────────────────────────────

/**
 * 一家補習班：一位老師、兩位學生、兩位家長（一位已驗證、一位沒有）、
 * 一個班、一份卷、兩個任務（一份 12 小時後截止、一份昨天就截止了）。
 *
 * 兩家用同一個函式建，理由與 tools/e2e-ability.mjs 相同：兩邊的資料
 * 形狀一模一樣、只有 tenantId 不同，所以任何一列跨界出現在對方的
 * 結果裡，都只可能是隔離漏了。
 */
async function seedTenant(spec) {
  const now = spec.now;
  const tenant = await prisma.tenant.create({ data: { name: spec.name } });
  const year = await prisma.academicYear.create({
    data: {
      tenantId: tenant.id,
      name: '115學年度',
      startDate: new Date('2026-08-01'),
      endDate: new Date('2027-07-31'),
      isCurrent: true,
    },
  });
  const mkUser = (suffix, name, role, extra = {}) =>
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        username: `${spec.prefix}-${suffix}`,
        displayName: `${spec.tag}${name}`,
        systemRole: role,
        passwordHash: HASH,
        ...extra,
      },
    });

  const teacher = await mkUser('T01', '的數學老師', 'TEACHER');
  const student = await mkUser('S01', '的王大明', 'STUDENT');
  const leaver = await mkUser('S02', '的轉出同學', 'STUDENT');
  // 家長的登入代號是信箱（見 lib/guardian.ts 的 guardianUsername）。
  const parent = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: `${spec.prefix.toLowerCase()}-mom@example.com`,
      displayName: `${spec.tag}的王大明家長`,
      systemRole: 'GUARDIAN',
      passwordHash: HASH,
    },
  });
  const unverified = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: `${spec.prefix.toLowerCase()}-dad@example.com`,
      displayName: `${spec.tag}的未驗證家長`,
      systemRole: 'GUARDIAN',
      passwordHash: HASH,
    },
  });

  // **一位已驗證、一位沒有。** `verifiedAt` 是「憑證確實交到那位法定
  // 代理人手上」被人確認的時刻，而未驗證的連結不得作為任何推播的
  // 收件人——那條規則擋的正是「把成績寄給陌生人」。
  await prisma.guardianLink.create({
    data: { guardianId: parent.id, studentId: student.id, verifiedAt: now },
  });
  await prisma.guardianLink.create({
    data: { guardianId: unverified.id, studentId: student.id },
  });

  const subject = await prisma.subject.create({
    data: { tenantId: tenant.id, code: 'MATH_A', name: '數學A', gsatFullScore: 100 },
  });
  const klass = await prisma.class.create({
    data: { tenantId: tenant.id, academicYearId: year.id, name: '三年甲班' },
  });
  for (const u of [student, leaver]) {
    await prisma.classMembership.create({
      data: { classId: klass.id, userId: u.id, role: 'STUDENT' },
    });
  }

  const question = await prisma.question.create({
    data: {
      tenantId: tenant.id,
      subjectId: subject.id,
      familyId: `${spec.prefix}-q1`,
      version: 1,
      type: 'SINGLE_CHOICE',
      content: `${spec.tag}：第一題`,
      score: 5,
      answerKeys: [1],
      sourceType: 'TEACHER_ORIGINAL',
      licenseScope: 'TENANT_EXPORTABLE',
      status: 'PUBLISHED',
    },
  });
  const paper = await prisma.examPaper.create({
    data: {
      tenantId: tenant.id,
      subjectId: subject.id,
      title: `${spec.tag}·通知測試用卷`,
      status: 'READY',
      totalScore: 5,
      createdBy: teacher.id,
    },
  });
  await prisma.examPaperItem.create({
    data: { paperId: paper.id, questionId: question.id, order: 1, score: 5 },
  });

  const mkAssignment = async (title, dueAt, extra = {}) => {
    const a = await prisma.assignment.create({
      data: {
        tenantId: tenant.id,
        paperId: paper.id,
        title: `${spec.tag}·${title}`,
        mode: 'EXAM',
        maxAttempts: 1,
        dueAt,
        createdBy: teacher.id,
        ...extra,
      },
    });
    await prisma.assignmentTarget.create({ data: { assignmentId: a.id, classId: klass.id } });
    return a;
  };

  // 12 小時後截止（在 24 小時的快到期視窗內）。
  const soon = await mkAssignment('明天要交的小考', new Date(+now + 12 * HOUR));
  // 昨天就截止了，而且不收遲交。
  const late = await mkAssignment('昨天就該交的週考', new Date(+now - DAY));
  // 三天前截止，還收遲交——文案的下一步不一樣。
  const lateOpen = await mkAssignment('上週的補交作業', new Date(+now - 2 * DAY), {
    allowLate: true,
  });

  return {
    tenant,
    teacher,
    student,
    leaver,
    parent,
    unverified,
    subject,
    klass,
    paper,
    question,
    soon,
    late,
    lateOpen,
  };
}

/**
 * 這個人所有的通知列，不管狀態。查「有沒有卡在 QUEUED」用它。
 *
 * 跨租戶讀，因為它是**檢查用的**：要能看到未接渠道那幾列
 * SUPPRESSED、看到別人的租戶有沒有被污染。租戶隔離本身由專門的
 * 那幾格用 `withTenant` 驗——把兩件事混在一起的話，一次隔離的漏洞
 * 會被當成「查不到資料」而不是「跨界了」。
 */
function rowsOf(userId) {
  return withoutTenantScope('端到端：檢查某個人的通知列', () =>
    prisma.notification.findMany({
      where: { recipientId: userId },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

const keysOf = (rows) => rows.map((r) => r.templateKey).sort();

// ── 主流程 ───────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  const fixture = await withoutTenantScope('通知端到端：清庫並建出兩家補習班', async () => {
    // `notifications` 與 `notification_preferences` **要明著列出來**。
    //
    // 這兩張表沒有任何外鍵（schema 上 `Notification` 不對 `Tenant` 建
    // 關聯，`NotificationPreference` 也不對 `User` 建），所以
    // `TRUNCATE tenants … CASCADE` 碰不到它們——上一次執行留下的列會
    // 帶著已經不存在的 tenantId 與 recipientId 活下來。
    //
    // 那不只是「測試不乾淨」：那些孤兒列會讓「隔壁補習班的通知不會
    // 出現在這家的收件匣裡」這一格**因為查不到而通過**，而它應該是
    // 這一支最重要的斷言之一。一個因為髒資料而綠燈的隔離測試，
    // 比沒有測試更危險。
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE tenants, subjects, publishers, official_source_fetches,
                     notifications, notification_preferences
      RESTART IDENTITY CASCADE
    `);
    const mine = await seedTenant({ name: '端到端測試補習班', prefix: 'A', tag: '本校', now });
    const other = await seedTenant({ name: '隔壁補習班', prefix: 'B', tag: '隔壁', now });
    return { mine, other, now };
  });
  return mainFlow(fixture);
}

async function mainFlow({ mine: f, other, now }) {
  /**
   * 這個人現在收件匣裡看得到的（狀態必須是 SENT）。
   *
   * **一律在本校的租戶脈絡下讀**，因為它模擬的是網頁端：那一邊永遠
   * 在某個租戶裡（`scopedPage`）。用跨租戶讀的話，這一支就驗不到
   * 「RLS 底下這幾支查詢還查得到自己的資料」——而 fail closed 的
   * 症狀正是「收件匣是空的」。
   */
  const inboxOf = (userId) =>
    withTenant(f.tenant.id, async () => {
      const { rows } = await inboxPage(prisma, userId, { take: 50 });
      return rows;
    });

  /** 未讀數與標記已讀，一律在本校的租戶脈絡下——與網頁端一樣。 */
  const unreadOf = (userId) => withTenant(f.tenant.id, () => unreadCount(prisma, userId));
  const markReadFor = (userId, opts) =>
    withTenant(f.tenant.id, () => markRead(prisma, userId, opts));

  // ── 一、事件觸發 → 進佇列 ──────────────────────────────────────
  //
  // 掃描與投遞都是跨租戶的（工作者不屬於任何一家補習班），
  // 所以這一段包在 withoutTenantScope 裡，與 scripts/worker.mjs 一樣。

  section('事件觸發 → 通知進佇列');

  await test('考試進行中不掃描（考試優先於通知）', async () => {
    await withoutTenantScope('端到端：模擬考試中的負載', async () => {
      // 一份正在計時的作答。門檻是 20 份，所以一份不算「有一場考試」。
      const live = await prisma.attempt.create({
        data: {
          assignmentId: f.soon.id,
          userId: f.student.id,
          attemptNo: 1,
          status: 'IN_PROGRESS',
          startedAt: now,
          expiresAt: new Date(+now + HOUR),
        },
      });
      assert.equal(await examBusy(prisma), false, '一份不該算成有考試');
      // 門檻降到 1 就算「有考試」——工作者那邊用常數，這裡驗的是判斷
      // 真的看得到那一列。
      assert.equal(await examBusy(prisma, { threshold: 1 }), true);
      // **卡住的作答不可以永遠擋住通知。** expiresAt 已經過了的那些
      // 會掛在 IN_PROGRESS 三個月（首頁待辦上那一項講的就是它），
      // 用它當指標的話通知會從此不再產生。
      await prisma.attempt.update({
        where: { id: live.id },
        data: { expiresAt: new Date(+now - DAY) },
      });
      assert.equal(
        await examBusy(prisma, { threshold: 1 }),
        false,
        '過期沒收掉的作答不算「考試進行中」',
      );
      await prisma.attempt.deleteMany({ where: { id: live.id } });
    });
  });

  await test('一輪掃描產生學生、家長、老師三種通知', async () => {
    await withoutTenantScope('端到端：產生通知', async () => {
      const r = await generateAll(prisma, { now });
      assert.deepEqual(r.failures, [], '掃描不該有失敗');
      assert.ok(r.created > 0, '應該產生了通知');
    });

    // 學生：快到期一則（摘要）＋ 逾期未交一則（摘要，兩份任務合成一則）
    assert.deepEqual(keysOf(await rowsOf(f.student.id)), [
      'assignment.due_soon',
      'assignment.overdue',
    ]);
    // 家長：只有逾期未交，而且只有已驗證的那一位收得到。
    assert.deepEqual(keysOf(await rowsOf(f.parent.id)), ['assignment.overdue.guardian']);
    assert.deepEqual(await rowsOf(f.unverified.id), [], '未驗證的家長一列都不該有');
  });

  await test('逾期未交是摘要：兩份任務合成一則，帶得出份數', async () => {
    // 六份就送六則的話，收件匣從那一刻起不再是一份可以讀的清單，
    // 而六則的下一步完全相同。
    const [row] = (await rowsOf(f.student.id)).filter(
      (r) => r.templateKey === 'assignment.overdue',
    );
    assert.ok(row);
    assert.equal(row.payload.count, 2, '兩份逾期未交要合成一則');
    // 其中一份還收遲交 → 下一步是「現在交還來得及」，不是「找老師」。
    assert.equal(row.payload.canStillSubmit, true);
    const v = render(row.templateKey, row.payload);
    assert.match(v.body, /遲交/);
  });

  await test('去重鍵真的寫進去了，而且帶得出是誰的哪一件事', async () => {
    // 這一欄要能被人讀：「為什麼這位家長沒收到通知」的第一步是撈一列
    // 出來看，而一串雜湊不會告訴任何人任何事。
    const rows = await rowsOf(f.student.id);
    for (const r of rows) {
      assert.ok(r.dedupeKey, '每一列都要有去重鍵');
      assert.ok(r.dedupeKey.startsWith(`${r.templateKey}:${f.student.id}:`), r.dedupeKey);
    }
  });

  // ── 二、冪等：跑十次只有一則 ───────────────────────────────────

  section('冪等：工作者重跑不會重複送');

  await test('同一輪掃描跑十次，通知列數完全不變', async () => {
    const before = (await rowsOf(f.student.id)).length;
    await withoutTenantScope('端到端：重複掃描', async () => {
      for (let i = 0; i < 10; i++) {
        const r = await generateAll(prisma, { now: new Date(+now + i * 1000) });
        assert.deepEqual(r.failures, []);
        assert.equal(r.created, 0, `第 ${i + 1} 次掃描不該新增任何一則`);
        assert.ok(r.skipped > 0, '應該全部撞到去重鍵');
      }
    });
    assert.equal((await rowsOf(f.student.id)).length, before, '列數不可以變');
  });

  await test('同一個去重鍵在資料庫層真的擋得住（不是靠先查有沒有）', async () => {
    // 兩個工作者實例會同時查到「沒有」、同時寫進去。所以「只送一次」
    // 必須由 @@unique([tenantId, dedupeKey]) 保證。
    await withoutTenantScope('端到端：併發寫入同一個去重鍵', async () => {
      const spec = {
        tenantId: f.tenant.id,
        recipientId: f.student.id,
        templateKey: 'grade.released',
        scope: 'dupe-test',
        payload: { assignmentId: f.soon.id, title: '併發測試' },
      };
      const results = await Promise.all([
        enqueueMany(prisma, [spec], { now }),
        enqueueMany(prisma, [spec], { now }),
        enqueueMany(prisma, [spec], { now }),
      ]);
      const created = results.reduce((n, r) => n + r.created, 0);
      assert.equal(created, 1, '三個併發的寫入只能有一個成功');
      const rows = await prisma.notification.findMany({
        where: { recipientId: f.student.id, templateKey: 'grade.released' },
      });
      assert.equal(rows.length, 1);
      await prisma.notification.deleteMany({ where: { id: rows[0].id } });
    });
  });

  await test('隔壁補習班用同一個去重鍵不會互相擋住', async () => {
    // 唯一鍵是 (tenantId, dedupeKey)。少了 tenantId 那一半的話，
    // 兩家補習班的第二家會靜靜地收不到任何通知。
    await withoutTenantScope('端到端：兩家用同一個 scope', async () => {
      const mk = (tenantId, recipientId) => ({
        tenantId,
        recipientId,
        templateKey: 'grade.released',
        scope: 'same-scope',
        payload: { title: 'x' },
      });
      const a = await enqueueMany(prisma, [mk(f.tenant.id, f.student.id)], { now });
      const b = await enqueueMany(prisma, [mk(other.tenant.id, other.student.id)], { now });
      assert.equal(a.created, 1);
      assert.equal(b.created, 1, '不同租戶的同一個 scope 必須都寫得進去');
      await prisma.notification.deleteMany({ where: { templateKey: 'grade.released' } });
    });
  });

  // ── 三、送出 ───────────────────────────────────────────────────

  section('worker 送出 → 收件匣看得到 → 已讀');

  await test('送出之前收件匣是空的（QUEUED 的不畫出來）', async () => {
    // 收件匣列的是「已經送到的東西」。把 QUEUED 也畫出來的話，
    // 免打擾與節流全部失效——那兩件事就是靠 scheduledAt 生效的。
    assert.deepEqual(await inboxOf(f.student.id), []);
    assert.equal(await unreadOf(f.student.id), 0);
  });

  await test('worker 送出之後，收件匣看得到而且是未讀', async () => {
    const r = await withoutTenantScope('端到端：投遞', () =>
      deliverDue(prisma, { now: new Date(+now + 60_000) }),
    );
    assert.ok(r.sent > 0, '應該送出了幾則');
    const rows = await inboxOf(f.student.id);
    assert.deepEqual(keysOf(rows), ['assignment.due_soon', 'assignment.overdue']);
    for (const row of rows) assert.equal(row.readAt, null);
    assert.equal(await unreadOf(f.student.id), 2);
  });

  await test('每一則都畫得出標題、內文與一個站內的下一步', async () => {
    for (const row of await inboxOf(f.student.id)) {
      const v = render(row.templateKey, row.payload);
      assert.ok(v.known, `${row.templateKey} render 不出來`);
      assert.ok(v.title.length >= 4 && v.body.length >= 20);
      assert.match(v.href, /^\//);
    }
  });

  await test('重跑 worker 不會重複送', async () => {
    // **這是這一支最重要的一格。** 重複送的症狀是學生每 30 秒收到
    // 一則一樣的東西，而系統上一切正常。
    const before = await inboxOf(f.student.id);
    for (let i = 0; i < 5; i++) {
      const r = await withoutTenantScope('端到端：重複投遞', () =>
        deliverDue(prisma, { now: new Date(+now + 120_000 + i * 1000) }),
      );
      assert.equal(r.sent, 0, `第 ${i + 1} 次投遞不該再送任何一則`);
    }
    const after = await inboxOf(f.student.id);
    assert.equal(after.length, before.length);
    assert.deepEqual(
      after.map((r) => r.id).sort(),
      before.map((r) => r.id).sort(),
    );
  });

  await test('標成已讀之後未讀數歸零，而通知還在', async () => {
    const rows = await inboxOf(f.student.id);
    const n = await markReadFor(f.student.id, { ids: [rows[0].id] });
    assert.equal(n, 1);
    assert.equal(await unreadOf(f.student.id), 1);
    // 再標一次同一則不會再算一次（readAt 只寫一次——那個時刻是
    // 「他第一次看到」，蓋掉就沒有意義了）。
    assert.equal(await markReadFor(f.student.id, { ids: [rows[0].id] }), 0);
    await markReadFor(f.student.id, { all: true });
    assert.equal(await unreadOf(f.student.id), 0);
    assert.equal((await inboxOf(f.student.id)).length, rows.length, '已讀的通知還要在清單上');
  });

  await test('不可以標記別人的通知', async () => {
    // RLS 擋得住別家補習班，擋不住同一間補習班的隔壁同學。
    const [row] = await inboxOf(f.parent.id);
    assert.ok(row, '家長應該有一則');
    const n = await markReadFor(f.student.id, { ids: [row.id] });
    assert.equal(n, 0, '用別人的 id 一列都不該動到');
    const [again] = await inboxOf(f.parent.id);
    assert.equal(again.readAt, null, '家長那一則必須還是未讀');
  });

  // ── 四、免打擾與節流 ───────────────────────────────────────────

  section('免打擾與節流');

  await test('免打擾時段內的通知延後，不是丟掉，也不出現在收件匣', async () => {
    const quietNow = new Date(Date.UTC(2026, 8, 8, 19, 13)); // 台灣 9/9 03:13
    await withTenant(f.tenant.id, () =>
      prisma.notificationPreference.create({
        data: {
          userId: f.student.id,
          channels: {},
          quietHours: { start: '22:00', end: '07:00' },
        },
      }),
    );
    await withoutTenantScope('端到端：免打擾', async () => {
      const r = await enqueueMany(
        prisma,
        [
          {
            tenantId: f.tenant.id,
            recipientId: f.student.id,
            templateKey: 'grade.released',
            scope: 'quiet-test',
            payload: { assignmentId: f.soon.id, title: '半夜放行的考試' },
          },
        ],
        { now: quietNow },
      );
      assert.equal(r.created, 1, '通知要建立起來——延後不是丟掉');
      // 投遞的時刻仍在免打擾內 → 一則都不撈。
      const d1 = await deliverDue(prisma, { now: new Date(+quietNow + 60_000) });
      assert.equal(d1.sent, 0, '免打擾時段內不可以送出');
      // 早上七點之後 → 送出。
      const d2 = await deliverDue(prisma, { now: new Date(Date.UTC(2026, 8, 8, 23, 5)) });
      assert.equal(d2.sent, 1, '免打擾結束之後要送出');
    });
    const row = (await rowsOf(f.student.id)).find((r) => r.dedupeKey.endsWith(':quiet-test'));
    assert.equal(row.status, 'SENT');
    assert.ok(+new Date(row.scheduledAt) > +quietNow, 'scheduledAt 要被推到未來');
  });

  await test('節流：一分鐘內最多三則，其餘往後排而且一則都不少', async () => {
    await withTenant(f.tenant.id, () =>
      prisma.notificationPreference.deleteMany({ where: { userId: f.student.id } }),
    );
    const t0 = new Date(+now + 10 * DAY);
    await withoutTenantScope('端到端：節流', async () => {
      const specs = [];
      for (let i = 0; i < 6; i++) {
        specs.push({
          tenantId: f.tenant.id,
          recipientId: f.student.id,
          templateKey: 'grade.released',
          scope: `throttle-${i}`,
          payload: { assignmentId: f.soon.id, title: `第 ${i} 份` },
        });
      }
      const r = await enqueueMany(prisma, specs, { now: t0 });
      assert.equal(r.created, 6, '六則都要建立起來');
      const d = await deliverDue(prisma, { now: new Date(+t0 + 1000) });
      assert.equal(d.sent, MAX_PER_WINDOW, `一分鐘內只能送出 ${MAX_PER_WINDOW} 則`);
      const d2 = await deliverDue(prisma, { now: new Date(+t0 + 61_000) });
      assert.equal(d2.sent, 6 - MAX_PER_WINDOW, '其餘的在視窗空出來之後送出');
    });
    await withTenant(f.tenant.id, () =>
      prisma.notification.deleteMany({ where: { templateKey: 'grade.released' } }),
    );
  });

  // ── 五、未接的渠道 ─────────────────────────────────────────────

  section('未接的渠道');

  await test('EMAIL / LINE / SMS 立刻變成 SUPPRESSED，一列都不留在 QUEUED', async () => {
    // **這是這個功能最危險的一種失敗。** 留在 QUEUED 的通知是在說
    // 「排隊中，等一下就送」，而它永遠不會被送出——老師會以為
    // 家長收到了成績通知，然後在電話裡才發現沒有。
    await withoutTenantScope('端到端：未接的渠道', async () => {
      const r = await enqueueMany(
        prisma,
        ['EMAIL', 'LINE', 'SMS'].map((channel) => ({
          tenantId: f.tenant.id,
          recipientId: f.parent.id,
          channel,
          templateKey: 'assignment.overdue.guardian',
          scope: `channel-${channel}`,
          payload: { childName: '王大明', studentId: f.student.id, count: 1 },
        })),
        { now },
      );
      assert.equal(r.suppressed, 3);
      assert.equal(r.created, 0, '未接的渠道不算「已建立待送」');
    });
    const rows = (await rowsOf(f.parent.id)).filter((r) => r.channel !== 'IN_APP');
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.status, 'SUPPRESSED', `${row.channel} 不可以是 ${row.status}`);
      assert.ok(row.failReason && row.failReason.length > 10, `${row.channel} 沒有寫原因`);
      assert.equal(row.sentAt, null);
    }
    // 而且它們不會出現在收件匣（收件匣只列 SENT）。
    const inbox = await inboxOf(f.parent.id);
    assert.equal(inbox.length, 1, '站內的那一則，未接渠道的三則都不算');
    assert.equal(inbox[0].templateKey, 'assignment.overdue.guardian');

    // 全庫檢查：任何一列 QUEUED 都不可以是未接的渠道。
    const stuck = await withoutTenantScope('端到端：檢查佇列裡沒有未接的渠道', () =>
      prisma.notification.findMany({ where: { status: 'QUEUED' } }),
    );
    for (const row of stuck) {
      assert.equal(row.channel, 'IN_APP', `渠道 ${row.channel} 卡在 QUEUED`);
    }
  });

  await test('使用者關掉的類別也是 SUPPRESSED，不是靜靜地不建立', async () => {
    // 建立起來才查得到「為什麼我沒收到」。
    await withTenant(f.tenant.id, () =>
      prisma.notificationPreference.create({
        data: {
          userId: f.leaver.id,
          channels: { 'grade.released': { IN_APP: false } },
          quietHours: null,
        },
      }),
    );
    await withoutTenantScope('端到端：使用者關掉的類別', async () => {
      const r = await enqueueMany(
        prisma,
        [
          {
            tenantId: f.tenant.id,
            recipientId: f.leaver.id,
            templateKey: 'grade.released',
            scope: 'turned-off',
            payload: { assignmentId: f.soon.id, title: 'x' },
          },
        ],
        { now },
      );
      assert.equal(r.suppressed, 1);
    });
    const row = (await rowsOf(f.leaver.id)).find((r) => r.templateKey === 'grade.released');
    assert.ok(row, '關掉的類別仍然要建立一列，否則查不到「為什麼我沒收到」');
    assert.equal(row.status, 'SUPPRESSED');
    assert.match(row.failReason, /關掉/);
  });

  await test('必收的類別關不掉，就算偏好裡寫著關閉', async () => {
    // 直接往 channels 這個 JSON 塞 `{"attempt.voided":{"IN_APP":false}}`
    // 是繞過畫面的一次合法寫入，而它不可以生效——關掉之後學生
    // 永遠不知道自己的卷子不算數。
    await withTenant(f.tenant.id, () =>
      prisma.notificationPreference.updateMany({
        where: { userId: f.leaver.id },
        data: { channels: { 'attempt.voided': { IN_APP: false } } },
      }),
    );
    await withoutTenantScope('端到端：必收的類別', async () => {
      const r = await enqueueMany(
        prisma,
        [
          {
            tenantId: f.tenant.id,
            recipientId: f.leaver.id,
            templateKey: 'attempt.voided',
            scope: 'mandatory',
            payload: { assignmentId: f.late.id, title: '昨天就該交的週考' },
          },
        ],
        { now },
      );
      assert.equal(r.created, 1, '必收的類別一定要建立起來並排入佇列');
      assert.equal(r.suppressed, 0);
    });
    const row = (await rowsOf(f.leaver.id)).find((r) => r.templateKey === 'attempt.voided');
    assert.equal(row.status, 'QUEUED');
    assert.equal(row.failReason, null);
    // 而它的內容不可以出現作廢的理由（那是誠信事件，要由人說明）。
    const v = render(row.templateKey, row.payload);
    for (const word of ['作弊', '違規']) assert.ok(!v.body.includes(word));
    await withTenant(f.tenant.id, async () => {
      await prisma.notificationPreference.deleteMany({ where: { userId: f.leaver.id } });
      // 收掉這一列，下一節（投遞失敗）才數得清楚——留著它的話，
      // 那一節注入的失敗會同時打到兩列。
      await prisma.notification.deleteMany({ where: { id: row.id } });
    });
  });

  // ── 六、失敗與重試 ─────────────────────────────────────────────

  section('送出失敗、重試上限與失敗原因');

  await test('送出失敗會累加 retryCount、寫下 failReason，並在上限停手', async () => {
    // 無上限的重試會讓一則永遠送不出去的通知每分鐘失敗一次，而
    // failReason 每次被覆寫成一樣的字——沒有人看得出它試了三千次。
    await withoutTenantScope('端到端：投遞失敗', async () => {
      const t0 = new Date(+now + 20 * DAY);
      const key = `grade.released:${f.leaver.id}:will-fail`;
      await enqueueMany(
        prisma,
        [
          {
            tenantId: f.tenant.id,
            recipientId: f.leaver.id,
            templateKey: 'grade.released',
            scope: 'will-fail',
            payload: { assignmentId: f.soon.id, title: '送不出去的那一則' },
          },
        ],
        { now: t0 },
      );
      // 只讓目標那一列失敗。整批都失敗的話，這一格的計數會被同時
      // 在佇列裡的別的通知影響，而那種脆弱的斷言遲早會被改成
      // 「>= 1」然後失去意義。
      const fail = async (row) => {
        if (row.dedupeKey === key) throw new Error('假裝對方不通');
      };
      let at = +t0 + 60_000;
      for (let i = 1; i <= MAX_RETRY; i++) {
        // 退避會把 scheduledAt 推到未來，所以每一輪要把時間往前推。
        at += 20 * 60_000;
        const r = await deliverDue(prisma, { now: new Date(at), send: fail });
        const row = await prisma.notification.findFirst({
          where: { tenantId: f.tenant.id, dedupeKey: key },
        });
        assert.equal(row.retryCount, i, `第 ${i} 次之後 retryCount 應該是 ${i}`);
        assert.match(row.failReason, /假裝對方不通/, '失敗的原因要留著');
        if (i < MAX_RETRY) {
          assert.equal(r.failed, 1);
          assert.equal(row.status, 'QUEUED', '還沒到上限要放回佇列');
        } else {
          assert.equal(r.dead, 1);
          assert.equal(row.status, 'FAILED', '到了上限要停手');
          assert.match(row.failReason, /重試上限/);
        }
      }
      // 停手之後真的不再撈它。
      const after = await deliverDue(prisma, { now: new Date(at + DAY), send: fail });
      assert.equal(after.failed + after.dead, 0, 'FAILED 的不可以再被撈出來');
    });
  });

  await test('卡在「送出中」的會被放回佇列', async () => {
    // 行程被 kill（OOM、部署重啟）的那一列會永遠停在 SENDING，
    // 而沒有人再碰它。做法與 detect-stuck-imports 相同。
    await withoutTenantScope('端到端：卡住的投遞', async () => {
      const t0 = new Date(+now + 30 * DAY);
      await enqueueMany(
        prisma,
        [
          {
            tenantId: f.tenant.id,
            recipientId: f.leaver.id,
            templateKey: 'attempt.unvoided',
            scope: 'stuck',
            payload: { assignmentId: f.late.id, title: 'x' },
          },
        ],
        { now: t0 },
      );
      await prisma.notification.updateMany({
        where: { recipientId: f.leaver.id, templateKey: 'attempt.unvoided' },
        data: { status: 'SENDING' },
      });
      // 還沒超時 → 不動它（那可能是另一個實例正在送）。
      const soon = await deliverDue(prisma, { now: new Date(+t0 + 60_000) });
      assert.equal(soon.rescued, 0);
      // 超時之後 → 放回去並送出。
      const later = await deliverDue(prisma, { now: new Date(+t0 + 10 * 60_000) });
      assert.equal(later.rescued, 1);
      assert.equal(later.sent, 1);
    });
  });

  // ── 七、退出班級 ───────────────────────────────────────────────

  section('退出班級之後不再收到那個班的通知');

  await test('離班之後，新的一天的掃描一則都不給他', async () => {
    await withoutTenantScope('端到端：離班', async () => {
      // 先確認他在班上時真的收得到（換一個新的台灣日期，去重鍵才是新的）。
      const day2 = new Date(+now + DAY);
      // 讓「快到期」的任務在 day2 也還在視窗內。
      await prisma.assignment.updateMany({
        where: { id: f.soon.id },
        data: { dueAt: new Date(+day2 + 6 * HOUR) },
      });
      const before = await sweepDueSoon(prisma, { now: day2 });
      assert.ok(before.created >= 1, '在班上的時候收得到');
      const gotIt = (await rowsOf(f.leaver.id)).some(
        (r) => r.templateKey === 'assignment.due_soon',
      );
      assert.equal(gotIt, true, '離班之前應該收得到快到期的通知');

      // 退出班級。
      await prisma.classMembership.updateMany({
        where: { classId: f.klass.id, userId: f.leaver.id },
        data: { leftAt: day2 },
      });

      const countBefore = (await rowsOf(f.leaver.id)).length;
      const day3 = new Date(+now + 2 * DAY);
      await prisma.assignment.updateMany({
        where: { id: f.soon.id },
        data: { dueAt: new Date(+day3 + 6 * HOUR) },
      });
      await sweepDueSoon(prisma, { now: day3 });
      await sweepOverdue(prisma, { now: day3 });
      assert.equal(
        (await rowsOf(f.leaver.id)).length,
        countBefore,
        '離班之後一則都不可以再進來',
      );
      // 而還在班上的那一位照樣收得到（否則上面那一條可能只是掃描壞了）。
      const stillThere = (await rowsOf(f.student.id)).filter(
        (r) => r.dedupeKey.endsWith(`:${taipeiDayOf(day3)}`),
      );
      assert.ok(stillThere.length >= 1, '還在班上的學生必須照樣收得到');
    });
  });

  // ── 八、租戶隔離 ───────────────────────────────────────────────

  section('租戶隔離');

  await test('隔壁補習班的通知不會出現在這家的收件匣裡', async () => {
    await withoutTenantScope('端到端：兩家都送出', () =>
      deliverDue(prisma, { now: new Date(+now + 40 * DAY) }),
    );
    // 在本校的租戶脈絡下，看不到隔壁的任何一列。
    await withTenant(f.tenant.id, async () => {
      const all = await prisma.notification.findMany({});
      assert.ok(all.length > 0, '本校自己的通知要看得到');
      for (const row of all) {
        assert.equal(row.tenantId, f.tenant.id, `跨界了：${row.tenantId}`);
      }
      // 直接拿隔壁學生的 id 去查收件匣，一列都不該有。
      assert.deepEqual(
        await inboxPage(prisma, other.student.id, { take: 50 }),
        { rows: [], hasMore: false },
        'RLS 應該讓隔壁的通知整個消失',
      );
      assert.equal(await unreadCount(prisma, other.student.id), 0);
      // 也不可以標記隔壁的。
      assert.equal(await markRead(prisma, other.student.id, { all: true }), 0);
    });
  });

  await test('每一列通知的 tenantId 都與收件人的租戶一致', async () => {
    // 掃描是跨租戶跑的，而 tenantId 決定這一列屬於誰。對不上時
    // 寫下去就是把一家補習班的資料放進另一家。
    await withoutTenantScope('端到端：對照收件人的租戶', async () => {
      const rows = await prisma.notification.findMany({});
      const users = await prisma.user.findMany({ select: { id: true, tenantId: true } });
      const tenantOf = new Map(users.map((u) => [u.id, u.tenantId]));
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.equal(
          row.tenantId,
          tenantOf.get(row.recipientId),
          `通知 ${row.dedupeKey} 的租戶與收件人的不同`,
        );
      }
    });
  });

  // ── 九、家長看得到什麼 ─────────────────────────────────────────

  section('家長只收得到自己孩子的，而且欄位只減不加');

  await test('家長的通知只關於自己的孩子', async () => {
    await withTenant(f.tenant.id, async () => {
      const rows = await inboxOf(f.parent.id);
      assert.ok(rows.length >= 1);
      for (const row of rows) {
        assert.equal(row.payload.studentId, f.student.id, '不可以是別人的孩子');
      }
    });
  });

  await test('未驗證的家長連結一則都收不到', async () => {
    // `verifiedAt` 擋的正是「把成績寄給陌生人」——名冊上的家長信箱
    // 是櫃檯打的，打錯的方向不是「寄不到」而是「寄到另一個人那裡」。
    assert.deepEqual(await rowsOf(f.unverified.id), []);
  });

  await test('家長的通知不含逐題作答、智慧老師或監考的任何內容', async () => {
    // **通知是把資料推出去的，比一個頁面更難收回來。**
    const banned = [
      'answerKeys',
      'answerText',
      'answerSlots',
      'isCorrect',
      'earnedScore',
      'totalScore',
      'autoScore',
      'tutor',
      'proctor',
      'reason',
    ];
    const rows = await withTenant(f.tenant.id, () => inboxOf(f.parent.id));
    for (const row of rows) {
      const json = JSON.stringify(row.payload);
      for (const word of banned) {
        assert.ok(!json.includes(word), `家長的 payload 出現了 ${word}：${json}`);
      }
      // 畫出來的字裡也不可以有分數。家長看得到的成績只在
      // `/guardian` 那一頁（老師放行之後），不是在一則推出去的通知裡。
      const v = render(row.templateKey, row.payload);
      assert.ok(!/\d+\s*分/.test(v.body), `家長的通知出現了分數：${v.body}`);
      // 而且要說得出下一步，而那條路是家長端的（不是學生的檢討頁）。
      assert.match(v.href, /^\/guardian/);
    }
  });

  await test('家長那一則的 payload 欄位是一份白名單', async () => {
    // **用共用的那一份清單，不再在這裡抄一份。** 抄的那一份與正本
    // 分歧時，分歧的方向是「這裡是綠的而正本已經放寬了」——而這一格
    // 存在的理由正是「真的寫進資料庫的那一列長什麼樣」。
    // 新增欄位的把關在 `GUARDIAN_PAYLOAD_KEYS` 那段註解上：它要求
    // 說出為什麼那個欄位不是逐題作答、對話或監考資料。
    const allowed = new Set(GUARDIAN_PAYLOAD_KEYS);
    const rows = await withTenant(f.tenant.id, () => inboxOf(f.parent.id));
    for (const row of rows) {
      for (const key of Object.keys(row.payload ?? {})) {
        assert.ok(allowed.has(key), `家長的 payload 多了 ${key}——欄位只減不加`);
      }
    }
  });

  // ── 十、老師那一側 ─────────────────────────────────────────────

  section('老師的通知');

  await test('匯入完成與失敗都通知得到，而且只通知一次', async () => {
    await withoutTenantScope('端到端：匯入通知', async () => {
      const t0 = new Date(+now + 50 * DAY);
      const mkJob = (title, status, error) =>
        prisma.importJob.create({
          data: {
            tenantId: f.tenant.id,
            subjectId: f.subject.id,
            title,
            status,
            sourceType: 'TEACHER_ORIGINAL',
            licenseScope: 'TENANT_EXPORTABLE',
            rightsDeclaredBy: f.teacher.id,
            rightsDeclaredName: '數學老師',
            rightsBasis: 'OWNED',
            createdBy: f.teacher.id,
            totalCandidates: 48,
            error,
            updatedAt: t0,
          },
        });
      await mkJob('115 學測模擬卷', 'READY_FOR_REVIEW', null);
      await mkJob('壞掉的那一份', 'FAILED', '切題階段停在 60 分鐘沒有進展，判定為中斷');

      const r1 = await sweepImports(prisma, { now: t0 });
      assert.equal(r1.created, 2);
      // 跑十次不會變成二十則。
      for (let i = 0; i < 10; i++) {
        const r = await sweepImports(prisma, { now: new Date(+t0 + i * 1000) });
        assert.equal(r.created, 0);
      }
    });
    const keys = keysOf(await rowsOf(f.teacher.id));
    assert.ok(keys.includes('import.ready'));
    assert.ok(keys.includes('import.failed'));
    const failedRow = (await rowsOf(f.teacher.id)).find((r) => r.templateKey === 'import.failed');
    // 失敗的原因要進到文案裡：老師的下一步（從哪一階段繼續）就在裡面。
    assert.match(render(failedRow.templateKey, failedRow.payload).body, /切題階段/);
  });

  await test('有非選題等閱卷時通知派卷的老師，一份任務只一次', async () => {
    await withoutTenantScope('端到端：待閱卷通知', async () => {
      const t0 = new Date(+now + 60 * DAY);
      // 計分跑過（gradedAt 有值）卻還停在 SUBMITTED —— 那正是
      // lib/scoring.ts 在 pendingManual > 0 時做的事。
      await prisma.attempt.create({
        data: {
          assignmentId: f.late.id,
          userId: f.student.id,
          attemptNo: 1,
          status: 'SUBMITTED',
          startedAt: new Date(+t0 - HOUR),
          submittedAt: t0,
          gradedAt: t0,
          layout: [{ questionId: f.question.id, order: 1, score: 5 }],
        },
      });
      const r1 = await sweepGrading(prisma, { now: t0 });
      assert.equal(r1.created, 1);
      for (let i = 0; i < 10; i++) {
        const r = await sweepGrading(prisma, { now: new Date(+t0 + i * 1000) });
        assert.equal(r.created, 0, '同一份任務不可以每輪都播報一次');
      }
    });
    assert.ok(keysOf(await rowsOf(f.teacher.id)).includes('grading.pending'));
  });

  await test('老師收不到學生與家長的那幾類，學生收不到老師的', async () => {
    // 收件匣本來就只查得到自己那幾列，這裡驗的是掃描沒有把類別派錯人
    // ——派錯的症狀是學生看到「有卷子等你閱卷」，然後以為系統把他
    // 當成老師。
    const teacherKeys = new Set(keysOf(await rowsOf(f.teacher.id)));
    for (const k of ['assignment.due_soon', 'assignment.overdue', 'attempt.voided']) {
      assert.equal(teacherKeys.has(k), false, `老師不該收到 ${k}`);
    }
    const studentKeys = new Set(keysOf(await rowsOf(f.student.id)));
    for (const k of ['import.ready', 'import.failed', 'grading.pending']) {
      assert.equal(studentKeys.has(k), false, `學生不該收到 ${k}`);
    }
  });

  // ── 十一、分頁 ─────────────────────────────────────────────────

  section('收件匣分頁');

  await test('游標分頁：翻到更早的不會重複也不會跳過', async () => {
    // 用 skip 的話，讀完第一頁、期間來了兩則新的，第二頁會把第一頁
    // 最後兩則再顯示一次——而使用者會以為自己看漏了。
    const first = await withTenant(f.tenant.id, () =>
      inboxPage(prisma, f.student.id, { take: 2 }),
    );
    assert.equal(first.rows.length, 2);
    assert.equal(first.hasMore, true);
    const second = await withTenant(f.tenant.id, () =>
      inboxPage(prisma, f.student.id, {
        take: 2,
        before: first.rows[first.rows.length - 1].createdAt,
      }),
    );
    const ids = new Set(first.rows.map((r) => r.id));
    for (const row of second.rows) {
      assert.equal(ids.has(row.id), false, '第二頁不可以重複第一頁的東西');
    }
  });

  // ── 十二、送出前重新確認事實 ───────────────────────────────────
  //
  // 產生與送出之間可以隔八個小時（免打擾 22:00–07:00），而通知的內容
  // 在**產生**的那一刻就寫死了。這一段驗的是那個窗口：排隊期間孩子
  // 補交了，早上七點還會不會送出去。
  //
  // 這件事在單元測試裡用假的資料庫驗過分支，但**真正會出錯的地方在
  // 這裡**：payload 是 jsonb（進去出來還是不是同一個陣列）、
  // `attempt` 的比對是跨兩張表的、而 `deliverDue` 是工作者真的會跑的
  // 那一支。

  section('排隊期間事實變了');

  await test('排到早上七點的催繳，孩子半夜補交之後就不送了', async () => {
    await withoutTenantScope('端到端：排隊期間補交', async () => {
      // 乾淨的起點：這位家長與學生前面幾段已經收過東西了。
      await prisma.notification.deleteMany({ where: { recipientId: f.parent.id } });
      await prisma.notification.deleteMany({ where: { recipientId: f.student.id } });
      await prisma.attempt.deleteMany({ where: { assignmentId: f.soon.id } });

      // 三天後的深夜那一輪：`soon`（12 小時後截止的那一份）這時已經
      // 逾期，而且還在三天的回看視窗內，所以家長與學生各一則。
      const night = new Date(+now + 3 * DAY);
      const gen = await sweepOverdue(prisma, { now: night });
      assert.ok(gen.created >= 2, `逾期掃描沒有產生通知：${JSON.stringify(gen)}`);

      const before = await prisma.notification.findMany({
        where: { recipientId: f.parent.id, status: 'QUEUED' },
      });
      assert.equal(before.length, 1, '家長那一則沒有排進佇列');
      // 送出前要重新確認的那幾份**真的存進去了**（jsonb 進出之後
      // 還是一個陣列）。少了它，重新確認會走「舊格式，照送」那一條，
      // 而每一格都會是綠的。
      assert.ok(
        Array.isArray(before[0].payload.assignmentIds) &&
          before[0].payload.assignmentIds.includes(f.soon.id),
        `payload 沒有帶要重新確認的那幾份：${JSON.stringify(before[0].payload)}`,
      );

      // 半小時後：王大明補交了。
      await prisma.attempt.create({
        data: {
          assignmentId: f.soon.id,
          userId: f.student.id,
          attemptNo: 1,
          status: 'SUBMITTED',
          startedAt: night,
          submittedAt: new Date(+night + 30 * 60_000),
          late: true,
        },
      });

      // 早上七點：工作者送出這一輪。
      // **這一輪是跨租戶的**（工作者不屬於任何一家補習班），所以
      // 前面幾段留下來的列也會一起被送出——斷言要落在這兩則本身，
      // 不是整輪的總數。
      const out = await deliverDue(prisma, { now: new Date(+night + 8 * HOUR) });
      assert.ok(out.suppressed >= 2, `應該兩則都攔下來：${JSON.stringify(out)}`);

      for (const uid of [f.parent.id, f.student.id]) {
        const rows = await prisma.notification.findMany({ where: { recipientId: uid } });
        assert.equal(rows.length, 1);
        // **不是刪掉**：查得到才答得出「為什麼那天早上沒有收到催繳」。
        assert.equal(rows[0].status, 'SUPPRESSED', `${uid} 那一則還是送出去了`);
        assert.match(rows[0].failReason ?? '', /不成立/, '沒有寫下原因');
      }
      // 而收件匣裡看不到它——SUPPRESSED 的不畫（`inboxPage` 只撈 SENT）。
      const { rows } = await inboxPage(prisma, f.parent.id, { take: 10 });
      assert.equal(rows.length, 0, '被攔下來的那一則出現在收件匣裡了');
    });
  });

  await test('三份裡只補交一份的時候照送——下一步仍然成立', async () => {
    await withoutTenantScope('端到端：只補交其中一份', async () => {
      await prisma.notification.deleteMany({ where: { recipientId: f.parent.id } });
      await prisma.notification.deleteMany({ where: { recipientId: f.student.id } });

      // 兩份都落在「四天後」那一輪的回看視窗內。
      const mk = async (title, dueAt) => {
        const a = await prisma.assignment.create({
          data: {
            tenantId: f.tenant.id,
            paperId: f.paper.id,
            title,
            mode: 'EXAM',
            maxAttempts: 1,
            dueAt,
            createdBy: f.teacher.id,
          },
        });
        await prisma.assignmentTarget.create({
          data: { assignmentId: a.id, classId: f.klass.id },
        });
        return a;
      };
      const one = await mk('本校·兩天後的作業', new Date(+now + 2 * DAY));
      await mk('本校·三天後的作業', new Date(+now + 3 * DAY));

      const night = new Date(+now + 4 * DAY);
      await sweepOverdue(prisma, { now: night });
      const queued = await prisma.notification.findMany({
        where: { recipientId: f.parent.id, status: 'QUEUED' },
      });
      assert.equal(queued.length, 1);
      assert.equal(queued[0].payload.count, 2, '摘要應該是兩份');

      // 只補交其中一份。
      await prisma.attempt.create({
        data: {
          assignmentId: one.id,
          userId: f.student.id,
          attemptNo: 1,
          status: 'SUBMITTED',
          startedAt: night,
          submittedAt: new Date(+night + 30 * 60_000),
        },
      });

      const out = await deliverDue(prisma, { now: new Date(+night + 8 * HOUR) });
      assert.ok(out.sent >= 2, `還有一份沒交，這一則應該照送：${JSON.stringify(out)}`);
      const rows = await prisma.notification.findMany({
        where: { recipientId: f.parent.id },
      });
      assert.equal(rows[0].status, 'SENT');
    });
  });

  // ── 十三、保存期限 ─────────────────────────────────────────────

  section('保存期限');

  await test('過了期限的通知真的被刪掉，卡在佇列裡的留著', async () => {
    await withoutTenantScope('端到端：保存期限', async () => {
      await prisma.notification.deleteMany({ where: { recipientId: f.leaver.id } });
      const old = new Date(+now - (NOTIFICATION_RETENTION_DAYS + 30) * DAY);
      const mk = (tag, status, createdAt) =>
        prisma.notification.create({
          data: {
            tenantId: f.tenant.id,
            recipientId: f.leaver.id,
            channel: 'IN_APP',
            templateKey: 'assignment.overdue',
            payload: {},
            status,
            scheduledAt: createdAt,
            createdAt,
            dedupeKey: `retention:${f.leaver.id}:${tag}`,
          },
        });
      await mk('old-sent', 'SENT', old);
      await mk('old-failed', 'FAILED', old);
      await mk('old-queued', 'QUEUED', old);
      await mk('fresh', 'SENT', now);

      const r = await purgeOldNotifications(prisma, { now });
      assert.ok(r.deleted >= 2, `該刪的沒有刪：${JSON.stringify(r)}`);
      const left = await prisma.notification.findMany({ where: { recipientId: f.leaver.id } });
      const keys = left.map((x) => x.dedupeKey).sort();
      // 卡在佇列裡一年的那一列是一個症狀，刪掉它等於把唯一的線索
      // 清乾淨，而卡住的原因會繼續存在。
      assert.deepEqual(
        keys,
        [`retention:${f.leaver.id}:fresh`, `retention:${f.leaver.id}:old-queued`],
        '刪錯了東西',
      );
    });
  });
}

/** 台灣日期。與 lib/notify.mjs 的 taipeiDay 同一個算法，只給斷言用。 */
function taipeiDayOf(at) {
  return new Date(+at + 480 * 60_000).toISOString().slice(0, 10);
}

main()
  .catch(async (e) => {
    console.error('\n端到端測試本身出錯：', e);
    failed++;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    console.log(`\n${passed} 通過，${failed} 失敗`);
    process.exit(failed > 0 ? 1 : 0);
  });
