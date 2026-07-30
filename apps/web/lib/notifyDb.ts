/**
 * 通知的網頁端綁定：把 `lib/notify.mjs` 接到 `@/lib/prisma` 上。
 *
 * # 為什麼檔名不是 notify.ts
 *
 * 同一個資料夾裡已經有 `notify.mjs`，而 **tsc 與 webpack 對
 * `@/lib/notify` 的解析順序相反**（詳細理由見 `lib/abilityDb.ts` 的
 * 檔頭：tsc 先找 `.ts`，Next 的 webpack 先找 `.mjs`）。兩份實作的
 * 症狀極難查——`tsc --noEmit` 全綠、`next build` 印一行
 * 「Attempted import error」然後照樣 exit 0，而頁面炸在
 * 「xxx is not a function」。所以直接換一個不會撞的檔名。
 *
 * # 這一層刻意很薄
 *
 * 去重、節流、免打擾、掃描全部在 `notify.mjs`（純 JS，工作者與
 * 端到端測試跑的是同一份）。這裡只做兩件事：
 *
 *   一、把 `prisma` 與 `requireTenant()` 補上
 *   二、**把觸發點包成「絕對不會往上丟」的呼叫**
 *
 * 第二件是這個檔案真正的內容。
 *
 * # 通知失敗絕對不可以讓正事失敗
 *
 * 這裡每一支 `notifyXxx` 都自己吞掉例外，理由與 `lib/attempt.ts` 的
 * `gradeOnSubmit`、`lib/abilityDb.ts` 的快照更新**完全相同**：
 *
 *   · 交卷成功、老師按下放行成功、作廢成功 —— 這些都已經寫進資料庫了
 *   · 這時通知因為任何原因失敗（資料庫瞬斷、payload 有洞），
 *     讓整個請求回 500 的結果是：老師看到錯誤畫面，以為放行沒成功，
 *     於是再按一次——而第二次會撞到「這份任務已經放行過了」，
 *     於是他確信系統壞了
 *
 * **少一則通知是看得見也補得回來的**（成績就在那裡，任務清單上也有）；
 * 放行失敗不是。所以吞掉，只留一行日誌。
 *
 * # 為什麼觸發點放在這裡而不是各自的模組裡
 *
 * 因為 `lib/scoring.ts`、`lib/assignment.ts`、`lib/attempt.ts` 是這個
 * 系統裡最不該被加東西的三個檔案（成績、派卷、作答）。它們各加一行
 * `await notifyXxx(...)`，而**那一行做的每一件事都在這裡**——
 * 收件人怎麼算、文案吃什麼欄位、失敗怎麼處理。改通知不必碰那三個檔案。
 */
import { Prisma } from '@prisma/client';

import {
  enqueue,
  enqueueMany,
  inboxPage,
  markRead as markReadCore,
  unreadCount as unreadCountCore,
  buildChannels,
  parseQuietHours,
} from '@/lib/notify.mjs';
import { prisma } from '@/lib/prisma';
import { requireTenant } from '@/lib/tenant';

// ─────────────────────────────────────────────────────────────────
// 讀：收件匣
// ─────────────────────────────────────────────────────────────────

export type InboxRow = {
  id: string;
  templateKey: string;
  payload: unknown;
  createdAt: Date;
  readAt: Date | null;
};

/** 收件匣的一頁。`before` 是游標（上一頁最後一則的 createdAt）。 */
export async function listInbox(
  recipientId: string,
  opts: { take?: number; before?: Date | null } = {},
): Promise<{ rows: InboxRow[]; hasMore: boolean }> {
  requireTenant();
  return inboxPage(prisma, recipientId, opts);
}

/**
 * 未讀數。
 *
 * **失敗回 0 而不是往上丟。** 這個數字畫在導覽列上，也就是每一頁都有；
 * 讓它有能力把任何一頁變成錯誤畫面，是把一個裝飾品放到承重牆上。
 */
export async function unread(recipientId: string): Promise<number> {
  try {
    requireTenant();
    return await unreadCountCore(prisma, recipientId);
  } catch (e) {
    console.error('[notify] 未讀數算不出來', e);
    return 0;
  }
}

