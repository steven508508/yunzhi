/**
 * 一份作答的時鐘：現在還寫得進去嗎，寫不進去了又還沒交怎麼辦。
 *
 * # 這個檔案是為了一種完全沒有症狀的失敗而存在的
 *
 * 學生寫到一半筆電沒電、瀏覽器被關掉、網路斷了而且沒有再回來。
 * 那一份 `Attempt` 的 `expiresAt` 過了之後：
 *
 *   · 伺服器不收任何一題答案了（`saveAnswer` 擋掉）
 *   · 但狀態還是 `IN_PROGRESS`，`submittedAt` 是 null
 *   · 學生的任務清單把它算成「已作答 1 次」→ 次數用完 → 沒有按鈕
 *   · 老師的成績頁只查 SUBMITTED / GRADED → 這個人整列不存在
 *
 * 結果是：**他寫過的答案還在資料庫裡，但沒有任何人看得到，
 * 也沒有任何按鈕能把它結算出來。** 畫面上沒有錯誤、沒有警告，
 * 老師看到的是「這個人沒考」，學生看到的是「已完成，沒有分數」。
 *
 * 收掉這種作答的程式其實一直都在（`finalizeAttempt`），但它只在
 * 學生**再一次開始作答**時被順手呼叫到——而次數只有一次的考試，
 * 那條路永遠走不到。
 *
 * # 為什麼判斷抽成不碰資料庫的純函式
 *
 * 因為它同時被三個地方問：儲存答案時（還收不收）、老師代為結算時
 * （能不能收）、成績頁畫那一列時（要不要標成「卡住」）。三份各自
 * 寫一個 `if` 的話，最可能不一致的是邊界那一秒，而不一致的症狀是
 * 「按了代為結算卻說時間還沒到」——老師會覺得系統壞了。
 */

/**
 * @typedef {object} ClockAssignment
 * @property {Date|null} [dueAt]
 * @property {boolean} [allowLate]
 */

/**
 * @typedef {object} ClockAttempt
 * @property {string} status IN_PROGRESS / SUBMITTED / GRADED / VOIDED
 * @property {Date|null} [expiresAt] 開始作答的那一刻算出來的到期時刻。null = 不限時。
 * @property {ClockAssignment} [assignment] 這一份所屬任務的截止設定。
 *   **給了才會被考慮**——見 `attemptClosed`。
 */

/**
 * 這份作答現在還收不收得到答案。
 *
 * 兩個條件缺一不可：**還在進行中**，而且**沒有過期**。
 * 不限時（`expiresAt` 是 null）的一律收——那種作答學生隨時回得來，
 * 不是這個檔案要處理的問題。
 *
 * @param {ClockAttempt} attempt
 * @param {Date} [now]
 * @returns {boolean}
 */
export function attemptWritable(attempt, now = new Date()) {
  if (attempt.status !== 'IN_PROGRESS') return false;
  const expiresAt = attempt.expiresAt ?? null;
  return expiresAt == null || now <= expiresAt;
}

/**
 * 這一份**實質上已經結束了**——不管有沒有人按下交卷。
 *
 * # 為什麼它與 `attemptWritable` 不是同一個問題的反面
 *
 * `attemptWritable` 只看 `expiresAt`，而且必須只看它：那一欄是伺服器
 * 在開始作答時算好寫死的，`saveAnswer` 拿它決定收不收答案，前端的
 * 倒數也是照它算的。多看一個條件就會出現「畫面上還有 12 分鐘，
 * 伺服器卻不收了」。
 *
 * 但「這一份還要不要繼續等下去」是另一個問題，而它的答案在任務上：
 * **一份沒設時限的作答（`expiresAt` 是 null），在任務截止而且不收
 * 遲交之後，就再也不會有人來交它了。** 首頁的待辦本來就是這樣算的
 * （`app/(app)/page.tsx` 那句 OR），成績頁卻只看 `expiresAt`——於是
 * 同一份作答在兩個畫面上一個算卡住、一個算「還在作答時間內」，
 * 而錯誤訊息叫老師去把截止時間改成現在，那正是他剛剛做過的事。
 *
 * 所以 `assignment` 是**可選**的：不給就退回只看 `expiresAt` 的舊行為
 * （呼叫端沒查那兩欄時，寧可少判成卡住也不要誤判）；給了就把兩個
 * 畫面拉到同一條規則上。
 *
 * @param {ClockAttempt} attempt
 * @param {Date} [now]
 * @returns {boolean}
 */
