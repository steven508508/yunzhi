/**
 * 智慧老師：引導式教學的對話。
 *
 * # 這個功能的成敗不在於有沒有一個聊天框
 *
 * 業主的原話是「不只要看解析還要有智慧老師幫助，要盡量透過詢問的
 * 方式了解、引導學生」。而他對現有工具的兩大抱怨之一就是
 * 「AI 功能不好用」——「不好用」的具體樣子，就是那個聊天框問一句
 * 「我不會」它就把整題解一遍。那不是老師，那是一個比較慢的解析，
 * 而解析在這一頁上面就有了。
 *
 * 所以這個檔案裡有一半的程式碼在做同一件事：**不讓答案出去。**
 *
 * # 三層設限，缺一層都會失守
 *
 * **一、提示層**（`apps/ai/pipeline/tutor_prompts.py`）。明確禁止給出
 * 最終答案、禁止一次講完所有步驟、要求以提問結尾。這一層擋得住
 * 「正常情況」，擋不住學生問第三次。
 *
 * **二、後處理層**（`lib/tutorGuard.mjs`）。**這一層才是真正守住的
 * 那一層。** 它看完整段輸出，用確定性的規則判斷有沒有洩漏，命中就
 * 整段丟掉重新生成；重試用完就退回一句安全的引導問句並記 `blocked`。
 * 模型在學生反覆要求時會妥協，所以提示層不夠，一定要有這道閘門。
 *
 * **三、介面層**（`take/[assignmentId]/result/Tutor.tsx`）。對話框裡
 * **沒有「直接看答案」的捷徑**。答案本來就在這一頁上面，學生想看
 * 隨時看得到——但那是他自己捲上去看，不是 AI 講給他聽。這個區別
 * 看起來很細，但它就是「引導」與「代勞」的分界。
 *
 * # 誰可以開對話：這一條寫錯就是洩題
 *
 * **只有在學生看得到這一題的檢討時才能開對話**，判定走
 * `lib/release.mjs` 的 `maySeeResult`，要求 `FULL`。
 *
 * 設成 `ON_DUE` 的考試，先交卷的學生在截止前只看得到分數。這時候
 * 若讓他開對話，他就有一個知道正確答案、而且很想幫他的東西可以問
 * ——**用 AI 把答案問出來**，然後傳給還沒考的同學。這不是理論上的
 * 風險：`maySeeResult` 那一整個檔案存在的理由就是這件事。
 *
 * 另外三道與 `lib/attempt.ts` 同源：
 *   · 每一支進入點自己比對 `userId`（RLS 擋不住同班同學）
 *   · 題目必須在這一份作答的版面快照裡（不能拿別份卷子的題目來問）
 *   · 對話內容裡，`CONTEXT` 角色的訊息不送給學生
 *
 * # 為什麼沒有做串流
 *
 * 因為**閘門要看完整段才判得出洩漏**。邊生成邊顯示，等於把可能洩漏
 * 的內容先放到學生螢幕上，判定完再收回來——而他已經看到了，
 * 截圖也已經按了。這不是可以靠「等一下再顯示」折衷的事：
 * 一段話要到最後一句才知道它有沒有把答案講完。
 *
 * 代價是學生要等一次完整生成（實測 2–5 秒）。介面上用打字中的指示
 * 與樂觀顯示自己的訊息把這段等待撐住。
 */
import type { Prisma } from '@prisma/client';

import { paperCohort } from '@/lib/assignment';
import { AttemptError, orderOptions, readLayout } from '@/lib/attempt';
import { hasAnswer } from '@/lib/examOps.mjs';
import { prisma } from '@/lib/prisma';
import { maySeeResult, pickExplanation, readLayers } from '@/lib/release.mjs';
import { requireTenant } from '@/lib/tenant';
import {
  answerFacts,
  checkStudentMessage,
  checkTutorReply,
  describeViolations,
  DISTRESS_REPLY,
  GHOSTWRITE_REPLY,
  INJECTION_REPLY,
  MODE_LABELS,
  pickMode,
  safeFallback,
  TUTOR_MODES,
} from '@/lib/tutorGuard.mjs';

// ─────────────────────────────────────────────────────────────────
// 錯誤
// ─────────────────────────────────────────────────────────────────

export type TutorErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'NOT_RELEASED'
  | 'BAD_QUESTION'
  | 'CLOSED'
  | 'TOO_MANY'
  | 'BUDGET'
  | 'AI_DOWN';

export class TutorError extends Error {
  readonly code: TutorErrorCode;
  readonly status: number;
  constructor(code: TutorErrorCode, message: string, status = 400) {
    super(message);
    this.name = 'TutorError';
    this.code = code;
    this.status = status;
  }
}

export function tutorFailure(e: unknown): {
  status: number;
  body: { error: string; code?: TutorErrorCode };
} {
  if (e instanceof TutorError) {
    return { status: e.status, body: { error: e.message, code: e.code } };
  }
  if (e instanceof AttemptError) {
    return { status: e.status, body: { error: e.message } };
  }
  console.error('[tutor] 未預期的錯誤', e);
  return {
    status: 500,
    body: { error: '智慧老師出了點問題。你的訊息沒有送出去，稍後再試一次，或直接問老師。' },
  };
}

// ─────────────────────────────────────────────────────────────────
// 對外的形狀
// ─────────────────────────────────────────────────────────────────

export type TutorMode = 'AUTO' | 'SMALL_TIP' | 'STEP_BY_STEP' | 'BASIC_TOPIC';

export type TutorMessageView = {
  id: string;
  /** 只會是 STUDENT 或 TUTOR。**CONTEXT 不出去**，理由見 `visibleMessages`。 */
  role: 'STUDENT' | 'TUTOR';
  content: string;
  createdAt: string;
};

export type TutorSessionView = {
  sessionId: string;
  questionId: string;
  attemptId: string | null;
  status: string;
  stuckAt: string | null;
  resolvedAt: string | null;
  /**
   * 這一段對話有幾則非脈絡訊息（含被擋掉的草稿）。
   *
   * **刻意不回「這一輪用了哪一種模式」。** 模式要看卡點與前置掌握度
   * 才算得出來，而這裡只有 session 那一列——算出來的會與實際送給
   * 模型的那一個不同，而一個會說謊的欄位比沒有那個欄位糟。
   * 介面上那三顆按鈕記的是學生自己按了什麼，不是系統選了什麼。
   */
  messageCount: number;
  messages: TutorMessageView[];
  /** 開場的選項。學生點一下就送出，不必打字（手機上這件事很重要）。 */
  openingChoices: string[];
};

/** 開場的卡點選項。與 `apps/ai/pipeline/tutor_prompts.py` 的 OPENING_CHOICES 同一份。 */
const OPENING_CHOICES = [
  '完全不知道從哪裡開始',
  '看不懂題目在問什麼',
  '算到一半卡住了',
  '我以為我是對的',
  '看了解析還是不懂',
];

