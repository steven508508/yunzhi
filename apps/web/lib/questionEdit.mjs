/**
 * 題目編輯與送分的**判斷規則**。純函式，只相依同樣是純函式的
 * `questionShape.mjs`。
 *
 * # 為什麼這一份要獨立出來
 *
 * 改題目是這套系統裡最危險的寫入路徑：一個判斷寫錯，症狀不是錯誤訊息，
 * 是**一整班的分數安靜地變成錯的**。而會算錯的那幾個判斷都不需要
 * 資料庫——它們只看「改前」與「改後」。抽出來就測得動
 * （`tests/question.test.mjs`），而 `lib/question.ts` 只負責讀寫。
 *
 * # 三個貫穿這份檔案的判斷
 *
 * **一、`answerKeys` 存的是選項的序號，所以序號的意義不能變。**
 * 這是這整份檔案存在的理由。學生的 `AttemptAnswer.answerKeys` 存的是
 * `[3]`，而「3」是靠 `question_options.order` 才有意義的。已經有人
 * 作答之後刪掉第 2 個選項，剩下的選項會重新編號，於是那個「3」
 * 指到的變成另一個選項——**畫面上他會看到自己選了一個沒選過的答案**，
 * 而重新計分會拿那個錯位的座標去判對錯。沒有任何錯誤訊息。
 * 見 `checkOptionStructure`。
 *
 * **二、改標準答案是安全的，改選項結構不是。** 前者只換掉「哪一個是
 * 對的」，座標系沒有動，所以重新計分之後每一份都會得到正確的結果，
 * 而學生當時選了什麼一個位元都沒變。後者會動座標系。這兩件事在畫面上
 * 長得很像（都是「改這一題」），所以規則要寫在同一個地方講清楚。
 *
 * **三、送分是題目上的一個旗標，不是把分數寫進作答記錄。**
 * 寫進作答記錄的話，下一次有人按「重新計分」就會把它蓋掉——而那個
 * 蓋掉不會有任何提示，老師只會在幾週後發現「我明明送過分了」。
 * 旗標存在 `Question.scoringRule.awardAll`，`lib/grading.mjs` 每次計分
 * 都會讀它，所以重算幾次結果都一樣。見 `readAward`。
 */
import { normalizeOptions } from './questionShape.mjs';

/**
 * 型別走 JSDoc，不另外寫一份 `.d.ts`（`lib/release.mjs` 也是這樣）。
 * 兩份宣告遲早會分岐，而分岐的那一次 TypeScript 仍然是綠的——
 * 它信的是宣告檔，而執行的是這一份。
 *
 * @typedef {object} OptionRow
 * @property {number|null} [origin] 這一列原本是第幾個選項（1 起算）。新增的列是 null。
 * @property {string|null} [label]
 * @property {string|null} [content]
 * @property {boolean} [correct] 這一列是標準答案之一
 *
 * @typedef {object} ShapedOption
 * @property {number} order
 * @property {string} label
 * @property {string} content
 *
 * @typedef {{ok: true, options: ShapedOption[], answerKeys: number[]}
 *          | {ok: false, error: string}} ShapedOptions
 *
 * @typedef {object} RetireAssignment
 * @property {string} assignmentId
 * @property {string} title
 * @property {Date|string|null} dueAt
 *
 * @typedef {object} RetireUse
 * @property {string} paperId
 * @property {string} paperTitle
 * @property {string} paperStatus
 * @property {RetireAssignment[]} assignments
 *
 * @typedef {object} RetireBlocker
 * @property {'assignment'|'paper'} kind
 * @property {string} id
 * @property {string} title
 * @property {string} why
 *
 * @typedef {object} Award
 * @property {string|null} at
 * @property {string|null} by
 * @property {string|null} byName
 * @property {string|null} reason
 * @property {string|null} assignmentId
 * @property {string|null} assignmentTitle
 */

// ─────────────────────────────────────────────────────────────
// 題型
// ─────────────────────────────────────────────────────────────

/**
 * 給人看的題型名稱。題庫、成績、編輯畫面共用一份，免得三處不一致。
 *
 * 標成 `Record<string, string>` 是為了讓 `TYPE_LABELS[q.type]` 這種用法
 * 成立——`q.type` 從資料庫回來時是 string，而推導出來的字面量型別
 * 會讓每一個呼叫端都得先斷言一次。
 * @type {Record<string, string>}
 */
export const TYPE_LABELS = {
  SINGLE_CHOICE: '單選',
  MULTI_CHOICE: '多選',
  FILL_SLOT: '選填',
  FILL_TEXT: '填空',
  SHORT_ANSWER: '簡答',
  ESSAY: '作文',
  TRANSLATION: '翻譯',
  TRUE_FALSE: '是非',
};

