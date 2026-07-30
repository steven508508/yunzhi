/**
 * 非選題 AI 閱卷的確定性閘門，以及加總、穩定性、採用率的純函式。
 *
 * # 這一層擋的東西與前兩個 AI 功能都不一樣
 *
 * 智慧老師（`lib/tutorGuard.mjs`）擋的是**洩漏答案**：模型知道答案，
 * 學生想要，它會給。升學建議（`lib/adviceGuard.mjs`）擋的是**製造假的
 * 精確度**：一個編出來的百分比讀起來與查來的一模一樣。
 *
 * 這裡擋的是第三種，而它比前兩種都難看出來：
 *
 * **一、看起來很有道理，實際上在評文采而不是評給分要點。** 一段「文句
 * 通順、結構完整、論述清楚」可以套用到任何一篇作文上——它沒有錯，
 * 只是沒有內容。而它的危險不在於沒用，在於**它會讓老師以為 AI 真的
 * 讀過那篇作文**，於是他按下採用。三十份都這樣按完，那三十個分數
 * 是誰給的？沒有人給的。
 *
 * **二、對同一份答案給出不穩定的分數。** 同一篇作文評兩次差三分，
 * 那兩個數字裡至少有一個是錯的，而畫面上兩個都長得一樣有把握。
 * 這一項不是靠規則擋的，是靠**評 N 次量離散度**（見 `aggregateSamples`）。
 *
 * # 為什麼不共用另外兩個閘門的正規化
 *
 * 與 `adviceGuard` 不共用 `tutorGuard` 是同一個理由，但這裡更具體：
 * tutorGuard 會把 LaTeX 折成純文字、把中文數字折成阿拉伯數字。這兩件事
 * 在這裡都是有害的——**這一層最重要的判斷是「理由裡有沒有引用學生
 * 答案的具體內容」**，而那是把兩段字串攤平之後比對子字串。任何一邊多
 * 折一次、少折一次，比對就對不上，症狀是「所有的理由都被判成通用評語」
 * 或者更糟的「所有通用評語都被放過」。
 *
 * 所以這裡自己有兩支正規化，而且刻意只做最少的事（見下一節）。
 * 共用一份的話，遲早有人為了讓另一邊過而改動它。
 *
 * # 這一層擋不住的四件事，寫出來免得有人以為它做得到
 *
 * 一、**它不知道分數給得對不對。** 它驗的是「這個分數與這段理由自己
 *     對不對得起來」（加總、面向上限、有沒有引用答案），不是「這篇
 *     作文值不值 12 分」。後者沒有任何可機械稽核的基準——那正是
 *     `AnswerGradeProposal` 與 `AttemptAnswer.earnedScore` 是兩張表的
 *     理由。
 * 二、**它擋不住「引用了一句話但評語其實還是空的」。** 模型抄一句
 *     學生的話貼在通用評語前面就通得過這一層。要看出那件事需要判斷
 *     語意，而這個檔案不做語意。
 * 三、**它擋不住「理由與分數矛盾」。** 「幾乎沒有回應題目」配 15 分
 *     會通過。做得到的機械版本（否定詞很多卻給高分）誤擋率高到不能用。
 * 四、**它不能保證重新生成之後就變好。** 所以重試有上限，用完就把這一筆
 *     記成 `BLOCKED` 並附理由——那一題退回純人工閱卷，也就是這個功能
 *     存在之前的樣子。
 *
 * # 為什麼是 .mjs
 *
 * 與 `lib/grading.mjs`、`lib/tutorGuard.mjs` 同一個理由：**會算錯的東西
 * 要能在沒有資料庫的情況下驗。** 這個檔案裡每一支都是純函式，
 * `tests/gradingProposal.test.mjs` 餵它三十幾種壞掉的評分輸出與一整組
 * 必須通過的正常輸出。
 *
 * 唯一的 import 是同樣純函式的 `questionEdit.mjs`，而且只借一支
 * `readAward`——與 `lib/grading.mjs` 借它的理由完全相同：「這一題有沒有
 * 被送分」的判定必須只有一份。
 */
import { readAward } from './questionEdit.mjs';

// ─────────────────────────────────────────────────────────────────
// 正規化
//
// 兩支，用途不同，而且**不可以合併**：
//
//   normalizeForGrading  給規則比對用（套語、對學生本人的評價）。
//                        只折全形、收斂空白。看得到標點。
//   condense             給子字串比對用（引用了學生的哪一句、有沒有
//                        照抄規準）。**連標點與空白一起拿掉**，因為
//                        模型引用學生的句子時會重新標點——「他寫『魚
//                        市場的清晨』」與學生原文「魚市場的清晨，」
//                        在字元上不同，在意義上是同一句。
// ─────────────────────────────────────────────────────────────────