/**
 * 開場的第一句話。
 *
 * **不呼叫模型。** 兩個理由：200 位學生各開一次對話就是 200 次呼叫，
 * 換來 200 句一樣的問候；更重要的是，開場就讓模型講話，它會在還不
 * 知道學生卡在哪的時候開始解題。第一句永遠是問他卡在哪——
 * 那正是 `TutorSession.stuckAt` 的用途。
 */
const OPENING_QUESTION =
  '我們一起看這一題。先告訴我：你卡在哪裡？（可以點下面的選項，也可以自己打）';

/** 一段對話的訊息上限。 */
const MAX_MESSAGES = 40;

/** 每一輪最多重新生成幾次。 */
const MAX_REGENERATE = 3;

/** 送給模型的歷史輪數。太長不只貴，還會讓模型忘記系統提示。 */
const HISTORY_TURNS = 12;

// ─────────────────────────────────────────────────────────────────
// 開對話
// ─────────────────────────────────────────────────────────────────

/**
 * 開一段對話，或把既有的那一段拿回來。
 *
 * **綁在 attempt + question 上，不是綁在學生身上**（schema 註解）。
 * 同一位學生對同一題在不同次考試後的對話是分開的兩段——他第二次問
 * 的時候，上一次的理解程度已經不同了。
 *
 * 這一支是冪等的：同一題重複開只會拿到同一段。學生在手機上點兩下、
 * 網路重試、換一個分頁再打開，都不該產生第二段對話（產生了的話，
 * 老師端會看到同一個人對同一題問了五次，而其中四次是空的）。
 *
 * # 已經結束的那一段照樣回，**不在這裡自動重開**
 *
 * 因為「重開」要是免費的、隱含的，那「結束這一段」就等於沒有這個動作
 * ——他按了結束、再點一次入口、又開著了。所以這一支照實回一段
 * `status = CLOSED` 的對話，介面依它顯示結束的樣子並給一顆
 * 「我還想再問」，按下去才走 `reopenTutorSession`。
 *
 * **也不在這裡建第二段。** `TutorSession` 上沒有唯一鍵，多建一段在
 * 資料層是合法的，但老師端的「這一題有幾個人問」會開始把同一個人
 * 數成好幾次，而學生點回來時看不到自己上一輪打的字——他回來多半
 * 正是為了看那幾句。
 */
export async function openTutorSession(input: {
  attemptId: string;
  questionId: string;
  userId: string;
}): Promise<TutorSessionView> {
  const tenantId = requireTenant();
  const gate = await gateForReview(input.attemptId, input.questionId, input.userId);

  const existing = await prisma.tutorSession.findFirst({
    where: {
      attemptId: input.attemptId,
      questionId: input.questionId,
      userId: input.userId,
    },
    orderBy: { createdAt: 'desc' },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (existing) return toView(existing, existing.messages);

  const session = await prisma.tutorSession.create({
    data: {
      tenantId,
      userId: input.userId,
      attemptId: input.attemptId,
      questionId: input.questionId,
      status: 'OPEN',
      kpIds: gate.kpIds,
      messageCount: 1,
    },
  });

  // 開場的兩則。CONTEXT 那一則記的是「這一輪的模型看到了什麼」——
  // 三個月後老師問「它為什麼會這樣講」時，唯一答得出來的東西。
  await prisma.tutorMessage.createMany({
    data: [
      {
        sessionId: session.id,
        role: 'CONTEXT',
        content: contextDigest(gate),
      },
      {
        sessionId: session.id,
        role: 'TUTOR',
        content: OPENING_QUESTION,
        // 開場沒有呼叫模型，所以 modelUsed 是 null 而不是編一個名字。
        promptVersion: 'opening',
      },
    ],
  });

  const messages = await prisma.tutorMessage.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'asc' },
  });
  return toView(session, messages);
}

/**
 * 這位學生現在可以對這一題開對話嗎，以及開了之後要餵什麼脈絡給模型。
 *
 * 判斷的順序不能換：**是不是你的 → 檢討開放了沒 → 這一題在不在
 * 這份卷子上**。放行判斷放在查題目之前，是為了讓一份還沒開放的
 * 考卷連題目與答案都不會被讀進記憶體（與 `lib/result.ts` 的分界
 * 三行同一個道理）。
 */
async function gateForReview(attemptId: string, questionId: string, userId: string) {
  requireTenant();
  const now = new Date();

  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId },
    select: {
      id: true,
      userId: true,
      status: true,
      submittedAt: true,
      layout: true,
      assignment: {
        select: {
          id: true,
          paperId: true,
          dueAt: true,
          releasePolicy: true,
          releasedAt: true,
          paper: { select: { subject: { select: { name: true } } } },
        },
      },
    },
  });
  if (!attempt) throw new TutorError('NOT_FOUND', '找不到這份作答', 404);

  // RLS 擋得住別家補習班，擋不住隔壁同學——他的 attempt 與你的
  // 在同一個租戶裡，政策全部通過。所以這一行一定要自己比。
  if (attempt.userId !== userId) {
    throw new TutorError('FORBIDDEN', '這不是你的作答', 403);
  }

  const visibility = maySeeResult(
    {
      ...attempt.assignment,
      paperCohort: await paperCohort(attempt.assignment.paperId, attempt.assignment.id),
    },
    attempt,
    now,
  );
  if (visibility.level !== 'FULL') {
    // 訊息照抄放行判斷給的那一句。自己另外寫一句的話，學生在檢討頁
    // 看到「8/3 之後開放」而在這裡看到「還沒開放」，他會以為是兩件事。
    throw new TutorError(
      'NOT_RELEASED',
      `這一題的檢討還沒有開放，所以還不能問。${visibility.reason}`,
      403,
    );
  }

  const layout = readLayout(attempt.layout);
  const item = layout.find((i) => i.questionId === questionId);
  if (!item) {
    // 題目不在這份卷子的版面快照裡。網址改一個 id 就想問別份卷子的
    // 題目——而那份卷子可能還沒考。
    throw new TutorError('BAD_QUESTION', '這一題不在這份考卷上', 400);
  }

  const question = await prisma.question.findFirst({
    where: { id: questionId },
    select: {
      id: true,
      type: true,
      content: true,
      answerKeys: true,
      answerSlots: true,
      answerText: true,
      group: { select: { stimulus: true } },
      options: {
        select: { order: true, label: true, content: true, assets: true },
        orderBy: { order: 'asc' },
      },
      knowledgePoints: {
        select: {
          knowledgePoint: { select: { id: true, name: true, description: true } },
        },
      },
    },
  });
  if (!question) throw new TutorError('BAD_QUESTION', '這一題現在讀不出來，請告訴老師', 404);

  const mine = await prisma.attemptAnswer.findFirst({
    where: { attemptId, questionId },
    select: { answerKeys: true, answerText: true, answerSlots: true, isCorrect: true, earnedScore: true },
  });

  // 選項要照學生當時看到的順序與標籤重排，用的是 `lib/attempt.ts`
  // 匯出的同一支 `orderOptions`。另寫一份的話，考試時的 (2) 在這裡
  // 變成 (4)，而閘門會拿錯的代號去比對——**擋的與該擋的不是同一個**。
  const ordered = orderOptions(question.options, item.optionOrder);
  const correctKeys = new Set(question.answerKeys);
  const myKeys = new Set(mine?.answerKeys ?? []);

  const options = ordered.map((o) => ({
    label: o.label,
    content: o.content,
    correct: correctKeys.has(o.key),
    picked: myKeys.has(o.key),
  }));

  const slots = readSlots(question.answerSlots);
  const correctTexts = splitTexts(question.answerText);

  const kpIds = question.knowledgePoints.map((k) => k.knowledgePoint.id);
  const prerequisites = await loadPrerequisites(kpIds, userId);

  return {
    attemptId,
    questionId,
    subject: attempt.assignment.paper.subject.name,
    type: question.type,
    stem: [question.group?.stimulus, question.content].filter(Boolean).join('\n\n'),
    options,
    correctTexts,
    correctSlots: slots,
    myText: describeMine(mine, ordered, myKeys),
    verdict: verdictOf(mine),
    knowledgePoints: question.knowledgePoints.map((k) => ({
      name: k.knowledgePoint.name,
      description: k.knowledgePoint.description,
      mastery: null as number | null,
    })),
    prerequisites,
    kpIds,
    methodBasis: await loadMethodBasis(questionId),
  };
}

