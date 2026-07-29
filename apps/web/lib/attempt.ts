/**
 * 學生線上作答。
 *
 * # 這一段的標準與其他地方不一樣
 *
 * 別的地方出錯，最壞是老師要重做一次；**這裡出錯是學生的成績不見了**，
 * 而且發生在他沒有第二次機會的那一次考試裡。所以這個檔案裡每一個
 * 判斷都往「寧可擋下來，也不要靜靜地算錯」的方向倒。
 *
 * 四條貫穿全檔的規則：
 *
 * **一、版面是快照，與題庫分離。**
 * `startAttempt` 把題序、選項順序、配分寫進 `Attempt.layout` 就不再改。
 * 老師在考試進行中改題目（補一個選項、修錯字）是很常見的事，而
 * 沒有快照的話，學生在第 12 題重新整理之後會看到不同的選項順序，
 * 但他前面的答案是照舊的編號存的——**每一個受影響的人都會被判錯，
 * 而且沒有任何跡象**。
 *
 * **二、時間一律以伺服器為準。**
 * `expiresAt` 在開始作答的當下算好寫死，之後每一次判斷都拿
 * `new Date()` 跟它比。前端送來的時間一個都不採信，前端的倒數只是顯示。
 * 不這樣做的話，把系統時間往回調就能無限延長考試。
 *
 * **三、學生只看得到自己的作答。**
 * RLS 擋得住別家補習班，**擋不住同一間補習班的隔壁同學**——他的
 * attempt 跟你的在同一個租戶裡，政策全部通過。所以每一支進入點都
 * 要自己比對 `userId`。這是整個功能最容易漏、漏了最沒有症狀的一條。
 *
 * **四、正確答案不進入網路封包。**
 * `loadAttemptForStudent` 用白名單挑欄位，不是把題目物件丟出去再刪幾個
 * 欄位。黑名單的寫法在題庫多一個欄位時就會漏，而「開發者工具按一下
 * 就看得到答案」這種洩題方式，學生之間傳得比任何作弊手法都快。
 *
 * # 計分的分界
 *
 * 算分的邏輯全部在 `lib/scoring.ts` 與 `lib/grading.mjs`。這裡只負責把
 * 「學生選了什麼」原封不動地存下來——`AttemptAnswer.answerKeys` 是
 * 申訴時唯一能拿出來的東西，重新計分只動 `earnedScore`，永遠不動它。
 *
 * 交卷成功之後這裡會叫一次自動計分（見 `gradeOnSubmit`），
 * 但那是一次「順手做掉」，失敗不影響交卷。
 */
import { randomInt } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import { resolveRecipients } from '@/lib/assignment';
import { attemptWritable, checkFinalizeOnBehalf } from '@/lib/attemptClock.mjs';
import { prisma } from '@/lib/prisma';
import { maySeeResult, type ResultLevel } from '@/lib/release.mjs';
import { gradeAttemptById } from '@/lib/scoring';
import { requireTenant } from '@/lib/tenant';

// ─────────────────────────────────────────────────────────────────
// 錯誤
//
// 用一個帶代碼的錯誤類別，而不是四處丟 `new Error('...')`：
// 路由要把「還沒開放」與「不是你的考卷」對應到不同的 HTTP 狀態，
// 作答頁要在收到 EXPIRED 時停止送出並跳到結束畫面。
// 只靠字串比對的話，改一個字就會靜靜地失效。
// ─────────────────────────────────────────────────────────────────

export type AttemptErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'NOT_OPEN'
  | 'CLOSED'
  | 'NO_ATTEMPTS_LEFT'
  | 'EMPTY_PAPER'
  | 'EXPIRED'
  | 'SUBMITTED'
  | 'VOIDED'
  | 'BAD_QUESTION'
  | 'BAD_ANSWER';

export class AttemptError extends Error {
  readonly code: AttemptErrorCode;
  readonly status: number;

  constructor(code: AttemptErrorCode, message: string, status: number) {
    super(message);
    this.name = 'AttemptError';
    this.code = code;
    this.status = status;
  }
}

const err = {
  notFound: (m = '找不到這份作答') => new AttemptError('NOT_FOUND', m, 404),
  forbidden: (m: string) => new AttemptError('FORBIDDEN', m, 403),
  conflict: (code: AttemptErrorCode, m: string) => new AttemptError(code, m, 409),
  bad: (code: AttemptErrorCode, m: string) => new AttemptError(code, m, 400),
};

/**
 * 把錯誤轉成路由要回的東西。四支路由共用，因為**它們對同一種錯誤
 * 必須回同一個狀態碼**：作答頁靠 `code` 決定要不要停止自動存檔、
 * 要不要跳到已交卷畫面，而各路由各自對應一次，遲早會有一支不一樣。
 *
 * 非 AttemptError 一律 500 且**不把原始訊息吐給前端**——那裡面可能有
 * 資料庫的欄位名與查詢內容。
 */
export function attemptFailure(e: unknown): {
  status: number;
  body: { error: string; code?: AttemptErrorCode };
} {
  if (e instanceof AttemptError) {
    return { status: e.status, body: { error: e.message, code: e.code } };
  }
  console.error('[attempt] 未預期的錯誤', e);
  return { status: 500, body: { error: '系統出了問題，你的作答已經存下來了。請重新整理，或告訴老師。' } };
}

// ─────────────────────────────────────────────────────────────────
// 版面快照
// ─────────────────────────────────────────────────────────────────

/**
 * `Attempt.layout` 裡的一筆。形狀與 schema.prisma 的註解一致，
 * **不要在這裡加欄位**：那一份是給資料庫看的合約，兩邊分歧的時候
 * 讀資料的人會以為自己看懂了。
 */
export type LayoutItem = {
  questionId: string;
  /** 學生看到的題號，1 起算。隨機題序時與題庫的順序無關。 */
  order: number;
  /** 這一題在這份卷子上值幾分。快照，之後老師改配分不影響已開始的人。 */
  score: number;
  /**
   * 選項的顯示順序，內容是**題庫裡的 `QuestionOption.order`**。
   *
   * 存原始編號而不是顯示位置，是因為 `answerKeys` 存的就是原始編號：
   * 學生點第二個選項時前端送回來的是它的原始編號，計分時直接跟
   * 題目的正確答案比對，中間不需要任何轉換——**而每一次轉換都是
   * 一次算錯答案的機會**（見 lib/questionShape.mjs 的同類教訓）。
   */
  optionOrder: number[];
};

/** 選項會被打散的題型。是非題不打散——把「是」與「否」對調只會讓人看錯。 */
const SHUFFLABLE = new Set(['SINGLE_CHOICE', 'MULTI_CHOICE']);