/**
 * 題型的「家族」——**答案存在哪一欄**。
 *
 *   CHOICE 存 answerKeys（選項序號）
 *   SLOT   存 answerSlots（答案卡格位）
 *   TEXT   存 answerText（自由書寫）
 *
 * 分家族是為了 `checkTypeChange`：單選改多選只是換一條計分公式，
 * 學生存的東西還是同一種；單選改填空則會讓已經存在的 `answerKeys`
 * 變成無人讀取的資料，而 `answerText` 是空的——**全班瞬間變成
 * 「未作答，0 分」，而且每一題看起來都被正常計分了**。
 */
export function typeFamily(type) {
  switch (String(type ?? '')) {
    case 'SINGLE_CHOICE':
    case 'MULTI_CHOICE':
    case 'TRUE_FALSE':
      return 'CHOICE';
    case 'FILL_SLOT':
      return 'SLOT';
    case 'FILL_TEXT':
    case 'SHORT_ANSWER':
    case 'ESSAY':
    case 'TRANSLATION':
      return 'TEXT';
    default:
      return 'UNKNOWN';
  }
}

// ─────────────────────────────────────────────────────────────
// 選項
// ─────────────────────────────────────────────────────────────

/**
 * 選項代號的重新編號。
 *
 * `label` 是印在學生眼前的那個代號（`(1)` `(2)`），與 `order` 是兩回事：
 * 匯入的題本可能用 `(A)(B)(C)` 或 `甲乙丙`，那是原稿的一部分，不能亂改。
 *
 * 所以只在**現有代號整組就是 1..n 這種預設編號**時才重編。老師刪掉
 * 第 2 個選項之後，畫面上剩下 `(1)(3)(4)` 是明顯的錯誤，但把 `(A)(C)(D)`
 * 硬改成 `(A)(B)(C)` 也是錯的——後者是在竄改原稿。
 *
 * @param {OptionRow[]} rows 照畫面順序
 * @returns {string[]} 每一列該用的代號
 */
export function renumberLabels(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const labels = list.map((r, i) => {
    const raw = r && r.label != null ? String(r.label).trim() : '';
    return raw || String(i + 1);
  });
  // 全形數字也算（台灣的輸入法在中文模式下打出來的就是那個）。
  const plain = labels.every((l) => /^[0-9０-９]+$/.test(l));
  return plain ? list.map((_, i) => String(i + 1)) : labels;
}

/**
 * 把編輯畫面送上來的選項列整理成可以入庫的形狀，並把答案鍵一起帶過去。
 *
 * **重新編號與答案鍵的對映一律走 `normalizeOptions`**（見那個檔案的
 * 檔頭：那一段算錯的話，每一個答對的學生都會被判錯而且沒有跡象）。
 * 這裡只做兩件它不做的事：把「哪幾列被勾成答案」翻成序號，
 * 以及把它回報的問題翻成老師看得懂的話。
 *
 * @param {OptionRow[]} rows 照畫面順序，`correct` 是被勾成答案
 * @returns {ShapedOptions}
 */
export function shapeOptions(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const labels = renumberLabels(list);
  const raw = list.map((r, i) => ({
    order: i + 1,
    label: labels[i],
    content: r && r.content != null ? String(r.content) : '',
  }));
  const picked = list.map((r, i) => (r && r.correct ? i + 1 : 0)).filter(Boolean);

  const shaped = normalizeOptions(raw, picked);

  if (shaped.dropped.length) {
    // 被勾成答案的那一列內容是空的。`normalizeOptions` 會把空選項丟掉，
    // 於是答案指到一個入庫後不存在的位置。**不猜、不硬塞**——猜錯的
    // 後果是每一個答對的學生被判錯。
    return {
      ok: false,
      error:
        `第 ${shaped.dropped.map((n) => `(${n})`).join('')} 個選項被標成標準答案，` +
        `但它的內容是空的。請把內容補上，或改標別的選項。`,
    };
  }
  if (shaped.duplicates.length) {
    const pairs = shaped.duplicates.map(([a, b]) => `${a}／${b}`).join('、');
    return {
      ok: false,
      error:
        `選項 ${pairs} 的內容完全一樣，這一題沒有唯一解——每一個選到` +
        `「另一個一樣的」的學生都會被判錯。多半是差一個向量箭頭、` +
        `上標、負號或單位，請補回差異。`,
    };
  }
  if (shaped.options.length > 0 && shaped.answerKeys.length === 0) {
    return {
      ok: false,
      error:
        '這一題有選項卻沒有標準答案。沒有標準答案的選擇題不會被判錯，' +
        '而是每一份都掛在「需人工確認」等老師一份一份看。',
    };
  }
  return { ok: true, options: shaped.options, answerKeys: shaped.answerKeys };
}