/** 全形 ASCII 與全形空白折成半形。兩支正規化共用的第一步。 */
function toHalfWidth(s) {
  return String(s)
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

/**
 * 規則比對用的形式。**匯出是給測試用的**——折錯了的症狀是某一類
 * 壞掉的評語永遠擋不到，而那在整合層完全看不出來。
 */
export function normalizeForGrading(text) {
  if (!text) return '';
  return toHalfWidth(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * 子字串比對用的形式：只留下文字與數字，標點、空白、換行全部拿掉。
 *
 * 保留英文字母與數字（英文作文與數學的非選題要靠它們比對），
 * 英文一律折成小寫——模型引用學生的句子時很常改掉首字母大小寫。
 */
export function condense(text) {
  if (!text) return '';
  return toHalfWidth(text)
    .toLowerCase()
    .replace(/[^0-9a-z㐀-䶿一-鿿豈-﫿]/g, '');
}

// ─────────────────────────────────────────────────────────────────
// 常數
//
// 每一個都要說得出為什麼是這個數，否則下一個人會為了讓某一筆過而
// 把它調鬆——而調鬆這幾個數字沒有任何症狀。
// ─────────────────────────────────────────────────────────────────

/**
 * 「有引用到學生答案」的最短長度（折疊後的字元數）。
 *
 * 6 個中文字是一個站得住的詞組。設 4 的話，「我認為這」這種在任何
 * 一篇作文與任何一段通用評語裡都會出現的組合就會被當成引用，於是
 * 整條規則放行一半的通用評語；設 8 的話，模型正確地引用一個短詞組
 * （「魚市場」加標點）會被判成沒有引用。
 */
export const QUOTE_MIN = 6;

/** 滿分與零分要求更明確的引用。理由見 `EXTREME_NO_REASON`。 */
export const QUOTE_MIN_EXTREME = 8;

/**
 * 英文答案的門檻。
 *
 * **六個中文字與六個英文字母不是同一件事。** 六個中文字是一個詞組，
 * 六個字母是一個半的單字——而 `therefore`、`important`、`education`
 * 這種字在任何一篇英文作文與任何一段通用評語裡都會出現。用同一個
 * 門檻的話，英文作文那一側的「有沒有引用」等於沒有在檢查。
 *
 * 16 個字元大約是三個單字，那是一個引用得出來的片語。
 */
export const QUOTE_MIN_LATIN = 16;
export const QUOTE_MIN_LATIN_EXTREME = 24;

/**
 * 引號裡的字串要幾個字才拿來驗「是不是編出來的」。
 *
 * **這裡與 `QUOTE_MIN` 的門檻刻意不對稱，而那個不對稱是有方向的：**
 * 引號裡的東西**真的在答案裡**時，3 個字就足以當成「他讀過」的證據；
 * 引號裡的東西**查不到**時，要 5 個字才判定是編出來的——因為中文的
 * 引號有一半的用途是強調而不是引用（「這一段的『論點』其實是重述題目」）。
 * 兩邊都往「不要冤枉模型、但也不要放過空話」的方向倒。
 */
export const QUOTE_SPAN_MIN = 5;

/** 被當成證據的引號跨距下限。 */
export const QUOTE_EVIDENCE_MIN = 3;

/**
 * 照抄規準原文的判定長度。
 *
 * 規準的 descriptor 通常 30 至 80 字，而模型**本來就該依規準評分**，
 * 所以改寫、摘要、引用關鍵詞都是正常的。18 個連續字元一模一樣不是
 * 引用，是轉貼——而 `Rubric.internalOnly` 的授權範圍是內部閱卷，
 * 不含散布。
 *
 * 英文的規準用 `LEAK_SPAN_LATIN`，理由與 `QUOTE_MIN_LATIN` 相同：
 * 18 個字母是三個單字，而「the content is clear」這種組合會在任何
 * 一段英文評語裡出現。
 */
export const LEAK_SPAN = 18;
export const LEAK_SPAN_LATIN = 40;

/** 理由的長度上下限。上限擋失控，下限擋「尚可」這種等於沒寫的東西。 */
export const MIN_RATIONALE_CHARS = 12;
export const MAX_RATIONALE_CHARS = 600;

/** 加總比對的容差。浮點數的 0.1+0.2 不該變成一次違規。 */
export const SUM_TOLERANCE = 0.01;

/** 幾句套語就算「通篇套語」。理由見 `CLICHES`。 */
export const CLICHE_LIMIT = 3;

/**
 * 離散度超過配分的多少比例就標成「AI 判斷不穩」。
 *
 * 0.15：18 分的國寫題，三次評分差到 2.7 分以上就不該讓老師直接採用。
 * 這個值是刻意偏嚴的——標錯的代價是老師多看一份（他本來就要看），
 * 漏標的代價是他採用了一個擲骰子擲出來的分數。
 */
export const UNSTABLE_RATIO = 0.15;

/** 採用率要幾筆才說得出話。少於這個數只能說「還看不出來」。 */
export const MIN_ACCURACY_SAMPLE = 20;

// ─────────────────────────────────────────────────────────────────
// 詞表
// ─────────────────────────────────────────────────────────────────

/**
 * 套語。**可以套用到任何一份答案上的評語。**
 *
 * 這一串本身不構成違規——一段有具體引用的好評語裡出現一句「結構完整」
 * 是正常的。要**三句以上**（`CLICHE_LIMIT`）才算，因為三句套語加起來
 * 就是一整段沒有內容的評語，而它讀起來最像一份認真的閱卷。
 *
 * 每一項都經得起這個問題：把它貼到另一位學生的答案上，還通嗎？
 */
export const CLICHES = [
  '文句通順', '文筆流暢', '行文流暢', '語句通順', '結構完整', '結構嚴謹',
  '論述清楚', '論述完整', '說明清楚', '層次分明', '條理分明', '段落分明',
  '言之有物', '內容充實', '立意甚佳', '用詞精準', '用字精準', '情感真摯',
  '情意真摯', '首尾呼應', '切合題旨', '扣合題旨', '舉例恰當', '見解獨到',
  '字跡工整', '語意連貫', '表達清晰', '邏輯清晰', '觀點明確', '大致完整',
  '整體良好', '整體不錯', '表現良好', '表現不錯', '尚可', '中規中矩',
  '符合要求', '有待加強',
];

/**
 * 文采詞。**單獨出現不算違規**——評國寫本來就要談文字。
 *
 * 它參與的是 `STYLE_OVER_RUBRIC`：規準有面向、而整段理由只談文采、
 * 一個面向的名字都沒提到——那就是在評文采而不是評給分要點，
 * 也就是這一層最主要要擋的那件事。
 */
export const STYLE_WORDS = [
  '文筆', '文采', '辭藻', '修辭', '優美', '華麗', '生動', '細膩', '感人',
  '詩意', '意境', '筆法', '行文', '用字遣詞', '文字功力', '美感',
];

/**
 * 對**學生本人**的評價。
 *
 * 這一條要與「對這份答案的評價」分得開，而分界不在有沒有提到「學生」
 * ——「學生沒有回答第二小題」是一句完全正確的閱卷理由。分界在**被
 * 評價的是誰**：這份答案，或這個人。
 *
 * 為什麼一定要擋：閱卷理由會被老師抄進 `scoreNote`，而 `scoreNote`
 * 學生看得到。一句「這位學生程度不錯」出現在成績單上，是補習班對
 * 一個未成年人的能力評斷，而它的依據是一篇作文。
 */
const PERSON_TRAITS =
  '程度|能力|資質|天分|天賦|悟性|素質|實力|水準|水平|基礎|底子|聰明|用心|認真|努力|懶|態度|個性|習慣|平時|一向|向來';

const JUDGES_PERSON = [
  // 「這位學生程度不錯」「該生的能力不足」「這孩子很用心」
  new RegExp(`(?:這位?|該|此)?(?:學生|考生|同學|孩子|小朋友)[^。！？\\n]{0,8}(?:${PERSON_TRAITS})`),
  // 「他的程度」「他一向不認真」——沒有提到「學生」，但主詞是人
  new RegExp(`(?:他|她|他們|這個人)(?:的)?[^。！？\\n]{0,4}(?:${PERSON_TRAITS})`),
  // 沒有主詞的斷語：「程度不錯」「基礎不好」「資質很好」
  new RegExp(`(?:${PERSON_TRAITS})[^。！？\\n]{0,4}(?:不錯|很好|不好|良好|不足|不佳|偏低|偏弱|不夠|很差|夠好|待加強)`),
  // 對未來的預測。這不是閱卷，這是算命。
  /(?:應該可以|大概可以|有機會|恐怕|勢必)[^。！？\n]{0,6}(?:考上|上榜|拿到|達到)[^。！？\n]{0,8}(?:級分|分數|學校|校系)/,
];

// ─────────────────────────────────────────────────────────────────
// 事實：這一次評分可以出現哪些字串、加起來要等於多少
// ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} RubricDimensionFact
 * @property {string} id
 * @property {string} name
 * @property {number} maxScore
 */

/**
 * @typedef {object} GradingFacts
 * @property {number} questionScore  這一題在這份卷子上的配分（快照）
 * @property {number|null} rubricTotal 規準的總分。沒有規準時是 null
 * @property {RubricDimensionFact[]} dimensions 沒有規準時是空陣列
 * @property {string[]} dimensionNames
 * @property {boolean} hasRubric
 * @property {boolean} blank 學生整題空白
 * @property {string} answer   折疊後的學生答案
 * @property {string} publicText 折疊後的題幹＋規準全文（引用時對得回的來源）
 * @property {string[]} leakSpans 規準 descriptor 的長跨距，照抄就是散布
 */

/**
 * 從題目、規準與學生的答案算出「這一次評分要對得起哪些事實」。
 *
 * 分成兩支（這裡算事實、`checkGradeProposal` 用事實判斷）與另外兩個
 * 閘門同一個結構，理由也一樣：前者要碰資料的形狀，後者只認得字串
 * 與數字。合成一支的話，閘門就得知道 Prisma 的模型長什麼樣子。
 *
 * @param {object} inp
 * @param {{stem?: string, score: number}} inp.question
 * @param {object|null} [inp.rubric] `lib/rubric.ts` 的 `RubricView`
 * @param {string|null} [inp.answer] 學生寫的（原文，不要先排版）
 * @returns {GradingFacts}
 */
export function gradingFacts(inp) {
  const question = inp?.question ?? {};
  const rubric = inp?.rubric ?? null;
  const dims = (rubric?.dimensions ?? []).map((d) => ({
    id: String(d.id ?? ''),
    name: String(d.name ?? ''),
    maxScore: Number(d.maxScore ?? 0),
  }));

  // 規準的全文。兩個用途：驗證引號裡的詞是不是編的（引用規準的術語
  // 是正常的），以及算出「照抄了哪一段」。
  const rubricText = [
    rubric?.name ?? '',
    ...dims.map((d) => d.name),
    ...(rubric?.dimensions ?? []).map((d) => d.descriptor ?? ''),
    ...(rubric?.bands ?? []).map((b) => `${b.grade ?? ''}${b.descriptor ?? ''}`),
  ].join('\n');

  const answer = condense(inp?.answer ?? '');
  const stem = condense(question.stem ?? '');
  const rubricCond = condense(rubricText);

  return {
    questionScore: Number(question.score ?? 0),
    rubricTotal: rubric ? Number(rubric.totalScore ?? 0) : null,
    dimensions: dims,
    dimensionNames: dims.map((d) => d.name).filter(Boolean),
    hasRubric: Boolean(rubric),
    blank: answer.length === 0,
    /** 這份答案是英文寫的嗎。決定引用與照抄的門檻要用哪一組。 */
    latin: isLatin(answer),
    answer,
    publicText: `${stem}\n${rubricCond}`,
    leakSpans: descriptorSpans(rubric),
  };
}

/**
 * 這段折疊後的文字主要是英文嗎。
 *
 * 門檻放在 0.6 而不是 0.5：中譯英的答案裡會夾中文的標號與註記，
 * 而它仍然是一份英文答案。
 */
function isLatin(cond) {
  if (!cond) return false;
  const latin = (cond.match(/[0-9a-z]/g) ?? []).length;
  return latin / cond.length > 0.6;
}

/**
 * 規準 descriptor 的每一個長跨距。
 *
 * 存成跨距而不是整段，是因為模型抄的往往是**中間那一句**。比對整段
 * 的話，抄了八成也對不上；比對跨距，抄了 18 個連續字元就對得上。
 *
 * 長度逐段決定（中文 18、英文 40），因為同一份規準的面向描述可能是
 * 中文而等第描述是英文（英文作文的規準常常這樣）。
 */
function descriptorSpans(rubric) {
  const out = new Set();
  const texts = [
    ...(rubric?.dimensions ?? []).map((d) => d.descriptor ?? ''),
    ...(rubric?.bands ?? []).map((b) => b.descriptor ?? ''),
  ];
  for (const raw of texts) {
    const t = condense(raw);
    const span = isLatin(t) ? LEAK_SPAN_LATIN : LEAK_SPAN;
    for (let i = 0; i + span <= t.length; i += 1) out.add(t.slice(i, i + span));
  }
  return [...out];
}

// ─────────────────────────────────────────────────────────────────
// 引用：這段理由到底有沒有讀過學生的答案
//
// 這是整個檔案最重要的一支。它回答的問題不是「這段評語寫得好不好」，
// 是「寫這段評語的東西有沒有看過那份答案」——而那件事是可以機械
// 判定的：**理由裡必須出現一段只有在那份答案裡才有的文字。**
// ─────────────────────────────────────────────────────────────────

/** 引號裡的每一段。中文的「」『』與英文的成對引號都算。 */
export function quotedSpans(text) {
  const out = [];
  const patterns = [/「([^」]{1,60})」/g, /『([^』]{1,60})』/g, /"([^"]{1,60})"/g, /“([^”]{1,60})”/g];
  for (const re of patterns) {
    for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m[1]);
  }
  return out;
}

/** 一段字串的所有固定長度片段。比對用 Set，見 `quoteMatch` 的說明。 */
function gramSet(s, len) {
  const out = new Set();
  for (let i = 0; i + len <= s.length; i += 1) out.add(s.slice(i, i + len));
  return out;
}

/**
 * 這段理由裡有沒有出現學生答案中一段**連續 `len` 個字**、而題幹與
 * 規準裡都沒有的文字。有就回那一段，沒有就回空字串。
 *
 * # 為什麼要排除題幹與規準裡也有的文字
 *
 * 因為學生的作文一定會出現題目給的那幾個詞。不排除的話，一段把題目
 * 重述一次的通用評語就「引用到了答案」——而那正是這條規則要擋的東西。
 *
 * # 為什麼是固定長度而不是找最長的共同片段
 *
 * 兩個理由。一、**這樣它是 O(n)**：三十位學生每人評三次，一次要比
 * 幾百字對幾百字，找最長片段的寫法會讓批次閱卷頁載入變成好幾秒。
 * 二、規則說得清楚：「答案裡連續 6 個字出現在理由裡」是一句老師看得
 * 懂的話，「最長共同片段 7 個字」不是。
 */
export function quoteMatch(facts, text, len) {
  const need = Math.floor(len);
  const answer = facts.answer ?? '';
  if (need <= 0 || answer.length < need) return '';
  const hay = condense(text);
  if (hay.length < need) return '';

  const pub = gramSet(facts.publicText ?? '', need);
  const hays = gramSet(hay, need);
  for (let i = 0; i + need <= answer.length; i += 1) {
    const g = answer.slice(i, i + need);
    if (pub.has(g)) continue;
    if (hays.has(g)) return g;
  }
  return '';
}

/**
 * 引號裡真的是學生寫過的那幾段。
 *
 * 兩個用途，而它們是相反的方向：**驗到的**是「他讀過」的證據
 * （即使只有三個字），**驗不到而且夠長的**是編出來的引用。
 */
export function verifiedQuotes(facts, text) {
  return quotedSpans(text).filter((s) => {
    const c = condense(s);
    return c.length >= QUOTE_EVIDENCE_MIN && (facts.answer ?? '').includes(c);
  });
}

// ─────────────────────────────────────────────────────────────────
// 一份建議的形狀
// ─────────────────────────────────────────────────────────────────

/**
 * 把模型回來的一份評分折成固定形狀，順手把分數收成兩位小數。
 *
 * 收小數是為了讓加總檢查驗的是真的算錯，而不是 6.6666666 這種
 * 表現方式——而 `checkManualScore`（`lib/examOps.mjs`）本來就只收
 * 兩位小數，這裡不先收的話，一筆通過閘門的建議會在老師採用時被拒。
 */
export function readSample(raw) {
  const dims = Array.isArray(raw?.dimensions) ? raw.dimensions : [];
  return {
    suggestedScore: round2(raw?.suggestedScore ?? raw?.score),
    dimensions: dims.map((d) => ({
      dimensionId: String(d?.dimensionId ?? d?.dimension_id ?? ''),
      name: String(d?.name ?? ''),
      score: round2(d?.score),
      max: round2(d?.max ?? d?.maxScore ?? d?.max_score),
      reason: String(d?.reason ?? '').trim(),
    })),
    rationale: String(raw?.rationale ?? '').trim(),
    confidence: clampConfidence(raw?.confidence),
  };
}

/** 兩位小數。非數字回 NaN，讓檢查那一層報出來而不是靜靜變成 0。 */
function round2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return Number.NaN;
  return Math.round(n * 100) / 100;
}

function clampConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // 上限 0.95：模型自陳 1.0 的意思是「保證」，而這一層沒有任何東西
  // 保證得了一篇作文的分數。下限 0.02 是為了不讓 0 在後面的乘法裡
  // 把整個排序壓平。
  return Math.min(0.95, Math.max(0.02, n));
}

// ─────────────────────────────────────────────────────────────────
// 閘門
// ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} GradeViolation
 * @property {string} code
 * @property {'INVALID'|'STYLE'} severity INVALID 一定重來；STYLE 收下但標記
 * @property {string} detail 給老師看的一句話。會寫進 `blockedReason`。
 */

/**
 * 這一份評分建議可以拿給老師看嗎。
 *
 * @param {ReturnType<typeof readSample>} sample
 * @param {GradingFacts} facts
 * @param {{maxChars?: number}} [opts]
 * @returns {{ok: boolean, violations: GradeViolation[], unusable: boolean}}
 *
 * **逐面向的理由與整段理由合起來看。** 分開看的話，「整段理由是套語、
 * 具體內容全在逐面向裡」會被判違規，而那是一份好的閱卷；
 * 反過來「整段引用了一句話、三個面向的理由全是套語」會通過。
 */
export function checkGradeProposal(sample, facts, opts = {}) {
  /** @type {GradeViolation[]} */
  const v = [];
  const add = (code, severity, detail) => {
    if (!v.some((x) => x.code === code)) v.push({ code, severity, detail });
  };

  const dims = sample.dimensions ?? [];
  const total = sample.suggestedScore;
  const max = facts.rubricTotal ?? facts.questionScore;

  // ── 一、分數本身 ────────────────────────────────────────
  if (!Number.isFinite(total)) {
    add('BAD_SCORE', 'INVALID', '建議的分數不是一個數字。');
  } else {
    if (total < 0) add('NEGATIVE_TOTAL', 'INVALID', `建議了負分（${total}）。`);
    if (total > max + SUM_TOLERANCE) {
      add(
        'OVER_TOTAL',
        'INVALID',
        `建議 ${total} 分，超過這一題的配分 ${max} 分。` +
          '超過配分的建議連老師想採用都採用不了（人工給分會被擋）。',
      );
    }
  }

  // ── 二、逐面向 ──────────────────────────────────────────
  if (!facts.hasRubric && dims.length > 0) {
    // 沒有規準卻回了面向，等於自己發明了一套評分標準。老師看到面向
    // 會以為那是規準，而它不是——那是這一層最容易騙過人的一種輸出。
    add(
      'DIMS_WITHOUT_RUBRIC',
      'INVALID',
      `這一題沒有評分規準，但建議裡有 ${dims.length} 個面向。` +
        '那幾個面向是模型自己定的，不是老師定的標準。',
    );
  }

  if (facts.hasRubric) {
    const byId = new Map(facts.dimensions.map((d) => [d.id, d]));
    const byName = new Map(facts.dimensions.map((d) => [d.name, d]));
    const seen = new Set();

    for (const d of dims) {
      const ref = byId.get(d.dimensionId) ?? byName.get(d.name) ?? null;
      if (!ref) {
        add(
          'UNKNOWN_DIMENSION',
          'INVALID',
          `建議裡的面向「${d.name || d.dimensionId || '（沒有名字）'}」不在這一題的規準裡。`,
        );
        continue;
      }
      seen.add(ref.id);
      if (!Number.isFinite(d.score)) {
        add('BAD_SCORE', 'INVALID', `面向「${ref.name}」的分數不是一個數字。`);
        continue;
      }
      if (d.score < 0) {
        add('DIM_NEGATIVE', 'INVALID', `面向「${ref.name}」是負分（${d.score}）。`);
      }
      if (d.score > ref.maxScore + SUM_TOLERANCE) {
        add(
          'DIM_OVER_MAX',
          'INVALID',
          `面向「${ref.name}」給了 ${d.score} 分，超過它的上限 ${ref.maxScore} 分。`,
        );
      }
      // 面向上限報錯代表模型照著另一套配分在評。分數加起來可能剛好
      // 對得上總分，但每一個面向的比重都是錯的。
      if (Number.isFinite(d.max) && Math.abs(d.max - ref.maxScore) > SUM_TOLERANCE) {
        add(
          'DIM_MAX_MISMATCH',
          'INVALID',
          `面向「${ref.name}」的上限被寫成 ${d.max}，規準上是 ${ref.maxScore}。`,
        );
      }
      if (!d.reason) {
        add('NO_DIM_REASON', 'STYLE', `面向「${ref.name}」有分數但沒有寫理由。`);
      }
    }

    const missing = facts.dimensions.filter((d) => !seen.has(d.id));
    if (missing.length > 0) {
      // 少評一個面向，總分自然偏低，而畫面上完全看不出來——老師看到
      // 的是一個「有理由、有面向」的建議，只是少了一塊。
      add(
        'MISSING_DIMENSION',
        'INVALID',
        `規準有 ${facts.dimensions.length} 個面向，建議只評了 ${seen.size} 個，` +
          `少了：${missing.map((d) => d.name).join('、')}。`,
      );
    }

    if (dims.length > 0 && Number.isFinite(total)) {
      const sum = dims.reduce((n, d) => n + (Number.isFinite(d.score) ? d.score : 0), 0);
      if (Math.abs(round2(sum) - total) > SUM_TOLERANCE) {
        add(
          'SUM_MISMATCH',
          'INVALID',
          `逐面向加起來是 ${round2(sum)} 分，總分卻寫 ${total} 分。` +
            '兩個數字對不起來時，沒有人知道該相信哪一個。',
        );
      }
    }
  }

  // ── 三、理由 ────────────────────────────────────────────
  const rationale = normalizeForGrading(sample.rationale);
  const dimReasons = dims.map((d) => normalizeForGrading(d.reason)).join('\n');
  const whole = `${rationale}\n${dimReasons}`;
  const wholeCond = condense(whole);

  if (wholeCond.length < MIN_RATIONALE_CHARS) {
    add(
      'EMPTY_RATIONALE',
      'INVALID',
      `理由只有 ${wholeCond.length} 個字。老師要拿它跟家長解釋這個分數。`,
    );
  }
  if (wholeCond.length > (opts.maxChars ?? MAX_RATIONALE_CHARS)) {
    add(
      'TOO_LONG',
      'STYLE',
      `理由有 ${wholeCond.length} 字，超過 ${opts.maxChars ?? MAX_RATIONALE_CHARS} 字。` +
        '一份要看三十遍的東西寫這麼長，老師不會讀。',
    );
  }

  const verified = verifiedQuotes(facts, whole);

  // 空白卷是唯一「引用不到任何東西」而合理的情況，所以它自己一條規則，
  // 而且要求分數是 0——一份空白卷拿到分數是這一層最嚴重的失效。
  if (facts.blank) {
    if (Number.isFinite(total) && total > 0) {
      add(
        'BLANK_BUT_SCORED',
        'INVALID',
        `學生這一題整題空白，但建議給 ${total} 分。`,
      );
    }
  } else {
    // 折疊後比門檻還短的答案（一句翻譯、一個名詞），要求引用六個字是
    // 不可能的——那時整份答案就是那六個字以內的東西。
    const base = facts.latin ? QUOTE_MIN_LATIN : QUOTE_MIN;
    const need = Math.min(base, facts.answer.length);
    if (quoteMatch(facts, whole, need) === '' && verified.length === 0) {
      add(
        'GENERIC_RATIONALE',
        'INVALID',
        '整段理由沒有引用學生答案裡的任何一句具體內容。' +
          '一段可以套用到任何一份答案上的評語，會讓老師以為 AI 真的讀過這一份。',
      );
    }

    // 編出來的引用。**這一條是「假裝讀過」的鐵證**，比通用評語嚴重
    // 得多：通用評語只是沒有內容，編出來的引用是把不存在的句子寫成
    // 學生寫過的，而老師會照著它扣分。
    for (const s of quotedSpans(whole)) {
      const c = condense(s);
      if (c.length < QUOTE_SPAN_MIN) continue;
      if (facts.answer.includes(c) || facts.publicText.includes(c)) continue;
      add(
        'FABRICATED_QUOTE',
        'INVALID',
        `理由裡用引號寫了「${s}」，但學生的答案、題幹與規準裡都沒有這一段。`,
      );
      break;
    }

    // 滿分與零分。這兩個分數最容易被質疑，也最需要說得出具體理由——
    // 而「引用得更長」是唯一機械驗得出來的「更具體」。
    if (Number.isFinite(total) && (total <= 0 || total >= max - SUM_TOLERANCE)) {
      const extreme = facts.latin ? QUOTE_MIN_LATIN_EXTREME : QUOTE_MIN_EXTREME;
      const needExtreme = Math.min(extreme, facts.answer.length);
      if (quoteMatch(facts, whole, needExtreme) === '' && verified.length === 0) {
        add(
          'EXTREME_NO_REASON',
          'INVALID',
          `給了${total <= 0 ? '零分' : '滿分'}（${total}／${max}）卻沒有指出答案裡的具體內容。` +
            '這兩個分數是最會被家長問的，而問起來時只剩這一段理由。',
        );
      }
    }
  }

  // ── 四、這段理由是誰寫的字 ──────────────────────────────
  //
  // 下面三條（套語、評價學生本人、評文采）比對的是**模型寫的字**，
  // 所以先把「引號裡確認是學生寫的」那幾段換掉。少了這一步，一篇
  // 剛好在談「能力」的作文，任何一段正確引用它的理由都會被判成
  // 「在評價學生本人」——而那一題從此永遠評不出建議。
  const authored = maskVerified(whole, verified);

  // 套語。三句以上就是一整段沒有內容的評語，即使裡面剛好夾了一句引用。
  const clicheHits = CLICHES.filter((c) => authored.includes(c));
  if (clicheHits.length >= CLICHE_LIMIT) {
    add(
      'CLICHE_HEAVY',
      'INVALID',
      `理由裡有 ${clicheHits.length} 句套語（${clicheHits.slice(0, 3).join('、')}…）。` +
        '這幾句貼到任何一份答案上都通，所以它們沒有告訴老師任何事。',
    );
  }

  // 對學生本人的評價。
  for (const re of JUDGES_PERSON) {
    const m = re.exec(authored);
    if (m) {
      add(
        'JUDGES_STUDENT',
        'INVALID',
        `理由在評價學生本人而不是這份答案（「${m[0].slice(0, 20)}」）。` +
          '閱卷理由會被抄進評語，而評語學生看得到。',
      );
      break;
    }
  }

  // 照抄規準原文。
  for (const span of facts.leakSpans) {
    if (wholeCond.includes(span)) {
      add(
        'RUBRIC_LEAK',
        'INVALID',
        `理由裡有 ${LEAK_SPAN} 個字以上與規準的描述文字一字不差。` +
          '規準的描述受著作權保護（internalOnly），授權範圍是內部閱卷而不是轉貼。',
      );
      break;
    }
  }

  // 評文采而不是評給分要點。
  if (facts.dimensionNames.length > 0) {
    const styleHits = STYLE_WORDS.filter((w) => authored.includes(w));
    const namedDimension = facts.dimensionNames.some((n) => n && authored.includes(n));
    if (styleHits.length >= 2 && !namedDimension) {
      add(
        'STYLE_OVER_RUBRIC',
        'INVALID',
        `理由談了文采（${styleHits.slice(0, 3).join('、')}）但沒有提到規準的任何一個面向` +
          `（${facts.dimensionNames.join('、')}）。這是在評文章好不好，不是在評給分要點。`,
      );
    }
  }

  return {
    ok: v.length === 0,
    violations: v,
    /** 有 INVALID 就不可以拿給老師當建議看。 */
    unusable: v.some((x) => x.severity === 'INVALID'),
  };
}

