/**
 * 學測級分預測（N1），以及它的校準。
 *
 * # 為什麼這一項從「做不到」變成做得到
 *
 * 原本的判斷是「級分預測需要 IRT 能力估計，核心系統沒有，所以不做」
 * （`lib/admission.mjs` 的 `NOT_OFFERED.GRADE_PREDICTION` 仍然留著那段
 * 文字，因為它描述的那條路確實走不通）。那個判斷錯在它忽略了一件
 * 現成的事：**補習班的模擬考本來就會公布級分**——南模、全模、校內
 * 模考，學生手上那張成績單上印的就是級分。那是**直接觀測值**。
 *
 * 從自己的作答記錄反推級分要跨兩道換算：原始分 → 難度校正 → 級距。
 * 每一道都放大誤差，而級距在校內人數不足時本身就不可靠（文件 A.2：
 * 級距 = 前 1% 考生的平均原始分 ÷ 15，80 人的模考前 1% 不到一個人）。
 * 直接收成績單上那個數字，這兩道誤差都是零。
 *
 * 所以這個檔案的輸入是 `SubjectGradeRecord`（歷次級分），不是作答記錄。
 *
 * # 輸出永遠是分布，永遠不是一個數字
 *
 * 規格書 §6.3 的驗收準則寫得很硬：「介面上不存在任何呈現單一級分數字
 * 的路徑」。理由是「你的數學 A 預估 12 級分」會被學生當成承諾，
 * 而「11 至 13 級分，信心 70%」才是誠實的。
 *
 * 這一條在程式碼上的落實方式有三層：
 *
 *   一、`predictGrade()` 回的是**機率分布**加一個區間，沒有點估計欄位
 *       出現在學生看得到的那一層（`basis.center` 是稽核與校準用的，
 *       `predictDb.ts` 的學生投影會把它濾掉）。
 *   二、`intervalOf()` **不允許回一個寬度為 1 的區間**——「預估 12 至
 *       12 級分」在讀者眼裡就是一個數字。命中時往機率大的一側加寬，
 *       並回報加寬後真正達到的覆蓋率。
 *   三、信心水準**永遠小於 1**（資料庫的 CHECK 也擋這件事）。
 *       1 代表保證，而這個系統不做保證。
 *
 * # 不確定性有四個來源，四個都要進去（規格書 §6.1）
 *
 * 規格書列的四項是針對 IRT 那條路寫的，這裡逐項對應到觀測級分之後
 * 仍然是四項，而且**每一項都在 `basis.variance` 裡有自己的數字**——
 * 合成一個 σ 的話，日後沒有人分得出哪一項估得太小。
 *
 *   一、`disp`   自己歷次成績的離散程度。取代原文的「theta 估計誤差」：
 *                同樣是「他這個人的水準本身有多不確定」，而樣本越少
 *                越不確定。這一項用**預測區間**的公式（`s²(1+1/n)`）
 *                而不是平均數的標準誤——我們要預測的是下一次的一個
 *                觀測值，不是他的長期平均。少了那個 `s²` 項，區間會
 *                窄到荒謬。
 *   二、`diff`   模考與真學測的難度差異。規格書說「用共同題校正，沒有
 *                共同題時這一項的不確定性很大」——我們沒有共同題
 *                （模考的卷子不是我們出的），所以這一項是一個依來源
 *                給定的常數，而不是校正出來的值。
 *   三、`scale`  級距本身的不確定性。**這一項與第二項刻意分開**，因為
 *                它們的來源不同：難度差異是「卷子不一樣」，級距不確定
 *                是「換算的分母不可靠」。校內模考在這一項上特別重
 *                （文件 A.2），全國模考輕得多——分開才說得出這件事。
 *   四、`drift`  剩餘時間內的能力變化。**距考試越遠不確定性越大，而且
 *                分布偏向上方**（規格書原文），因為學生通常會進步。
 *                偏向上方用的是兩片式常態（split-normal）：眾數以上的
 *                σ 比眾數以下大，所以右尾比左尾厚，而不是把整個分布
 *                平移——平移會讓「他可能退步」這件事消失。
 *
 * # 為什麼進步幅度不是直接把模考的斜率外插到考試日
 *
 * 因為那是這一類預測最常見的一種爆炸：三次模考從 8 進步到 11，斜率
 * 一個月一級，離考試還有六個月 → 預估 17 級分。級分上限是 15，而
 * 真正的問題不是上限而是**斜率本身估不準**——三個點的迴歸斜率標準誤
 * 大到與斜率本身同一個量級。
 *
 * 所以斜率做**收縮**（shrinkage）：樣本少時往一個保守的先驗（每月
 * 0.15 級分）靠，樣本多時才相信他自己的斜率。這是經驗貝氏最標準的
 * 做法，而它的行為在兩端都對：一次成績 → 完全用先驗；八次穩定上升
 * → 幾乎完全用他自己的斜率。最後再加一個絕對上限。
 *
 * # 校準是這個功能能不能存在的條件（規格書 §6.2）
 *
 * 「預測系統若不追蹤自己的準確度，就只是在製造好看的數字。」
 * 所以每一次預測都存進 `GradePrediction`，學測成績公布後回填
 * `actualGrade`，然後算校準曲線：**所有被預測為「信心 70%」的區間裡，
 * 實際落在區間內的比例是否接近 70%**。
 *
 * `calibrationCurve()` 是那一段的計算。它刻意做了一件事：**小樣本
 * 不告警**。用 Wilson 區間而不是點估計去判斷偏離，否則第一屆的前
 * 十筆資料就會讓管理介面天天紅字，然後那個告警會被關掉——而它是
 * 這整套東西唯一的品質訊號。
 *
 * # 為什麼是 .mjs
 *
 * 與 `lib/admission.mjs`、`lib/star.mjs` 同一個理由：會算錯的東西要能
 * 在沒有資料庫的情況下驗。這裡每一支都是純函式，餵物件就測得動。
 * 資料層（`lib/predictDb.ts`）只負責讀出來丟給它算、把結果寫回去。
 */