type Gate = Awaited<ReturnType<typeof gateForReview>>;

/**
 * 前置知識點，附這位學生的掌握度。
 *
 * `KpPrerequisite` 的 schema 註解說它就是「智慧老師往回補前置觀念時
 * 走的路」，而這一支就是走那條路的地方。沒有它，Basic topics 模式
 * 只能靠模型自己猜這一題的前置是什麼——它會猜出課綱上不存在的東西。
 *
 * 掌握度取自 `AbilitySnapshot`。**沒有快照時是 `null` 而不是 0**：
 * 沒有資料與「掌握度是零」是兩件完全不同的事，而後者會讓每一位
 * 新生的每一題都被判成前置缺失。
 */
async function loadPrerequisites(kpIds: string[], userId: string) {
  if (kpIds.length === 0) return [];

  const links = await prisma.kpPrerequisite.findMany({
    where: { kpId: { in: kpIds } },
    select: {
      strength: true,
      prereq: { select: { id: true, name: true, description: true } },
    },
    orderBy: { strength: 'desc' },
    // 一次補三個前置觀念是補不完的。取最強的幾條就好——脈絡愈長，
    // 模型愈容易忘記系統提示裡那幾條約束。
    take: 5,
  });
  if (links.length === 0) return [];

  const snaps = await prisma.abilitySnapshot.findMany({
    where: { userId, knowledgePointId: { in: links.map((l) => l.prereq.id) } },
    select: { knowledgePointId: true, mastery: true, reliable: true },
  });
  const by = new Map(snaps.map((s) => [s.knowledgePointId, s]));

  return links.map((l) => {
    const s = by.get(l.prereq.id);
    return {
      name: l.prereq.name,
      description: l.prereq.description,
      mastery: s ? s.mastery : null,
      reliable: s ? s.reliable : false,
    };
  });
}

/**
 * 老師自編解析的「方法結構」。
 *
 * 文件 03 §5.3：補習班老師教了很多年，有自己的解題套路與符號慣例。
 * 智慧老師用另一套方法引導，學生會混亂——他上課學的是甲方法，
 * 系統教他乙方法，兩邊都不熟。
 *
 * **注入的是方法而不是答案**：只取 `steps` 那一層的前幾步，
 * 而且不取 `conclusion`（結論那一層講的正是答案）。`rawBody` 更是
 * 從頭到尾不在任何一個 select 裡——那是受著作權保護的原文。
 */
async function loadMethodBasis(questionId: string): Promise<string | null> {
  const rows = await prisma.explanation.findMany({
    where: { questionId, takedownAt: null },
    select: {
      id: true,
      isPrimary: true,
      origin: true,
      displayMode: true,
      licenseScope: true,
      takedownAt: true,
      layers: true,
      sourceRef: true,
      modelUsed: true,
      updatedAt: true,
    },
  });
  const picked = pickExplanation(rows);
  if (!picked) return null;

  const steps = picked.layers.find((l: { key: string }) => l.key === 'steps');
  if (!steps) return null;

  const body = steps.items
    .slice(0, 6)
    .map((it: { lead: string | null; body: string }) => (it.lead ? `${it.lead}. ${it.body}` : it.body))
    .join('\n');
  return body.slice(0, 1200) || null;
}

// ─────────────────────────────────────────────────────────────────
// 送一則訊息
// ─────────────────────────────────────────────────────────────────

export type SendResult = {
  session: TutorSessionView;
  /**
   * 這一輪丟掉了幾則草稿。
   *
   * 名字刻意是「擋掉幾則」而不是「重試幾次」：第一次生成被擋也算
   * 一則，而「重試 0 次但擋掉 1 則」與「重試 1 次」是同一件事的
   * 兩種數法——數錯的那一種會讓稽核時的數字跟資料庫裡的
   * blocked 列數對不起來。
   */
  blockedDrafts: number;
  /** 退回罐頭回應了。 */
  fellBack: boolean;
};

/**
 * 學生說了一句話，智慧老師回一句。
 *
 * 這一支是整個功能的主迴圈，順序是：
 *
 *   1. 權限與狀態
 *   2. 學生訊息過閘門（提示注入擋下來但**仍然存**）
 *   3. 第一則學生訊息寫進 `stuckAt`
 *   4. 預算
 *   5. 決定模式 → 呼叫模型 → 輸出過閘門 → 不過就重來
 *   6. 記用量、記訊息
 */