/**
 * 選項的**結構**動得了嗎。已經有人作答過就動不了。
 *
 * 判定方式是比對每一列的來源：編輯畫面上的每一列都帶著它原本是第幾個
 * （`origin`，新增的列是 null）。已經有作答時，第 i 列必須still是原本的
 * 第 i 個——這一條同時擋掉刪除、插入與**搬動順序**，而搬動順序是三者
 * 裡最不容易看出來的一種。
 *
 * 為什麼不是「擋掉整題不給改」：改標準答案、改錯字、改配分都是安全的，
 * 而那三件正是老師最常需要做的。真正危險的只有座標系被動到。
 *
 * @param {OptionRow[]} rows 送上來的選項列，照畫面順序
 * @param {number} beforeCount 原本有幾個選項
 * @param {number} answered 這一題已經有幾份作答（含進行中）
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function checkOptionStructure(rows, beforeCount, answered) {
  const list = Array.isArray(rows) ? rows : [];
  if (!(answered > 0)) return { ok: true };

  const moved = list.some((r, i) => (r && r.origin != null ? Number(r.origin) !== i + 1 : true));
  if (list.length === beforeCount && !moved) return { ok: true };

  return {
    ok: false,
    error:
      `這一題已經有 ${answered} 份作答，選項的增刪與搬動會改掉「第幾個選項」的意思——` +
      `那些學生記錄裡的「選了 (3)」會指到另一個選項，重新計分也會用錯位的答案判對錯。\n` +
      `改標準答案、改選項的文字、改配分都可以，這三件不會動到座標。` +
      `真的要換一組選項，請在題庫另外建一題，讓舊的那一題留給已經考過的人。`,
  };
}

/**
 * 題型改得了嗎。
 *
 * 同一個家族內隨便改（單選↔多選是真的會發生的更正：「這題其實是多選」）。
 * 跨家族在已經有作答之後不給改，理由見 `typeFamily`。
 *
 * @param {string} from
 * @param {string} to
 * @param {number} answered
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function checkTypeChange(from, to, answered) {
  if (String(from) === String(to)) return { ok: true };
  if (!(answered > 0)) return { ok: true };
  if (typeFamily(from) === typeFamily(to)) return { ok: true };
  return {
    ok: false,
    error:
      `這一題已經有 ${answered} 份作答。「${TYPE_LABELS[from] ?? from}」與` +
      `「${TYPE_LABELS[to] ?? to}」的答案存在不同的欄位，改過去之後那些人` +
      `作答的內容會變成沒有人讀的資料，重新計分時全部變成未作答 0 分——` +
      `而畫面上每一題看起來都被正常計分了。`,
  };
}

// ─────────────────────────────────────────────────────────────
// 版本
// ─────────────────────────────────────────────────────────────

/**
 * 會改變計分結果的欄位。動到其中任何一個就把 `version` 加一。
 *
 * `Question.version` 在這套系統裡的意思是**「這一題的計分依據被改過
 * 幾次」**，不是「被編輯過幾次」：改錯字不影響任何一份已經算出來的
 * 成績，把它算成一版只會讓家長申訴時翻出來的版號失去意義。
 */
export const GRADING_FIELDS = [
  'type',
  'answerKeys',
  'answerSlots',
  'answerText',
  'scoringRule',
  'options',
];

/**
 * 這一次的改動有沒有動到計分依據。
 * @param {Iterable<string>|Set<string>} changed 改到的欄位名
 * @returns {boolean}
 */
export function bumpsVersion(changed) {
  const set = changed instanceof Set ? changed : new Set(changed ?? []);
  return GRADING_FIELDS.some((f) => set.has(f));
}

// ─────────────────────────────────────────────────────────────
// 下架
// ─────────────────────────────────────────────────────────────

/**
 * 這一題現在下架得了嗎。
 *
 * **下架的意思是「以後不要再用這一題」，不是「把它從進行中的考試上
 * 抽掉」。** 已經在一份還沒截止的任務上的題目被下架，學生照樣會考到它
 * （組卷時的狀態檢查只在加題目的當下跑一次），而老師會以為自己已經
 * 把它處理掉了——這是那種要等到考完才會發現的錯。
 *
 * 兩種情況擋下來：
 *
 *   · **還有沒截止的任務用著它。** 沒有截止時間的任務也算——那種是
 *     長期開放的自主練習，永遠不會「結束」。
 *   · **還在一份沒封存、也還沒派出去的卷子上。** 那份卷子隨時會被派
 *     出去，而派出去的時候不會再檢查一次題目狀態。
 *
 * 已經截止的任務與已封存的卷子不擋：那是歷史，下架不影響它們的成績。
 *
 * @param {RetireUse[]} uses
 * @param {Date} [now]
 * @returns {{ok: true, blocking: RetireBlocker[]}
 *          | {ok: false, blocking: RetireBlocker[], error: string}}
 */
