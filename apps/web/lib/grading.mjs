/**
 * 客觀題自動評分。**純函式、零相依。**
 *
 * # 為什麼整段抽成 .mjs
 *
 * 這是全系統最不能出錯的一段（文件 05 階段 3、藍圖 B4）。它沒有
 * 相依，就測得動：`node --test` 直接載入，不需要資料庫、不需要
 * Prisma 引擎、不需要跑起 Next。與資料庫互動的那一層在
 * `lib/scoring.ts`，它只負責「讀出來、算、寫回去」，
 * 所有會算錯的邏輯都在這個檔案裡，而這個檔案有 `tests/grading.test.mjs`。
 *
 * # 三條貫穿整份實作的規則
 *
 * **一、不確定就交給人，不猜。** 每個計分函式都可能回傳
 * `needsReview: true` 與 `earnedScore: null`。那不是失敗，那是
 * 這一題的資料不足以確定地判定（沒有標準答案、選項編號對不上、
 * 選填的寫法無法判斷等值）。猜一個 0 分下去，學生沒有任何跡象
 * 可以發現自己被誤判——而他不會來申訴一個他不知道的錯誤。
 *
 * **二、scoreNote 要說得出人話。** 學生看到「這題 3 分」的第一個
 * 反應是「為什麼不是 5 分」。多選部分給分尤其如此，所以每一題都
 * 附一句「答錯 1 個選項：(5 − 2×1)/5 = 3/5 的配分，得 3 分」。
 *
 * **三、scoreNote 不寫出正確答案。** 它存在 AttemptAnswer 上，
 * 而解析什麼時候放行是 `Assignment.releasePolicy` 決定的
 * （ON_DUE 是為了避免先寫完的人洩題）。計分順手把答案寫進去，
 * 等於繞過那個設定。
 *
 * # 官方規則出處（文件 A.2）
 *
 *   單選題：答錯、未作答、多劃記皆得 0 分
 *   多選題：答錯 k 個選項得該題 `(n − 2k)/n` 的分數，n 為選項總數，
 *           **計算結果低於零分或全部未作答者以 0 分計**
 *   選填題：整題全對才給分，答錯不倒扣
 */

// ═══════════════════════════════════════════════════════════════
// 文字正規化與數學等價
// ═══════════════════════════════════════════════════════════════

/** NFKC 收不掉的各種「像減號的東西」。學生從 PDF 複製貼上就會帶進來。 */
const MINUS_LIKE = /[‐‑‒–—―−﹘﹣]/g;

/**
 * 看起來像「還有數學結構沒被解析掉」的記號。出現這些而兩邊字串又
 * 不相等時，一律判需人工確認——`√2` 與 `1.414` 到底算不算同一個
 * 答案，那是老師的判斷，不是字串比對能決定的。
 */
const RISKY_MARKUP = /[\\^√π∘°∞±×÷≈<>≤≥=∑∫∠]|分之|根號|次方|倍/;

/** 中文數字。「二分之一」是學生真的會寫的東西，但解析它比不解析更危險。 */
const CJK_NUMERAL = /[〇零一二三四五六七八九十百千萬億兩半]/;

/**
 * 答案文字的正規化。**吸收寫法差異，不改變答案本身。**
 *
 * 做四件事：
 *   一、NFKC——全形數字 `１`、全形斜線 `／`、全形句點 `．`、全形加號
 *       `＋` 一次處理掉。台灣的輸入法在中文模式下打出來的就是這些，
 *       而 `．5` 與 `.5` 在畫面上幾乎看不出差別。
 *   二、各種破折號、連字號、真正的減號 `−` 一律變成 ASCII 的 `-`。
 *   三、去掉所有空白（含全形空白）。`1 / 2` 與 `1/2` 是同一個答案。
 *   四、頓號與全形逗號變成半形逗號，去掉句末的句號。
 */
