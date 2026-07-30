/**
 * 通知：去重、節流、免打擾，以及把它們接到資料庫上。
 *
 * # 為什麼是 .mjs，而且資料庫用戶端由呼叫端傳進來
 *
 * 因為這一段有兩個呼叫端，而**其中一個不經過 TypeScript**：
 *
 *   網頁端    `lib/notifyDb.ts` → `@/lib/prisma`
 *   工作者    `scripts/worker.mjs`（映像裡是 `node scripts/worker.mjs`，
 *             純 node，沒有 `@/` 別名、也不編譯 .ts）
 *   端到端    `tools/e2e-notify.mjs` → `tools/pg-shim.mjs`
 *
 * 三邊各寫一份的話，「同一個事件只送一次」會有三種答案，而它們
 * 不一致的症狀是**家長收到兩則一模一樣的通知**，或者更糟——
 * 一則都沒有。分工與 `lib/ability.mjs` / `lib/abilityDb.ts` 完全相同：
 * 會算錯的東西在這裡（純函式、有測試），薄薄的一層綁定在 .ts 那邊。
 *
 * # 這個模組守的四條線
 *
 * **一、去重鍵是真的去重，不是一個提示。**
 * `Notification` 有 `@@unique([tenantId, dedupeKey])`，所以「只送一次」
 * 由資料庫保證，不是由「先查一下有沒有」保證。後者在兩個 worker
 * 實例同時跑時**一定會漏**：兩邊都查到沒有，兩邊都寫進去。
 * 所以這裡一律「寫下去，撞到唯一鍵就當成已經有了」。
 *
 * **二、不可送的一律建立成 SUPPRESSED 並寫下原因，絕不留在 QUEUED。**
 * 未接的渠道（EMAIL / LINE / SMS）與使用者關掉的類別都走這一條。
 * 留在 QUEUED 的後果是老師以為家長收到了——那比沒有這個渠道更糟。
 *
 * **三、免打擾是延後，不是丟掉。**
 * 半夜三點的「作業快到期」延到早上七點出現，學生收到的資訊完全一樣；
 * 丟掉的話他永遠不知道有這件事。必收的那幾則也一樣延後——「不可
 * 關閉」的意思是一定送到，不是一定現在吵你。
 *
 * **四、通知不可以拖垮考試。**
 * 產生通知的掃描（`sweepDueSoon` 那幾支）會掃過所有租戶的任務與
 * 作答。那是這個模組最重的查詢，而它跟考試搶的是同一個資料庫。
 * 所以有一場考試正在進行時整輪掃描直接跳過（`examBusy`）——
 * 掃描是冪等的，下一輪補得回來，而考試不能等。
 *
 * # 站內通知的「送出」是什麼
 *
 * 老實說：**什麼都沒有離開這台機器。** IN_APP 的那一列本身就是投遞，
 * QUEUED → SENT 只是記帳。仍然讓它走一次工作者，是為了三件事：
 * 免打擾與節流只在一個地方生效、失敗與重試的帳從第一天就記著、
 * 以及日後真的接上 LINE 時管線已經在那裡（`deliverDue` 的 `send`）。
 */

import { countByAssignment } from './scope.mjs';
import { TEMPLATES, mayTurnOff } from './notifyTemplates.mjs';

// ─────────────────────────────────────────────────────────────────
// 常數
// ─────────────────────────────────────────────────────────────────

/**
 * 真的接上的渠道。**這一行就是唯一的事實來源。**
 *
 * `NotifyChannel` 的 enum 裡有四個（IN_APP / EMAIL / LINE / SMS），
 * 而這套系統跑在補習班機房的封閉網段：對外的 SMTP 是
 * `ERR_TUNNEL_CONNECTION_FAILED`。這個專案已經因為同一個理由刻意
 * 不做「寄信重設密碼」（見 `lib/roster.ts`）與「寄信驗證家長」
 * （見 `lib/guardian.ts`），這裡不會例外。
 *
 * 學生多半沒有登記 email；家長有信箱（名冊 CSV 收得到）但一樣寄不
 * 出去，而**那才是危險的地方**：老師會以為家長收到了成績通知。
 *
 * 日後真的接上時，改這一行、在 `deliverDue` 的 `send` 裡多一個分支，
 * 其餘不必動。
 */
export const READY_CHANNELS = Object.freeze(['IN_APP']);

/**
 * 未接的渠道各自的原因。會原封不動寫進 `failReason`，讓人查得到。
 *
 * 標成 `Record<string, string>` 而不是讓 TypeScript 推出四個字面型別：
 * 呼叫端拿到的 `channel` 來自資料庫（是一個 string），而推出來的
 * 窄型別會讓 `UNREADY_REASON[channel]` 在 tsc 底下變成錯誤。
 * @type {Record<string, string>}
 */
export const UNREADY_REASON = Object.freeze({
  EMAIL: '這套系統跑在封閉網段，對外 SMTP 不通，所以電子郵件還沒有接。這一則沒有送出。',
  LINE: 'LINE 官方帳號還沒有綁定（NotificationPreference.lineUserId 是空的，而且對外連線不通）。這一則沒有送出。',
  SMS: '簡訊需要對外的服務商，目前沒有接。這一則沒有送出。',
});

/** 快到期的視窗。截止前 24 小時內、而且還沒交的才提醒。 */
export const DUE_SOON_MS = 24 * 60 * 60 * 1000;

/**
 * 逾期未交往回看多久。
 *
 * **這個上限是必要的，不是保守。** 少了它，第一次啟用通知的那一輪
 * 掃描會把系統上線以來每一份沒交的作業全部翻出來，於是每個學生的
 * 收件匣裡塞進去年的東西——而那些沒有一件是他今天做得到的。
 * 「發生了什麼事」講的是最近發生的事。
 */
export const OVERDUE_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

/** 匯入與待閱卷往回看多久。老師的節奏比學生慢，但一週前的沒有意義。 */
export const STAFF_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 節流：同一個人在 `THROTTLE_WINDOW_MS` 內最多讓幾則出現。
 *
 * schema 自己的註解就寫著「避免家長在一分鐘內收到五則相同的到班
 * 通知」。三則是刻意比五更嚴：**第四則之後，收件匣就不再是一份
 * 可以讀的清單了**，而讀不完的清單與沒有通知的效果一樣。
 *
 * 超過的不丟，往後排到視窗空出來的那一刻（見 `throttle`）。
 */
export const THROTTLE_WINDOW_MS = 60 * 1000;
export const MAX_PER_WINDOW = 3;

/**
 * 未讀只算最近這麼多天的。
 *
 * # 為什麼未讀數要有一個地平線
 *
 * 因為一個永遠不會歸零的紅點，一週之後就被完全忽略了——而那時候
 * 它連「有新的事情」都不再表示。三個月前一則沒點開的「作業快到期」
 * 不該讓今天的作廢通知看起來一樣不重要。
 *
 * 這是三道機制裡的第三道，另外兩道在 `app/(app)/inbox`：打開收件匣
 * 就把畫面上那幾則標成已讀、以及沒有未讀時完全不畫那個數字。
 */
export const UNREAD_HORIZON_DAYS = 30;