/**
 * Fisher–Yates，亂數來自 `node:crypto`。
 *
 * 不用 `Math.random()`：它在 V8 裡是 xorshift128+，同一個 process 內
 * 的序列是可預測的。**題序與選項順序是防作弊的第一層**（文件 04 的 L1），
 * 可預測的隨機等於沒有隨機。crypto 的成本在這個量級（一份卷子幾十題）
 * 完全不必考慮。
 */
function shuffle<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

type PaperItem = {
  questionId: string;
  order: number;
  score: number;
  question: {
    id: string;
    type: string;
    groupId: string | null;
    options: { order: number }[];
  };
};

/**
 * 產生一份版面。
 *
 * **題組不會被打散。** 題組（`groupId`）是「37–39 題為題組」那種共用
 * 一段閱讀素材的結構，把它們拆開分散到卷子各處，學生要在三個地方
 * 讀同一篇文章，而題號的連續性也不見了。所以隨機的單位是「區塊」：
 * 同一個題組是一個區塊、其餘每一題各自一個區塊，區塊之間打散、
 * 區塊內部維持原順序。
 */
export function buildLayout(
  items: PaperItem[],
  opts: { shuffleQuestions: boolean; shuffleOptions: boolean },
): LayoutItem[] {
  const blocks: PaperItem[][] = [];
  const byGroup = new Map<string, PaperItem[]>();

  for (const it of items) {
    const g = it.question.groupId;
    if (!g) {
      blocks.push([it]);
      continue;
    }
    const seen = byGroup.get(g);
    if (seen) {
      seen.push(it);
    } else {
      const block = [it];
      byGroup.set(g, block);
      blocks.push(block);
    }
  }

  const ordered = opts.shuffleQuestions ? shuffle(blocks) : blocks;

  const layout: LayoutItem[] = [];
  let n = 0;
  for (const block of ordered) {
    for (const it of block) {
      const orders = it.question.options.map((o) => o.order);
      const optionOrder =
        opts.shuffleOptions && SHUFFLABLE.has(it.question.type) && orders.length > 1
          ? shuffle(orders)
          : orders;
      layout.push({
        questionId: it.questionId,
        order: ++n,
        score: it.score,
        optionOrder,
      });
    }
  }
  return layout;
}

/**
 * 把資料庫裡的 JSON 讀回 `LayoutItem[]`，**並且驗過**。
 *
 * 快照壞掉（欄位被改、JSON 存成別的形狀）時要在這裡就停下來。
 * 讓一份殘缺的版面繼續往下走，結果是學生少看到幾題而畫面完全正常。
 */
export function readLayout(raw: Prisma.JsonValue | null): LayoutItem[] {
  if (!Array.isArray(raw)) {
    throw new AttemptError('NOT_FOUND', '這份作答的版面資料不見了，請告訴老師', 500);
  }
  const out: LayoutItem[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.questionId !== 'string' || typeof r.order !== 'number') continue;
    out.push({
      questionId: r.questionId,
      order: r.order,
      score: typeof r.score === 'number' ? r.score : 0,
      optionOrder: Array.isArray(r.optionOrder)
        ? r.optionOrder.filter((x): x is number => typeof x === 'number')
        : [],
    });
  }
  if (out.length === 0) {
    throw new AttemptError('NOT_FOUND', '這份作答沒有任何題目，請告訴老師', 500);
  }
  return out.sort((a, b) => a.order - b.order);
}

// ─────────────────────────────────────────────────────────────────
// 派送對象
// ─────────────────────────────────────────────────────────────────

/**
 * 這位學生收得到這份任務嗎。
 *
 * 名單來自 `@/lib/assignment` 的 `resolveRecipients`——**那是唯一一份
 * 「這份任務派給了誰」**。B3 用它決定誰開得了考卷、B4 用它算應交人數、
 * 催繳用它算誰還沒交。這裡自己再寫一份判定的話，會出現「清單上看得到、
 * 按下去說沒派給你」，而兩邊都覺得自己是對的。
 */
async function mayAttempt(assignmentId: string, userId: string): Promise<boolean> {
  const recipients = await resolveRecipients(assignmentId);
  return recipients.some((r) => r.userId === userId);
}

// ─────────────────────────────────────────────────────────────────
// 開始作答
// ─────────────────────────────────────────────────────────────────

export type StartResult = {
  attemptId: string;
  /** 這是接續原本那一份，不是新開的。前端用它決定要不要顯示「已回到中斷處」。 */
  resumed: boolean;
  attemptNo: number;
};

/**
 * 開始（或接續）一份作答。
 *
 * 順序是刻意的：資格 → 時間窗 → 次數 → 快照 → 寫入。前三項任何一項
 * 不過就不該留下任何痕跡，所以它們全部排在建立資料之前。
 */
