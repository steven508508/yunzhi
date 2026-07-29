/**
 * 智慧老師的確定性閘門。
 *
 * # 為什麼這一層存在，以及為什麼它比提示詞重要
 *
 * 「不要直接給答案」寫在提示詞裡是有用的——在學生只問一次的時候。
 * 學生問第三次「拜託你直接告訴我」，模型就會講。這不是提示詞寫得
 * 不夠嚴厲可以修的：對齊訓練讓它傾向順從使用者，而一個高中生在
 * 檢討自己剛考爛的那一題時，順從他正好是最沒有幫助的事。
 *
 * 所以真正守住這條線的是這個檔案：**它看完整段輸出，用規則判斷，
 * 命中就整段丟掉重新生成。** 規則會誤擋，誤擋的代價是多花一次
 * 生成的錢；漏擋的代價是這個功能退化成一個比較慢的解析，
 * 而那正是業主抱怨現有工具的那件事。**所以每一條邊界都往擋的方向倒。**
 *
 * # 為什麼在 Node 端而不是在 Python 端
 *
 * 因為只能有一份。洩漏偵測要跟著題型演進（單選、多選、選填、非選
 * 各有各的「答案長什麼樣子」），兩份實作只要有一份先改，症狀就是
 * 「某些題型擋得住、某些擋不住」——而那不會有人回報，畫面上看起來
 * 只是 AI 那一天講得比較清楚。代價是重新生成要多一次內網往返。
 *
 * # 這個檔案為什麼是 .mjs 而不是 .ts
 *
 * 與 `lib/grading.mjs`、`lib/release.mjs` 同一個理由：**會算錯的東西
 * 要能在沒有資料庫的情況下驗。** 這裡的每一支都是純函式，
 * 輸入是字串與一組事實，輸出是判斷。`tests/tutorGuard.test.mjs`
 * 餵它三十幾種洩漏樣式與一整組正常的引導問句。
 *
 * # 三件這一層做不到的事，寫出來免得有人以為它做得到
 *
 * 一、**它擋不住「用暗示的」。** 「你再想想看，跟 π 有關的那一個」
 *     這種句子沒有任何可比對的字串。這一層擋的是可機械辨識的洩漏，
 *     教學品質靠提示詞與模式設計。
 * 二、**它不理解語意。** 它比對的是這一題的答案事實，
 *     不是「這段話有沒有教育意義」。
 * 三、**它不能保證重新生成之後就變好。** 所以重試有上限，
 *     用完就退回一句安全的引導問句並記 `blocked`（見 lib/tutor.ts）。
 */

// ─────────────────────────────────────────────────────────────────
// 正規化
//
// 洩漏可以寫成 $\boxed{24}$、（３）、３／４、二十四。這些在字串上
// 完全不同，在學生眼裡完全一樣。比對之前一律折成同一種寫法，
// 否則「換一種寫法就過得去」，而那是最容易被試出來的破口。
// ─────────────────────────────────────────────────────────────────