/**
 * 把確認是學生寫的那幾段引號內容換成佔位符。
 *
 * 換成「＿」而不是刪掉，是為了不讓相鄰的字黏在一起產生新的詞——
 * 與 `adviceGuard` 把假否定詞折成「約」是同一個考量。
 */
function maskVerified(text, verified) {
  let out = text;
  for (const s of verified) {
    if (!s) continue;
    out = out.split(s).join('＿');
  }
  return out;
}

/** 把違規清單折成一行寫進 `AnswerGradeProposal.blockedReason`。 */
export function describeGradeViolations(violations) {
  if (!violations || violations.length === 0) return '';
  return violations.map((x) => `${x.code}：${x.detail}`).join('；');
}

// ─────────────────────────────────────────────────────────────────
// 穩定性
//
// # 為什麼要評 N 次
//
// 因為單次評分的分數看不出它有多不確定。同一篇作文評三次拿到
// 12、12、13 與拿到 9、12、15 是兩件完全不同的事，而只評一次的話，
// 兩者在畫面上都是「建議 12 分」。第二種的老師應該自己重看一遍，
// 第一種可以直接採用——而系統有義務告訴他是哪一種。
//
// # 為什麼三次都用同一個溫度
//
// 因為要量的是**模型對這一份答案的判斷有多穩**，不是溫度有多高。
// 刻意調高溫度再說「離散度很大」，量到的是自己調的那個參數。
// 所以 N 次用正式參數各跑一次（見 apps/ai/routes_grading.py）。
//
// # 為什麼取「離中位數最近的那一份」而不是逐面向取中位數
//
// 逐面向取中位數再加起來，會產生一份**沒有任何一次評分真的長成那樣**
// 的結果：面向分數來自不同次，加起來不等於任何一次的總分，而每個面向
// 的理由對應的是別的分數。老師看到的會是一份自我矛盾的建議，而它甚至
// 過不了上面的加總檢查。
//
// 所以取一份完整的：總分最接近中位數的那一次。它內部一致，
// 而離散程度另外回報。
// ─────────────────────────────────────────────────────────────────