export function attemptClosed(attempt, now = new Date()) {
  const expiresAt = attempt.expiresAt ?? null;
  if (expiresAt != null && now > expiresAt) return true;
  const a = attempt.assignment;
  if (a && a.allowLate !== true && a.dueAt != null && now > a.dueAt) return true;
  return false;
}

/**
 * 這一份是不是「卡住了」——時間到了、寫不進去了，卻還掛在進行中。
 *
 * 這就是上面說的那種作答。它與「正在考試中」的差別只有一個時刻的
 * 比較，而在畫面上兩者都顯示成「進行中」，所以老師分不出來哪一個
 * 該處理、哪一個要放著讓學生寫完。
 *
 * @param {ClockAttempt} attempt
 * @param {Date} [now]
 * @returns {boolean}
 */
export function attemptStranded(attempt, now = new Date()) {
  return attempt.status === 'IN_PROGRESS' && attemptClosed(attempt, now);
}

/**
 * 老師能不能代替這位學生把這一份收掉。
 *
 * # 只有「已經寫不進去」的才准，理由不是保守而是安全
 *
 * 過了 `expiresAt` 之後 `saveAnswer` 一題都不收，所以這時候結算
 * **不可能弄丟任何東西**——那一份實質上早就結束了，只差沒有人按
 * 下按鈕。反過來，如果准許老師收掉一份還在計時的作答，那就是
 * 在學生正在寫的時候把考卷抽走，而他的畫面上不會有任何提示：
 * 下一次自動存檔才會跳出「這份考卷已經交出去了」。
 *
 * 不限時的那些（`expiresAt` 是 null）也不准，而且理由是它們**不是
 * 死路**：學生的任務清單會把它算成進行中，「繼續作答」那顆按鈕
 * 一直都在，他隨時回得來。要結束那種考試，正確的做法是設一個
 * 截止時間，不是從老師這邊把它收掉。
 *
 * @param {ClockAttempt} attempt
 * @param {Date} [now]
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function checkFinalizeOnBehalf(attempt, now = new Date()) {
  if (attempt.status === 'VOIDED') {
    return { ok: false, error: '這一份已經作廢，不會計分，也不需要結算。' };
  }
  if (attempt.status !== 'IN_PROGRESS') {
    return { ok: false, error: '這一份已經交卷了。要重算分數請用「重新計分」。' };
  }
  if (attemptClosed(attempt, now)) return { ok: true };
  const a = attempt.assignment;
  if ((attempt.expiresAt ?? null) == null && !(a && a.dueAt != null)) {
    return {
      ok: false,
      error:
        '這一份沒有作答時限也沒有截止時間，學生的清單上還看得到「繼續作答」，' +
        '他隨時回得來——現在收掉等於把他寫到一半的考卷抽走。' +
        '要結束這場考試，請用任務頁的「立刻結束這場考試」，或把截止時間改成現在。',
    };
  }
  return {
    ok: false,
    error: '這位學生還在作答時間內。現在收掉會把他正在寫的考卷抽走，而他的畫面上不會有任何提示。',
  };
}

// ─────────────────────────────────────────────────────────────────
// 改動進行中的到期時刻
//
// # 為什麼這件事非做不可，而且非做成「改 expiresAt」不可
//
// 全班斷網十分鐘之後老師要補回來。改任務的 `timeLimitMin` 沒有用：
// 那一欄在有人開始作答之後就凍結了，而且**就算解凍也不會有作用**
// ——`expiresAt` 是開始作答那一刻算好寫死的，任務設定改了不會回頭
// 重算已經開始的那幾份。反方向也一樣：把截止時間改成現在，停不掉
// 正在寫的人，因為 `attemptWritable` 只看 `expiresAt`。
//
// 所以「延長」與「立刻結束」都只有一種做法：**直接改 attempts 的
// expiresAt**。判斷抽在這裡是因為它有三個呼叫端（整份任務一次延長、
// 單一學生延長、立刻結束），而三份各寫一個 if 的話，最可能不一致的
// 又是邊界那一秒。
// ─────────────────────────────────────────────────────────────────

/** 一次最多延長幾分鐘。與 `normalizeTimeLimit` 的上限同一個數字。 */
const MAX_EXTEND_MIN = 600;

