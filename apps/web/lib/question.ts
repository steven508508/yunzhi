/**
 * 改題目：題幹、選項、標準答案、配分、題型、知識點、詳解、發布與下架，
 * 以及「全班送分」。
 *
 * # 在這個檔案之前，題庫是一條單行道
 *
 * 正式程式碼裡唯一一處 `question.update` 在 `lib/commit.ts`，而且只寫
 * `qualityFlags`。也就是說：題目一旦入庫就改不動了——標準答案抓錯的
 * 那一題，老師唯一的辦法是重新匯入一次整本題本。而畫面上有三個地方
 * 承諾了這件事做得到（`/grades` 的說明、重新計分對話框的兩個範例）。
 *
 * # 一、為什麼是「原地改」，而不是開一列新版本
 *
 * `Question` 有 `familyId` 與 `version`，schema 的註解說那是版本控制：
 * `familyId` 跨版本穩定、`id` 是版本列的主鍵、作答記錄指向 `id`
 * 所以天然版本化。照字面做的話，改答案應該是**新增一列**
 * `version + 1`、`familyId` 不變，然後把卷子指過去。
 *
 * **這裡刻意不那樣做，因為那會讓「改標準答案」變成一個沒有效果的動作。**
 *
 * 已經考過的作答透過兩條路指向舊的那一列：`AttemptAnswer.questionId`
 * 與 `Attempt.layout` 的快照。開新列的話，那兩條都還指著舊列，
 * 於是老師改完答案、按下「全班重新計分」、畫面回報「重算了 37 份」，
 * 而 37 份的分數一分都沒有變——因為重算讀的是舊列的 `answerKeys`。
 * 這正是這一輪在清的那種缺陷：**看起來成功、實際上什麼都沒發生**。
 *
 * 所以：
 *
 *   · `familyId` 永遠不動。它仍然是這一題跨版本的識別。
 *   · `version` **原地加一**，意思是「這一題的計分依據被改過幾次」——
 *     不是「被編輯過幾次」。改錯字不加版（見 `bumpsVersion`）：
 *     那不影響任何一份已經算出來的成績，算成一版只會讓家長申訴時
 *     翻出來的版號失去意義。
 *   · `inheritStats` 不動。它是給「真的分版」用的旗標，而原地改的題目
 *     統計本來就跟著同一列走。
 *   · 真正需要「另一題」的時候（換一整組選項、改考法），做法是在題庫
 *     **另外建一題**，把舊的那一題留給已經考過的人。那條路徑在
 *     `checkOptionStructure` 的錯誤訊息裡明說。
 *
 * 代價講清楚：舊版的題幹與答案不會留在 `questions` 表裡。它留在
 * `AuditLog.before`——每一次改動的前後值都寫進去，而那正是家長申訴時
 * 要拿出來的東西。
 *
 * # 二、學生「當時選了什麼」永遠不變
 *
 * `AttemptAnswer.answerKeys` 這一整層，這個檔案一個位元都不碰。
 * 重新計分也只寫 `isCorrect`、`earnedScore`、`scoreNote` 三欄
 * （見 `lib/scoring.ts` 檔頭）。所以改了標準答案之後：
 *
 *   學生選的 (2) 還是 (2)　→　只是它現在被判定為對的
 *
 * 唯一會破壞這件事的是**動到選項的結構**（增、刪、搬動），因為那會
 * 改掉「第 3 個」的意思。已經有人作答的題目一律擋下來，見
 * `lib/questionEdit.mjs` 的 `checkOptionStructure`。
 *
 * # 三、改完之後不會自己生效
 *
 * 改標準答案不會動到任何一份已經算好的成績——那是刻意的（見
 * `lib/scoring.ts`：計分是可重跑的動作，不是改題目的副作用）。
 * 所以每一支寫入都回傳 `impact`：**哪幾份任務、各有幾份作答要重算**，
 * 讓畫面直接把連結給老師。少了這一段，老師會以為改完就結束了，
 * 而那幾十份成績會一直是錯的。
 *
 * 「送分」是唯一的例外：它按下去就會順手重算那一份任務，因為它本來
 * 就是在成績頁上針對某一份任務做的決定。見 `setAward`。
 */
// 這裡的 `Prisma` 是**值**而不是只有型別（其餘的 lib 都只 import type）：
// 把一個可為 null 的 Json 欄位清空，Prisma 5 只認 `Prisma.DbNull`，
// 傳 JS 的 `null` 會在執行期被拒絕（Json 的 null 有兩種意思：
// 「這一格是 JSON 的 null」與「這一格是空的」）。而清空是真的需要的：
// 取消送分之後，`scoringRule` 應該回到什麼都沒設定的樣子。
import { Prisma } from '@prisma/client';

import type { SessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  bumpsVersion,
  checkOptionStructure,
  checkPublish,
  checkRetire,
  checkTypeChange,
  readAward,
  shapeOptions,
  typeFamily,
  withAward,
} from '@/lib/questionEdit.mjs';
import type { Award, OptionRow, PublishIssue, RetireBlocker } from '@/lib/questionEdit.mjs';
import { partitionAssets } from '@/lib/questionShape.mjs';
import { mayGrade, regradeAssignment } from '@/lib/scoring';
import { requireTenant } from '@/lib/tenant';

/**
 * 業務錯誤。帶 HTTP 狀態，因為「找不到」「你不能改」「你改的內容不對」
 * 是三件不同的事，混成同一個 400 的話前端分不出要顯示什麼。
 * 與 `lib/attempt.ts` 的 `AttemptError` 同一個做法。
 */
export class QuestionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'QuestionError';
    this.status = status;
  }
}

