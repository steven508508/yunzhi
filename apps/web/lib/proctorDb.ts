/**
 * 考試行為偵測的資料層：把 `lib/proctor.mjs` 合併好的記錄寫進資料庫，
 * 以及把它們整理成老師看得懂的樣子。
 *
 * # 為什麼檔名不是 proctor.ts
 *
 * 因為同一個資料夾裡已經有 `proctor.mjs`，而 **tsc 與 webpack 對
 * `@/lib/proctor` 的解析順序相反**：TypeScript 先找 `.ts`，Next 的
 * webpack 先找 `.mjs`。兩份實作的症狀非常難查——`npx tsc --noEmit`
 * 全綠、`next build` 只印一行「Attempted import error」然後照樣
 * exit 0，而頁面在瀏覽器上炸在「xxx is not a function」。
 * 這個坑在 `lib/abilityDb.ts` 上踩過一次，所以這裡直接換一個檔名。
 *
 * # 這一層刻意很薄
 *
 * 會判斷錯的東西全部在 `lib/proctor.mjs`（純函式、有單元測試）：
 * 事件怎麼合併、抖動怎麼濾掉、「與全班明顯不同」是什麼意思。
 * 這裡只做三件事：寫進去、讀出來、丟給它算。
 *
 * **摘要與時間軸用的是同一支 `summarizeEvents`。** 各算一份的話，
 * 老師會在列表上看到「切走 5 次」、點進去數出 7 列，而那時他不會
 * 懷疑程式，他會懷疑學生。
 *
 * # 寫入失敗不可以影響作答
 *
 * 這些是輔助資料，不是學生的答案。所以呼叫端（路由）對這裡丟出來的
 * 任何錯誤都只回一個狀態碼，不做重試、不擋任何東西——而前端拿到
 * 非 2xx 時直接把那一批丟掉。理由見 app/api/attempts/[attemptId]/proctor
 * 的檔頭。
 */
import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { summarizeEvents, rankStudents, type ProctorSummary, type ProctorWire } from '@/lib/proctor.mjs';
import { requireTenant } from '@/lib/tenant';

/**
 * 一份作答最多留幾列。
 *
 * 上限存在的理由不是效能，是**這張表是給人看的**：兩千列的時間軸
 * 沒有人讀得完，而讀不完的證據等於沒有證據。合併與去抖動之後，
 * 一場 60 分鐘的考試正常是十幾列，切換頻繁的也就幾十列——會撞到
 * 1000 的只有兩種情況：前端壞了，或者有人拿這支 API 灌資料。
 * 兩種都不該讓它把磁碟寫滿。
 */
export const MAX_EVENTS_PER_ATTEMPT = 1000;

/**
 * 交卷之後還收多久的事件（毫秒）。
 *
 * 分頁關閉時的 beacon 與交卷的請求在網路上是賽跑的，而 beacon 常常
 * 慢半拍。零寬容的話，「他切走之後就再也沒有回來」那一列——也就是
 * 最值得記下來的那一列——正好是最常被丟掉的那一列。
 */
export const LATE_GRACE_MS = 5 * 60 * 1000;

export type RecordResult = {
  accepted: number;
  /**
   * 收下了但沒有寫進去的筆數。
   *
   * **要回得出這個數字**，即使前端不會為它做任何事：沒有它的話，
   * 「學生的瀏覽器沒送」與「送了但被丟掉」在事後完全分不出來，
   * 而那兩件事一個要查前端、一個要查上限設定。
   */
  dropped: number;
  reason: 'OK' | 'CLOSED' | 'FULL';
};