/**
 * @param {ReturnType<typeof readSample>[]} samples
 * @param {{maxScore: number, unstableRatio?: number}} opts
 * @returns {{
 *   pick: ReturnType<typeof readSample>,
 *   samples: number, median: number, spread: number, spreadRatio: number,
 *   unstable: boolean, confidence: number, scores: number[], note: string,
 * }|null}
 */
export function aggregateSamples(samples, opts = {}) {
  const usable = (samples ?? []).filter((s) => s && Number.isFinite(s.suggestedScore));
  if (usable.length === 0) return null;

  const scores = usable.map((s) => s.suggestedScore).sort((a, b) => a - b);
  const mid = Math.floor(scores.length / 2);
  const median =
    scores.length % 2 === 1 ? scores[mid] : round2((scores[mid - 1] + scores[mid]) / 2);

  // 最接近中位數的那一份。同樣接近時取分數低的那一份——**不是因為
  // 對學生比較嚴，是因為要有一個確定的規則**。不定規則的話，同一組
  // 輸入在不同次執行會挑到不同的建議，而那時「AI 不穩」與「這支函式
  // 不穩」分不開。
  let pick = usable[0];
  let best = Infinity;
  for (const s of usable) {
    const d = Math.abs(s.suggestedScore - median);
    if (d < best - 1e-9 || (Math.abs(d - best) <= 1e-9 && s.suggestedScore < pick.suggestedScore)) {
      best = Math.min(best, d);
      pick = s;
    }
  }

  const spread = round2(scores[scores.length - 1] - scores[0]);
  const maxScore = Number(opts.maxScore) || 0;
  const spreadRatio = maxScore > 0 ? spread / maxScore : spread > 0 ? 1 : 0;
  const unstable = spreadRatio > (opts.unstableRatio ?? UNSTABLE_RATIO);

  // 模型自陳的信心要被離散度懲罰。**這兩件事不一樣**：自陳信心是它
  // 覺得自己多有把握，離散度是它實際上有多不一致，而後者是可觀測的。
  // 只呈現前者的話，一份三次差五分的評分會標著「信心 0.8」。
  const declared = usable
    .map((s) => s.confidence)
    .filter((c) => typeof c === 'number' && Number.isFinite(c));
  const base = declared.length > 0 ? declared.reduce((a, b) => a + b, 0) / declared.length : 0.5;
  // 只評一次時信心一律打折：那時候離散度是未知，而未知不等於零。
  const single = usable.length < 2 ? 0.7 : 1;
  let confidence = base * (1 - Math.min(1, spreadRatio)) * single;
  if (unstable) confidence = Math.min(confidence, 0.4);
  confidence = Math.min(0.95, Math.max(0.02, round2(confidence)));

  return {
    pick,
    samples: usable.length,
    median,
    spread,
    spreadRatio: round2(spreadRatio),
    unstable,
    confidence,
    scores,
    note: unstable
      ? `同一份答案評了 ${usable.length} 次，分數落在 ${scores[0]} 至 ${scores[scores.length - 1]} 分` +
        `（差 ${spread} 分）。AI 判斷不穩，請人工細看。`
      : usable.length < 2
        ? '只評了一次，看不出這個分數有多穩。'
        : `評了 ${usable.length} 次，分數差 ${spread} 分。`,
  };
}

/**
 * 「這一份 AI 判斷不穩」記在理由的第一行。
 *
 * # 為什麼記在文字裡而不是加一個欄位
 *
 * 因為不加遷移（這一批的前提），而這件事本來就有先例：`lib/examOps.mjs`
 * 把「這個分數是人給的」記在 `scoreNote` 的開頭，理由一樣。
 *
 * 而它有一個附帶的好處：**離散度的警告會跟著理由一起走到任何看得到
 * 理由的地方**，包含資料庫的原始傾印與稽核。存在另一個欄位裡的話，
 * 畫面上少畫一次就不見了。
 */
export const STABILITY_MARK = '【AI 判斷不穩】';

/** 把離散度的警告接到理由前面。穩定的就原樣回去。 */
export function composeRationale(inp) {
  const body = String(inp?.rationale ?? '').trim();
  if (!inp?.unstable) return body;
  const note = String(inp?.note ?? '同一份答案評了幾次，分數差距偏大。').trim();
  return `${STABILITY_MARK}${note}\n${body}`;
}

/** 讀回來：`{ unstable, note, rationale }`。 */
export function parseRationale(text) {
  const raw = String(text ?? '');
  if (!raw.startsWith(STABILITY_MARK)) return { unstable: false, note: '', rationale: raw.trim() };
  const rest = raw.slice(STABILITY_MARK.length);
  const nl = rest.indexOf('\n');
  return {
    unstable: true,
    note: (nl < 0 ? rest : rest.slice(0, nl)).trim(),
    rationale: (nl < 0 ? '' : rest.slice(nl + 1)).trim(),
  };
}

// ─────────────────────────────────────────────────────────────────
// 哪些題目 AI 評得了
// ─────────────────────────────────────────────────────────────────