/** 全形 ASCII 與全形空白折成半形。 */
function toHalfWidth(s) {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

/**
 * 把 LaTeX 折成純文字。
 *
 * `\frac{3}{4}` 折成 `3/4` 而**不是** `(3)/(4)`：加了括號之後，
 * 一個分數在後面的比對裡會長得跟選項代號一模一樣，於是每一題
 * 含分數的引導都會被當成「講出了選項 (3)」。
 */
function stripLatex(s) {
  let t = s;
  for (let i = 0; i < 4; i += 1) {
    t = t
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
      .replace(/\\(?:boxed|text|textbf|mathrm|mathbf|operatorname|ce|mbox)\s*\{([^{}]*)\}/g, '$1');
  }
  return t
    .replace(/\\therefore/g, '∴')
    .replace(/\\(?:Rightarrow|rightarrow|implies|to)\b/g, '→')
    .replace(/\\(?:times|cdot)\b/g, '*')
    .replace(/\\div\b/g, '/')
    .replace(/\\(?:left|right)\b/g, '')
    .replace(/\\\\/g, ' ')
    .replace(/\\[,;!:]/g, '')
    .replace(/\$+/g, '')
    .replace(/\\([a-zA-Z]+)/g, '$1')
    .replace(/[{}^_]/g, '');
}

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * 中文數字折成阿拉伯數字，只處理 1–99。
 *
 * 「答案是二十四」與「答案是 24」是同一件事，而只擋後者的話，
 * 前者會通過——模型在被要求「不要寫出數字」時，真的會改用國字。
 *
 * **只在數字語境裡折。** 無條件折的話，「三角函數」會變成
 * 「3角函數」、「一起」會變成「1起」——而一道答案剛好是 3 的題目
 * 就再也不能提到三角函數了。漏掉的代價（「答案是三」擋不到）
 * 遠小於誤擋的代價（整個單元的引導全被擋）。
 */
function cnToArabic(s) {
  const digit = (d) => String(CN_DIGITS[d] ?? d);
  return (
    s
      // 帶「十」的複合數：十、十二、六十、二十四
      .replace(/[一二兩三四五六七八九]?十[一二兩三四五六七八九]?/g, (m) => {
        const [hi, lo] = m.split('十');
        const tens = hi === '' ? 1 : (CN_DIGITS[hi] ?? NaN);
        const ones = lo === '' ? 0 : (CN_DIGITS[lo] ?? NaN);
        if (Number.isNaN(tens) || Number.isNaN(ones)) return m;
        return String(tens * 10 + ones);
      })
      // 序數與明確的答案語境：第三、答案是三、選三
      .replace(/(?<=第|選項|答案是|答案為|正解是|正確答案是|選)([零一二兩三四五六七八九])/g, (_, d) =>
        digit(d),
      )
      // 後面接量詞：三個、四項、五題
      .replace(/([零一二兩三四五六七八九])(?=[個項號題步次])/g, (_, d) => digit(d))
  );
}

/**
 * 比對用的正規化形式。**匯出是給測試用的**：折錯了的症狀是
 * 某一類洩漏永遠擋不到，而那在整合層看不出來。
 */
export function normalizeForGuard(text) {
  if (!text) return '';
  return cnToArabic(toHalfWidth(stripLatex(String(text))))
    .replace(/[ \t ]+/g, ' ')
    .trim();
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 數值 token：整數、小數、分數、負號、百分比都算同一個。 */
function numberTokens(text) {
  const out = new Set();
  const re = /-?\d+(?:\.\d+)?(?:\/\d+)?/g;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[0]);
  return out;
}

/**
 * 量詞用法裡的數字不是答案。
 *
 * 「第 2 步」「有 3 個條件」裡的數字，在一道答案剛好是 2 或 3 的
 * 填充題上會把每一句正常的引導都擋下來。這一支只在「裸數值」那一條
 * 規則前面跑，**不在「有提示語」那一條前面跑**——「答案是 3 個」
 * 仍然要擋。
 */
function stripCounters(text) {
  return text.replace(
    /-?\d+(?:\.\d+)?\s*(?:個|題|步|次|種|項|行|條|位|人|句|字|遍|回|分|秒|度|倍|年|月|日)/g,
    ' ',
  );
}

/** 量詞與單位。跟在裸數字後面時，那個數字多半不是答案而是計數。 */
const UNIT_AFTER =
  '(?:個|題|步|次|種|項|行|條|位|人|句|字|遍|回|分|秒|度|倍|年|月|日|元|小時|公里|公尺|公分|公克|毫升|%)';

// ─────────────────────────────────────────────────────────────────
// 事實：這一題的「答案」到底是哪些字串
// ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} GuardOption
 * @property {string} label   學生看到的標籤（隨機選項時是位置的標籤）
 * @property {string} content
 * @property {boolean} correct
 * @property {boolean} [picked]
 */

/**
 * @typedef {object} GuardQuestion
 * @property {string} type
 * @property {string} stem
 * @property {GuardOption[]} options
 * @property {string[]} [correctTexts] 非選擇題可接受的寫法
 * @property {string[]} [correctSlots] 選填題各格的答案
 * @property {string|null} [myText]    學生自己寫的（他自己寫過的東西不是祕密）
 */

/**
 * @typedef {object} AnswerFacts
 * @property {boolean} choice
 * @property {string[]} correctLabels
 * @property {string[]} wrongLabels
 * @property {number[]} correctOrdinals 正解在畫面上的第幾個（1 起算）
 * @property {string[]} correctContents 正解選項的內容（正規化過）
 * @property {string[]} contentSecrets  只有正解才有的內容字串
 * @property {string[]} secretValues    足以指認答案的 token
 */

/**
 * 從一題算出「哪些字串講出來就是洩漏」。
 *
 * # 選擇題與非選擇題的祕密不是同一種東西
 *
 * 選擇題的選項內容**學生本來就看得到**，祕密是「哪一個」——所以
 * 祕密是代號、位置、以及「只出現在正解裡的那幾個數」。
 * 非選擇題沒有選項，祕密就是答案本身。
 *
 * 分不清這一點的實作會出現兩種錯：對選擇題把正解內容整段當祕密
 * （於是連「(3) 說的是什麼意思？」都擋掉），或對非選題只擋代號
 * （於是「等於 24」暢行無阻）。
 */
export function answerFacts(q) {
  const options = Array.isArray(q?.options) ? q.options : [];
  const choice = options.length > 0;

  const stem = normalizeForGuard(q?.stem ?? '');
  const mine = normalizeForGuard(q?.myText ?? '');
  const publicNums = new Set([...numberTokens(stem), ...numberTokens(mine)]);

  const correctLabels = [];
  const wrongLabels = [];
  const correctOrdinals = [];
  const correctContents = [];
  const wrongContents = [];

  options.forEach((o, i) => {
    const label = normalizeForGuard(o?.label ?? '').replace(/^[([]|[)\]]$/g, '');
    const content = normalizeForGuard(o?.content ?? '');
    if (o?.correct) {
      if (label) correctLabels.push(label);
      correctOrdinals.push(i + 1);
      correctContents.push(content);
    } else {
      if (label) wrongLabels.push(label);
      wrongContents.push(content);
    }
  });

  /** @type {Set<string>} */
  const secrets = new Set();

  if (choice) {
    // 只出現在正解裡、錯誤選項與題幹裡都沒有的數——講出它等於指著
    // 那個選項。多選題四個正解共用的數也算（每一個都指認到一組）。
    const wrongNums = new Set();
    for (const c of wrongContents) for (const n of numberTokens(c)) wrongNums.add(n);
    for (const c of correctContents) {
      for (const n of numberTokens(c)) {
        if (!wrongNums.has(n) && !publicNums.has(n)) secrets.add(n);
      }
    }
  } else {
    const texts = [
      ...(Array.isArray(q?.correctTexts) ? q.correctTexts : []),
      ...(Array.isArray(q?.correctSlots) ? q.correctSlots : []),
    ];
    for (const raw of texts) {
      const t = normalizeForGuard(raw ?? '');
      if (!t) continue;
      // 整串答案。太短的（一個字元）交給數值那一條處理，
      // 否則「x」這種答案會讓每一句含 x 的引導都被擋。
      if (t.length >= 2 && !stem.includes(t)) secrets.add(t);
      for (const n of numberTokens(t)) {
        if (!publicNums.has(n)) secrets.add(n);
      }
    }
  }

  // 選項內容裡「只有正解才有」的那幾個字串。
  //
  // 英文與社會科的選項是單字或短句（which / where / what / then），
  // 數值那一條完全抓不到它們——一句「答案是 what 那個」躲得過
  // 每一條數值規則。但它**不能拿來當裸露偵測**：中性地引用選項內容
  // 提問（「(C) what 跟 (A) which 差在哪裡？」）是最該鼓勵的一種引導。
  // 所以它只參與「有提示語」與「有斷定語氣」那兩條。
  const contentSecrets = correctContents.filter(
    (c) => c.length >= 2 && !wrongContents.some((w) => w.includes(c)) && !stem.includes(c),
  );

  return {
    choice,
    correctLabels,
    wrongLabels,
    correctOrdinals,
    correctContents,
    contentSecrets,
    secretValues: [...secrets],
  };
}

// ─────────────────────────────────────────────────────────────────
// 規則
// ─────────────────────────────────────────────────────────────────

/**
 * 「我要講答案了」的提示語。
 *
 * 這一串本身不構成違規——`checkTutorReply` 要求提示語**附近**同時
 * 出現一個祕密 token 才算。只靠提示語的話，「答案就在題目裡，
 * 你再讀一次」這種完全正確的引導會被擋掉。
 */
const REVEAL_CUES = [
  '答案是', '答案為', '答案就是', '答案應該是', '答案:', '答案=',
  '正確答案', '標準答案', '正解', '正確的是', '對的是', '答對的是', '正確選項',
  '故選', '所以選', '因此選', '應該選', '要選', '就選', '該選', '選的是',
  '答:', '∴', '所以是', '因此是', '得到', '就是', '等於', '就在', '=',
  'the answer', 'answer is', 'answer:', 'answer =', 'correct answer',
  'ans:', 'ans =', 'the correct one', 'the right one', 'should choose',
  // 「答案很明顯，就在那個」這種寫法躲得過上面每一條具體的提示語，
  // 所以最後補一條裸的「答案」。它排在最後，是為了讓命中時報出來的
  // 理由盡量具體——迴圈找到第一個就停。
  '答案',
];

/**
 * 斷定語氣。與提示語不同，這一組**貼著代號**出現就算。
 *
 * 每一條都要擋掉否定與疑問：「(1) 不對」裡有「對」、「(1) 成立嗎？」
 * 裡有「成立」，兩句都是完全正常的引導。少了前後那兩個判斷，
 * 這條規則會把最該鼓勵的那種提問全部擋掉。
 */
const AFFIRM = new RegExp(
  '(?<![不沒非未])(?:' +
    '是對的|是正確的|才對|才是對的|才是正解|沒錯|正確無誤|是答案|是正解|符合題意|' +
    '成立|正確|is correct|is right|is the answer|✓|√' +
    ')(?![不嗎呢?？])' +
    // 「對的那一個是 (3)」——倒裝，肯定詞在代號前面。
    '|(?<![不沒非未])(?:對的|正確的)(?=[那這個一])' +
    // 單獨一個「對」只在句末或標點前算——「對不對」「對於」不算。
    '|(?<![不沒非未])對(?=[，,。.！!；;、\\s]|$)',
);

/** 否定語氣。用來判斷排除法有沒有把錯的選項全部點名。 */
const NEGATE =
  /(?:不對|不正確|(?<![沒])錯|不成立|排除|不可能|不符合|不行|不是|✗|×|is wrong|incorrect)/;

/**
 * 一則回應裡的「步驟標記」數。三個以上就是把整題講完了，
 * 而那與直接給答案在教學上的後果一樣：學生讀完覺得懂了，
 * 但他一步都沒有自己走過。
 */
function countSteps(text) {
  let n = 0;
  n += (text.match(/第\s*\d+\s*步/g) ?? []).length;
  n += (text.match(/^\s*\d+\s*[.)、]/gm) ?? []).length;
  n += (text.match(/step\s*\d/gi) ?? []).length;
  return n;
}