export async function startAttempt(
  assignmentId: string,
  userId: string,
): Promise<StartResult> {
  const tenantId = requireTenant();
  const now = new Date();

  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId },
    select: {
      id: true,
      title: true,
      openAt: true,
      dueAt: true,
      timeLimitMin: true,
      allowLate: true,
      maxAttempts: true,
      shuffleQuestions: true,
      shuffleOptions: true,
      paper: {
        select: {
          id: true,
          items: {
            select: {
              questionId: true,
              order: true,
              score: true,
              question: {
                select: {
                  id: true,
                  type: true,
                  groupId: true,
                  options: { select: { order: true }, orderBy: { order: 'asc' } },
                },
              },
            },
            orderBy: { order: 'asc' },
          },
        },
      },
    },
  });
  if (!assignment) throw err.notFound('找不到這份任務');

  // ── 資格 ──
  if (!(await mayAttempt(assignmentId, userId))) {
    throw err.forbidden('這份任務沒有派給你。如果你覺得這是錯的，請告訴班級老師。');
  }

  // ── 時間窗 ──
  if (assignment.openAt && now < assignment.openAt) {
    throw err.conflict('NOT_OPEN', `這份任務要到 ${fmtLocal(assignment.openAt)} 才開放作答`);
  }
  if (assignment.dueAt && now > assignment.dueAt && !assignment.allowLate) {
    throw err.conflict('CLOSED', `這份任務已經在 ${fmtLocal(assignment.dueAt)} 截止了`);
  }

  // ── 已經有一份在進行中 ──
  const existing = await prisma.attempt.findMany({
    where: { assignmentId, userId },
    select: { id: true, attemptNo: true, status: true, expiresAt: true, startedAt: true },
    orderBy: { attemptNo: 'asc' },
  });

  const inProgress = existing.find((a) => a.status === 'IN_PROGRESS');
  if (inProgress) {
    if (!inProgress.expiresAt || inProgress.expiresAt > now) {
      // 續考。**絕不開第二份**——第二份會有自己的版面與自己的答案，
      // 而學生看到的是空白的卷子，前面寫的全部「不見了」（其實還在，
      // 只是掛在另一個 attempt 上，而成績結算時兩份都在）。
      return { attemptId: inProgress.id, resumed: true, attemptNo: inProgress.attemptNo };
    }
    // 過期了卻還掛著 IN_PROGRESS：學生關掉瀏覽器沒交卷、或當機。
    // 伺服器在這裡補收——時間到就是結束了，不能因為沒有人按下按鈕
    // 就永遠停在進行中（那會讓他之後的每一次都被判成「還有一份在寫」）。
    await finalizeAttempt(inProgress.id, { auto: true });
  }

  // ── 次數 ──
  // 作廢（VOIDED）的不算次數：那是誠信事件或系統故障造成的，
  // 讓它佔掉一次機會等於處罰了可能無辜的人。
  const used = existing.filter((a) => a.status !== 'VOIDED').length;
  if (used >= assignment.maxAttempts) {
    throw err.conflict(
      'NO_ATTEMPTS_LEFT',
      assignment.maxAttempts === 1
        ? '這份任務只能作答一次，你已經交過了'
        : `這份任務最多作答 ${assignment.maxAttempts} 次，你已經用完了`,
    );
  }

  const items = assignment.paper.items;
  if (items.length === 0) {
    throw err.conflict('EMPTY_PAPER', '這份考卷還沒有題目，請告訴老師');
  }

  // ── 版面快照 ──
  const layout = buildLayout(items, {
    shuffleQuestions: assignment.shuffleQuestions,
    shuffleOptions: assignment.shuffleOptions,
  });

  // ── 到期時間 ──
  //
  // min(現在 + 時限, 截止時間)。兩個都沒有就是不限時（null）。
  //
  // `dueAt > now` 那個條件是給遲交用的：allowLate 的任務在截止之後
  // 才開始寫時，把已經過去的 dueAt 拿來當上限，會算出一個過去的
  // 到期時間——學生一進去就是「時間已到」，而畫面上完全看不出為什麼。
  const bounds: number[] = [];
  if (assignment.timeLimitMin) {
    bounds.push(now.getTime() + assignment.timeLimitMin * 60_000);
  }
  if (assignment.dueAt && assignment.dueAt > now) {
    bounds.push(assignment.dueAt.getTime());
  }
  const expiresAt = bounds.length ? new Date(Math.min(...bounds)) : null;

  const attemptNo = existing.reduce((m, a) => Math.max(m, a.attemptNo), 0) + 1;

  try {
    const created = await prisma.attempt.create({
      data: {
        assignmentId,
        userId,
        attemptNo,
        status: 'IN_PROGRESS',
        startedAt: now,
        expiresAt,
        layout: layout as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, attemptNo: true },
    });

    await audit(tenantId, userId, 'attempt.start', created.id, {
      assignment: assignment.title,
      attemptNo,
      questions: layout.length,
      expiresAt: expiresAt?.toISOString() ?? null,
    });

    return { attemptId: created.id, resumed: false, attemptNo: created.attemptNo };
  } catch (e) {
    // 兩個分頁同時按下「開始作答」。`@@unique([assignmentId, userId,
    // attemptNo])` 會擋下第二個，而正確的處理是把先建成的那一份給他，
    // 不是回一個錯誤——他只是點了兩下。
    if ((e as { code?: string }).code !== 'P2002') throw e;
    const raced = await prisma.attempt.findFirst({
      where: { assignmentId, userId, status: 'IN_PROGRESS' },
      select: { id: true, attemptNo: true },
      orderBy: { attemptNo: 'desc' },
    });
    if (!raced) throw e;
    return { attemptId: raced.id, resumed: true, attemptNo: raced.attemptNo };
  }
}

// ─────────────────────────────────────────────────────────────────
// 讀取自己的作答
// ─────────────────────────────────────────────────────────────────

type OwnAttempt = {
  id: string;
  userId: string;
  attemptNo: number;
  status: string;
  startedAt: Date;
  expiresAt: Date | null;
  submittedAt: Date | null;
  autoSubmitted: boolean;
  late: boolean;
  layout: Prisma.JsonValue | null;
  assignment: {
    id: string;
    title: string;
    mode: string;
    dueAt: Date | null;
    allowLate: boolean;
    paper: { title: string; instructions: string | null };
  };
};

/**
 * 讀一份作答，**並且確認它是這個人的**。
 *
 * 所有進入點都走這裡。RLS 只保證這份 attempt 屬於同一間補習班；
 * 「屬於這位學生」是應用層的事，而它只要漏一次，任何人改一下網址
 * 就看得到同學的答案卷。
 */
async function loadOwnAttempt(attemptId: string, userId: string): Promise<OwnAttempt> {
  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId },
    select: {
      id: true,
      userId: true,
      attemptNo: true,
      status: true,
      startedAt: true,
      expiresAt: true,
      submittedAt: true,
      autoSubmitted: true,
      late: true,
      layout: true,
      assignment: {
        select: {
          id: true,
          title: true,
          mode: true,
          dueAt: true,
          allowLate: true,
          paper: { select: { title: true, instructions: true } },
        },
      },
    },
  });
  if (!attempt) throw err.notFound();
  if (attempt.userId !== userId) {
    // 訊息刻意與「找不到」不同，因為這一種是要記錄的：正常操作
    // 不會走到這裡。
    throw err.forbidden('這不是你的作答');
  }
  return attempt as OwnAttempt;
}

/** 還剩幾秒。`null` 代表不限時。到期後一律回 0，不回負數。 */
export function remainingSeconds(expiresAt: Date | null, now = new Date()): number | null {
  if (!expiresAt) return null;
  return Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));
}

export type AttemptStatusView = {
  attemptId: string;
  status: string;
  /** 伺服器算的剩餘秒數。**倒數要以它為準，不要相信瀏覽器的時鐘。** */
  remainingSeconds: number | null;
  serverNow: string;
  expiresAt: string | null;
  submittedAt: string | null;
  late: boolean;
  autoSubmitted: boolean;
  answered: number;
  total: number;
};

/**
 * 目前狀態。**給倒數校時用，所以刻意很輕**——它每半分鐘會被呼叫一次，
 * 而三百個人同時考試就是每秒十次。不查題目、不查答案內容。
 *
 * 為什麼倒數要校時而不是前端自己減一秒：分頁切到背景時瀏覽器會
 * 節流計時器（可能慢到一分鐘才跳一次），手機鎖屏時更久。純前端的
 * 倒數在學生切出去看一下 LINE 再回來時，會顯示還剩十分鐘而其實已經
 * 結束了。這裡回的是伺服器算的秒數，前端只是在兩次校時之間插值。
 */