/**
 * 寫入一批行為事件。
 *
 * # 三道關卡
 *
 * **一、必須是自己的作答。** RLS 擋得住別家補習班，擋不住同一間裡的
 * 隔壁同學——他的 attempt 與你的在同一個租戶裡，政策全部通過。
 * 與 `lib/attempt.ts` 的每一支進入點同一條規則。
 *
 * **二、時刻由伺服器算。** 前端送的是「幾毫秒之前」而不是時刻
 * （見 `toProctorPayload`）：改系統時間就能偽造時刻，而這個功能的
 * 使用者正是有動機改系統時間的人。算出來之後再夾進
 * `[startedAt, now]`——夾不進去的多半是時鐘飄了，不是他在考試開始前
 * 三小時就切走了。
 *
 * **三、關掉的作答不再收。** 但留一段寬限，見 `LATE_GRACE_MS`。
 *
 * 回傳收下幾筆、丟掉幾筆。**丟掉不是錯誤**：前端不會因此重試，
 * 它本來就不該為了輔助資料多打一次伺服器。
 */
export async function recordProctorEvents(
  attemptId: string,
  userId: string,
  events: ProctorWire[],
  now = new Date(),
): Promise<RecordResult> {
  requireTenant();

  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId },
    select: { id: true, userId: true, status: true, startedAt: true, submittedAt: true },
  });
  // 找不到與不是你的都回同一件事。回「不是你的」等於告訴對方這個 id
  // 存在，而這一支不需要那個區分——前端對兩者的處置一模一樣。
  if (!attempt || attempt.userId !== userId) {
    return { accepted: 0, dropped: events.length, reason: 'CLOSED' };
  }

  const closedFor =
    attempt.status === 'IN_PROGRESS'
      ? 0
      : attempt.submittedAt
        ? now.getTime() - attempt.submittedAt.getTime()
        : Number.POSITIVE_INFINITY;
  // 作廢之後的事件不收：那一份已經不算數了，而繼續累積只是在一個
  // 沒有人會看的地方長資料。
  if (attempt.status === 'VOIDED' || closedFor > LATE_GRACE_MS) {
    return { accepted: 0, dropped: events.length, reason: 'CLOSED' };
  }

  const already = await prisma.proctorEvent.count({ where: { attemptId } });
  const room = MAX_EVENTS_PER_ATTEMPT - already;
  if (room <= 0) {
    return { accepted: 0, dropped: events.length, reason: 'FULL' };
  }

  const take = events.slice(0, room);
  const floor = attempt.startedAt.getTime();
  const ceil = now.getTime();

  const rows: Prisma.ProctorEventCreateManyInput[] = take.map((e) => {
    const at = clampTime(ceil - e.atOffsetMs, floor, ceil);
    return {
      attemptId,
      type: e.type,
      at: new Date(at),
      // 持續時間也要夾：`at − durationMs` 不可以早於這一場的開始，
      // 否則老師端畫出來的時間軸會有一段跑到考試開始之前。
      durationMs: e.durationMs == null ? null : Math.min(e.durationMs, at - floor),
      questionOrder: e.questionOrder ?? null,
      // meta 的形狀在路由的 zod 上鎖死（只有字元數與次數）。
      // **這裡不做「原樣存下來」**——那會讓貼上的內容有機會進資料庫。
      meta: (e.meta ?? undefined) as Prisma.InputJsonValue | undefined,
    };
  });

  await prisma.proctorEvent.createMany({ data: rows });

  return {
    accepted: rows.length,
    dropped: events.length - rows.length,
    reason: rows.length === events.length ? 'OK' : 'FULL',
  };
}

function clampTime(t: number, lo: number, hi: number): number {
  if (!Number.isFinite(t)) return hi;
  return Math.min(hi, Math.max(lo, t));
}

// ─────────────────────────────────────────────────────────────────
// 讀：老師端
// ─────────────────────────────────────────────────────────────────

export type ProctorEventRow = {
  id: string;
  type: string;
  at: Date;
  durationMs: number | null;
  questionOrder: number | null;
  meta: { chars?: number; count?: number; bursts?: number } | null;
};

export type ProctorStudentRow = {
  attemptId: string;
  userId: string;
  displayName: string;
  username: string;
  status: string;
  startedAt: Date;
  submittedAt: Date | null;
  summary: ProctorSummary;
  /** 與全班明顯不同——**這是排序用的標記，不是判定**。見 rankStudents。 */
  standsOut: boolean;
  why: string[];
};

