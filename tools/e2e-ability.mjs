/**
 * 能力分析對真的 Postgres 的端到端驗證。
 *
 * 掌握度的公式本身有 49 個單元測試（apps/web/tests/ability.test.mjs），
 * 這一支**不重複測它們**。它驗的是跨越資料庫邊界之後還對不對：
 *
 *   · `refreshAbility` 的每一句查詢在真的 schema 上跑得動
 *     （欄位名、型別、`ability_snapshots` 的唯一鍵）
 *   · 老師改了標準答案重新計分之後，快照真的跟著改
 *   · **作廢的作答不算進去**，撤銷作廢之後又算回來
 *   · 標註被拿掉之後，那一筆快照會消失而不是留一個 0
 *   · RLS：隔壁補習班的作答不會混進這家的掌握度
 *   · **整批重算與逐次更新算出一模一樣的結果**
 *
 * 最後那一項是這一支最重要的斷言。兩條路徑算出不同答案的話，沒有人
 * 知道哪一個是對的——而它們不一致的症狀是「重建了一次，全班的掌握度
 * 都變了」，那時已經沒有任何辦法判斷該相信哪一次。
 *
 * # 為什麼用 pg-shim 而不是 PrismaClient
 *
 * 理由見 tools/pg-shim.mjs 的檔頭：Prisma 的查詢引擎要從外部網域下載，
 * 而這套系統要部署的補習班機房是封閉網段。shim 從同一份 schema 取得
 * 欄位對應，所以欄位名寫錯一樣會被抓到。
 *
 * # 這一支跑的是正式程式，不是複製品
 *
 * `refreshAbility` / `rebuildAbility` 直接從 `apps/web/lib/ability.mjs`
 * import——與網頁端、與整批重算腳本用的是同一份。所以這裡綠燈代表
 * 那一份會動，不是代表「一份長得很像的東西會動」。
 *
 * 唯一沒有被這支跑到的是 `lib/scoring.ts` 裡呼叫它的那一行（那是
 * TypeScript，端到端測試不編譯 TS），而那一行由 tsc 與 next build 顧著。
 * 底下的 `regrade()` 逐句對應 `gradeAttemptById` 的寫回與呼叫方式。
 *
 * 用法（要先有一個套過遷移的資料庫）：
 *   DATABASE_URL=postgresql://… node tools/e2e-ability.mjs
 */
import assert from 'node:assert/strict';

