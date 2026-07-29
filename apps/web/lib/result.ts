/**
 * 學生的成績與檢討。
 *
 * # 這個檔案與 lib/attempt.ts 剛好相反，所以要看得出來
 *
 * `loadAttemptForStudent` 的整份設計是「正確答案一個位元都不准出去」。
 * 這裡**故意**把正確答案、逐題對錯與解析全部撈出來——訪談時業主講的
 * 第一個痛點就是「交完卷只看到一個分數」，這一頁就是為了修那件事。
 *
 * 兩個方向相反的東西放在同一個檔案裡，遲早會有人在改 A 的時候順手
 * 動到 B。所以它們是兩個檔案，而這一個的檔頭必須把守門的條件寫在最
 * 前面：
 *
 * **一、正確答案只在 `maySeeResult` 說 FULL 的時候才查。**
 * 不是查出來再決定畫不畫——那樣的話一個 SCORE_ONLY 的頁面，
 * 伺服器端仍然把整份答案卡序列化進 HTML，而「檢視原始碼」就看得到。
 * 分界寫在 `loadAttemptResult` 中間那個 `if`，那是整個檔案最重要的三行。
 *
 * **二、每一支進入點都自己比對 `userId`。**
 * RLS 擋得住別家補習班，**擋不住同一間補習班的隔壁同學**——他的
 * attempt 與你的在同一個租戶裡，政策全部通過。老師要看學生的卷子
 * 走 `/grades`，不走這裡：那一邊有科目授課權限的判斷（`mayGrade`），
 * 這一邊沒有，因為這一邊的答案永遠是「只有你自己」。
 *
 * **三、`Explanation.rawBody` 不在任何一個 select 裡。**
 * 那是匯入的出版社原文，schema 註解寫明只作為 AI 改寫的依據。
 * 用白名單挑欄位而不是查出來再刪——黑名單的寫法在資料表多一個欄位
 * 時就會漏，而漏掉的症狀是一段受著作權保護的原文出現在學生畫面上。
 *
 * # 版面以快照為準，不以題庫現在的樣子為準
 *
 * 選項順序、題號、配分全部從 `Attempt.layout` 讀。用題庫現在的順序
 * 重畫的話，開了選項隨機的那份考卷，學生在檢討頁看到的「你選了 (2)」
 * 會指到另一個選項——**他會以為系統把他的答案改掉了**，而畫面上沒有
 * 任何跡象說得出哪一邊是對的。標籤也走 `attempt.ts` 匯出的同一支
 * `orderOptions`，不另外寫一份。
 */
import type { Prisma } from '@prisma/client';

import { AttemptError, orderOptions, readLayout, type TakeOption } from '@/lib/attempt';
import { slotList, splitAlternatives } from '@/lib/grading.mjs';
import { prisma } from '@/lib/prisma';
import { readAward } from '@/lib/questionEdit.mjs';
import {
  maySeeResult,
  pickExplanation,
  type ResultLevel,
  type VisibleExplanation,
} from '@/lib/release.mjs';
import { requireTenant } from '@/lib/tenant';

/** 一題最後落在哪一種狀態。**未作答與答錯是兩件事**，所以分開。 */
export type QuestionVerdict =
  | 'CORRECT' // 全對
  | 'PARTIAL' // 部分給分（多選）
  | 'WRONG' // 答錯，0 分
  | 'BLANK' // 沒有作答。不會就是不會，沒時間就是沒時間，兩者要分得開
  | 'PENDING'; // 非選題等人評，或客觀題資料有問題要人確認

export type ResultOption = TakeOption & {
  /** 這是標準答案之一。 */
  correct: boolean;
  /** 學生選了這一個。 */
  picked: boolean;
};

