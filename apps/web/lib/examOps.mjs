/**
 * 考試營運：派卷之後到成績出來之間，那幾件「畫面上算得出來、
 * 但兩個畫面各算一次就會不一樣」的事。
 *
 * # 這個檔案收的是哪一類判斷
 *
 * 三件事，共同點是**它們都同時有兩個以上的讀者**：
 *
 *   · **有沒有作答**（`hasAnswer`）。學生的作答頁靠它算「已寫 11 題」，
 *     老師的成績頁靠它算「已作答 18 / 25」。兩份實作的後果不是當機，
 *     是老師看著一個比實際高的數字做決定——「已作答 22/25，讓他繼續
 *     寫吧」，而那個人其實只寫了 11 題。差在哪裡：`attempt_answers`
 *     有列不代表有答案，按了「標記待複查」與點了選項又取消都會留下
 *     一列空的。
 *
 *   · **應交／已開始／已交卷／未動作**（`rosterTally`）。這四個數字要
 *     加得起來，而它們的來源是兩份完全不同的資料：名單來自
 *     `resolveRecipients`（派給了誰），作答來自 `attempts`（誰動過）。
 *     只用後者的話，**連考卷都沒打開的那個人在每一塊裡都不存在**，
 *     而「我沒收到」正是要從他身上查起。
 *
 *   · **這一題的分數是人給的嗎**（`isManualScore`）。重新計分會把
 *     每一題重算一次，而老師手動改過的那一題不可以被蓋掉——蓋掉的
 *     症狀是一個已經處理完的申訴在下一次重算時默默倒退，而總分少掉
 *     那幾分。沒有欄位可以記這件事（不加遷移），所以記在 `scoreNote`
 *     的開頭，而讀寫兩邊必須是同一個字串。
 *
 * 全部是純函式：不碰資料庫、不碰 React，有單元測試（tests/examOps.test.mjs）。
 */

// ─────────────────────────────────────────────────────────────────
// 有沒有作答
// ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} AnswerRow
 * @property {number[]} answerKeys
 * @property {string|null} [answerText]
 * @property {unknown} [answerSlots] jsonb，形狀是 `[{ slot, value }]`
 */

/**
 * 這一列有沒有真的寫東西。
 *
 * 「有作答」是指選了選項、打了字、或填了格位裡的任何一格。
 * **只按了「標記待複查」不算**，那是提醒自己回來看的記號；
 * **點了選項又點一次取消也不算**，那一列的 `answerKeys` 會被覆蓋成空。
 *
 * @param {AnswerRow} row
 * @returns {boolean}
 */
export function hasAnswer(row) {
  if (!row) return false;
  if (Array.isArray(row.answerKeys) && row.answerKeys.length > 0) return true;
  if (typeof row.answerText === 'string' && row.answerText.trim() !== '') return true;
  const slots = row.answerSlots;
  if (Array.isArray(slots)) {
    return slots.some(
      (s) =>
        s != null &&
        typeof s === 'object' &&
        !Array.isArray(s) &&
        String(/** @type {Record<string, unknown>} */ (s).value ?? '').trim() !== '',
    );
  }
  return false;
}

/**
 * 一份作答裡真的寫了幾題。
 *
 * @param {AnswerRow[]} rows
 * @returns {number}
 */
export function countAnswered(rows) {
  return (rows ?? []).filter((r) => hasAnswer(r)).length;
}

// ─────────────────────────────────────────────────────────────────
// 應交 vs 交卷
// ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} TallyRecipient
 * @property {string} userId
 */

/**
 * @typedef {object} TallyAttempt
 * @property {string} userId
 * @property {string} status IN_PROGRESS / SUBMITTED / GRADED / VOIDED
 */

/**
 * @typedef {object} RosterTally
 * @property {number} expected 應交人數。**以名單為準，不是以作答為準。**
 * @property {number} started 開過考卷的人數（含已交、含作廢過的）
 * @property {number} submitted 已經交卷的人數（SUBMITTED / GRADED）
 * @property {number} inProgress 還掛在進行中的人數
 * @property {number} untouched 名單上但連考卷都沒打開的人數
 * @property {string[]} untouchedIds 那幾位是誰。**老師當下要打電話的名單。**
 * @property {string[]} strangerIds 有作答記錄但不在名單上的人。
 */