import { createPgShim } from './pg-shim.mjs';
import {
  computeSnapshots,
  knowledgePointsOfQuestions,
  masteryOf,
  rebuildAbility,
  refreshAbility,
  MIN_ITEMS,
} from '../apps/web/lib/ability.mjs';
import { gradeAttempt } from '../apps/web/lib/grading.mjs';
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
    console.error(`     ${e.message.split('\n').slice(0, 6).join('\n     ')}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
}

const HASH = '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);

// ── 建置 ─────────────────────────────────────────────────────────

/**
 * 一家補習班：一位學生、一位同學、三個知識點（含一條前置關係）、
 * 九題（難度各異、其中一題掛兩個知識點）、一份卷、一個任務。
 *
 * 兩家用同一個函式建，理由與 tools/e2e-exam.mjs 相同：兩邊的資料形狀
 * 一模一樣、只有 tenantId 不同，所以任何一列跨界出現在對方的結果裡，
 * 都只可能是隔離漏了。
 */
async function seedTenant(spec) {
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
  const teacher = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: `${spec.prefix}-T01`,
      displayName: `${spec.tag}的數學老師`,
      systemRole: 'TEACHER',
      passwordHash: HASH,
    },
  });
  const student = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: `${spec.prefix}-S01`,
      displayName: `${spec.tag}的學生甲`,
      systemRole: 'STUDENT',
      passwordHash: HASH,
    },
  });
  const classmate = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: `${spec.prefix}-S02`,
      displayName: `${spec.tag}的學生乙`,
      systemRole: 'STUDENT',
      passwordHash: HASH,
    },
  });
  const subject = await prisma.subject.create({
    data: { tenantId: tenant.id, code: 'MATH_A', name: '數學A', gsatFullScore: 100 },
  });
  const klass = await prisma.class.create({
    data: { tenantId: tenant.id, academicYearId: year.id, name: '三年甲班' },
  });
  for (const u of [student, classmate]) {
    await prisma.classMembership.create({
      data: { classId: klass.id, userId: u.id, role: 'STUDENT' },
    });
  }

  // 知識點。衰減率刻意不同：程序性的（計算）忘得快，概念性的慢。
  // 這是為了驗「每個知識點用自己的 decayRate」真的有走到資料庫那一層。
  const kpPerm = await prisma.knowledgePoint.create({
    data: { tenantId: tenant.id, subjectId: subject.id, name: '排列組合', decayRate: 0.05 },
  });
  const kpProb = await prisma.knowledgePoint.create({
    data: { tenantId: tenant.id, subjectId: subject.id, name: '機率統計', decayRate: 0.05 },
  });
  const kpFast = await prisma.knowledgePoint.create({
    data: { tenantId: tenant.id, subjectId: subject.id, name: '三角函數', decayRate: 0.9 },
  });
  // 機率統計需要先會排列組合。學生端的「先補前置」走的就是這一條。
  await prisma.kpPrerequisite.create({
    data: { kpId: kpProb.id, prereqKpId: kpPerm.id, strength: 1 },
  });

  /** 一題單選＋五個選項。選項要真的建，多選的部分給分公式數的是它。 */
  const makeQuestion = async (tag, answerKeys, difficulty, type = 'SINGLE_CHOICE') => {
    const q = await prisma.question.create({
      data: {
        tenantId: tenant.id,
        subjectId: subject.id,
        familyId: `${spec.prefix}-${tag}`,
        version: 1,
        type,
        content: `${spec.tag}：${tag}`,
        score: 5,
        answerKeys,
        difficulty,
        sourceType: 'TEACHER_ORIGINAL',
        licenseScope: 'TENANT_EXPORTABLE',
        status: 'PUBLISHED',
      },
    });
    for (let i = 1; i <= 5; i++) {
      await prisma.questionOption.create({
        data: { questionId: q.id, order: i, label: `(${i})`, content: `${tag} 選項 ${i}` },
      });
    }
    return q;
  };

  // 機率統計六題（含一題難、一題送分、一題沒有難度資料），
  // 排列組合兩題，三角函數一題。
  const qs = {
    p1: await makeQuestion('prob-1', [1], 0.9),
    p2: await makeQuestion('prob-2', [2], 0.1),
    p3: await makeQuestion('prob-3', [3], null),
    p4: await makeQuestion('prob-4', [4], 0.5),
    p5: await makeQuestion('prob-5', [5], 0.5),
    p6: await makeQuestion('prob-6', [1], 0.5),
    m1: await makeQuestion('perm-1', [2], 0.5),
    m2: await makeQuestion('perm-2', [3], 0.5),
    t1: await makeQuestion('trig-1', [4], 0.5),
    // 非選題：交卷時算不出對錯（isCorrect 是 null），不該進掌握度。
    e1: await makeQuestion('essay-1', [], 0.5, 'ESSAY'),
  };

  const link = (q, kp, weight = 1) =>
    prisma.questionKnowledgePoint.create({
      data: { questionId: q.id, knowledgePointId: kp.id, weight },
    });
  for (const k of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) await link(qs[k], kpProb);
  await link(qs.m1, kpPerm);
  await link(qs.m2, kpPerm);
  await link(qs.t1, kpFast);
  // 一題掛兩個知識點：p6 同時考機率與排列組合（權重比較低）。
  await link(qs.p6, kpPerm, 0.5);
  await link(qs.e1, kpProb);

  const paper = await prisma.examPaper.create({
    data: {
      tenantId: tenant.id,
      subjectId: subject.id,
      title: `${spec.tag}·能力分析用卷`,
      status: 'READY',
      totalScore: 50,
      createdBy: teacher.id,
    },
  });
  const order = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'm1', 'm2', 't1', 'e1'];
  for (const [i, key] of order.entries()) {
    await prisma.examPaperItem.create({
      data: { paperId: paper.id, questionId: qs[key].id, order: i + 1, score: 5 },
    });
  }

  const assignment = await prisma.assignment.create({
    data: {
      tenantId: tenant.id,
      paperId: paper.id,
      title: `${spec.tag}·第一次段考`,
      mode: 'EXAM',
      maxAttempts: 5,
      createdBy: teacher.id,
    },
  });
  await prisma.assignmentTarget.create({
    data: { assignmentId: assignment.id, classId: klass.id },
  });

  return { tenant, teacher, student, classmate, subject, klass, kpPerm, kpProb, kpFast, qs, order, paper, assignment };
}

/**
 * 造一份已交卷的作答。`picks` 是 questionKey → 學生選的選項。
 * 沒列到的題目**不建作答列**——學生跳過的題目本來就不會送出任何東西。
 */
async function makeAttempt(f, user, attemptNo, when, picks) {
  const attempt = await prisma.attempt.create({
    data: {
      assignmentId: f.assignment.id,
      userId: user.id,
      attemptNo,
      status: 'SUBMITTED',
      startedAt: when,
      submittedAt: when,
      layout: f.order.map((key, i) => ({
        questionId: f.qs[key].id,
        order: i + 1,
        score: 5,
        optionOrder: [1, 2, 3, 4, 5],
      })),
    },
  });
  for (const [key, keys] of Object.entries(picks)) {
    await prisma.attemptAnswer.create({
      data: {
        attemptId: attempt.id,
        questionId: f.qs[key].id,
        answerKeys: keys,
        // 作答時間就是這一份的交卷時間。掌握度的時間加權讀的是它——
        // 不是 createdAt，也不是快照的 updatedAt。
        answeredAt: when,
      },
    });
  }
  return attempt;
}

/**
 * 計分一份作答，並更新能力快照。
 *
 * **逐句對應 `lib/scoring.ts` 的 `gradeAttemptById`**：算 → 只寫
 * isCorrect / earnedScore / scoreNote → 更新總分 → 用這份卷子的
 * questionId 去限定重算範圍。這裡是端到端測試唯一一段「複製」的程式，
 * 所以刻意寫得最短，而且不加任何 scoring.ts 沒有的邏輯。
 */
async function regrade(f, attemptId) {
  const attempt = await prisma.attempt.findFirst({ where: { id: attemptId } });
  const answers = await prisma.attemptAnswer.findMany({ where: { attemptId } });
  const layout = attempt.layout;
  const questions = await prisma.question.findMany({
    where: { id: { in: layout.map((l) => l.questionId) } },
  });
  const byId = new Map(questions.map((q) => [q.id, q]));

  const items = layout.map((l, i) => {
    const q = byId.get(l.questionId);
    return {
      questionId: l.questionId,
      order: l.order ?? i + 1,
      type: q?.type ?? '',
      score: l.score ?? 0,
      correctKeys: q?.answerKeys ?? [],
      correctSlots: q?.answerSlots ?? null,
      correctText: q?.answerText ?? null,
      optionCount: 5,
      scoringRule: q?.scoringRule ?? null,
      optionOrder: l.optionOrder,
    };
  });
  const graded = gradeAttempt(
    items,
    answers.map((a) => ({
      questionId: a.questionId,
      answerKeys: a.answerKeys,
      answerText: a.answerText,
      answerSlots: a.answerSlots,
    })),
  );

  const rowOf = new Map(answers.map((a) => [a.questionId, a]));
  for (const r of graded.results) {
    const row = rowOf.get(r.questionId);
    if (!row) continue;
    await prisma.attemptAnswer.update({
      where: { id: row.id },
      data: { isCorrect: r.isCorrect, earnedScore: r.earnedScore, scoreNote: r.scoreNote },
    });
  }
  await prisma.attempt.update({
    where: { id: attempt.id },
    data: { autoScore: graded.autoScore, totalScore: graded.autoScore, gradedAt: new Date(), status: 'GRADED' },
  });

  // 這一行就是掛在計分之後的鉤子（scoring.ts 裡是
  // `refreshAbilityAfterGrading(attempt.userId, source.map(s => s.questionId))`）。
  const kpIds = await knowledgePointsOfQuestions(prisma, layout.map((l) => l.questionId));
  if (kpIds.length) {
    await refreshAbility(prisma, {
      tenantId: f.tenant.id,
      userId: attempt.userId,
      knowledgePointIds: kpIds,
    });
  }
  return graded;
}

/** 這位學生現在的快照，照知識點 id 排好，方便逐列比對。 */
async function snapshotsOf(userId) {
  const rows = await prisma.abilitySnapshot.findMany({ where: { userId } });
  return rows
    .map((r) => ({
      knowledgePointId: r.knowledgePointId,
      correct: r.correct,
      total: r.total,
      mastery: r.mastery,
      reliable: r.reliable,
      streakWrong: r.streakWrong,
      lastAnsweredAt: r.lastAnsweredAt ? new Date(r.lastAnsweredAt).getTime() : null,
    }))
    .sort((a, b) => (a.knowledgePointId < b.knowledgePointId ? -1 : 1));
}

/** 逐列比對兩份快照。掌握度用容差——兩條路徑的 `now` 差幾秒是正常的。 */
function assertSameSnapshots(a, b, why) {
  assert.equal(a.length, b.length, `${why}：知識點的筆數不同`);
  for (const [i, x] of a.entries()) {
    const y = b[i];
    assert.equal(x.knowledgePointId, y.knowledgePointId, `${why}：第 ${i} 列不是同一個知識點`);
    assert.deepEqual(
      { c: x.correct, t: x.total, r: x.reliable, s: x.streakWrong, l: x.lastAnsweredAt },
      { c: y.correct, t: y.total, r: y.reliable, s: y.streakWrong, l: y.lastAnsweredAt },
      `${why}：${x.knowledgePointId} 的計數對不上`,
    );
    assert.ok(
      Math.abs(x.mastery - y.mastery) <= 1e-4,
      `${why}：${x.knowledgePointId} 的掌握度 ${x.mastery} ≠ ${y.mastery}`,
    );
  }
}

// ── 主流程 ───────────────────────────────────────────────────────

async function main() {
  const fixture = await withoutTenantScope('能力分析端到端：清庫並建出兩家補習班', async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE tenants, subjects, publishers, official_source_fetches
      RESTART IDENTITY CASCADE
    `);
    const mine = await seedTenant({ name: '端到端測試補習班', prefix: 'A', tag: '本校' });
    const other = await seedTenant({ name: '隔壁補習班', prefix: 'B', tag: '隔壁' });
    return { mine, other };
  });
  return withTenant(fixture.mine.tenant.id, () => mainScoped(fixture));
}