// ═════════════════════════════════════════════════════════════════
// §1 常數
//
// 每一個都要說得出為什麼是這個數字。說不出來的常數會在下一個人
// 「調一下看看」的時候變成另一個數字，而沒有人知道原本為什麼是那樣。
// ═════════════════════════════════════════════════════════════════

/** 級分的下界與上界。學測是 0 至 15（文件 A.2）。 */
export const GRADE_MIN = 0;
export const GRADE_MAX = 15;

/**
 * 少於這麼多次成績就標成 `thin`，不給區間。
 *
 * # 門檻為什麼是 3
 *
 * 因為 2 是「算得出離散程度」的最小值，而 3 是「那個離散程度不是
 * 完全由一個點決定」的最小值。逐項說：
 *
 *   1 次 → 離散程度**完全沒有資料**。這時候的區間寬度只能來自先驗，
 *          也就是說**每一位只考過一次而級分相同的學生會看到一模一樣
 *          的區間**——那個區間與他這個人沒有關係，它只是一個常數。
 *          而學生會把它當成針對他的預測。
 *   2 次 → 一個自由度。標準差的估計本身的相對誤差約 70%，而且它由
 *          唯一的那一組差值決定：兩次都剛好考 12，估出來的離散是 0，
 *          於是區間會窄到只有一級——一個看起來極精確的錯誤。
 *   3 次 → 兩個自由度。仍然很粗，但至少一次意外不會單獨決定寬度，
 *          而收縮（`PRIOR_DF`）會把剩下的不確定性補回來。
 *
 * 規格書 §6.3 的門檻寫的是「作答樣本少於 50 題」，那是針對「從作答
 * 記錄反推」那條路的。這裡的樣本單位是**考試次數**而不是題數，所以
 * 那個數字不能照抄——照抄的話，一位考過五次模考的學生會因為題數
 * 不足而被標成資料不足，而他手上有五個直接觀測值。
 */
export const THIN_MIN_RECORDS = 3;

/**
 * 時間權重的半衰期（天）。
 *
 * 120 天約四個月：去年這個時候的模考只算最近一次的八分之一左右。
 * 選這個長度是因為高三的一個學期大約就是這麼長，而**跨學期的成績
 * 不該與這個月的成績等重**——但也不能直接丟掉，那會讓樣本數掉回
 * 一兩筆然後整科變成 `thin`。
 */
export const HALF_LIFE_DAYS = 120;

/**
 * 離散程度的先驗：標準差 1.2 級分、相當於 2 個自由度。
 *
 * 1.2 級分是模考之間的典型波動量級（同一位學生兩次模考差一到兩級
 * 是常態）。`PRIOR_DF = 2` 讓它在 n=3（自由度 2）時與觀測值各佔一半
 * ——樣本少時不要相信一個由兩三個點算出來的標準差，尤其是它剛好
 * 算出 0 的那一次。
 */
export const PRIOR_SD = 1.2;
export const PRIOR_DF = 2;

/**
 * 每一種成績來源帶進來的兩種不確定性（級分，標準差）。
 *
 *   `difficulty` 這張卷子與真學測的難度差異。
 *   `scale`      這個級分是用什麼級距換算出來的，那個級距可靠嗎。
 *
 * 三種來源的差別集中在 `scale`，而理由很具體：
 *
 *   · `OFFICIAL_GSAT` 兩項都是 0。它**就是**學測，沒有難度差異也沒有
 *     換算誤差。（會有這種記錄是因為重考生，以及回填校準用的實際成績。）
 *   · `EXTERNAL_MOCK`（南模、全模）到考人數是全國幾萬人，級距算得出來
 *     而且穩定，所以 `scale` 小。但卷子不是大考中心出的，難度會偏。
 *   · `INTERNAL_MOCK`（校內模考）難度差異與外部模考同一個量級，但
 *     `scale` 重得多——校內幾十人到幾百人，前 1% 只有一兩個人，那一兩個
 *     人那天的狀況決定全班的級分（文件 A.2、`lib/gsat.mjs` 的 `gsatLevels`
 *     在人數不足時根本不換算級分，就是這個理由）。
 *
 * 這幾個數字沒有辦法從資料估出來（那需要同一批學生的模考與學測配對，
 * 而那要累積一屆）。所以它們是**先驗，而且校準曲線會告訴我們它們是不是
 * 訂錯了**：若 70% 區間的實際命中率長期偏高，代表這裡給得太寬。
 */
export const SOURCE_UNCERTAINTY = Object.freeze({
  OFFICIAL_GSAT: Object.freeze({ difficulty: 0, scale: 0, label: '學測' }),
  EXTERNAL_MOCK: Object.freeze({ difficulty: 0.7, scale: 0.4, label: '外部模考' }),
  INTERNAL_MOCK: Object.freeze({ difficulty: 0.7, scale: 1.1, label: '校內模考' }),
});

/** 認不出來的來源當成最不可靠的那一種。**不要當成中等。** */
const UNKNOWN_SOURCE = Object.freeze({ difficulty: 0.9, scale: 1.3, label: '來源不明' });

/** 這一筆成績的來源帶進來的不確定性。 */
export function sourceUncertaintyOf(source) {
  return SOURCE_UNCERTAINTY[String(source ?? '')] ?? UNKNOWN_SOURCE;
}