export async function sendTutorMessage(input: {
  sessionId: string;
  userId: string;
  text: string;
  mode?: TutorMode;
}): Promise<SendResult> {
  const tenantId = requireTenant();
  const session = await loadOwnSession(input.sessionId, input.userId);

  if (session.status !== 'OPEN') {
    // 訊息要說得出「怎麼再開」。原本寫的是「重新開一段」，而系統裡
    // 當時**不存在**那個動作——學生照著做也做不到，只能放棄這一題。
    throw new TutorError(
      'CLOSED',
      '這一段對話已經結束了。點「我還想再問」就可以接著問。',
      409,
    );
  }
  if (session.messageCount >= MAX_MESSAGES) {
    throw new TutorError(
      'TOO_MANY',
      '這一題我們聊得夠久了。剩下的部分直接問老師會比較快——把題號抄下來。',
      429,
    );
  }
  if (!session.attemptId) {
    // attemptId 是 SetNull：那一次作答被刪掉了。沒有作答就沒有辦法
    // 重新確認「這一題的檢討對他開放了嗎」，而那一條不能用猜的。
    throw new TutorError('NOT_FOUND', '這一段對話所屬的作答記錄已經不在了', 404);
  }

  const check = checkStudentMessage(input.text);
  const trimmed = String(input.text ?? '').trim().slice(0, 2000);

  // 被擋下來的訊息**仍然存**（schema 註解：刪掉的話事後查不出
  // 「他問了什麼才觸發的」）。存完之後就地回一句，不呼叫模型。
  //
  // 提示注入與代寫請求走同一條路，因為要做的事完全一樣：留證據、
  // 回一句說得出界線在哪裡的話、**不花錢呼叫模型**。差別只在回哪一句。
  //
  // 代寫請求為什麼一定要在這裡就擋掉：智慧老師是學習歷程代寫的後門
  // ——`app/(app)/portfolio/**` 那條路有六條防代寫規則而且每一次呼叫
  // 都寫 `AiDisclosureLog`，這條路兩樣都沒有。讓模型先寫再由輸出閘門
  // 攔，攔得住的那幾則不會有記錄、攔不住的那一則更不會有——而學生的
  // AI 使用揭露聲明是照記錄產生的，於是它會誠實地說出一句假話。
  if (!check.ok && (check.code === 'INJECTION' || check.code === 'GHOSTWRITE')) {
    const reply = check.code === 'GHOSTWRITE' ? GHOSTWRITE_REPLY : INJECTION_REPLY;
    await prisma.$transaction([
      prisma.tutorMessage.create({
        data: {
          sessionId: session.id,
          role: 'STUDENT',
          content: trimmed,
          blocked: true,
          blockedReason: check.reason,
        },
      }),
      prisma.tutorMessage.create({
        data: { sessionId: session.id, role: 'TUTOR', content: reply, promptVersion: 'guard' },
      }),
      prisma.tutorSession.update({
        where: { id: session.id },
        data: { messageCount: { increment: 2 } },
      }),
    ]);
    return { session: await reload(session.id), blockedDrafts: 0, fellBack: true };
  }
  if (!check.ok) {
    throw new TutorError('BAD_QUESTION', '訊息是空的', 400);
  }

  // 明顯的情緒困擾：存下訊息、回一段關懷的話，**不呼叫模型**。
  // 這種時候不需要一個模型，需要的是一個人。
  if (check.distress) {
    await prisma.$transaction([
      prisma.tutorMessage.create({
        data: { sessionId: session.id, role: 'STUDENT', content: trimmed },
      }),
      prisma.tutorMessage.create({
        data: { sessionId: session.id, role: 'TUTOR', content: DISTRESS_REPLY, promptVersion: 'guard' },
      }),
      prisma.tutorSession.update({
        where: { id: session.id },
        data: { messageCount: { increment: 2 } },
      }),
    ]);
    return { session: await reload(session.id), blockedDrafts: 0, fellBack: true };
  }

  // 放行判斷要**每一輪都重問**，不是只在開對話時問一次。
  // 老師可以在對話進行中把一份 MANUAL 的任務收回去，也可以作廢
  // 這一份作答——那之後這段對話就不該再繼續。
  const gate = await gateForReview(session.attemptId, session.questionId, input.userId);

  const history = await prisma.tutorMessage.findMany({
    where: { sessionId: session.id, blocked: false, role: { in: ['STUDENT', 'TUTOR'] } },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  });

  // 第一則學生訊息就是卡點。**這是引導的起點**，所以它有自己的欄位
  // 而不是「去對話裡找第一則」——找的寫法在學生第一句打「嗯」的時候
  // 會把「嗯」當成卡點。
  const isFirst = session.stuckAt === null;
  const stuckAt = session.stuckAt ?? trimmed;

  const mode = pickMode({
    forced: input.mode,
    stuckAt,
    verdict: gate.verdict,
    prerequisites: gate.prerequisites,
    turn: history.length,
  });

  await assertBudget(tenantId);

  const facts = answerFacts({
    type: gate.type,
    stem: gate.stem,
    options: gate.options,
    correctTexts: gate.correctTexts,
    correctSlots: gate.correctSlots,
    myText: gate.myText,
  });

  const turn = Math.max(1, Math.floor(history.length / 2) + 1);
  const payload = {
    subject: gate.subject,
    question_type: gate.type,
    stem: gate.stem,
    // **選項不帶 correct 旗標。** 正確答案只走 correct_answer_text
    // 一條路，而那一欄在提示詞裡是被框起來、附帶「不可揭露」聲明的。
    options: gate.options.map((o) => ({ label: o.label, content: o.content, picked: o.picked })),
    my_answer_text: gate.myText,
    verdict: gate.verdict,
    knowledge_points: gate.knowledgePoints,
    prerequisites: gate.prerequisites,
    method_basis: gate.methodBasis,
    stuck_at: stuckAt,
    correct_answer_text: correctAnswerText(gate),
    history: [...history, { role: 'STUDENT' as const, content: trimmed }].slice(-HISTORY_TURNS * 2),
    mode,
    turn,
  };

  // ── 先確定 AI 真的答得出來，再把學生的訊息寫進去 ─────────
  //
  // # 為什麼順序是這樣，而不是「先存訊息再呼叫」
  //
  // 先存的版本有一個沒有出口的狀態：訊息已經進資料庫、`messageCount`
  // 也加了 1，然後第一次呼叫就連不上 AI 往上拋 503，而介面那一側顯示
  // 「你的訊息沒有送出去」並把原文放回輸入框。學生自然再按一次——
  // 於是逐字稿裡同一句話出現兩次，`messageCount` 多算一次，
  // 而上限是 40，數到就 429「這一題我們聊得夠久了」。
  //
  // 換句話說：**畫面說的話與資料庫裡的事實不一致，而且是往壞的方向。**
  // 修的方式有兩個，這裡選了第二個：
  //
  // 一、存了之後失敗就回頭刪掉。要多一次寫入、要記得把 `stuckAt`
  //     一起還原，而刪除本身也可能失敗——一條會在失敗路徑上再失敗
  //     一次的路。
  // 二、把第一次呼叫移到寫入之前。失敗時**什麼都還沒發生**，
  //     介面那句話是真的，重送一次也不會留下第二筆。
  //
  // 原本的註解說「模型呼叫失敗時，他打的字不該跟著消失」——那件事
  // 由介面把原文放回輸入框達成（TutorChat.tsx 的 `setDraft(body)`），
  // 不需要靠資料庫留一筆學生看不到、也刪不掉的記錄。
  //
  // 這一行的例外**故意不接**：它往上拋成 503，而那時候資料庫裡
  // 一個字都沒有動過。
  const firstTurn: TurnResponse = await callTutorTurn({ ...payload, retry: 0 });

  await prisma.$transaction([
    prisma.tutorMessage.create({
      data: { sessionId: session.id, role: 'STUDENT', content: trimmed },
    }),
    prisma.tutorSession.update({
      where: { id: session.id },
      data: {
        messageCount: { increment: 1 },
        ...(isFirst ? { stuckAt: trimmed } : {}),
        // 這一段對話涵蓋了哪些知識點。能力分析的「問過但仍不會」
        // 要靠它——沒有寫的話那個統計永遠是空的。
        kpIds: gate.kpIds,
      },
    }),
  ]);

  // ── 生成 → 檢查 → 不過就重來 ────────────────────────────
  let blockedDrafts = 0;
  let accepted: { text: string; model: string; promptVersion: string; latencyMs: number } | null = null;
  let lastReason = '';
  let tokensIn = 0;
  let tokensOut = 0;

  for (let attempt = 0; attempt <= MAX_REGENERATE; attempt += 1) {
    let turnResult: TurnResponse;
    if (attempt === 0) {
      turnResult = firstTurn;
    } else {
      try {
        turnResult = await callTutorTurn({ ...payload, retry: attempt });
      } catch {
        // 重生成的途中上游掛了：拿罐頭回應收尾，不要把學生的訊息
        // 卡在半路。第一次就掛掉的情況在上面處理掉了（那時候還沒有
        // 任何東西寫進資料庫）。
        break;
      }
    }
    tokensIn += turnResult.input_tokens;
    tokensOut += turnResult.output_tokens;

    // **閘門要看得到學生剛剛那一句。** 「那 (3) 對不對」→「對，就是
    // 這樣」這種洩漏，代號在學生那一句裡而不在回覆裡，只看回覆的話
    // 每一條規則都落空（見 tutorGuard.mjs 的 `studentProposedSecret`）。
    const verdict = checkTutorReply(turnResult.text, facts, { studentText: trimmed });
    if (verdict.ok) {
      accepted = {
        text: turnResult.text,
        model: turnResult.model,
        promptVersion: turnResult.prompt_version,
        latencyMs: turnResult.latency_ms,
      };
      break;
    }

    lastReason = describeViolations(verdict.violations);

    // 只剩體例問題（太長、沒問句）而且已經重來過一次，就收下。
    // 為了句子長了 20 個字把一段好的引導丟掉，換來的是學生多等
    // 三秒看一句罐頭——那個交換是虧的。
    //
    // 判斷用 `mustRegenerate` 而不是 `leaked`：**洩漏與代寫都永遠不收**，
    // 而代寫不是洩漏。只看 `leaked` 的話，一段可以貼進學習歷程的
    // 第一人稱敘述會在第二次重試之後被當成體例問題收下——而它唯一的
    // 體例違規正好是「整則沒有問任何問題」。
    if (!verdict.mustRegenerate && attempt >= 1) {
      accepted = {
        text: turnResult.text,
        model: turnResult.model,
        promptVersion: turnResult.prompt_version,
        latencyMs: turnResult.latency_ms,
      };
      break;
    }

    // 被擋下來的草稿要留著。老師端要看得出「模型差一點講了什麼」，
    // 而那正是判斷這個功能有沒有在做事的唯一證據。
    await prisma.tutorMessage.create({
      data: {
        sessionId: session.id,
        role: 'TUTOR',
        content: turnResult.text,
        blocked: true,
        blockedReason: lastReason,
        modelUsed: turnResult.model,
        promptVersion: turnResult.prompt_version,
        latencyMs: turnResult.latency_ms,
      },
    });
    blockedDrafts += 1;
  }

  const fellBack = accepted === null;
  const reply = accepted ?? {
    text: safeFallback(mode, turn, facts),
    model: '',
    promptVersion: 'fallback',
    latencyMs: 0,
  };

  await prisma.$transaction([
    prisma.tutorMessage.create({
      data: {
        sessionId: session.id,
        role: 'TUTOR',
        content: reply.text,
        modelUsed: reply.model || null,
        promptVersion: reply.promptVersion,
        latencyMs: reply.latencyMs || null,
        // 退回罐頭時，那一則本身沒有被擋（它是安全的），
        // 但要在 CONTEXT 裡留下「這一輪走到了退路」。
      },
    }),
    prisma.tutorMessage.create({
      data: {
        sessionId: session.id,
        role: 'CONTEXT',
        content:
          `模式：${MODE_LABELS[mode] ?? mode}（${mode}）` +
          `　擋掉 ${blockedDrafts} 則草稿` +
          (fellBack ? `　退回罐頭回應：${lastReason}` : ''),
      },
    }),
    prisma.tutorSession.update({
      where: { id: session.id },
      data: {
        // 被擋掉的草稿也算：它們是真的產生過的 TutorMessage 列，
        // 而 `messageCount` 的定義是「這一段對話有幾則非脈絡訊息」。
        // 不算的話，老師端看到「12 則」而點開有 18 則，
        // 那個差正好是被擋下來的那幾則——最不該對不起來的那幾則。
        messageCount: { increment: 1 + blockedDrafts },
        tokensIn: { increment: tokensIn },
        tokensOut: { increment: tokensOut },
      },
    }),
  ]);

  await recordUsage({
    tenantId,
    sessionId: session.id,
    tokensIn,
    tokensOut,
    model: reply.model,
    promptVersion: reply.promptVersion,
    latencyMs: reply.latencyMs,
    succeeded: !fellBack,
    errorCode: fellBack ? 'GUARD_FALLBACK' : null,
    retryCount: blockedDrafts,
  });

  return { session: await reload(session.id), blockedDrafts, fellBack };
}

