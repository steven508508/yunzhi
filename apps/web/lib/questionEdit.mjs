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
import { missingAssetRefs, normalizeOptions } from './questionShape.mjs';

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
 * @typedef {object} PublishIssue
 * @property {string} code
 * @property {string} detail
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
// 發布
// ─────────────────────────────────────────────────────────────

/**
 * `lib/grading.mjs` 認得的題型。不在裡面的一律走
 * `review('不認得的題型…')`——每一份作答都掛在需人工確認。
 */
const GRADABLE_TYPES = new Set(Object.keys(TYPE_LABELS));

/**
 * 沒有標準答案是**正常**的題型。作文、翻譯、簡答本來就是人工或 AI 閱卷
 * （`lib/grading.mjs` 的 `MANUAL_TYPES`），拿「沒填標準答案」擋住它們
 * 等於這三種題型永遠發布不了。
 */
const OPEN_ENDED_TYPES = new Set(['ESSAY', 'TRANSLATION', 'SHORT_ANSWER']);

/**
 * 這一題現在發布得了嗎。
 *
 * # 為什麼發布需要前置條件，而下架早就有了
 *
 * 因為兩邊擋的是同一件事的兩端，而只有一端被實作了。下架擋的是
 * 「別讓還在考的卷子被抽掉題目」；發布擋的是**「別讓壞掉的題目進到
 * 考卷上」**——而後者的代價大得多：一題沒有標準答案的單選題可以
 * 入庫 → 發布 → 組進卷子 → 全班考完，四十份成績掛在「需人工確認」，
 * 而老師是在成績出不來的那一天才發現的。
 *
 * 在這之前 `setQuestionStatus` 只在 `to === 'RETIRED'` 時檢查，
 * `PUBLISHED` 一路直達；畫面上那顆按鈕也是無條件畫出來的。
 *
 * # BLOCK 與 WARN 怎麼分
 *
 * **只有一條線：這一題現在拿去考學生，會不會產生「沒有人看得出來
 * 的錯誤結果」。** 會的就擋，不會的就提醒。
 *
 * 擋（BLOCK）——學生的作答會得到錯的或算不出來的結果：
 *   · 題幹是空的：學生看到一片空白，而卷子上有這一題的分數
 *   · 題型不認得：`gradeByType` 落到 `review('不認得的題型')`
 *   · 選擇題沒有選項、或只有一個：這不是一道題目
 *   · 選擇題沒有標準答案／答案指到不存在的選項／單選卻有多個答案：
 *     三種都讓 `gradeSingleChoice` 回 `review`，全班掛在需人工確認
 *   · 選填、填空沒有標準答案：同上
 *   · 內容引用的附圖對不到：學生看到「這裡有一張附圖，但系統找不到它」，
 *     而題目寫著「如右圖」——那一題根本無法作答
 *
 * 提醒（WARN）——題目本身是好的，只是某些功能會少一塊：
 *   · **沒有知識點**：能力分析算不到這一題（學生的雷達圖上少一格），
 *     但作答與計分完全正常。擋住它等於「老師想出一份考卷，得先把
 *     知識點樹整理完」——那會把人推去繞過這個流程，而不是去標知識點。
 *   · **配分是 0**：組卷時會自動變成 1 分
 *     （`lib/paper.ts`：`question.score > 0 ? question.score : 1`），
 *     所以不會出現「答對了得 0 分」。它只代表原稿的配分沒抽到，
 *     老師在組卷時本來就會逐題設定。
 *   · **沒有詳解**：學生檢討時看不到解析。解析可以事後補，而且權利
 *     基礎未確認時本來就刻意不建（見 lib/commit.ts）——拿它擋發布
 *     等於把著作權的保守作法變成一道功能障礙。
 *
 * @param {{type?: string, content?: string|null, score?: number|null,
 *          answerKeys?: number[], answerSlots?: unknown, answerText?: string|null,
 *          options?: {order:number,label:string,content:string,assets?:unknown}[],
 *          assets?: unknown, stimulus?: string|null, stimulusAssets?: unknown,
 *          knowledgePointCount?: number, explanationCount?: number}} q
 * @returns {{ok: boolean, blocking: PublishIssue[], warnings: PublishIssue[],
 *            error: string|null}}
 */