/**
 * 延長的分鐘數合不合法。
 *
 * 只收正整數：`Number(input)` 對空字串回 0、對「10 分」回 NaN，而那兩種
 * 若當成 0 靜靜地通過，老師會看到「已延長」而學生的倒數一秒都沒變。
 *
 * @param {unknown} minutes
 * @returns {{ ok: true, minutes: number } | { ok: false, error: string }}
 */
export function checkExtendMinutes(minutes) {
  if (typeof minutes !== 'number' || !Number.isInteger(minutes)) {
    return { ok: false, error: '延長時間要填整數的分鐘數。' };
  }
  if (minutes <= 0) {
    return { ok: false, error: '延長時間要大於 0 分鐘。要提前結束請用「立刻結束這場考試」。' };
  }
  if (minutes > MAX_EXTEND_MIN) {
    return { ok: false, error: `一次最多延長 ${MAX_EXTEND_MIN} 分鐘，這通常是打錯了。` };
  }
  return { ok: true, minutes };
}

/**
 * 這一份可不可以延長，延長之後到期時刻是什麼。
 *
 * # 為什麼是「原本的到期時刻 ＋ N」而不是「現在 ＋ N」
 *
 * 因為老師要的是**全班一起多 N 分鐘**。用「現在 + N」的話，早交的人
 * 與晚交的人拿到的總時間不一樣，而且對已經過期幾分鐘的那幾份等於
 * 額外多送了那幾分鐘——同一場考試裡出現兩種長度，那正是
 * `lib/assignment.ts` 凍結時限想避免的事。
 *
 * 代價是：已經過期很久的那一份加 10 分鐘之後可能還是過期的。那是
 * 對的，而且呼叫端要說得出來（見回傳的 `reopened`）。
 *
 * **已交卷與已作廢的一律不動。** 交出去的分數不會因為別人延長而改變，
 * 這一條是延長這個功能能不能被信任的前提。
 *
 * @param {ClockAttempt} attempt
 * @param {number} minutes 已經過 `checkExtendMinutes` 的分鐘數
 * @param {Date} [now]
 * @returns {{ ok: true, expiresAt: Date, reopened: boolean } | { ok: false, error: string }}
 */
export function checkExtend(attempt, minutes, now = new Date()) {
  const valid = checkExtendMinutes(minutes);
  if (!valid.ok) return valid;
  if (attempt.status !== 'IN_PROGRESS') {
    return {
      ok: false,
      error:
        attempt.status === 'VOIDED'
          ? '這一份已經作廢，延長時間對它沒有作用。'
          : '這一份已經交卷了，延長時間不會把他拉回考試中。',
    };
  }
  const expiresAt = attempt.expiresAt ?? null;
  if (expiresAt == null) {
    return {
      ok: false,
      error:
        '這一份沒有到期時刻（任務沒設作答時限也沒設截止時間），本來就沒有時間壓力，' +
        '沒有東西可以延長。',
    };
  }
  const next = new Date(expiresAt.getTime() + minutes * 60_000);
  // 原本已經寫不進去、加完之後又寫得進去 = 這位學生真的被救回來了。
  // 老師要看到的是這個數字，而不是「更新了 32 筆」。
  return { ok: true, expiresAt: next, reopened: now > expiresAt && now <= next };
}

/**
 * 這一份可不可以「立刻結束」。
 *
 * 把到期時刻設成現在。**這是唯一停得掉正在作答的人的方法**——改任務
 * 的截止時間只擋得住還沒開始的人（`attemptWritable` 只看 `expiresAt`），
 * 而畫面上那句「要立刻結束這場考試，把截止時間改成現在」一直在教
 * 老師走那條沒有作用的路。
 *
 * 已經結束的不重複動：把 `expiresAt` 往後挪到現在等於偷偷送了幾分鐘。
 *
 * @param {ClockAttempt} attempt
 * @param {Date} [now]
 * @returns {{ ok: true, expiresAt: Date } | { ok: false, error: string }}
 */
export function checkEndNow(attempt, now = new Date()) {
  if (attempt.status !== 'IN_PROGRESS') {
    return { ok: false, error: '這一份已經不在進行中了。' };
  }
  if (attemptClosed(attempt, now)) {
    return { ok: false, error: '這一份的作答時間已經結束了，不需要再結束一次。' };
  }
  return { ok: true, expiresAt: now };
}