/** 題目改得動的狀態。`DRAFT` 是舊資料留下的，一樣看得到、改得動。 */
export const EDITABLE_STATUS = ['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'RETIRED'] as const;
export type QuestionStatus = (typeof EDITABLE_STATUS)[number];

// ─────────────────────────────────────────────────────────────
// 讀
// ─────────────────────────────────────────────────────────────

export type UsageAssignment = {
  assignmentId: string;
  title: string;
  dueAt: Date | null;
  /** 已交卷（含已評分）的份數。改了答案之後要重算的就是這些。 */
  graded: number;
  /** 還在作答中的份數。有值代表現在正在考這一題。 */
  inProgress: number;
};

export type QuestionUsage = {
  papers: {
    paperId: string;
    paperTitle: string;
    paperStatus: string;
    /** 這一題在那份卷子上值幾分。與題庫的預設配分是兩回事。 */
    score: number;
    assignments: UsageAssignment[];
  }[];
  /** 卷子上有這一題的作答份數（任何狀態）。**選項結構的鎖看這個數字。** */
  attempts: number;
  /** 真的留下作答記錄的份數。 */
  answered: number;
  /** 已經計過分的份數。改了答案之後要重算的就是這些。 */
  graded: number;
  inProgress: number;
};

export type QuestionDetail = {
  id: string;
  familyId: string;
  version: number;
  subjectId: string;
  subjectName: string;
  status: string;
  type: string;
  content: string;
  score: number;
  answerKeys: number[];
  answerSlots: string[] | null;
  answerText: string | null;
  scoringRule: Prisma.JsonValue | null;
  award: Award | null;
  options: { id: string; order: number; label: string; content: string }[];
  knowledgePointIds: string[];
  explanation: { id: string; origin: string; conclusion: string; steps: string[] } | null;
  /** 有解析但這個畫面編不了（AI 改寫、原文收錄）。要說出來，不要假裝沒有。 */
  foreignExplanations: number;
  sourceType: string;
  sourceRef: string | null;
  sourceExam: string | null;
  licenseScope: string;
  group: { id: string; label: string | null; stimulus: string } | null;
  nationalCorrectRate: number | null;
  createdAt: Date;
  updatedAt: Date;
  usage: QuestionUsage;
};

/**
 * 誰改得動這一題。**與 `lib/scoring.ts` 的 `mayGrade` 是同一條規則。**
 *
 * 不另外寫一份角色清單，理由與 `lib/nav.ts` 檔頭寫的一樣：兩份清單
 * 遲早會不一致，而不一致的方向若是「這裡放行、那裡擋住」，老師會
 * 看到一個按了就報錯的按鈕；反過來則是一個他不該有的權限。
 *
 * 改題目與改成績為什麼是同一條規則：**改標準答案就是在改成績**，
 * 只是隔了一次「重新計分」。給改答案卻不給重算，等於給了一把只能
 * 弄壞、不能修好的工具。
 */
export function mayEditQuestion(user: SessionUser, subjectId: string): Promise<boolean> {
  return mayGrade(user, subjectId);
}

/** 取出這一題，並確認這個人動得了它。動不了就丟出帶狀態碼的錯誤。 */
export async function requireEditable(questionId: string, user: SessionUser) {
  const q = await prisma.question.findFirst({
    where: { id: questionId },
    select: {
      id: true,
      subjectId: true,
      status: true,
      type: true,
      version: true,
      content: true,
      score: true,
      answerKeys: true,
      answerSlots: true,
      answerText: true,
      scoringRule: true,
      subject: { select: { name: true } },
    },
  });
  if (!q) throw new QuestionError('找不到這一題。它可能已經被刪除了。', 404);
  if (!(await mayEditQuestion(user, q.subjectId))) {
    throw new QuestionError(
      `你不是「${q.subject.name}」的授課老師，改不動這一題。` +
        `改別科的題目會直接影響那一科的成績，所以只有該科的老師與管理員可以改。`,
      403,
    );
  }
  return q;
}

/** 這一題被誰用著、已經有多少人考過。所有的擋阻與提醒都靠它。 */
export async function questionUsage(questionId: string): Promise<QuestionUsage> {
  const items = await prisma.examPaperItem.findMany({
    where: { questionId },
    select: {
      score: true,
      paper: {
        select: {
          id: true,
          title: true,
          status: true,
          assignments: { select: { id: true, title: true, dueAt: true } },
        },
      },
    },
  });

  const assignmentIds = items.flatMap((i) => i.paper.assignments.map((a) => a.id));

  // 一次查回來自己歸類，而不是每份任務各數一次。一題可能出現在十幾份
  // 卷子上（複習卷、模考、補考），逐份查會變成一頁十幾次往返。
  const [attempts, answered] = await Promise.all([
    assignmentIds.length
      ? prisma.attempt.findMany({
          where: { assignmentId: { in: assignmentIds } },
          select: { assignmentId: true, status: true },
        })
      : Promise.resolve([] as { assignmentId: string; status: string }[]),
    prisma.attemptAnswer.count({ where: { questionId } }),
  ]);

  const graded = new Map<string, number>();
  const running = new Map<string, number>();
  for (const a of attempts) {
    // 作廢的不算：它不計分，也不會因為改了答案而需要重算。
    if (a.status === 'SUBMITTED' || a.status === 'GRADED') {
      graded.set(a.assignmentId, (graded.get(a.assignmentId) ?? 0) + 1);
    } else if (a.status === 'IN_PROGRESS') {
      running.set(a.assignmentId, (running.get(a.assignmentId) ?? 0) + 1);
    }
  }

  return {
    papers: items.map((i) => ({
      paperId: i.paper.id,
      paperTitle: i.paper.title,
      paperStatus: i.paper.status,
      score: i.score,
      assignments: i.paper.assignments.map((a) => ({
        assignmentId: a.id,
        title: a.title,
        dueAt: a.dueAt,
        graded: graded.get(a.id) ?? 0,
        inProgress: running.get(a.id) ?? 0,
      })),
    })),
    // **任何狀態都算。** 這個數字是選項結構的鎖：一份還在進行中的作答
    // 也有一份版面快照，動了選項一樣會錯位。
    attempts: attempts.length,
    answered,
    graded: [...graded.values()].reduce((s, n) => s + n, 0),
    inProgress: [...running.values()].reduce((s, n) => s + n, 0),
  };
}

/** 題目內頁要的全部東西。 */
export async function loadQuestionDetail(questionId: string): Promise<QuestionDetail | null> {
  requireTenant();
  const q = await prisma.question.findFirst({
    where: { id: questionId },
    select: {
      id: true,
      familyId: true,
      version: true,
      subjectId: true,
      status: true,
      type: true,
      content: true,
      score: true,
      answerKeys: true,
      answerSlots: true,
      answerText: true,
      scoringRule: true,
      sourceType: true,
      sourceRef: true,
      sourceExam: true,
      licenseScope: true,
      nationalCorrectRate: true,
      createdAt: true,
      updatedAt: true,
      subject: { select: { name: true } },
      group: { select: { id: true, label: true, stimulus: true } },
      options: {
        select: { id: true, order: true, label: true, content: true },
        orderBy: { order: 'asc' },
      },
      knowledgePoints: { select: { knowledgePointId: true } },
      explanations: {
        // `rawBody` 不取。那是匯入的出版社原文，schema 註解寫明只作為
        // AI 改寫的依據——這個畫面編的是老師自己寫的那一份。
        select: {
          id: true,
          origin: true,
          layers: true,
          isPrimary: true,
          takedownAt: true,
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!q) return null;

  const usage = await questionUsage(questionId);
  const mine = q.explanations.find((e) => e.origin === 'TEACHER_WRITTEN' && e.takedownAt === null);

  return {
    id: q.id,
    familyId: q.familyId,
    version: q.version,
    subjectId: q.subjectId,
    subjectName: q.subject.name,
    status: q.status,
    type: q.type,
    content: q.content,
    score: q.score,
    answerKeys: q.answerKeys,
    answerSlots: slotStrings(q.answerSlots),
    answerText: q.answerText,
    scoringRule: q.scoringRule,
    award: readAward(q.scoringRule),
    options: q.options,
    knowledgePointIds: q.knowledgePoints.map((k) => k.knowledgePointId),
    explanation: mine
      ? { id: mine.id, origin: mine.origin, ...readTeacherLayers(mine.layers) }
      : null,
    foreignExplanations: q.explanations.filter((e) => e.id !== mine?.id && e.takedownAt === null)
      .length,
    sourceType: q.sourceType,
    sourceRef: q.sourceRef,
    sourceExam: q.sourceExam,
    licenseScope: q.licenseScope,
    group: q.group,
    nationalCorrectRate: q.nationalCorrectRate,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    usage,
  };
}

/**
 * 這一份任務上，哪幾題被送分了。成績頁靠它畫標記。
 *
 * **沒有這一段的話，送分是看不見的**：那一題的答對率會停在 12%
 * 而平均得分率是 100%，下一個看到這一頁的人只會覺得統計壞掉了。
 */
export async function awardedOnAssignment(assignmentId: string): Promise<Map<string, Award>> {
  const rows = await prisma.question.findMany({
    where: { paperItems: { some: { paper: { assignments: { some: { id: assignmentId } } } } } },
    select: { id: true, scoringRule: true },
  });
  const out = new Map<string, Award>();
  for (const r of rows) {
    const award = readAward(r.scoringRule);
    if (award) out.set(r.id, award);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 改
// ─────────────────────────────────────────────────────────────

export type QuestionPatch = {
  content?: string;
  type?: string;
  score?: number;
  /** 選擇題家族才會送。照畫面順序，每一列帶著它原本是第幾個。 */
  options?: OptionRow[];
  /** 填空／簡答的標準答案。`|` 分隔多個都算對的寫法。 */
  answerText?: string | null;
  /** 選填題的格位答案。 */
  answerSlots?: string[] | null;
  knowledgePointIds?: string[];
  /** 老師自己寫的詳解。`null` 代表刪掉。 */
  explanation?: { conclusion?: string; steps?: string } | null;
};

export type UpdateResult = {
  questionId: string;
  version: number;
  /** 這一次真的改了哪幾個欄位。 */
  changed: string[];
  /** 動到計分依據了嗎。有的話下面那幾份要重算。 */
  gradingChanged: boolean;
  usage: QuestionUsage;
};

/**
 * 改一題。**整批在一個交易裡，稽核也在裡面。**
 *
 * 稽核寫不進去就整筆回滾，是刻意的：一次沒有記錄的標準答案變更，
 * 在家長申訴時等於「沒有人知道為什麼分數變了」。寧可讓老師看到
 * 一個失敗，也不要留下一個查不出來源的改動。
 */
export async function updateQuestion(
  questionId: string,
  patch: QuestionPatch,
  user: SessionUser,
): Promise<UpdateResult> {
  const tenantId = requireTenant();

  const before = await prisma.question.findFirst({
    where: { id: questionId },
    select: {
      id: true,
      subjectId: true,
      version: true,
      type: true,
      content: true,
      score: true,
      answerKeys: true,
      answerSlots: true,
      answerText: true,
      status: true,
      contentAssets: true,
      options: {
        select: { order: true, label: true, content: true, assets: true },
        orderBy: { order: 'asc' },
      },
      knowledgePoints: { select: { knowledgePointId: true } },
    },
  });
  if (!before) throw new QuestionError('找不到這一題。它可能已經被刪除了。', 404);

  const usage = await questionUsage(questionId);
  const data: Prisma.QuestionUncheckedUpdateInput = {};
  const changed = new Set<string>();
  const auditBefore: Record<string, unknown> = {};
  const auditAfter: Record<string, unknown> = {};

  const note = (field: string, from: unknown, to: unknown) => {
    changed.add(field);
    auditBefore[field] = from;
    auditAfter[field] = to;
  };

  // ── 題幹 ────────────────────────────────────────────────────
  if (patch.content !== undefined) {
    const content = patch.content.trim();
    if (!content) throw new QuestionError('題幹不能是空的。');
    if (content.length > 8000) {
      throw new QuestionError('題幹超過 8000 字。閱讀素材請放在題組的前導敘述上，不要塞進題幹。');
    }
    if (content !== before.content) {
      data.content = content;
      note('content', before.content, content);
    }
  }

  // ── 題型 ────────────────────────────────────────────────────
  const type = patch.type ?? before.type;
  if (patch.type !== undefined && patch.type !== before.type) {
    if (!QUESTION_TYPES.includes(patch.type)) {
      throw new QuestionError(`不認得的題型「${patch.type}」`);
    }
    const allowed = checkTypeChange(before.type, patch.type, usage.attempts);
    if (!allowed.ok) throw new QuestionError(allowed.error);
    data.type = patch.type as Prisma.QuestionUncheckedUpdateInput['type'];
    note('type', before.type, patch.type);
  }
  const family = typeFamily(type);

  // ── 配分 ────────────────────────────────────────────────────
  if (patch.score !== undefined) {
    const score = Number(patch.score);
    if (!Number.isFinite(score)) throw new QuestionError('配分要是一個數字');
    if (score < 0) throw new QuestionError('配分不能是負的。');
    if (score > 1000) throw new QuestionError('一題超過 1000 分，這通常是打錯了');
    if (score !== before.score) {
      data.score = score;
      // 題庫的預設配分**不會**改動任何一份已經出過的卷子：那些卷子
      // 存的是自己的 `ExamPaperItem.score`，作答還另外存了快照。
      // 所以這一項不算動到計分依據。
      note('score', before.score, score);
    }
  }

  // ── 選項與標準答案 ──────────────────────────────────────────
  let newOptions: { order: number; label: string; content: string }[] | null = null;
  if (family === 'CHOICE' && patch.options !== undefined) {
    const structure = checkOptionStructure(patch.options, before.options.length, usage.attempts);
    if (!structure.ok) throw new QuestionError(structure.error);

    const shaped = shapeOptions(patch.options);
    if (!shaped.ok) throw new QuestionError(shaped.error);

    // 本來有選項的題目不能被改到只剩一個或零個。清空每一格的文字是
    // 「刪掉這個選項」，一路清完就會得到一題沒有選項的選擇題——計分
    // 時它會變成「選項總數不明」，全班掛在需人工確認，而題目在畫面上
    // 只是看起來少了幾行。要把它變成非選擇題，該做的是改題型。
    if (shaped.options.length < 2 && before.options.length >= 2) {
      throw new QuestionError(
        '選擇題至少要留兩個選項。要把這一題改成填空或申論，請改題型，不要把選項清空。',
      );
    }

    if (!sameOptions(before.options, shaped.options)) {
      newOptions = shaped.options;
      // 稽核只留文字。`assets` 是一整包 bbox 與物件鍵，寫進去會讓
      // 每一次改錯字的稽核列膨脹好幾 KB，而它從來不是「誰改了什麼」
      // 要回答的問題。
      note('options', before.options.map(textOnly), shaped.options);
    }
    if (!sameKeys(before.answerKeys, shaped.answerKeys)) {
      data.answerKeys = shaped.answerKeys;
      note('answerKeys', before.answerKeys, shaped.answerKeys);
    }
  }

  // 換成非選擇題家族時，殘留的選項與答案鍵要清掉。留著的話，題庫頁
  // 與檢討頁會照樣把它們畫出來，而計分早就不看它們了。
  if (family !== 'CHOICE' && before.options.length > 0 && changed.has('type')) {
    newOptions = [];
    note('options', before.options.map(textOnly), []);
    if (before.answerKeys.length) {
      data.answerKeys = [];
      note('answerKeys', before.answerKeys, []);
    }
  }

  if (patch.answerText !== undefined && family !== 'CHOICE') {
    const text = patch.answerText === null ? null : String(patch.answerText).trim() || null;
    if (text !== before.answerText) {
      data.answerText = text;
      note('answerText', before.answerText, text);
    }
  }

  if (patch.answerSlots !== undefined && family === 'SLOT') {
    const slots = (patch.answerSlots ?? []).map((s) => String(s).trim()).filter((s) => s !== '');
    const nextSlots = slots.length ? slots : null;
    if (JSON.stringify(nextSlots) !== JSON.stringify(slotStrings(before.answerSlots))) {
      data.answerSlots =
        nextSlots === null ? Prisma.DbNull : (nextSlots as unknown as Prisma.InputJsonValue);
      note('answerSlots', slotStrings(before.answerSlots), nextSlots);
    }
  }

  // ── 知識點 ──────────────────────────────────────────────────
  let newKps: string[] | null = null;
  if (patch.knowledgePointIds !== undefined) {
    const wanted = [...new Set(patch.knowledgePointIds.filter(Boolean))];
    const now = before.knowledgePoints.map((k) => k.knowledgePointId).sort();
    if (JSON.stringify(wanted.slice().sort()) !== JSON.stringify(now)) {
      // 只收這一科真的存在的知識點。不存在的靜默丟掉會讓老師以為
      // 標好了，而能力分析上那一題永遠不屬於任何章節。
      const known = await prisma.knowledgePoint.findMany({
        where: { id: { in: wanted }, subjectId: before.subjectId },
        select: { id: true },
      });
      if (known.length !== wanted.length) {
        throw new QuestionError('有知識點不屬於這一科，或已經被刪掉了。請重新整理再標一次。');
      }
      newKps = wanted;
      note('knowledgePoints', now, wanted);
    }
  }

  // ── 詳解 ────────────────────────────────────────────────────
  //
  // 先在交易外面算好要做什麼。放進交易裡才決定的話，「只改了詳解」
  // 這一種會在下面那個「沒有任何改動」的早退裡被丟掉——按了儲存、
  // 畫面說已儲存、而詳解一個字都沒有寫進去。
  const explanationPlan = await planExplanation(questionId, patch.explanation);
  if (explanationPlan) {
    note('explanation', explanationPlan.before, explanationPlan.after);
  }

  const gradingChanged = bumpsVersion(changed);
  if (changed.size === 0) {
    return {
      questionId,
      version: before.version,
      changed: [],
      gradingChanged: false,
      usage,
    };
  }
  if (gradingChanged) data.version = before.version + 1;

  await prisma.$transaction(async (tx) => {
    await tx.question.update({ where: { id: questionId }, data });

    if (newOptions !== null) {
      // 先刪再建，不是逐列更新：`UNIQUE (questionId, order)` 不是
      // deferrable，逐列改順序會在中途撞上還沒讓開的那一列
      // （與 `reorderPaperItems` 同一個坑）。整組換掉沒有這個問題。
      //
      // `selectCount`（哪個誘答項最多人選）會歸零。目前沒有任何一段
      // 程式在累積它，而把一個舊統計掛到改過的選項文字上，比沒有統計
      // 更糟——那個數字看起來完全正常。
      await tx.questionOption.deleteMany({ where: { questionId } });
      if (newOptions.length) {
        // **選項的附圖要一起搬過來。** 先刪再建的寫法會連 `assets`
        // 一起刪掉，而編輯畫面根本沒有那一欄——老師只是改了一個錯字，
        // 物理題四個選項的力圖就全部消失了，畫面上完全看不出來。
        //
        // 歸屬照**新的內容**重算（`partitionAssets` 看的是文字裡的
        // `![[a:o1]]`），不是照索引對回去：老師把某一張圖的標記從
        // (A) 剪到 (B) 時，圖要跟著標記走。索引對映在那一種情況下
        // 會把圖留在 (A)，而那正是「看起來對、其實錯」的那一類。
        const media = partitionAssets({ assets: assetPool(before), options: newOptions });
        await tx.questionOption.createMany({
          data: newOptions.map((o, i) => ({
            questionId,
            order: o.order,
            label: o.label,
            content: o.content,
            assets: (media.optionAssets[i]?.assets.length
              ? media.optionAssets[i].assets
              : undefined) as Prisma.InputJsonValue | undefined,
          })),
        });
      }
    }

    if (newKps !== null) {
      await tx.questionKnowledgePoint.deleteMany({ where: { questionId } });
      for (const id of newKps) {
        await tx.questionKnowledgePoint.create({
          data: { questionId, knowledgePointId: id, confirmedBy: user.id },
        });
      }
    }

    if (explanationPlan) await applyExplanation(tx, questionId, tenantId, user, explanationPlan);

    // **稽核在同一個交易裡。** 一次沒有記錄的答案變更，在家長申訴時
    // 等於沒有人知道分數為什麼變了。寧可整筆失敗。
    await tx.auditLog.create({
      data: {
        tenantId,
        category: 'QUESTION',
        action: 'question.update',
        actorId: user.id,
        targetType: 'Question',
        targetId: questionId,
        before: { version: before.version, ...auditBefore } as Prisma.InputJsonValue,
        after: {
          version: gradingChanged ? before.version + 1 : before.version,
          ...auditAfter,
        } as Prisma.InputJsonValue,
        metadata: {
          gradingChanged,
          // 改的當下有多少份成績會因此變得不正確。事後回頭看時，
          // 這個數字說明了那一次改動的規模。
          gradedAttempts: usage.graded,
          affectedAssignments: usage.papers.flatMap((p) =>
            p.assignments.filter((a) => a.graded > 0).map((a) => a.title),
          ),
        } as Prisma.InputJsonValue,
      },
    });
  });

  return {
    questionId,
    version: gradingChanged ? before.version + 1 : before.version,
    changed: [...changed],
    gradingChanged,
    usage,
  };
}

/**
 * 這一題現在手上有哪些附圖，收成一包。
 *
 * 選項的圖與題幹的圖都放進來，是因為同一張圖可以同時被題幹與某個
 * 選項引用（`![[a:fig1]]` 寫在兩處）——只收選項那一份的話，重算歸屬時
 * 那個標記會變成「對不到圖」，而學生會在選項裡看到一行紅字。
 */
function assetPool(before: {
  contentAssets: Prisma.JsonValue | null;
  options: { assets: Prisma.JsonValue | null }[];
}): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  const take = (raw: Prisma.JsonValue | null) => {
    if (!Array.isArray(raw)) return;
    for (const a of raw) {
      if (!a || typeof a !== 'object') continue;
      const id = (a as { id?: unknown }).id;
      if (typeof id === 'string' && id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      out.push(a);
    }
  };
  for (const o of before.options) take(o.assets);
  take(before.contentAssets);
  return out;
}

// ─────────────────────────────────────────────────────────────
// 發布與下架
// ─────────────────────────────────────────────────────────────

export type StatusResult = {
  questionId: string;
  from: string;
  to: string;
  blocking: RetireBlocker[];
  /**
   * 發布放行了，但這一題有幾件事會少一塊（沒標知識點、配分是 0、
   * 沒有解析）。**不擋，但要說**——理由見 `checkPublish` 的說明。
   */
  warnings: PublishIssue[];
};

/**
 * 改題目狀態。
 *
 * `PUBLISHED` 與 `RETIRED` 這兩個值在這個檔案之前**永遠到不了**——
 * 入庫一律 `PENDING_REVIEW`，而沒有任何一行程式改得動它。組卷那邊
 * 因此有一句「這一題已經下架」的錯誤訊息從來不會出現。
 *
 * 三個狀態對應三件真實的事：
 *
 *   PENDING_REVIEW　抽取正確，但還沒有人確認它可以拿去考學生
 *   PUBLISHED　　　 這一題可以用了
 *   RETIRED　　　　 以後不要再用（答案有爭議、超出範圍、版本過期）
 *
 * 下架不會把題目從已經考過的卷子上拿掉，也不影響任何一份成績——
 * 那些是歷史。它擋的是「以後再被組進卷子」。
 */
export async function setQuestionStatus(
  questionId: string,
  to: QuestionStatus,
  user: SessionUser,
  reason?: string,
): Promise<StatusResult> {
  const tenantId = requireTenant();
  const q = await prisma.question.findFirst({
    where: { id: questionId },
    select: {
      id: true,
      status: true,
      content: true,
      // 以下這些只有發布前檢查用得到。多讀一次是划算的：少了它們，
      // 「這一題能不能拿去考學生」就只能靠老師記得去看。
      type: true,
      score: true,
      answerKeys: true,
      answerSlots: true,
      answerText: true,
      contentAssets: true,
      options: {
        select: { order: true, label: true, content: true, assets: true },
        orderBy: { order: 'asc' },
      },
      group: { select: { stimulus: true, stimulusAssets: true } },
      _count: { select: { knowledgePoints: true } },
      explanations: { where: { takedownAt: null }, select: { id: true } },
    },
  });
  if (!q) throw new QuestionError('找不到這一題。', 404);
  if (q.status === to) return { questionId, from: q.status, to, blocking: [], warnings: [] };

  // 發布前檢查。**與下架是對稱的**：兩邊都有前置條件、兩邊都說得出
  // 擋在哪一條。在這之前只有下架有，而發布才是把壞題目送到學生面前的
  // 那一側（見 `checkPublish` 的說明）。
  let warnings: PublishIssue[] = [];
  if (to === 'PUBLISHED') {
    const allowed = checkPublish({
      type: q.type,
      content: q.content,
      score: q.score,
      answerKeys: q.answerKeys,
      // 原樣傳，不先過 `slotStrings`：那一支把物件形狀攤平成陣列，
      // 而 `checkPublish` 要判的是「計分程式會不會覺得這是空的」，
      // 判斷對象必須是資料庫裡真正的那一包。
      answerSlots: q.answerSlots,
      answerText: q.answerText,
      options: q.options,
      assets: q.contentAssets,
      stimulus: q.group?.stimulus ?? null,
      stimulusAssets: q.group?.stimulusAssets ?? null,
      knowledgePointCount: q._count.knowledgePoints,
      explanationCount: q.explanations.length,
    });
    warnings = allowed.warnings;
    if (!allowed.ok) throw new QuestionError(allowed.error!);
  }

  let blocking: RetireBlocker[] = [];
  if (to === 'RETIRED') {
    const usage = await questionUsage(questionId);
    const allowed = checkRetire(
      usage.papers.map((p) => ({
        paperId: p.paperId,
        paperTitle: p.paperTitle,
        paperStatus: p.paperStatus,
        assignments: p.assignments,
      })),
      new Date(),
    );
    blocking = allowed.blocking;
    if (!allowed.ok) throw new QuestionError(allowed.error);
  }

  await prisma.$transaction(async (tx) => {
    await tx.question.update({
      where: { id: questionId },
      data: {
        status: to,
        // `retiredAt` 是「什麼時候不再使用」。復用時要清掉，否則
        // 一題已經回到題庫的題目，記錄上永遠帶著一個下架日期。
        retiredAt: to === 'RETIRED' ? new Date() : null,
      },
    });
    await tx.auditLog.create({
      data: {
        tenantId,
        category: 'QUESTION',
        action: 'question.status',
        actorId: user.id,
        targetType: 'Question',
        targetId: questionId,
        before: { status: q.status },
        after: { status: to },
        metadata: { reason: reason ?? null } as Prisma.InputJsonValue,
      },
    });
  });

  return { questionId, from: q.status, to, blocking, warnings };
}

// ─────────────────────────────────────────────────────────────
// 送分
// ─────────────────────────────────────────────────────────────

export type AwardResult = {
  questionId: string;
  awarded: boolean;
  /** 這一次順手重算的任務。 */
  regraded: { assignmentId: string; attempts: number; changedAttempts: number; failures: number };
  /** 這一題也在這幾份任務上，它們要各自重新計分。 */
  alsoAffects: { assignmentId: string; title: string; graded: number }[];
};

/**
 * 全班送分（或取消）。
 *
 * # 為什麼送分是題目上的旗標，而不是把分數寫進去
 *
 * 因為計分是可以重跑的。把 `earnedScore` 直接改成滿分的話，下一次
 * 任何人按「重新計分」——改了另一題的答案、處理某位學生的個案——
 * 都會照標準答案重算，把送分安靜地蓋掉。老師不會收到任何提示，
 * 幾週後才會發現「我明明送過分了」。
 *
 * 旗標寫在 `Question.scoringRule.awardAll`，`lib/grading.mjs` 每次計分
 * 都重讀，所以重算幾次結果都一樣。**送分不再是一次性的動作，
 * 而是這一題的一個狀態**，畫面上也才看得出來。
 *
 * # 代價：它的範圍是「這一題」，不是「這一份任務的這一題」
 *
 * 一題可能同時在好幾份卷子上（複習卷、補考卷）。送分之後那幾份
 * 也會跟著送——重算過的才會反映出來。這是資料模型的限制，
 * 但方向是安全的：一題錯到要送分的題目，在別的班上也是錯的。
 * 所以回傳 `alsoAffects`，讓畫面把那幾份列出來並給連結。
 *
 * # 為什麼順手重算
 *
 * 因為老師是在成績頁上按下這一顆的，他要的是「這一題的分數修好」。
 * 只寫旗標不重算的話，畫面上什麼都沒變，而他會再按一次。
 */
export async function setAward(
  questionId: string,
  opts: { assignmentId: string; award: boolean; reason: string; user: SessionUser },
): Promise<AwardResult> {
  const tenantId = requireTenant();
  const { assignmentId, award, reason, user } = opts;

  const q = await prisma.question.findFirst({
    where: { id: questionId },
    select: { id: true, subjectId: true, scoringRule: true, subject: { select: { name: true } } },
  });
  if (!q) throw new QuestionError('找不到這一題。', 404);

  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId },
    select: {
      id: true,
      title: true,
      paper: { select: { id: true, subjectId: true, items: { select: { questionId: true } } } },
    },
  });
  if (!assignment) throw new QuestionError('找不到這份任務。', 404);
  if (!assignment.paper.items.some((i) => i.questionId === questionId)) {
    // 任務與題目對不上時**不要照做**：那多半是網址被改過，而照做的
    // 後果是別份卷子上的題目被送分，沒有人會發現。
    throw new QuestionError('這一題不在這份任務的卷子上，不能從這裡送分。', 400);
  }

  // 兩種人可以送分：**改得動這份任務成績的人**（與「全班重新計分」
  // 同一條規則——送分的效力就是全班的分數），以及**這一題的授課老師**
  // （他本來就改得動這一題的標準答案）。合科的模考卷需要前者：
  // 自然卷的老師不是化學老師，但那份成績是他在管。
  const [mayThisAssignment, mayThisQuestion] = await Promise.all([
    mayGrade(user, assignment.paper.subjectId),
    mayGrade(user, q.subjectId),
  ]);
  if (!mayThisAssignment && !mayThisQuestion) {
    throw new QuestionError('只有這一科的授課老師與管理員可以送分。', 403);
  }

  const trimmed = reason.trim();
  if (award && trimmed.length < 4) {
    // 送分會改掉全班的分數，而且它會留在這一題上影響往後每一份考卷。
    // 「為什麼」是事後唯一說得出口的東西。
    throw new QuestionError('請寫下送分的原因，例如「選項 (3) 印錯，全班送分」。');
  }

  const nextRule = withAward(
    q.scoringRule,
    award
      ? {
          at: new Date().toISOString(),
          by: user.id,
          byName: user.displayName,
          reason: trimmed,
          assignmentId: assignment.id,
          assignmentTitle: assignment.title,
        }
      : null,
  );

  await prisma.$transaction(async (tx) => {
    await tx.question.update({
      where: { id: questionId },
      data: {
        scoringRule:
          nextRule === null ? Prisma.DbNull : (nextRule as unknown as Prisma.InputJsonValue),
      },
    });
    await tx.auditLog.create({
      data: {
        tenantId,
        category: 'QUESTION',
        action: award ? 'question.award' : 'question.award_cancel',
        actorId: user.id,
        targetType: 'Question',
        targetId: questionId,
        before: { scoringRule: q.scoringRule ?? null } as Prisma.InputJsonValue,
        after: { scoringRule: (nextRule ?? null) as Prisma.InputJsonValue },
        metadata: {
          reason: trimmed || null,
          assignmentId: assignment.id,
          assignment: assignment.title,
          subject: q.subject.name,
        } as Prisma.InputJsonValue,
      },
    });
  });

  // 重算放在交易外面：它自己會逐份寫入並另外寫一筆 GRADE 稽核，
  // 包進同一個交易的話，一份三十人的班級要在單一交易裡跑上百次更新。
  //
  // 理由裡一定要有題號。成績的稽核是照時間排的，事後看到的是一串
  // 「全班重新計分」，而分辨得出「這一次是為了第 12 題送分」的只有這一句。
  const no = await orderOf(assignment.paper.id, questionId);
  const r = await regradeAssignment(assignmentId, {
    actorId: user.id,
    reason: award ? `第 ${no} 題全班送分：${trimmed}` : `第 ${no} 題取消送分：${trimmed || '（未填原因）'}`,
  });

  const usage = await questionUsage(questionId);
  const alsoAffects = usage.papers
    .flatMap((p) => p.assignments)
    .filter((a) => a.assignmentId !== assignmentId && a.graded > 0)
    .map((a) => ({ assignmentId: a.assignmentId, title: a.title, graded: a.graded }));

  return {
    questionId,
    awarded: award,
    regraded: {
      assignmentId,
      attempts: r.attempts,
      changedAttempts: r.changedAttempts,
      failures: r.failures.length,
    },
    alsoAffects,
  };
}

// ─────────────────────────────────────────────────────────────
// 輔助
// ─────────────────────────────────────────────────────────────

type Tx = Omit<
  typeof prisma,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** schema 的 `QuestionType`。打錯字要在這裡被擋下來，不是在資料庫。 */
const QUESTION_TYPES = [
  'SINGLE_CHOICE',
  'MULTI_CHOICE',
  'FILL_SLOT',
  'FILL_TEXT',
  'SHORT_ANSWER',
  'ESSAY',
  'TRANSLATION',
  'TRUE_FALSE',
];

/** 這一題在那份卷子上是第幾題。稽核與重算理由要說得出題號。 */
async function orderOf(paperId: string, questionId: string): Promise<number | string> {
  const item = await prisma.examPaperItem.findFirst({
    where: { paperId, questionId },
    select: { order: true },
  });
  return item?.order ?? '？';
}

type ExplanationPlan = {
  existingId: string | null;
  /** 空的代表「刪掉這一份」。 */
  conclusion: string;
  steps: string[];
  before: { conclusion: string; steps: string[] } | null;
  after: { conclusion: string; steps: string[] } | null;
};

/**
 * 老師寫的詳解：先算出「要做什麼」，不寫入。
 *
 * 分成 plan 與 apply 兩段，是為了讓「只改了詳解」這一種也算一次改動
 * ——稽核與早退的判斷都在交易外面做完，交易裡只剩寫入。
 *
 * **這一支只碰 `origin = TEACHER_WRITTEN` 的那一份。** 匯入來的
 * （VERBATIM_IMPORT）與 AI 改寫的權利基礎是另一回事，在這個畫面上
 * 改動它們等於竄改別人的著作。
 */
async function planExplanation(
  questionId: string,
  input: { conclusion?: string; steps?: string } | null | undefined,
): Promise<ExplanationPlan | null> {
  if (input === undefined) return null;

  const existing = await prisma.explanation.findFirst({
    where: { questionId, origin: 'TEACHER_WRITTEN' },
    select: { id: true, layers: true },
  });
  const before = existing ? readTeacherLayers(existing.layers) : null;

  const conclusion = (input?.conclusion ?? '').trim();
  const steps = (input?.steps ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const after = !conclusion && steps.length === 0 ? null : { conclusion, steps };

  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  if (before === null && after === null) return null;
  return { existingId: existing?.id ?? null, conclusion, steps, before, after };
}

async function applyExplanation(
  tx: Tx,
  questionId: string,
  tenantId: string,
  user: SessionUser,
  plan: ExplanationPlan,
): Promise<void> {
  if (plan.after === null) {
    // 全部清空 = 刪掉這一份。留一個空的解析列，學生看到的是一個標著
    // 「解析」卻什麼都沒有的區塊，那比誠實地說「還沒有解析」更糟。
    if (plan.existingId) await tx.explanation.delete({ where: { id: plan.existingId } });
    return;
  }

  const layers = {
    conclusion: plan.conclusion || undefined,
    steps: plan.steps,
  } as unknown as Prisma.InputJsonValue;

  // **先把別份的 isPrimary 收掉。** 資料庫有一個 partial unique index
  // （每題最多一份主要解析），而匯入的原文詳解入庫時就是 isPrimary。
  // 不先降級的話，老師第一次寫詳解會撞上唯一鍵，而畫面上顯示的是
  // 一段看不懂的 Prisma 錯誤，題目的其他改動也一起被回滾。
  await tx.explanation.updateMany({
    where: { questionId, isPrimary: true, ...(plan.existingId ? { NOT: { id: plan.existingId } } : {}) },
    data: { isPrimary: false },
  });

  if (plan.existingId) {
    await tx.explanation.update({
      where: { id: plan.existingId },
      data: { layers, declaredBy: user.id, isPrimary: true },
    });
    return;
  }
  await tx.explanation.create({
    data: {
      tenantId,
      questionId,
      origin: 'TEACHER_WRITTEN',
      // 老師自己寫的：權利在機構，不受出版社授權的限制。
      rightsBasis: 'OWNED',
      // 但仍然不外流。散布範圍要人明確決定，預設收在租戶內——
      // 預設公開的那一次不會有任何症狀，直到它已經被散布出去。
      licenseScope: 'TENANT_NO_EXPORT',
      displayMode: 'FULL',
      // 每題最多一份主要解析（資料庫有 partial unique index）。老師寫的
      // 那一份要蓋過匯入的，否則學生看到的還是原稿。
      isPrimary: true,
      layers,
      declaredBy: user.id,
    },
  });
}

/** `Explanation.layers` 讀成編輯畫面要的兩格。 */
function readTeacherLayers(raw: Prisma.JsonValue): { conclusion: string; steps: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { conclusion: '', steps: [] };
  const src = raw as Record<string, unknown>;
  const steps = Array.isArray(src.steps)
    ? src.steps
        .map((s) =>
          typeof s === 'string'
            ? s
            : s && typeof s === 'object' && typeof (s as { content?: unknown }).content === 'string'
              ? String((s as { content: string }).content)
              : '',
        )
        .filter(Boolean)
    : [];
  return { conclusion: typeof src.conclusion === 'string' ? src.conclusion : '', steps };
}

/**
 * `answerSlots` 讀成字串陣列。
 *
 * 這一欄有兩種合法形狀（陣列，或以格位編號為鍵的物件），與計分那邊
 * 的 `slotList` 是同一件事。這裡不 import 它，是因為這一支還要處理
 * 「空的就回 null」——編輯畫面要區分「沒有標準答案」與「答案是空字串」。
 */
function slotStrings(raw: Prisma.JsonValue | null): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    const list = raw.map((v) => (v == null ? '' : String(v)));
    return list.length ? list : null;
  }
  if (typeof raw === 'object') {
    const keys = Object.keys(raw as Record<string, unknown>).sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const list = keys.map((k) => String((raw as Record<string, unknown>)[k] ?? ''));
    return list.length ? list : null;
  }
  return [String(raw)];
}

function sameKeys(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 稽核用的選項形狀：只留文字，不留附圖那一包 bbox 與物件鍵。 */
function textOnly(o: { order: number; label: string; content: string }) {
  return { order: o.order, label: o.label, content: o.content };
}

function sameOptions(
  a: { order: number; label: string; content: string }[],
  b: { order: number; label: string; content: string }[],
): boolean {
  return (
    a.length === b.length &&
    a.every((o, i) => o.order === b[i].order && o.label === b[i].label && o.content === b[i].content)
  );
}

/**
 * 刪掉一題。
 *
 * **不自己發明安全規則——資料庫已經有了。** `ExamPaperItem` 與
 * `AttemptAnswer` 對 Question 都是 `onDelete: Restrict`，所以「已經在
 * 卷子上」或「已經有人作答」的題目，刪除會在資料庫層被擋下來。
 * 這裡先查一次只是為了**給人看得懂的訊息**：外鍵錯誤長成
 * `Foreign key constraint failed on the field: ...`，那句話對科目代表
 * 老師沒有任何意義。
 *
 * 附屬資料（選項、知識點、教科書連結、詳解、rubric、重複題成員）
 * 是 Cascade，跟著走，不必手動清。
 *
 * **不做軟刪除。** `User.deletedAt` 那條路的教訓是：有讀取端、沒有
 * 寫入端，欄位形同虛設而唯一鍵永遠被佔著（見 docs/功能清單.md）。
 * 題目要留痕跡的話用 RETIRED 狀態，那是既有且真的有人讀的機制。
 */
export async function deleteQuestion(questionId: string, user: SessionUser) {
  await requireEditable(questionId, user);

  const [onPapers, answered] = await Promise.all([
    prisma.examPaperItem.count({ where: { questionId } }),
    prisma.attemptAnswer.count({ where: { questionId } }),
  ]);

  if (onPapers > 0 || answered > 0) {
    const why = [
      onPapers > 0 ? `已被 ${onPapers} 份卷子使用` : null,
      answered > 0 ? `已有 ${answered} 筆學生作答` : null,
    ]
      .filter(Boolean)
      .join('、');
    throw new QuestionError(
      `這一題${why}，不能刪除——刪掉會讓那些卷子與成績失去依據。` +
        `要讓它不再被選入新卷子，請改用「下架」（狀態改為 RETIRED），` +
        `既有的卷子與成績不受影響。`,
      409,
    );
  }

  await prisma.question.delete({ where: { id: questionId } });
  return { id: questionId };
}