export async function getAttemptStatus(
  attemptId: string,
  userId: string,
): Promise<AttemptStatusView> {
  const attempt = await loadOwnAttempt(attemptId, userId);
  const now = new Date();
  return {
    attemptId: attempt.id,
    status: attempt.status,
    remainingSeconds: remainingSeconds(attempt.expiresAt, now),
    serverNow: now.toISOString(),
    expiresAt: attempt.expiresAt?.toISOString() ?? null,
    submittedAt: attempt.submittedAt?.toISOString() ?? null,
    late: attempt.late,
    autoSubmitted: attempt.autoSubmitted,
    answered: await countAnswered(attempt.id),
    total: countLayout(attempt.layout),
  };
}

// ─────────────────────────────────────────────────────────────────
// 儲存單題
// ─────────────────────────────────────────────────────────────────

export type AnswerPayload = {
  /** 選了哪幾個選項。內容是題庫裡的 `QuestionOption.order`。 */
  answerKeys?: number[];
  answerText?: string | null;
  answerSlots?: { slot: string; value: string }[] | null;
  /** 標記待複查（作答介面的「先跳過」）。 */
  flagged?: boolean;
};

export type SaveResult = {
  questionId: string;
  remainingSeconds: number | null;
};

/**
 * 儲存一題的答案。
 *
 * 三件事是這一支的規格：
 *
 * **可以重複送。** 自動存檔、離開頁面時的 sendBeacon、按下交卷前的
 * 最後一次 flush，同一題會被送好幾次。所以它是 upsert 且冪等——
 * 同一份內容送兩次的結果與送一次完全相同。
 *
 * **過期就不收。** 比對的是資料庫裡的 `expiresAt` 與伺服器的現在，
 * 前端送什麼時間都不看。而且順手把那份逾時的作答收掉（見下面的
 * finalizeAttempt），否則它會一直掛在「進行中」。
 *
 * **交卷之後不收。** 這一條沒有例外，包括 sendBeacon 那種遲到的封包。
 */
export async function saveAnswer(
  attemptId: string,
  questionId: string,
  payload: AnswerPayload,
  // userId 是必填而不是選填：**做成選填就一定會有人忘記傳**，
  // 而忘記的症狀是任何人都能改別人的答案。
  userId: string,
): Promise<SaveResult> {
  const attempt = await loadOwnAttempt(attemptId, userId);
  const now = new Date();

  if (attempt.status !== 'IN_PROGRESS') {
    throw err.conflict('SUBMITTED', '這份考卷已經交出去了，不能再修改答案');
  }
  // 「還收不收得到」的判斷在 lib/attemptClock.mjs。老師那邊的「代為結算」
  // 問的是同一件事的反面，兩邊共用一份實作，邊界那一秒才不會各說各話。
  if (!attemptWritable(attempt, now)) {
    await finalizeAttempt(attempt.id, { auto: true });
    throw err.conflict('EXPIRED', '作答時間已經結束，這一題沒有存進去');
  }

  const layout = readLayout(attempt.layout);
  const item = layout.find((i) => i.questionId === questionId);
  if (!item) {
    // 版面裡沒有的題目一律拒收。少了這一道，前端（或改過的前端）
    // 可以對任何一題寫入答案，包括不在這份卷子上的題目——結算時
    // 那些答案會跟著出現，而沒有人知道它們是怎麼進來的。
    throw err.bad('BAD_QUESTION', '這一題不在你的考卷上');
  }

  const data: Prisma.AttemptAnswerUncheckedUpdateInput = {};

  if (payload.answerKeys !== undefined) {
    const allowed = new Set(item.optionOrder);
    const keys = [...new Set(payload.answerKeys)].filter((k) => Number.isInteger(k));
    // 選項編號必須真的是這一題的選項。非選擇題（optionOrder 是空的）
    // 送來任何編號都是錯的。
    for (const k of keys) {
      if (!allowed.has(k)) throw err.bad('BAD_ANSWER', '選項編號不是這一題的選項');
    }
    data.answerKeys = keys.sort((a, b) => a - b);
  }
  if (payload.answerText !== undefined) {
    data.answerText = payload.answerText;
  }
  if (payload.answerSlots !== undefined && payload.answerSlots !== null) {
    data.answerSlots = payload.answerSlots as unknown as Prisma.InputJsonValue;
  }
  if (payload.flagged !== undefined) {
    data.flagged = payload.flagged;
  }

  // 計分欄（isCorrect / earnedScore / scoreNote）在這裡一個都不碰。
  // 那是 B4 的事，而且重新計分時也只動那幾欄——學生選了什麼永遠不變。
  await prisma.attemptAnswer.upsert({
    where: { attemptId_questionId: { attemptId, questionId } },
    create: {
      attemptId,
      questionId,
      answerKeys: (data.answerKeys as number[] | undefined) ?? [],
      answerText: (data.answerText as string | null | undefined) ?? null,
      answerSlots: data.answerSlots as Prisma.InputJsonValue | undefined,
      flagged: (data.flagged as boolean | undefined) ?? false,
    },
    update: data,
  });

  return { questionId, remainingSeconds: remainingSeconds(attempt.expiresAt, now) };
}

// ─────────────────────────────────────────────────────────────────
// 交卷
// ─────────────────────────────────────────────────────────────────

export type SubmitResult = {
  attemptId: string;
  status: string;
  submittedAt: string | null;
  autoSubmitted: boolean;
  late: boolean;
  /** 有作答的題數（含只按了標記但沒寫答案的？不含——見 countAnswered）。 */
  answered: number;
  total: number;
  /** 這一次呼叫之前就已經交過了。重複呼叫時是 true，但不是錯誤。 */
  alreadySubmitted: boolean;
};

/**
 * 交卷。
 *
 * **冪等。** 學生連點兩下、離線重試、時間到的自動交卷與他自己按下的
 * 交卷同時發生——這些都會讓它被呼叫兩次以上，而第二次必須回傳
 * 與第一次相同的結果，不是一個錯誤。錯誤畫面會讓學生以為沒交成功，
 * 然後在考場裡舉手。
 */
export async function submitAttempt(
  attemptId: string,
  opts: { auto?: boolean; userId: string },
): Promise<SubmitResult> {
  const attempt = await loadOwnAttempt(attemptId, opts.userId);
  if (attempt.status === 'VOIDED') {
    throw err.conflict('VOIDED', '這份作答已經被作廢，請找老師處理');
  }
  return finalizeAttempt(attempt.id, { auto: opts.auto ?? false });
}