// ─────────────────────────────────────────────────────────────────
// 結束
// ─────────────────────────────────────────────────────────────────

/**
 * 學生按了「我懂了」或「結束這一段」。
 *
 * `resolvedAt` 只在他真的按「我懂了」時寫。schema 註解說得很清楚：
 * **沒有按不代表沒懂，所以不拿它當成效指標的分母。** 這裡照做——
 * 結束對話寫的是 `CLOSED`，不順手補一個 `resolvedAt`。
 *
 * # 這一支只該接到一顆真的寫著「結束」的按鈕上
 *
 * 曾經接在標題列那顆寫著「收起」的按鈕上，於是學生想把對話摺起來
 * 回頭看解析，按下去把這一題的智慧老師永久關掉了——而當時沒有任何
 * 一條路可以重開。**「收起」與「結束這一段」在使用者心裡是兩個不同
 * 的動作**，所以現在是兩顆按鈕：收起只在瀏覽器裡摺疊、不打 API，
 * 結束才走這一支。
 */
export async function closeTutorSession(input: {
  sessionId: string;
  userId: string;
  resolved: boolean;
}): Promise<TutorSessionView> {
  const session = await loadOwnSession(input.sessionId, input.userId);
  await prisma.tutorSession.update({
    where: { id: session.id },
    data: {
      status: 'CLOSED',
      resolvedAt: input.resolved ? (session.resolvedAt ?? new Date()) : session.resolvedAt,
    },
  });
  return reload(session.id);
}