export type ResultQuestion = {
  order: number;
  questionId: string;
  type: string;
  subLabel: string | null;
  stimulus: string | null;
  stimulusLabel: string | null;
  groupId: string | null;
  content: string;
  /** 這一題在這份卷子上值幾分（快照）。 */
  score: number;
  options: ResultOption[];
  /** 學生填的（選填題的格位、填充與非選的文字）。 */
  myKeys: number[];
  myText: string | null;
  mySlots: { slot: string; value: string }[] | null;
  /** 標準答案。選擇題看 options 的 correct，這兩欄是給非選擇題用的。 */
  correctSlots: string[] | null;
  /** 可接受的寫法。老師用 `|` 列出多個時會有好幾個。 */
  correctTexts: string[] | null;
  verdict: QuestionVerdict;
  earnedScore: number | null;
  /** 為什麼是這個分數。多選部分給分靠它說得出「答錯 1 個，得 3/5」。 */
  scoreNote: string | null;
  explanation: VisibleExplanation | null;
  /**
   * 原稿詳解還沒改寫，不可原文收錄。
   * 這一種要說「還在整理中」，**不可以退而求其次去顯示原文**。
   */
  explanationPending: boolean;
};

export type ResultAttemptChoice = {
  attemptId: string;
  attemptNo: number;
  status: string;
  submittedAt: string | null;
  late: boolean;
  totalScore: number | null;
  /** 這一次現在看得到多少。切換清單上要看得出哪幾次還沒開放。 */
  level: ResultLevel;
};

export type ResultView = {
  assignmentId: string;
  assignmentTitle: string;
  paperTitle: string;
  subjectName: string;
  mode: string;

  attemptId: string;
  attemptNo: number;
  status: string;
  startedAt: string;
  submittedAt: string | null;
  late: boolean;
  autoSubmitted: boolean;

  visibility: { level: ResultLevel; reason: string; availableAt: string | null };

  /** 目前的總分。`null` 代表還沒計分（交卷後的自動計分失敗過）。 */
  totalScore: number | null;
  autoScore: number | null;
  /** 卷面滿分，由快照的配分加總——不是題庫或卷子現在的總分。 */
  maxScore: number;
  gradedAt: string | null;

  /** 逐題。`visibility.level` 不是 FULL 時**一定是空陣列**。 */
  questions: ResultQuestion[];
  /** 逐題統計。同上，只有 FULL 時才有值。 */
  tally: Record<QuestionVerdict, number> | null;
};

// ─────────────────────────────────────────────────────────────────
// 讀自己的作答
// ─────────────────────────────────────────────────────────────────

const notYours = () =>
  new AttemptError('FORBIDDEN', '這不是你的作答。你只看得到自己的成績。', 403);

/**
 * 這位學生在這份任務上的每一次作答，新的在前面。
 *
 * 檢討頁要靠它做兩件事：決定預設打開哪一次，以及在可以作答多次時
 * 列出切換的清單。**作廢的那幾次照樣列出來**——藏起來的話學生會
 * 以為那一次的記錄不見了，而它其實是被作廢的，那是要找老師問的事。
 */
export async function listOwnAttempts(
  assignmentId: string,
  userId: string,
): Promise<ResultAttemptChoice[]> {
  requireTenant();
  const now = new Date();

  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId },
    select: { id: true, releasePolicy: true, dueAt: true, releasedAt: true },
  });
  if (!assignment) return [];

  const rows = await prisma.attempt.findMany({
    // **一定要限定 userId。** 不限的話這裡會帶回全班每個人的作答，
    // 而 RLS 一個都不會擋——他們與你在同一個租戶裡。
    where: { assignmentId, userId },
    select: {
      id: true,
      attemptNo: true,
      status: true,
      submittedAt: true,
      late: true,
      totalScore: true,
    },
    orderBy: { attemptNo: 'desc' },
  });

  return rows.map((a) => ({
    attemptId: a.id,
    attemptNo: a.attemptNo,
    status: a.status,
    submittedAt: a.submittedAt?.toISOString() ?? null,
    late: a.late,
    totalScore: a.totalScore,
    level: maySeeResult(assignment, a, now).level,
  }));
}