/**
 * 剩餘時間造成的不確定性：每 √月 0.45 級分。
 *
 * 用 √t 而不是 t 是隨機漫步的標準尺度，而它的形狀是對的：距考試
 * 一個月與兩個月的差別，比十一個月與十二個月的差別大。線性成長會
 * 讓一年前的預測寬到沒有意義（±5 級分以上），而那時它應該是
 * 「不確定但仍然有方向」。
 *
 * 0.45 × √12 ≈ 1.56 級分，也就是離考試一年時光這一項就貢獻約 1.5 級分
 * 的標準差。與離散程度那一項合起來，區間大約是 ±3 級分——對一年前的
 * 預測而言這是誠實的。
 */
export const DRIFT_SD_PER_SQRT_MONTH = 0.45;

/**
 * 進步幅度的先驗：每月 0.15 級分。
 *
 * 正的，因為高三下半年在補習班上課的學生通常會進步——這也是規格書
 * §6.1 說「分布應該偏向上方」的同一個理由。0.15 是保守的：半年 0.9 級
 * 分，不到一級。**不能訂大**，因為它會在樣本少的時候完全主導預測，
 * 而那時我們對這位學生一無所知。
 */
export const PRIOR_DRIFT_PER_MONTH = 0.15;

/**
 * 斜率收縮的強度。`k = (n_eff - 2) / (n_eff - 2 + SLOPE_SHRINK)`。
 *
 * 2 讓 n_eff = 4 時各佔一半、n_eff = 8 時他自己的斜率佔 75%。
 * 也就是「考過四次才開始相信你自己的趨勢」。
 */
export const SLOPE_SHRINK = 2;

/**
 * 進步幅度的絕對上限（級分）。
 *
 * 3 級分是一個很大的進步（例如 9 到 12），而它是**上限不是預期**。
 * 這一條擋的是「三次模考剛好連續上升」乘上「還有八個月」算出來的
 * 六級分——那個數字在數學上是斜率外插的結果，在現實裡不存在。
 */
export const MAX_IMPROVEMENT = 3;

/**
 * 右尾加厚的速率與上限。`skew = min(SKEW_MAX, SKEW_PER_MONTH × 月)`，
 * 而 `σ_up = σ_down × (1 + skew)`。
 *
 * 離考試八個月時 skew ≈ 0.48，也就是右邊的標準差比左邊大 48%。
 * 上限 0.5 是為了讓分布仍然看得出是一個峰——再偏下去它會變成一條
 * 往上拖的斜坡，而那已經不是「通常會進步」而是「一定會進步」。
 */
export const SKEW_PER_MONTH = 0.06;
export const SKEW_MAX = 0.5;

/** 預設的目標信心水準。規格書 §6.1 的例子用的就是 70%。 */
export const DEFAULT_CONFIDENCE = 0.7;

/**
 * 信心水準的上限。
 *
 * **不是 0.999 也不是 1。** 資料庫的 CHECK 明文擋 `confidence = 1`
 * （1 代表保證，而這個系統不做保證），而離散的 16 個級分很容易讓
 * 一個寬區間的覆蓋率算出 1.0——例如區間就是 0 到 15。
 * 所以在這裡先夾住，理由與 CHECK 相同。
 */
export const MAX_CONFIDENCE = 0.99;

/** 一個月幾天。回歸與剩餘時間都用它換算，寫死一個平均值。 */
const DAYS_PER_MONTH = 30.4375;
const DAY_MS = 86_400_000;

// ═════════════════════════════════════════════════════════════════
// §2 常態分布
//
// 這兩支要匯出，因為落點模擬的 Gaussian copula 用同一份實作
// （`lib/placement.mjs`）。兩邊各寫一份的話，其中一邊改了精度，
// 而抽樣結果與邊際分布就會對不起來——症狀是模擬出來的通過率
// 與逐科的區間互相矛盾，而畫面上兩個數字都看起來正常。
// ═════════════════════════════════════════════════════════════════

/**
 * 誤差函數。Abramowitz & Stegun 7.1.26，絕對誤差 < 1.5e-7。
 *
 * 這個精度對級分綽綽有餘：級分是 16 個整數，1.5e-7 的機率誤差不會
 * 改變任何一個 bin 的第四位小數。用更精確的實作（例如連分數）換不到
 * 任何看得見的差別，只換到更難驗的程式碼。
 */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}

/** 標準常態的累積分布函數。 */
export function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * 兩片式常態（split-normal）的累積分布函數。
 *
 * 眾數在 `mode`，眾數以下的標準差是 `sdDown`、以上是 `sdUp`。
 * `sdUp > sdDown` 時右尾比左尾厚，也就是**分布偏向上方**——這是
 * 規格書 §6.1 對「剩餘時間內的能力變化」明確要求的形狀。
 *
 * 為什麼用它而不是把整個常態往上平移：平移之後「他可能退步」這件事
 * 就消失了（分布左邊也跟著上移）。加厚右尾保留了兩個方向，只是
 * 往上的那一邊留了更多空間。
 *
 * 兩片在 `mode` 接得上：眾數以下的總機率是 `sdDown / (sdDown + sdUp)`，
 * 小於 0.5——這一行就是「偏向上方」在數字上的意思。
 */
export function splitNormalCdf(x, mode, sdDown, sdUp) {
  const s1 = Math.max(1e-9, sdDown);
  const s2 = Math.max(1e-9, sdUp);
  if (x < mode) {
    return ((2 * s1) / (s1 + s2)) * normalCdf((x - mode) / s1);
  }
  return (s1 - s2) / (s1 + s2) + ((2 * s2) / (s1 + s2)) * normalCdf((x - mode) / s2);
}

// ═════════════════════════════════════════════════════════════════
// §3 學測日期
// ═════════════════════════════════════════════════════════════════