/** 一次投遞最多處理幾列。考試中的資料庫負載優先，所以有上限。 */
export const DELIVER_BATCH = 200;

/**
 * 送出失敗最多重試幾次。
 *
 * 上限存在的理由不是效能，是**可見性**：無上限的重試會讓一則永遠
 * 送不出去的通知每分鐘失敗一次，而 `failReason` 每次都被覆寫成
 * 一樣的字——沒有人看得出它已經試了三千次。到了上限標成 FAILED
 * 就停手，而那一列會留著原因。
 */
export const MAX_RETRY = 5;

/** 搶下來卻沒有結果的（行程被 kill）多久之後放回佇列。 */
export const STUCK_SENDING_MS = 5 * 60 * 1000;

/**
 * 幾份正在計時的作答算「有一場考試正在進行」。
 *
 * 判斷用 `expiresAt > now` 而不是只看 `status = IN_PROGRESS`：
 * 卡住的作答會永遠掛在 IN_PROGRESS（首頁待辦上那一項講的就是它），
 * 拿它當指標的話，一份三個月前沒收掉的卷子會讓通知**永遠不再產生**。
 * 沒有時限的那些也不算——它們與卡住的在資料上分不出來。
 */
export const EXAM_BUSY_ATTEMPTS = 20;

/** 台北時間與 UTC 的差。台灣自 1980 年起沒有日光節約時間，所以是常數。 */
const TAIPEI_OFFSET_MIN = 480;

// ─────────────────────────────────────────────────────────────────
// 純函式：時間
// ─────────────────────────────────────────────────────────────────

/**
 * 這個時刻在台灣是哪一天（`YYYY-MM-DD`）。
 *
 * 去重鍵裡的「一天」一律指台灣的一天。用 UTC 的話，晚上八點與
 * 隔天早上七點會落在同一個 UTC 日期，於是**晚上收到過提醒的學生
 * 隔天早上不會再收到**——而那正是最該提醒他的時候。
 *
 * @param {Date|number} at
 * @returns {string}
 */
