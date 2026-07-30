/**
 * 升學建議的確定性閘門。
 *
 * # 這裡的風險與智慧老師完全不同
 *
 * 智慧老師的閘門（`lib/tutorGuard.mjs`）擋的是**洩漏答案**。這一層擋的
 * 是另一件事：**製造假的精確度**。
 *
 * 兩者的失效方式不一樣。洩漏了答案，學生看完就知道答案，傷害立刻發生
 * 而且看得見。假的精確度不是這樣——「你通過的機率大約 68%」讀起來
 * 專業、令人安心、而且完全沒有症狀。學生會照著它決定要不要填那個志願，
 * 而那個數字建立在**每年只有一個極值資料點**的統計上（官方公布的只有
 * 各校系第一輪最後一名錄取者的在校百分比，而第一輪名額常常只有 1 至 3
 * 名）。用三年的極值算出來的 68%，它的誤差比它本身還大。
 *
 * 規格書 §7.2 明文禁止「有相當把握」這類措辭，§2.3 要求「不確定性必須
 * 被看見」「資料不足時要承認，不要補值」。這個檔案是那三句話的執行者。
 *
 * # 為什麼這一層是規則而不是提示詞
 *
 * 與智慧老師同一個理由，但更嚴重一點：學生問的是「我到底上不上得了」，
 * 而那個問題只有一種令人滿意的答案形狀——一個數字。模型想幫忙，
 * 所以它會給。提示詞寫「不要給機率」擋得住第一次，擋不住第三次；
 * 而且它擋不住換一種寫法——「大概七成」「十之八九」「應該沒問題」
 * 在字串上與 68% 完全不同，在學生眼裡完全一樣。
 *
 * **所以每一條邊界都往擋的方向倒。** 誤擋的代價是多花一次生成的錢；
 * 漏擋的代價是一位學生照著一個編出來的數字放掉一個他上得了的志願。
 *
 * # 這一層擋不住的三件事
 *
 * 一、**擋不住語氣上的暗示。** 「你這個百分比…嗯，我覺得可以試試看」
 *     沒有任何數字、沒有任何禁用詞。這一層擋的是可機械辨識的假精確度。
 * 二、**它不知道建議寫得好不好。** 它只驗證每一個數字對得回一筆
 *     `AdmissionReference`，不驗證那些數字被解讀得對不對。
 * 三、**它不能保證重新生成之後就變好。** 所以重試有上限，用完就退回
 *     `safeAdvice()`——一段只陳述事實的版本，由程式組出來，不經過模型。
 *
 * # 為什麼不共用 tutorGuard 的正規化
 *
 * 因為兩邊要折的東西不一樣，而共用會讓其中一邊悄悄變弱。tutorGuard 把
 * 中文數字折成阿拉伯數字（「答案是二十四」要擋），這裡**刻意不折**：
 * 「七成」折成「7成」之後就對不上任何一條規則，而「七成」正是這一層
 * 最該擋的一種寫法。共用一份正規化，遲早有人為了讓一邊過而改動它，
 * 另一邊就這樣安靜地破一個洞。
 */

// ─────────────────────────────────────────────────────────────────
// 正規化
//
// 只做三件事：全形折半形、全形百分號折成 %、空白收斂。
// **不折中文數字**，理由見檔頭。
// ─────────────────────────────────────────────────────────────────

