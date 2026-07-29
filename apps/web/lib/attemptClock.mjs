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
 * @typedef {object} ClockAttempt
 * @property {string} status IN_PROGRESS / SUBMITTED / GRADED / VOIDED
 * @property {Date|null} [expiresAt] 開始作答時就算好寫死的到期時刻。null = 不限時。
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
 * 這一份是不是「卡住了」——時間到了、寫不進去了，卻還掛在進行中。
 *
 * 這就是上面說的那種作答。它與「正在考試中」的差別只有一個
 * `expiresAt` 的比較，而在畫面上兩者都顯示成「進行中」，所以老師
 * 分不出來哪一個該處理、哪一個要放著讓學生寫完。
 *
 * @param {ClockAttempt} attempt
 * @param {Date} [now]
 * @returns {boolean}
 */
export function attemptStranded(attempt, now = new Date()) {
  return attempt.status === 'IN_PROGRESS' && !attemptWritable(attempt, now);
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
  if ((attempt.expiresAt ?? null) == null) {
    return {
      ok: false,
      error:
        '這一份沒有作答時限也沒有截止時間，學生的清單上還看得到「繼續作答」，' +
        '他隨時回得來——現在收掉等於把他寫到一半的考卷抽走。' +
        '要結束這場考試，請把任務的截止時間改成現在。',
    };
  }
  if (attemptWritable(attempt, now)) {
    return {
      ok: false,
      error: '這位學生還在作答時間內。現在收掉會把他正在寫的考卷抽走，而他的畫面上不會有任何提示。',
    };
  }
  return { ok: true };
}