/**
 * 某個民國學年度的學測大約是哪一天。
 *
 * 115 學年度的學測在**民國 116 年 1 月**（西元 2027），所以西元年是
 * `1911 + year + 1`。差一年的後果不是顯示錯誤，是剩餘時間差 12 個月，
 * 於是整份預測的區間寬度差一倍——而畫面上只是一個看起來偏寬的區間。
 *
 * 日期用 1 月 20 日這個近似值。確切日期每年由大考中心公告，而它只
 * 影響剩餘時間那一項：兩週的誤差在 √月 的尺度上大約是 2%，改變不了
 * 任何一個區間的整數邊界。真的要精確就傳 `examDate` 進來。
 */
export function gsatDateOf(year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 100 || y > 200) return null;
  return new Date(Date.UTC(1911 + y + 1, 0, 20));
}

// ═════════════════════════════════════════════════════════════════
// §4 一科的預測
// ═════════════════════════════════════════════════════════════════

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 一科的級分預測。
 *
 * @param {{
 *   subjectCode: string,
 *   records: {examName?: string, examDate: Date|string, grade: number, source?: string}[],
 *   examDate?: Date|string|null,
 *   targetYear?: number,
 *   now?: Date,
 *   confidence?: number,
 *   abilityTrend?: number|null,
 * }} input
 *   `abilityTrend` 是掌握度的變化方向（`AbilitySnapshot` 的趨勢，
 *   −1 至 1），**可選**。它只微調進步幅度的先驗，不改變區間寬度——
 *   掌握度與級分不同尺度，用它去算寬度是把兩件事混在一起。
 *
 * @returns {{
 *   subjectCode: string, available: boolean, thin: boolean, reason: string,
 *   interval: {low: number, high: number, confidence: number, widened: boolean}|null,
 *   distribution: {grade: number, p: number}[]|null,
 *   basis: object, notes: string[],
 * }}
 */