export function checkPublish(q) {
  const blocking = [];
  const warnings = [];
  const block = (code, detail) => blocking.push({ code, detail });
  const warn = (code, detail) => warnings.push({ code, detail });

  const type = String(q?.type ?? '');
  const options = Array.isArray(q?.options) ? q.options : [];
  const keys = Array.isArray(q?.answerKeys) ? q.answerKeys : [];

  if (!String(q?.content ?? '').trim()) {
    block('empty_content', '題幹是空的。學生會看到一題只有分數、沒有內容的題目。');
  }

  if (!GRADABLE_TYPES.has(type)) {
    block(
      'unknown_type',
      `題型「${type || '（空白）'}」不在計分程式認得的清單裡，每一份作答都會掛在「需人工確認」。`,
    );
  } else if (typeFamily(type) === 'CHOICE') {
    if (options.length < 2) {
      block(
        'too_few_options',
        `這是「${TYPE_LABELS[type]}」題，但只有 ${options.length} 個選項。` +
          `多半是掃描漏抓了——請先把選項補齊。`,
      );
    }
    if (keys.length === 0) {
      block(
        'no_answer',
        '這一題沒有標準答案。學生不會被判錯，但每一份作答都會掛在「需人工確認」，' +
          '要老師一份一份看——一個班就是四十份。',
      );
    } else {
      const orders = new Set(options.map((o) => Number(o?.order)));
      const orphan = keys.filter((k) => !orders.has(Number(k)));
      if (orphan.length) {
        block(
          'answer_orphan',
          `標準答案 (${orphan.join(')(')}) 指到不存在的選項（本題共 ${options.length} 個）。` +
            `這樣計分會判定「題目資料要先修正」，全班都拿不到分數。`,
        );
      }
      if (type !== 'MULTI_CHOICE' && keys.length > 1) {
        block(
          'multi_answer_on_single',
          `這是「${TYPE_LABELS[type]}」題卻有 ${keys.length} 個標準答案。` +
            `計分會停下來要求人工確認。要複選請把題型改成多選。`,
        );
      }
    }
  } else if (type === 'FILL_SLOT') {
    // `answerSlots` 是 Json，三種形狀都可能：`['1','2']`、
    // `{'13':'1','14':'2'}`（格位編號當鍵）、`'12'`（單格）。
    // 判斷方式要與 `lib/grading.mjs` 的 `slotList` 一致——那一支
    // 認定「空的」的時候，這裡就必須擋，否則老師會發布一題計分
    // 永遠停在需人工確認的選填題。
    //
    // 不直接 import 那一支：`grading.mjs` 已經 import 這個檔案的
    // `readAward`，反向匯入會形成循環。
    const raw = q?.answerSlots;
    const slots =
      raw === null || raw === undefined
        ? []
        : Array.isArray(raw)
          ? raw
          : typeof raw === 'object'
            ? Object.values(raw)
            : [raw];
    if (!slots.some((s) => String(s ?? '').trim() !== '')) {
      block('no_answer', '選填題還沒有填格位答案，每一份作答都會掛在「需人工確認」。');
    }
  } else if (type === 'FILL_TEXT') {
    if (!String(q?.answerText ?? '').trim()) {
      block('no_answer', '填空題還沒有標準答案，每一份作答都會掛在「需人工確認」。');
    }
  } else if (!OPEN_ENDED_TYPES.has(type)) {
    // 這一支落到這裡代表 TYPE_LABELS 加了新題型而這個函式沒跟上。
    // 靜默放行的話，新題型會繞過整組前置條件——寧可吵。
    block('unchecked_type', `題型「${type}」還沒有對應的發布前檢查，請先回報。`);
  }

  // 附圖標記對不到圖。
  //
  // 逐欄檢查而不是用 `partitionAssets`：題庫裡的題目**已經分好欄位**了
  // （題幹、每個選項、題組素材各存各的），沒有一個平的清單可以餵給它。
  // 那一支是給匯入用的（那時候還沒分）。
  //
  // 為什麼題庫這一側也要檢查：老師在題目編輯頁可以自己打
  // `![[a:fig1]]`，那條路沒有經過入庫的那道關。
  const missing = [
    ...missingAssetRefs(q?.stimulus, q?.stimulusAssets).map((id) => ({ id, where: '題組前導敘述' })),
    ...missingAssetRefs(q?.content, q?.assets).map((id) => ({ id, where: '題幹' })),
    ...options.flatMap((o) =>
      missingAssetRefs(o?.content, o?.assets).map((id) => ({ id, where: `選項 (${o?.label})` })),
    ),
  ];
  if (missing.length) {
    const where = [...new Set(missing.map((m) => m.where))].join('、');
    block(
      'missing_asset',
      `${where}裡的 ![[a:${missing.map((m) => m.id).join('、')}]] 對不到任何一張圖。` +
        `學生會在那個位置看到一句「這裡有一張附圖，但系統找不到它」，而題目寫著「如圖」。`,
    );
  }

  if (!(Number(q?.knowledgePointCount) > 0)) {
    warn(
      'no_knowledge_point',
      '還沒有標知識點。這一題照樣考得了，但能力分析算不到它——' +
        '學生答錯之後，雷達圖上不會有任何一個章節變弱。',
    );
  }
  if (!(Number(q?.score) > 0)) {
    warn(
      'zero_score',
      '預設配分是 0 分（原稿的配分沒有抽到）。組卷時若不另外指定，' +
        '系統會給它 1 分——不會出現「答對了得 0 分」，但那多半不是你要的分數。',
    );
  }
  if (!(Number(q?.explanationCount) > 0)) {
    warn(
      'no_explanation',
      '還沒有解析。學生交卷後看得到對錯，但看不到為什麼。',
    );
  }

  if (blocking.length === 0) return { ok: true, blocking, warnings, error: null };
  return {
    ok: false,
    blocking,
    warnings,
    error:
      `這一題還不能發布——發布之後它就會被組進卷子拿去考學生：\n` +
      blocking.map((b) => `　·　${b.detail}`).join('\n'),
  };
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
