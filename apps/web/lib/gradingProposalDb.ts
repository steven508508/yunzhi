/**
 * 非選題 AI 閱卷的資料層：把 `lib/gradingProposal.mjs` 的閘門接到資料庫
 * 與 Python 服務上。
 *
 * # 為什麼檔名不是 gradingProposal.ts
 *
 * 因為同一個資料夾裡已經有 `gradingProposal.mjs`，而 **tsc 與 webpack 對
 * `@/lib/gradingProposal` 的解析順序相反**。症狀非常難查：`tsc --noEmit`
 * 全綠、`next build` 印一行「Attempted import error」然後照樣 exit 0，
 * 而頁面在瀏覽器上炸在「xxx is not a function」。理由與做法見
 * `lib/abilityDb.ts` 的檔頭。
 *
 * # 這一層最重要的一件事：它寫不到 earnedScore
 *
 * `AnswerGradeProposal` 的表註解寫著整批資料模型裡最硬的一條：
 *
 * > **AI 的評分是提案，不是分數。** `AttemptAnswer.earnedScore` 只有兩個
 * > 寫入者：客觀題的自動計分，與老師手動輸入。這張表沒有任何路徑
 * > 寫得到它。
 *
 * 所以這個檔案裡**沒有一行碰 `prisma.attemptAnswer`**。老師採用建議時
 * 走的是既有的 `setManualScore`（`lib/scoring.ts`）——同一支老師手動
 * 輸入分數時走的函式，同一份稽核紀錄，同一個「重新計分不會蓋掉」的
 * 記號（`scoreNote` 開頭的人工標記）。`tests/gradingWriteBarrier.test.mjs`
 * 靜態檢查這件事：這個檔案與 `app/api/proposals/**` 裡不可以出現
 * `attemptAnswer` 或 `earnedScore:` 的寫入。
 *
 * 那個測試不是形式。少了它，下一個為了「批次採用比較快」而繞過
 * `setManualScore` 的人不會有任何症狀——直到某次重新計分把三十份作文的
 * 分數清成 null。
 *
 * # 順序：先寫分數，再記決定
 *
 * `setManualScore` 會丟例外（沒有作答記錄、超過配分、作答還在進行中）。
 * 反過來寫的話，資料庫裡會有一筆 `state: ACCEPTED, finalScore: 18` 而
 * 學生的那一題還是待評分——而老師的畫面上那一列已經變成「已採用」。
 *
 * # 為什麼建議一定是三份而不是一份
 *
 * 見 `aggregateSamples` 的註解與 `apps/ai/routes_grading.py` 的檔頭：
 * 單次評分看不出它有多不確定，而不確定的那幾份正是老師必須自己看的。
 * 成本是三倍，而它買到的是「哪幾份可以直接採用」這個判斷——沒有它，
 * 老師只能每一份都自己重看，那時這個功能等於不存在。
 */
import type { Prisma } from '@prisma/client';

import { readLayout } from '@/lib/attempt';
import type { SessionUser } from '@/lib/auth';
import { isManualScore } from '@/lib/examOps.mjs';
import { prisma } from '@/lib/prisma';
import {
  accuracyReport,
  aggregateSamples,
  checkDecision,
  checkGradeProposal,
  composeDecisionNote,
  composeRationale,
  decideState,
  describeGradeViolations,
  gradingFacts,
  isAiGradable,
  parseDecisionNote,
  parseRationale,
  readSample,
  sortForReview,
} from '@/lib/gradingProposal.mjs';
import { loadRubricForAi, type RubricView } from '@/lib/rubric';
import { mayGrade, setManualScore } from '@/lib/scoring';
import { requireTenant } from '@/lib/tenant';

// ─────────────────────────────────────────────────────────────────
// 錯誤
// ─────────────────────────────────────────────────────────────────

export type GradingErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'NOT_GRADABLE'
  | 'ATTEMPT_STATE'
  | 'BUDGET'
  | 'AI_DOWN'
  | 'BAD_DECISION';

export class GradingError extends Error {
  readonly code: GradingErrorCode;
  readonly status: number;
  constructor(code: GradingErrorCode, message: string, status = 400) {
    super(message);
    this.name = 'GradingError';
    this.code = code;
    this.status = status;
  }
}