/**
 * 老師代替學生把一份卡住的作答收掉。
 *
 * # 為什麼非有這一支不可
 *
 * 見 `lib/attemptClock.mjs` 的檔頭：時間到了卻沒有人按下交卷的那一份
 * 會永遠掛在 `IN_PROGRESS`。學生那邊已經沒有任何按鈕（次數用完了），
 * 老師那邊連這個人都看不到（成績頁只查 SUBMITTED / GRADED）。
 * 於是他寫過的答案留在資料庫裡，而沒有任何一條路徑走得到它。
 *
 * **不做身分檢查**——與 `finalizeAttempt` 一樣，那是呼叫端的事
 * （路由會問這位老師教不教這一科）。這裡只確認「這一份現在可以收」，
 * 而那個判斷是純函式，見 `checkFinalizeOnBehalf`。
 *
 * `actorId` 一定要傳。稽核上寫成學生自己交的話，記錄就是假的——
 * 而成績異動的稽核之所以存在，正是為了回答「這一份是誰、什麼時候
 * 動的」。
 */
export async function finalizeAttemptOnBehalf(
  attemptId: string,
  actorId: string,
): Promise<SubmitResult> {
  requireTenant();
  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId },
    select: { id: true, status: true, expiresAt: true },
  });
  if (!attempt) throw err.notFound('找不到這一份作答');

  const allowed = checkFinalizeOnBehalf(attempt);
  if (!allowed.ok) throw err.conflict('SUBMITTED', allowed.error);

  return finalizeAttempt(attempt.id, { auto: true, actorId });
}

/**
 * 真正結算的那一段。**不做身分檢查**（呼叫端已經做過），因為它也被
 * 伺服器自己呼叫——逾時的作答不會有人來按按鈕，得由伺服器收。
 *
 * `actorId` 只有老師代為結算時才會給。給了就寫進稽核，因為那一筆
 * 「交卷」不是學生做的。
 */
async function finalizeAttempt(
  attemptId: string,
  opts: { auto: boolean; actorId?: string },
): Promise<SubmitResult> {
  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId },
    select: {
      id: true,
      userId: true,
      status: true,
      startedAt: true,
      expiresAt: true,
      submittedAt: true,
      autoSubmitted: true,
      late: true,
      layout: true,
      assignment: { select: { title: true, dueAt: true, allowLate: true, tenantId: true } },
    },
  });
  if (!attempt) throw err.notFound();

  const total = countLayout(attempt.layout);

  if (attempt.status !== 'IN_PROGRESS') {
    return {
      attemptId: attempt.id,
      status: attempt.status,
      submittedAt: attempt.submittedAt?.toISOString() ?? null,
      autoSubmitted: attempt.autoSubmitted,
      late: attempt.late,
      answered: await countAnswered(attempt.id),
      total,
      alreadySubmitted: true,
    };
  }

  const now = new Date();
  const expired = attempt.expiresAt != null && now > attempt.expiresAt;
  const dueAt = attempt.assignment.dueAt;

  let submittedAt = now;
  let autoSubmitted = opts.auto;

  if (expired) {
    // 逾時的一律記成自動交卷，不管是誰按的按鈕——這一份的結束時間
    // 是由時間決定的，不是由人決定的。
    autoSubmitted = true;
    if (!attempt.assignment.allowLate) {
      // **交卷時間回填到期時刻。** 過了 expiresAt 之後 saveAnswer 一題
      // 都不收，所以這份卷子實質上就是在那一刻結束的；記成「現在」
      // 反而會讓成績單上出現一個沒有任何作答發生的空白區間，
      // 也會讓遲交統計把一個沒有遲交的人算成遲交。
      submittedAt = attempt.expiresAt!;
    }
  }

  // 遲交只看截止日。沒有截止日就不存在遲交。
  const late = dueAt != null && submittedAt > dueAt;

  // 資料庫的 CHECK（attempts_time_ordered）要求 submittedAt >= startedAt。
  // 回填時刻理論上不會早於開始時刻，但時鐘調整過的機器會——
  // 在這裡夾住，而不是讓一次交卷因為資料庫約束而整個失敗。
  if (submittedAt < attempt.startedAt) submittedAt = attempt.startedAt;

  // updateMany + status 條件 = 一次原子的 compare-and-set。
  // 兩個請求同時交卷時只有一個會真的寫入，另一個的 count 是 0，
  // 而它讀回來的仍然是同一份結果。
  const done = await prisma.attempt.updateMany({
    where: { id: attempt.id, status: 'IN_PROGRESS' },
    data: { status: 'SUBMITTED', submittedAt, autoSubmitted, late },
  });

  const fresh = await prisma.attempt.findFirst({
    where: { id: attempt.id },
    select: { status: true, submittedAt: true, autoSubmitted: true, late: true },
  });
  const answered = await countAnswered(attempt.id);

  if (done.count > 0) {
    // 稽核的行為人是「真的做了這件事的人」。老師代為結算時記成學生
    // 自己交的話，日後查「這一份為什麼在他不在場的時候交出去」會查
    // 不到任何東西——而那正是會被家長問到的那一種問題。
    await audit(
      attempt.assignment.tenantId,
      opts.actorId ?? attempt.userId,
      'attempt.submit',
      attempt.id,
      {
        assignment: attempt.assignment.title,
        autoSubmitted,
        late,
        answered,
        total,
        ...(opts.actorId ? { onBehalfOf: attempt.userId } : {}),
      },
    );

    await gradeOnSubmit(attempt.id);
  }

  return {
    attemptId: attempt.id,
    status: fresh?.status ?? 'SUBMITTED',
    submittedAt: fresh?.submittedAt?.toISOString() ?? submittedAt.toISOString(),
    autoSubmitted: fresh?.autoSubmitted ?? autoSubmitted,
    late: fresh?.late ?? late,
    answered,
    total,
    alreadySubmitted: done.count === 0,
  };
}

/**
 * 交卷之後立刻自動計分。
 *
 * # 為什麼包在 try 裡
 *
 * **交卷成功與計分成功是兩件事，而前者絕對不能被後者拖下水。**
 * 學生按下交卷、伺服器已經把狀態寫成 SUBMITTED、稽核也記了，
 * 這時計分若因為任何原因失敗（卷子被刪、題目資料有洞、資料庫瞬斷），
 * 讓整個請求回 500 的結果是：學生看到錯誤畫面，以為沒交成功，
 * 於是重按——而第二次會走到 `alreadySubmitted` 分支、看起來又正常了。
 * 他會不知道自己到底交了沒有。
 *
 * 所以這裡吞掉錯誤，只留一行日誌。沒算到分的那一份會留在 SUBMITTED，
 * 而成績頁的第一欄就是「還沒計分的份數」——老師看得到、按一下
 * 「重新計分」就補上了。**沒算到分是看得見的，交卷失敗不是。**
 *
 * # 為什麼只在真的轉換狀態時呼叫
 *
 * 呼叫端只在 `done.count > 0`（compare-and-set 真的寫進去）時進來。
 * 冪等的重複交卷不會重算：重算本身無害（`gradeAttemptById` 只碰計分
 * 欄位，不動作答內容），但那會讓老師剛剛手動調過的分數在學生重整
 * 頁面時被自動計分覆蓋回去。
 */