/** 比對用的形式。匯出是給測試用的——折錯了的症狀是某一類永遠擋不到。 */
export function normalizeForAdvice(text) {
  if (!text) return '';
  return String(text)
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/％/g, '%')
    // LaTeX 的殘骸。建議裡不該有數學式，但模型會寫 $68\%$ 這種東西，
    // 而那躲得過每一條含 % 的規則。
    .replace(/\\%/g, '%')
    .replace(/\$+/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────
// 事實：這一次建議可以出現哪些數字
// ─────────────────────────────────────────────────────────────────

/**
 * 制度常數。**建議可以講這幾個數字而不必對回任何一筆參考資料**，
 * 因為它們是系統自己的說明文字裡本來就有的公開制度事實：
 *
 *   1 至 8   繁星學群的編號；第一輪「一校一名」的 1；名額常有 1 至 3 名；
 *            校內每個位置至多推薦 2 名；推薦序 2 至 6
 *   922      115 學年度繁星全國缺額（`lib/star.mjs` 的第二輪說明就寫了它）
 *
 * 這份白名單刻意小而且逐項說得出理由。放寬它等於放寬「每一個數字都
 * 必須有來源」那條規則，而那是這個檔案的主要價值。
 */
export const INSTITUTION_NUMBERS = ['1', '2', '3', '4', '5', '6', '7', '8', '922'];

/**
 * 把 `adviceBasis()` 的結果折成閘門要的事實。
 *
 * 分成兩支（`adviceBasis` 在 `admissionRef.mjs`、`adviceFacts` 在這裡）
 * 是因為它們的責任不同：前者回答「這位學生手上有什麼」，後者回答
 * 「哪些字串出現在輸出裡是可以的」。合成一支的話，閘門就得 import 整個
 * 參考資料模組，而它應該只認得字串與一組數字。
 *
 * @param {object} basis `adviceBasis()` 的輸出
 */
export function adviceFacts(basis = {}) {
  const numbers = new Set(INSTITUTION_NUMBERS.map((n) => String(Number(n))));
  for (const n of basis.numbers ?? []) {
    const v = Number(n);
    if (Number.isFinite(v)) numbers.add(String(v));
  }

  const years = new Set();
  for (const r of basis.references ?? []) {
    if (Number.isFinite(r?.year)) years.add(r.year);
  }

  return {
    /** 可以出現的數字（正規化成 `String(Number(x))`）。 */
    numbers: [...numbers],
    /** 有錄取標準資料的學年度數。「近三年」要靠它驗。 */
    yearCount: (basis.yearsWithThreshold ?? []).length,
    /** 門檻資料的筆數。沒有門檻就不該出現任何比較。 */
    thresholdCount: (basis.thresholds ?? []).length,
    /** 有沒有任何一筆是官方文件。沒有就不可以說「依官方公布」。 */
    hasOfficialDoc: basis.hasOfficialDoc === true,
    allYears: [...years],
  };
}

// ─────────────────────────────────────────────────────────────────
// 規則
// ─────────────────────────────────────────────────────────────────

/**
 * 機率詞。**本身不構成違規**——「本系統不估第二輪的機率」是一句必須
 * 說得出來的話。要旁邊同時出現一個數字或一個程度副詞才算。
 */
const ODDS_WORDS =
  /機率|機會|可能性|勝算|成功率|錄取率|通過率|上榜率|命中率|把握度|probability|chance|odds|likelihood/gi;

/**
 * 程度。與機率詞連在一起就是一個沒有根據的預測，即使沒有數字——
 * 「你的機會很大」與「你的機率是 68%」在學生眼裡是同一句話。
 */
const MAGNITUDE = /[高低大小]|不小|不高|很|蠻|挺|超|過半|一半|幾成|偏高|偏低|微乎其微|渺茫|不錯|樂觀/;

/** 否定與「做不到」。這兩種語境裡的機率詞是誠實的，不能擋。 */
const ODDS_EXEMPT_AFTER = /無法|不能|不做|不估|不算|沒有辦法|估不出|算不出/;

/**
 * 長得像否定但不是否定的詞。**這一行是必要的，不是潔癖。**
 *
 * 「差不多八成」裡的「不」不否定「八成」——它是「大約」的意思，而如果
 * 把它當成否定放過去，這句話就通過了閘門。而它正是模型被擋掉「68%」
 * 之後最容易改寫成的樣子。「不過」（然而）、「不但」、「不只」同理：
 * 它們都是連接詞，出現在斷語的前面而不是否定它。
 *
 * 折成「約」而不是刪掉，是為了不讓相鄰的字黏在一起產生新的詞。
 */
const FALSE_NEGATORS = /差不多|不過|不但|不僅|不只|不外乎|要不然|不然/g;

/**
 * 這個位置前面有否定嗎。
 *
 * 看八個字而不是一個字：「沒有把握」的 `有把握` 命中時，它前面第一個字
 * 是「有」而不是「沒」。只看一個字的實作會把最誠實的那一句話擋掉。
 */
function negatedBefore(text, index, back = 8) {
  const win = text.slice(Math.max(0, index - back), index).replace(FALSE_NEGATORS, '約');
  return /[不沒無非未別]|難以/.test(win);
}

/**
 * 中文的成數與俗語。**這一組是這個檔案存在的主要理由。**
 *
 * 模型被擋掉「68%」之後會改寫成「大概七成」，而那需要的不是更嚴厲的
 * 提示詞，是這一行正規表達式。排除的是 成功／成績／成本 這一類複合詞
 * ——少了那個 lookahead，一句提到「成功大學」的正常建議會被擋掉。
 */
const TENTHS =
  /[一二三四五六七八九兩幾]成(?![功績本長立為果員熟就分語效])|十之八九|八九不離十|九成九|十拿九穩|過半的機會/g;

/**
 * 斷定語氣。規格書 §7.2 明文禁止「有相當把握」這類措辭。
 *
 * 每一條都要能與**誠實的否定形**共存：「沒有把握」「不保證」「不一定
 * 上得了」都是應該鼓勵的說法，而它們的字串裡就含著禁用詞。所以命中
 * 之後還要再看前面六個字有沒有否定詞（見 `hasNegatorBefore`）。
 *
 * 「一定」與「絕對」刻意要求後面接一個具體的斷言：「你一定要注意年際
 * 波動」與「它絕對不是零」都是好句子，而它們前半段長得像違規。
 */
const CERTAINTY = [
  ['一定會上', /一定(?:上|會上|能上|考得上|錄取|過關|通過|沒問題|可以上|行)/g],
  ['穩上', /穩(?:上|過|了|啦|得很|的很)|[很蠻挺超還]穩(?![健定固])/g],
  ['有把握', /(?:有|相當|很有|挺有|滿有|頗有|蠻有)(?:相當)?把握/g],
  ['保證', /保證/g],
  ['沒問題', /沒問題|不會有問題|不成問題/g],
  ['篤定', /篤定|鐵定|包上|跑不掉|沒跑|勝券在握|穩操勝算|穩穩/g],
  ['絕對可以', /絕對(?:上|會上|沒問題|可以|安全|穩)/g],
  ['輕鬆上', /輕鬆(?:上|過|錄取|通過)/g],
  ['放心', /放心(?:填|去填|了|吧)|可以放心/g],
  ['沒有懸念', /沒有?懸念|毫無疑問/g],
  ['問題不大', /問題不大|不會有意外|十成十/g],
];

/** 帶單位的數字。**這幾個單位裡的數字會被學生用來做決定。** */
const NUMBER_WITH_UNIT = /(\d+(?:\.\d+)?)\s*(%|級分|名|人|分)(?!鐘|之)/g;

/**
 * 平均、中位數。**這幾個字在這裡一定是編的。**
 *
 * 官方公布的只有各校系第一輪**最後一名錄取者**的在校百分比。那是一個
 * 極值，不是一個分布——所以「平均錄取百分比是 16%」這句話沒有任何資料
 * 可以支撐它，不管有幾年的資料。這一條抓的正是「把極值當平均」。
 */
const AVERAGE_WORDS = /平均|均值|中位數|中位|average|median|mean(?!ing)/gi;

/** 對全體錄取者的分布下結論。同上：只有最後一名那一個點。 */
const DISTRIBUTION_CLAIM =
  /全體錄取|所有錄取(?:者|生|的人)|錄取(?:生|者)的分布|錄取分布|錄取者的平均/;

/**
 * 引用來源的句型。**只抓引用，不抓建議。**
 *
 * 「去大考中心查一下當年度的統計」是這個功能最該講的一句話，而它含著
 * 「大考中心」。所以這一組刻意只比對引用形（依／根據／簡章寫／統計顯示），
 * 不比對機構名本身——不然最好的輸出會被擋掉。
 */
const CITED_SOURCE =
  /(?:依|根據|按照|依照|依據)(?:官方|簡章|委員會|大考中心|教育部|招聯會|榜單)|官方(?:公布|統計)(?:的)?(?:資料|數字|標準)?(?:顯示|指出|寫著|說明|說)|簡章(?:上|裡)?(?:寫|明訂|規定|載明)(?:著|明)?|(?:大考中心|委員會|招聯會)(?:的)?(?:統計|資料|公告)(?:顯示|指出|寫著)/;

/** 三年跨度的說法。資料只有一年時說「近三年」就是憑空多出兩年。 */
const SPAN_THREE = /近三年|近 ?3 ?年|這三年|過去三年|三年來|前三年|近三屆|三年的資料|三年的趨勢/;
/** 兩年以上的跨度。「歷年」也算——一筆資料談不上歷年。 */
const SPAN_TWO = /近兩年|近 ?2 ?年|這兩年|過去兩年|兩年來|歷年|逐年|每一年都|年年/;

/**
 * 不確定性的標記。有門檻資料而完全不提資料基礎的建議是不合格的——
 * 那正是坊間工具的樣子，也是規格書 §2.3 要求的相反面。
 */
const UNCERTAINTY_MARKERS =
  /極值|只有一個|唯一一個|年際|波動|樣本|不確定|最後一名|參考|可能差很多|不保證|沒有辦法|說不準|變動|看不出|線索|趨勢/;

/** 建議的長度上限。比智慧老師寬——這裡要交代資料來源與缺口。 */
const MAX_ADVICE_CHARS = 700;

// ─────────────────────────────────────────────────────────────────

/**
 * 一個位置附近的文字。
 *
 * 兩種寬度都用得到，而它們的用途不同：**否定詞只看緊鄰的八個字**
 * （否定要貼著才是否定），**數字看寬一點**（「the probability of admission
 * is about 70%」中間隔了二十幾個字，而它是一次完整的機率預測）。
 * 用同一個寬度的話，兩邊必有一邊是錯的。
 */
function nearby(text, start, end, back, fwd) {
  return text.slice(Math.max(0, start - back), end + fwd);
}

/** 全域正規表達式的每一個命中位置。`g` 旗標的 lastIndex 一定要先歸零。 */
function allMatches(re, text) {
  re.lastIndex = 0;
  const out = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ text: m[0], index: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return out;
}

/**
 * @typedef {object} AdviceViolation
 * @property {string} code
 * @property {'FAKE'|'STYLE'} severity FAKE 一定重來；STYLE 重來一次還這樣就收下
 * @property {string} detail 給人看的一句話。會寫進稽核與老師端。
 */

/**
 * 這一段建議可以送給學生嗎。
 *
 * @param {string} advice 模型產生的一整段文字
 * @param {ReturnType<typeof adviceFacts>} facts
 * @param {{maxChars?: number}} [opts]
 * @returns {{ok: boolean, violations: AdviceViolation[], fabricated: boolean}}
 *
 * **整段一起看。** 「這個志願的門檻你跨得過。差不多七成。」拆成兩句
 * 之後每一句單獨都不夠明顯，合起來是一次完整的假預測。
 */
export function checkAdvice(advice, facts = {}, opts = {}) {
  /** @type {AdviceViolation[]} */
  const v = [];
  const text = normalizeForAdvice(advice);
  const allowed = new Set(facts.numbers ?? []);

  const add = (code, severity, detail) => {
    if (!v.some((x) => x.code === code)) v.push({ code, severity, detail });
  };

  // ── 一、機率詞 ＋ 數字或程度 ─────────────────────────────
  for (const hit of allMatches(ODDS_WORDS, text)) {
    // 「不估機率」「機率無法估計」——這兩種都是誠實的說法，而且是這個
    // 功能必須說得出來的話。
    if (negatedBefore(text, hit.index)) continue;
    if (ODDS_EXEMPT_AFTER.test(text.slice(hit.end, hit.end + 10))) continue;
    const withNumber = /\d/.test(nearby(text, hit.index, hit.end, 24, 24));
    const withMagnitude = MAGNITUDE.test(nearby(text, hit.index, hit.end, 12, 12));
    if (withNumber || withMagnitude) {
      add(
        'ODDS_PREDICTION',
        'FAKE',
        `出現了「${hit.text}」形式的錄取預測。全國比序只有每年一個極值資料點，` +
          '推不出任何機率——這一項規格書列為明確不做。',
      );
      break;
    }
  }

  // ── 二、換成中文的成數 ──────────────────────────────────
  for (const hit of allMatches(TENTHS, text)) {
    if (negatedBefore(text, hit.index)) continue;
    add('ODDS_IN_WORDS', 'FAKE', `用中文的成數講了機率（「${hit.text}」），與寫百分比一樣。`);
    break;
  }

  // ── 三、斷定語氣 ────────────────────────────────────────
  //
  // 每一種都要掃**全部**的命中位置，不是只看第一個。只看第一個的話，
  // 「我不保證會上，但這個志願保證沒問題」前半段的否定會把後半段擋掉的
  // 機會吃掉——而那正是模型學會的第一種繞法。
  outer: for (const [name, re] of CERTAINTY) {
    for (const hit of allMatches(re, text)) {
      if (negatedBefore(text, hit.index)) continue;
      add(
        'CERTAINTY',
        'FAKE',
        `出現了「${hit.text}」（${name}）。規格書明文禁止這類措辭——` +
          '官方公布的只有最後一名錄取者的百分比，而第一輪名額常常只有 1 至 3 名。',
      );
      break outer;
    }
  }

  // ── 四、沒有來源的數字 ──────────────────────────────────
  //
  // 建議裡的每一個帶單位的數字都必須對得回一筆 AdmissionReference。
  // 對不回去的就是模型自己編的，而它讀起來與查來的完全一樣。
  NUMBER_WITH_UNIT.lastIndex = 0;
  for (let m = NUMBER_WITH_UNIT.exec(text); m !== null; m = NUMBER_WITH_UNIT.exec(text)) {
    const key = String(Number(m[1]));
    if (allowed.has(key)) continue;
    add(
      'UNSOURCED_NUMBER',
      'FAKE',
      `「${m[1]}${m[2]}」對不回任何一筆你查到的資料。` +
        '沒有來源的數字與有來源的長得一模一樣，而學生會照著它決定要不要填志願。',
    );
    break;
  }

  // ── 五、把極值當平均 ────────────────────────────────────
  {
    for (const hit of allMatches(AVERAGE_WORDS, text)) {
      // 「不是平均，是最後一名」是這一段最該講的話之一，所以否定形要放過。
      if (negatedBefore(text, hit.index)) continue;
      if (!/\d/.test(nearby(text, hit.index, hit.end, 24, 24))) continue;
      add(
        'EXTREME_AS_AVERAGE',
        'FAKE',
        `把極值講成了「${hit.text}」。官方公布的是第一輪最後一名錄取者的百分比，` +
          '那是一個極值而不是一個分布——沒有任何平均可以算。',
      );
      break;
    }
    if (DISTRIBUTION_CLAIM.test(text)) {
      add(
        'EXTREME_AS_AVERAGE',
        'FAKE',
        '對全體錄取者的分布下了結論。可取得的資料只有最後一名錄取者那一個點。',
      );
    }
  }

  // ── 六、引用不存在的來源 ────────────────────────────────
  if (!facts.hasOfficialDoc) {
    const hit = CITED_SOURCE.exec(text);
    if (hit) {
      add(
        'FAKE_SOURCE',
        'FAKE',
        `寫了「${hit[0]}」，但這位學生輸入的資料裡沒有任何一筆是官方文件。` +
          '引用一個不存在的來源，比不引用更糟。',
      );
    }
  }

  // ── 七、憑空多出來的年份 ────────────────────────────────
  if (SPAN_THREE.test(text) && (facts.yearCount ?? 0) < 3) {
    add(
      'FAKE_YEAR_SPAN',
      'FAKE',
      `講了「近三年」，但只有 ${facts.yearCount ?? 0} 年的錄取標準資料。` +
        '缺的那兩年不是可以推出來的東西。',
    );
  }
  if (SPAN_TWO.test(text) && (facts.yearCount ?? 0) < 2) {
    add(
      'FAKE_YEAR_SPAN',
      'FAKE',
      `講了跨年度的趨勢，但只有 ${facts.yearCount ?? 0} 年的資料。一筆資料談不上趨勢。`,
    );
  }

  // ── 八、體例 ────────────────────────────────────────────
  //
  // 這兩條不是假精確度，是「這樣就不誠實了」。分開標記，因為呼叫端
  // 對兩種的重試策略不同：假精確度一定重來，體例問題重來一次還是這樣
  // 就收下——為了少一句「資料很薄」而把一段有用的建議丟掉是虧的。
  //
  // 只在建議**真的引用了一個百分比**時要求它交代資料基礎。單看
  // `thresholdCount > 0` 的話，一段完全不下結論、只說「去把 113 那年
  // 補上」的建議也會被判成不合格——而那一段正是資料不足時最該給的東西。
  if ((facts.thresholdCount ?? 0) > 0 && /\d+(?:\.\d+)?\s*%/.test(text)) {
    if (!UNCERTAINTY_MARKERS.test(text)) {
      add(
        'NO_UNCERTAINTY',
        'STYLE',
        '引用了門檻的百分比，但完全沒有交代這個判斷的資料基礎有多薄。' +
          '規格書 §2.3：不確定性必須被看見。',
      );
    }
  }
  const len = text.replace(/\s+/g, '').length;
  const max = opts.maxChars ?? MAX_ADVICE_CHARS;
  if (len > max) {
    add('TOO_LONG', 'STYLE', `這一段有 ${len} 字，超過 ${max} 字。學生不會讀完。`);
  }

  return {
    ok: v.length === 0,
    violations: v,
    /** 有沒有製造假的精確度。true 就一定要重新生成。 */
    fabricated: v.some((x) => x.severity === 'FAKE'),
  };
}

/** 把違規清單折成一行，寫進伺服器日誌。**這一份會引用被擋掉的數字。** */
export function describeAdviceViolations(violations) {
  if (!violations || violations.length === 0) return '';
  return violations.map((x) => `${x.code}：${x.detail}`).join('；');
}

/**
 * 每一種違規的**不含數字**的說法。
 *
 * # 為什麼要有第二套說法
 *
 * 因為 `detail` 會把被擋掉的那個數字引用出來（「『68%』對不回任何一筆
 * 你查到的資料」），而那正是整個閘門在防的東西。把它送到學生的畫面上，
 * 等於用一句「這個數字被擋掉了」把那個數字說給他聽——他會記住 68%，
 * 而 68% 從來就不存在。
 *
 * 所以分成兩套：`detail` 給伺服器日誌與老師端（那裡需要具體），
 * 這一份給學生（他需要知道「AI 剛剛想給你一個機率」，不需要知道是幾）。
 */
export const VIOLATION_LABELS = {
  ODDS_PREDICTION: '給了一個錄取機率',
  ODDS_IN_WORDS: '用中文的成數講了機率',
  CERTAINTY: '用了斷定的措辭（「一定」「穩」「有把握」這一類）',
  UNSOURCED_NUMBER: '用了一個對不回你查到的資料的數字',
  EXTREME_AS_AVERAGE: '把最後一名錄取者的百分比講成了平均',
  FAKE_SOURCE: '引用了一個你手上沒有的來源',
  FAKE_YEAR_SPAN: '憑空多出了幾個年份的資料',
  NO_UNCERTAINTY: '引用了門檻卻沒有交代資料基礎有多薄',
  TOO_LONG: '寫太長了',
};

/**
 * 可以給學生看的違規說明。**不含任何被擋掉的數字。**
 *
 * @returns {string[]} 每一項是 `CODE：說法`。代號留著是因為它不含數字，
 *   而且老師問起來時對得回規則。
 */
export function summarizeAdviceViolations(violations) {
  if (!violations || violations.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const v of violations) {
    if (seen.has(v.code)) continue;
    seen.add(v.code);
    out.push(`${v.code}：${VIOLATION_LABELS[v.code] ?? '不符合這一層的規則'}`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// 退路
// ─────────────────────────────────────────────────────────────────

const fmtDate = (d) => {
  const t = d ? new Date(d) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toISOString().slice(0, 10) : '日期不明';
};

/**
 * 重試用完之後給學生的東西：**一個只陳述事實的版本。**
 *
 * 它由程式組出來，不經過模型，所以它永遠不會製造假的精確度。三件事：
 * 把他查到的原樣列出來（含來源與查詢日期）、說出這些數字的資料基礎有
 * 多薄、以及還缺什麼。
 *
 * **不可以是「AI 暫時無法回應」。** 對學生來說那等於功能壞了，而它沒壞
 * ——是模型剛剛三次都想給他一個機率。而且這一段本身就有用：他查到的
 * 東西擺在一起、標好來源與日期，那已經比一張紙上的幾個數字好得多。
 *
 * 列出的筆數有上限，因為它要通得過自己的長度規則（測試會驗這件事）。
 */
export function safeAdvice(basis = {}) {
  const lines = [];
  const thresholds = (basis.thresholds ?? []).slice(0, 4);

  if (thresholds.length > 0) {
    lines.push('你查到的錄取標準：');
    for (const t of thresholds) {
      const where = [t.institutionName, t.programName, t.starGroup ? `第 ${t.starGroup} 類學群` : '']
        .filter(Boolean)
        .join(' ');
      lines.push(
        `· ${where}　${t.year} 學年度　${t.describe}` +
          `（${t.trust?.sourceLabel ?? '來源不明'}，${fmtDate(t.lookedUpAt)} 查` +
          `${t.trust?.stale ? '，已經過了學年度' : ''}）`,
      );
    }
  }

  const mine = Number.isFinite(basis.officialPercentile)
    ? { v: basis.officialPercentile, from: '教務處匯入的' }
    : Number.isFinite(basis.selfPercentile)
      ? { v: basis.selfPercentile, from: '你自己輸入的' }
      : null;
  if (mine) {
    lines.push(`你的在校百分比是 ${mine.v}%（${mine.from}，越小越好）。`);
  }

  if (thresholds.length > 0) {
    // 這一句是整段的重點，而且它是這個功能與坊間工具唯一的實質差別。
    lines.push(
      '要知道的是這些數字的來歷：官方公布的只有第一輪最後一名錄取者的百分比，' +
        '而繁星校系第一輪名額常常只有 1 至 3 名——也就是每年只有一個極值資料點。' +
        '年際波動可能很大，所以這裡不估錄取機率。',
    );
  }

  for (const g of (basis.gaps ?? []).slice(0, 2)) lines.push(g.text);

  if (lines.length === 0) {
    lines.push(
      '你還沒有輸入任何查到的資料，所以現在沒有東西可以給建議。' +
        '上面的清單照時序列出了要查什麼、去哪裡查、以及查到之後填在哪一格。',
    );
  }

  return lines.join('\n');
}