/**
 * 這一題會落到「等人工或 AI 評分」嗎。
 *
 * **這一支必須與 `lib/grading.mjs` 的 `MANUAL_TYPES` 加上
 * `gradeShortAnswerByRule` 的結果一致**，而那個一致性是測出來的
 * （`tests/gradingProposal.test.mjs` 直接拿 `gradeAttempt` 跑一遍，
 * 比對哪幾種題型真的回 `earnedScore: null`）。
 *
 * 不直接 import 那個常數是因為它在 grading.mjs 裡是私有的，而
 * grading.mjs 不在這一批可以動的範圍內。用測試綁住比開放一個內部
 * 常數安全：常數被匯出之後，下一個人會在別的地方也用它，然後兩邊
 * 的語意慢慢分岔。
 *
 * @param {string} type
 * @param {object|null} [scoringRule] `Question.scoringRule`
 */
export function isAiGradable(type, scoringRule) {
  if (!MANUAL_TYPES.has(String(type))) return false;
  const rule = scoringRule && typeof scoringRule === 'object' && !Array.isArray(scoringRule)
    ? scoringRule
    : null;
  // 設了比對規則的簡答題由 grading.mjs 自動計分，不必也不該讓 AI 再評
  // 一次——兩個分數不一樣的時候，老師沒有辦法判斷該相信哪一個。
  // 這兩個字串要與 `gradeShortAnswerByRule` 認得的模式完全一致。
  if (rule && (rule.mode === 'EXACT' || rule.mode === 'CONTAINS')) return false;
  // 送分的題目沒有什麼要評的（`gradeItem` 會直接給滿分）。
  //
  // **判定借 `readAward` 而不是自己看 `awardAll`。** 與 `lib/grading.mjs`
  // 借同一支是同一個理由（見那個檔案的檔頭）：`awardAll: false`、
  // `awardAll: 0` 這種殘留值不算送分，而自己判的那一份遲早會把它們
  // 當成送分——症狀是那一題從閱卷清單上消失，而分數還是 null。
  if (readAward(scoringRule)) return false;
  return true;
}

const MANUAL_TYPES = new Set(['ESSAY', 'TRANSLATION', 'SHORT_ANSWER']);

// ─────────────────────────────────────────────────────────────────
// 待閱順序
// ─────────────────────────────────────────────────────────────────

/**
 * 這一筆多需要人看。**數字越小越前面。**
 *
 * 順序是：安全規則擋下的（完全沒有建議，一定要人給分）→ 判斷不穩的
 * → 信心低的 → 信心高的。已經決定過的沉到最後。
 *
 * 為什麼被擋下的排最前面：老師如果照著清單從上往下改，那幾筆是唯一
 * 「不改就不會有分數」的。排在後面的話，一份卷子看起來改完了，
 * 而剩下那三筆停在待評分。
 */
export function reviewPriority(row) {
  if (row?.state && row.state !== 'PENDING' && row.state !== 'BLOCKED') return 10;
  if (row?.state === 'BLOCKED' || !row?.proposal) return -2;
  if (row.proposal.unstable) return -1;
  const c = row.proposal.confidence;
  return typeof c === 'number' && Number.isFinite(c) ? c : 0.5;
}

/**
 * 待閱清單的順序。**不改動輸入的陣列。**
 *
 * 同優先度時用 `sortKey`（學號）決定，讓同一份清單每次打開都一樣——
 * 順序會跳的清單，老師改到一半重新載入就找不到自己剛剛看到哪裡。
 */
export function sortForReview(rows) {
  return [...(rows ?? [])].sort((a, b) => {
    const d = reviewPriority(a) - reviewPriority(b);
    if (Math.abs(d) > 1e-9) return d;
    return String(a?.sortKey ?? '').localeCompare(String(b?.sortKey ?? ''), 'zh-Hant');
  });
}

// ─────────────────────────────────────────────────────────────────
// 老師的決定
// ─────────────────────────────────────────────────────────────────

/** 老師動了什麼。與 `ProposalState` 的四個已決定狀態一對一。 */
export const PROPOSAL_STATES = ['PENDING', 'ACCEPTED', 'ADJUSTED', 'REJECTED', 'BLOCKED'];

export const STATE_LABELS = {
  PENDING: '還沒有人看',
  ACCEPTED: '照建議給分',
  ADJUSTED: '改了分數',
  REJECTED: '不採用',
  BLOCKED: '安全規則擋下',
};

/**
 * 老師這一次的動作要記成哪一種狀態。
 *
 * @param {object} inp
 * @param {number|null} inp.suggested AI 建議的分數。BLOCKED 的建議是 null
 * @param {number} inp.final 老師實際給的
 * @param {boolean} [inp.dismissed] 老師按了「這個建議沒有參考價值」
 *
 * **打了與建議一樣的分數算 ACCEPTED，不算 ADJUSTED。** 那是同意，
 * 而同意不需要理由。分不清這一點的話，採用率會被「老師自己打了同一個
 * 數字」這件事壓低，然後這個功能會因為一個算錯的數字被關掉。
 */
export function decideState(inp) {
  if (inp?.dismissed) return 'REJECTED';
  const s = num(inp?.suggested);
  const f = num(inp?.final);
  // 被擋下的建議沒有分數可以比（`suggested` 是 null），老師給的分數
  // 一律算不採用——那一筆的意義正是「AI 沒有給出可用的建議」。
  if (!Number.isFinite(s) || !Number.isFinite(f)) return 'REJECTED';
  return Math.abs(s - f) <= SUM_TOLERANCE ? 'ACCEPTED' : 'ADJUSTED';
}

/**
 * 分數用的 Number()。
 *
 * **`Number(null)` 是 0，而 0 是一個合法的分數。** 直接用 Number 的話，
 * 「沒有填分數」與「給 0 分」在程式裡是同一件事——而它們在成績單上
 * 差很多，一個是待評分，一個是老師判定不給分。
 */