async function gradeOnSubmit(attemptId: string): Promise<void> {
  try {
    await gradeAttemptById(attemptId, { reason: '交卷自動計分', audit: false });
  } catch (e) {
    console.error('[attempt] 交卷後自動計分失敗，這一份留在待計分', attemptId, e);
  }
}

/**
 * 有作答的題數。
 *
 * 「有作答」是指真的寫了東西：選了選項、打了字、填了格位。
 * 只按了「標記待複查」不算——那是一個提醒自己回來看的記號，
 * 把它算成已作答會讓學生以為自己寫完了。
 */
async function countAnswered(attemptId: string): Promise<number> {
  const rows = await prisma.attemptAnswer.findMany({
    where: { attemptId },
    select: { answerKeys: true, answerText: true, answerSlots: true },
  });
  return rows.filter((r) => hasAnswer(r)).length;
}

function hasAnswer(r: {
  answerKeys: number[];
  answerText: string | null;
  answerSlots: Prisma.JsonValue | null;
}): boolean {
  if (r.answerKeys.length > 0) return true;
  if (r.answerText && r.answerText.trim() !== '') return true;
  if (Array.isArray(r.answerSlots)) {
    return r.answerSlots.some(
      (s) =>
        s != null &&
        typeof s === 'object' &&
        !Array.isArray(s) &&
        String((s as Record<string, unknown>).value ?? '').trim() !== '',
    );
  }
  return false;
}

function countLayout(raw: Prisma.JsonValue | null): number {
  return Array.isArray(raw) ? raw.length : 0;
}

// ─────────────────────────────────────────────────────────────────
// 組出作答畫面
// ─────────────────────────────────────────────────────────────────

export type TakeOption = {
  /** 送回伺服器的編號（題庫裡的原始 order）。學生看不到這個數字。 */
  key: number;
  /** 學生看到的標籤。隨機選項時是「位置」的標籤，不是原本那一個。 */
  label: string;
  content: string;
  assets: Prisma.JsonValue | null;
};

export type TakeQuestion = {
  order: number;
  questionId: string;
  type: string;
  score: number;
  content: string;
  contentAssets: Prisma.JsonValue | null;
  subLabel: string | null;
  /** 題組的前導敘述。同一個題組的第一題才帶，後面的題目共用。 */
  stimulus: string | null;
  stimulusLabel: string | null;
  groupId: string | null;
  options: TakeOption[];
  /** 選填題的格位標籤。**只有標籤，沒有答案。** */
  slots: { slot: string }[] | null;
  answerKeys: number[];
  answerText: string | null;
  answerSlots: { slot: string; value: string }[] | null;
  flagged: boolean;
};

export type TakeView = {
  attemptId: string;
  assignmentId: string;
  assignmentTitle: string;
  paperTitle: string;
  instructions: string | null;
  mode: string;
  attemptNo: number;
  status: string;
  startedAt: string;
  expiresAt: string | null;
  /** 伺服器算的剩餘秒數。**前端的倒數要以它校時。** */
  remainingSeconds: number | null;
  /** 伺服器的現在。前端拿來對照自己的時鐘偏移。 */
  serverNow: string;
  submittedAt: string | null;
  late: boolean;
  autoSubmitted: boolean;
  questions: TakeQuestion[];
  totalScore: number;
};

/**
 * 把一份作答組成前端要的樣子。
 *
 * **這一支是「不可以洩題」那條規則的所在地。** 題目的 `answerKeys`、
 * `answerText`、`answerSlots`（裡面有答案）、`scoringRule` 全部不查、
 * 不帶、不回傳。下面的 select 是白名單——新增欄位時預設不會外流，
 * 要外流得有人主動加一行，而那一行看得出來。
 */
export async function loadAttemptForStudent(
  attemptId: string,
  userId: string,
): Promise<TakeView> {
  const attempt = await loadOwnAttempt(attemptId, userId);
  const layout = readLayout(attempt.layout);
  const now = new Date();

  const questions = await prisma.question.findMany({
    where: { id: { in: layout.map((i) => i.questionId) } },
    select: {
      id: true,
      type: true,
      content: true,
      contentAssets: true,
      subLabel: true,
      groupId: true,
      // 選填題要知道有幾個格位、每個格位叫什麼，才畫得出答案欄。
      // 值在下面被 slotShape() 丟掉。
      answerSlots: true,
      group: { select: { id: true, stimulus: true, stimulusAssets: true, label: true } },
      options: {
        // selectCount（有多少人選過這個選項）刻意不取：它是統計欄位，
        // 但在作答當下它是一個提示——熱門選項往往就是答案。
        select: { order: true, label: true, content: true, assets: true },
        orderBy: { order: 'asc' },
      },
    },
  });
  const byId = new Map(questions.map((q) => [q.id, q]));

  const answers = await prisma.attemptAnswer.findMany({
    where: { attemptId },
    select: {
      questionId: true,
      answerKeys: true,
      answerText: true,
      answerSlots: true,
      flagged: true,
    },
  });
  const answerBy = new Map(answers.map((a) => [a.questionId, a]));

  const seenGroups = new Set<string>();
  const out: TakeQuestion[] = [];

  for (const item of layout) {
    const q = byId.get(item.questionId);
    const mine = answerBy.get(item.questionId);
    const answered = {
      answerKeys: mine?.answerKeys ?? [],
      answerText: mine?.answerText ?? null,
      answerSlots: (mine?.answerSlots as { slot: string; value: string }[] | null) ?? null,
      flagged: mine?.flagged ?? false,
    };

    if (!q) {
      // 題目查不到（被刪了、或版面裡有一筆髒資料）。**不要整頁壞掉**——
      // 一份考試進行到一半因為一題而 500，全班都在等。把這一題畫成
      // 一個說得出話的佔位，其餘的照常寫。
      out.push({
        order: item.order,
        questionId: item.questionId,
        type: 'UNAVAILABLE',
        score: item.score,
        content: '（這一題暫時無法顯示，請舉手告訴監考老師）',
        contentAssets: null,
        subLabel: null,
        stimulus: null,
        stimulusLabel: null,
        groupId: null,
        options: [],
        slots: null,
        ...answered,
      });
      continue;
    }

    // 題組的前導敘述只在該題組的第一題帶出來。每一題都帶一次的話，
    // 一篇 500 字的閱讀素材會在封包裡出現三次，而學生的手機在
    // 熱點網路下要多等那幾百 KB。
    const firstOfGroup = q.groupId != null && !seenGroups.has(q.groupId);
    if (q.groupId) seenGroups.add(q.groupId);

    out.push({
      order: item.order,
      questionId: q.id,
      type: q.type,
      score: item.score,
      content: q.content,
      contentAssets: q.contentAssets,
      subLabel: q.subLabel,
      stimulus: firstOfGroup ? (q.group?.stimulus ?? null) : null,
      stimulusLabel: firstOfGroup ? (q.group?.label ?? null) : null,
      groupId: q.groupId,
      options: orderOptions(q.options, item.optionOrder),
      // 有選項的題目不會有格位。舊資料裡偶爾兩者都有（匯入時多存了
      // 一份），而那會讓作答畫面在選擇題底下多畫一排空格。
      slots: q.options.length > 0 ? null : slotShape(q.answerSlots),
      ...answered,
    });
  }

  return {
    attemptId: attempt.id,
    assignmentId: attempt.assignment.id,
    assignmentTitle: attempt.assignment.title,
    paperTitle: attempt.assignment.paper.title,
    instructions: attempt.assignment.paper.instructions,
    mode: attempt.assignment.mode,
    attemptNo: attempt.attemptNo,
    status: attempt.status,
    startedAt: attempt.startedAt.toISOString(),
    expiresAt: attempt.expiresAt?.toISOString() ?? null,
    remainingSeconds: remainingSeconds(attempt.expiresAt, now),
    serverNow: now.toISOString(),
    submittedAt: attempt.submittedAt?.toISOString() ?? null,
    late: attempt.late,
    autoSubmitted: attempt.autoSubmitted,
    questions: out,
    totalScore: layout.reduce((s, i) => s + i.score, 0),
  };
}