export function predictGrade({
  subjectCode,
  records = [],
  examDate = null,
  targetYear = null,
  now = new Date(),
  confidence = DEFAULT_CONFIDENCE,
  abilityTrend = null,
} = {}) {
  const nowAt = now instanceof Date ? now : new Date(now);

  // 級分必須是 0 至 15 的整數。超出範圍的一律丟掉並記下來——資料庫的
  // CHECK 擋得住寫入，但這一支也可能吃到別處組出來的物件，而一筆 78
  // （填成百分制的那一次）會把整條趨勢拉走，且畫面上只是一個偏高的區間。
  const bad = [];
  const rows = [];
  for (const r of records) {
    const g = Number(r?.grade);
    const at = r?.examDate instanceof Date ? r.examDate : new Date(r?.examDate);
    if (!Number.isInteger(g) || g < GRADE_MIN || g > GRADE_MAX || Number.isNaN(at?.getTime())) {
      bad.push({ examName: r?.examName ?? '', grade: r?.grade, examDate: r?.examDate });
      continue;
    }
    rows.push({ examName: r?.examName ?? '', examDate: at, grade: g, source: r?.source });
  }
  rows.sort((a, b) => a.examDate - b.examDate);

  const target =
    examDate ? (examDate instanceof Date ? examDate : new Date(examDate)) : gsatDateOf(targetYear);

  const emptyBasis = {
    records: rows.length,
    rejected: bad,
    targetYear: targetYear ?? null,
    examDate: target ? target.toISOString() : null,
  };

  if (rows.length === 0) {
    return {
      subjectCode,
      available: false,
      thin: true,
      reason:
        '這一科還沒有任何級分記錄，所以沒有東西可以預測。' +
        '把模考成績單上的級分輸入進來（南模、全模、校內模考都算），一次一筆。',
      interval: null,
      distribution: null,
      basis: emptyBasis,
      notes: [],
    };
  }

  // ── 時間權重 ──────────────────────────────────────────────
  //
  // 以**最近一次考試**為基準算年齡，而不是以「今天」。理由是這一段
  // 要回答的是「他現在的水準」，而那個估計的時點應該落在他的成績
  // 記錄裡面，不是落在一個他可能三個月沒考試的今天。
  const newest = rows[rows.length - 1].examDate.getTime();
  const weights = rows.map((r) =>
    Math.pow(0.5, (newest - r.examDate.getTime()) / DAY_MS / HALF_LIFE_DAYS),
  );
  const sumW = weights.reduce((a, b) => a + b, 0);
  const sumW2 = weights.reduce((a, b) => a + b * b, 0);
  /**
   * Kish 的有效樣本數。八次都在同一個月 → 接近 8；八次散在三年 →
   * 可能只有 2 點多。用它算收縮與 `1/n` 項才對得上「這些資料真的
   * 提供了多少獨立資訊」。
   */
  const nEff = sumW > 0 ? (sumW * sumW) / sumW2 : 0;

  // 加權平均的時點。加權平均估的是**這個時點**的水準，所以進步幅度
  // 要從這裡算到考試日，不是從今天算。差別在學生停考一段時間時很大。
  const anchorMs = rows.reduce((acc, r, i) => acc + weights[i] * r.examDate.getTime(), 0) / sumW;
  const anchorDate = new Date(anchorMs);
  const weightedMean = rows.reduce((acc, r, i) => acc + weights[i] * r.grade, 0) / sumW;

  const monthsToExam = target ? (target.getTime() - anchorMs) / DAY_MS / DAYS_PER_MONTH : 0;
  const monthsAhead = Math.max(0, monthsToExam);

  // ── 樣本不足：標成 thin，**不給區間** ─────────────────────
  //
  // 這裡刻意不回一個「寬一點的區間」。一個由先驗決定寬度的區間，
  // 對每一位只考過一兩次而級分相同的學生都是同一個數字——它看起來
  // 是針對他的預測，實際上與他這個人無關。門檻的理由見
  // `THIN_MIN_RECORDS` 的註解。
  if (rows.length < THIN_MIN_RECORDS) {
    return {
      subjectCode,
      available: true,
      thin: true,
      reason:
        `這一科只有 ${rows.length} 次級分記錄，**資料不足，預測不可靠**。` +
        `至少要 ${THIN_MIN_RECORDS} 次才算得出你自己的成績波動有多大——` +
        `${rows.length === 1 ? '一次' : '兩次'}的資料算不出波動，` +
        '硬給一個區間的話，那個寬度來自預設值而不是你的成績。',
      interval: null,
      distribution: null,
      basis: {
        ...emptyBasis,
        nEff: round(nEff, 3),
        weightedMean: round(weightedMean, 3),
        anchorDate: anchorDate.toISOString(),
        monthsToExam: round(monthsToExam, 2),
        sources: sourceMix(rows, weights, sumW),
      },
      notes: [],
    };
  }

  // ── 一、離散程度 ──────────────────────────────────────────
  const ss = rows.reduce((acc, r, i) => acc + weights[i] * (r.grade - weightedMean) ** 2, 0);
  // 加權的無偏變異數。nEff 剛好 1 時分母會是 0，但這裡 rows.length >= 3
  // 而權重是連續衰減的，nEff 不會低於 1；仍然夾一下，因為「除以 0 得到
  // Infinity 然後區間變成 0 至 15」是一個看起來很正常的畫面。
  const varObs = nEff > 1 ? ss / sumW / (1 - 1 / nEff) : PRIOR_SD ** 2;
  const dfObs = Math.max(0, nEff - 1);
  // 往先驗收縮。兩次剛好同分算出 0 的那一次，這一行就是它的下限。
  const varShrunk = (dfObs * varObs + PRIOR_DF * PRIOR_SD ** 2) / (dfObs + PRIOR_DF);
  // **預測區間而不是平均數的標準誤**：要預測的是下一次的一個觀測值。
  const varDisp = varShrunk * (1 + 1 / nEff);

  // ── 二、三、來源帶進來的：難度差異與級距 ──────────────────
  let varDiff = 0;
  let varScale = 0;
  for (const [i, r] of rows.entries()) {
    const u = sourceUncertaintyOf(r.source);
    varDiff += (weights[i] / sumW) * u.difficulty ** 2;
    varScale += (weights[i] / sumW) * u.scale ** 2;
  }

  // ── 四、剩餘時間 ──────────────────────────────────────────
  const varDrift = (DRIFT_SD_PER_SQRT_MONTH ** 2) * monthsAhead;

  const sdDown = Math.sqrt(varDisp + varDiff + varScale + varDrift);
  const skew = Math.min(SKEW_MAX, SKEW_PER_MONTH * monthsAhead);
  const sdUp = sdDown * (1 + skew);

  // ── 趨勢：收縮後的斜率 ────────────────────────────────────
  const slope = weightedSlope(rows, weights, anchorMs);
  const k = nEff > 2 ? (nEff - 2) / (nEff - 2 + SLOPE_SHRINK) : 0;
  // 掌握度的趨勢只微調先驗，不碰他自己的斜率——兩者不同尺度。
  const prior =
    PRIOR_DRIFT_PER_MONTH *
    (Number.isFinite(abilityTrend) ? clamp(1 + Number(abilityTrend), 0.5, 1.5) : 1);
  const perMonth = slope === null ? prior : k * slope + (1 - k) * prior;
  const improvement = clamp(perMonth * monthsToExam, -MAX_IMPROVEMENT, MAX_IMPROVEMENT);

  const center = clamp(weightedMean + improvement, GRADE_MIN, GRADE_MAX);

  const distribution = discretize(center, sdDown, sdUp);
  const interval = intervalOf(distribution, confidence);

  const notes = [];
  if (monthsAhead >= 3) {
    notes.push(
      `距學測還有約 ${Math.round(monthsAhead)} 個月，所以這個區間比較寬，` +
        '而且**往上的空間比往下多**——剩下的時間裡通常是進步，但那不保證。' +
        '越接近考試，這個區間會越窄。',
    );
  }
  const internalOnly = rows.every((r) => r.source === 'INTERNAL_MOCK');
  if (internalOnly) {
    notes.push(
      '你的級分全部來自校內模考。校內到考人數不足時**級距本身就不可靠**' +
        '（級距是前 1% 考生的平均原始分除以 15，幾十人的模考前 1% 只有一個人），' +
        '所以這個區間比有全國模考成績的同學寬。有南模或全模的成績就補進來。',
    );
  }
  if (interval.widened) {
    notes.push(
      '這個區間被加寬到至少兩級。理由是「預估 12 至 12 級分」讀起來就是一個' +
        '確定的數字，而級分預測不該給確定的數字——加寬之後旁邊的信心水準也' +
        '跟著提高，那才是誠實的說法。',
    );
  }

  return {
    subjectCode,
    available: true,
    thin: false,
    reason: '',
    interval,
    distribution,
    notes,
    basis: {
      ...emptyBasis,
      nEff: round(nEff, 3),
      /**
       * **這一欄不要印在學生的畫面上。** 它是一個單一級分數字，而規格書
       * §6.3 明文要求介面上不存在呈現單一級分數字的路徑。它留在這裡是
       * 為了校準與稽核（「上週的區間怎麼跟這週不一樣」要答得出來），
       * `predictDb.ts` 的學生投影會把它濾掉。
       */
      center: round(center, 3),
      weightedMean: round(weightedMean, 3),
      anchorDate: anchorDate.toISOString(),
      monthsToExam: round(monthsToExam, 2),
      improvement: round(improvement, 3),
      slopePerMonth: slope === null ? null : round(slope, 4),
      slopeWeight: round(k, 3),
      sdDown: round(sdDown, 3),
      sdUp: round(sdUp, 3),
      skew: round(skew, 3),
      /** 四個不確定性來源各自的變異數。合成一個 σ 就分不出誰估錯了。 */
      variance: {
        disp: round(varDisp, 4),
        diff: round(varDiff, 4),
        scale: round(varScale, 4),
        drift: round(varDrift, 4),
      },
      sources: sourceMix(rows, weights, sumW),
      exams: rows.map((r, i) => ({
        examName: r.examName,
        examDate: r.examDate.toISOString().slice(0, 10),
        grade: r.grade,
        source: r.source ?? null,
        weight: round(weights[i] / sumW, 4),
      })),
    },
  };
}