export function normalizeAnswerText(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw);
  if (!s) return '';
  s = s.normalize('NFKC');
  s = s.replace(MINUS_LIKE, '-');
  // NFKC 把 ½ 拆成「1 ⁄ 2」，中間那個是分數斜線（U+2044）而不是 `/`。
  // 不換掉的話 ½ 永遠解析不出來，而它會出現在複製貼上的題目裡。
  s = s.replace(/⁄/g, '/');
  s = s.replace(/[\s 　]+/g, '');
  s = s.replace(/[、]/g, ',');
  s = s.replace(/[。．｡]+$/g, '');
  return s;
}

/**
 * 把最單純的 LaTeX 分數寫法換成 `a/b`，並去掉數學模式的標點。
 *
 * 只處理 `\frac{2}{3}` 這種**兩個大括號裡都沒有再巢狀**的形式。
 * 更複雜的（根號、次方、巢狀分數）刻意不處理——處理到一半的
 * 解析器會給出看起來成功的錯誤結果，那比解析失敗糟得多。
 */
function stripMath(s) {
  return s
    .replace(/\\[dt]?frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
    .replace(/\\%/g, '%')
    .replace(/[$]/g, '')
    .replace(/\\[(),;!\][ ]/g, '')
    .replace(/\{|\}/g, '');
}

function gcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x;
}

/** 十進位字串轉分數。`0.50` → 50/100，之後約分。不經過浮點數。 */
function decimalToRational(text) {
  const [intPart, fracPart = ''] = text.split('.');
  const digits = `${intPart || '0'}${fracPart}`;
  if (!/^\d+$/.test(digits)) return null;
  return { num: BigInt(digits), den: 10n ** BigInt(fracPart.length) };
}

const NUMBER_RE =
  /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:\/([+-]?)(\d+(?:\.\d*)?|\.\d+))?(.*)$/;

/**
 * 把答案讀成**有理數加單位**。讀不出來就回 null——回 null 是安全的，
 * 因為呼叫端會把它轉成「需人工確認」而不是「答錯」。
 *
 * **刻意用 BigInt 而不是 parseFloat。** `0.1 + 0.2 !== 0.3` 這件事在
 * 計分上的後果是：兩個數學上相等的答案被判不同，而且只在特定數值
 * 上發生，測不到的那種。分子分母交叉相乘比較，完全避開浮點數。
 *
 * 單位（`公分`、`元`、`%`）保留下來由呼叫端決定怎麼處理——這裡
 * 不做單位換算，`0.03公尺` 與 `3公分` 交給老師判。
 */
export function parseRational(raw) {
  let s = normalizeAnswerText(stripMath(normalizeAnswerText(raw)));
  if (!s) return null;
  // 千分位逗號。只在整串真的長得像「1,234,567.8」時才拿掉，
  // 否則 `1,2`（兩個答案）會被讀成 12。
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  // 句末的半形句點：`0.5.` 不去掉的話，尾巴那一點會被當成單位，
  // 於是與 `0.5` 判成「單位不同」而丟給人工。
  s = s.replace(/\.$/, '');

  const m = NUMBER_RE.exec(s);
  if (!m) return null;
  const [, sign1, a, sign2 = '', b, rest = ''] = m;
  // 尾巴還有數字，代表這不是「一個數加單位」（`1/2/3`、`3x4`、`1或2`）。
  if (/\d/.test(rest)) return null;

  const top = decimalToRational(a);
  if (!top) return null;
  let num = top.num;
  let den = top.den;

  if (b !== undefined) {
    const bot = decimalToRational(b);
    if (!bot) return null;
    if (bot.num === 0n) return null; // 分母 0：資料本身有問題
    num *= bot.den;
    den *= bot.num;
    if (sign2 === '-') num = -num;
  }
  if (sign1 === '-') num = -num;
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den) || 1n;
  return { num: num / g, den: den / g, unit: rest };
}

/** 兩個有理數相等。交叉相乘，不除。 */
function sameRational(x, y) {
  return x.num * y.den === y.num * x.den;
}

/** 這個字串有沒有「可能其實是個數」的成分。有的話就不敢判它答錯。 */
function looksNumericish(s) {
  return /\d/.test(s) || CJK_NUMERAL.test(s) || RISKY_MARKUP.test(s);
}