/** 標成已讀。回傳這一次真的標起來的筆數。 */
export async function markRead(
  recipientId: string,
  opts: { ids?: string[]; all?: boolean },
): Promise<number> {
  requireTenant();
  return markReadCore(prisma, recipientId, opts);
}

// ─────────────────────────────────────────────────────────────────
// 讀寫：偏好
// ─────────────────────────────────────────────────────────────────

export type PreferenceView = {
  /** templateKey → 收不收。必收的那幾則永遠是 true。 */
  wanted: Record<string, boolean>;
  quietHours: { start: string; end: string } | null;
};

/**
 * 這個人的通知偏好。**沒有記錄就是「全部收得到、沒有免打擾」。**
 *
 * 不在使用者第一次登入時建一列，是刻意的：一列不存在與一列全部
 * 預設值在行為上完全相同，而少了那一次寫入就少了一個「什麼時候
 * 建、誰負責建」的問題。偏好只在他真的改過設定之後才存在。
 */
export async function loadPreference(userId: string): Promise<PreferenceView> {
  requireTenant();
  const row = await prisma.notificationPreference.findFirst({
    where: { userId },
    select: { channels: true, quietHours: true },
  });
  const channels =
    row?.channels && typeof row.channels === 'object' && !Array.isArray(row.channels)
      ? (row.channels as Record<string, unknown>)
      : {};

  const wanted: Record<string, boolean> = {};
  for (const [key, val] of Object.entries(channels)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      wanted[key] = (val as Record<string, unknown>).IN_APP !== false;
    }
  }
  const quiet = parseQuietHours(row?.quietHours ?? null) as
    | { startMin: number; endMin: number }
    | null;
  return {
    wanted,
    quietHours: quiet ? { start: hhmm(quiet.startMin), end: hhmm(quiet.endMin) } : null,
  };
}

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/**
 * 存偏好。
 *
 * `channels` 的形狀由 `buildChannels` 決定（只記關掉的、必收的一律
 * 忽略），所以**畫面上停用一個核取方塊不是保護**——直接打 API
 * 一樣送不進去。
 *
 * 免打擾時段讀不懂就當成沒有設定（`parseQuietHours` 回 null），
 * 而不是丟錯：那個值來自表單的兩個 time 輸入，瀏覽器之間的格式
 * 差異真的存在，而一個 500 對「時間打錯」是過度的反應。
 * 存不進去的話畫面上會顯示成「沒有設定」，那是看得見的。
 */
export async function savePreference(
  userId: string,
  input: { wanted: Record<string, boolean>; quietHours: { start: string; end: string } | null },
): Promise<PreferenceView> {
  requireTenant();
  const channels = buildChannels(input.wanted, 'IN_APP') as Record<string, unknown>;
  const quiet = input.quietHours ? parseQuietHours(input.quietHours) : null;

  const existing = await prisma.notificationPreference.findFirst({
    where: { userId },
    select: { id: true },
  });
  const data = {
    channels: channels as Prisma.InputJsonValue,
    // 清掉免打擾時段要寫 `Prisma.DbNull`（那一欄是可為 null 的 Json）。
    // 直接寫 JS 的 `null` 在 Prisma 的型別上是 `JsonNull`——存進去的是
    // **JSON 的 null**，而 `parseQuietHours` 讀到它會回 null 沒錯，
    // 但欄位上就此不是 SQL NULL，日後任何 `quietHours: null` 的查詢
    // 都比對不到它。差別在畫面上完全看不出來。
    quietHours: quiet && input.quietHours
      ? (input.quietHours as Prisma.InputJsonValue)
      : Prisma.DbNull,
  };
  if (existing) {
    await prisma.notificationPreference.update({ where: { id: existing.id }, data });
  } else {
    await prisma.notificationPreference.create({ data: { userId, ...data } });
  }
  return loadPreference(userId);
}

// ─────────────────────────────────────────────────────────────────
// 寫：事件觸發點
// ─────────────────────────────────────────────────────────────────

/**
 * 每一支觸發點共用的外殼：吞掉一切、留一行日誌。
 *
 * 包成一個函式而不是每支自己寫 try/catch，是因為**漏掉其中一支的
 * 症狀是「老師按下放行看到 500」**，而那一支可能三個月後才被加進來。
 */