/**
 * 把一段結束掉的對話重新打開。
 *
 * # 為什麼非有這個動作不可
 *
 * 因為在它存在之前，一段對話結束了就是永遠結束了：`openTutorSession`
 * 找既有那一段時完全不看 status，把 `CLOSED` 的原樣回傳，介面判定
 * 已結束，畫面上只剩一句「這一段對話結束了」——沒有輸入框、沒有開場
 * 選項。**整份考卷的每一題都可以這樣一去不回**，而學生會以為是壞了。
 * `sendTutorMessage` 當時回的那句「要再問的話，重新開一段」指的更是
 * 一個不存在的動作。
 *
 * # 為什麼是接回同一段，不是建第二段
 *
 * 資料層兩種都合法（`TutorSession` 上沒有 `@@unique`）。選同一段的
 * 理由是學生點回來時要看得到自己上一輪打的字——他回來多半就是為了
 * 看那幾句；而且老師端「這一題有幾個人問」不會因為有人開開關關就
 * 把同一個人數成五個。代價是逐字稿裡看不出中間斷過，所以這裡補一則
 * `CONTEXT` 把重開這件事記下來。
 *
 * # `resolvedAt` 重開之後不清掉
 *
 * 他確實按過「我懂了」，那是一個發生過的事件，把它抹掉等於改寫記錄。
 * 而 schema 註解已經聲明這個欄位不當成效指標的分母，所以「按過我懂了
 * 又回來問」不會讓任何一個數字說謊。
 *
 * # 放行判斷要重跑
 *
 * 上一次開對話到現在，老師可能已經把這份任務的檢討收回去、或者作廢
 * 了這份作答。不重跑的話，重開是一條繞過 `maySeeResult` 的路——
 * 而那一條規則存在的理由就是洩題。
 */
export async function reopenTutorSession(input: {
  sessionId: string;
  userId: string;
}): Promise<TutorSessionView> {
  const session = await loadOwnSession(input.sessionId, input.userId);

  // 已經開著就直接回。手機上點兩下、或者兩個分頁各按一次，
  // 都不該變成錯誤訊息。
  if (session.status === 'OPEN') return reload(session.id);

  if (session.status === 'HALTED') {
    // HALTED 是觸發安全規則而停止的（schema 註解）。那一種要老師處理，
    // 不能讓學生自己按一顆按鈕就繞過去。
    throw new TutorError(
      'CLOSED',
      '這一段對話因為安全規則停住了，沒有辦法自己重開。請直接問老師。',
      409,
    );
  }
  if (!session.attemptId) {
    throw new TutorError('NOT_FOUND', '這一段對話所屬的作答記錄已經不在了', 404);
  }
  if (session.messageCount >= MAX_MESSAGES) {
    throw new TutorError(
      'TOO_MANY',
      '這一題我們聊得夠久了。剩下的部分直接問老師會比較快——把題號抄下來。',
      429,
    );
  }

  await gateForReview(session.attemptId, session.questionId, input.userId);

  await prisma.$transaction([
    prisma.tutorSession.update({
      where: { id: session.id },
      data: { status: 'OPEN' },
    }),
    prisma.tutorMessage.create({
      data: {
        sessionId: session.id,
        role: 'CONTEXT',
        content: '學生把這一段對話重新打開了（上一次的狀態是 CLOSED）。',
      },
    }),
  ]);
  return reload(session.id);
}

export async function loadTutorSession(sessionId: string, userId: string) {
  await loadOwnSession(sessionId, userId);
  return reload(sessionId);
}

/**
 * 找一段對話並確認它是這個人的。
 *
 * 找不到與不是你的**回同一種錯誤**。分開回的話，換一個 id 就能問出
 * 「這段對話存不存在」，而那是同班同學的對話。
 */
async function loadOwnSession(sessionId: string, userId: string) {
  requireTenant();
  const s = await prisma.tutorSession.findFirst({ where: { id: sessionId } });
  if (!s || s.userId !== userId) {
    throw new TutorError('NOT_FOUND', '找不到這一段對話', 404);
  }
  return s;
}

async function reload(sessionId: string): Promise<TutorSessionView> {
  const s = await prisma.tutorSession.findFirstOrThrow({ where: { id: sessionId } });
  const messages = await prisma.tutorMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  });
  return toView(s, messages);
}

// ─────────────────────────────────────────────────────────────────
// 老師端
// ─────────────────────────────────────────────────────────────────

export type TutorDigestQuestion = {
  questionId: string;
  order: number | null;
  sessions: number;
  students: number;
  blocked: number;
  resolved: number;
};

export type TutorDigestSession = {
  sessionId: string;
  studentName: string;
  username: string;
  questionOrder: number | null;
  stuckAt: string | null;
  status: string;
  resolvedAt: string | null;
  messageCount: number;
  blocked: number;
  createdAt: string;
  /** 逐字對話。CONTEXT 一併帶出來——老師要看得出當時是哪一種模式。 */
  transcript: {
    role: string;
    content: string;
    blocked: boolean;
    blockedReason: string | null;
    createdAt: string;
  }[];
};

export type TutorDigest = {
  total: number;
  students: number;
  blocked: number;
  byQuestion: TutorDigestQuestion[];
  sessions: TutorDigestSession[];
};

/**
 * 一份任務底下所有的智慧老師對話。**唯讀。**
 *
 * # 為什麼老師一定要看得到
 *
 * 這是未成年人在補習班的系統裡與 AI 的互動。不留監督能力，出事時
 * 沒有人說得出發生過什麼；而只留給學生自己看，等於補習班對自己
 * 場域內的 AI 互動沒有任何監督能力。
 *
 * # 為什麼預設看到的是統計而不是逐字稿
 *
 * 因為老師打開這一頁要回答的問題是「哪一題要重講」，不是「誰問了
 * 什麼」。**問的人最多的那一題就是明天要重講的那一題**——那個訊號
 * 比答對率更直接（答對率低可能是題目爛，但特地跑去問 AI 的人多，
 * 代表他們真的想弄懂而弄不懂）。
 *
 * 逐字稿收在每一列後面，要點才展開。規格書文件 01 §12.2 傾向
 * 「老師看摘要不看逐字」，這裡折衷：能力要在，但不要變成預設的
 * 瀏覽方式。
 *
 * **呼叫端一定要先問過 `mayViewGrades`。** 這一支不做權限判斷。
 */
