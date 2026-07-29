/**
 * 學測級分與五標的換算。**純函式、零相依。**
 *
 * 官方定義（文件 A.2）：
 *
 *   級距 L = 該科到考考生原始總分**前百分之一**考生的平均原始總分 ÷ 15，
 *            計算至小數第五位、第六位四捨五入。
 *   對照   原始分 0 分即 0 級分；`0 < X ≦ L` 為 1 級分，逐級遞增；
 *          `14L < X ≦ 滿分` 為 15 級分。
 *
 * 也就是 `級分 = min(15, ceil(X / L))`。
 *
 * # 為什麼 min(15, …) 那一項一定要在
 *
 * L 是**前 1% 的平均分**除以 15，而前 1% 的平均分必然低於滿分，
 * 所以 `15L < 滿分` 恆成立。高分群的 X 超過 15L 是常態，此時
 * `ceil(X / L)` 會算出 16、17。照著定義敘述「逐級遞增」寫下來就會
 * 踩到，而且**只有最高分的那幾個學生會中**——他們最可能拿去
 * 做升學決策，也最可能相信這個數字。
 *
 * # 為什麼 ceil 要帶一個 epsilon
 *
 * 分界點 `X = 3L` 依定義是 3 級分（區間右閉）。但 L 是小數，
 * `3 * 4.53333 / 4.53333` 在浮點數下可能是 `3.0000000000000004`，
 * `ceil` 之後變成 4 級分。這種錯只在特定數值上出現，而且是**多給**
 * 一級——不會有人來申訴，所以它會一直在。
 *
 * # 小樣本
 *
 * 校內模擬考 80 人，前 1% 不到 1 個人，算出來的級距是那一個人的
 * 分數除以 15。他那天狀況好不好會決定全班的級分。三層策略見
 * `gsatLevels()`，而**估計值一定要標示成估計值**——給出一個不可靠
 * 的級分，學生會當真並據以填志願，那比不給更糟。
 */

/**
 * 各科學測滿分。**社會 144、自然 128，不是 100**（文件 A.1）。
 *
 * 這份表是 `Subject.gsatFullScore` 沒設定時的後備，不是權威——
 * 權威是資料庫那一欄，因為滿分是可能改的（111 學年度數學才拆成
 * A、B 兩科）。這裡列出來是為了讓「忘記設定」不會安靜地變成 100。
 */
export const GSAT_FULL_SCORE = Object.freeze({
  CHINESE: 100,
  ENGLISH: 100,
  MATH_A: 100,
  MATH_B: 100,
  SOCIAL: 144,
  SCIENCE: 128,
});

/** 級分制的上限。學測 15 級分；分科測驗是 60（文件 A.3）。 */
export const GSAT_MAX_LEVEL = 15;

/**
 * 可靠地算級距所需的最少到考人數（文件 01 第 10.3 節，暫定 300）。
 * 300 人時前 1% 是 3 個人——已經很少，但至少不是 1 個人。
 */
export const MIN_COHORT = 300;

/**
 * 這一科滿分幾分。
 *
 * **查不到就回 null，絕不預設 100。** 用 100 當預設值的話，社會科
 * 全班的得分率會變成 144/100 = 144%，而級分換算會全部偏高——
 * 而且畫面上不會有任何地方看起來不對。
 *
 * @param {{code?: string, parentCode?: string|null, gsatFullScore?: number|null}|string} subject
 * @returns {number|null}
 */
