/**
 * 作廢一份作答，以及撤銷作廢。
 *
 * # 這個狀態原本零個寫入者
 *
 * `AttemptStatus.VOIDED` 在 schema 裡從第一天就存在，計分那一側也
 * 判它（`gradeAttemptById` 拒絕計分、`classStats` 不查它、
 * `maySeeResult` 給學生一句人話、`startAttempt` 不把它算進作答次數），
 * `deleteAssignment` 的錯誤訊息甚至叫老師「把 Attempt 標成 VOIDED」——
 * **而全 repo 沒有任何一行程式把任何一份作答標成 VOIDED。**
 *
 * 於是抓到作弊、或斷電毀掉一份卷子的時候，老師手上只有兩個選擇：
 * 留著那個分數，或者刪掉整份任務。前者是把作弊的成績算進全班統計，
 * 後者會連同其他三十個人的作答一起消失。
 *
 * # 為什麼判斷抽成純函式
 *
 * 因為「這一份現在可不可以作廢」有三個問的地方：API 路由、成績頁
 * 畫不畫按鈕、以及寫入前的最後一道。三份各寫一個 `if` 的話，最先
 * 不一致的會是 IN_PROGRESS 那一格，而症狀是老師看得到按鈕、
 * 按下去被拒絕——他會以為系統壞了，而不是「這一份不該作廢」。
 *
 * 與 `lib/attemptClock.mjs`、`lib/release.mjs` 同一個分工。
 */

/**
 * @typedef {object} VoidAttempt
 * @property {string} status IN_PROGRESS / SUBMITTED / GRADED / VOIDED
 * @property {Date|null} [submittedAt] 交卷時刻。撤銷時要靠它決定還原成什麼。
 */

/** 作廢的理由至少要這麼長。少於這個字數的「作廢」「錯誤」說明不了任何事。 */
export const MIN_REASON = 4;
export const MAX_REASON = 500;

/**
 * 理由夠不夠。
 *
 * # 為什麼理由是必填，而且擋在這裡
 *
 * 作廢一個學生的成績是**會被家長質疑的動作**，而三個月後唯一還在的
 * 東西就是稽核裡的這一句。空白的理由等於沒有稽核：記錄上會寫著
 * 「王老師在 9 月 3 日作廢了這一份」，然後沒有人說得出為什麼。
 *
 * 前端當然也擋，但前端擋的是誤觸，不是規則——規則要在寫入之前。
 *
 * @param {unknown} reason
 * @returns {{ ok: true, reason: string } | { ok: false, error: string }}
 */
export function checkReason(reason) {
  const clean = typeof reason === 'string' ? reason.trim() : '';
  if (clean.length < MIN_REASON) {
    return {
      ok: false,
      error:
        '請寫下作廢的原因。這一句是日後家長或學生問起時唯一說得出來的東西，' +
        '例如「監考記錄第 3 條：作答中使用手機」或「教室跳電，這一份只剩前 4 題」。',
    };
  }
  if (clean.length > MAX_REASON) {
    return { ok: false, error: `作廢原因太長，請控制在 ${MAX_REASON} 字以內。` };
  }
  return { ok: true, reason: clean };
}

/**
 * 這一份現在作廢得了嗎。
 *
 * # 三種來源狀態都准，包含還在寫的那一份
 *
 * 抓到作弊的時間點多半就是**考試進行中**——監考老師走過去看到手機，
 * 這時候要能立刻讓那一份不算數。擋掉 IN_PROGRESS 的話，老師只能
 * 等他考完再處理，而那段時間學生還在繼續作答。
 *
 * 作廢一份進行中的作答之後，學生那一側是有話可說的：`saveAnswer`
 * 與 `submitAttempt` 都會回「這份作答已經被作廢，請找老師處理」
 * （見 lib/attempt.ts），不是一個看不懂的錯誤。
 *
 * # 已經作廢的要擋，而且不能靜靜地成功
 *
 * 兩位老師同時看著同一頁時，後按的那一位會以為是自己作廢的，
 * 而他填的那個理由不會被寫進去——稽核上留下的是前一位的說法。
 *
 * @param {VoidAttempt} attempt
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function checkVoid(attempt) {
  if (attempt.status === 'VOIDED') {
    return {
      ok: false,
      error: '這一份已經作廢了。重新整理看看是不是別人剛按的——作廢的原因記在稽核裡。',
    };
  }
  if (!KNOWN.has(attempt.status)) {
    // 認不得的狀態一律不動。日後 schema 多一個值而這裡忘了跟上時，
    // 症狀是「作廢不了」——那會被回報；反過來預設放行的話，
    // 是把一份狀態不明的作答改成 VOIDED，而那不可逆。
    return { ok: false, error: '這一份作答的狀態看不懂，先不要動它。請告訴系統管理員。' };
  }
  return { ok: true };
}

const KNOWN = new Set(['IN_PROGRESS', 'SUBMITTED', 'GRADED', 'VOIDED']);

/**
 * 撤銷作廢時，這一份要回到哪一個狀態。
 *
 * # 為什麼不記住「作廢之前是什麼」
 *
 * 因為沒有欄位可以記。`Attempt` 上沒有 previousStatus，而上線前一天
 * 加一個欄位、跑一次遷移，風險遠大於這件事的價值。所以還原目標
 * **從現有的資料推出來**，而推得出來的只有一件事：`submittedAt`
 * 有沒有值。
 *
 * # 為什麼交過卷的一律回 SUBMITTED，而不是 GRADED
 *
 * 因為兩種猜錯的代價不對稱。
 *
 *   · 猜成 GRADED 而其實還有非選題沒改 → 畫面上寫著「已評分」，
 *     老師以為處理完了，那 25 分永遠不會被補上。這正是 lib/scoring.ts
 *     檔頭警告的那種錯。
 *   · 猜成 SUBMITTED 而其實早就評完了 → 狀態欄顯示「待評分」，
 *     老師按一次「重新計分」就回到已評分。**自己會好。**
 *
 * 分數本身不受影響：作廢不清 `totalScore`，撤銷之後那個分數還在，
 * 只是被標成「等一次確認」。班級統計兩種狀態都算，所以撤銷完
 * 立刻就回到平均裡。
 *
 * @param {VoidAttempt} attempt
 * @returns {'IN_PROGRESS'|'SUBMITTED'}
 */
export function restoreStatus(attempt) {
  return (attempt.submittedAt ?? null) == null ? 'IN_PROGRESS' : 'SUBMITTED';
}

/**
 * 撤銷得了嗎，以及撤銷之後會變成什麼。
 *
 * # 還原成 IN_PROGRESS 的那一種要說清楚
 *
 * 一份還沒交卷就被作廢的作答，撤銷之後回到進行中——而它的
 * `expiresAt` 在作廢期間照樣走。學生可能回得去（時限還沒到），
 * 也可能一回去就是「時間已到」。兩種都是誠實的結果，但老師按下
 * 撤銷之前要知道會是哪一種，所以這裡把它講出來，由畫面顯示。
 *
 * @param {VoidAttempt} attempt
 * @returns {{ ok: true, status: 'IN_PROGRESS'|'SUBMITTED' } | { ok: false, error: string }}
 */
export function checkUnvoid(attempt) {
  if (attempt.status !== 'VOIDED') {
    return {
      ok: false,
      error: '這一份沒有作廢，沒有東西可以撤銷。重新整理看看是不是別人剛撤銷的。',
    };
  }
  return { ok: true, status: restoreStatus(attempt) };
}