/**
 * 兩個答案是不是同一個答案。
 *
 * 回傳 `'SAME'`、`'DIFFERENT'`、`'UNSURE'` 三種。**`UNSURE` 是這個
 * 函式存在的理由**：`1/2` 與 `0.5` 判相同是基本要求，但
 * `√2` 與 `1.414`、`50%` 與 `0.5`、`Na` 與 `na` 這幾種，
 * 任何一個判定都可能是錯的，而錯的那個方向沒有人會發現。
 *
 * 判定順序（先到先用）：
 *   1. 正規化後完全相同 → SAME
 *   2. 一邊空白 → DIFFERENT（沒作答就是沒作答）
 *   3. 兩邊都讀得出數：單位相同就比值，單位不同 → UNSURE
 *   4. 只有一邊是數：另一邊有數字味（含中文數字）→ UNSURE，否則 DIFFERENT
 *   5. 只差大小寫 → UNSURE（`Co` 是鈷、`CO` 是一氧化碳，不敢自己決定）
 *   6. 任一邊還有沒解析掉的數學記號或數字 → UNSURE
 *   7. 其餘（純文字且不同）→ DIFFERENT
 */
export function mathEquivalent(a, b) {
  const na = normalizeAnswerText(a);
  const nb = normalizeAnswerText(b);
  if (na === nb) return 'SAME';
  if (!na || !nb) return 'DIFFERENT';

  const pa = parseRational(na);
  const pb = parseRational(nb);
  if (pa && pb) {
    if (pa.unit !== pb.unit) return 'UNSURE';
    return sameRational(pa, pb) ? 'SAME' : 'DIFFERENT';
  }
  if (pa || pb) return looksNumericish(pa ? nb : na) ? 'UNSURE' : 'DIFFERENT';

  if (na.toLowerCase() === nb.toLowerCase()) return 'UNSURE';
  if (looksNumericish(na) || looksNumericish(nb)) return 'UNSURE';
  return 'DIFFERENT';
}

// ═══════════════════════════════════════════════════════════════
// 共用小工具
// ═══════════════════════════════════════════════════════════════

/**
 * 分數的收斂。浮點數的 `5 * 3 / 5` 會出現 `2.9999999999999996`，
 * 一份 60 題的卷子加起來就變成「總分 79.99999999999999」。
 * 每一題與總分都收到小數第六位。
 */
export function roundScore(x) {
  return Math.round((x + Number.EPSILON) * 1e6) / 1e6;
}

/** 給人看的分數：`3`、`2.4`，不是 `3.000000`。 */
export function formatScore(x) {
  return String(roundScore(x));
}

/** 一個結果。四個欄位對應 AttemptAnswer 的三欄加上「要不要人看」。 */
function result(isCorrect, earnedScore, scoreNote, needsReview = false) {
  return { isCorrect, earnedScore, scoreNote, needsReview };
}

/** 需人工確認。**earnedScore 是 null 而不是 0**——見檔頭第一條規則。 */
function review(why) {
  return result(null, null, `需人工確認：${why}`, true);
}

/**
 * 答案鍵的整理：去重、排序、擋掉不是正整數的東西。
 *
 * `AttemptAnswer.answerKeys` 是 `Int[]`，對 `question_options`
 * **沒有外鍵也沒有 CHECK**（見 schema），所以 0、負數、重複值
 * 都塞得進去。重複值特別危險：多選題算答錯幾個是用集合差，
 * 不去重的話 `[2,2]` 會被算成兩個。
 */
function cleanKeys(raw) {
  if (!Array.isArray(raw)) return { keys: [], bad: raw === null || raw === undefined ? [] : [raw] };
  const keys = [];
  const bad = [];
  for (const k of raw) {
    const n = typeof k === 'number' ? k : Number(k);
    if (!Number.isInteger(n) || n < 1) bad.push(k);
    else if (!keys.includes(n)) keys.push(n);
  }
  keys.sort((x, y) => x - y);
  return { keys, bad };
}