function num(v) {
  if (v === null || v === undefined || v === '') return Number.NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * 這個決定填得完整嗎。與資料庫的 CHECK 是同一條規則的兩種形狀。
 *
 * 為什麼要在程式裡也擋一次：CHECK 擋下來的錯誤訊息是
 * `violates check constraint "answer_grade_proposals_change_has_note"`，
 * 而老師看到的會是一句「存檔失敗」。他不會知道要填理由。
 */
export function checkDecision(inp) {
  const state = inp?.state;
  if (!PROPOSAL_STATES.includes(state)) {
    return { ok: false, error: `不認得的決定「${state}」` };
  }
  if (state === 'ADJUSTED' || state === 'REJECTED') {
    const note = composeDecisionNote(inp);
    if (note.trim() === '') {
      return {
        ok: false,
        error:
          state === 'ADJUSTED'
            ? '改了 AI 的分數要寫一句為什麼。那是改進提示詞的唯一素材，也是判斷這個功能該不該繼續用的依據。'
            : '不採用要寫一句為什麼。沒有理由的不採用，事後看不出是 AI 評錯了還是這一題本來就不適合。',
      };
    }
  }
  if (state === 'ACCEPTED' || state === 'ADJUSTED' || state === 'REJECTED') {
    if (!Number.isFinite(num(inp?.finalScore))) {
      return { ok: false, error: '要填一個分數。' };
    }
  }
  return { ok: true, error: '' };
}

/**
 * 老師標「哪一個面向評得不準」的記法。
 *
 * # 為什麼記在 decisionNote 的開頭而不是加一個欄位
 *
 * 因為不加遷移（這一批的前提），而這件事本來就有先例：
 * `lib/examOps.mjs` 的 `isManualScore` 把「這個分數是人給的」記在
 * `scoreNote` 的開頭，理由一樣——沒有欄位可以記，而讀寫兩邊只要是
 * 同一個字串就行。
 *
 * 而它非記不下來不可：**「被改最多的面向」是這個功能唯一可以據以
 * 改進的數字。** 只知道總分差了 2 分，改不了任何一句提示詞；知道
 * 十次裡有八次是「組織」被改，那一句提示詞就找得到。
 */
export const DIM_TAG_MARK = '評得不準的面向';

/** 面向名稱裡不可以出現的字（會把記法本身弄壞）。 */
const DIM_TAG_BAD = /[[\]：:／]/;

export function composeDecisionNote(inp) {
  const dims = (inp?.dimensions ?? [])
    .map((d) => String(d ?? '').trim())
    .filter((d) => d !== '' && !DIM_TAG_BAD.test(d));
  const note = String(inp?.note ?? '').trim();
  if (dims.length === 0) return note;
  return `[${DIM_TAG_MARK}：${dims.join('／')}] ${note}`.trim();
}

export function parseDecisionNote(text) {
  const raw = String(text ?? '');
  const re = new RegExp(`^\\[${DIM_TAG_MARK}：([^\\]]*)\\]\\s*`);
  const m = re.exec(raw);
  if (!m) return { dimensions: [], note: raw.trim() };
  return {
    dimensions: m[1]
      .split('／')
      .map((s) => s.trim())
      .filter(Boolean),
    note: raw.slice(m[0].length).trim(),
  };
}

// ─────────────────────────────────────────────────────────────────
// 這個功能到底準不準
//
// # 為什麼這一支存在
//
// 因為**老師採用率 90% 與 30% 是兩個完全不同的世界，而後者代表這個
// 功能該關掉**（`AnswerGradeProposal` 的表註解）。而那個數字只算得
// 出來一次：如果被否決的建議沒有留著。
//
// # 為什麼要三個數字而不是一個
//
// 採用率高不代表評得準——老師趕著改三十份時，一個看起來合理的分數
// 他會直接按。所以要配上**平均誤差**（他改的時候改了多少）與**被改
// 最多的面向**（改的是哪一塊）。三個一起看才分得出「AI 評得準」與
// 「老師懶得改」。
// ─────────────────────────────────────────────────────────────────

/**
 * @param {Array<{
 *   state: string, suggestedScore: number|null, finalScore: number|null,
 *   maxScore?: number|null, decisionNote?: string|null,
 * }>} rows 一批**已經決定過**與待決定的建議（這一支自己分開算）
 */
export function accuracyReport(rows) {
  const list = rows ?? [];
  const count = { PENDING: 0, ACCEPTED: 0, ADJUSTED: 0, REJECTED: 0, BLOCKED: 0 };
  for (const r of list) {
    if (count[r?.state] !== undefined) count[r.state] += 1;
  }

  const decided = list.filter(
    (r) => r?.state === 'ACCEPTED' || r?.state === 'ADJUSTED' || r?.state === 'REJECTED',
  );
  const changed = decided.filter((r) => r.state !== 'ACCEPTED');

  const errs = [];
  const rel = [];
  const signed = [];
  for (const r of decided) {
    const s = Number(r.suggestedScore);
    const f = Number(r.finalScore);
    if (!Number.isFinite(s) || !Number.isFinite(f)) continue;
    errs.push(Math.abs(f - s));
    signed.push(f - s);
    const m = Number(r.maxScore);
    if (Number.isFinite(m) && m > 0) rel.push(Math.abs(f - s) / m);
  }

  const mean = (xs) => (xs.length === 0 ? null : round2(xs.reduce((a, b) => a + b, 0) / xs.length));

  // 被改最多的面向。只有老師標了才算得出來，所以**沒標的筆數要一起
  // 回報**——不然「組織被改 3 次」看起來像全部只有三次，而其實是
  // 三十次裡只有三次有標。
  const dimCount = new Map();
  let untagged = 0;
  for (const r of changed) {
    const { dimensions } = parseDecisionNote(r.decisionNote);
    if (dimensions.length === 0) {
      untagged += 1;
      continue;
    }
    for (const d of dimensions) dimCount.set(d, (dimCount.get(d) ?? 0) + 1);
  }

  const adoptionRate = decided.length === 0 ? null : round2(count.ACCEPTED / decided.length);

  return {
    total: list.length,
    ...count,
    decided: decided.length,
    /** 照建議給分的比例。分母是「老師看過的」，不含還沒看與被擋下的。 */
    adoptionRate,
    /** 平均誤差（分）。含採用的那些（誤差 0），所以它是整體的平均。 */
    mae: mean(errs),
    /** 只看老師改過的那幾筆。這個數字才是「它錯的時候錯多少」。 */
    maeWhenChanged: mean(changed.map((r) => Math.abs(Number(r.finalScore) - Number(r.suggestedScore))).filter(Number.isFinite)),
    /** 平均誤差佔配分的比例。不同配分的題目要用它才比得起來。 */
    relativeError: mean(rel),
    /**
     * 有號誤差。**正數代表老師普遍給得比 AI 高**（AI 偏嚴），
     * 負數代表 AI 偏寬鬆。這一項比平均誤差好修：系統性偏一邊
     * 是提示詞改得動的，隨機誤差不是。
     */
    bias: mean(signed),
    worstDimensions: [...dimCount.entries()]
      .map(([name, n]) => ({ name, count: n }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant')),
    untaggedChanges: untagged,
    /** 樣本夠不夠。不夠時上面每一個數字都只是雜訊。 */
    enough: decided.length >= MIN_ACCURACY_SAMPLE,
    verdict: verdictOf(decided.length, adoptionRate),
  };
}

/**
 * 一句人話。**刻意不做成自動開關。**
 *
 * 採用率低到該關掉這個功能時，關掉的決定要有人做——一個自己把自己
 * 關掉的功能，下一次打開時沒有人知道當初為什麼關。
 */
function verdictOf(n, rate) {
  if (n < MIN_ACCURACY_SAMPLE) {
    return `只有 ${n} 筆決定，還看不出準不準（至少要 ${MIN_ACCURACY_SAMPLE} 筆）。`;
  }
  if (rate === null) return '算不出採用率。';
  if (rate >= 0.8) {
    return `採用率 ${Math.round(rate * 100)}%。看起來幫得上忙，但要一起看平均誤差——` +
      '趕著改三十份的時候，一個看起來合理的分數老師會直接按。';
  }
  if (rate >= 0.5) {
    return `採用率 ${Math.round(rate * 100)}%。一半以上要改，代表它現在只能當第一稿。` +
      '看「被改最多的面向」那一欄，那是提示詞唯一改得動的地方。';
  }
  return `採用率只有 ${Math.round(rate * 100)}%。老師改得比自己評還多，` +
    '這個功能現在是在增加工作而不是減少——建議關掉，或只留在有規準的題目上。';
}

// ─────────────────────────────────────────────────────────────────
// 規準本身的加總驗證與範本
//
// # 為什麼放在這個檔案
//
// 因為它與閘門驗的是**同一組加總**：各面向上限加起來等於總分、
// 等第的分數帶連續不重疊、最高等第的上限等於配分。兩邊各寫一份的
// 症狀是「建得起來的規準，評分時每一份都被判成加總不對」。
//
// 而且它必須是純函式：一個算錯的規準不會有錯誤訊息，它只是讓每一份
// 建議都差幾分。`apps/ai/pipeline/schemas.py` 的 `RubricOut` 在
// Python 端驗同一組不變量（匯入大考中心的評分原則時），這裡是老師
// 手建那一條路的同一道關卡。
// ─────────────────────────────────────────────────────────────────

/** 三種模式。與 `RubricOut.mode`（Python 端）一致。 */
export const RUBRIC_MODES = ['BAND', 'DIMENSION', 'DEDUCTION'];

export const MODE_LABELS = {
  BAND: '等第制（國寫：A+ 到 0 各對一個分數帶）',
  DIMENSION: '分面向（英文作文：內容、組織各有上限）',
  DEDUCTION: '扣分制（中譯英：每個錯誤扣固定分數）',
};

/**
 * 老師建的規準草稿合不合法。
 *
 * @param {object} draft
 * @returns {{ok: boolean, errors: string[]}}
 *
 * 回**全部**的錯誤而不是第一個：老師一次填十幾格，一次只講一個錯
 * 會讓他存十次。
 */
export function checkRubricDraft(draft) {
  const errors = [];
  const name = String(draft?.name ?? '').trim();
  const total = Number(draft?.totalScore);
  const mode = String(draft?.mode ?? 'BAND');
  const dims = Array.isArray(draft?.dimensions) ? draft.dimensions : [];
  const bands = Array.isArray(draft?.bands) ? draft.bands : [];

  if (name === '') errors.push('規準要有名稱（例如「115 國寫知性題評分原則」）。');
  if (!Number.isFinite(total) || total <= 0) errors.push('總分要填一個大於 0 的數字。');
  if (!RUBRIC_MODES.includes(mode)) errors.push(`不認得的模式「${mode}」。`);

  for (const [i, d] of dims.entries()) {
    if (String(d?.name ?? '').trim() === '') errors.push(`第 ${i + 1} 個面向沒有名稱。`);
    const m = Number(d?.maxScore);
    if (!Number.isFinite(m) || m <= 0) errors.push(`面向「${d?.name ?? i + 1}」的滿分要大於 0。`);
  }

  // 面向上限加起來要等於總分。差一分的規準，AI 的每一份建議都會在
  // 加總那一條被擋下來，而錯的是規準不是建議。
  if (dims.length > 0 && Number.isFinite(total)) {
    const sum = dims.reduce((n, d) => n + (Number(d?.maxScore) || 0), 0);
    if (Math.abs(round2(sum) - total) > SUM_TOLERANCE) {
      errors.push(`各面向的滿分加起來是 ${round2(sum)} 分，與總分 ${total} 分不符。`);
    }
  }
  if (mode === 'DIMENSION' && dims.length === 0) {
    errors.push('分面向模式至少要有一個面向。');
  }

  if (bands.length > 0) {
    for (const [i, b] of bands.entries()) {
      if (String(b?.grade ?? '').trim() === '') errors.push(`第 ${i + 1} 個等第沒有代號。`);
      if (String(b?.descriptor ?? '').trim() === '') {
        errors.push(`等第「${b?.grade ?? i + 1}」沒有描述。沒有描述的等第，AI 與老師都用不到。`);
      }
      const lo = Number(b?.scoreMin);
      const hi = Number(b?.scoreMax);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        errors.push(`等第「${b?.grade ?? i + 1}」的分數帶要填兩個數字。`);
      } else if (hi < lo) {
        errors.push(`等第「${b?.grade ?? i + 1}」的上限（${hi}）低於下限（${lo}）。`);
      } else if (Number.isFinite(total) && hi > total + SUM_TOLERANCE) {
        errors.push(`等第「${b?.grade ?? i + 1}」的上限 ${hi} 超過總分 ${total}。`);
      }
    }
    const sorted = [...bands]
      .filter((b) => Number.isFinite(Number(b?.scoreMin)) && Number.isFinite(Number(b?.scoreMax)))
      .sort((a, b) => Number(b.scoreMax) - Number(a.scoreMax));
    if (sorted.length > 0 && Number.isFinite(total)) {
      if (Math.abs(Number(sorted[0].scoreMax) - total) > SUM_TOLERANCE) {
        errors.push(
          `最高等第「${sorted[0].grade}」的上限是 ${sorted[0].scoreMax}，` +
            `與總分 ${total} 不符——那樣沒有人拿得到滿分。`,
        );
      }
      // 分數帶之間不可以重疊。重疊的話同一個分數落在兩個等第上，
      // 而 AI 與老師會各挑一個。
      for (let i = 0; i + 1 < sorted.length; i += 1) {
        if (Number(sorted[i].scoreMin) <= Number(sorted[i + 1].scoreMax) - SUM_TOLERANCE) {
          errors.push(
            `等第「${sorted[i].grade}」（${sorted[i].scoreMin} 起）與` +
              `「${sorted[i + 1].grade}」（到 ${sorted[i + 1].scoreMax}）的分數帶重疊。`,
          );
        }
      }
      if (Math.abs(Number(sorted[sorted.length - 1].scoreMin)) > SUM_TOLERANCE) {
        errors.push('最低的等第要從 0 分起算，否則空白卷落不到任何一個等第。');
      }
    }
  }
  if (mode === 'BAND' && bands.length === 0) {
    errors.push('等第制至少要有一個等第。');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 學測國文寫作的規準範本。
 *
 * # 為什麼描述文字是自己寫的
 *
 * **因為出版社與大考中心的評分原則描述受著作權保護**（文件 16 §3），
 * 而一份內建在系統裡、每個租戶都拿得到的範本，不管 `internalOnly`
 * 設成什麼都已經是散布。所以這幾段字是照公開的等第結構自己寫的
 * 白話說明——它的用途是讓老師不必從零建，然後**照他手上那一份改**。
 *
 * 結構本身（知性題／情意題、A+ 到 C- 六個等第、各 25 分）是公開的
 * 制度事實，不是著作。
 *
 * 範本一律標 `internalOnly: true`：老師改完之後裡面很可能就是他手上
 * 那一份的文字了，而系統沒有辦法知道他改了什麼。預設關著比較安全。
 */
export function rubricTemplates() {
  return [
    {
      key: 'GSAT_CHINESE_KNOWLEDGE',
      label: '學測國寫・知性題（25 分，A+ 到 0）',
      hint: '結構照公開的等第制。描述文字是系統自己寫的白話版，請照你手上那一份改。',
      draft: {
        name: '國寫知性題評分原則',
        totalScore: 25,
        mode: 'BAND',
        dimensions: [],
        bands: chineseBands([
          ['A+', 22, 25, '完全掌握題目要求的判斷與說明，論點清楚且有具體依據，材料用得準確，行文組織完整。'],
          ['A', 18, 21, '掌握題目要求，論點清楚，依據大致具體，組織完整但有少數鬆散處。'],
          ['B+', 14, 17, '回應了題目，論點看得出來但依據偏薄，材料的使用有部分不準確。'],
          ['B', 10, 13, '回應題目的一部分，論點與依據都不夠，段落之間的連結不清楚。'],
          ['C+', 6, 9, '只碰到題目的邊，多為重述題幹或個人感想，缺少判斷與說明。'],
          ['C', 1, 5, '幾乎沒有回應題目，或內容過短無法判斷。'],
          ['0', 0, 0, '空白、文不對題、或完全與題目無關。'],
        ]),
      },
    },
    {
      key: 'GSAT_CHINESE_EMOTION',
      label: '學測國寫・情意題（25 分，A+ 到 0）',
      hint: '情意題看的是經驗的具體與感受的真切，不是文采。描述文字同樣要照你手上那一份改。',
      draft: {
        name: '國寫情意題評分原則',
        totalScore: 25,
        mode: 'BAND',
        dimensions: [],
        bands: chineseBands([
          ['A+', 22, 25, '經驗寫得具體，感受與經驗對得起來，敘述有層次，讀得出是自己的事。'],
          ['A', 18, 21, '經驗具體，感受清楚，敘述完整但層次略平。'],
          ['B+', 14, 17, '有經驗也有感受，但兩者的連結偏弱，或經驗停在概括的層面。'],
          ['B', 10, 13, '經驗與感受都偏空泛，多為一般性的說法。'],
          ['C+', 6, 9, '幾乎沒有具體經驗，通篇為抽象的抒情或口號。'],
          ['C', 1, 5, '偏離題目所要求的經驗與感受，或內容過短無法判斷。'],
          ['0', 0, 0, '空白、文不對題、或完全與題目無關。'],
        ]),
      },
    },
    {
      key: 'GSAT_ENGLISH_ESSAY',
      label: '學測英文作文（20 分，分四個面向）',
      hint: '英文作文是分面向給分。四個面向各 5 分，加起來 20 分。',
      draft: {
        name: '英文作文評分面向',
        totalScore: 20,
        mode: 'DIMENSION',
        dimensions: [
          { name: '內容', nameEn: 'Content', maxScore: 5, descriptor: '是否切合題目要求、要點是否完整、有無具體的支持細節。', order: 0 },
          { name: '組織', nameEn: 'Organization', maxScore: 5, descriptor: '段落安排、主題句與支持句的關係、句與句之間的連接。', order: 1 },
          { name: '文法句構', nameEn: 'Grammar', maxScore: 5, descriptor: '時態、主動詞一致、句型的正確與變化。', order: 2 },
          { name: '字彙拼字', nameEn: 'Vocabulary', maxScore: 5, descriptor: '用字是否恰當、拼字正確、有無重複使用同一組簡單字彙。', order: 3 },
        ],
        bands: [],
      },
    },
  ];
}

function chineseBands(rows) {
  return rows.map(([grade, scoreMin, scoreMax, descriptor], i) => ({
    grade,
    scoreMin,
    scoreMax,
    descriptor,
    order: i,
  }));
}