/** 回應長度上限。提示詞要求 150 字，這裡擋的是失控而不是超標一點點。 */
const MAX_REPLY_CHARS = 350;

/**
 * 代號在這一段文字裡的每一個出現位置。
 *
 * 單一個數字的代號（「3」）最麻煩：它會出現在「第 3 步」「3 個條件」
 * 「3/4」裡。所以裸數字要多兩道條件——前後不是數字（不是某個大數的
 * 一部分），而且後面不接量詞或單位。加了括號的（「(3)」）不必。
 *
 * 回位置而不是回布林，是因為後面幾條規則要看**代號前後**的語氣，
 * 而洩漏的語氣有一半出現在代號前面（「對的那個是 (3)」「也不是 (2)」）。
 * 只往後看的實作會漏掉倒裝，而倒裝是模型被擋幾次之後自己會找到的路。
 */
function labelPositions(text, label) {
  const L = escapeRe(label);
  const alt = /^\d+$/.test(label)
    ? `|(?<![\\d.\\/])${L}(?![\\d.\\/])(?!\\s*${UNIT_AFTER})`
    : `|(?<![A-Za-z])${L}(?![A-Za-z])`;
  const re = new RegExp(`[(\\[]\\s*${L}\\s*[)\\]]${alt}`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return out;
}

function labelHit(text, label) {
  return labelPositions(text, label).length > 0;
}

/** 序數形式的指認：「第三個」「第 3 個選項」「the third」。 */
function ordinalPositions(text, ordinal) {
  const words = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
  const out = [];
  const re = new RegExp(`第\\s*${ordinal}\\s*(?:個|項|條)?\\s*(?:選項|敘述)?`, 'g');
  let m;
  while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
  const w = words[ordinal];
  if (w) {
    const re2 = new RegExp(`\\b${w}\\b`, 'gi');
    while ((m = re2.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

function ordinalHit(text, ordinal) {
  return ordinalPositions(text, ordinal).length > 0;
}

/** 取一個位置前後的語氣視窗。前面看得比後面短：倒裝多半就在一句之內。 */
function around(text, [start, end], back = 14, fwd = 16) {
  return text.slice(Math.max(0, start - back), end + fwd);
}

/** 祕密值出現在這一段文字裡嗎（避免命中更大的數字的一部分）。 */
function valueHit(text, value) {
  if (/^-?\d+(?:\.\d+)?(?:\/\d+)?$/.test(value)) {
    return new RegExp(`(?<![\\d.])${escapeRe(value)}(?![\\d.])`).test(text);
  }
  return text.includes(value);
}

/** 這一段文字裡有沒有任何一個祕密（代號、位置、值）。 */
function anySecret(text, facts) {
  for (const l of facts.correctLabels) if (labelHit(text, l)) return true;
  for (const o of facts.correctOrdinals) if (ordinalHit(text, o)) return true;
  for (const v of facts.secretValues) if (valueHit(text, v)) return true;
  const lower = text.toLowerCase();
  for (const c of facts.contentSecrets ?? []) if (lower.includes(c.toLowerCase())) return true;
  return false;
}

/**
 * @typedef {object} Violation
 * @property {string} code
 * @property {'LEAK'|'STYLE'} severity
 * @property {string} detail 給老師看的一句話。會寫進 TutorMessage.blockedReason。
 */

/**
 * 這一段輸出可以送給學生嗎。
 *
 * @param {string} reply 模型產生的一整段文字
 * @param {AnswerFacts} facts `answerFacts()` 的結果
 * @param {{maxChars?: number}} [opts]
 * @returns {{ok: boolean, violations: Violation[], leaked: boolean}}
 *
 * **整段一起看，不逐句看。** 「答案很簡單。就是 (3)。」拆成兩句之後
 * 每一句單獨都不構成違規，而合起來是一次完整的洩漏。
 */
export function checkTutorReply(reply, facts, opts = {}) {
  /** @type {Violation[]} */
  const v = [];
  const raw = String(reply ?? '');
  const text = normalizeForGuard(raw);
  const lower = text.toLowerCase();

  const add = (code, severity, detail) => {
    if (!v.some((x) => x.code === code)) v.push({ code, severity, detail });
  };

  // ── 一、提示語 ＋ 附近有祕密 ──────────────────────────────
  //
  // 視窗開得比一句話寬（前 24 字、後 60 字），因為「分兩句拆開講」
  // 是最常見的繞法，而它繞得過逐句比對。
  for (const cue of REVEAL_CUES) {
    const hay = /[a-z]/.test(cue) ? lower : text;
    let from = 0;
    for (;;) {
      const i = hay.indexOf(cue, from);
      if (i < 0) break;
      from = i + cue.length;
      const win = text.slice(Math.max(0, i - 24), i + cue.length + 60);
      if (anySecret(win, facts)) {
        add('ANSWER_PHRASE', 'LEAK', `出現「${cue}」並在附近說出了答案`);
        break;
      }
    }
    if (v.some((x) => x.code === 'ANSWER_PHRASE')) break;
  }

  // ── 二、代號貼著斷定語氣 ────────────────────────────────
  // 「(3) 是對的」「C is correct」「對的那個是 (3)」。
  // 沒有提示語也算——它本身就是結論。
  for (const l of facts.correctLabels) {
    for (const pos of labelPositions(text, l)) {
      if (AFFIRM.test(around(text, pos))) {
        add('AFFIRM_LABEL', 'LEAK', `把正確選項（${l}）說成是對的`);
      }
    }
    const L = escapeRe(l);
    // 「只有 (3) 成立」「剩下 (3)」——不含任何肯定詞，但一樣是結論。
    if (new RegExp(`(?:只有|剩下|唯一|only|just)\\s*[(\\[]?\\s*${L}\\s*[)\\]]?`).test(text)) {
      add('AFFIRM_LABEL', 'LEAK', `用「只有／剩下」指出了正確選項（${l}）`);
    }
    // 「選 (3)」。**「你選的 (3)」不算**——那是在講學生自己選的東西，
    // 而答對了還來問的學生本來就會被這樣回應。
    if (new RegExp(`(?<![你妳他她])(?:選|挑|勾|choose|pick)\\s*[(\\[]?\\s*${L}\\s*[)\\]]?`).test(text)) {
      add('PICK_CORRECT', 'LEAK', `叫學生選正確選項（${l}）`);
    }
  }

  // ── 二之二、整則就是一個代號 ────────────────────────────
  //
  // 「(3)」。沒有任何肯定詞、沒有提示語、沒有數值——上面每一條都
  // 抓不到，而它是最直接的一種給法。學生問到第五次時，模型放棄
  // 掙扎就會這樣回。
  {
    const bare = text.replace(/[\s，。！？、,.!?()（）[\]:：]/g, '');
    if (bare.length <= 8 && facts.correctLabels.some((l) => labelHit(text, l))) {
      add('BARE_LABEL', 'LEAK', '整則回應就只是正確選項的代號');
    }
  }

  // ── 三、序數指認 ──────────────────────────────────────
  for (const o of facts.correctOrdinals) {
    for (const pos of ordinalPositions(text, o)) {
      if (AFFIRM.test(around(text, pos))) {
        add('ORDINAL_REVEAL', 'LEAK', `用「第 ${o} 個」指出了正確選項`);
      }
    }
  }

  // ── 四、排除法把錯的全部點名 ────────────────────────────
  //
  // 「(1) 不對，(2) 不成立，(4)(5) 也不行」——一個字都沒提正解，
  // 但答案已經給完了。這一條沒有的話，模型被擋幾次之後就會自己
  // 找到這條路（它確實會）。
  if (facts.wrongLabels.length >= 2) {
    let denied = 0;
    for (const l of facts.wrongLabels) {
      const hit = labelPositions(text, l).some((pos) => NEGATE.test(around(text, pos, 14, 18)));
      if (hit) denied += 1;
    }
    if (denied >= facts.wrongLabels.length) {
      add('ELIMINATE_ALL', 'LEAK', '把每一個錯誤選項都點名否定了，等於講出答案');
    }
  }

  // ── 五、把正解的內容當成結論複述 ────────────────────────
  //
  // 「所以會生鏽的是鐵這個敘述」。內容本身學生看得到，
  // 所以要「內容 ＋ 斷定語氣」才算；只是引用來提問不算。
  for (const c of facts.correctContents) {
    if (c.length < 4 || !text.includes(c)) continue;
    const i = text.indexOf(c);
    const seg = text.slice(Math.max(0, i - 12), i + c.length + 16);
    if (AFFIRM.test(seg)) {
      add('CORRECT_CONTENT', 'LEAK', '把正確選項的內容當成結論說出來了');
    }
  }

  // ── 六、算到最終值 ──────────────────────────────────────
  // 「= 24」「∴ x = 24」「得 24」。中間的式子可以出現，最後那個數不行。
  for (const val of facts.secretValues) {
    const V = escapeRe(val);
    if (
      new RegExp(
        `(?:=|∴|→|得|共|約|就是|答|等於|equals|is)\\s*[^\\d\\n]{0,6}(?<![\\d.])${V}(?![\\d.])`,
      ).test(text)
    ) {
      add('COMPUTED_TO_END', 'LEAK', `把計算一路算到了最終值（${val}）`);
      break;
    }
  }

  // ── 七、裸露的祕密值 ────────────────────────────────────
  //
  // 非選擇題沒有選項可以指，答案本身就是祕密，所以任何一次出現都算
  // （量詞用法先拿掉，見 stripCounters）。選擇題則要求兩個字元以上
  // ——一個數字太容易在「第 2 步」這種地方誤中。
  {
    const scan = stripCounters(text);
    for (const val of facts.secretValues) {
      if (facts.choice && val.length < 2) continue;
      if (valueHit(scan, val)) {
        add('BARE_ANSWER', 'LEAK', `直接寫出了答案（${val}）`);
        break;
      }
    }
  }

  // ── 八、體例 ────────────────────────────────────────────
  //
  // 這幾條不是洩漏，是「這樣就不是引導了」。分開標記，因為
  // lib/tutor.ts 對兩種的重試策略不同：洩漏一定重來，體例問題
  // 重來一次還是這樣就收下——為了句子長了 20 個字而把一段好的
  // 引導丟掉，換來的是學生多等三秒看一句罐頭。
  const steps = countSteps(text);
  if (steps >= 3) {
    add('FULL_SOLUTION', 'STYLE', `一次講完了 ${steps} 個步驟，這是解析不是引導`);
  }
  const len = text.replace(/\s+/g, '').length;
  const max = opts.maxChars ?? MAX_REPLY_CHARS;
  if (len > max) {
    add('TOO_LONG', 'STYLE', `這一則有 ${len} 字，超過 ${max} 字`);
  }
  const questions = (text.match(/[?？]/g) ?? []).length;
  if (questions === 0) {
    add('NO_QUESTION', 'STYLE', '整則沒有問任何問題');
  } else if (questions >= 3) {
    add('MULTI_QUESTION', 'STYLE', `一次問了 ${questions} 個問題`);
  }

  return {
    ok: v.length === 0,
    violations: v,
    leaked: v.some((x) => x.severity === 'LEAK'),
  };
}

/** 把違規清單折成一行寫進 `TutorMessage.blockedReason`。 */
export function describeViolations(violations) {
  if (!violations || violations.length === 0) return '';
  return violations.map((x) => `${x.code}：${x.detail}`).join('；');
}

// ─────────────────────────────────────────────────────────────────
// 學生那一側
// ─────────────────────────────────────────────────────────────────

/**
 * 提示注入。
 *
 * **「直接告訴我答案」不在這裡面。** 那是一句正常的、可以理解的話，
 * 而且它出現的時刻正好是學生最接近想通的時刻——把它擋掉並回一句
 * 「你的訊息違反規定」，等於在他最需要人的時候給他一張罰單。
 * 那句話交給模型正常回應，而模型會不會妥協由輸出閘門決定。
 *
 * 這裡擋的是另一種：企圖改寫規則本身。擋下來的訊息仍然存進
 * `TutorMessage`（`blocked = true`），刪掉的話事後查不出他打了什麼。
 */
const INJECTION = [
  /忽略(?:掉)?(?:前面|上面|之前|先前|所有)?的?(?:指示|規則|限制|提示|設定)/,
  /(?:不要|別)(?:再)?管(?:前面|上面|之前)?的?(?:規則|限制|指示)/,
  /你(?:現在|從現在開始)?(?:是|扮演|當)(?:一[個位隻])?(?!學生)/,
  /(?:從現在開始|接下來)你(?:要|必須|就)/,
  /(?:系統|系統提示|提示詞|prompt)(?:是什麼|給我看|印出來|complete)/,
  /把你的(?:系統)?(?:提示|指示|規則)(?:說|講|印|寫)出來/,
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|prompts?)/i,
  /disregard\s+(?:all\s+)?(?:previous|prior|above)/i,
  /you\s+are\s+now\s+(?:a|an)\s+/i,
  /(?:developer|god|dan)\s+mode/i,
  /system\s*prompt/i,
];

/**
 * 明顯的情緒困擾訊號。
 *
 * **偵測到不阻擋、不叫模型、直接回一段關懷的話。** 規格書文件 01
 * §12.2 要求這件事，而它在補習班場景不是加分項：一位高三生在
 * 半夜檢討模擬考時打出這種句子，系統回一句「這一步你再想想」
 * 是很糟的一件事。
 *
 * 樣式刻意抓得窄——「這題難到爆」「我要瘋了」不在裡面。誤判的成本
 * 是一句用不上的關心，漏判的成本是另一回事，但把每一句抱怨都
 * 當成危機處理會讓學生不敢再打字。
 */
const DISTRESS = [
  /不想活/, /活不下去/, /想死/, /自殺/, /輕生/,
  /傷害自己/, /割腕/, /結束(?:自己的)?生命/,
  /(?:真的)?撐不下去了/, /我沒有用了?/,
];

/**
 * @returns {{ok: boolean, code: 'INJECTION'|'EMPTY'|null, reason: string, distress: boolean}}
 */
export function checkStudentMessage(text) {
  const raw = String(text ?? '');
  const t = normalizeForGuard(raw);
  const distress = DISTRESS.some((re) => re.test(t));

  if (t.length === 0) {
    return { ok: false, code: 'EMPTY', reason: '訊息是空的', distress };
  }
  for (const re of INJECTION) {
    if (re.test(t)) {
      return {
        ok: false,
        code: 'INJECTION',
        reason: '這則訊息想改寫智慧老師的規則（提示注入），沒有送給模型',
        distress,
      };
    }
  }
  return { ok: true, code: null, reason: '', distress };
}

/** 偵測到情緒困擾時回的話。不呼叫模型——這種時候不需要一個模型。 */
export const DISTRESS_REPLY =
  '先停一下，這一題沒有那麼重要。' +
  '你剛剛說的話我看到了，如果現在心裡很難受，先去找你的老師或家人講一講，' +
  '或者打 1925（安心專線，24 小時免付費）。' +
  '題目我隨時都在這裡，等你想看的時候再回來。';

/** 提示注入被擋下來時回的話。要說得出擋的是什麼，不要含糊。 */
export const INJECTION_REPLY =
  '這一則我沒有辦法照做——我的規則不會在對話裡被改掉。' +
  '不過你想知道答案的話，這一頁上面就有正確答案跟解析，你隨時看得到。' +
  '我們回到題目：你目前想到哪裡了？';

// ─────────────────────────────────────────────────────────────────
// 三種模式
//
// # 為什麼是「按鈕 ＋ 自動判斷」而不是二選一
//
// 業主點名了 Step by Step / Small tips / Basic Topics 三種。實作方式
// 有三個選項，兩個純的都不成立：
//
// **純自動判斷不行。** 學生只是把負號抄錯，系統判成觀念不清、
// 開始一步一步拆基本觀念——那正是「AI 功能不好用」的具體樣子。
// 而且他沒有任何辦法告訴系統「我不需要這個」。
//
// **純按鈕也不行。** 一個完全卡住的高中生，你要他先自己診斷
// 「我這是觀念誤解還是前置缺失」——那個判斷本身就需要他已經懂了。
// 而且三顆按鈕擺在對話框上方，最常被按的一定是他覺得最快的那一顆，
// 不是他需要的那一顆。
//
// **所以：預設自動，但學生按得動。** 系統依卡點與前置掌握度先選一種
// （這一支，確定性的，測得到），對話中三顆小按鈕隨時可以改。
// 學生按下去就以他的為準——他比系統更知道自己現在要什麼，
// 而且「按了沒反應」比「選錯了」傷害大得多。
//
// 這一支放在閘門這個檔案裡，因為它與閘門是同一種東西：**必須是
// 確定性的、必須測得到、而且不可以碰資料庫。** 模式若由模型自己
// 在對話中決定，它會在學生嫌慢的時候切到一種沒有名字的模式，
// 而那種模式就是直接講答案。
// ─────────────────────────────────────────────────────────────────

/** @typedef {'AUTO'|'SMALL_TIP'|'STEP_BY_STEP'|'BASIC_TOPIC'} TutorMode */

export const TUTOR_MODES = ['SMALL_TIP', 'STEP_BY_STEP', 'BASIC_TOPIC'];

export const MODE_LABELS = {
  SMALL_TIP: '給我一點提示',
  STEP_BY_STEP: '一步一步帶我',
  BASIC_TOPIC: '回頭講基本觀念',
  AUTO: '由老師判斷',
};

/** 掌握度低於這個值就當成「前置沒有掌握」。樣本不足時不算（見 reliable）。 */
const WEAK_MASTERY = 0.5;

/** 卡點的關鍵詞 → 模式。順序有意義：先比對比較具體的那幾種。 */
const STUCK_HINTS = [
  [/算到一半|算錯|粗心|看錯|符號|正負|漏掉|抄錯|差一點|快算出來/, 'SMALL_TIP'],
  [/完全不知道|不知道從哪|沒學過|完全不會|沒印象|忘光/, 'BASIC_TOPIC'],
  [/看不懂題目|題目在問什麼|讀不懂|不知道題目/, 'STEP_BY_STEP'],
  [/以為(?:我)?(?:是)?對|為什麼(?:不對|錯)|哪裡錯/, 'STEP_BY_STEP'],
  [/解析|看了還是不懂|還是不懂/, 'BASIC_TOPIC'],
];

/**
 * 這一輪用哪一種模式。
 *
 * @param {object} inp
 * @param {TutorMode} [inp.forced]  學生自己按的。按了就以他為準。
 * @param {string|null} [inp.stuckAt]
 * @param {string} [inp.verdict] CORRECT / PARTIAL / WRONG / BLANK / PENDING
 * @param {{name: string, mastery: number|null, reliable?: boolean}[]} [inp.prerequisites]
 * @param {number} [inp.turn]
 * @returns {TutorMode}
 */
export function pickMode(inp = {}) {
  const forced = inp.forced;
  if (forced && forced !== 'AUTO' && TUTOR_MODES.includes(forced)) return forced;

  const stuck = normalizeForGuard(inp.stuckAt ?? '');

  // 前置知識點掌握度不足時一律先補前置。**這一條排在卡點之前**，
  // 因為學生說得出「我算到一半卡住」的時候，他不知道自己卡住的
  // 原因是三章之前的一個公式沒有掌握——而系統知道。
  // 但要有「可靠」旗標：樣本太少的掌握度是雜訊，拿它把學生送回
  // 前置觀念，他會覺得系統在浪費他的時間。
  const weak = (inp.prerequisites ?? []).filter(
    (p) => typeof p?.mastery === 'number' && p.mastery < WEAK_MASTERY && p.reliable !== false,
  );
  if (weak.length > 0) return 'BASIC_TOPIC';

  for (const [re, mode] of STUCK_HINTS) {
    if (re.test(stuck)) {
      // 「完全不知道」而且沒有前置可補時，往回退也沒有地方退，
      // 只能在這一題上拆步驟。
      if (mode === 'BASIC_TOPIC' && (inp.prerequisites ?? []).length === 0) return 'STEP_BY_STEP';
      return mode;
    }
  }

  // 多選題部分給分：他對了一半，那是提示就夠的情況。
  if (inp.verdict === 'PARTIAL') return 'SMALL_TIP';

  // 還沒問出卡點（第一輪）就不要替模型決定。AUTO 會讓提示詞裡的
  // 判斷區塊生效，而那一段要求它先判斷再照那一種做。
  if (!stuck) return 'AUTO';

  return 'STEP_BY_STEP';
}

// ─────────────────────────────────────────────────────────────────
// 退路
// ─────────────────────────────────────────────────────────────────

/**
 * 重試用完之後送給學生的話。
 *
 * **不可以是「系統忙碌中，請稍後再試」。** 對學生來說那等於功能壞了，
 * 而它其實沒壞——是模型剛剛三次都想把答案講出來。所以退路仍然是
 * 一句真的能往前走的引導問句，而且依模式不同（在 Small tip 模式裡
 * 問「這一題給了哪些條件」是白問，他早就知道了）。
 *
 * 這幾句沒有一句碰得到答案，所以它們永遠通得過自己的閘門。
 */
const FALLBACKS = {
  SMALL_TIP: [
    '我們換個方式：你把剛剛的算式從頭念一次給我聽，念到哪一步你覺得最沒把握？',
    '先不要重算。你回頭看你寫的第一行，那一行的每一個數字都是題目給的嗎？',
  ],
  STEP_BY_STEP: [
    '我們慢一點。這一題如果只做第一步，你覺得第一步該做什麼？',
    '先把題目裡給的條件一個一個列出來給我看，列好了嗎？',
  ],
  BASIC_TOPIC: [
    '這一題先放著。你先告訴我，這個單元裡最基本的那個定義，你會怎麼用自己的話講？',
    '我們退一步：這一題用到的公式，你記得它是從哪裡來的嗎？',
  ],
  AUTO: [
    '先講講看你當時是怎麼想的？從你看到題目的第一個念頭開始就好。',
    '你卡住的地方比較像「不知道要用什麼」還是「知道要用什麼但算不出來」？',
  ],
};

/**
 * 連退路都撞到答案時的最後一句。
 *
 * 它只指涉這一頁上的東西（解析、題號、老師），不含任何可能是
 * 某一題答案的內容詞。
 */
const LAST_RESORT =
  '這一輪我想不到一個好問題問你。先看看上面的解析，' +
  '還是不懂的話把題號抄下來直接問老師，那樣會比較快。';

/**
 * @param {TutorMode} mode
 * @param {number} turn 用來輪替句子。同一段對話裡連續兩次退路，
 *   回同一句話會讓學生確定這是罐頭——而它本來就是罐頭，
 *   但至少不要是同一個罐頭。
 * @param {AnswerFacts} [facts] 給了就用閘門檢查退路本身。
 *
 * # 為什麼退路自己也要過閘門
 *
 * 因為退路是寫死的句子，而**答案不是**。一道填充題的標準答案剛好是
 * 「條件」的時候，「先把題目裡給的條件列出來」這一句就洩漏了答案。
 * 機率很低，但它會發生在某一位學生的某一題上，而那時候沒有人查得出來
 * ——退路是不記 blocked 的那一則。
 */
export function safeFallback(mode, turn = 1, facts = null) {
  const bank = FALLBACKS[mode] ?? FALLBACKS.AUTO;
  const start = Math.max(0, turn - 1) % bank.length;
  if (!facts) return bank[start];

  // 先試這個模式的，再試其他模式的。全部撞到就用最後那一句。
  const candidates = [
    ...bank.slice(start),
    ...bank.slice(0, start),
    ...Object.values(FALLBACKS).flat(),
  ];
  for (const c of candidates) {
    if (!checkTutorReply(c, facts).leaked) return c;
  }
  return LAST_RESORT;
}