async function quietly(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[notify] ${what} 的通知沒有建立（不影響剛剛那件事本身）`, e);
  }
}

/**
 * 成績放行了（`releasePolicy = MANUAL`，老師按下放行）。
 *
 * # 為什麼收件名單由呼叫端給，而不是這裡自己查
 *
 * 兩個理由，第二個才是真的：
 *
 *   一、`resolveRecipientIds` 是**唯一一份「這份任務派給了誰」**
 *       （見 `lib/assignment.ts` 的決定四），而它就在呼叫端那個檔案裡。
 *   二、**避免相依循環。** 這裡 import `lib/assignment.ts`、而它 import
 *       這裡，在 ESM 與 webpack 底下都能跑，但那種模組圖會在某一次
 *       重構之後變成執行期的 `undefined is not a function`，
 *       而錯誤指向的地方與原因無關。
 *
 * 沒有 `attempt` 的人也會收到嗎？**會，而且應該。** 一份 MANUAL 的
 * 任務放行時，沒交的人收到「成績開放了」會發現自己沒有成績——
 * 那是他該知道的事，而且下一步（找老師）是真的。
 */
export async function notifyGradeReleased(
  assignmentId: string,
  info: { tenantId: string; title: string; recipientIds: readonly string[] },
): Promise<void> {
  await quietly('成績放行', async () => {
    if (info.recipientIds.length === 0) return;
    await enqueueMany(
      prisma,
      info.recipientIds.map((userId) => ({
        tenantId: info.tenantId,
        recipientId: userId,
        templateKey: 'grade.released',
        // 一份任務放行一次就是一次。老師收回再放行不會再送——
        // 學生已經知道了，而第二則說的是同一件事。
        scope: assignmentId,
        payload: { assignmentId, title: info.title },
      })),
    );
  });
}

/**
 * 老師代替學生收了一份卡住的卷子。
 *
 * 只在**真的轉換了狀態**時呼叫（呼叫端看 `alreadySubmitted`）。
 * 冪等的重複呼叫也送一則的話，去重鍵會擋住它，但那會讓
 * 「這個事件發生過幾次」變成一個查不出來的問題。
 */
export async function notifyFinalizedOnBehalf(
  attemptId: string,
  info: { tenantId: string; recipientId: string; assignmentId: string; title: string },
): Promise<void> {
  await quietly('代為結算', () =>
    enqueue(prisma, {
      tenantId: info.tenantId,
      recipientId: info.recipientId,
      templateKey: 'attempt.finalized_by_teacher',
      scope: attemptId,
      payload: { assignmentId: info.assignmentId, title: info.title },
    }),
  );
}

/**
 * 作答被作廢／撤銷作廢。
 *
 * **`reason` 不進 payload。** 那一句是老師寫給稽核看的
 * （`lib/scoring.ts` 的 `voidAttempt` 把它寫進 `AuditLog.metadata`），
 * 而作廢的原因有兩種——誠信事件與系統故障——**系統分不出來**。
 * 把它原文推到學生面前，等於讓系統代替老師說出一句指控，
 * 而猜錯的那一次是指控一個沒有作弊的孩子。
 *
 * 所以通知只說「這一份不算數了」與「去找誰」，理由由人說明。
 * 文案見 `lib/notifyTemplates.mjs`。
 *
 * 任務名稱在這裡自己查，不由呼叫端傳：`voidAttempt` 的 select 裡本來
 * 沒有它，而**在 `lib/scoring.ts` 那個檔案裡動一個既有的查詢，比在
 * 這裡多一次查詢危險得多**——那支查詢是作廢流程的一部分，而作廢
 * 動的是學生的成績。這裡多的那一次查詢在通知的 try 裡面，失敗也
 * 只是少一則通知。
 */
export async function notifyVoided(
  attemptId: string,
  info: { tenantId: string; recipientId: string; assignmentId: string },
  voided: boolean,
): Promise<void> {
  await quietly(voided ? '作答作廢' : '撤銷作廢', async () => {
    const asg = await prisma.assignment.findFirst({
      where: { id: info.assignmentId },
      select: { title: true },
    });
    await enqueue(prisma, {
      tenantId: info.tenantId,
      recipientId: info.recipientId,
      templateKey: voided ? 'attempt.voided' : 'attempt.unvoided',
      scope: attemptId,
      payload: { assignmentId: info.assignmentId, title: asg?.title ?? '' },
    });
  });
}