export function checkRetire(uses, now = new Date()) {
  const list = Array.isArray(uses) ? uses : [];
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const blocking = [];

  for (const u of list) {
    const assignments = Array.isArray(u.assignments) ? u.assignments : [];
    for (const a of assignments) {
      const due = a.dueAt ? new Date(a.dueAt).getTime() : null;
      if (due === null || due > at) {
        blocking.push({
          kind: 'assignment',
          id: a.assignmentId,
          title: a.title,
          why: due === null ? '沒有截止時間' : `${fmtDue(a.dueAt)} 才截止`,
        });
      }
    }
    if (assignments.length === 0 && u.paperStatus !== 'ARCHIVED') {
      blocking.push({
        kind: 'paper',
        id: u.paperId,
        title: u.paperTitle,
        why: '這份卷子還沒派出去，也還沒封存',
      });
    }
  }

  if (blocking.length === 0) return { ok: true, blocking: [] };
  return {
    ok: false,
    blocking,
    error:
      `這一題還被 ${blocking.length} 份用著，現在下架的話那幾份的學生照樣會考到它` +
      `（組卷時的狀態檢查只在加題目的當下跑一次）：\n` +
      blocking.map((b) => `　·　「${b.title}」——${b.why}`).join('\n') +
      `\n要下架請先把它從那幾份卷子上移除，或等它們結束。`,
  };
}

/** 截止時間。一律台北時區——不指定的話 10:30 會被印成 02:30。 */
function fmtDue(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '不明';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

// ─────────────────────────────────────────────────────────────
// 送分
// ─────────────────────────────────────────────────────────────

/**
 * 這一題有沒有被送分。**這是唯一一份判定，四個地方都讀它**：
 * 計分（`lib/grading.mjs`）、題目內頁、成績頁的標記、稽核。
 *
 * 各寫一份的話，最可能的分歧方向是「畫面說已送分、計分沒有送」——
 * 老師按了送分、標記亮起來、學生的分數一分都沒動，而沒有人會去
 * 比對這兩段程式。
 *
 * @param {unknown} scoringRule `Question.scoringRule`
 * @returns {Award|null}
 */
export function readAward(scoringRule) {
  if (!scoringRule || typeof scoringRule !== 'object' || Array.isArray(scoringRule)) return null;
  const a = scoringRule.awardAll;
  // 只認物件。`awardAll: false`、`awardAll: 0` 這種殘留值不算送分——
  // 「取消送分」是把這個鍵刪掉，不是塞一個假值。
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  return {
    at: a.at != null ? String(a.at) : null,
    by: a.by != null ? String(a.by) : null,
    byName: a.byName != null ? String(a.byName) : null,
    reason: a.reason != null ? String(a.reason) : null,
    assignmentId: a.assignmentId != null ? String(a.assignmentId) : null,
    assignmentTitle: a.assignmentTitle != null ? String(a.assignmentTitle) : null,
  };
}

/**
 * 把送分旗標加進（或移出）`scoringRule`，**其餘設定原封不動**。
 *
 * 直接把整個 `scoringRule` 換成 `{awardAll: …}` 的話，多選題的
 * 「全對才給分」（`mode: ALL_OR_NOTHING`）與簡答題的關鍵詞比對
 * （`mode: CONTAINS`）會一起消失——而那兩個消失之後，計分仍然算得出
 * 一個看起來正常的分數，只是規則變回了預設值。
 *
 * @param {unknown} scoringRule 現在的規則
 * @param {Record<string, unknown>|null} award null 代表取消送分
 * @returns {Record<string, unknown>|null}
 */
export function withAward(scoringRule, award) {
  const base =
    scoringRule && typeof scoringRule === 'object' && !Array.isArray(scoringRule)
      ? { ...scoringRule }
      : {};
  if (award === null || award === undefined) {
    delete base.awardAll;
    // 只剩空物件時回 null：資料庫那一欄留一個 `{}` 會讓「有沒有設過
    // 計分規則」這個問題答不出來。
    return Object.keys(base).length === 0 ? null : base;
  }
  base.awardAll = award;
  return base;
}