/**
 * 依快照的順序排選項，並重新給標籤。
 *
 * 標籤是**位置**的標籤：打散之後第一個顯示的選項就叫 (1)，不管它
 * 原本是第幾個。用原本的標籤會讓學生看到「(3)(1)(4)(2)」，那看起來
 * 像壞掉；而標籤取自這一題自己的標籤序列（可能是 1234 也可能是
 * ABCD），不是硬寫死的一組。
 *
 * 代價：題幹如果寫著「選項 (A) 的敘述…」，打散之後那個指涉就錯了。
 * 這是老師打開 shuffleOptions 時要承擔的事，而不是這裡能修的——
 * 系統無法可靠地判斷題幹有沒有指涉選項。
 *
 * **匯出是給檢討頁用的**（見 lib/result.ts）。檢討頁要照學生當時看到的
 * 順序與標籤重畫一次選項，而那必須是**同一支函式**算出來的：各寫一份
 * 的話，考試時的 (2) 在檢討頁變成 (4)，學生會以為系統把他的答案改掉了，
 * 而畫面上沒有任何跡象說得出哪一邊是對的。
 */
export function orderOptions(
  options: { order: number; label: string; content: string; assets: Prisma.JsonValue }[],
  optionOrder: number[],
): TakeOption[] {
  if (options.length === 0) return [];
  const byOrder = new Map(options.map((o) => [o.order, o]));
  const labels = options.map((o) => o.label);

  const sequence = optionOrder.length ? optionOrder : options.map((o) => o.order);
  const out: TakeOption[] = [];
  for (const key of sequence) {
    const o = byOrder.get(key);
    // 快照裡有、題庫裡沒有（老師刪了一個選項）。跳過而不是塞一個
    // 空選項——空白選項會被學生選中，而它不對應任何東西。
    if (!o) continue;
    out.push({
      key: o.order,
      label: labels[out.length] ?? o.label,
      content: o.content,
      assets: o.assets,
    });
  }
  return out;
}

/**
 * 選填題的格位，**只留標籤**。
 *
 * 題庫裡的 `answerSlots` 長成 `[{ slot: '①', value: '3' }]`——`value`
 * 就是答案。作答畫面需要知道有幾格、每格叫什麼，但那個 `value`
 * 一旦跟著出去，開發者工具按一下就是整份答案卡。
 *
 * 所以這裡逐格重建，而不是把陣列 delete 幾個欄位後傳出去：
 * 重建的寫法在資料多一個欄位時仍然是安全的。
 */
function slotShape(raw: Prisma.JsonValue | null): { slot: string }[] | null {
  if (!Array.isArray(raw)) return null;
  const out: { slot: string }[] = [];
  for (const [i, s] of raw.entries()) {
    if (s == null || typeof s !== 'object' || Array.isArray(s)) continue;
    const slot = (s as Record<string, unknown>).slot;
    out.push({ slot: typeof slot === 'string' ? slot : String(i + 1) });
  }
  return out.length ? out : null;
}

// ─────────────────────────────────────────────────────────────────
// 學生的任務清單
// ─────────────────────────────────────────────────────────────────

export type TaskState =
  | 'IN_PROGRESS' // 寫到一半
  | 'OPEN' // 可以開始
  | 'UPCOMING' // 還沒開放
  | 'DONE' // 交完了（或次數用完）
  | 'MISSED'; // 過了截止而且沒交

export type StudentTask = {
  assignmentId: string;
  title: string;
  paperTitle: string;
  subjectName: string;
  mode: string;
  openAt: string | null;
  dueAt: string | null;
  timeLimitMin: number | null;
  allowLate: boolean;
  maxAttempts: number;
  questionCount: number;
  state: TaskState;
  attemptsUsed: number;
  /** 進行中那一份的 id 與剩餘秒數。沒有就是 null。 */
  openAttemptId: string | null;
  openRemainingSeconds: number | null;
  lastSubmittedAt: string | null;
  lastLate: boolean;

  // ── 成績 ──
  //
  // 這幾欄講的一律是**最近一次交出去的那份作答**（與 `lastSubmittedAt`
  // 同一份）。沒有交過就全部是 null / false。
  //
  // 它們在這裡算好，而不是讓清單頁逐筆去問——一頁三十份任務就是
  // 三十次查詢，而那三十次每一次都要再讀一次同一個 assignment。

  /** 最近一次交卷的得分。`null` 代表還沒計分（交卷後的自動計分失敗過）。 */
  score: number | null;
  /** 卷面滿分。沒有交過任何一次就是 null。 */
  maxScore: number | null;
  /** 檢討頁現在給看到什麼程度。交卷之前一律是 NONE。 */
  resultLevel: ResultLevel;
  /** 點得進檢討頁而且看得到東西（分數或全部）。 */
  resultVisible: boolean;
  /**
   * 為什麼看得到／看不到，以及什麼時候看得到。
   * 沒有交過任何一次時是空字串——那時候不該提成績這件事。
   */
  resultNote: string;
};