export function gradingFailure(e: unknown): {
  status: number;
  body: { error: string; code?: GradingErrorCode };
} {
  if (e instanceof GradingError) {
    return { status: e.status, body: { error: e.message, code: e.code } };
  }
  if (e instanceof Error && e.name === 'RubricError') {
    return { status: 400, body: { error: e.message } };
  }
  console.error('[grading] 未預期的錯誤', e);
  return {
    status: 500,
    body: {
      error:
        'AI 閱卷出了點問題。**沒有任何分數被改動**——這一條路只會寫建議，' +
        '分數要你自己按下去才成立。可以直接用旁邊的輸入框給分。',
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 對外的形狀
// ─────────────────────────────────────────────────────────────────

export type ProposalDimension = {
  dimensionId: string;
  name: string;
  score: number;
  max: number;
  reason: string;
};

export type ProposalView = {
  id: string;
  state: 'PENDING' | 'ACCEPTED' | 'ADJUSTED' | 'REJECTED' | 'BLOCKED';
  /** BLOCKED 時仍然有一個數字（被擋下的那一份），但**畫面上不可以當建議用**。 */
  suggestedScore: number | null;
  dimensions: ProposalDimension[];
  rationale: string;
  /** AI 判斷不穩。從 `rationale` 的第一行讀回來（見 `STABILITY_MARK`）。 */
  unstable: boolean;
  stabilityNote: string;
  confidence: number | null;
  blockedReason: string | null;
  modelUsed: string | null;
  promptVersion: string | null;
  rubricId: string | null;
  finalScore: number | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string;
  /** 老師標的「哪幾個面向評不準」。 */
  weakDimensions: string[];
  createdAt: string;
};

/** 批次閱卷頁上的一列：一位學生的一題。 */
export type BatchRow = {
  attemptId: string;
  userId: string;
  displayName: string;
  username: string;
  attemptNo: number;
  attemptStatus: string;
  /** 學生寫的原文。**不排版**——老師要評的是他打的字。 */
  answerText: string;
  answered: boolean;
  /** 現在的分數（可能是老師剛給的，也可能還是 null）。 */
  earnedScore: number | null;
  scoreNote: string | null;
  manual: boolean;
  maxScore: number;
  proposal: ProposalView | null;
  /** `sortForReview` 用它做確定的次序。 */
  sortKey: string;
  state: string;
};

export type BatchView = {
  assignmentId: string;
  assignmentTitle: string;
  questionId: string;
  questionOrder: number | null;
  questionType: string;
  stem: string;
  /** 題幹的附圖。老師要判 AI 的建議合不合理，手上得有學生看到的東西。 */
  stemAssets: Prisma.JsonValue | null;
  /**
   * 題組的前導敘述（引文、圖表說明）。
   *
   * **AI 拿得到而老師拿不到是不可以的。** `proposeGrade` 刻意把它併進
   * 餵給模型的題幹（見那一支：少了引文等於評一段沒有題目的作答），
   * 而這一頁以前只給老師子題題幹——於是老師在判斷一個他看不到題目的
   * 建議準不準。
   */
  stimulus: string | null;
  stimulusLabel: string | null;
  stimulusAssets: Prisma.JsonValue | null;
  maxScore: number;
  /** 規準（含描述文字）。**只在老師端**，而且這一頁自己判過 `mayGrade`。 */
  rubric: RubricView | null;
  rows: BatchRow[];
  /** 還沒有分數的份數。頁首那一句話要說得出來。 */
  pending: number;
  /** 已經有 AI 建議、還沒有人決定的份數。 */
  waiting: number;
};

// ─────────────────────────────────────────────────────────────────
// 讀
// ─────────────────────────────────────────────────────────────────

const PROPOSAL_SELECT = {
  id: true,
  attemptId: true,
  questionId: true,
  state: true,
  suggestedScore: true,
  dimensions: true,
  rationale: true,
  confidence: true,
  blockedReason: true,
  modelUsed: true,
  promptVersion: true,
  rubricId: true,
  finalScore: true,
  decidedBy: true,
  decidedAt: true,
  decisionNote: true,
  createdAt: true,
};

type ProposalRow = Prisma.AnswerGradeProposalGetPayload<{ select: typeof PROPOSAL_SELECT }>;

/**
 * `Question.scoringRule` 是 jsonb，型別上可能是字串或數字。
 * **在這裡窄化而不是在 `isAiGradable` 裡**：那一支是純函式，
 * 它不該認得 Prisma 的型別。
 */
function asRule(raw: Prisma.JsonValue | null): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function readDimensions(raw: Prisma.JsonValue | null): ProposalDimension[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposalDimension[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const d = item as Record<string, unknown>;
    out.push({
      dimensionId: typeof d.dimensionId === 'string' ? d.dimensionId : '',
      name: typeof d.name === 'string' ? d.name : '',
      score: typeof d.score === 'number' ? d.score : 0,
      max: typeof d.max === 'number' ? d.max : 0,
      reason: typeof d.reason === 'string' ? d.reason : '',
    });
  }
  return out;
}

function toProposalView(r: ProposalRow, decidedByName: string | null = null): ProposalView {
  const parsed = parseRationale(r.rationale);
  const note = parseDecisionNote(r.decisionNote);
  return {
    id: r.id,
    state: r.state,
    suggestedScore: r.suggestedScore,
    dimensions: readDimensions(r.dimensions),
    rationale: parsed.rationale,
    unstable: parsed.unstable,
    stabilityNote: parsed.note,
    confidence: r.confidence,
    blockedReason: r.blockedReason,
    modelUsed: r.modelUsed,
    promptVersion: r.promptVersion,
    rubricId: r.rubricId,
    finalScore: r.finalScore,
    decidedBy: r.decidedBy,
    decidedByName,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    decisionNote: note.note,
    weakDimensions: note.dimensions,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * 一份作答的每一筆建議，鍵是 questionId。
 *
 * 給答案卷那一頁用（每一題旁邊畫一塊）。**不做權限判斷**——那一頁在
 * 進來的時候已經判過 `mayViewGrades` 與 `mayGrade` 了，這裡再判一次
 * 需要重查一次科目，而漏判的風險由那一頁的判斷擋著。
 */
export async function loadProposalsForAttempt(
  attemptId: string,
): Promise<Map<string, ProposalView>> {
  requireTenant();
  const rows = await prisma.answerGradeProposal.findMany({
    where: { attemptId },
    select: PROPOSAL_SELECT,
  });
  const names = await decidedByNames(rows);
  return new Map(
    rows.map((r) => [r.questionId, toProposalView(r, r.decidedBy ? (names.get(r.decidedBy) ?? null) : null)]),
  );
}

async function decidedByNames(rows: { decidedBy: string | null }[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.decidedBy).filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true },
  });
  return new Map(users.map((u) => [u.id, u.displayName]));
}

/**
 * 這份任務的卷子上有哪幾題是 AI 評得了的非選題，以及各題還缺幾份分數。
 *
 * 批次閱卷頁的第一層選單靠它。**待評分的份數要用「派給了誰」還是
 * 「誰交了卷」算？用後者**：沒有交卷的那幾位沒有答案可以評，而他們
 * 出現在這個數字裡會讓老師永遠改不完。
 */
export async function nonObjectiveItems(assignmentId: string): Promise<
  {
    questionId: string;
    order: number;
    type: string;
    score: number;
    peek: string;
    hasRubric: boolean;
    total: number;
    scored: number;
    proposed: number;
    undecided: number;
  }[]
> {
  requireTenant();
  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId },
    select: {
      paper: {
        select: {
          items: {
            select: {
              order: true,
              score: true,
              questionId: true,
              question: { select: { id: true, type: true, content: true, scoringRule: true } },
            },
            orderBy: { order: 'asc' },
          },
        },
      },
    },
  });
  if (!assignment) throw new GradingError('NOT_FOUND', '找不到這份任務', 404);

  const items = assignment.paper.items.filter((i) =>
    isAiGradable(i.question.type, asRule(i.question.scoringRule)),
  );
  if (items.length === 0) return [];

  const qids = items.map((i) => i.questionId);
  const [attempts, answers, proposals, rubrics] = await Promise.all([
    prisma.attempt.findMany({
      where: { assignmentId, status: { in: ['SUBMITTED', 'GRADED'] } },
      select: { id: true },
    }),
    prisma.attemptAnswer.findMany({
      where: { questionId: { in: qids }, attempt: { assignmentId } },
      select: { questionId: true, earnedScore: true },
    }),
    prisma.answerGradeProposal.findMany({
      where: { questionId: { in: qids }, attempt: { assignmentId } },
      select: { questionId: true, state: true },
    }),
    prisma.rubric.findMany({ where: { questionId: { in: qids } }, select: { questionId: true } }),
  ]);

  const withRubric = new Set(rubrics.map((r) => r.questionId));
  return items.map((i) => {
    const mine = answers.filter((a) => a.questionId === i.questionId);
    const props = proposals.filter((p) => p.questionId === i.questionId);
    return {
      questionId: i.questionId,
      order: i.order,
      type: i.question.type,
      score: i.score,
      peek: i.question.content.slice(0, 60),
      hasRubric: withRubric.has(i.questionId),
      total: attempts.length,
      scored: mine.filter((a) => a.earnedScore !== null).length,
      proposed: props.length,
      undecided: props.filter((p) => p.state === 'PENDING').length,
    };
  });
}

