/**
 * 考卷 → 派卷 → 作答 → 計分這條線的端到端驗證
 * （由 tools/e2e-import.sh 起好相依之後接著跑，沿用同一個資料庫）。
 *
 * 這條線的純邏輯（lib/grading.mjs、lib/gsat.mjs）已經有 68 個單元測試，
 * 這一支**不重複測它們**。它驗的是跨越資料庫邊界之後還對不對：
 *
 *   · 遷移裡那 7 條 CHECK 真的擋得住，而不是寫在那裡好看的
 *   · 6 條 RLS 政策真的隔得開兩家補習班——特別是 4 張沒有 tenantId、
 *     靠外鍵遞迴掛上去的表。這一組寫錯的症狀是「隔壁補習班看得到
 *     你的考題」，而且完全沒有錯誤訊息
 *   · 版面快照存進 jsonb 再讀回來還是同一份，連型別都不能變
 *   · 交卷的 compare-and-set 在真的併發下只讓一個請求贏
 *   · onDelete：該連帶刪的刪掉、該擋的擋住（尤其是學生的作答記錄
 *     不會因為老師刪了一題而消失）
 *   · 真的從資料庫讀出來的作答餵進 gradeAttempt，算出來的分數是對的
 */
import assert from 'node:assert/strict';
import { createPgShim } from './pg-shim.mjs';
import {
  exitTenantScope,
  withTenant,
  withoutTenantScope,
} from '../apps/web/lib/tenantContext.mjs';
import { gradeAttempt } from '../apps/web/lib/grading.mjs';
import {
  attemptWritable,
  checkEndNow,
  checkExtend,
} from '../apps/web/lib/attemptClock.mjs';