/**
 * 一次作答的完整檢討。
 *
 * 順序是刻意的，而且不能換：**先確認是你的 → 再算放行到哪一級 →
 * 最後才決定要不要去查答案**。把查詢提前到判斷之前，等於每一次
 * 開啟都把整份答案卡讀進記憶體，然後靠畫面層記得不要畫出來。
 */
export async function loadAttemptResult(
  attemptId: string,
  userId: string,
): Promise<ResultView> {
  requireTenant();
  const now = new Date();

  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId },
    select: {
      id: true,
      userId: true,
      attemptNo: true,
      status: true,
      startedAt: true,
      submittedAt: true,
      late: true,
      autoSubmitted: true,
      layout: true,
      autoScore: true,
      totalScore: true,
      gradedAt: true,
      assignment: {
        select: {
          id: true,
          title: true,
          mode: true,
          dueAt: true,
          releasePolicy: true,
          releasedAt: true,
          paper: { select: { title: true, subject: { select: { name: true } } } },
        },
      },
    },
  });
  if (!attempt) throw new AttemptError('NOT_FOUND', '找不到這份作答', 404);
  if (attempt.userId !== userId) throw notYours();

  const layout = readLayout(attempt.layout);
  const visibility = maySeeResult(attempt.assignment, attempt, now);

  const base: ResultView = {
    assignmentId: attempt.assignment.id,
    assignmentTitle: attempt.assignment.title,
    paperTitle: attempt.assignment.paper.title,
    subjectName: attempt.assignment.paper.subject.name,
    mode: attempt.assignment.mode,
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
    status: attempt.status,
    startedAt: attempt.startedAt.toISOString(),
    submittedAt: attempt.submittedAt?.toISOString() ?? null,
    late: attempt.late,
    autoSubmitted: attempt.autoSubmitted,
    visibility: {
      level: visibility.level,
      reason: visibility.reason,
      availableAt: visibility.availableAt?.toISOString() ?? null,
    },
    totalScore: attempt.totalScore,
    autoScore: attempt.autoScore,
    maxScore: round2(layout.reduce((s, i) => s + i.score, 0)),
    gradedAt: attempt.gradedAt?.toISOString() ?? null,
    questions: [],
    tally: null,
  };

  // ── 這三行是這個檔案的分界 ──────────────────────────────────
  //
  // FULL 以外的一律到此為止：題目、正確答案、解析三個查詢都不發，
  // 於是它們也不可能出現在回傳值裡。畫面層漏畫一個 `if` 是很平常的
  // 事，但漏查一個查詢不是。
  if (visibility.level !== 'FULL') return base;

  const questionIds = layout.map((i) => i.questionId);

  const [questions, answers, explanations] = await Promise.all([
    prisma.question.findMany({
      where: { id: { in: questionIds } },
      select: {
        id: true,
        type: true,
        content: true,
        subLabel: true,
        groupId: true,
        // 這三欄就是正確答案。**在作答畫面上它們是禁止查詢的**
        // （見 lib/attempt.ts 規則四），在這裡才是這一頁的目的。
        answerKeys: true,
        answerSlots: true,
        answerText: true,
        // 送分的旗標在這一欄裡。**沒有它，被送分而學生剛好空白的
        // 那一題會變成一個對不起來的帳**：總分含了那 5 分（分數以
        // 卷面題目為準算出來，不是以作答記錄），但這一題上寫著
        // 「沒有作答 — / 5 分」，而空白的題目沒有 attempt_answers 列
        // 可以掛 scoreNote。學生自己加總會少 5 分。
        scoringRule: true,
        qualityFlags: true,
        group: { select: { stimulus: true, label: true } },
        options: {
          // selectCount 不取：那是「多少人選過這個選項」，屬於老師的
          // 統計，不是學生的檢討。學生知道「38 個人跟我選一樣的」
          // 沒有教學價值，只有比較。
          select: { order: true, label: true, content: true, assets: true },
          orderBy: { order: 'asc' },
        },
      },
    }),
    prisma.attemptAnswer.findMany({
      where: { attemptId },
      select: {
        questionId: true,
        answerKeys: true,
        answerText: true,
        answerSlots: true,
        isCorrect: true,
        earnedScore: true,
        scoreNote: true,
      },
    }),
    prisma.explanation.findMany({
      // 下架的在這裡就濾掉，`pickExplanation` 裡還會再擋一次。
      // 兩道是刻意的：這一道省的是流量，那一道守的是規則，而規則
      // 那一道有單元測試、這一道沒有。
      where: { questionId: { in: questionIds }, takedownAt: null },
      select: {
        id: true,
        questionId: true,
        isPrimary: true,
        origin: true,
        displayMode: true,
        licenseScope: true,
        takedownAt: true,
        layers: true,
        sourceRef: true,
        modelUsed: true,
        updatedAt: true,
        // rawBody **不在這裡**，而且不可以加進來。見檔頭第三條。
      },
    }),
  ]);

  const byId = new Map(questions.map((q) => [q.id, q]));
  const answerBy = new Map(answers.map((a) => [a.questionId, a]));
  const explainBy = new Map<string, (typeof explanations)[number][]>();
  for (const e of explanations) {
    const bucket = explainBy.get(e.questionId);
    if (bucket) bucket.push(e);
    else explainBy.set(e.questionId, [e]);
  }

  const seenGroups = new Set<string>();
  const out: ResultQuestion[] = [];
  const tally: Record<QuestionVerdict, number> = {
    CORRECT: 0,
    PARTIAL: 0,
    WRONG: 0,
    BLANK: 0,
    PENDING: 0,
  };

  for (const item of layout) {
    const q = byId.get(item.questionId);
    const mine = answerBy.get(item.questionId) ?? null;
    const myKeys = mine?.answerKeys ?? [];
    const myText = mine?.answerText ?? null;
    const mySlots = (mine?.answerSlots as { slot: string; value: string }[] | null) ?? null;

    if (!q) {
      // 題目查不到（版本切換、或版面裡有一筆髒資料）。**不要整頁壞掉**
      // ——一份考卷的檢討因為一題而 500，全班都看不到自己的成績。
      out.push({
        order: item.order,
        questionId: item.questionId,
        type: 'UNAVAILABLE',
        subLabel: null,
        stimulus: null,
        stimulusLabel: null,
        groupId: null,
        content: '（這一題現在讀不出來，請告訴老師）',
        score: item.score,
        options: [],
        myKeys,
        myText,
        mySlots,
        correctSlots: null,
        correctTexts: null,
        verdict: mine?.earnedScore == null ? 'PENDING' : 'WRONG',
        earnedScore: mine?.earnedScore ?? null,
        scoreNote: mine?.scoreNote ?? null,
        explanation: null,
        explanationPending: false,
      });
      tally[out[out.length - 1].verdict]++;
      continue;
    }

    const firstOfGroup = q.groupId != null && !seenGroups.has(q.groupId);
    if (q.groupId) seenGroups.add(q.groupId);

    const correctKeys = new Set(q.answerKeys);
    const options: ResultOption[] = orderOptions(q.options, item.optionOrder).map((o) => ({
      ...o,
      correct: correctKeys.has(o.key),
      picked: myKeys.includes(o.key),
    }));

    const answered = hasAnswer({ answerKeys: myKeys, answerText: myText, answerSlots: mySlots });
    const verdict = judge(mine, answered);
    tally[verdict]++;

    const flags = q.qualityFlags as { explanationPendingRewrite?: unknown } | null;
    const pendingRewrite = flags?.explanationPendingRewrite === true;

    out.push({
      order: item.order,
      questionId: q.id,
      type: q.type,
      subLabel: q.subLabel,
      // 題組的前導敘述只在該題組的第一題帶出來。每一題都帶一次的話，
      // 一篇 500 字的閱讀素材會在頁面裡出現三次。
      stimulus: firstOfGroup ? (q.group?.stimulus ?? null) : null,
      stimulusLabel: firstOfGroup ? (q.group?.label ?? null) : null,
      groupId: q.groupId,
      content: q.content,
      score: item.score,
      options,
      myKeys,
      myText,
      mySlots,
      // 有選項的題目，標準答案在 options 的 correct 上，這兩欄留空——
      // 兩個地方各講一次同一件事，畫面上會出現「答案：(2)」加上一個
      // 已經標好的選項，看起來像其中一個是錯的。
      correctSlots: options.length > 0 ? null : correctSlotList(q.answerSlots),
      correctTexts: options.length > 0 ? null : correctTextList(q.answerText),
      verdict,
      earnedScore: mine?.earnedScore ?? null,
      // 有作答記錄時，計分已經把送分的說明寫進 scoreNote 了
      // （見 lib/grading.mjs）。沒有作答記錄的那一種在這裡補一句——
      // 補的是**畫面上的文字，不是一列作答記錄**：憑空生一列等於在
      // 稽核上宣稱他在交卷之後作答過。
      scoreNote:
        mine?.scoreNote ??
        (readAward(q.scoringRule)
          ? `這一題全班送分：不論作答，一律得 ${item.score} 分，已經算進你的總分。`
          : null),
      // 原稿詳解還沒改寫時，這一題連查都不必查——`commit.ts` 在這種
      // 情況下根本沒有建 Explanation 列，原文留在候選題上。
      explanation: pendingRewrite ? null : pickExplanation(explainBy.get(q.id) ?? []),
      explanationPending: pendingRewrite,
    });
  }

  return { ...base, questions: out, tally };
}