export function fullScoreFor(subject) {
  if (subject && typeof subject === 'object') {
    const v = Number(subject.gsatFullScore);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const code = typeof subject === 'string' ? subject : subject?.code;
  const direct = GSAT_FULL_SCORE[String(code ?? '').toUpperCase()];
  if (direct) return direct;
  // 化學、物理這類分科沒有自己的學測滿分，看它屬於哪一張合科考卷。
  const parent = typeof subject === 'object' ? subject?.parentCode : null;
  return GSAT_FULL_SCORE[String(parent ?? '').toUpperCase()] ?? null;
}

/** 四捨五入到小數第五位（官方對級距的規定）。 */
function round5(x) {
  return Math.round((x + Number.EPSILON) * 1e5) / 1e5;
}

/** 只留下真的有成績的人。缺考不計入級距與五標（官方定義）。 */
function presentScores(scores) {
  return (scores ?? []).filter((s) => typeof s === 'number' && Number.isFinite(s));
}

/**
 * 前 1% 考生的平均原始總分。
 *
 * **同分的人一起算。** 300 人取前 3 名，若第 3、4 名同分，取 4 個人。
 * 不這樣做的話，兩個一模一樣的分數會有一個被算進去、一個沒有，
 * 而誰被算到取決於排序的穩定性——那是不能對學生解釋的東西。
 *
 * @returns {{mean:number, count:number, cutoff:number, nominal:number}|null}
 */
export function topOnePercentMean(scores) {
  const values = presentScores(scores);
  const n = values.length;
  if (n === 0) return null;
  const sorted = [...values].sort((a, b) => b - a);
  const nominal = Math.max(1, Math.ceil(n / 100));
  const cutoff = sorted[nominal - 1];
  const top = sorted.filter((s) => s >= cutoff);
  const mean = top.reduce((a, b) => a + b, 0) / top.length;
  return { mean, count: top.length, cutoff, nominal };
}

/**
 * 級距 L。回 null 代表算不出來（沒有人到考、或前 1% 平均是 0）。
 *
 * @param {number[]} scores 該科到考考生的原始總分
 * @param {number} [maxLevel] 級分制的上限。學測 15、分科 60。
 */
export function levelInterval(scores, maxLevel = GSAT_MAX_LEVEL) {
  const top = topOnePercentMean(scores);
  if (!top || !(top.mean > 0)) return null;
  return round5(top.mean / maxLevel);
}

/**
 * 原始分數換成級分：`min(maxLevel, ceil(X / L))`。
 *
 * @param {number} raw 原始分數
 * @param {number} interval 級距 L
 * @param {number} [maxLevel] 上限。**這個截斷不是保險，是定義的一部分。**
 * @returns {number|null} null 代表級距無效，算不出級分
 */
export function toLevel(raw, interval, maxLevel = GSAT_MAX_LEVEL) {
  if (!Number.isFinite(raw) || !Number.isFinite(interval) || interval <= 0) return null;
  if (raw <= 0) return 0; // 「原始分 0 分即 0 級分」；負分不存在，但也歸 0
  // 1e-9：分界點 X = kL 依定義屬於第 k 級（區間右閉）。見檔頭。
  const level = Math.ceil(raw / interval - 1e-9);
  return Math.min(maxLevel, Math.max(0, level));
}

/**
 * 級分對照表：每一級對應的原始分區間。老師會拿它跟大考中心的
 * 對照表核對，所以區間的開閉要與官方一致（左開右閉）。
 *
 * @returns {{level:number, from:number, to:number}[]} from 是「大於」，to 是「小於等於」
 */
export function levelTable(interval, fullScore, maxLevel = GSAT_MAX_LEVEL) {
  if (!Number.isFinite(interval) || interval <= 0) return [];
  const rows = [{ level: 0, from: -Infinity, to: 0 }];
  for (let i = 1; i <= maxLevel; i++) {
    const from = round5(interval * (i - 1));
    const to = i === maxLevel ? (Number.isFinite(fullScore) ? fullScore : Infinity) : round5(interval * i);
    rows.push({ level: i, from, to });
  }
  return rows;
}

/**
 * 累計百分比：不高於這個分數的人佔多少（大考中心的「累計人數百分比」）。
 * 五標的定義建立在它上面，所以兩者用同一個慣例。
 */
export function percentileOf(scores, value) {
  const values = presentScores(scores);
  if (values.length === 0) return null;
  const atOrBelow = values.filter((s) => s <= value).length;
  return Math.round((atOrBelow / values.length) * 1000) / 10;
}

/** 第 p 百分位數的人是誰（最近排名法）。 */
function valueAtPercentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const rank = Math.max(1, Math.min(n, Math.ceil((p / 100) * n)));
  return sortedAsc[rank - 1];
}

/**
 * 一整群人的級分換算，含小樣本的三層策略（文件 03 第 6.4 節）。
 *
 *   到考 ≥ minCohort            → `COHORT`：用本次分布算級距
 *   人數不足但有歷史錨定級距    → `HISTORICAL_ANCHOR`：**估計值**
 *   兩者皆無                    → `UNAVAILABLE`：不給級分，改給百分位
 *
 * 最後那一條是刻意的。校內模擬考 30 個人算出來的級分不是「比較不準」，
 * 而是沒有意義——前 1% 是 1 個人，級距等於那個人的分數除以 15。
 *
 * @param {number[]} scores 原始總分（缺考傳 null 或直接不放進來）
 * @param {{minCohort?:number, anchorInterval?:number|null,
 *          difficultyFactor?:number, maxLevel?:number}} [opts]
 *   anchorInterval：歷史錨定級距（例如該科最近一次全國學測的實際級距）
 *   difficultyFactor：本次與歷史的難度調整係數，由共同題表現比較得出。
 *     大於 1 代表本次較簡單（同樣的原始分要打折）。
 */