// 用 pg-shim 而非 PrismaClient。理由見 tools/pg-shim.mjs 的檔頭：
// Prisma 的查詢引擎要從外部網域下載，而這套系統要部署的補習班機房
// 是封閉網段。shim 從同一份 schema 取得欄位對應，所以欄位名寫錯
// 一樣會被抓到。
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
    console.error(`     ${e.message.split('\n').slice(0, 4).join('\n     ')}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
}

/** bcrypt 格式的假雜湊。長度合法但對不上任何密碼。 */
const HASH = '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar';

// ── 基礎資料 ─────────────────────────────────────────────────

/**
 * 建一題選擇題，連選項一起。
 *
 * 選項一定要真的建出來：多選題的部分給分公式 `(n − 2k)/n` 裡的 n 是
 * **選項總數**，而計分時那個 n 是去數 question_options 得到的。
 * 選項沒入庫的題目算出來的分數會是錯的，而畫面上完全看不出來。
 */
async function makeQuestion(tenant, subject, spec) {
  const q = await prisma.question.create({
    data: {
      tenantId: tenant.id,
      subjectId: subject.id,
      familyId: spec.familyId,
      version: 1,
      type: spec.type,
      content: spec.content,
      score: spec.score,
      answerKeys: spec.answerKeys,
      scoringRule: spec.scoringRule ?? null,
      sourceType: 'TEACHER_ORIGINAL',
      licenseScope: 'TENANT_EXPORTABLE',
      status: 'PUBLISHED',
    },
  });
  for (let i = 1; i <= spec.optionCount; i++) {
    await prisma.questionOption.create({
      data: {
        questionId: q.id,
        order: i,
        label: `(${i})`,
        content: `${spec.familyId} 的第 ${i} 個選項`,
      },
    });
  }
  return q;
}

/**
 * 照 lib/attempt.ts 的 `LayoutItem` 造一份版面快照。
 *
 * 形狀是 `[{ questionId, order, score, optionOrder }]`，與 schema.prisma
 * 在 `Attempt.layout` 上寫的合約一致。這裡刻意手寫而不去 import
 * `buildLayout`——那支是 TypeScript，import 進來要多一層編譯，而多一層
 * 編譯就是多一個「測試環境與正式環境不同」的來源。
 *
 * `optionOrder` 裡放的是**題庫的 QuestionOption.order**（不是顯示位置），
 * 所以 `answerKeys` 存的原始編號可以直接跟標準答案比對，中間不必轉換。
 */
function layoutOf(items) {
  return items.map((it, i) => ({
    questionId: it.questionId,
    order: i + 1,
    score: it.score,
    optionOrder: it.optionOrder,
  }));
}

/**
 * 一家補習班的完整動線：老師、學生、班級、四題、一份卷、一個任務、
 * 一份已經交出去的作答。
 *
 * 兩家補習班用同一個函式建，是為了讓「A 看不到 B」那一組斷言有意義：
 * 兩邊的資料形狀一模一樣，只有 tenantId 不同，所以任何一列跨界出現在
 * 對方的查詢結果裡，都只可能是隔離漏了，不會是別的原因。
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
  await prisma.classMembership.create({
    data: { classId: klass.id, userId: student.id, role: 'STUDENT' },
  });

  // 四題涵蓋計分要驗到的四種情況：答對的單選、部分給分的多選、
  // 一題沒作答的、以及設成全對才給分的多選。
  const qSingle = await makeQuestion(tenant, subject, {
    familyId: `${spec.prefix}-fam-single`,
    type: 'SINGLE_CHOICE',
    content: `${spec.tag}：單選題，標準答案是 (3)`,
    score: 5,
    answerKeys: [3],
    optionCount: 5,
  });
  const qMulti = await makeQuestion(tenant, subject, {
    familyId: `${spec.prefix}-fam-multi`,
    type: 'MULTI_CHOICE',
    content: `${spec.tag}：多選題，標準答案是 (1)(3)`,
    score: 4,
    answerKeys: [1, 3],
    optionCount: 5,
  });
  const qBlank = await makeQuestion(tenant, subject, {
    familyId: `${spec.prefix}-fam-blank`,
    type: 'SINGLE_CHOICE',
    content: `${spec.tag}：單選題，這一題學生沒作答`,
    score: 5,
    answerKeys: [2],
    optionCount: 5,
  });
  const qStrict = await makeQuestion(tenant, subject, {
    familyId: `${spec.prefix}-fam-strict`,
    type: 'MULTI_CHOICE',
    content: `${spec.tag}：多選題，這一題設定為全對才給分`,
    score: 6,
    answerKeys: [2, 4],
    scoringRule: { mode: 'ALL_OR_NOTHING' },
    optionCount: 5,
  });

  const paper = await prisma.examPaper.create({
    data: {
      tenantId: tenant.id,
      subjectId: subject.id,
      title: `${spec.tag}·第一次段考 數學A`,
      status: 'READY',
      totalScore: 20,
      instructions: '本卷共 4 題，作答時間 50 分鐘。',
      createdBy: teacher.id,
    },
  });
  const specs = [
    { question: qSingle, order: 1, score: 5, optionOrder: [1, 2, 3, 4, 5] },
    // 選項順序打散過的一題。快照存的是題庫的原始編號，所以打散不影響
    // 計分——這正是要驗的：快照原封不動地存得下來、讀得回來。
    { question: qMulti, order: 2, score: 4, optionOrder: [3, 1, 5, 2, 4] },
    { question: qBlank, order: 3, score: 5, optionOrder: [1, 2, 3, 4, 5] },
    { question: qStrict, order: 4, score: 6, optionOrder: [1, 2, 3, 4, 5] },
  ];
  const items = [];
  for (const s of specs) {
    items.push(
      await prisma.examPaperItem.create({
        data: {
          paperId: paper.id,
          questionId: s.question.id,
          order: s.order,
          score: s.score,
        },
      }),
    );
  }

  const now = Date.now();
  const assignment = await prisma.assignment.create({
    data: {
      tenantId: tenant.id,
      paperId: paper.id,
      title: `${spec.tag}·第一次段考`,
      mode: 'EXAM',
      openAt: new Date(now - 60 * 60 * 1000),
      dueAt: new Date(now + 60 * 60 * 1000),
      timeLimitMin: 50,
      maxAttempts: 2,
      shuffleOptions: true,
      releasePolicy: 'ON_DUE',
      createdBy: teacher.id,
    },
  });
  // 兩種派送對象都建：整班一筆、個人一筆（補考的那一位）。
  const targets = [
    await prisma.assignmentTarget.create({
      data: { assignmentId: assignment.id, classId: klass.id },
    }),
    await prisma.assignmentTarget.create({
      data: { assignmentId: assignment.id, userId: classmate.id },
    }),
  ];

  const startedAt = new Date(now - 40 * 60 * 1000);
  const attempt = await prisma.attempt.create({
    data: {
      assignmentId: assignment.id,
      userId: student.id,
      attemptNo: 1,
      status: 'SUBMITTED',
      startedAt,
      expiresAt: new Date(startedAt.getTime() + 50 * 60 * 1000),
      submittedAt: new Date(now - 10 * 60 * 1000),
      layout: layoutOf(
        specs.map((s) => ({
          questionId: s.question.id,
          score: s.score,
          optionOrder: s.optionOrder,
        })),
      ),
    },
  });

  // qBlank 刻意沒有作答列。「沒有列」與「有列但空著」在計分上要
  // 得到同一個答案（0 分、未作答），而只有前者測得到真實情況：
  // 學生跳過的題目根本不會送出任何東西。
  const answers = [
    await prisma.attemptAnswer.create({
      data: { attemptId: attempt.id, questionId: qSingle.id, answerKeys: [3] },
    }),
    await prisma.attemptAnswer.create({
      data: { attemptId: attempt.id, questionId: qMulti.id, answerKeys: [1, 3, 4] },
    }),
    await prisma.attemptAnswer.create({
      data: { attemptId: attempt.id, questionId: qStrict.id, answerKeys: [2] },
    }),
  ];

  return {
    tenant,
    teacher,
    student,
    classmate,
    subject,
    klass,
    questions: { qSingle, qMulti, qBlank, qStrict },
    paper,
    items,
    assignment,
    targets,
    attempt,
    answers,
  };
}

/** 六張新表在一份完整動線裡各自有哪些列。RLS 的斷言逐張比對這個。 */
function rowsOf(f) {
  return {
    examPaper: [f.paper.id],
    examPaperItem: f.items.map((i) => i.id),
    assignment: [f.assignment.id],
    assignmentTarget: f.targets.map((t) => t.id),
    attempt: [f.attempt.id],
    attemptAnswer: f.answers.map((a) => a.id),
  };
}

/** 六張表的中文名，錯誤訊息要說得出是哪一張漏了。 */
const TABLE_LABEL = {
  examPaper: 'exam_papers（考卷）',
  examPaperItem: 'exam_paper_items（卷上的題目，間接掛在考卷下）',
  assignment: 'assignments（任務）',
  assignmentTarget: 'assignment_targets（派給誰，間接）',
  attempt: 'attempts（作答場次，間接）',
  attemptAnswer: 'attempt_answers（每一題的作答，隔兩層間接）',
};

async function main() {
  // 建置是跨租戶的：要清庫、要建出租戶本身。這是全檔唯一一處，
  // 之後每一項測試都在租戶脈絡下跑——那才是正式環境的樣子，
  // 也才驗得到 RLS。
  const fixture = await withoutTenantScope('考卷動線測試建置：清庫並建出兩家補習班', async () => {
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

async function mainScoped({ mine, other }) {
  const { tenant, teacher, student, classmate, subject, paper, assignment } = mine;

  /** 專門拿來撞約束的空白卷子。撞壞了也不影響上面那份真的卷。 */
  const probePaper = await prisma.examPaper.create({
    data: {
      tenantId: tenant.id,
      subjectId: subject.id,
      title: '約束測試用的空白卷',
      status: 'DRAFT',
      createdBy: teacher.id,
    },
  });

  /** 每個要動 attempts 的測試各拿一個自己的任務，彼此不會撞唯一鍵。 */
  let probeSeq = 0;
  const newAssignment = async (title, extra = {}) =>
    prisma.assignment.create({
      data: {
        tenantId: tenant.id,
        paperId: probePaper.id,
        title: `${title}（探針 ${++probeSeq}）`,
        createdBy: teacher.id,
        ...extra,
      },
    });

  // ── 資料庫約束 ─────────────────────────────────────────────
  //
  // 七條 CHECK 各驗一條。每一條都要看到「違規的被拒絕」與
  // 「合法的進得去」兩半：只驗前半的話，一個把整張表寫壞的錯誤
  // （例如欄位名打錯）也會讓測試通過，因為它一樣會拋例外。

  section('資料庫約束');

  await test('配分不得為負（exam_paper_items_score_nonneg）', async () => {
    // 0 分是合法的：題目送分或作廢時配分就是 0。負分不合法——
    // 送分要用加分處理，一題給負分會把別題的分數扣掉。
    const zero = await prisma.examPaperItem.create({
      data: {
        paperId: probePaper.id,
        questionId: mine.questions.qSingle.id,
        order: 1,
        score: 0,
      },
    });
    assert.equal(zero.score, 0);
    await assert.rejects(
      prisma.examPaperItem.create({
        data: {
          paperId: probePaper.id,
          questionId: mine.questions.qMulti.id,
          order: 2,
          score: -1,
        },
      }),
      /exam_paper_items_score_nonneg/,
    );
    await prisma.examPaperItem.deleteMany({ where: { id: zero.id } });
  });

  await test('截止不得早於開放（assignments_window_ordered）', async () => {
    const now = Date.now();
    // 老師把日期打反是真的會發生的事，而畫面上看起來完全正常：
    // 一份沒有人交得出來的考卷，直到有學生來問才會發現。
    await assert.rejects(
      newAssignment('日期打反的段考', {
        openAt: new Date(now + 60 * 60 * 1000),
        dueAt: new Date(now),
      }),
      /assignments_window_ordered/,
    );
    // 兩邊都不填是合法的（隨時可作答的練習）。
    const open = await newAssignment('不限時間的練習');
    assert.equal(open.openAt, null);
    await prisma.assignment.deleteMany({ where: { id: open.id } });
  });

  await test('作答時限必須為正（assignments_time_limit_positive）', async () => {
    // 0 分鐘的考試一開始就結束，學生看到的是一個立刻自動交卷的空白卷。
    await assert.rejects(
      newAssignment('零分鐘的考試', { timeLimitMin: 0 }),
      /assignments_time_limit_positive/,
    );
    await assert.rejects(
      newAssignment('負分鐘的考試', { timeLimitMin: -30 }),
      /assignments_time_limit_positive/,
    );
    const free = await newAssignment('不限時的任務', { timeLimitMin: null });
    assert.equal(free.timeLimitMin, null, 'null 代表不限時，必須是合法的');
    await prisma.assignment.deleteMany({ where: { id: free.id } });
  });

  await test('作答次數至少一次（assignments_attempts_positive）', async () => {
    // 0 次的任務會出現在學生的清單上但按不下去，而錯誤訊息會說
    // 「已達作答次數上限」——他一次都還沒考。
    await assert.rejects(
      newAssignment('不能作答的任務', { maxAttempts: 0 }),
      /assignments_attempts_positive/,
    );
    await assert.rejects(
      newAssignment('負次數的任務', { maxAttempts: -1 }),
      /assignments_attempts_positive/,
    );
  });

  await test('派送對象至少要有班或人（assignment_targets_one_side）', async () => {
    const a = await newAssignment('派送對象測試');
    // 兩邊都空的那一列不代表任何人，但它會被算進「這份任務派給誰」，
    // 於是應交人數多一個永遠不會交卷的幽靈。
    await assert.rejects(
      prisma.assignmentTarget.create({ data: { assignmentId: a.id } }),
      /assignment_targets_one_side/,
    );
    const real = await prisma.assignmentTarget.create({
      data: { assignmentId: a.id, userId: student.id },
    });
    assert.equal(real.userId, student.id);
    await prisma.assignment.deleteMany({ where: { id: a.id } });
  });

  await test('交了卷就一定有交卷時間（attempts_submitted_has_time）', async () => {
    const a = await newAssignment('交卷時間測試');
    // 少了這一條，「已交卷但 submittedAt 是 null」會讓成績統計把它
    // 算成未交——學生明明交了，催繳名單上還有他。
    for (const status of ['SUBMITTED', 'GRADED']) {
      await assert.rejects(
        prisma.attempt.create({
          data: { assignmentId: a.id, userId: student.id, status },
        }),
        /attempts_submitted_has_time/,
        `${status} 沒有交卷時間卻寫得進去`,
      );
    }
    // 作答中與作廢的沒有交卷時間才是正常的。
    const live = await prisma.attempt.create({
      data: { assignmentId: a.id, userId: student.id, status: 'IN_PROGRESS' },
    });
    assert.equal(live.submittedAt, null);
    await prisma.assignment.deleteMany({ where: { id: a.id } });
  });

  await test('交卷不得早於開始（attempts_time_ordered）', async () => {
    const a = await newAssignment('時間順序測試');
    const startedAt = new Date();
    await assert.rejects(
      prisma.attempt.create({
        data: {
          assignmentId: a.id,
          userId: student.id,
          status: 'SUBMITTED',
          startedAt,
          submittedAt: new Date(startedAt.getTime() - 1000),
        },
      }),
      /attempts_time_ordered/,
    );
    // 同一毫秒交卷是合法的（自動交卷剛好落在同一刻）。
    const instant = await prisma.attempt.create({
      data: {
        assignmentId: a.id,
        userId: classmate.id,
        status: 'SUBMITTED',
        startedAt,
        submittedAt: startedAt,
        autoSubmitted: true,
      },
    });
    assert.equal(instant.status, 'SUBMITTED');
    await prisma.assignment.deleteMany({ where: { id: a.id } });
  });

  // ── 租戶隔離 ───────────────────────────────────────────────
  //
  // 六張表逐一驗。其中四張沒有 tenantId，靠外鍵遞迴掛到 tenants
  // （exam_paper_items → exam_papers、assignment_targets/attempts →
  // assignments、attempt_answers → attempts → assignments），那四張
  // 最容易被漏掉，因為它們看起來與租戶無關。
  //
  // 漏掉的症狀是隔壁補習班看得到你的考題與全班的成績，而且**沒有
  // 任何錯誤訊息**——它只是安靜地多回傳幾列。

  section('租戶隔離');

  await test('六張表都看得到自己的、看不到隔壁的', async () => {
    const ours = rowsOf(mine);
    const theirs = rowsOf(other);
    for (const key of Object.keys(TABLE_LABEL)) {
      const seen = await prisma[key].findMany({});
      const ids = new Set(seen.map((r) => r.id));
      for (const id of ours[key]) {
        assert.ok(ids.has(id), `${TABLE_LABEL[key]}：連自己的都看不到，那不是隔離是壞掉`);
      }
      for (const id of theirs[key]) {
        assert.ok(
          !ids.has(id),
          `${TABLE_LABEL[key]}：看到了隔壁補習班的資料。這就是漏掉 where 條件時會發生的事`,
        );
      }
    }
  });

  await test('知道 id 也查不到隔壁的（隔離不能只擋列表）', async () => {
    const theirs = rowsOf(other);
    for (const key of Object.keys(TABLE_LABEL)) {
      for (const id of theirs[key]) {
        const row = await prisma[key].findFirst({ where: { id } });
        assert.equal(row, null, `${TABLE_LABEL[key]}：知道 id 就查得到，等於沒有隔離`);
      }
    }
  });

  await test('拿隔壁的卷子 id 也插不進題目（WITH CHECK）', async () => {
    // 只有 USING 沒有 WITH CHECK 的政策會讓資料寫得進去卻讀不到，
    // 那是最難查的一種資料損壞：新增成功、列表沒有、再新增一次
    // 撞唯一鍵說已經存在。
    await assert.rejects(
      prisma.examPaperItem.create({
        data: {
          paperId: other.paper.id,
          questionId: mine.questions.qSingle.id,
          order: 99,
          score: 5,
        },
      }),
      /row-level security|policy/i,
    );
    await assert.rejects(
      prisma.attempt.create({
        data: { assignmentId: other.assignment.id, userId: student.id },
      }),
      /row-level security|policy/i,
    );
    await assert.rejects(
      prisma.attemptAnswer.create({
        data: {
          attemptId: other.attempt.id,
          questionId: mine.questions.qSingle.id,
          answerKeys: [1],
        },
      }),
      /row-level security|policy/i,
    );
  });

  await test('改不動也刪不掉隔壁的作答', async () => {
    // 改得動別家的資料比讀得到更嚴重：竄改成績不會留下任何痕跡。
    const upd = await prisma.attempt.updateMany({
      where: { id: other.attempt.id },
      data: { totalScore: 0, status: 'VOIDED' },
    });
    assert.equal(upd.count, 0, '把隔壁補習班的作答作廢掉了');
    const del = await prisma.attemptAnswer.deleteMany({
      where: { id: { in: rowsOf(other).attemptAnswer } },
    });
    assert.equal(del.count, 0, '刪掉了隔壁補習班學生的作答記錄');

    const still = await withoutTenantScope('驗證用：回頭確認隔壁的資料沒被動到', async () => {
      const a = await prisma.attempt.findFirst({ where: { id: other.attempt.id } });
      const n = await prisma.attemptAnswer.count({ where: { attemptId: other.attempt.id } });
      return { a, n };
    });
    assert.equal(still.a.status, 'SUBMITTED');
    assert.equal(still.a.totalScore, null);
    assert.equal(still.n, other.answers.length);
  });

  await test('沒有租戶脈絡時六張表都是空的（fail closed）', async () => {
    // 忘記包 withTenant 是最常見的錯。它必須是「查不到東西」，
    // 而不是「查到全部」——後者是安靜的資料外洩。
    await exitTenantScope(async () => {
      for (const key of Object.keys(TABLE_LABEL)) {
        const n = await prisma[key].count({});
        assert.equal(n, 0, `${TABLE_LABEL[key]}：沒設租戶卻查得到 ${n} 列，fail open`);
      }
    });
  });

  // ── 版面快照 ───────────────────────────────────────────────

  section('版面快照');

  await test('layout 存進 jsonb 再讀回來，欄位與型別都不變', async () => {
    const back = await prisma.attempt.findFirst({ where: { id: mine.attempt.id } });
    const want = layoutOf([
      { questionId: mine.questions.qSingle.id, score: 5, optionOrder: [1, 2, 3, 4, 5] },
      { questionId: mine.questions.qMulti.id, score: 4, optionOrder: [3, 1, 5, 2, 4] },
      { questionId: mine.questions.qBlank.id, score: 5, optionOrder: [1, 2, 3, 4, 5] },
      { questionId: mine.questions.qStrict.id, score: 6, optionOrder: [1, 2, 3, 4, 5] },
    ]);
    assert.deepEqual(back.layout, want, '快照不是原封不動地存回來');

    // 型別要逐一驗，不能只靠 deepEqual：lib/attempt.ts 的 readLayout
    // 會把不是 number 的 optionOrder 元素**過濾掉**，所以整數在 jsonb
    // 裡變成字串的話，學生會少看到幾個選項而畫面完全正常。
    for (const row of back.layout) {
      assert.equal(typeof row.questionId, 'string');
      assert.ok(Number.isInteger(row.order), 'order 不是整數');
      assert.equal(typeof row.score, 'number', 'score 的型別變了');
      assert.ok(Array.isArray(row.optionOrder), 'optionOrder 不是陣列');
      for (const o of row.optionOrder) {
        assert.ok(Number.isInteger(o), `optionOrder 裡出現了非整數：${JSON.stringify(o)}`);
      }
    }

    // 直接問資料庫它到底存成什麼。物件被 JSON.stringify 兩次的話，
    // jsonb 裡是一個**字串**而不是陣列，readLayout 會說「版面資料
    // 不見了」，而那時人已經在考試中。
    const [shape] = await prisma.$queryRawUnsafe(
      `SELECT jsonb_typeof(layout) AS kind,
              jsonb_array_length(layout) AS len,
              jsonb_typeof(layout -> 0 -> 'optionOrder') AS opt_kind,
              (layout -> 1 -> 'optionOrder' ->> 0)::int AS first_opt
         FROM attempts WHERE id = $1`,
      mine.attempt.id,
    );
    assert.equal(shape.kind, 'array', 'layout 在 jsonb 裡不是陣列');
    assert.equal(shape.len, 4);
    assert.equal(shape.opt_kind, 'array');
    assert.equal(shape.first_opt, 3, '打散過的選項順序沒有照原樣存下來');
  });

  // ── 交卷 ───────────────────────────────────────────────────

  section('交卷');

  await test('兩個同時交卷的請求只有一個會贏', async () => {
    const a = await newAssignment('併發交卷測試');
    // 十分鐘前開始作答。兩個交卷時間都必須晚於它，否則擋下這個測試的
    // 會是 attempts_time_ordered，而不是我們要驗的那件事。
    const attempt = await prisma.attempt.create({
      data: {
        assignmentId: a.id,
        userId: student.id,
        status: 'IN_PROGRESS',
        startedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });

    // 學生連點兩次交卷、或倒數歸零與手動交卷撞在一起時，兩個請求會
    // 同時進來。沒有 compare-and-set 的話，第二個會蓋掉第一個的交卷
    // 時間，而遲交判定與計時稽核用的就是那個時間。
    //
    // 條件寫在 UPDATE 的 WHERE 裡（status 還是 IN_PROGRESS），輸的那個
    // 在 READ COMMITTED 下重新評估條件會發現已經不成立，於是改到 0 列。
    const first = new Date(Date.now() - 5000);
    const second = new Date();
    const [ra, rb] = await Promise.all([
      prisma.attempt.updateMany({
        where: { id: attempt.id, status: 'IN_PROGRESS' },
        data: { status: 'SUBMITTED', submittedAt: first },
      }),
      prisma.attempt.updateMany({
        where: { id: attempt.id, status: 'IN_PROGRESS' },
        data: { status: 'SUBMITTED', submittedAt: second, autoSubmitted: true },
      }),
    ]);
    assert.deepEqual(
      [ra.count, rb.count].sort(),
      [0, 1],
      `兩個請求的結果是 ${ra.count} 與 ${rb.count}——同一份作答被交了兩次`,
    );

    const after = await prisma.attempt.findFirst({ where: { id: attempt.id } });
    assert.equal(after.status, 'SUBMITTED');
    const winner = ra.count === 1 ? first : second;
    assert.equal(
      after.submittedAt.getTime(),
      winner.getTime(),
      '輸的那一個還是把交卷時間蓋掉了',
    );
    await prisma.assignment.deleteMany({ where: { id: a.id } });
  });

  await test('同一個人的同一次作答不會有兩份', async () => {
    const a = await newAssignment('重複作答測試', { maxAttempts: 3 });
    await prisma.attempt.create({
      data: { assignmentId: a.id, userId: student.id, attemptNo: 1 },
    });
    // 重整頁面、按兩次開始、或前端重試都會送出第二個「開始作答」。
    // 擋不住的話學生會有兩份同時進行中的卷子，而成績要用哪一份沒有
    // 人說得準。
    await assert.rejects(
      prisma.attempt.create({
        data: { assignmentId: a.id, userId: student.id, attemptNo: 1 },
      }),
      /attempts_unique_try|duplicate key/i,
    );
    // 第二次作答（補考、練習模式重做）用不同的 attemptNo，要放行。
    const retry = await prisma.attempt.create({
      data: { assignmentId: a.id, userId: student.id, attemptNo: 2 },
    });
    assert.equal(retry.attemptNo, 2);
    await prisma.assignment.deleteMany({ where: { id: a.id } });
  });

  // ── 考試當天的時鐘 ─────────────────────────────────────────
  //
  // 延長作答時間與立刻結束，兩者都只有一種實作方式：**直接改
  // attempts.expiresAt**。改任務的 `timeLimitMin` 沒有用（凍結，而且
  // 不會回頭重算已經開始的那幾份），改 `dueAt` 也停不掉正在寫的人
  // （`attemptWritable` 只看 expiresAt）。
  //
  // 判斷本身在 lib/attemptClock.mjs，已經有單元測試。這一段驗的是
  // **跨越資料庫邊界之後還對不對**：時刻寫進 timestamp(3) 再讀回來
  // 還是同一毫秒嗎、批次更新有沒有動到不該動的那幾份、以及交卷時間
  // 的 CHECK 會不會被延長撞到。
  //
  // 這幾件事在單元測試裡看不到，而它們錯的症狀是：老師按下「全部
  // 延長 10 分鐘」，畫面說成功，而學生的倒數一秒都沒有變。

  section('考試當天的時鐘');

  await test('延長 10 分鐘：過期的重新可寫，已交卷的一動也不動', async () => {
    const a = await newAssignment('延長時間測試', { timeLimitMin: 60 });
    const now = new Date();
    const startedAt = new Date(now.getTime() - 70 * 60 * 1000);

    // 三份作答，各自代表現場的一種人：
    //   · 斷線的那一個——時間到了、還掛在進行中
    //   · 還在寫的那一個——時間還沒到
    //   · 已經交卷的那一個——**延長絕對不能動到他**
    const stranded = await prisma.attempt.create({
      data: {
        assignmentId: a.id,
        userId: student.id,
        attemptNo: 1,
        status: 'IN_PROGRESS',
        startedAt,
        expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      },
    });
    const writing = await prisma.attempt.create({
      data: {
        assignmentId: a.id,
        userId: classmate.id,
        attemptNo: 1,
        status: 'IN_PROGRESS',
        startedAt,
        expiresAt: new Date(now.getTime() + 3 * 60 * 1000),
      },
    });
    const submittedExpiry = new Date(now.getTime() - 20 * 60 * 1000);
    const handedIn = await prisma.attempt.create({
      data: {
        assignmentId: a.id,
        userId: teacher.id,
        attemptNo: 1,
        status: 'SUBMITTED',
        startedAt,
        expiresAt: submittedExpiry,
        submittedAt: new Date(now.getTime() - 25 * 60 * 1000),
        totalScore: 88,
      },
    });

    assert.equal(
      attemptWritable(await prisma.attempt.findFirst({ where: { id: stranded.id } }), now),
      false,
      '前提不成立：這一份本來就該是寫不進去的',
    );

    // ── 老師按下「全部延長 10 分鐘」──────────────────────────
    //
    // 這裡走的路徑與 lib/assignment.ts 的 `extendAttempts` 完全相同：
    // 只撈進行中的、逐份算新的到期時刻、逐份寫回。
    // **逐份**而不是一句 `expiresAt = 某個固定值`：每個人開始作答的
    // 時刻不同，拉到同一個時刻的話晚開始的人反而被縮短。
    const open = await prisma.attempt.findMany({
      where: { assignmentId: a.id, status: 'IN_PROGRESS' },
    });
    assert.equal(open.length, 2, '進行中的應該只有兩份——已交卷的不該被撈進來');

    for (const row of open) {
      const plan = checkExtend(row, 10, now);
      assert.equal(plan.ok, true, `${row.id} 應該延長得了`);
      await prisma.attempt.updateMany({
        where: { id: row.id },
        data: { expiresAt: plan.expiresAt },
      });
    }

    // ── 斷線的那一位：回到寫得進去 ─────────────────────────
    const afterStranded = await prisma.attempt.findFirst({ where: { id: stranded.id } });
    assert.equal(
      afterStranded.expiresAt.getTime(),
      new Date(now.getTime() + 5 * 60 * 1000).getTime(),
      // 差一毫秒也算錯：timestamp(3) 存得下毫秒，而 `remainingSeconds`
      // 是用它現算的。寫進去再讀出來變成別的值的話，學生的倒數會與
      // 老師以為的不一樣，而兩邊都不覺得自己壞了。
      `寫回去再讀出來變成 ${afterStranded.expiresAt.toISOString()}`,
    );
    assert.equal(
      attemptWritable(afterStranded, now),
      true,
      '延長之後還是寫不進去的話，這個功能等於沒有',
    );

    // ── 還在寫的那一位：各自往後推 10 分鐘 ─────────────────
    const afterWriting = await prisma.attempt.findFirst({ where: { id: writing.id } });
    assert.equal(
      afterWriting.expiresAt.getTime(),
      new Date(now.getTime() + 13 * 60 * 1000).getTime(),
      '兩個人被拉到同一個到期時刻了——晚開始的那一位等於被縮短',
    );

    // ── 已交卷的那一位：一個位元都不能變 ───────────────────
    //
    // **這是延長這個功能能不能被信任的前提。** 動到已交卷的那一份，
    // 症狀是一場考完的考試在老師按下延長之後分數變了，而沒有人
    // 會想到那是延長造成的。
    const afterHandedIn = await prisma.attempt.findFirst({ where: { id: handedIn.id } });
    assert.equal(afterHandedIn.status, 'SUBMITTED');
    assert.equal(afterHandedIn.expiresAt.getTime(), submittedExpiry.getTime());
    assert.equal(afterHandedIn.totalScore, 88);
    assert.equal(
      checkExtend(afterHandedIn, 10, now).ok,
      false,
      '已交卷的那一份居然延長得了',
    );

    await prisma.assignment.deleteMany({ where: { id: a.id } });
  });

  await test('立刻結束：正在寫的下一秒就收不到答案，已交卷的不受影響', async () => {
    // 把任務的截止時間改成現在**停不掉正在寫的人**——`attemptWritable`
    // 只看 `expiresAt`。這一格驗的是那條唯一有效的路徑。
    const a = await newAssignment('立刻結束測試', { timeLimitMin: 60 });
    const now = new Date();
    const startedAt = new Date(now.getTime() - 10 * 60 * 1000);

    const writing = await prisma.attempt.create({
      data: {
        assignmentId: a.id,
        userId: student.id,
        attemptNo: 1,
        status: 'IN_PROGRESS',
        startedAt,
        expiresAt: new Date(now.getTime() + 50 * 60 * 1000),
      },
    });
    // 不限時也沒有截止時間的那一種。以前它是死路：成績頁不算它卡住，
    // 代為結算又回「請把任務的截止時間改成現在」——而那正是老師剛做過的事。
    const untimed = await prisma.attempt.create({
      data: {
        assignmentId: a.id,
        userId: classmate.id,
        attemptNo: 1,
        status: 'IN_PROGRESS',
        startedAt,
        expiresAt: null,
      },
    });

    const open = await prisma.attempt.findMany({
      where: { assignmentId: a.id, status: 'IN_PROGRESS' },
    });
    const ids = open.filter((r) => checkEndNow(r, now).ok).map((r) => r.id);
    assert.equal(ids.length, 2, '不限時的那一份也該結束得掉，否則它永遠出不來');
    await prisma.attempt.updateMany({ where: { id: { in: ids } }, data: { expiresAt: now } });

    const oneSecondLater = new Date(now.getTime() + 1000);
    for (const id of [writing.id, untimed.id]) {
      const after = await prisma.attempt.findFirst({ where: { id } });
      assert.equal(after.expiresAt.getTime(), now.getTime());
      assert.equal(attemptWritable(after, now), true, '結束的那一秒還收得到答案');
      assert.equal(
        attemptWritable(after, oneSecondLater),
        false,
        '設成現在之後下一秒就該收不到答案',
      );
    }

    await prisma.assignment.deleteMany({ where: { id: a.id } });
  });

  // ── 刪除的連鎖與阻擋 ───────────────────────────────────────

  section('刪除的連鎖與阻擋');

  await test('刪掉任務，作答與作答明細一起消失（Cascade）', async () => {
    const a = await newAssignment('連帶刪除測試');
    const at = await prisma.attempt.create({
      data: { assignmentId: a.id, userId: student.id },
    });
    await prisma.attemptAnswer.create({
      data: { attemptId: at.id, questionId: mine.questions.qSingle.id, answerKeys: [1] },
    });
    await prisma.assignmentTarget.create({
      data: { assignmentId: a.id, userId: student.id },
    });

    await prisma.assignment.deleteMany({ where: { id: a.id } });
    // 留下沒有任務的作答會讓成績統計算到一個不存在的考試。
    assert.equal(await prisma.attempt.count({ where: { id: at.id } }), 0);
    assert.equal(await prisma.attemptAnswer.count({ where: { attemptId: at.id } }), 0);
    assert.equal(await prisma.assignmentTarget.count({ where: { assignmentId: a.id } }), 0);
  });

  await test('刪掉作答，作答明細一起消失（Cascade）', async () => {
    const a = await newAssignment('作答明細連帶刪除測試');
    const at = await prisma.attempt.create({
      data: { assignmentId: a.id, userId: student.id },
    });
    await prisma.attemptAnswer.create({
      data: { attemptId: at.id, questionId: mine.questions.qSingle.id, answerKeys: [2] },
    });
    await prisma.attemptAnswer.create({
      data: { attemptId: at.id, questionId: mine.questions.qMulti.id, answerKeys: [1, 3] },
    });
    assert.equal(await prisma.attemptAnswer.count({ where: { attemptId: at.id } }), 2);

    await prisma.attempt.deleteMany({ where: { id: at.id } });
    assert.equal(await prisma.attemptAnswer.count({ where: { attemptId: at.id } }), 0);
  });

  await test('學生作答過的題目刪不掉（Restrict）', async () => {
    // **這一條保護的是學生的作答記錄。** 老師整理題庫刪掉一題，
    // 如果連帶把 attempt_answers 刪了，那份成績就再也說不出當初
    // 這一題學生選了什麼——申訴時唯一能拿出來的東西沒了，
    // 而且總分還是原來那個數字，對不起來。
    const a = await newAssignment('題目刪除保護測試');
    const at = await prisma.attempt.create({
      data: { assignmentId: a.id, userId: student.id },
    });
    // 這一題刻意不放進任何卷子，否則擋下刪除的會是 exam_paper_items
    // 的外鍵，就驗不到 attempt_answers 這一條。
    const q = await makeQuestion(tenant, subject, {
      familyId: 'A-fam-restrict',
      type: 'SINGLE_CHOICE',
      content: '被作答過、之後老師想刪掉的題目',
      score: 5,
      answerKeys: [1],
      optionCount: 4,
    });
    const ans = await prisma.attemptAnswer.create({
      data: { attemptId: at.id, questionId: q.id, answerKeys: [4] },
    });

    await assert.rejects(
      prisma.question.deleteMany({ where: { id: q.id } }),
      /attempt_answers_questionId_fkey|foreign key/i,
      '題目被刪掉了，而學生的作答記錄跟著不見',
    );
    const kept = await prisma.attemptAnswer.findFirst({ where: { id: ans.id } });
    assert.deepEqual(kept.answerKeys, [4], '作答記錄被動到了');

    // 對照組：沒有人作答過的題目刪得掉。少了這半邊，一個「題目
    // 永遠刪不掉」的錯誤也會讓上面那個斷言通過。
    const unused = await makeQuestion(tenant, subject, {
      familyId: 'A-fam-unused',
      type: 'SINGLE_CHOICE',
      content: '沒有人作答過的題目',
      score: 5,
      answerKeys: [1],
      optionCount: 4,
    });
    const gone = await prisma.question.deleteMany({ where: { id: unused.id } });
    assert.equal(gone.count, 1, '沒有人作答過的題目也刪不掉，那不是保護是卡住');

    await prisma.assignment.deleteMany({ where: { id: a.id } });
    await prisma.attemptAnswer.deleteMany({ where: { id: ans.id } });
    await prisma.question.deleteMany({ where: { id: q.id } });
  });

  await test('還有任務在用的卷子刪不掉（Restrict）', async () => {
    // 卷子被刪掉，正在進行的考試就沒有題目可以顯示了。
    await assert.rejects(
      prisma.examPaper.deleteMany({ where: { id: paper.id } }),
      /assignments_paperId_fkey|foreign key/i,
    );
    const still = await prisma.examPaper.findFirst({ where: { id: paper.id } });
    assert.ok(still, '卷子不見了');
  });

  // ── 計分 ───────────────────────────────────────────────────
  //
  // 計分邏輯本身由 apps/web/tests/grading.test.mjs 驗（68 項），
  // 這裡驗的是**從資料庫讀出來的東西餵進去之後還對不對**：
  // 快照裡的配分、question_options 的數量、jsonb 存的計分規則，
  // 任何一個在邊界上變了形，算出來的分數就是錯的。

  section('計分');

  /** 照 lib/scoring.ts 的 gradeAttemptById 的做法，把計分要的東西讀齊。 */
  async function gradingInputs(attemptId) {
    const attempt = await prisma.attempt.findFirst({ where: { id: attemptId } });
    const layout = attempt.layout;
    const rows = await prisma.question.findMany({
      where: { id: { in: layout.map((l) => l.questionId) } },
    });
    const byId = new Map(rows.map((q) => [q.id, q]));

    const items = [];
    for (const l of layout) {
      const q = byId.get(l.questionId);
      items.push({
        questionId: l.questionId,
        order: l.order,
        // 配分以快照為準：同一題在小考與模考的配分不同，而老師改了
        // 卷子上的配分不能追溯影響已經考完的人。
        score: l.score,
        type: q?.type ?? '',
        correctKeys: q?.answerKeys ?? [],
        correctSlots: q?.answerSlots ?? null,
        correctText: q?.answerText ?? null,
        optionCount: await prisma.questionOption.count({ where: { questionId: l.questionId } }),
        scoringRule: q?.scoringRule ?? null,
        optionOrder: l.optionOrder,
      });
    }
    const answers = (await prisma.attemptAnswer.findMany({ where: { attemptId } })).map((a) => ({
      questionId: a.questionId,
      answerKeys: a.answerKeys,
      answerText: a.answerText,
      answerSlots: a.answerSlots,
    }));
    return { attempt, items, answers };
  }

  await test('真的從資料庫讀出來的作答，算出來的分數是對的', async () => {
    const { items, answers } = await gradingInputs(mine.attempt.id);
    assert.equal(items.length, 4, '版面上的題數不對');
    assert.equal(answers.length, 3, '第三題沒作答，本來就不該有作答列');

    const g = gradeAttempt(items, answers);
    const by = new Map(g.results.map((r) => [r.questionId, r]));

    const single = by.get(mine.questions.qSingle.id);
    assert.equal(single.earnedScore, 5, '單選答對沒有拿到滿分');
    assert.equal(single.isCorrect, true);

    // 多選 n=5、標準答案 (1)(3)、學生多選了 (4)：答錯 1 個，
    // (5−2×1)/5 = 3/5 的配分，4 × 0.6 = 2.4 分。
    const multi = by.get(mine.questions.qMulti.id);
    assert.equal(multi.earnedScore, 2.4, `部分給分算錯了：${multi.scoreNote}`);
    assert.equal(multi.isCorrect, false);

    // 沒作答的那一題連 attempt_answers 都沒有一列，計分要當成
    // 未作答 0 分，而不是需人工確認——後者會讓老師的待辦清單塞滿
    // 所有跳過的題目。
    const blank = by.get(mine.questions.qBlank.id);
    assert.equal(blank.earnedScore, 0);
    assert.equal(blank.needsReview, false, `沒作答被判成需人工確認：${blank.scoreNote}`);
    assert.match(blank.scoreNote, /未作答/);

    assert.equal(g.autoScore, 7.4, `總分算錯：${g.autoScore}`);
    assert.equal(g.maxScore, 20, '滿分應該是快照上四題的配分總和');
    assert.equal(g.correctCount, 1);
    assert.equal(g.needsReview, 0, '四題都是客觀題，不該有需人工確認的');
    assert.equal(g.pendingManual, 0);
  });

  await test('多選的全對才給分規則從 jsonb 讀出來仍然生效', async () => {
    const { items } = await gradingInputs(mine.attempt.id);
    const strict = items.find((i) => i.questionId === mine.questions.qStrict.id);
    // 規則存在 Question.scoringRule 這個 jsonb 欄位。讀回來變成
    // 字串或 null 的話，這一題會悄悄改用部分給分——學生只選對一半
    // 卻拿到 3.6 分，而老師設的是全對才給分。
    assert.deepEqual(strict.scoringRule, { mode: 'ALL_OR_NOTHING' });

    const g = gradeAttempt(items, [
      { questionId: mine.questions.qStrict.id, answerKeys: [2] },
    ]);
    const r = g.results.find((x) => x.questionId === mine.questions.qStrict.id);
    assert.equal(r.earnedScore, 0, `全對才給分的題目給了部分分數：${r.scoreNote}`);
    assert.match(r.scoreNote, /全對才給分/);
  });

  await test('計分結果寫回資料庫，讀出來還是同一個數', async () => {
    const { items, answers } = await gradingInputs(mine.attempt.id);
    const g = gradeAttempt(items, answers);

    for (const r of g.results) {
      const w = await prisma.attemptAnswer.updateMany({
        // **只動這三欄。** answerKeys 不在這裡——重新計分不改學生
        // 寫了什麼，那是申訴時唯一能拿出來的東西。
        where: { attemptId: mine.attempt.id, questionId: r.questionId },
        data: { isCorrect: r.isCorrect, earnedScore: r.earnedScore, scoreNote: r.scoreNote },
      });
      // 沒作答的那一題沒有列可以更新，那是正常的。
      assert.ok(w.count <= 1);
    }
    await prisma.attempt.updateMany({
      where: { id: mine.attempt.id },
      data: {
        autoScore: g.autoScore,
        totalScore: g.autoScore,
        status: 'GRADED',
        gradedAt: new Date(),
      },
    });

    const after = await prisma.attempt.findFirst({ where: { id: mine.attempt.id } });
    assert.equal(after.status, 'GRADED');
    // 2.4 這種分數存進 double precision 再讀回來必須一模一樣。
    // 差在小數第十五位的分數會讓「班平均」與「各題得分加總」對不起來，
    // 而那是家長真的會拿計算機驗算的東西。
    assert.equal(after.totalScore, 7.4, `寫回去再讀出來變成 ${after.totalScore}`);
    assert.equal(after.autoScore, 7.4);

    const multi = await prisma.attemptAnswer.findFirst({
      where: { attemptId: mine.attempt.id, questionId: mine.questions.qMulti.id },
    });
    assert.equal(multi.earnedScore, 2.4);
    assert.deepEqual(multi.answerKeys, [1, 3, 4], '重新計分動到了學生的作答');
    assert.match(multi.scoreNote, /答錯 1 個選項/);
    // 解析什麼時候放行由 Assignment.releasePolicy 決定，計分順手把
    // 標準答案寫進 scoreNote 等於繞過那個設定（先交卷的人可以直接
    // 把答案給還在考的同學）。
    assert.ok(!/標準答案是|正確答案/.test(multi.scoreNote), 'scoreNote 洩漏了標準答案');
  });

  // ── 收尾 ───────────────────────────────────────────────────

  console.log(`\n${passed}/${passed + failed} 通過`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\n測試本身出錯：', e);
  await prisma.$disconnect();
  process.exit(1);
});