// ─────────────────────────────────────────────────────────────────

/**
 * 這一題落在哪一種狀態。
 *
 * **順序就是規格。** 先問「有沒有寫」再問「對不對」：一題沒作答的
 * 非選題，`earnedScore` 也是 null，但把它說成「等老師評分」會讓學生
 * 以為自己還有分數可以拿。沒寫就是沒寫。
 *
 * 部分給分要與答錯分開，因為它們對學生的意義不同——多選拿到 3/5 的人
 * 知道自己方向對了，被歸進「答錯」的話那個訊息就沒了。
 */
function judge(
  row: { isCorrect: boolean | null; earnedScore: number | null } | null,
  answered: boolean,
): QuestionVerdict {
  if (!answered) return 'BLANK';
  if (!row || row.earnedScore === null) return 'PENDING';
  if (row.isCorrect === true) return 'CORRECT';
  if (row.earnedScore > 0) return 'PARTIAL';
  return 'WRONG';
}

/**
 * 有沒有作答。與 lib/attempt.ts 的 `hasAnswer` 同一條規則：
 * 只按了「標記待複查」不算，那是提醒自己回來看的記號。
 */
function hasAnswer(r: {
  answerKeys: number[];
  answerText: string | null;
  answerSlots: { slot: string; value: string }[] | null;
}): boolean {
  if (r.answerKeys.length > 0) return true;
  if (r.answerText && r.answerText.trim() !== '') return true;
  if (r.answerSlots?.some((s) => String(s?.value ?? '').trim() !== '')) return true;
  return false;
}

/** 選填題的標準答案。用計分那一支的 `slotList`，兩邊的讀法必須一樣。 */
function correctSlotList(raw: Prisma.JsonValue | null): string[] | null {
  const list = slotList(raw).filter((v) => v.trim() !== '');
  return list.length ? list : null;
}

/**
 * 填充題的標準答案。老師用 `|` 列出幾種都算對的寫法，這裡照計分時
 * 的同一條規則切開——`|x|=3` 的直線是答案的一部分，切開會變成
 * 畫面上兩個看不懂的碎片。
 */
function correctTextList(raw: string | null): string[] | null {
  if (!raw || raw.trim() === '') return null;
  const list = splitAlternatives(raw);
  return list.length ? list : null;
}

/** 分數一律兩位小數。浮點加總會印出 78.30000000000001。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