async function mainScoped({ mine: f, other }) {
  const { student, kpProb, kpPerm, kpFast } = f;

  // ── 一、逐次更新 ───────────────────────────────────────────────

  section('交卷計分之後，快照跟著出現');

  // 三次作答，時間拉開：三個月前、一個月前、今天。
  // 答對的用正確選項，答錯的故意選 5（除了答案本來就是 5 的 p5）。
  const a1 = await makeAttempt(f, student, 1, daysAgo(90), {
    p1: [1], p2: [5], p3: [3], m1: [2], t1: [4],
  });
  const a2 = await makeAttempt(f, student, 2, daysAgo(30), {
    p4: [5], p5: [5], m2: [3],
  });
  const a3 = await makeAttempt(f, student, 3, daysAgo(1), {
    p6: [1], p2: [2], e1: [],
  });

  await test('第一份計分之後就有快照，而且原始計數是數得出來的', async () => {
    await regrade(f, a1.id);
    const snaps = await snapshotsOf(student.id);
    const by = new Map(snaps.map((s) => [s.knowledgePointId, s]));

    const prob = by.get(kpProb.id);
    assert.ok(prob, '機率統計要有一列');
    // 第一份裡機率統計考了 p1(對) p2(錯) p3(對)
    assert.equal(prob.total, 3);
    assert.equal(prob.correct, 2);
    assert.equal(prob.reliable, false, `只有 3 題，低於門檻 ${MIN_ITEMS}`);
    assert.ok(prob.mastery > 0 && prob.mastery < 1);

    assert.equal(by.get(kpPerm.id).total, 1, '排列組合只考了 m1');
    assert.equal(by.get(kpFast.id).total, 1);
  });

  await test('沒有評分的非選題不算證據', async () => {
    await regrade(f, a3.id);
    const rows = await prisma.attemptAnswer.findMany({ where: { attemptId: a3.id } });
    const essay = rows.find((r) => r.questionId === f.qs.e1.id);
    assert.equal(essay.isCorrect, null, '作文交卷時算不出對錯');

    const by = new Map((await snapshotsOf(student.id)).map((s) => [s.knowledgePointId, s]));
    // 第一份 3 題 + 第三份的 p6、p2（重考）= 5 題。作文不算。
    assert.equal(by.get(kpProb.id).total, 5, '作文那一題不進分母');
  });

  await test('一題掛兩個知識點時，兩邊都拿到證據', async () => {
    const by = new Map((await snapshotsOf(student.id)).map((s) => [s.knowledgePointId, s]));
    // p6 同時掛機率（權重 1）與排列組合（權重 0.5）
    assert.equal(by.get(kpPerm.id).total, 2, 'm1 + p6');
  });

  await test('同一個學生重複重算不會長出第二列（唯一鍵 userId+kpId）', async () => {
    const before = await snapshotsOf(student.id);
    await regrade(f, a1.id);
    await regrade(f, a3.id);
    const after = await snapshotsOf(student.id);
    assert.equal(before.length, after.length);
    assertSameSnapshots(before, after, '重複重算');
  });

  await test('三份都計分之後，樣本夠的知識點才標成可靠', async () => {
    await regrade(f, a2.id);
    const by = new Map((await snapshotsOf(student.id)).map((s) => [s.knowledgePointId, s]));
    // 機率：p1 p2 p3（第一份）＋ p4 p5（第二份）＋ p6 p2（第三份）= 7
    assert.equal(by.get(kpProb.id).total, 7);
    assert.equal(by.get(kpProb.id).reliable, true, '七題而且有近期的作答');
    assert.equal(by.get(kpPerm.id).total, 3);
    assert.equal(by.get(kpPerm.id).reliable, false, '三題不足以下結論');
  });

  await test('連續答錯記得起來（那是「卡住了」的提示來源）', async () => {
    const by = new Map((await snapshotsOf(student.id)).map((s) => [s.knowledgePointId, s]));
    // 機率最後三題依時間序：p4(錯) p5(對) → 一個月前；p6(對) p2(對) → 昨天
    assert.equal(by.get(kpProb.id).streakWrong, 0, '最近一題是答對的');
    // 三角函數只考過一次而且答對
    assert.equal(by.get(kpFast.id).streakWrong, 0);
  });

  await test('每個知識點用自己的衰減率（三個月前的那一題，衰減快的掉得多）', async () => {
    const by = new Map((await snapshotsOf(student.id)).map((s) => [s.knowledgePointId, s]));
    const fast = by.get(kpFast.id); // decayRate 0.9，t1 是 90 天前答對的
    // 同樣一題答對、同樣 90 天前，衰減率 0.05 的算出來會高得多。
    const slow = masteryOf(
      [{ isCorrect: true, answeredAt: daysAgo(90), difficulty: 0.5, linkWeight: 1 }],
      { decayRate: 0.05 },
    );
    assert.ok(
      fast.mastery < slow.mastery / 2,
      `衰減快的知識點要掉得多：${fast.mastery} vs ${slow.mastery}`,
    );
  });

  // ── 二、重新計分 ───────────────────────────────────────────────

  section('老師改了標準答案');

  await test('改答案重新計分之後，快照跟著對', async () => {
    const before = new Map((await snapshotsOf(student.id)).map((s) => [s.knowledgePointId, s]));
    const probBefore = before.get(kpProb.id);

    // p1 的標準答案從 (1) 改成 (5)。這位學生第一份選的是 (1)，
    // 原本算對，改完之後變成錯。
    await prisma.question.update({ where: { id: f.qs.p1.id }, data: { answerKeys: [5] } });
    await regrade(f, a1.id);

    const after = new Map((await snapshotsOf(student.id)).map((s) => [s.knowledgePointId, s]));
    const probAfter = after.get(kpProb.id);
    assert.equal(probAfter.total, probBefore.total, '題數不變');
    assert.equal(probAfter.correct, probBefore.correct - 1, '少對一題');
    assert.ok(probAfter.mastery < probBefore.mastery, '掌握度要跟著往下');

    // 還原，後面的斷言才有一個乾淨的起點。
    await prisma.question.update({ where: { id: f.qs.p1.id }, data: { answerKeys: [1] } });
    await regrade(f, a1.id);
    const back = new Map((await snapshotsOf(student.id)).map((s) => [s.knowledgePointId, s]));
    assert.equal(back.get(kpProb.id).correct, probBefore.correct, '改回去就回來了');
  });

  await test('送分（整題改成全對）也會反映到掌握度', async () => {
    const before = new Map((await snapshotsOf(student.id)).map((s) => [s.knowledgePointId, s]));
    // p2 這位學生兩次都作答過（第一份選 5 錯、第三份選 2 對）。
    // 把標準答案改成他兩次選的都算對是做不到的，所以這裡驗的是
    // 「答案改成 (5) 之後，第一份那一題從錯變對」。
    await prisma.question.update({ where: { id: f.qs.p2.id }, data: { answerKeys: [5] } });
    await regrade(f, a1.id);
    await regrade(f, a3.id);
    const after = new Map((await snapshotsOf(student.id)).map((s) => [s.knowledgePointId, s]));
    assert.equal(
      after.get(kpProb.id).total,
      before.get(kpProb.id).total,
      '送分不會改變題數',
    );
    assert.notEqual(after.get(kpProb.id).mastery, before.get(kpProb.id).mastery);

    await prisma.question.update({ where: { id: f.qs.p2.id }, data: { answerKeys: [2] } });
    await regrade(f, a1.id);
    await regrade(f, a3.id);
  });

  // ── 三、作廢 ───────────────────────────────────────────────────

  section('作廢的作答不算進去');

  let beforeVoid;
  await test('作廢一份之後，那一份的每一題退出掌握度', async () => {
    beforeVoid = await snapshotsOf(student.id);
    const by = new Map(beforeVoid.map((s) => [s.knowledgePointId, s]));
    assert.equal(by.get(kpProb.id).total, 7, '作廢前是七題');

    // voidAttempt 做的事：狀態改 VOIDED，然後重算這位學生的全部快照。
    await prisma.attempt.update({ where: { id: a1.id }, data: { status: 'VOIDED' } });
    await refreshAbility(prisma, {
      tenantId: f.tenant.id,
      userId: student.id,
      knowledgePointIds: null,
    });

    const after = new Map((await snapshotsOf(student.id)).map((s) => [s.knowledgePointId, s]));
    // 第一份裡機率有 p1 p2 p3 三題
    assert.equal(after.get(kpProb.id).total, 4, '作廢那一份的三題要退出去');
    assert.equal(after.get(kpProb.id).reliable, false, '退出去之後樣本不夠了');
  });

  await test('作廢那一份是唯一證據的知識點，快照整列消失而不是留一個 0', async () => {
    // 三角函數只有第一份的 t1，而第一份剛剛作廢了。
    const by = new Map((await snapshotsOf(student.id)).map((s) => [s.knowledgePointId, s]));
    assert.equal(
      by.has(kpFast.id),
      false,
      '沒有證據就不該有列——留一個 mastery 0 會被讀成「完全不會」',
    );
  });

  await test('撤銷作廢之後，快照回到與作廢前一模一樣', async () => {
    await prisma.attempt.update({ where: { id: a1.id }, data: { status: 'SUBMITTED' } });
    await refreshAbility(prisma, {
      tenantId: f.tenant.id,
      userId: student.id,
      knowledgePointIds: null,
    });
    assertSameSnapshots(await snapshotsOf(student.id), beforeVoid, '撤銷作廢');
  });

  await test('還在作答中的那一份不算證據', async () => {
    const before = await snapshotsOf(student.id);
    const open = await makeAttempt(f, student, 4, new Date(), { p1: [1], p2: [2] });
    await prisma.attempt.update({ where: { id: open.id }, data: { status: 'IN_PROGRESS' } });
    // 考試中的作答連對錯都還沒判，混進去等於在他交卷前就先給了掌握度。
    await prisma.attemptAnswer.updateMany({
      where: { attemptId: open.id },
      data: { isCorrect: true },
    });
    await refreshAbility(prisma, {
      tenantId: f.tenant.id,
      userId: student.id,
      knowledgePointIds: null,
    });
    assertSameSnapshots(await snapshotsOf(student.id), before, '進行中的作答');
    await prisma.attemptAnswer.deleteMany({ where: { attemptId: open.id } });
    await prisma.attempt.deleteMany({ where: { id: open.id } });
  });

  // ── 四、標註被拿掉 ─────────────────────────────────────────────

  section('知識點標註被改掉');

  await test('標註拿掉之後，那一筆快照會消失', async () => {
    const link = await prisma.questionKnowledgePoint.findFirst({
      where: { questionId: f.qs.t1.id, knowledgePointId: kpFast.id },
    });
    assert.ok(link, '先確定那一條標註在');
    await prisma.questionKnowledgePoint.deleteMany({
      where: { questionId: f.qs.t1.id, knowledgePointId: kpFast.id },
    });
    await refreshAbility(prisma, {
      tenantId: f.tenant.id,
      userId: student.id,
      knowledgePointIds: null,
    });
    const by = new Map((await snapshotsOf(student.id)).map((s) => [s.knowledgePointId, s]));
    assert.equal(by.has(kpFast.id), false);

    // 加回去，最後的整批比對才是完整的資料。
    await prisma.questionKnowledgePoint.create({
      data: { questionId: f.qs.t1.id, knowledgePointId: kpFast.id, weight: 1 },
    });
    await refreshAbility(prisma, {
      tenantId: f.tenant.id,
      userId: student.id,
      knowledgePointIds: null,
    });
    const back = new Map((await snapshotsOf(student.id)).map((s) => [s.knowledgePointId, s]));
    assert.equal(back.get(kpFast.id).total, 1);
  });

  // ── 五、租戶隔離 ───────────────────────────────────────────────

  section('隔壁補習班');

  await test('隔壁的作答不會混進這家的掌握度', async () => {
    // 隔壁那位學生也考一份、也計分。
    await withTenant(other.tenant.id, async () => {
      const b1 = await makeAttempt(other, other.student, 1, daysAgo(2), {
        p1: [1], p2: [2], p3: [3], p4: [4], p5: [5],
      });
      await regrade(other, b1.id);
    });

    const mineSnaps = await snapshotsOf(student.id);
    const kpIds = new Set(mineSnaps.map((s) => s.knowledgePointId));
    assert.equal(kpIds.has(other.kpProb.id), false, '隔壁的知識點不該出現在這家的快照裡');

    // 反過來也要成立：在這家的脈絡下查不到隔壁的快照。
    const leaked = await prisma.abilitySnapshot.findMany({ where: { userId: other.student.id } });
    assert.equal(leaked.length, 0, 'RLS 應該讓這家看不到隔壁那位學生的快照');
  });

  await test('隔壁的快照確實有算出來（不是因為根本沒寫進去才看不到）', async () => {
    // 這一條是上一條的對照組。少了它，一個「什麼都沒寫入」的 bug
    // 會讓上面那個斷言通過，而隔離其實根本沒被驗到。
    await withTenant(other.tenant.id, async () => {
      const rows = await prisma.abilitySnapshot.findMany({ where: { userId: other.student.id } });
      assert.ok(rows.length > 0, '隔壁那位學生應該有自己的快照');
    });
  });

  // ── 六、整批重算與逐次更新一致 ─────────────────────────────────

  section('整批重算與逐次更新算出同一個答案');

  await test('在既有快照上重跑整批，結果不變（冪等）', async () => {
    const incremental = await snapshotsOf(student.id);
    await rebuildAbility(prisma, { tenantId: f.tenant.id, userIds: [student.id] });
    assertSameSnapshots(await snapshotsOf(student.id), incremental, '整批重算（覆蓋）');
  });

  await test('把快照全部刪光再重建，結果與逐次更新一模一樣', async () => {
    // **這是這一支最重要的斷言。** 兩條路徑算出不同答案的話，
    // 沒有人知道哪一個是對的——而那正是「上線第一天重建了一次，
    // 全班的掌握度都變了」的情況。
    const incremental = await snapshotsOf(student.id);
    assert.ok(incremental.length >= 3, '先確定有東西可以比');

    const all = await prisma.abilitySnapshot.findMany({ where: { userId: student.id } });
    await prisma.abilitySnapshot.deleteMany({ where: { id: { in: all.map((r) => r.id) } } });
    assert.equal((await snapshotsOf(student.id)).length, 0, '確定真的清空了');

    const result = await rebuildAbility(prisma, { tenantId: f.tenant.id, userIds: [student.id] });
    assert.equal(result.failures.length, 0, `重建不該有失敗：${JSON.stringify(result.failures)}`);
    assertSameSnapshots(await snapshotsOf(student.id), incremental, '整批重建（從零）');
  });

  await test('整批重建對一位從來沒考過的學生是安全的', async () => {
    const r = await rebuildAbility(prisma, { tenantId: f.tenant.id, userIds: [f.classmate.id] });
    assert.equal(r.failures.length, 0);
    assert.equal(r.points, 0, '沒有作答就不該生出任何一列');
    assert.equal((await snapshotsOf(f.classmate.id)).length, 0);
  });

  await test('整批重算挑學生的方式：只挑學生、只挑在籍的', async () => {
    // 這一段對應 `lib/abilityDb.ts` 的 `rebuildAbilityFor` 與
    // `apps/web/scripts/rebuild-ability.mjs` 挑名單的那兩句。挑錯的症狀
    // 是「重建了一次，老師自己試考的那幾份也進了能力分析」，
    // 而那份掌握度會是滿分——看起來完全正常。
    const wholeTenant = await prisma.user.findMany({
      where: { systemRole: 'STUDENT', deletedAt: null },
      select: { id: true },
    });
    const ids = new Set(wholeTenant.map((u) => u.id));
    assert.equal(ids.has(student.id), true);
    assert.equal(ids.has(f.classmate.id), true);
    assert.equal(ids.has(f.teacher.id), false, '老師不進能力分析');
    assert.equal(ids.has(other.student.id), false, 'RLS：隔壁的學生不在名單裡');

    const inClass = await prisma.classMembership.findMany({
      where: { classId: f.klass.id, role: 'STUDENT', leftAt: null },
      select: { userId: true },
    });
    assert.equal(inClass.length, 2);
  });

  await test('限定範圍的重算不會動到範圍外的知識點', async () => {
    const before = await snapshotsOf(student.id);
    // 只重算三角函數。機率與排列組合那兩列必須原封不動——
    // 一份數學卷子不該把這位學生的物理快照刪掉，這是同一件事。
    await refreshAbility(prisma, {
      tenantId: f.tenant.id,
      userId: student.id,
      knowledgePointIds: [kpFast.id],
    });
    assertSameSnapshots(await snapshotsOf(student.id), before, '限定範圍');
  });

  await test('快照裡的數字與純函式對同一批列算出來的一致', async () => {
    // 把資料庫裡的原始列讀出來，用 computeSnapshots 算一次，
    // 與存進去的比對。中間任何一段（查詢漏了條件、欄位對錯、
    // 時間戳被轉成字串）出錯，這裡就會不一樣。
    const attempts = await prisma.attempt.findMany({
      where: { userId: student.id, status: { in: ['SUBMITTED', 'GRADED'] } },
      select: { id: true },
    });
    const answers = await prisma.attemptAnswer.findMany({
      where: { attemptId: { in: attempts.map((a) => a.id) } },
      select: { questionId: true, isCorrect: true, answeredAt: true },
    });
    const questionIds = [...new Set(answers.map((a) => a.questionId))];
    const links = await prisma.questionKnowledgePoint.findMany({
      where: { questionId: { in: questionIds } },
    });
    const questions = await prisma.question.findMany({
      where: { id: { in: questionIds } },
      select: { id: true, difficulty: true },
    });
    const points = await prisma.knowledgePoint.findMany({
      where: { id: { in: [...new Set(links.map((l) => l.knowledgePointId))] } },
      select: { id: true, decayRate: true },
    });

    const expected = computeSnapshots({ answers, links, questions, points });
    const stored = await snapshotsOf(student.id);
    assert.equal(stored.length, expected.length);
    for (const e of expected) {
      const s = stored.find((x) => x.knowledgePointId === e.knowledgePointId);
      assert.ok(s, `${e.knowledgePointId} 應該有快照`);
      assert.equal(s.correct, e.correct);
      assert.equal(s.total, e.total);
      assert.equal(s.reliable, e.reliable);
      assert.equal(s.streakWrong, e.streakWrong);
      assert.ok(Math.abs(s.mastery - e.mastery) <= 1e-4);
    }
  });
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