function sameSet(a, b) {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * 選項洗牌之後的還原。
 *
 * `Attempt.layout` 可以帶 `optionOrder`（隨機出題時每個人的選項順序
 * 不同）。**這裡預設學生的 answerKeys 存的是題庫的原始編號**，
 * 因為那是唯一在老師改題、選項增減之後仍然有意義的座標系。
 *
 * 若作答層存的是「畫面上的第幾個」，它必須在 layout 上明說
 * （`keysAreDisplayOrder: true`），然後由這個函式換回原始編號。
 * 兩邊講好的方式不一致而沒有人發現，是這一段最貴的失敗——
 * 症狀是全班的分數都不對，但每一題看起來都被正常計分了。
 *
 * @param {number[]} keys 畫面上的位置（1 起算）
 * @param {number[]} optionOrder 位置 i 顯示的是原始的第 optionOrder[i] 個
 * @returns {number[]|null} null 代表對不上，呼叫端要判需人工確認
 */
export function mapDisplayKeys(keys, optionOrder) {
  if (!Array.isArray(optionOrder) || optionOrder.length === 0) return null;
  const out = [];
  for (const k of keys) {
    const canonical = optionOrder[k - 1];
    if (!Number.isInteger(canonical) || canonical < 1) return null;
    out.push(canonical);
  }
  return out.sort((a, b) => a - b);
}

// ═══════════════════════════════════════════════════════════════
// 單選題
// ═══════════════════════════════════════════════════════════════

/**
 * 單選題。答錯、未作答、**多劃記**皆得 0 分（文件 A.2）。
 *
 * 多劃記要單獨判：它與「答錯」在資料上長得不一樣（陣列長度 2），
 * 而學生看到「多劃記」才知道是自己畫了兩個，不是選錯。
 * 線上作答理論上不會發生，但**答案卡辨識匯入**會，而且那正是
 * 最需要一句解釋的場合。
 *
 * @param {number[]} answerKeys 學生選了什麼
 * @param {number[]} correctKeys 標準答案
 * @param {number} score 這一題的配分
 * @param {number} [optionCount] 選項總數。給了就順便檢查標準答案
 *   指不指得到真的選項——指不到的話**全班都是 0 分而完全沒有跡象**。
 */
export function gradeSingleChoice(answerKeys, correctKeys, score, optionCount) {
  const want = cleanKeys(correctKeys);
  if (want.keys.length === 0) return review('這一題沒有標準答案');
  if (want.keys.length > 1) {
    return review(`單選題卻有 ${want.keys.length} 個標準答案，題目資料要先修正`);
  }
  const n = Number(optionCount);
  if (Number.isInteger(n) && n > 0 && want.keys[0] > n) {
    return review('標準答案指到不存在的選項，題目資料要先修正');
  }
  const got = cleanKeys(answerKeys);
  if (got.bad.length > 0) return review('作答記錄裡有不合法的選項編號');
  if (got.keys.length === 0) return result(false, 0, '未作答，0 分');
  if (got.keys.length > 1) {
    return result(false, 0, `多劃記（劃記了 ${got.keys.length} 個），單選題一律 0 分`);
  }
  if (got.keys[0] === want.keys[0]) {
    return result(true, roundScore(score), `答對，得 ${formatScore(score)} 分`);
  }
  return result(false, 0, '答錯，0 分');
}

// ═══════════════════════════════════════════════════════════════
// 多選題
// ═══════════════════════════════════════════════════════════════

/**
 * 多選題的部分給分：`(n − 2k) / n`。
 *
 *   n = 選項總數（不是正確答案的個數——這是最容易寫錯的一處）
 *   k = 答錯的選項數 = 該選沒選 + 不該選卻選了（對稱差）
 *
 * 三個邊界都會實際發生，而且都不是理論上的：
 *
 *   **負分要歸零。** n=5 的題目答錯 3 個，`(5−6)/5 = −0.2`。
 *   不歸零的話這一題把別題的分數扣掉了，總分會低於它應有的值，
 *   而學生自己手算對不起來。
 *
 *   **全部未作答是 0 分，不是套公式。** 空白卷在公式下 k = 正確答案
 *   個數，n=5、正確答案 2 個時算出 `(5−4)/5 = 0.2`，一題送 1 分。
 *   一份 6 題多選的卷子，什麼都不寫可以拿 6 分。官方規則明寫
 *   「全部未作答者以 0 分計」，這一條就是為了擋這個。
 *
 *   **全選也不划算。** n=5、正確 2 個，全選 k=3 → 負的 → 0 分。
 *
 * @param {number[]} answerKeys 學生選了什麼
 * @param {number[]} correctKeys 標準答案
 * @param {number} optionCount 選項總數 n（數學 5 個、英文 4 個，不固定）
 * @param {number} score 這一題的配分
 * @param {{mode?: 'GSAT_PARTIAL'|'ALL_OR_NOTHING'}} [rule] Question.scoringRule
 */
export function gradeMultiChoice(answerKeys, correctKeys, optionCount, score, rule) {
  const n = Number(optionCount);
  if (!Number.isInteger(n) || n < 2) {
    // 選項沒入庫或只有一個。硬算會得到荒謬的分數（n=0 時除以 0）。
    return review('這一題的選項總數不明，無法套用部分給分公式');
  }
  const want = cleanKeys(correctKeys);
  if (want.keys.length === 0) return review('這一題沒有標準答案');
  if (want.keys.some((k) => k > n)) {
    // 選項被重新編號而答案沒跟著改（見 lib/questionShape.mjs 的說明）。
    return review('標準答案指到不存在的選項，題目資料要先修正');
  }

  const got = cleanKeys(answerKeys);
  if (got.bad.length > 0) return review('作答記錄裡有不合法的選項編號');
  if (got.keys.some((k) => k > n)) {
    return review('作答的選項編號超出這一題的選項數，可能是選項順序對不上');
  }
  if (got.keys.length === 0) {
    return result(false, 0, '未作答，0 分（未作答不套部分給分公式）');
  }

  const wrong = [
    ...want.keys.filter((k) => !got.keys.includes(k)), // 該選沒選
    ...got.keys.filter((k) => !want.keys.includes(k)), // 不該選卻選了
  ];
  const k = wrong.length;

  if (rule && rule.mode === 'ALL_OR_NOTHING') {
    return k === 0
      ? result(true, roundScore(score), `全對，得 ${formatScore(score)} 分`)
      : result(false, 0, `答錯 ${k} 個選項；這一題設定為全對才給分，0 分`);
  }

  if (k === 0) return result(true, roundScore(score), `全對，得 ${formatScore(score)} 分`);

  const ratio = (n - 2 * k) / n;
  if (ratio <= 0) {
    return result(
      false,
      0,
      `答錯 ${k} 個選項：(${n} − 2×${k})/${n} 不大於 0，依規定以 0 分計`,
    );
  }
  const earned = roundScore(score * ratio);
  return result(
    false,
    earned,
    `答錯 ${k} 個選項：(${n} − 2×${k})/${n} = ${n - 2 * k}/${n} 的配分，` +
      `得 ${formatScore(earned)} 分（滿分 ${formatScore(score)} 分）`,
  );
}

// ═══════════════════════════════════════════════════════════════
// 選填題
// ═══════════════════════════════════════════════════════════════

/**
 * 把答案格讀成陣列。
 *
 * 三種形狀都吃，因為 `answerSlots` 是 Json 欄位，而三種寫法都合理：
 *   `['1','2']`、`{'13':'1','14':'2'}`（格位編號當鍵）、`'12'`（單格）。
 * 物件的鍵用數值排序，`'2'` 要排在 `'10'` 前面——字串排序會反過來，
 * 而那會讓兩格的答案對調，然後這一題被判錯。
 */
export function slotList(raw) {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map((v) => (v === null || v === undefined ? '' : String(v)));
  if (typeof raw === 'object') {
    const keys = Object.keys(raw);
    keys.sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return keys.map((k) => (raw[k] === null || raw[k] === undefined ? '' : String(raw[k])));
  }
  return [String(raw)];
}

/**
 * 選填題。**整題全對才給分，答錯不倒扣**（文件 A.2）。
 *
 * 學測的選填是「答案填入答案卡的編號格位」，一格一個字元
 * （數字或負號）。逐格比對，任何一格不同就是 0 分——不做部分給分，
 * 因為官方規則沒有部分給分。
 *
 * @param {unknown} answerSlots 學生填的（陣列或以格位為鍵的物件）
 * @param {unknown} correctSlots 標準答案
 * @param {number} score 配分
 */
export function gradeFillSlot(answerSlots, correctSlots, score) {
  const want = slotList(correctSlots);
  if (want.length === 0 || want.every((v) => normalizeAnswerText(v) === '')) {
    return review('這一題沒有標準答案');
  }
  const got = slotList(answerSlots);
  if (got.length > want.length) {
    // 學生填的格數比標準答案多，代表這一題在他作答之後被改過
    // （或是作答介面與題目對不上）。硬比會比錯位置。
    return review(`作答有 ${got.length} 格、標準答案只有 ${want.length} 格，兩者對不上`);
  }
  if (got.every((v) => normalizeAnswerText(v) === '')) {
    return result(false, 0, '未作答，0 分');
  }

  const wrong = [];
  const unsure = [];
  for (let i = 0; i < want.length; i++) {
    const verdict = mathEquivalent(got[i] ?? '', want[i]);
    if (verdict === 'UNSURE') unsure.push(i + 1);
    if (verdict === 'DIFFERENT') wrong.push(i + 1);
  }
  // **有一格確定錯了就已經定案**，因為選填是整題全對才給分。
  // 這時另一格判不判得出來不影響結果，不必送進人工佇列——
  // 送了只會讓老師看一份他無論如何都只能按「維持原判」的卷子。
  if (wrong.length === 0 && unsure.length > 0) {
    return review(`第 ${unsure.join('、')} 格的寫法無法確定是否等值`);
  }
  if (wrong.length === 0) {
    return result(true, roundScore(score), `${want.length} 格全對，得 ${formatScore(score)} 分`);
  }
  return result(
    false,
    0,
    `第 ${wrong.join('、')} 格不對；選填題整題全對才給分，0 分（不倒扣）`,
  );
}

// ═══════════════════════════════════════════════════════════════
// 填充（自由書寫的短答案）
// ═══════════════════════════════════════════════════════════════

/**
 * 把標準答案切成「幾種都算對的寫法」。
 *
 * **`|` 不一定是分隔符。** 絕對值 `|x|=3`、LaTeX 的 `\left|x\right|`
 * 裡的直線是答案本身的一部分，切開之後會變成兩個誰也不等於的碎片，
 * 而那一題全班都會被判錯。所以只有在**切出來每一段都不是空的、
 * 而且整串沒有反斜線（不是 LaTeX）**時才當成分隔符——
 * `|x|` 會切出空的頭尾，剛好落在這條規則外面。
 *
 * 判斷錯的方向也選過：把分隔符當成答案的一部分，症狀是「多寫的
 * 那個寫法沒有生效」，學生會進人工佇列；反過來則是直接判錯。
 *
 * **匯出是給檢討頁用的。** 那一頁要在學生面前印出標準答案，而
 * 「`1/2|0.5` 這一串到底是一個答案還是兩個」必須與計分時的判斷完全
 * 一致——各寫一份的話，畫面上印著兩個答案而計分只認一個（或反過來），
 * 學生照著畫面申訴，而兩邊都覺得自己是對的。
 */
export function splitAlternatives(raw) {
  const whole = normalizeAnswerText(raw) === '' ? [] : [raw.trim()];
  if (!raw.includes('|')) return whole;
  if (raw.includes('\\')) return whole;
  const parts = raw.split('|').map((s) => s.trim());
  if (parts.some((s) => normalizeAnswerText(s) === '')) return whole;
  return parts;
}

/**
 * 填充題。做數學等價判定，判不出來就交給人。
 *
 * 標準答案可以用 `|` 列出多個都算對的寫法（`1/2|0.5|二分之一`）。
 * 這是老師實際會需要的：同一個答案的合理寫法不只一種，而
 * 「多寫一個 `|`」比「事後一份一份改回來」便宜得多。
 *
 * @param {unknown} answerText 學生寫的
 * @param {unknown} correctText 標準答案，`|` 分隔多個可接受寫法
 * @param {number} score 配分
 */
export function gradeFillText(answerText, correctText, score) {
  const raw = correctText === null || correctText === undefined ? '' : String(correctText);
  const alternatives = splitAlternatives(raw);
  if (alternatives.length === 0) return review('這一題沒有標準答案');

  if (normalizeAnswerText(answerText) === '') return result(false, 0, '未作答，0 分');

  const verdicts = alternatives.map((alt) => ({ alt, verdict: mathEquivalent(answerText, alt) }));
  if (verdicts.some((v) => v.verdict === 'SAME')) {
    return result(true, roundScore(score), `答對，得 ${formatScore(score)} 分`);
  }
  const unsure = verdicts.filter((v) => v.verdict === 'UNSURE');
  if (unsure.length === 0) return result(false, 0, '答錯，0 分');

  // 有判不出來的寫法時，還有一種情況可以確定地判錯：
  // **學生寫的讀得出是一個數，標準答案裡也至少有一個讀得出是數，
  // 而判不出來的那幾個是標準答案自己那一邊讀不出來。**
  //
  // 沒有這一條的話，老師只要在答案裡多寫一個 `|二分之一`，
  // 這一題所有答錯的人都會排進人工佇列——於是老師學到的是
  // 「不要用這個功能」，而那個功能本來是為了少改幾份卷子。
  //
  // 代價是：若答案欄真的列了**兩個不同的值**而其中一個讀不出來
  // （`0.5|√2/2` 這種），可能誤判。那是罕見而且答案欄本身就有問題
  // 的寫法，而部分給分的多選題與選填題都不走這條路徑。
  const studentIsNumber = parseRational(answerText) !== null;
  const definiteWrong = verdicts.some((v) => v.verdict === 'DIFFERENT');
  if (studentIsNumber && definiteWrong && unsure.every((v) => parseRational(v.alt) === null)) {
    return result(false, 0, '答錯，0 分');
  }
  return review('作答與標準答案的寫法不同，無法確定是否等值');
}

/**
 * 簡答題的規則比對（文件 01 第 10.1 節的第二條路徑）。
 *
 * 只做**純程式判定得了**的兩種：完全相符與關鍵詞包含。
 * 「AI 語意判定」不在這裡——這個檔案的整個價值就在於它是
 * 100% 確定性的，把模型呼叫放進來會毀掉這一點。
 *
 * @param {unknown} answerText 學生寫的
 * @param {{mode?: string, keywords?: string[], answer?: string}} rule 比對規則
 * @param {number} score 配分
 */
export function gradeShortAnswerByRule(answerText, rule, score) {
  const mode = rule && typeof rule.mode === 'string' ? rule.mode : '';
  if (mode === 'EXACT') return gradeFillText(answerText, rule.answer ?? '', score);
  if (mode === 'CONTAINS') {
    const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
    if (keywords.length === 0) return review('這一題設定為關鍵詞比對，但沒有設定關鍵詞');
    const got = normalizeAnswerText(answerText);
    if (!got) return result(false, 0, '未作答，0 分');
    const missing = keywords.filter((k) => !got.includes(normalizeAnswerText(k)));
    if (missing.length === 0) {
      return result(true, roundScore(score), `包含全部 ${keywords.length} 個關鍵詞，得 ${formatScore(score)} 分`);
    }
    return result(false, 0, `少了 ${missing.length} 個關鍵詞（共 ${keywords.length} 個），0 分`);
  }
  return null; // 不是規則比對，交給人工或 AI
}

// ═══════════════════════════════════════════════════════════════
// 整份卷子
// ═══════════════════════════════════════════════════════════════

/** 這些題型這個檔案不評——非選題要人或 AI 看（文件 03 第 3 節）。 */
const MANUAL_TYPES = new Set(['ESSAY', 'TRANSLATION', 'SHORT_ANSWER']);

/**
 * 一題的計分。把題型分派到上面那幾個函式。
 *
 * @param {object} item 題目端的資料（見 gradeAttempt 的說明）
 * @param {object|null} answer 學生端的資料
 */
function gradeItem(item, answer) {
  const score = Number(item.score) || 0;
  const type = String(item.type ?? '');
  const a = answer ?? {};

  // 選項洗牌過而且作答存的是畫面順序時，先換回題庫的原始編號。
  let keys = a.answerKeys;
  if (item.keysAreDisplayOrder && Array.isArray(keys) && keys.length > 0) {
    const mapped = mapDisplayKeys(keys, item.optionOrder);
    if (mapped === null) {
      return {
        ...review('這一份的選項順序快照對不上作答，無法還原學生選了哪一個'),
        autoGraded: false,
      };
    }
    keys = mapped;
  }

  switch (type) {
    case 'SINGLE_CHOICE':
    case 'TRUE_FALSE':
      return {
        ...gradeSingleChoice(keys, item.correctKeys, score, item.optionCount),
        autoGraded: true,
      };
    case 'MULTI_CHOICE':
      return {
        ...gradeMultiChoice(keys, item.correctKeys, item.optionCount, score, item.scoringRule),
        autoGraded: true,
      };
    case 'FILL_SLOT':
      return { ...gradeFillSlot(a.answerSlots, item.correctSlots, score), autoGraded: true };
    case 'FILL_TEXT':
      return { ...gradeFillText(a.answerText, item.correctText, score), autoGraded: true };
    default: {
      if (MANUAL_TYPES.has(type)) {
        const byRule = gradeShortAnswerByRule(a.answerText, item.scoringRule, score);
        if (byRule) return { ...byRule, autoGraded: true };
        return {
          isCorrect: null,
          earnedScore: null,
          scoreNote: '非選題，等待人工或 AI 評分',
          needsReview: false,
          autoGraded: false,
        };
      }
      return {
        ...review(`不認得的題型「${type || '（空白）'}」`),
        autoGraded: false,
      };
    }
  }
}

/**
 * 整份卷子的自動計分。
 *
 * @param {Array<{
 *   questionId: string, type: string, score: number, order?: number,
 *   correctKeys?: number[], correctSlots?: unknown, correctText?: string|null,
 *   optionCount?: number, scoringRule?: object|null,
 *   optionOrder?: number[], keysAreDisplayOrder?: boolean,
 * }>} items 題目端：從 Attempt.layout 的快照與 Question 讀出來
 * @param {Array<{questionId: string, answerKeys?: number[],
 *   answerText?: string|null, answerSlots?: unknown}>|Map} answers 學生端
 *
 * @returns 每題的結果與四個總計。**`autoScore` 只加「這次真的算出分數的題」**：
 *   需人工確認與非選題的 earnedScore 是 null，不當成 0 加進去。
 *   把它們當 0，畫面上會出現一個看起來已經確定、但其實還沒改完的分數。
 */
export function gradeAttempt(items, answers) {
  const byQuestion = new Map();
  if (answers instanceof Map) {
    for (const [k, v] of answers) byQuestion.set(k, v);
  } else if (Array.isArray(answers)) {
    for (const a of answers) if (a && a.questionId) byQuestion.set(a.questionId, a);
  } else if (answers && typeof answers === 'object') {
    for (const [k, v] of Object.entries(answers)) byQuestion.set(k, v);
  }

  const results = [];
  let autoScore = 0;
  let maxScore = 0;
  let autoMaxScore = 0;
  let needsReview = 0;
  let pendingManual = 0;
  let correctCount = 0;

  for (const [i, item] of (items ?? []).entries()) {
    const graded = gradeItem(item, byQuestion.get(item.questionId) ?? null);
    const score = Number(item.score) || 0;
    maxScore += score;
    if (graded.autoGraded) autoMaxScore += score;
    if (graded.needsReview) needsReview++;
    if (!graded.autoGraded && !graded.needsReview) pendingManual++;
    if (graded.earnedScore !== null) autoScore += graded.earnedScore;
    if (graded.isCorrect === true) correctCount++;

    results.push({
      questionId: item.questionId,
      order: item.order ?? i + 1,
      type: item.type,
      score,
      isCorrect: graded.isCorrect,
      earnedScore: graded.earnedScore,
      scoreNote: graded.scoreNote,
      needsReview: graded.needsReview,
      autoGraded: graded.autoGraded,
    });
  }

  return {
    results,
    autoScore: roundScore(autoScore),
    maxScore: roundScore(maxScore),
    autoMaxScore: roundScore(autoMaxScore),
    correctCount,
    needsReview,
    pendingManual,
  };
}