export function taipeiDay(at) {
  const t = at instanceof Date ? at.getTime() : Number(at);
  return new Date(t + TAIPEI_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

/** 這個時刻在台灣是當天的第幾分鐘（0–1439）。 */
export function taipeiMinutes(at) {
  const t = at instanceof Date ? at.getTime() : Number(at);
  return Math.floor((t / 60_000 + TAIPEI_OFFSET_MIN) % 1440);
}

/**
 * 把 `NotificationPreference.quietHours` 這個 JSON 讀成分鐘。
 *
 * 讀不懂一律回 null（= 沒有免打擾時段）。**不猜。** 一個猜錯的免打擾
 * 時段的症狀是通知全部消失，而畫面上沒有任何跡象；而「設定沒生效」
 * 是會被回報的。
 *
 * `start === end` 也當成沒有設定：那寫下去的意思是「一整天都不要
 * 打擾」，而它的實際效果是每一則通知都被排到 24 小時後、再被排到
 * 24 小時後——一則都不會出現。那種設定不該被靜靜地接受。
 *
 * @param {unknown} raw
 * @returns {{startMin: number, endMin: number}|null}
 */
export function parseQuietHours(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = /** @type {Record<string, unknown>} */ (raw);
  const startMin = hhmm(src.start);
  const endMin = hhmm(src.end);
  if (startMin === null || endMin === null) return null;
  if (startMin === endMin) return null;
  return { startMin, endMin };
}

/** 「22:00」→ 1320。讀不出來回 null。 */
function hhmm(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 這個時刻在免打擾時段裡嗎。
 *
 * 跨午夜是常態（「22:00 到 07:00」），所以兩種都要處理：
 * `start < end` 是同一天內的一段，`start > end` 是跨過午夜的一段。
 * 只寫前者的話，最常見的那個設定會完全沒有作用。
 *
 * @param {{startMin: number, endMin: number}|null} quiet
 * @param {Date} at
 */
export function inQuietHours(quiet, at) {
  if (!quiet) return false;
  const m = taipeiMinutes(at);
  return quiet.startMin < quiet.endMin
    ? m >= quiet.startMin && m < quiet.endMin
    : m >= quiet.startMin || m < quiet.endMin;
}

/**
 * 免打擾時段結束的那一刻。只在 `inQuietHours` 為真時有意義。
 *
 * @param {{startMin: number, endMin: number}} quiet
 * @param {Date} at
 * @returns {Date}
 */
export function quietUntil(quiet, at) {
  const m = taipeiMinutes(at);
  const delta = (quiet.endMin - m + 1440) % 1440;
  // 秒與毫秒歸零，否則「早上七點開放」會變成 07:00:23.417 —— 同一批
  // 通知會落在不同的秒上，而測試與日誌都因此難讀。
  const base = Math.floor(at.getTime() / 60_000) * 60_000;
  return new Date(base + (delta === 0 ? 1440 : delta) * 60_000);
}

// ─────────────────────────────────────────────────────────────────
// 純函式：去重鍵
// ─────────────────────────────────────────────────────────────────

/**
 * 去重鍵。**同一個事件在重試或多次觸發時只送一次**靠的就是它。
 *
 * # 形狀
 *
 * `<templateKey>:<recipientId>:<scope>`
 *
 * 三段各有各的必要性：
 *
 *   · **templateKey** —— 同一份任務的「快到期」與「逾期未交」是兩件
 *     事，兩則都該收到。少了這一段，第二則會被第一則吃掉。
 *   · **recipientId** —— 一份任務放行時 30 個學生各收一則。少了這一段
 *     只有第一個人收到，而**其餘 29 個人的通知會安靜地消失**。
 *   · **scope** —— 事件的身分。這一段的選擇就是整個去重設計：
 *
 *       事件型（放行、作廢、代為結算、匯入）用那個東西的 id。
 *       一份任務放行一次就是一次，重複觸發（老師收回再放行、
 *       API 被重打）不該再送。
 *
 *       掃描型（快到期、逾期未交）用**台灣日期**。工作者每 15 分鐘
 *       跑一次，一天 96 輪；用 assignmentId 當 scope 的話一份任務
 *       只會提醒一次（截止前 24 小時那一刻），而用日期的話是
 *       「每天最多提醒一次」——後者才是人會期待的行為，而且它同時
 *       解決了「六份作業要送六則還是一則」：一則，因為六份的下一步
 *       完全相同（見 `notifyTemplates.mjs`）。
 *
 * # 為什麼不用雜湊
 *
 * 因為這一欄要能被人讀。「為什麼這位家長沒收到通知」的第一步是
 * 在資料庫裡撈一列出來看，而一串 sha256 不會告訴任何人任何事。
 *
 * @param {string} templateKey
 * @param {string} recipientId
 * @param {string} scope
 */
export function dedupeKey(templateKey, recipientId, scope) {
  if (!templateKey || !recipientId || !scope) {
    // 空的 scope 會產生一個所有事件共用的鍵，於是這個人一生只收得到
    // 一則通知。這種錯不能靜靜地過去。
    throw new Error(`去重鍵不完整：${templateKey}/${recipientId}/${scope}`);
  }
  return `${templateKey}:${recipientId}:${scope}`;
}

/**
 * 撞到唯一鍵了嗎。
 *
 * 三種寫法都要認：Prisma 的 `P2002`、Postgres 的 `23505`（pg-shim 走
 * 這一條），以及訊息字串（包裝過的錯誤有時只剩訊息）。**只認一種的
 * 後果是把「已經有了」當成真的失敗**，於是工作者每一輪都印一次
 * 錯誤，而事情其實是對的。
 */
export function isDuplicate(e) {
  if (!e) return false;
  const code = e.code ?? e?.meta?.code ?? '';
  if (code === 'P2002' || code === '23505') return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return /duplicate key value|Unique constraint failed/i.test(msg);
}

// ─────────────────────────────────────────────────────────────────
// 純函式：渠道與偏好
// ─────────────────────────────────────────────────────────────────

/** 這個渠道真的送得出去嗎。認不得的渠道一律 false。 */
export function channelReady(channel) {
  return READY_CHANNELS.includes(channel);
}

/**
 * 使用者把這一則關掉了嗎。
 *
 * `NotificationPreference.channels` 的形狀是
 * `{ "<templateKey>": { "IN_APP": false } }`。**沒有記錄就是開著**——
 * 預設值必須是「收得到」：一張空的偏好表（每個新帳號都是）若被
 * 讀成「全部關閉」，那症狀是通知功能整個不存在，而畫面上完全正常。
 *
 * 必收的那幾則不看這裡（見 `notifyTemplates.mjs` 的 `MANDATORY`）——
 * 判斷放在這一支裡而不是呼叫端，是因為呼叫端有三處，
 * 而漏掉其中一處的方向是「學生關掉了作廢通知」。
 *
 * @param {unknown} channels `NotificationPreference.channels`
 * @param {string} templateKey
 * @param {string} channel
 */
export function turnedOff(channels, templateKey, channel) {
  if (!mayTurnOff(templateKey)) return false;
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) return false;
  const forKey = /** @type {Record<string, unknown>} */ (channels)[templateKey];
  if (!forKey || typeof forKey !== 'object' || Array.isArray(forKey)) return false;
  return /** @type {Record<string, unknown>} */ (forKey)[channel] === false;
}

/**
 * 把一組勾選狀態寫成 `channels` 該有的形狀。
 *
 * **只記「關掉的」，不記「開著的」。** 全部開著時這一欄是 `{}`，
 * 於是日後新增一則通知類別時，既有使用者的預設是收得到——
 * 而如果這裡記的是白名單，新類別對每一個現存帳號都是關閉的，
 * 沒有人會發現。
 *
 * 必收的那幾則就算被送進來也不寫入：那個開關在畫面上是停用的，
 * 但**畫面停用不是保護**，直接打 API 一樣送得進來。
 *
 * @param {Record<string, boolean>} wanted templateKey → 要不要收
 * @param {string} channel
 */
export function buildChannels(wanted, channel = 'IN_APP') {
  /** @type {Record<string, Record<string, boolean>>} */
  const out = {};
  for (const [key, on] of Object.entries(wanted ?? {})) {
    if (!(key in TEMPLATES)) continue; // 認不得的代號一律丟掉
    if (!mayTurnOff(key)) continue;
    if (on === false) out[key] = { [channel]: false };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// 純函式：節流與排程
// ─────────────────────────────────────────────────────────────────

/**
 * 這一則什麼時候可以出現，才不會擠在一起。
 *
 * @param {number[]} recent 這個人已排定的時刻（毫秒），只需要視窗內的。
 * @param {number} nowMs
 * @param {{ windowMs?: number, maxPerWindow?: number }} [opts]
 * @returns {number} 這一則的 `scheduledAt`（毫秒）。
 *
 * # 為什麼是往後排而不是丟掉
 *
 * 丟掉的那一則永遠不會回來，而**它可能是六則裡唯一重要的那一則**
 * ——「你的作答被作廢」剛好排在第四位的機率不低。往後排的代價只是
 * 晚一分鐘看到。
 *
 * # 為什麼視窗是滑動的
 *
 * 用固定的整分鐘視窗（「每分鐘三則」）的話，59 秒與 61 秒屬於不同
 * 視窗，於是六則可以在兩秒內全部出現。這裡看的是「最近一分鐘內
 * 已經有幾則」，所以擠不進去。
 */
export function throttle(recent, nowMs, opts = {}) {
  const windowMs = opts.windowMs ?? THROTTLE_WINDOW_MS;
  const max = opts.maxPerWindow ?? MAX_PER_WINDOW;
  const sorted = [...recent].sort((a, b) => a - b);

  // 找出最早的一個時刻 `at`（不早於現在），使得「結束於 at 的那一分鐘」
  // 裡不到 max 則。
  //
  // **視窗要同時有頭有尾**（`t > at - windowMs && t <= at`）。只看下界
  // 的話，一則因為免打擾而被排到八小時後的通知會佔用**現在**的名額
  // ——於是設了免打擾的人在白天收到的每一則都被無故延後一分鐘，
  // 而那是一個查不出原因的症狀。這是端到端測試真的抓到的一個錯。
  let at = nowMs;
  // 每一圈至少把一列擠出視窗，所以繞不了超過 recent.length + 1 次。
  for (let guard = 0; guard <= sorted.length; guard++) {
    const inWindow = sorted.filter((t) => t > at - windowMs && t <= at);
    if (inWindow.length < max) return at;
    // 第 max 個最新的那一則離開視窗的那一刻。
    at = inWindow[inWindow.length - max] + windowMs;
  }
  return at;
}

/**
 * 這一則的最終排程時刻：節流與免打擾一起收斂。
 *
 * # 為什麼不是「先節流，再避開免打擾」兩步就好
 *
 * 因為那兩件事會互相推。半夜三點產生的五則各自被推到早上七點，
 * 而在七點那一刻它們是**同時出現的**——於是免打擾一結束，
 * 累積一整夜的通知一次湧出，而那正是節流要防的事。
 *
 * 反過來先避開免打擾再節流也不對：那時節流看的是「七點的視窗」，
 * 但被推過去之後又可能落進另一段免打擾（設了兩段的人）。
 *
 * 所以這裡求的是**不動點**：把「節流之後再避開免打擾」重複套用，
 * 直到時間不再往後移。兩個函式都是單調不減而且不會早於輸入，
 * 所以一定收斂；圈數以 `recent` 的長度為界，另外加一道硬上限
 * ——一個排程函式不可以有機會變成無窮迴圈，那會讓整個工作者卡死。
 *
 * @param {{ nowMs: number, recent: number[], quiet: {startMin:number,endMin:number}|null }} input
 * @returns {Date}
 */
export function scheduleFor({ nowMs, recent, quiet }) {
  let at = nowMs;
  const rounds = Math.min((recent?.length ?? 0) + 3, 64);
  for (let i = 0; i < rounds; i++) {
    let next = throttle(recent, at);
    const d = new Date(next);
    if (inQuietHours(quiet, d)) next = quietUntil(quiet, d).getTime();
    if (next === at) return new Date(at);
    at = next;
  }
  return new Date(at);
}

// ─────────────────────────────────────────────────────────────────
// 純函式：一份任務派給了誰
// ─────────────────────────────────────────────────────────────────

/**
 * 把派發對象展開成「任務 → 學生 id 的集合」。
 *
 * # 為什麼這裡又有一份，而 `lib/scope.mjs` 已經有 `countByAssignment`
 *
 * 因為那一支回的是**人數**，而催繳要的是**名單**。那個檔案不在這一
 * 批的改動範圍裡，所以這裡是同一條規則的集合版本；而**兩份實作
 * 對同一組輸入必須給出同一個答案**這件事不靠註解保證——
 * `tests/notify.test.mjs` 拿隨機組合對照兩支的結果，任何一邊改了
 * 而另一邊沒跟上都會紅。
 *
 * 三條規則與 `countByAssignment` 逐字相同：去重（同一位學生在兩個
 * 被派到的班上）、一列可以同時帶班級與個人、帳號檢查放在最後。
 *
 * @param {readonly {assignmentId: string, classId: string|null, userId: string|null}[]} targets
 * @param {Map<string, readonly string[]>} membersOfClass 班級 → 在學學生 id
 * @param {ReadonlySet<string>} validUserIds 通過帳號檢查的 id
 * @returns {Map<string, Set<string>>}
 */
export function recipientsByAssignment(targets, membersOfClass, validUserIds) {
  /** @type {Map<string, Set<string>>} */
  const out = new Map();
  for (const t of targets) {
    let set = out.get(t.assignmentId);
    if (!set) out.set(t.assignmentId, (set = new Set()));
    if (t.classId) {
      for (const uid of membersOfClass.get(t.classId) ?? []) {
        if (validUserIds.has(uid)) set.add(uid);
      }
    }
    if (t.userId && validUserIds.has(t.userId)) set.add(t.userId);
  }
  return out;
}

/** 上面那一支與 `countByAssignment` 是不是同一條規則。測試用。 */
export function agreesWithCount(targets, membersOfClass, validUserIds) {
  const sets = recipientsByAssignment(targets, membersOfClass, validUserIds);
  const counts = countByAssignment(targets, membersOfClass, validUserIds);
  if (sets.size !== counts.size) return false;
  for (const [id, set] of sets) {
    if (counts.get(id) !== set.size) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────
// 資料層：寫入
// ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} NotifySpec 一則要建立的通知。
 * @property {string} tenantId
 * @property {string} recipientId
 * @property {string} templateKey
 * @property {string} scope 去重鍵的第三段。見 `dedupeKey`。
 * @property {Record<string, unknown>} payload
 * @property {string} [channel] 預設 IN_APP。
 */

/**
 * @typedef {object} EnqueueResult
 * @property {number} created 真的寫進去的
 * @property {number} skipped 撞到去重鍵、已經有了的
 * @property {number} suppressed 建立了但標成 SUPPRESSED（渠道未接或使用者關掉）
 */

/**
 * 建立一批通知。**冪等**：同一批跑十次，結果與跑一次相同。
 *
 * # 為什麼是「批」而不是一則一則
 *
 * 因為節流要看「這個人最近有幾則」，而一則一則做的話那個查詢會
 * 乘上收件人數——一份任務放行是 30 次往返，一輪逾期掃描可能是
 * 兩百次。而連線池只有幾條，症狀是**通知一多，考試端開始逾時**。
 *
 * 所以偏好與節流各查一次，然後在記憶體裡逐則推進（前面幾則排到
 * 後面去之後，會佔用後面那幾則的視窗——這一點只有批次做得到）。
 *
 * @param {any} prisma
 * @param {NotifySpec[]} specs
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<EnqueueResult>}
 */
export async function enqueueMany(prisma, specs, opts = {}) {
  const out = { created: 0, skipped: 0, suppressed: 0 };
  const list = (specs ?? []).filter((s) => s && s.tenantId && s.recipientId && s.templateKey);
  if (list.length === 0) return out;

  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const recipientIds = [...new Set(list.map((s) => s.recipientId))];

  const prefs = await prisma.notificationPreference.findMany({
    where: { userId: { in: recipientIds } },
    select: { userId: true, channels: true, quietHours: true },
  });
  const prefByUser = new Map(prefs.map((p) => [p.userId, p]));

  // 節流的視窗只看已排定的時刻。**用 scheduledAt 而不是 createdAt**：
  // 一批被排到早上七點的通知，在早上七點是同時出現的，而那正是
  // 要防的事；createdAt 全部落在半夜，看起來完全不擠。
  const recentRows = await prisma.notification.findMany({
    where: {
      recipientId: { in: recipientIds },
      scheduledAt: { gt: new Date(nowMs - THROTTLE_WINDOW_MS) },
    },
    select: { recipientId: true, scheduledAt: true },
  });
  /** @type {Map<string, number[]>} */
  const recentByUser = new Map();
  for (const r of recentRows) {
    const arr = recentByUser.get(r.recipientId) ?? [];
    arr.push(new Date(r.scheduledAt).getTime());
    recentByUser.set(r.recipientId, arr);
  }

  for (const spec of list) {
    const channel = spec.channel ?? 'IN_APP';
    const pref = prefByUser.get(spec.recipientId);
    const quiet = parseQuietHours(pref?.quietHours ?? null);

    /** @type {string} */
    let status = 'QUEUED';
    /** @type {string|null} */
    let failReason = null;
    let scheduledAt = now;

    if (!channelReady(channel)) {
      // **這是「未接的渠道」唯一的處置。**
      //
      // 拒絕建立（丟例外）不行：通知的呼叫端一律吞掉錯誤（交卷不可以
      // 因為通知失敗而失敗），所以丟出去的例外會變成一次完全沒有
      // 痕跡的無事發生——事後沒有人查得出「為什麼家長沒收到」。
      //
      // 留在 QUEUED 更不行：那是在說「排隊中，等一下就送」，而它
      // 永遠不會被送出。老師會以為家長收到了成績通知，然後在電話裡
      // 才發現沒有。**一個安靜地卡住的佇列比沒有這個渠道更糟。**
      //
      // 所以：建立、立刻標成 SUPPRESSED、把原因寫進 failReason。
      // 查得到、算得出來、而且 `deliverDue` 永遠不會撿到它。
      status = 'SUPPRESSED';
      failReason = UNREADY_REASON[channel] ?? `渠道 ${channel} 沒有接。這一則沒有送出。`;
    } else if (turnedOff(pref?.channels ?? null, spec.templateKey, channel)) {
      status = 'SUPPRESSED';
      failReason = '收件人在通知設定裡關掉了這一類通知。';
    } else {
      const recent = recentByUser.get(spec.recipientId) ?? [];
      scheduledAt = scheduleFor({ nowMs, recent, quiet });
      recent.push(scheduledAt.getTime());
      recentByUser.set(spec.recipientId, recent);
    }

    const key = dedupeKey(spec.templateKey, spec.recipientId, spec.scope);
    try {
      await prisma.notification.create({
        data: {
          tenantId: spec.tenantId,
          recipientId: spec.recipientId,
          channel,
          templateKey: spec.templateKey,
          payload: spec.payload ?? {},
          status,
          scheduledAt,
          failReason,
          dedupeKey: key,
        },
      });
      if (status === 'SUPPRESSED') out.suppressed++;
      else out.created++;
    } catch (e) {
      // **撞到唯一鍵是正常結果，不是錯誤。** 這就是「跑十次只產生
      // 一則」的機制本身：不先查再寫（兩個 worker 實例會同時查到
      // 沒有、同時寫進去），而是寫下去讓資料庫判。
      if (isDuplicate(e)) {
        out.skipped++;
        // 排程時刻要收回來，否則被跳過的那一則會白佔一個節流名額。
        const arr = recentByUser.get(spec.recipientId);
        if (arr) {
          const i = arr.lastIndexOf(scheduledAt.getTime());
          if (i >= 0) arr.splice(i, 1);
        }
        continue;
      }
      throw e;
    }
  }
  return out;
}

/** 一則。`enqueueMany` 的方便寫法。 */
export function enqueue(prisma, spec, opts = {}) {
  return enqueueMany(prisma, [spec], opts);
}

// ─────────────────────────────────────────────────────────────────
// 資料層：投遞
// ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} DeliverResult
 * @property {number} sent
 * @property {number} failed 這一輪失敗、還會再試的
 * @property {number} dead 到了重試上限、標成 FAILED 的
 * @property {number} suppressed
 * @property {number} rescued 從卡住的 SENDING 放回佇列的
 */

/**
 * 把到期的通知送出去。
 *
 * # 三件事讓它可以被重跑而不重複送
 *
 * **一、只撿 QUEUED，而且用 compare-and-set 搶。**
 * `updateMany({ where: { id, status: 'QUEUED' } })` 的 `count` 是 0
 * 就代表別人搶走了。兩個 worker 實例同時跑時，一列只會被送一次
 * ——這與交卷的併發保護是同一個手法（見 `lib/attempt.ts`）。
 *
 * **二、`scheduledAt` 在未來的不撿。** 免打擾與節流就是靠它生效的，
 * 而在這裡多撿一列，前面兩段設計全部失效。
 *
 * **三、搶下來卻沒有結果的會被放回去。** 行程被 kill（OOM、部署重啟）
 * 的那一列會永遠停在 SENDING，而沒有人再碰它。做法與
 * `detect-stuck-imports` 相同：超過時限就放回 QUEUED。
 *
 * @param {any} prisma
 * @param {{ now?: Date, limit?: number, send?: (row: any) => Promise<void> }} [opts]
 *   `send` 只有在真的要對外送東西時才需要。IN_APP 沒有這一步——
 *   那一列本身就是投遞，狀態轉換只是記帳。測試用它來製造失敗。
 * @returns {Promise<DeliverResult>}
 */
export async function deliverDue(prisma, opts = {}) {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? DELIVER_BATCH;
  const out = { sent: 0, failed: 0, dead: 0, suppressed: 0, rescued: 0 };

  const stuck = await prisma.notification.updateMany({
    where: { status: 'SENDING', scheduledAt: { lt: new Date(now.getTime() - STUCK_SENDING_MS) } },
    data: { status: 'QUEUED' },
  });
  out.rescued = stuck.count;

  const rows = await prisma.notification.findMany({
    where: { status: 'QUEUED', scheduledAt: { lt: now } },
    orderBy: { scheduledAt: 'asc' },
    take: limit,
    // `payload` 與 `dedupeKey` 也撈出來：真的要對外送東西的 `send`
    // 沒有 payload 就渲染不出內容，而 `dedupeKey` 是日誌上唯一讀得懂
    // 的身分（「哪一位家長的哪一件事送不出去」）。多這兩欄的成本是
    // 每列幾百個位元組，而批次有上限。
    select: {
      id: true,
      tenantId: true,
      recipientId: true,
      channel: true,
      templateKey: true,
      payload: true,
      dedupeKey: true,
      retryCount: true,
      scheduledAt: true,
    },
  });

  for (const row of rows) {
    const claimed = await prisma.notification.updateMany({
      where: { id: row.id, status: 'QUEUED' },
      data: { status: 'SENDING' },
    });
    if (claimed.count === 0) continue; // 別人搶走了

    if (!channelReady(row.channel)) {
      // 理論上進不來（`enqueueMany` 已經擋掉了），但渠道清單會改版，
      // 而一列舊的 QUEUED 可能是上一版留下來的。往「不送」倒。
      await prisma.notification.updateMany({
        where: { id: row.id },
        data: {
          status: 'SUPPRESSED',
          failReason: UNREADY_REASON[row.channel] ?? `渠道 ${row.channel} 沒有接。`,
        },
      });
      out.suppressed++;
      continue;
    }

    try {
      if (opts.send) await opts.send(row);
      await prisma.notification.updateMany({
        where: { id: row.id },
        data: { status: 'SENT', sentAt: now, failReason: null },
      });
      out.sent++;
    } catch (e) {
      const n = (row.retryCount ?? 0) + 1;
      const why = e instanceof Error ? e.message : String(e);
      const dead = n >= MAX_RETRY;
      await prisma.notification.updateMany({
        where: { id: row.id },
        data: {
          status: dead ? 'FAILED' : 'QUEUED',
          retryCount: n,
          // **失敗的原因要看得到。** 只印在日誌裡的話，一週後查
          // 「這位家長為什麼沒收到」時什麼都不剩。
          failReason: dead
            ? `第 ${n} 次送出失敗：${why}（已達重試上限 ${MAX_RETRY}，不再重試）`
            : `第 ${n} 次送出失敗：${why}`,
          // 退避：失敗多半是對方暫時不通，立刻重試只是再失敗一次。
          scheduledAt: dead ? row.scheduledAt : new Date(now.getTime() + backoffMs(n)),
        },
      });
      if (dead) out.dead++;
      else out.failed++;
    }
  }
  return out;
}

/** 退避：1、2、4、8 分鐘，上限 15 分鐘。 */
function backoffMs(attempt) {
  return Math.min(15, 2 ** (attempt - 1)) * 60_000;
}

// ─────────────────────────────────────────────────────────────────
// 資料層：讀取（收件匣）
// ─────────────────────────────────────────────────────────────────

/**
 * 一個人的未讀數。
 *
 * 只算 **SENT 而且沒讀過而且在地平線內**的。三個條件各有理由：
 * QUEUED 的還沒出現在收件匣裡（點進去看不到那一則，數字就在說謊）；
 * SUPPRESSED 與 FAILED 的永遠不會出現；而地平線的理由見
 * `UNREAD_HORIZON_DAYS`。
 *
 * @param {any} prisma
 * @param {string} recipientId
 * @param {{ now?: Date }} [opts]
 */
export function unreadCount(prisma, recipientId, opts = {}) {
  const now = opts.now ?? new Date();
  return prisma.notification.count({
    where: {
      recipientId,
      status: 'SENT',
      readAt: null,
      createdAt: { gt: new Date(now.getTime() - UNREAD_HORIZON_DAYS * 86_400_000) },
    },
  });
}

/**
 * 收件匣的一頁。
 *
 * # 為什麼是游標而不是頁碼
 *
 * 因為這份清單的頭一直在長。用 `skip` 的話，讀完第一頁、期間來了
 * 兩則新的，第二頁會把第一頁最後兩則再顯示一次——而使用者會以為
 * 自己看漏了。游標（`before`）看的是時間，新的東西進來不影響它。
 *
 * `take + 1` 是為了知道「還有更早的嗎」，多取的那一筆不畫出來。
 *
 * @param {any} prisma
 * @param {string} recipientId
 * @param {{ take?: number, before?: Date|null }} [opts]
 * @returns {Promise<{ rows: any[], hasMore: boolean }>}
 */
export async function inboxPage(prisma, recipientId, opts = {}) {
  const take = opts.take ?? 40;
  const rows = await prisma.notification.findMany({
    where: {
      recipientId,
      // 收件匣是「已經送到的東西」。排在未來的那幾則不畫——
      // 畫了就等於免打擾時段沒有作用。
      status: 'SENT',
      ...(opts.before ? { createdAt: { lt: opts.before } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: take + 1,
    select: {
      id: true,
      templateKey: true,
      payload: true,
      createdAt: true,
      sentAt: true,
      readAt: true,
    },
  });
  return { rows: rows.slice(0, take), hasMore: rows.length > take };
}

/**
 * 標成已讀。
 *
 * **一定要帶 recipientId。** 只用 id 的話，任何人送一串別人的 id 就
 * 把別人的通知標成讀過了——RLS 擋得住別家補習班，擋不住同一間補習班
 * 的隔壁同學（理由與 `lib/attempt.ts` 的第三條規則完全相同）。
 *
 * `readAt` 只寫一次：已經讀過的不重新蓋時間。那個時刻是「他第一次
 * 看到」，蓋掉之後就沒有意義了。
 *
 * @param {any} prisma
 * @param {string} recipientId
 * @param {{ ids?: string[], all?: boolean, now?: Date }} opts
 * @returns {Promise<number>} 這一次真的標起來的筆數
 */
export async function markRead(prisma, recipientId, opts) {
  const now = opts.now ?? new Date();
  if (opts.all) {
    const r = await prisma.notification.updateMany({
      where: { recipientId, status: 'SENT', readAt: null },
      data: { readAt: now },
    });
    return r.count;
  }
  const ids = (opts.ids ?? []).filter((id) => typeof id === 'string' && id !== '');
  if (ids.length === 0) return 0;
  const r = await prisma.notification.updateMany({
    where: { id: { in: ids }, recipientId, status: 'SENT', readAt: null },
    data: { readAt: now },
  });
  return r.count;
}

// ─────────────────────────────────────────────────────────────────
// 資料層：家長
// ─────────────────────────────────────────────────────────────────

/**
 * 這幾位學生各自有哪些家長**收得到通知**。
 *
 * # 為什麼這裡有第二份，而 `lib/guardian.ts` 的 `notifiableGuardians` 已經存在
 *
 * 因為那一支是 TypeScript、而且 import 的是 `@/lib/prisma`，
 * 而**工作者是 `node scripts/worker.mjs`**：沒有 `@/` 別名、不編譯 .ts。
 * 逾期未交的通知是掃描產生的，只有工作者跑得到。
 *
 * 這一份不是「順手再寫一次」——它是同一條規則的批次版本
 * （一次問一位學生的話，一輪掃描是兩百次往返）。而**兩邊不可以
 * 分歧**，因為這條規則管的是「哪一位成年人收得到一個孩子的資料」：
 *
 *   · `verifiedAt` 不是 null —— 憑證確實交到那位法定代理人手上，
 *     由職員當面確認。未驗證的連結**不得作為任何推播的收件人**，
 *     理由見 `lib/guardian.ts` 那段長註解：通知是推出去的，收件人
 *     不需要持有密碼，所以「進得來就代表他有鑰匙」在這裡不成立。
 *     打錯一個字的家長信箱，寄出去的就是把成績交給陌生人。
 *   · `systemRole = GUARDIAN`、`status = ACTIVE`、`deletedAt = null`
 *     —— 停權與已刪除的帳號不該再收到孩子的資料。
 *
 * `tests/notify.test.mjs` 把兩支的 where 條件逐一對照（讀原始碼），
 * 任何一邊加了或少了一個條件都會紅。一句註解攔不住三個月後
 * 「順手」放寬其中一個條件的人，一條紅的測試攔得住。
 *
 * @param {any} prisma
 * @param {string[]} studentIds
 * @returns {Promise<Map<string, {id: string, tenantId: string}[]>>}
 */
export async function notifiableGuardianIds(prisma, studentIds) {
  /** @type {Map<string, {id: string, tenantId: string}[]>} */
  const out = new Map();
  const ids = [...new Set((studentIds ?? []).filter(Boolean))];
  if (ids.length === 0) return out;

  const links = await prisma.guardianLink.findMany({
    where: { studentId: { in: ids }, verifiedAt: { not: null } },
    select: { guardianId: true, studentId: true },
  });
  if (links.length === 0) return out;

  const guardians = await prisma.user.findMany({
    where: {
      id: { in: [...new Set(links.map((l) => l.guardianId))] },
      systemRole: 'GUARDIAN',
      status: 'ACTIVE',
      deletedAt: null,
    },
    select: { id: true, tenantId: true },
  });
  const byId = new Map(guardians.map((g) => [g.id, g]));

  for (const l of links) {
    const g = byId.get(l.guardianId);
    if (!g) continue;
    const arr = out.get(l.studentId) ?? [];
    arr.push({ id: g.id, tenantId: g.tenantId });
    out.set(l.studentId, arr);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// 產生：掃描
// ─────────────────────────────────────────────────────────────────

/**
 * 現在有考試正在進行嗎。
 *
 * 有的話整輪掃描跳過。理由見檔頭第四條：掃描是冪等的，下一輪
 * 補得回來；考試不能等。
 *
 * @param {any} prisma
 * @param {{ now?: Date, threshold?: number }} [opts]
 */
export async function examBusy(prisma, opts = {}) {
  const now = opts.now ?? new Date();
  const n = await prisma.attempt.count({
    where: { status: 'IN_PROGRESS', expiresAt: { gt: now } },
  });
  return n >= (opts.threshold ?? EXAM_BUSY_ATTEMPTS);
}

/**
 * 把一批任務展開成「學生 → 他還沒交的那幾份」。
 *
 * 快到期與逾期未交共用這一段：兩者的差別只有「哪些任務算進來」，
 * 而「誰還沒交」的判斷完全相同。分開寫的話，其中一邊遲早會漏掉
 * 「離班的不算」或「已交的不算」，而那時另一邊是對的——
 * 兩個名單對不起來時沒有人說得出哪一個對。
 *
 * @param {any} prisma
 * @param {{id: string, tenantId: string, title: string, dueAt: Date|null, allowLate: boolean}[]} assignments
 * @returns {Promise<Map<string, {tenantId: string, displayName: string, items: any[]}>>}
 */
async function pendingByStudent(prisma, assignments) {
  /** @type {Map<string, {tenantId: string, items: any[]}>} */
  const out = new Map();
  if (assignments.length === 0) return out;
  const ids = assignments.map((a) => a.id);
  const byId = new Map(assignments.map((a) => [a.id, a]));

  const targets = await prisma.assignmentTarget.findMany({
    where: { assignmentId: { in: ids } },
    select: { assignmentId: true, classId: true, userId: true },
  });
  if (targets.length === 0) return out;

  const classIds = [...new Set(targets.flatMap((t) => (t.classId ? [t.classId] : [])))];
  const directIds = [...new Set(targets.flatMap((t) => (t.userId ? [t.userId] : [])))];

  // **`leftAt: null` 就是「退出班級之後不再收到那個班的通知」。**
  // 這一個條件是整段掃描裡最容易漏、而漏了最沒有症狀的一個：
  // 轉出去的學生繼續收到前一個班的催繳，而他已經沒有那份作業了。
  const memberships = classIds.length
    ? await prisma.classMembership.findMany({
        where: { classId: { in: classIds }, role: 'STUDENT', leftAt: null },
        select: { classId: true, userId: true },
      })
    : [];

  const candidates = [...new Set([...memberships.map((m) => m.userId), ...directIds])];
  if (candidates.length === 0) return out;
  const users = await prisma.user.findMany({
    where: { id: { in: candidates }, systemRole: 'STUDENT', deletedAt: null },
    select: { id: true, tenantId: true, displayName: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  /** @type {Map<string, string[]>} */
  const membersOfClass = new Map();
  for (const m of memberships) {
    const arr = membersOfClass.get(m.classId) ?? [];
    arr.push(m.userId);
    membersOfClass.set(m.classId, arr);
  }
  const byAssignment = recipientsByAssignment(
    targets,
    membersOfClass,
    new Set(userById.keys()),
  );

  // 交過卷的不算。**次數用完但沒交的也算沒交**——那一份對他就是
  // 一份沒有交出去的作業，而他要知道。
  const done = await prisma.attempt.findMany({
    where: { assignmentId: { in: ids }, status: { in: ['SUBMITTED', 'GRADED'] } },
    select: { assignmentId: true, userId: true },
  });
  const doneSet = new Set(done.map((d) => `${d.assignmentId}|${d.userId}`));

  for (const [assignmentId, students] of byAssignment) {
    const a = byId.get(assignmentId);
    if (!a) continue;
    for (const uid of students) {
      if (doneSet.has(`${assignmentId}|${uid}`)) continue;
      const u = userById.get(uid);
      if (!u) continue;
      // **租戶必須對得上。** 掃描是跨租戶跑的，而 tenantId 決定這一列
      // 通知屬於誰；對不上時寫下去就是把一家補習班的資料放進另一家。
      // 資料上這不該發生（任務的對象都在同一個租戶裡），所以不修正、
      // 直接跳過——靜靜地「修好」一個不可能的狀態只會藏住真正的問題。
      if (u.tenantId !== a.tenantId) continue;
      const entry = out.get(uid) ?? { tenantId: u.tenantId, items: [], displayName: u.displayName };
      entry.items.push(a);
      out.set(uid, entry);
    }
  }
  // 每個人的清單依截止時間排序：文案裡「最近的一份」要真的是最近的。
  for (const entry of out.values()) {
    entry.items.sort((x, y) => (x.dueAt?.getTime() ?? 0) - (y.dueAt?.getTime() ?? 0));
  }
  return out;
}

/** 摘要文案要的那幾個欄位。最多三個名稱，其餘用數字帶過。 */
function digestPayload(items) {
  return {
    count: items.length,
    titles: items.slice(0, 3).map((a) => a.title),
    dueAt: items[0]?.dueAt ? new Date(items[0].dueAt).toISOString() : null,
  };
}

/**
 * 快到期還沒交（學生）。
 *
 * # 為什麼不通知家長
 *
 * 見 `notifyTemplates.mjs` 的 `assignment.overdue.guardian`：截止前
 * 家長沒有做得到的下一步，而把「催」變成每週三次的推播，兩邊都會
 * 開始忽略它。家長那一側只留「已經逾期」——那是事實而不是預測。
 *
 * # 還沒開放的不算
 *
 * `openAt` 還沒到的任務就算 24 小時內截止也不提醒：學生現在按不下去，
 * 而一則做不到下一步的通知只是噪音。這種設定本身有問題（開放窗口
 * 比作答時間短），那是老師要處理的事。
 *
 * @param {any} prisma
 * @param {{ now?: Date }} [opts]
 */
export async function sweepDueSoon(prisma, opts = {}) {
  const now = opts.now ?? new Date();
  const assignments = await prisma.assignment.findMany({
    where: {
      dueAt: { gt: now, lt: new Date(now.getTime() + DUE_SOON_MS) },
      OR: [{ openAt: null }, { openAt: { lt: now } }],
    },
    select: { id: true, tenantId: true, title: true, dueAt: true, allowLate: true },
  });
  const pending = await pendingByStudent(prisma, assignments);

  const day = taipeiDay(now);
  /** @type {NotifySpec[]} */
  const specs = [];
  for (const [userId, entry] of pending) {
    specs.push({
      tenantId: entry.tenantId,
      recipientId: userId,
      templateKey: 'assignment.due_soon',
      // **一天一則，不管有幾份。** 去重鍵用台灣日期而不是 assignmentId，
      // 理由見 `dedupeKey`：六份的下一步完全相同，六列一樣的東西會把
      // 真正個別的事情擠出畫面。
      scope: day,
      payload: digestPayload(entry.items),
    });
  }
  return enqueueMany(prisma, specs, { now });
}

/**
 * 逾期未交（學生 ＋ 已驗證的家長）。
 *
 * 往回只看 `OVERDUE_LOOKBACK_MS`，理由見那個常數。
 *
 * @param {any} prisma
 * @param {{ now?: Date }} [opts]
 */
export async function sweepOverdue(prisma, opts = {}) {
  const now = opts.now ?? new Date();
  const assignments = await prisma.assignment.findMany({
    where: { dueAt: { gt: new Date(now.getTime() - OVERDUE_LOOKBACK_MS), lt: now } },
    select: { id: true, tenantId: true, title: true, dueAt: true, allowLate: true },
  });
  const pending = await pendingByStudent(prisma, assignments);
  if (pending.size === 0) return { created: 0, skipped: 0, suppressed: 0 };

  const day = taipeiDay(now);
  const guardians = await notifiableGuardianIds(prisma, [...pending.keys()]);

  /** @type {NotifySpec[]} */
  const specs = [];
  for (const [userId, entry] of pending) {
    const base = digestPayload(entry.items);
    // 「還收遲交嗎」決定下一步是「現在去交」還是「找老師」，而那兩件
    // 事差很多。整批裡只要有一份還收遲交就算——**寧可多說一句
    // 「有幾份還交得出去」，也不要叫一個交得出去的人去找老師**。
    const canStillSubmit = entry.items.some((a) => a.allowLate === true);
    specs.push({
      tenantId: entry.tenantId,
      recipientId: userId,
      templateKey: 'assignment.overdue',
      scope: day,
      payload: { ...base, canStillSubmit },
    });
    for (const g of guardians.get(userId) ?? []) {
      // 家長與孩子不同租戶是不可能的（連結建立時在同一個租戶脈絡下），
      // 但這裡是跨租戶掃描，所以還是對一次。
      if (g.tenantId !== entry.tenantId) continue;
      specs.push({
        tenantId: g.tenantId,
        recipientId: g.id,
        templateKey: 'assignment.overdue.guardian',
        // 一位家長兩個孩子時要兩則（各自的名字與連結不同），
        // 所以 scope 帶上 studentId。
        scope: `${userId}:${day}`,
        // **只有這幾個欄位。** 沒有分數、沒有逐題、沒有智慧老師的
        // 對話——家長那一份是投影，欄位只減不加（見 lib/guardian.ts）。
        payload: {
          ...base,
          canStillSubmit,
          childName: entry.displayName ?? '孩子',
          studentId: userId,
        },
      });
    }
  }
  return enqueueMany(prisma, specs, { now });
}

/**
 * 匯入完成／失敗（老師）。
 *
 * # 為什麼是掃描狀態，而不是在管線裡呼叫一次
 *
 * 因為「匯入結束了」有**三條路徑**：管線正常跑完、BullMQ 判定不可
 * 重試而放棄、以及 `detect-stuck-imports` 把一份卡住的標成失敗。
 * 在三處各加一行的話，遲早有一條路徑沒加到——而漏掉的最可能是
 * 第三條（那正是老師最需要被告知的一條：他看到的是一個轉了三小時
 * 的進度條）。
 *
 * 狀態是資料庫裡的事實，掃描它就不會漏。而去重鍵讓「掃到同一份
 * 十次」只產生一則。
 *
 * @param {any} prisma
 * @param {{ now?: Date }} [opts]
 */
export async function sweepImports(prisma, opts = {}) {
  const now = opts.now ?? new Date();
  const jobs = await prisma.importJob.findMany({
    where: {
      status: { in: ['READY_FOR_REVIEW', 'FAILED'] },
      updatedAt: { gt: new Date(now.getTime() - STAFF_LOOKBACK_MS) },
    },
    select: {
      id: true,
      tenantId: true,
      title: true,
      status: true,
      error: true,
      createdBy: true,
      totalCandidates: true,
    },
  });

  /** @type {NotifySpec[]} */
  const specs = [];
  for (const j of jobs) {
    // 建立者被刪除之後 `createdBy` 是 null（ON DELETE SET NULL）。
    // 沒有收件人就沒有通知——這一份會留在匯入列表上，那是對的：
    // 通知是給人的，而那個人已經不在了。
    if (!j.createdBy) continue;
    specs.push({
      tenantId: j.tenantId,
      recipientId: j.createdBy,
      templateKey: j.status === 'FAILED' ? 'import.failed' : 'import.ready',
      scope: j.id,
      payload: {
        jobId: j.id,
        title: j.title,
        candidates: j.totalCandidates ?? 0,
        // 失敗原因是給老師看的下一步（「從哪一階段繼續」就在裡面），
        // 但它可能很長。截短，完整的在進度頁上。
        error: j.status === 'FAILED' ? clip(j.error, 180) : null,
      },
    });
  }
  return enqueueMany(prisma, specs, { now });
}

/**
 * 有非選題等你閱卷（老師）。
 *
 * 判斷用 `status = SUBMITTED` 而且 `gradedAt` 不是 null：計分跑過了，
 * 卻沒有升成 GRADED——那正是 `lib/scoring.ts` 在
 * `pendingManual > 0 || unresolvedReview > 0` 時做的事。
 * 不去數 `attemptAnswer` 是刻意的：那張表一份卷子幾十列，
 * 一輪掃描會變成幾萬列的統計，而這裡只需要知道「有沒有」。
 *
 * 收件人是**派出這份任務的人**（`createdBy`）。用授課老師的話要多查
 * 兩張表，而且一份跨科小考會通知到一個沒有派過它的人；
 * 派出去的人一定是知道這份任務存在的那一個。
 *
 * @param {any} prisma
 * @param {{ now?: Date }} [opts]
 */
export async function sweepGrading(prisma, opts = {}) {
  const now = opts.now ?? new Date();
  const waiting = await prisma.attempt.findMany({
    where: {
      status: 'SUBMITTED',
      gradedAt: { not: null },
      submittedAt: { gt: new Date(now.getTime() - STAFF_LOOKBACK_MS) },
    },
    select: { assignmentId: true },
  });
  if (waiting.length === 0) return { created: 0, skipped: 0, suppressed: 0 };

  /** @type {Map<string, number>} */
  const countByAsg = new Map();
  for (const a of waiting) countByAsg.set(a.assignmentId, (countByAsg.get(a.assignmentId) ?? 0) + 1);

  const assignments = await prisma.assignment.findMany({
    where: { id: { in: [...countByAsg.keys()] } },
    select: { id: true, tenantId: true, title: true, createdBy: true },
  });

  /** @type {NotifySpec[]} */
  const specs = [];
  for (const a of assignments) {
    if (!a.createdBy) continue;
    specs.push({
      tenantId: a.tenantId,
      recipientId: a.createdBy,
      templateKey: 'grading.pending',
      // **一份任務一則，不是每天一則。** 卷子是陸續交上來的，
      // 每天播報「還有 12 份沒改」會變成一個永遠不消失的東西——
      // 那是首頁待辦的工作。收件匣說的是「這件事開始了」。
      scope: a.id,
      payload: { assignmentId: a.id, title: a.title, count: countByAsg.get(a.id) ?? 1 },
    });
  }
  return enqueueMany(prisma, specs, { now });
}

/**
 * 一輪完整的產生。工作者呼叫這一支。
 *
 * 每一支掃描各自 try/catch：一支壞掉不該讓其他三支停擺（與
 * `scripts/worker.mjs` 的 `tick` 同一條原則，只是這裡的粒度更細——
 * 逾期未交壞掉時，匯入完成的通知沒有理由跟著消失）。
 *
 * @param {any} prisma
 * @param {{ now?: Date, log?: (msg: string) => void }} [opts]
 */
export async function generateAll(prisma, opts = {}) {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const total = { created: 0, skipped: 0, suppressed: 0, failures: [] };
  const sweeps = [
    ['due_soon', sweepDueSoon],
    ['overdue', sweepOverdue],
    ['imports', sweepImports],
    ['grading', sweepGrading],
  ];
  for (const [name, fn] of sweeps) {
    try {
      const r = await fn(prisma, { now });
      total.created += r.created;
      total.skipped += r.skipped;
      total.suppressed += r.suppressed;
      if (r.created > 0 || r.suppressed > 0) {
        log(`[notify:${name}] 新增 ${r.created} 則、抑制 ${r.suppressed} 則、已有 ${r.skipped} 則`);
      }
    } catch (e) {
      total.failures.push(`${name}：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return total;
}

/** 截短一段字，尾巴加刪節號。 */
function clip(s, max) {
  if (typeof s !== 'string' || s === '') return null;
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