/**
 * 這位學生的所有任務。
 *
 * **TODO：與 `resolveRecipients` 一樣，之後併進 `@/lib/assignment.ts`。**
 * 這裡是它的反方向（給定學生找任務），兩邊的口徑必須一樣，否則會
 * 出現「清單上看得到但按下去說沒派給你」。
 */
export async function listStudentTasks(userId: string): Promise<StudentTask[]> {
  requireTenant();
  const now = new Date();

  // 與 `resolveRecipients` 對齊：它只認 `systemRole = STUDENT` 且沒有被
  // 軟刪除的帳號。這裡不跟著擋的話，被個別指定的老師會在清單上看到
  // 一份任務、按下去卻被告知「沒有派給你」——**兩份判定不一致的
  // 症狀就長這樣**，而且看起來像是權限壞了。
  const me = await prisma.user.findFirst({
    where: { id: userId, systemRole: 'STUDENT', deletedAt: null },
    select: { id: true },
  });
  if (!me) return [];

  const memberships = await prisma.classMembership.findMany({
    where: { userId, leftAt: null, role: 'STUDENT' },
    select: { classId: true },
  });
  const classIds = memberships.map((m) => m.classId);

  const rows = await prisma.assignment.findMany({
    where: {
      targets: {
        some: {
          OR: [{ userId }, ...(classIds.length ? [{ classId: { in: classIds } }] : [])],
        },
      },
    },
    select: {
      id: true,
      title: true,
      mode: true,
      openAt: true,
      dueAt: true,
      timeLimitMin: true,
      allowLate: true,
      maxAttempts: true,
      // 放行時機要跟著查出來，成績那幾欄才算得出來。多這兩欄不多一次
      // 查詢，而少了它們就得逐份任務再問一次——那就是 N+1。
      releasePolicy: true,
      releasedAt: true,
      paper: {
        select: {
          title: true,
          // 卷面總分。用它當滿分是安全的：`requireEditablePaper` 在
          // 有人開始作答之後就不讓改卷子了，所以它與每一份 attempt 的
          // 版面快照加總必定一致。逐份去讀 layout JSON 才算滿分的話，
          // 這一頁會為了一個不會變的數字拉回幾百 KB 的快照。
          totalScore: true,
          subject: { select: { name: true } },
          _count: { select: { items: true } },
        },
      },
      // **一定要限定 userId。** 不限的話這裡會帶回全班每個人的作答
      // 狀態，而那是「誰交了誰沒交」——那是老師的資訊，不是同學的。
      attempts: {
        where: { userId },
        select: {
          id: true,
          status: true,
          expiresAt: true,
          submittedAt: true,
          late: true,
          totalScore: true,
        },
        orderBy: { attemptNo: 'asc' },
      },
    },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
  });

  return rows.map((a) => {
    const attempts = a.attempts;
    const open = attempts.find(
      (t) => t.status === 'IN_PROGRESS' && (!t.expiresAt || t.expiresAt > now),
    );
    const used = attempts.filter((t) => t.status !== 'VOIDED').length;
    const submitted = attempts.filter((t) => t.submittedAt != null);
    const last = submitted[submitted.length - 1];

    let state: TaskState;
    if (open) state = 'IN_PROGRESS';
    else if (used >= a.maxAttempts) state = 'DONE';
    else if (a.openAt && now < a.openAt) state = 'UPCOMING';
    else if (a.dueAt && now > a.dueAt && !a.allowLate) {
      state = submitted.length > 0 ? 'DONE' : 'MISSED';
    } else state = 'OPEN';

    // 成績講的是最近一次**交出去**的那一份，不是最後開的那一份——
    // 後者可能是一份剛開始寫、還沒交的，而清單上顯示它的分數（null）
    // 會讓上禮拜考完的成績看起來不見了。
    const visible = last ? maySeeResult(a, last, now) : null;

    return {
      assignmentId: a.id,
      title: a.title,
      paperTitle: a.paper.title,
      subjectName: a.paper.subject.name,
      mode: a.mode,
      openAt: a.openAt?.toISOString() ?? null,
      dueAt: a.dueAt?.toISOString() ?? null,
      timeLimitMin: a.timeLimitMin,
      allowLate: a.allowLate,
      maxAttempts: a.maxAttempts,
      questionCount: a.paper._count.items,
      state,
      attemptsUsed: used,
      openAttemptId: open?.id ?? null,
      openRemainingSeconds: open ? remainingSeconds(open.expiresAt ?? null, now) : null,
      lastSubmittedAt: last?.submittedAt?.toISOString() ?? null,
      lastLate: last?.late ?? false,
      // 分數只在放行到 SCORE_ONLY 以上時才出現。這一頁是清單，
      // 但它與檢討頁受同一條規則管——只在清單上藏起來、
      // 詳細頁卻看得到（或反過來）是最難察覺的一種不一致。
      score: visible && visible.level !== 'NONE' ? (last?.totalScore ?? null) : null,
      maxScore: last ? a.paper.totalScore : null,
      resultLevel: visible?.level ?? 'NONE',
      resultVisible: visible != null && visible.level !== 'NONE',
      resultNote: visible?.reason ?? '',
    };
  });
}

/**
 * 一份任務對這位學生現在的狀態，**但不開始作答**。
 *
 * 作答頁一進來要先知道「能不能開始、還有幾次、有沒有寫到一半的」，
 * 而那不能靠呼叫 `startAttempt` 去試——那會真的開一份，重新整理
 * 一次就用掉一次作答機會。
 */
export async function peekAssignment(
  assignmentId: string,
  userId: string,
): Promise<StudentTask | null> {
  const tasks = await listStudentTasks(userId);
  return tasks.find((t) => t.assignmentId === assignmentId) ?? null;
}

// ─────────────────────────────────────────────────────────────────

/** 訊息裡的時間一律用台灣時間。伺服器多半跑在 UTC，直接印會差八小時。 */
function fmtLocal(d: Date): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

async function audit(
  tenantId: string,
  actorId: string,
  action: string,
  targetId: string,
  after: Record<string, unknown>,
) {
  await prisma.auditLog.create({
    data: {
      tenantId,
      category: 'EXAM',
      action,
      actorId,
      targetType: 'Attempt',
      targetId,
      after: after as never,
    },
  });
}