export function gsatLevels(scores, opts = {}) {
  const {
    minCohort = MIN_COHORT,
    anchorInterval = null,
    difficultyFactor = 1,
    maxLevel = GSAT_MAX_LEVEL,
  } = opts;

  const all = scores ?? [];
  const values = presentScores(all);
  const cohortSize = values.length;
  const absent = all.length - cohortSize;
  const sortedAsc = [...values].sort((a, b) => a - b);

  const withPercentile = (interval) =>
    values.map((score) => ({
      score,
      level: interval === null ? null : toLevel(score, interval, maxLevel),
      percentile: percentileOf(values, score),
    }));

  if (cohortSize >= minCohort) {
    const interval = levelInterval(values, maxLevel);
    if (interval !== null) {
      return {
        method: 'COHORT',
        estimated: false,
        interval,
        cohortSize,
        absent,
        maxLevel,
        levels: withPercentile(interval),
        sortedAsc,
        note: `依本次到考 ${cohortSize} 人的分布計算，級距 ${interval}。`,
      };
    }
  }

  if (Number.isFinite(anchorInterval) && anchorInterval > 0) {
    const factor = Number.isFinite(difficultyFactor) && difficultyFactor > 0 ? difficultyFactor : 1;
    const interval = round5(anchorInterval * factor);
    return {
      method: 'HISTORICAL_ANCHOR',
      estimated: true,
      interval,
      cohortSize,
      absent,
      maxLevel,
      levels: withPercentile(interval),
      sortedAsc,
      note:
        `本次到考 ${cohortSize} 人，不足 ${minCohort} 人，` +
        `改用歷史錨定級距 ${anchorInterval}（難度調整 ${factor}）估算，級距 ${interval}。` +
        `**這是估計值**，與正式學測級分不可直接比較。`,
    };
  }

  return {
    method: 'UNAVAILABLE',
    estimated: false,
    interval: null,
    cohortSize,
    absent,
    maxLevel,
    levels: withPercentile(null),
    sortedAsc,
    note:
      `本次到考 ${cohortSize} 人，不足 ${minCohort} 人，也沒有可用的歷史錨定級距，` +
      `因此不換算級分——人數這麼少時前 1% 只有一兩個人，算出來的級距不可靠。` +
      `改看百分位數。`,
  };
}

/**
 * 五標。官方定義：頂標第 88 百分位、前標 75、均標 50、後標 25、
 * 底標 12 的**考生級分**，不含缺考生（文件 A.2）。
 *
 * 受與級分同樣的最小樣本限制——30 個人的「頂標」是第 27 名那個人，
 * 那不是頂標，那是某一個同學。
 *
 * @param {number[]} levels 全班（或全校）的級分
 */
export function fiveStandards(levels, opts = {}) {
  const { minCohort = MIN_COHORT } = opts;
  const values = presentScores(levels);
  const n = values.length;
  if (n === 0) {
    return { available: false, why: '沒有任何成績', cohortSize: 0 };
  }
  if (n < minCohort) {
    return {
      available: false,
      why: `到考 ${n} 人，不足 ${minCohort} 人。五標是全國百分位的概念，人數這麼少時它只是「第幾名的那位同學」。`,
      cohortSize: n,
    };
  }
  const sortedAsc = [...values].sort((a, b) => a - b);
  return {
    available: true,
    cohortSize: n,
    top: valueAtPercentile(sortedAsc, 88), // 頂標
    front: valueAtPercentile(sortedAsc, 75), // 前標
    average: valueAtPercentile(sortedAsc, 50), // 均標
    back: valueAtPercentile(sortedAsc, 25), // 後標
    bottom: valueAtPercentile(sortedAsc, 12), // 底標
  };
}

/**
 * 級分換算策略的中文說法。介面上要講得出為什麼沒有級分。
 * @type {Record<string, string>}
 */
export const METHOD_LABELS = Object.freeze({
  COHORT: '依本次分布計算',
  HISTORICAL_ANCHOR: '歷史錨定（估計值）',
  UNAVAILABLE: '人數不足，不換算級分',
});