/**
 * 批次閱卷頁的資料：一份任務的同一題，全班一起看。
 *
 * # 為什麼是「一題 × 全班」而不是「一份 × 全部題目」
 *
 * 因為那是老師真正的工作方式。三十份作文比較著改比一份一份改快得多，
 * 而且**標準比較一致**——一個人連續看三十份同一題的答案，他心裡的
 * 尺度會穩定下來；換題目換學生地跳著改，第五份與第二十五份的標準
 * 不一樣，而那個不一樣沒有任何辦法事後修正。
 */
export async function loadQuestionBatch(
  user: SessionUser,
  assignmentId: string,
  questionId: string,
): Promise<BatchView> {
  requireTenant();
  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId },
    select: {
      id: true,
      title: true,
      paper: {
        select: {
          subjectId: true,
          items: {
            select: {
              questionId: true,
              order: true,
              score: true,
              question: {
                select: {
                  id: true,
                  type: true,
                  content: true,
                  contentAssets: true,
                  scoringRule: true,
                  // 題組的引文與共用附圖。與 `proposeGrade` 餵給模型的
                  // 是同一份資料——兩邊看到的題目不一樣的話，老師否決
                  // 建議時記下的「AI 評不準」其實是「老師少看了引文」。
                  group: { select: { stimulus: true, label: true, stimulusAssets: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!assignment) throw new GradingError('NOT_FOUND', '找不到這份任務', 404);
  if (!(await mayGrade(user, assignment.paper.subjectId))) {
    throw new GradingError('FORBIDDEN', '只有這一科的授課老師與管理員可以閱卷', 403);
  }

  const item = assignment.paper.items.find((i) => i.questionId === questionId);
  if (!item) throw new GradingError('NOT_FOUND', '這一題不在這份卷子上', 404);
  if (!isAiGradable(item.question.type, asRule(item.question.scoringRule))) {
    throw new GradingError(
      'NOT_GRADABLE',
      '這一題不是非選題（或已經設了自動比對規則），會由系統自動計分。',
      400,
    );
  }

  const attempts = await prisma.attempt.findMany({
    where: { assignmentId, status: { in: ['SUBMITTED', 'GRADED'] } },
    select: {
      id: true,
      userId: true,
      attemptNo: true,
      status: true,
      layout: true,
      user: { select: { displayName: true, username: true } },
    },
    orderBy: [{ user: { username: 'asc' } }, { attemptNo: 'asc' }],
  });

  const attemptIds = attempts.map((a) => a.id);
  const [answers, proposals] = await Promise.all([
    prisma.attemptAnswer.findMany({
      where: { questionId, attemptId: { in: attemptIds } },
      select: { attemptId: true, answerText: true, earnedScore: true, scoreNote: true },
    }),
    prisma.answerGradeProposal.findMany({
      where: { questionId, attemptId: { in: attemptIds } },
      select: PROPOSAL_SELECT,
    }),
  ]);
  const names = await decidedByNames(proposals);
  const byAttempt = new Map(answers.map((a) => [a.attemptId, a]));
  const propByAttempt = new Map(proposals.map((p) => [p.attemptId, p]));

  const rows: BatchRow[] = attempts.map((a) => {
    const ans = byAttempt.get(a.id) ?? null;
    const p = propByAttempt.get(a.id) ?? null;
    // 配分以**版面快照**為準，與計分和人工給分同一個口徑：老師在考後
    // 改了卷面配分，這位學生當時看到的仍然是舊的那個數字。
    let max = item.score;
    try {
      max = readLayout(a.layout).find((l) => l.questionId === questionId)?.score ?? item.score;
    } catch {
      /* 版面快照壞了就用卷面配分。這一頁不該因此整頁打不開。 */
    }
    return {
      attemptId: a.id,
      userId: a.userId,
      displayName: a.user.displayName,
      username: a.user.username,
      attemptNo: a.attemptNo,
      attemptStatus: a.status,
      answerText: ans?.answerText ?? '',
      answered: Boolean(ans && (ans.answerText ?? '').trim() !== ''),
      earnedScore: ans?.earnedScore ?? null,
      scoreNote: ans?.scoreNote ?? null,
      manual: isManualScore(ans?.scoreNote ?? null),
      maxScore: max,
      proposal: p ? toProposalView(p, p.decidedBy ? (names.get(p.decidedBy) ?? null) : null) : null,
      sortKey: a.user.username,
      state: p?.state ?? 'PENDING',
    };
  });

  return {
    assignmentId,
    assignmentTitle: assignment.title,
    questionId,
    questionOrder: item.order,
    questionType: item.question.type,
    stem: item.question.content,
    stemAssets: item.question.contentAssets,
    stimulus: item.question.group?.stimulus ?? null,
    stimulusLabel: item.question.group?.label ?? null,
    stimulusAssets: item.question.group?.stimulusAssets ?? null,
    maxScore: item.score,
    // 這一頁已經判過 `mayGrade`，所以規準的描述文字在這裡是授權範圍內的
    // ——它是老師閱卷時的依據。學生那一側走 `rubricNoticeForStudent`。
    rubric: await loadRubricForAi(questionId),
    rows: sortForReview(rows) as BatchRow[],
    pending: rows.filter((r) => r.earnedScore === null).length,
    waiting: rows.filter((r) => r.proposal && r.proposal.state === 'PENDING').length,
  };
}

// ─────────────────────────────────────────────────────────────────
// 產生建議
// ─────────────────────────────────────────────────────────────────

/** 重新生成的次數上限。與智慧老師一致：三次拿不到合格輸出就退回人工。 */
const MAX_RETRY = 2;

/** 同一份答案評幾次。奇數，理由見 `aggregateSamples`（中位數要是真的樣本）。 */
const SAMPLES = 3;

export type ProposeOutcome = {
  attemptId: string;
  questionId: string;
  state: 'PENDING' | 'BLOCKED';
  proposal: ProposalView | null;
  /** 被擋下的理由（BLOCKED 時一定有）。 */
  blockedReason: string | null;
  /** 真的呼叫了幾次（含第一次）。突然變多代表提示詞或模型換了版本。 */
  attempts: number;
};

/**
 * 請 AI 評一份答案，把結果寫成一筆**建議**。
 *
 * 這一支不碰分數。它的輸出永遠是 `PENDING`（有可用的建議）或 `BLOCKED`
 * （閘門連續擋下來），兩者都要老師動一次手才會變成分數。
 */
export async function proposeGrade(
  user: SessionUser,
  attemptId: string,
  questionId: string,
): Promise<ProposeOutcome> {
  const tenantId = requireTenant();

  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId },
    select: {
      id: true,
      status: true,
      layout: true,
      assignment: {
        select: {
          paper: {
            select: {
              subjectId: true,
              subject: { select: { code: true } },
              items: {
                select: {
                  questionId: true,
                  score: true,
                  question: {
                    select: {
                      id: true,
                      type: true,
                      content: true,
                      scoringRule: true,
                      group: { select: { stimulus: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!attempt) throw new GradingError('NOT_FOUND', '找不到這一份作答', 404);
  if (!(await mayGrade(user, attempt.assignment.paper.subjectId))) {
    throw new GradingError('FORBIDDEN', '只有這一科的授課老師與管理員可以閱卷', 403);
  }
  if (attempt.status === 'IN_PROGRESS') {
    throw new GradingError(
      'ATTEMPT_STATE',
      '這一份還在作答中。學生還在寫的時候評分，他之後寫的答案會與建議對不起來。',
      409,
    );
  }
  if (attempt.status === 'VOIDED') {
    throw new GradingError('ATTEMPT_STATE', '這一份已經作廢，不計分也不評分。', 409);
  }

  const item = attempt.assignment.paper.items.find((i) => i.questionId === questionId);
  if (!item) throw new GradingError('NOT_FOUND', '這一題不在這份卷子上', 404);
  if (!isAiGradable(item.question.type, asRule(item.question.scoringRule))) {
    throw new GradingError('NOT_GRADABLE', '這一題由系統自動計分，不需要 AI 評分。', 400);
  }

  let maxScore = item.score;
  try {
    maxScore = readLayout(attempt.layout).find((l) => l.questionId === questionId)?.score ?? item.score;
  } catch {
    /* 版面快照壞了就用卷面配分 */
  }

  const answerRow = await prisma.attemptAnswer.findFirst({
    where: { attemptId, questionId },
    select: { answerText: true },
  });
  const answer = answerRow?.answerText ?? '';

  const rubric = await loadRubricForAi(questionId);
  await assertBudget(tenantId);

  // 題組共用的引文要一起餵進去：一題「請根據上文說明…」少了引文，
  // 模型評的是一段沒有題目的作答。
  const stem = [item.question.group?.stimulus ?? '', item.question.content]
    .filter((x) => x.trim() !== '')
    .join('\n');

  const facts = gradingFacts({
    question: { stem, score: maxScore },
    rubric,
    answer,
  });

  let violations = '';
  let retries = 0;
  let picked: ReturnType<typeof aggregateSamples> = null;
  let checked: ReturnType<typeof checkGradeProposal> | null = null;
  let modelUsed = '';
  let promptVersion = '';

  for (; retries <= MAX_RETRY; retries += 1) {
    const res = await callGrading({
      question: {
        type: item.question.type,
        stem,
        score: maxScore,
        subject: attempt.assignment.paper.subject?.code ?? null,
      },
      rubric: rubric ? aiRubric(rubric) : null,
      answer,
      samples: SAMPLES,
      retry: retries,
      violations,
      tier: 'MID',
    });
    modelUsed = res.model;
    promptVersion = res.prompt_version;
    await recordUsage({
      tenantId,
      attemptId,
      tokensIn: res.input_tokens,
      tokensOut: res.output_tokens,
      model: res.model,
      promptVersion: res.prompt_version,
      latencyMs: res.latency_ms,
      retryCount: retries,
      succeeded: true,
      errorCode: null,
    });

    const samples = res.samples.map((s) => readSample(s));
    const agg = aggregateSamples(samples, { maxScore });
    if (!agg) {
      violations = 'NO_SAMPLE：一份可以解析的評分都沒有';
      continue;
    }
    const check = checkGradeProposal(agg.pick, facts);
    picked = agg;
    checked = check;
    if (!check.unusable) break;
    violations = describeGradeViolations(check.violations);
  }

  const blocked = !picked || !checked || checked.unusable;
  // 次數要報「真的呼叫了幾次」。迴圈跑完之後 `retries` 已經多加了一次
  // （for 的遞增在條件不成立之前就跑了），直接寫 `retries + 1` 會多算
  // 一次——而那個數字會出現在老師的畫面上。
  const attempts = Math.min(retries, MAX_RETRY) + 1;
  const blockedReason = blocked
    ? `連續 ${attempts} 次沒有通過閘門：${violations || '（沒有記錄）'}`.slice(0, 1500)
    : null;

  // 被擋下的建議**仍然存起來**，理由見表註解：那是唯一看得出「AI 的
  // 閱卷準不準」的資料。刪掉它，這個功能的採用率就永遠算不出來。
  const data = {
    tenantId,
    attemptId,
    questionId,
    state: (blocked ? 'BLOCKED' : 'PENDING') as 'BLOCKED' | 'PENDING',
    suggestedScore: picked ? picked.pick.suggestedScore : 0,
    dimensions: (picked ? picked.pick.dimensions : []) as unknown as Prisma.InputJsonValue,
    rationale: picked
      ? composeRationale({
          rationale: picked.pick.rationale,
          unstable: picked.unstable,
          note: picked.note,
        })
      : '（沒有拿到任何可以解析的評分）',
    confidence: picked ? picked.confidence : null,
    blockedReason,
    modelUsed: modelUsed || null,
    promptVersion: promptVersion || null,
    rubricId: rubric?.id ?? null,
    // 重評一次要把上一次的決定清掉，否則 CHECK 會擋住
    // （`state IN (PENDING, BLOCKED)` 時不可以有 decidedBy）。
    finalScore: null,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
  };

  const row = await prisma.answerGradeProposal.upsert({
    where: { attemptId_questionId: { attemptId, questionId } },
    create: data,
    update: data,
    select: PROPOSAL_SELECT,
  });

  return {
    attemptId,
    questionId,
    state: blocked ? 'BLOCKED' : 'PENDING',
    proposal: toProposalView(row),
    blockedReason,
    attempts,
  };
}

/**
 * 一整題、全班一起評。
 *
 * **一份一份跑，不併發。** 每一份自己已經是 N 次呼叫（Python 端併發），
 * 三十份再併發就是九十個同時的請求打到閘道上——那會撞限流，而限流的
 * 症狀是「有幾份沒有建議」而不是一個錯誤訊息。
 *
 * 中途失敗不回滾：已經寫進去的建議是有價值的，而重按一次只會重評
 * 還沒有建議的那幾份（`skipExisting`）。
 */
export async function proposeGradesForQuestion(
  user: SessionUser,
  assignmentId: string,
  questionId: string,
  opts: { skipExisting?: boolean; limit?: number } = {},
): Promise<{ done: number; blocked: number; skipped: number; failed: number; errors: string[] }> {
  requireTenant();
  const view = await loadQuestionBatch(user, assignmentId, questionId);
  const limit = opts.limit ?? 60;

  let done = 0;
  let blocked = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of view.rows) {
    if (done + blocked >= limit) break;
    // 已經有人決定過的一律不重評——重評會把老師的決定清掉
    // （見 `proposeGrade` 裡把 decidedBy 清成 null 的那一段）。
    if (row.proposal && row.proposal.state !== 'PENDING' && row.proposal.state !== 'BLOCKED') {
      skipped += 1;
      continue;
    }
    if (opts.skipExisting !== false && row.proposal && row.proposal.state === 'PENDING') {
      skipped += 1;
      continue;
    }
    try {
      const out = await proposeGrade(user, row.attemptId, questionId);
      if (out.state === 'BLOCKED') blocked += 1;
      else done += 1;
    } catch (e) {
      failed += 1;
      const msg = e instanceof Error ? e.message : String(e);
      if (errors.length < 3) errors.push(`${row.displayName}：${msg}`);
      // 預算用完或 AI 掛掉時不必再試二十九次。
      if (e instanceof GradingError && (e.code === 'BUDGET' || e.code === 'AI_DOWN')) break;
    }
  }
  return { done, blocked, skipped, failed, errors };
}

// ─────────────────────────────────────────────────────────────────
// 老師的決定
// ─────────────────────────────────────────────────────────────────

export type DecideInput = {
  attemptId: string;
  questionId: string;
  /** 老師最後給的分數。 */
  finalScore: number;
  /** 按了「這個建議沒有參考價值」。 */
  dismissed?: boolean;
  note?: string | null;
  /** 老師標的「哪幾個面向評不準」。 */
  weakDimensions?: string[];
};

/**
 * 老師決定：採用、改分、或不採用。
 *
 * # 分數是這一支寫的嗎？不是
 *
 * 分數由 `setManualScore`（`lib/scoring.ts`）寫，也就是老師在答案卷上
 * 直接打一個數字時走的那一支。這裡只是**多記一筆「這個分數與 AI 的
 * 建議差多少」**。
 *
 * 走同一支的三個後果都是必要的：稽核紀錄的形狀一樣、`scoreNote` 帶得到
 * 人工給分的記號（所以「全班重新計分」不會蓋掉它）、而且總分會跟著
 * 重算。自己寫一條路的話，第二項最容易漏——而漏了它的症狀要等到
 * 下一次有人按重新計分才出現。
 */
export async function decideProposal(
  user: SessionUser,
  inp: DecideInput,
): Promise<{ proposal: ProposalView; earnedScore: number | null }> {
  const tenantId = requireTenant();

  const existing = await prisma.answerGradeProposal.findFirst({
    where: { attemptId: inp.attemptId, questionId: inp.questionId },
    select: PROPOSAL_SELECT,
  });
  if (!existing) {
    throw new GradingError(
      'NOT_FOUND',
      '這一題還沒有 AI 建議可以決定。直接用輸入框給分就好。',
      404,
    );
  }

  const attempt = await prisma.attempt.findFirst({
    where: { id: inp.attemptId },
    select: { assignment: { select: { paper: { select: { subjectId: true } } } } },
  });
  if (!attempt) throw new GradingError('NOT_FOUND', '找不到這一份作答', 404);
  if (!(await mayGrade(user, attempt.assignment.paper.subjectId))) {
    throw new GradingError('FORBIDDEN', '只有這一科的授課老師與管理員可以給分', 403);
  }

  // 被擋下的建議沒有分數可以比，一律算「不採用」。
  const suggested = existing.state === 'BLOCKED' ? null : existing.suggestedScore;
  const state = decideState({
    suggested,
    final: inp.finalScore,
    dismissed: inp.dismissed === true,
  });
  const decisionNote = composeDecisionNote({
    dimensions: inp.weakDimensions ?? [],
    note: inp.note ?? '',
  });

  const valid = checkDecision({
    state,
    finalScore: inp.finalScore,
    note: inp.note ?? '',
    dimensions: inp.weakDimensions ?? [],
  });
  if (!valid.ok) throw new GradingError('BAD_DECISION', valid.error, 400);

  // ── 先寫分數 ──────────────────────────────────────────────
  //
  // 反過來的話，資料庫裡會有一筆「已採用、18 分」而學生那一題還是
  // 待評分——而老師的畫面上那一列已經變成處理完了。
  const result = await setManualScore(inp.attemptId, inp.questionId, {
    score: inp.finalScore,
    note: teacherNote({ state, note: inp.note ?? '', suggested }),
    actorId: user.id,
  });

  const row = await prisma.answerGradeProposal.update({
    where: { id: existing.id },
    data: {
      state,
      finalScore: inp.finalScore,
      decidedBy: user.id,
      decidedAt: new Date(),
      decisionNote: decisionNote || null,
    },
    select: PROPOSAL_SELECT,
  });

  await prisma.auditLog.create({
    data: {
      tenantId,
      category: 'GRADE',
      action: 'grade.ai_proposal_decided',
      actorId: user.id,
      targetType: 'Attempt',
      targetId: inp.attemptId,
      before: {
        questionId: inp.questionId,
        suggestedScore: existing.suggestedScore,
        state: existing.state,
      } as Prisma.InputJsonValue,
      after: {
        questionId: inp.questionId,
        state,
        finalScore: inp.finalScore,
        decisionNote: decisionNote || null,
      } as Prisma.InputJsonValue,
      // 誤差留在稽核裡，因為採用率是事後回頭算的，而 `AnswerGradeProposal`
      // 會被重評覆蓋（同一個 attempt+question 只有一列）。
      metadata: {
        promptVersion: existing.promptVersion,
        modelUsed: existing.modelUsed,
        delta:
          suggested === null ? null : Math.round((inp.finalScore - suggested) * 100) / 100,
      } as Prisma.InputJsonValue,
    },
  });

  return {
    proposal: toProposalView(row, user.displayName),
    earnedScore: result.earnedScore ?? null,
  };
}

/**
 * 寫進 `AttemptAnswer.scoreNote` 的那一句。
 *
 * **一定要說出這個分數與 AI 的建議是什麼關係**，因為 `scoreNote` 是
 * 學生看得到的、而且是家長問起來時唯一留下的東西。老師照建議給分時
 * 也要寫出來——不寫的話，這個系統就變成「AI 給分但沒有人知道」。
 *
 * 不含 AI 的理由原文：那一段可能引用規準的描述（`internalOnly`）。
 */
function teacherNote(inp: { state: string; note: string; suggested: number | null }): string {
  const body = inp.note.trim();
  const how =
    inp.state === 'ACCEPTED'
      ? 'AI 提出建議、老師確認後給分'
      : inp.state === 'ADJUSTED'
        ? `老師調整後給分（AI 原建議 ${inp.suggested ?? '—'} 分）`
        : '老師評分（未採用 AI 建議）';
  return body ? `${how}：${body}` : how;
}

// ─────────────────────────────────────────────────────────────────
// 這個功能到底準不準
// ─────────────────────────────────────────────────────────────────

export type AccuracyView = ReturnType<typeof accuracyReport> & {
  byQuestion: {
    questionId: string;
    order: number | null;
    peek: string;
    decided: number;
    adoptionRate: number | null;
    mae: number | null;
  }[];
  /** 有幾個提示詞版本混在這批數字裡。混著看會把兩套規則的表現平均掉。 */
  promptVersions: string[];
};

/**
 * 採用率、平均誤差、被改最多的面向。
 *
 * # 為什麼一定要有這一頁
 *
 * 因為**採用率 90% 與 30% 是兩個完全不同的世界，而後者代表這個功能
 * 該關掉**（`AnswerGradeProposal` 的表註解）。沒有這個數字，這個功能會
 * 一直開著，而沒有人說得出它到底有沒有用。
 *
 * @param scope 不給就是整個租戶。給了 assignmentId 就只看那一份任務。
 */
export async function gradingAccuracy(
  scope: { assignmentId?: string } = {},
): Promise<AccuracyView> {
  requireTenant();
  const rows = await prisma.answerGradeProposal.findMany({
    where: scope.assignmentId ? { attempt: { assignmentId: scope.assignmentId } } : {},
    select: {
      questionId: true,
      state: true,
      suggestedScore: true,
      finalScore: true,
      decisionNote: true,
      promptVersion: true,
    },
    orderBy: { createdAt: 'desc' },
    // 上限：這一頁是給人看趨勢的，不是報表。三千筆足以算出穩定的採用率，
    // 而沒有上限的話，一年之後這一頁會開始逾時。
    take: 3000,
  });

  const qids = [...new Set(rows.map((r) => r.questionId))];
  const items = await prisma.examPaperItem.findMany({
    where: { questionId: { in: qids } },
    select: { questionId: true, order: true, score: true, question: { select: { content: true } } },
  });
  // 同一題可能在好幾份卷子上，配分也可能不同。取第一個當顯示用，
  // 而誤差的正規化用各自的配分（下面 withMax）。
  const meta = new Map<string, { order: number; score: number; peek: string }>();
  for (const i of items) {
    if (!meta.has(i.questionId)) {
      meta.set(i.questionId, {
        order: i.order,
        score: i.score,
        peek: i.question.content.slice(0, 40),
      });
    }
  }

  const withMax = rows.map((r) => ({ ...r, maxScore: meta.get(r.questionId)?.score ?? null }));
  const overall = accuracyReport(withMax);

  const byQuestion = qids
    .map((qid) => {
      const sub = accuracyReport(withMax.filter((r) => r.questionId === qid));
      const m = meta.get(qid);
      return {
        questionId: qid,
        order: m?.order ?? null,
        peek: m?.peek ?? '（找不到題目）',
        decided: sub.decided,
        adoptionRate: sub.adoptionRate,
        mae: sub.mae,
      };
    })
    .filter((q) => q.decided > 0)
    .sort((a, b) => (a.adoptionRate ?? 1) - (b.adoptionRate ?? 1));

  return {
    ...overall,
    byQuestion,
    promptVersions: [...new Set(rows.map((r) => r.promptVersion).filter((x): x is string => Boolean(x)))],
  };
}

// ─────────────────────────────────────────────────────────────────
// 用量與預算
// ─────────────────────────────────────────────────────────────────

function yearMonth(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 預算用完就不再評。**只擋 AI 評分，不擋人工給分。**
 *
 * 與智慧老師同一條規則（規格書文件 01 §16 的降級原則）：預算用完不該
 * 讓成績停擺。老師照樣改得動每一份，只是沒有第一稿。
 *
 * 這一項在閱卷上特別重要：一次「全班一起評」是三十份 × 三次 = 九十次
 * 呼叫，每次含題幹、規準與整篇作文。那是這個系統裡單次最貴的動作。
 */
async function assertBudget(tenantId: string): Promise<void> {
  const budget = Number(process.env.AI_MONTHLY_TOKEN_BUDGET ?? 0);
  if (!(budget > 0)) return;
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  const agg = await prisma.aiUsageLog.aggregate({
    where: { tenantId, createdAt: { gte: since } },
    _sum: { inputTokens: true, outputTokens: true },
  });
  const used = (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
  if (used >= budget) {
    throw new GradingError(
      'BUDGET',
      `這個月的 AI 用量已經到上限（${used.toLocaleString()} / ${budget.toLocaleString()}）。` +
        'AI 閱卷暫停，人工給分、成績與考試都不受影響。',
      429,
    );
  }
}

async function recordUsage(u: {
  tenantId: string;
  attemptId: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  promptVersion: string;
  latencyMs: number;
  retryCount: number;
  succeeded: boolean;
  errorCode: string | null;
}): Promise<void> {
  if (u.tokensIn === 0 && u.tokensOut === 0) return;
  const ym = yearMonth();
  try {
    await prisma.$transaction([
      prisma.aiUsageLog.create({
        data: {
          tenantId: u.tenantId,
          purpose: 'GRADING',
          // MID 而不是 HIGH：閱卷要的是照規準判斷，不是推導。
          // HIGH 的價格是 MID 的五倍，而一次全班閱卷是九十次呼叫。
          tier: 'MID',
          provider: process.env.AI_PROVIDER ?? 'unknown',
          model: u.model || 'unknown',
          baseUrl: process.env.AI_BASE_URL ?? null,
          inputTokens: u.tokensIn,
          outputTokens: u.tokensOut,
          latencyMs: u.latencyMs || null,
          succeeded: u.succeeded,
          errorCode: u.errorCode,
          retryCount: u.retryCount,
          refType: 'Attempt',
          refId: u.attemptId,
          promptVersion: u.promptVersion,
        },
      }),
      prisma.aiBudgetCounter.upsert({
        where: { tenantId_yearMonth: { tenantId: u.tenantId, yearMonth: ym } },
        create: {
          tenantId: u.tenantId,
          yearMonth: ym,
          inputTokens: BigInt(u.tokensIn),
          outputTokens: BigInt(u.tokensOut),
          callCount: 1,
        },
        update: {
          inputTokens: { increment: BigInt(u.tokensIn) },
          outputTokens: { increment: BigInt(u.tokensOut) },
          callCount: { increment: 1 },
        },
      }),
    ]);
  } catch (e) {
    // 記帳失敗不該把已經產生的建議吞掉。帳目的真相在 AiUsageLog，
    // 那一筆若也失敗了，下一次的 aggregate 會少算這一次。
    console.error('[grading] 用量記錄失敗', e);
  }
}

// ─────────────────────────────────────────────────────────────────
// 與 AI 服務的溝通
// ─────────────────────────────────────────────────────────────────

const AI_URL = (process.env.AI_SERVICE_URL ?? 'http://ai:8000').replace(/\/+$/, '');

/**
 * 一次閱卷的逾時。
 *
 * 比智慧老師（60 秒）長得多，因為一次要評 N 遍（Python 端併發，但
 * 上游限流時會排隊），而且輸入含整篇作文。老師按下去之後在等，
 * 但他等的是三十份裡的一份——太短的逾時會讓「全班一起評」在最忙的
 * 時候一半失敗。
 */
const GRADING_TIMEOUT_MS = 120_000;

type GradingResponse = {
  samples: {
    score: number;
    dimensions: unknown[];
    rationale: string;
    confidence: number | null;
  }[];
  parse_failures: number;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  tokens_estimated: boolean;
  latency_ms: number;
  prompt_version: string;
};

/** 規準折成 Python 端的欄位命名。 */
function aiRubric(r: RubricView) {
  return {
    name: r.name,
    total_score: r.totalScore,
    mode: r.mode,
    dimensions: r.dimensions.map((d) => ({
      id: d.id,
      name: d.name,
      max_score: d.maxScore,
      descriptor: d.descriptor,
    })),
    bands: r.bands.map((b) => ({
      grade: b.grade,
      score_min: b.scoreMin,
      score_max: b.scoreMax,
      descriptor: b.descriptor,
      dimension_name: b.dimensionName,
    })),
  };
}

async function callGrading(body: unknown): Promise<GradingResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRADING_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${AI_URL}/v1/grading/score`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    throw new GradingError(
      'AI_DOWN',
      aborted
        ? 'AI 想太久了，這一份沒有建議。直接用輸入框給分，或稍後再試。'
        : '現在連不上 AI 服務。**沒有任何分數被改動**，人工給分照樣可以用。',
      503,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 400);
    try {
      const j = JSON.parse(text) as { detail?: unknown };
      detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* 回應不是 JSON，用原文的前幾百字 */
    }
    console.error(`[grading] AI 服務回應 ${res.status}：${detail}`);
    throw new GradingError(
      'AI_DOWN',
      'AI 現在評不了這一份（設定或額度的問題）。這一題請人工閱卷。',
      503,
    );
  }
  return JSON.parse(text) as GradingResponse;
}