export type ProctorReport = {
  rows: ProctorStudentRow[];
  baseline: ReturnType<typeof rankStudents>['baseline'];
  /** 這份任務總共有幾列事件。0 代表沒有人的瀏覽器送過任何東西。 */
  total: number;
  /** 有沒有作答是完全沒有事件的（含沒有開過偵測的舊作答）。 */
  silent: number;
};

/**
 * 一份任務的全班行為摘要。
 *
 * # 為什麼連「一個事件都沒有」的作答也要算進來
 *
 * 因為中位數是拿來對照的。只統計有事件的那幾位，中位數會被算成
 * 「有事件的人的中位數」——那個數字必然偏高，於是「高於中位數兩倍」
 * 這條線會把正常的人濾掉、把最多的那一兩位留下來，而那正好是
 * 「總是找得到一個最可疑的人」的統計陷阱。
 *
 * 全班 30 個人裡有 28 個是 0 次時，中位數就該是 0，而切走 4 次的那位
 * 確實與全班不同。這才是老師要的對照。
 */
export async function assignmentProctorReport(assignmentId: string): Promise<ProctorReport> {
  requireTenant();

  const attempts = await prisma.attempt.findMany({
    where: { assignmentId },
    select: {
      id: true,
      userId: true,
      status: true,
      startedAt: true,
      submittedAt: true,
      user: { select: { displayName: true, username: true } },
    },
    orderBy: { startedAt: 'asc' },
  });
  if (attempts.length === 0) {
    return { rows: [], baseline: rankStudents([]).baseline, total: 0, silent: 0 };
  }

  // 只取摘要要用的三欄。整列拉回來會把 meta 也帶上，而那是時間軸
  // 才需要的東西——一個班的量差不多，但一個學期的量差很多。
  const events = await prisma.proctorEvent.findMany({
    where: { attempt: { assignmentId } },
    select: { attemptId: true, type: true, durationMs: true, meta: true },
  });

  const byAttempt = new Map<string, { type: string; durationMs: number | null; meta: unknown }[]>();
  for (const e of events) {
    const list = byAttempt.get(e.attemptId);
    if (list) list.push(e);
    else byAttempt.set(e.attemptId, [e]);
  }

  const ranked = rankStudents(
    attempts.map((a) => ({
      attemptId: a.id,
      userId: a.userId,
      displayName: a.user.displayName,
      username: a.user.username,
      status: a.status,
      startedAt: a.startedAt,
      submittedAt: a.submittedAt,
      summary: summarizeEvents(byAttempt.get(a.id) ?? []),
    })),
  );

  return {
    rows: ranked.rows,
    baseline: ranked.baseline,
    total: events.length,
    silent: ranked.rows.filter((r) => r.summary.total === 0).length,
  };
}

/**
 * 一份任務裡每一份作答的完整時間軸。
 *
 * 依時間排序，**不分組、不摺疊**：老師要看的是「他在第 14 題離開了
 * 四分鐘，回來之後三分鐘內又離開兩次」，而那個形狀只有在時間軸上
 * 才看得出來。
 *
 * 一次查完整份任務而不是一位一位查：三十位學生就是三十次往返，
 * 而這一頁本來就是「一次看完全班」的頁。
 */
export async function assignmentProctorTimelines(
  assignmentId: string,
): Promise<Map<string, ProctorEventRow[]>> {
  requireTenant();

  const rows = await prisma.proctorEvent.findMany({
    where: { attempt: { assignmentId } },
    select: {
      id: true,
      attemptId: true,
      type: true,
      at: true,
      durationMs: true,
      questionOrder: true,
      meta: true,
    },
    orderBy: { at: 'asc' },
  });

  const out = new Map<string, ProctorEventRow[]>();
  for (const r of rows) {
    const row: ProctorEventRow = {
      id: r.id,
      type: r.type,
      at: r.at,
      durationMs: r.durationMs,
      questionOrder: r.questionOrder,
      meta: (r.meta ?? null) as ProctorEventRow['meta'],
    };
    const list = out.get(r.attemptId);
    if (list) list.push(row);
    else out.set(r.attemptId, [row]);
  }
  return out;
}