/**
 * 四個數字，以及「未動作」那份名單。
 *
 * # 為什麼要「以人」而不是「以份」算
 *
 * 可作答多次的任務裡一個人有好幾份 attempt。用份數的話，一個練習
 * 做了三次的學生會讓「已交卷」比「應交」還多，而老師看到的是一張
 * 對不起來的表。所以每一段都先 `Set` 去重。
 *
 * # 為什麼「有作答但不在名單上」要單獨列出來而不是丟掉
 *
 * 兩種來源：老師把自己個別指定進去試考（那是刻意的），以及學生
 * 離開了班級名冊而作答記錄還在。兩種都不該混進應交人數，但也不能
 * 靜靜地消失——**名單上少一個人比多一個人難查得多**。
 *
 * @param {TallyRecipient[]} recipients
 * @param {TallyAttempt[]} attempts
 * @returns {RosterTally}
 */
export function rosterTally(recipients, attempts) {
  const expectedIds = new Set((recipients ?? []).map((r) => r.userId));
  const started = new Set();
  const submitted = new Set();
  const inProgress = new Set();
  const strangers = new Set();

  for (const a of attempts ?? []) {
    if (!a || !a.userId) continue;
    if (!expectedIds.has(a.userId)) {
      strangers.add(a.userId);
      continue;
    }
    started.add(a.userId);
    if (a.status === 'SUBMITTED' || a.status === 'GRADED') submitted.add(a.userId);
    if (a.status === 'IN_PROGRESS') inProgress.add(a.userId);
  }

  const untouchedIds = [...expectedIds].filter((id) => !started.has(id));
  return {
    expected: expectedIds.size,
    started: started.size,
    submitted: submitted.size,
    // 同一個人可能既有交卷的一份、又有進行中的另一份（多次作答的任務）。
    // 這裡刻意不互斥：畫面上那兩塊本來就分開列，硬要互斥的話
    // 「進行中」會少掉正在寫第二次的那幾位。
    inProgress: inProgress.size,
    untouched: untouchedIds.length,
    untouchedIds,
    strangerIds: [...strangers],
  };
}

// ─────────────────────────────────────────────────────────────────
// 人工評分的記號
// ─────────────────────────────────────────────────────────────────

/**
 * 人工評分寫進 `scoreNote` 的開頭記號。
 *
 * **不加欄位、不加遷移**，所以這個字串就是唯一的憑據。改它等於讓
 * 之前所有手動給過的分數在下一次重新計分時被自動計分蓋掉——而那件事
 * 不會有錯誤訊息，只有幾個學生的分數悄悄變回去。
 */
export const MANUAL_SCORE_MARK = '人工評分';

/**
 * 這一題的分數是人給的嗎。
 *
 * @param {string|null|undefined} scoreNote
 * @returns {boolean}
 */
export function isManualScore(scoreNote) {
  return typeof scoreNote === 'string' && scoreNote.startsWith(MANUAL_SCORE_MARK);
}

/**
 * 把老師打的評語組成要存進 `scoreNote` 的字串。
 *
 * 一定帶得出「誰給的分數是人給的」，即使老師什麼都沒寫——沒有記號的
 * 那一次會在下一次重新計分時被蓋掉。
 *
 * @param {string|null|undefined} note 老師寫的評語，可以是空的
 * @returns {string}
 */
export function manualScoreNote(note) {
  const body = typeof note === 'string' ? note.trim() : '';
  return body ? `${MANUAL_SCORE_MARK}：${body}` : `${MANUAL_SCORE_MARK}（老師手動給分）`;
}

/**
 * 老師輸入的分數合不合法。
 *
 * @param {unknown} score 要給的分數。`null` 代表「收回人工分數，回到自動計分」。
 * @param {number} max 這一題在這份卷子上的配分
 * @returns {{ ok: true, score: number|null } | { ok: false, error: string }}
 */
export function checkManualScore(score, max) {
  if (score === null) return { ok: true, score: null };
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return { ok: false, error: '分數要填數字。要改回自動計分請按「取消人工分數」。' };
  }
  if (score < 0) return { ok: false, error: '分數不能是負的。' };
  if (score > max) {
    return { ok: false, error: `這一題的配分是 ${max} 分，給不了 ${score} 分。` };
  }
  // 兩位小數。多選部分給分本來就會算出 2.4 這種值，而三位以上多半是
  // 打錯——而且它會讓總分出現 78.30000000000001 這種印出來的數字。
  return { ok: true, score: Math.round(score * 100) / 100 };
}