export async function assignmentTutorDigest(assignmentId: string): Promise<TutorDigest> {
  requireTenant();
  const empty: TutorDigest = { total: 0, students: 0, blocked: 0, byQuestion: [], sessions: [] };

  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId },
    select: { paperId: true },
  });
  if (!assignment) return empty;

  // 先只撈 id。這一支在**每一次打開成績頁**時都會跑，而九成的任務
  // 一段對話都沒有——那時候不該為了確認「沒有」而把全班的版面快照
  // （每份都是一整份卷子的 JSON）讀進記憶體。
  const attempts = await prisma.attempt.findMany({
    where: { assignmentId },
    select: { id: true, userId: true },
  });
  if (attempts.length === 0) return empty;

  const sessions = await prisma.tutorSession.findMany({
    where: { attemptId: { in: attempts.map((a) => a.id) } },
    orderBy: { createdAt: 'desc' },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
    // 一份任務的對話量在正常情況下是幾十段。上限是為了擋住
    // 「某一題全班都在問」讓這一頁再也打不開的那一天。
    take: 300,
  });
  if (sessions.length === 0) return empty;

  // 題號取自**卷面**（ExamPaperItem），不是取自某一位學生的版面快照。
  //
  // 開了 `shuffleQuestions` 的任務，每個人看到的題號都不一樣——
  // 拿其中一位的來標，老師唸出「第 3 題」時全班有一半的人翻到別題。
  // 卷面順序是唯一一個對全班都成立的編號。
  const items = assignment.paperId
    ? await prisma.examPaperItem.findMany({
        where: { paperId: assignment.paperId },
        select: { questionId: true, order: true },
      })
    : [];
  const orderOf = new Map<string, number>();
  for (const it of items) if (it.questionId) orderOf.set(it.questionId, it.order);

  const people = await prisma.user.findMany({
    where: { id: { in: [...new Set(sessions.map((s) => s.userId))] } },
    select: { id: true, displayName: true, username: true },
  });
  const whoOf = new Map(people.map((u) => [u.id, u]));

  const byQ = new Map<string, TutorDigestQuestion>();
  const seenStudents = new Set<string>();
  let blockedTotal = 0;

  const out: TutorDigestSession[] = sessions.map((s) => {
    const who = whoOf.get(s.userId) ?? null;
    const blocked = s.messages.filter((m) => m.blocked).length;
    blockedTotal += blocked;
    seenStudents.add(s.userId);

    const q = byQ.get(s.questionId) ?? {
      questionId: s.questionId,
      order: orderOf.get(s.questionId) ?? null,
      sessions: 0,
      students: 0,
      blocked: 0,
      resolved: 0,
    };
    q.sessions += 1;
    q.blocked += blocked;
    if (s.resolvedAt) q.resolved += 1;
    byQ.set(s.questionId, q);

    return {
      sessionId: s.id,
      studentName: who?.displayName ?? '（查不到）',
      username: who?.username ?? '',
      questionOrder: orderOf.get(s.questionId) ?? null,
      stuckAt: s.stuckAt,
      status: s.status,
      resolvedAt: s.resolvedAt?.toISOString() ?? null,
      messageCount: s.messageCount,
      blocked,
      createdAt: s.createdAt.toISOString(),
      transcript: s.messages.map((m) => ({
        role: m.role,
        content: m.content,
        blocked: m.blocked,
        blockedReason: m.blockedReason,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  });

  // 每一題有幾個**不同的人**在問。用段數的話，一個人問了五次
  // 看起來會像五個人不會——而那兩件事要做的處置完全不同。
  const perQuestionStudents = new Map<string, Set<string>>();
  for (const s of sessions) {
    const set = perQuestionStudents.get(s.questionId) ?? new Set<string>();
    set.add(s.userId);
    perQuestionStudents.set(s.questionId, set);
  }
  for (const [qid, q] of byQ) q.students = perQuestionStudents.get(qid)?.size ?? 0;

  return {
    total: sessions.length,
    students: seenStudents.size,
    blocked: blockedTotal,
    byQuestion: [...byQ.values()].sort(
      (a, b) => b.students - a.students || (a.order ?? 999) - (b.order ?? 999),
    ),
    sessions: out,
  };
}

// ─────────────────────────────────────────────────────────────────
// 用量與預算
// ─────────────────────────────────────────────────────────────────

function yearMonth(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 本月的 token 用量。
 *
 * # 為什麼不直接讀 `AiBudgetCounter`
 *
 * 因為那張表在這個 commit 之前**沒有任何一行程式寫過它**，而匯入
 * 管線那條路只寫 `AiUsageLog`。把計數器當成真相的話，一次燒掉半個月
 * 預算的題本匯入完全不會反映在它上面——於是預算「還很多」，
 * 對話照常進行，帳單月底才出現。
 *
 * 所以真相是 `AiUsageLog` 的 `aggregate`（`(tenantId, createdAt)`
 * 上有索引，一次範圍掃描），而計數器是**寫給人看的鏡子**：
 * 每一輪對話之後更新，讓「這個月用了多少」不必掃全表就答得出來。
 */
async function monthlyTokens(tenantId: string): Promise<number> {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  const agg = await prisma.aiUsageLog.aggregate({
    where: { tenantId, createdAt: { gte: since } },
    _sum: { inputTokens: true, outputTokens: true },
  });
  return (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
}

/**
 * 預算用完就不再開新的一輪。
 *
 * **只擋對話，不擋考試、計分與既有解析**（規格書文件 01 §16 的降級
 * 原則，與匯入管線的處理一致）。預算用完不該讓考試停擺。
 *
 * 200 位學生每人跟 AI 聊 20 輪是真的會花錢的——一輪含題目、選項、
 * 前置知識點與對話歷史，輸入大約 1500–3000 token。乘 4000 輪就是
 * 一千萬 token 上下。這個上限不是形式。
 */
async function assertBudget(tenantId: string) {
  const budget = Number(process.env.AI_MONTHLY_TOKEN_BUDGET ?? 0);
  if (!(budget > 0)) return;
  const used = await monthlyTokens(tenantId);
  if (used >= budget) {
    throw new TutorError(
      'BUDGET',
      `這個月的 AI 用量已經到上限（${used.toLocaleString()} / ${budget.toLocaleString()}）。` +
        `智慧老師暫停，但成績、解析與考試都不受影響。想繼續的話，請告訴老師。`,
      429,
    );
  }
}

async function recordUsage(u: {
  tenantId: string;
  sessionId: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  promptVersion: string;
  latencyMs: number;
  succeeded: boolean;
  errorCode: string | null;
  retryCount: number;
}) {
  if (u.tokensIn === 0 && u.tokensOut === 0) return;
  const ym = yearMonth();
  try {
    await prisma.$transaction([
      prisma.aiUsageLog.create({
        data: {
          tenantId: u.tenantId,
          purpose: 'TUTOR',
          // 引導不是推導。用 MID 而不是 HIGH：這一輪要產出的是一句
          // 150 字的提問，而 HIGH 的價格是 MID 的五倍。
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
          refType: 'TutorSession',
          refId: u.sessionId,
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
    // 記帳失敗不該把已經產生的引導吞掉。學生看得到回覆比帳目
    // 完整重要——而帳目的真相在 AiUsageLog，那一筆若也失敗了，
    // 下一次的 aggregate 會少算這一輪，那是可以接受的誤差。
    console.error('[tutor] 用量記錄失敗', e);
  }
}

// ─────────────────────────────────────────────────────────────────
// 與 AI 服務的溝通
// ─────────────────────────────────────────────────────────────────

const AI_URL = (process.env.AI_SERVICE_URL ?? 'http://ai:8000').replace(/\/+$/, '');

/** 一輪引導的逾時。學生在等，所以給得比匯入短得多。 */
const TURN_TIMEOUT_MS = 60_000;

type TurnResponse = {
  text: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  prompt_version: string;
  mode: string;
};

async function callTutorTurn(body: unknown): Promise<TurnResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${AI_URL}/v1/tutor/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    throw new TutorError(
      'AI_DOWN',
      aborted
        ? '智慧老師想太久了。再送一次試試看，或者直接問老師。'
        : '現在連不上智慧老師。解析與答案在這一頁上面還是看得到的。',
      503,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* 回應不是 JSON，用原文的前幾百字 */
    }
    console.error(`[tutor] AI 服務回應 ${res.status}：${detail}`);
    throw new TutorError(
      'AI_DOWN',
      '智慧老師現在沒有辦法回答。這通常是設定或額度的問題，請告訴老師。',
      503,
    );
  }
  return JSON.parse(text) as TurnResponse;
}

// ─────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────

/**
 * 學生看得到的訊息。
 *
 * **`CONTEXT` 不出去，`blocked` 也不出去。** 前者裝的是系統餵給模型
 * 的脈絡（含正確答案），後者是被擋下來的草稿——那一段正是因為
 * 講出了答案才被擋的。用白名單挑而不是把不要的濾掉：
 * 日後多一種角色時，預設是不給看。
 */
function visibleMessages(rows: { id: string; role: string; content: string; blocked: boolean; createdAt: Date }[]) {
  const out: TutorMessageView[] = [];
  for (const m of rows) {
    if (m.blocked) continue;
    if (m.role !== 'STUDENT' && m.role !== 'TUTOR') continue;
    out.push({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    });
  }
  return out;
}

function toView(
  s: {
    id: string;
    questionId: string;
    attemptId: string | null;
    status: string;
    stuckAt: string | null;
    resolvedAt: Date | null;
    messageCount: number;
  },
  messages: { id: string; role: string; content: string; blocked: boolean; createdAt: Date }[],
): TutorSessionView {
  return {
    sessionId: s.id,
    questionId: s.questionId,
    attemptId: s.attemptId,
    status: s.status,
    stuckAt: s.stuckAt,
    resolvedAt: s.resolvedAt?.toISOString() ?? null,
    messageCount: s.messageCount,
    messages: visibleMessages(messages),
    openingChoices: OPENING_CHOICES,
  };
}

/** 開對話時寫進 CONTEXT 的一段摘要。老師端看得到，學生端看不到。 */
function contextDigest(gate: Gate): string {
  const kp = gate.knowledgePoints.map((k) => k.name).join('、') || '（沒有標註知識點）';
  const pre = gate.prerequisites
    .map((p) => `${p.name}${p.mastery === null ? '' : `(${Math.round(p.mastery * 100)}%)`}`)
    .join('、');
  return [
    `題型：${gate.type}`,
    `學生的作答：${gate.myText || '（空白）'}　結果：${gate.verdict}`,
    `知識點：${kp}`,
    pre ? `前置：${pre}` : '',
    gate.methodBasis ? '已注入老師自編解析的方法結構' : '沒有可對齊的老師解析',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 送給模型的正確答案。
 *
 * 模型要知道才引導得動——不知道答案的模型會自己解一次，而它解錯的
 * 那幾題正好是學生也錯的那幾題，於是它會把學生往錯的方向帶。
 * 「AI 把我教錯」比「AI 講太快」嚴重得多。
 *
 * 不可以說出去這件事由提示層聲明、由 `tutorGuard` 執行。
 */
function correctAnswerText(gate: Gate): string {
  if (gate.options.length > 0) {
    const picked = gate.options.filter((o) => o.correct);
    return picked.map((o) => `(${o.label}) ${o.content}`).join('　') || '（題庫裡沒有標答案）';
  }
  if (gate.correctSlots.length > 0) return gate.correctSlots.join('　');
  if (gate.correctTexts.length > 0) return gate.correctTexts.join('　或　');
  return '（這一題由老師依評分標準給分，沒有單一標準答案）';
}

/** 學生填了什麼，折成一行給模型看。 */
function describeMine(
  mine: { answerText: string | null; answerSlots: Prisma.JsonValue } | null,
  ordered: { key: number; label: string; content: string }[],
  myKeys: Set<number>,
): string {
  if (!mine) return '';
  const picked = ordered.filter((o) => myKeys.has(o.key));
  if (picked.length > 0) return picked.map((o) => `(${o.label}) ${o.content}`).join('　');
  const slots = readSlots(mine.answerSlots);
  if (slots.length > 0) return slots.join('　');
  return mine.answerText ?? '';
}

/**
 * 這一題最後落在哪一種結果。
 *
 * **未作答與答錯不可以合併**（與檢討頁的 `QuestionVerdict` 同一個理由）：
 * 一個是不會，一個是沒時間，而智慧老師對這兩種的第一句話完全不同。
 *
 * **部分給分也要分得出來**：他對了一半，那是給一個提示就夠的情況，
 * 而 `pickMode` 靠它選 Small tip。合併成「答錯」的話，一位已經
 * 想對一半的學生會被從頭帶一次。
 */
function verdictOf(
  mine: {
    answerKeys: number[];
    answerText: string | null;
    answerSlots: Prisma.JsonValue;
    isCorrect: boolean | null;
    earnedScore: number | null;
  } | null,
): string {
  if (!mine || !hasAnswer(mine)) return 'BLANK';
  if (mine.isCorrect === true) return 'CORRECT';
  if (mine.isCorrect === false) {
    return (mine.earnedScore ?? 0) > 0 ? 'PARTIAL' : 'WRONG';
  }
  return 'PENDING';
}

function readSlots(raw: Prisma.JsonValue): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const s of raw) {
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      const rec = s as Record<string, unknown>;
      const slot = typeof rec.slot === 'string' ? rec.slot : '';
      const value = typeof rec.value === 'string' ? rec.value : '';
      if (value) out.push(slot ? `${slot} ${value}` : value);
    }
  }
  return out;
}

/** 題庫裡的 `answerText` 用 `|` 列出多種可接受的寫法（見 lib/grading.mjs）。 */
function splitTexts(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

export { TUTOR_MODES, MODE_LABELS };