/** 四捨五入到指定位數。分布與區間會被存進 JSON，位數要穩定。 */
function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** 各來源佔的權重。畫面上要說得出「你的資料主要來自哪裡」。 */
function sourceMix(rows, weights, sumW) {
  const acc = new Map();
  for (const [i, r] of rows.entries()) {
    const key = r.source ?? 'UNKNOWN';
    acc.set(key, (acc.get(key) ?? 0) + weights[i] / sumW);
  }
  return [...acc.entries()]
    .map(([source, share]) => ({
      source,
      label: sourceUncertaintyOf(source).label,
      share: round(share, 3),
      count: rows.filter((r) => (r.source ?? 'UNKNOWN') === source).length,
    }))
    .sort((a, b) => b.share - a.share);
}

/**
 * 加權最小平方的斜率（級分／月）。回 null 代表算不出來
 * （所有考試同一天，或只有一筆）。
 *
 * x 以加權平均時點為原點，所以 Σwx = 0，斜率就是 Sxy / Sxx——
 * 而加權平均本身就是這條線在原點的值。這個對齊不是為了少寫兩行，
 * 是為了讓「加權平均」與「斜率」講的是同一條線上的兩件事。
 */
function weightedSlope(rows, weights, anchorMs) {
  let sxx = 0;
  let sxy = 0;
  for (const [i, r] of rows.entries()) {
    const x = (r.examDate.getTime() - anchorMs) / DAY_MS / DAYS_PER_MONTH;
    sxx += weights[i] * x * x;
    sxy += weights[i] * x * r.grade;
  }
  if (!(sxx > 1e-9)) return null;
  return sxy / sxx;
}

/**
 * 把連續分布切成 16 個級分的機率。
 *
 * 兩端**把尾巴的機率全部收進端點的 bin**（0 級分收 −∞ 到 0.5，
 * 15 級分收 14.5 到 +∞），而不是切掉再正規化。理由是級分真的有界：
 * 一位期望值 14.5 的學生的確有很大的機會考 15，而他不可能考 16。
 * 切掉再正規化會把那份機率平均攤回中間，於是高分群的區間會被
 * 往下拉——而受影響的正是最可能拿這個數字去填志願的那幾個學生。
 */
export function discretize(center, sdDown, sdUp) {
  const out = [];
  let acc = 0;
  for (let g = GRADE_MIN; g <= GRADE_MAX; g += 1) {
    const lo = g === GRADE_MIN ? 0 : splitNormalCdf(g - 0.5, center, sdDown, sdUp);
    const hi = g === GRADE_MAX ? 1 : splitNormalCdf(g + 0.5, center, sdDown, sdUp);
    const p = Math.max(0, hi - lo);
    acc += p;
    out.push({ grade: g, p });
  }
  // 浮點數的殘差。正規化之後每一個 bin 才對得起來，而區間的覆蓋率
  // 直接由它們相加算出——差 1e-9 不影響顯示，但會讓「覆蓋率剛好
  // 等於 0.7」的測試變成一個要調容差的測試。
  return out.map((x) => ({ grade: x.grade, p: round(acc > 0 ? x.p / acc : 0, 6) }));
}

/**
 * 覆蓋率至少 `target` 的**最短連續區間**，以及它真正達到的覆蓋率。
 *
 * # 為什麼是「最短連續」而不是機率最高的幾個級分
 *
 * 因為後者可能不連續（雙峰時會挑出 10 與 13 而跳過 11、12），而
 * 「10 到 13 級分」與「10 或 13 級分」在畫面上長得一樣但意思完全不同。
 * 16 個級分的全部區間只有 136 種，直接全找一遍，不需要近似。
 *
 * # 為什麼不允許寬度 1 的區間
 *
 * 「預估 12 至 12 級分」是一個單一數字換了寫法，而規格書 §6.3 要求
 * 介面上**不存在**呈現單一級分數字的路徑。所以命中時往機率大的
 * 一側加寬一級，並回報加寬後真正的覆蓋率——區間變寬、信心跟著變高，
 * 兩個數字仍然是同一件事的兩面，沒有任何東西被美化。
 */
export function intervalOf(distribution, target = DEFAULT_CONFIDENCE) {
  const p = distribution.map((d) => d.p);
  const n = p.length;
  const want = clamp(Number(target) || DEFAULT_CONFIDENCE, 0.5, MAX_CONFIDENCE);

  let best = null;
  for (let lo = 0; lo < n; lo += 1) {
    let acc = 0;
    for (let hi = lo; hi < n; hi += 1) {
      acc += p[hi];
      if (acc + 1e-9 < want) continue;
      const width = hi - lo;
      if (best === null || width < best.width || (width === best.width && acc > best.cov)) {
        best = { lo, hi, width, cov: acc };
      }
      break; // 同一個 lo 再往右只會更寬
    }
  }
  // 一個分布不可能連 0 到 15 都湊不到 want（總和是 1），但別讓
  // 浮點數的殘差把這裡變成 null 然後在頁面上炸掉。
  if (best === null) best = { lo: 0, hi: n - 1, width: n - 1, cov: 1 };

  let { lo, hi, cov } = best;
  let widened = false;
  if (lo === hi) {
    widened = true;
    const up = hi + 1 < n ? p[hi + 1] : -1;
    const down = lo - 1 >= 0 ? p[lo - 1] : -1;
    if (up >= down) hi += 1;
    else lo -= 1;
    cov = p.slice(lo, hi + 1).reduce((a, b) => a + b, 0);
  }

  return {
    low: distribution[lo].grade,
    high: distribution[hi].grade,
    // 夾在 MAX_CONFIDENCE 以下，理由見那個常數的註解（資料庫也擋 1）。
    confidence: Math.min(MAX_CONFIDENCE, round(cov, 2)),
    widened,
  };
}

/**
 * 六科（或任意一組科目）一次算完。
 *
 * @param {{
 *   records: {subjectCode: string, examDate: Date|string, grade: number, source?: string, examName?: string}[],
 *   subjectCodes?: string[],
 *   targetYear?: number, examDate?: Date|string|null, now?: Date,
 *   confidence?: number,
 *   abilityTrend?: Record<string, number>,
 * }} input
 *   `subjectCodes` 沒給時只算有記錄的科目。給了的話，沒有記錄的科目
 *   也會回一列（`available: false`）——**這是刻意的**：畫面上要看得出
 *   「這一科你還沒輸入成績」，而不是那一科靜靜地不見。
 */
export function predictAll({
  records = [],
  subjectCodes = null,
  targetYear = null,
  examDate = null,
  now = new Date(),
  confidence = DEFAULT_CONFIDENCE,
  abilityTrend = {},
} = {}) {
  const bySubject = new Map();
  for (const r of records) {
    const code = String(r?.subjectCode ?? '');
    if (!code) continue;
    const list = bySubject.get(code) ?? [];
    list.push(r);
    bySubject.set(code, list);
  }

  const codes = subjectCodes ?? [...bySubject.keys()].sort();
  return codes.map((code) =>
    predictGrade({
      subjectCode: code,
      records: bySubject.get(code) ?? [],
      targetYear,
      examDate,
      now,
      confidence,
      abilityTrend: abilityTrend?.[code] ?? null,
    }),
  );
}

/**
 * 把預測折成落點模擬吃得下的形狀：**逐科的邊際分布**。
 *
 * 規格書 §6.1 的最後一句：「下游的落點模擬直接使用這個分布而非點估計
 * ——用點估計去算落點會嚴重低估風險。」這一支就是那個接口，而它
 * 刻意只回分布：**沒有一個「預估級分」欄位可以被誤用。**
 *
 * `thin` 的科目不會出現在回傳裡。那不是遺漏，是下游要看得出「這一科
 * 沒有可用的分布」然後把用到它的志願標成無法估計——用一個先驗寬度
 * 的假分布去抽樣，會算出一個看起來正常的機率。
 */
export function marginalsFor(predictions) {
  const out = {};
  for (const p of predictions) {
    if (!p.available || p.thin || !p.distribution) continue;
    out[p.subjectCode] = p.distribution;
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════
// §5 校準（規格書 §6.2）
//
// 「一個不追蹤自己準確度的預測系統只是在製造好看的數字。」
//
// 這一節算的是：所有被預測為「信心 70%」的區間裡，實際落在區間內的
// 比例是不是接近 70%。低於太多代表過度自信（區間太窄），高於太多
// 代表過度保守（區間太寬，等於什麼都沒說）。**兩邊都要報。**
// ═════════════════════════════════════════════════════════════════

/**
 * 信心水準的分組。
 *
 * 分組而不是逐一比對，是因為離散的級分讓實際的信心散在 0.68、0.71、
 * 0.76 這種值上——逐值分組的話每一組只有一兩筆，什麼都看不出來。
 * 邊界是左閉右開，最後一組右閉。
 */
export const CALIB_BANDS = Object.freeze([
  Object.freeze({ low: 0.5, high: 0.6, label: '50–60%' }),
  Object.freeze({ low: 0.6, high: 0.7, label: '60–70%' }),
  Object.freeze({ low: 0.7, high: 0.8, label: '70–80%' }),
  Object.freeze({ low: 0.8, high: 0.9, label: '80–90%' }),
  Object.freeze({ low: 0.9, high: 1.0, label: '90% 以上' }),
]);

/**
 * 一組少於這麼多筆就不下結論。
 *
 * 10 不是統計上的門檻（Wilson 區間那一條才是），它是**顯示上的**門檻：
 * 一組三筆資料算出來的「命中率 33%」會被讀成一個結論，而它只是三次
 * 拋硬幣。低於這個數的組照樣列出來，但標成「樣本太少」。
 */
export const CALIB_MIN_N = 10;

/**
 * 偏離多少才算明顯。規格書 §6.3 的例子：70% 區間的實際命中率低於 55%
 * 時告警——0.70 − 0.15 = 0.55，所以這個數字就是 0.15。
 */
export const CALIB_ALERT_MARGIN = 0.15;

/**
 * Wilson 分數區間（95%）。
 *
 * 用它而不是命中率的點估計去判斷偏離，是這一節唯一重要的實作決定。
 * 第一屆只有十幾筆資料，點估計會在 0.4 與 0.9 之間亂跳，於是告警
 * 天天亮——然後那個告警會被關掉，而它是這整套東西唯一的品質訊號。
 *
 * Wilson 而不是常態近似，因為 k=0 或 k=n 時常態近似的區間寬度是 0。
 */
export function wilsonInterval(k, n, z = 1.96) {
  if (!(n > 0)) return { low: 0, high: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const hw = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, c - hw), high: Math.min(1, c + hw) };
}

/**
 * 校準曲線。
 *
 * @param {{intervalLow: number, intervalHigh: number, confidence: number,
 *   actualGrade?: number|null, subjectCode?: string, targetYear?: number}[]} rows
 *   `GradePrediction` 的列。**還沒回填 `actualGrade` 的不算**，但要
 *   數出來——「這一屆還有 120 筆等成績」與「這一屆只有 8 筆」是兩件
 *   完全不同的事，而它們的曲線長得一樣。
 * @param {{minN?: number, margin?: number}} [opts]
 */
export function calibrationCurve(rows = [], { minN = CALIB_MIN_N, margin = CALIB_ALERT_MARGIN } = {}) {
  const scored = [];
  let pending = 0;
  let malformed = 0;

  for (const r of rows) {
    const lo = Number(r?.intervalLow);
    const hi = Number(r?.intervalHigh);
    const c = Number(r?.confidence);
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || !(c > 0) || !(c < 1) || hi < lo) {
      malformed += 1;
      continue;
    }
    if (r?.actualGrade === null || r?.actualGrade === undefined) {
      pending += 1;
      continue;
    }
    const a = Number(r.actualGrade);
    if (!Number.isInteger(a)) {
      malformed += 1;
      continue;
    }
    scored.push({ lo, hi, c, hit: a >= lo && a <= hi, actual: a, subjectCode: r.subjectCode ?? null });
  }

  const bands = CALIB_BANDS.map((b, i) => {
    const last = i === CALIB_BANDS.length - 1;
    const mine = scored.filter((s) => s.c >= b.low && (last ? s.c <= b.high : s.c < b.high));
    const n = mine.length;
    const hit = mine.filter((s) => s.hit).length;
    const hitRate = n > 0 ? hit / n : null;
    // 「應該命中幾成」用的是這一組**實際的**信心水準平均，不是組的
    // 中點。一組裡全部是 0.71 時，拿 0.75 去比就是拿一個不存在的
    // 承諾去比一個真的結果。
    const expected = n > 0 ? mine.reduce((a, s) => a + s.c, 0) / n : null;
    const wilson = wilsonInterval(hit, n);

    let alert = null;
    if (n >= minN && hitRate !== null && expected !== null) {
      if (hitRate < expected - margin && wilson.high < expected) {
        alert = {
          severity: 'OVERCONFIDENT',
          text:
            `這一組宣稱的信心是 ${pct(expected)}，實際只有 ${pct(hitRate)} 落在區間裡` +
            `（${hit} / ${n}）。**區間開得太窄**——學生看到的信心比它真正值的高，` +
            '而他會照著它決定要不要拚一個志願。',
        };
      } else if (hitRate > expected + margin && wilson.low > expected) {
        alert = {
          severity: 'OVERCAUTIOUS',
          text:
            `這一組宣稱的信心是 ${pct(expected)}，實際有 ${pct(hitRate)} 落在區間裡` +
            `（${hit} / ${n}）。**區間開得太寬**——這不會害到人，但一個寬到` +
            '什麼都包得住的區間等於什麼都沒說，學生會學會忽略它。',
        };
      }
    }

    return {
      ...b,
      n,
      hit,
      hitRate: hitRate === null ? null : round(hitRate, 4),
      expected: expected === null ? null : round(expected, 4),
      gap: hitRate === null ? null : round(hitRate - expected, 4),
      wilsonLow: round(wilson.low, 4),
      wilsonHigh: round(wilson.high, 4),
      /** 樣本太少，列出來但不下結論。 */
      thin: n < minN,
      alert,
    };
  });

  const n = scored.length;
  const hit = scored.filter((s) => s.hit).length;
  const expected = n > 0 ? scored.reduce((a, s) => a + s.c, 0) / n : null;

  return {
    /** 已經有實際成績、算得進曲線的筆數。 */
    scored: n,
    /** 還在等學測成績回填的筆數。**這個數字要跟曲線一起顯示。** */
    pending,
    /** 區間或信心壞掉的列。應該永遠是 0（資料庫有 CHECK），不是 0 就要查。 */
    malformed,
    totals: {
      n,
      hit,
      hitRate: n > 0 ? round(hit / n, 4) : null,
      expected: expected === null ? null : round(expected, 4),
      gap: n > 0 && expected !== null ? round(hit / n - expected, 4) : null,
    },
    bands,
    alerts: bands.filter((b) => b.alert).map((b) => ({ band: b.label, ...b.alert })),
    /**
     * 這一份資料值不值得看。
     *
     * 一屆的六科乘上幾十位學生大約是幾百筆，但**第一年只有一屆**，
     * 而且要等到三月成績公布才有。所以先講清楚現在能不能下結論，
     * 不然第一次打開這一頁的人會照著 8 筆資料調參數。
     */
    verdict:
      n === 0
        ? pending > 0
          ? `還沒有任何一筆回填實際成績（有 ${pending} 筆在等）。校準曲線要等學測成績公布之後才算得出來。`
          : '還沒有任何預測記錄。'
        : n < minN
          ? `只有 ${n} 筆已回填的預測，還下不了結論。一組至少要 ${minN} 筆才看得出偏離，` +
            '而累積一屆完整資料通常是幾百筆。'
          : `${n} 筆已回填，整體命中率 ${pct(hit / n)}，宣稱的平均信心 ${pct(expected)}。` +
            (bands.some((b) => b.alert?.severity === 'OVERCONFIDENT')
              ? '**有一組明顯過度自信，見下面的告警。**'
              : '各組沒有明顯偏離。'),
  };
}

const pct = (v) => `${Math.round(v * 100)}%`;
