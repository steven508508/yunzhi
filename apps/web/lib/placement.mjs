/**
 * 個人申請第一階段的落點模擬（N2）。
 *
 * # 先把篩選機制搞對，因為規格書第一版在這裡寫錯過（§8.1）
 *
 * 個人申請的篩選標準**不是全國百分位門檻**。簡章分則裡寫的是**篩選
 * 科目的順序與倍率**（「國文 3 倍、英文 2 倍、數學 A 1.5 倍」），篩選
 * 的作法是依序取「招生名額 × 倍率」的人數。這代表**實際的門檻級分是
 * 由該校系當年的報名者池內生決定的**——同一個校系，報名的人強，門檻
 * 就高。分則裡不存在「數學 A 前 30%」這種欄位。
 *
 * 所以「用全國級分累計表把百分比換算成門檻」這條路從一開始就走不通，
 * 因為根本沒有百分比可以換算。這個檔案的基準是**學生自己查來的歷年
 * 實際門檻級分**（`AdmissionReference` 的 `SIEVE_THRESHOLD`），而倍率
 * 與名額在計算裡**完全不出現**——它們是解釋用的，因為歷年門檻已經是
 * 那個過程的結果。倍率唯一的計算用途是驗證它有沒有超過學年度上限
 * （115–116 為 3 倍，117 起 4 倍），那是簡章抄錯的偵測。
 *
 * 全國累計表在本模組有兩個正當用途，但都不是這個：**檢定標準的換算**
 * （五標是全國百分位：頂標 88、前標 75、均標 50、後標 25、底標 12），
 * 以及**跨年度的難度標準化**。第二項這一階段沒做，而它的代價明確地
 * 記在可靠度評分的第四個因子裡（見 `MISSING_YEAR_CALIBRATION`）。
 *
 * # 跨科相關性必須明確建模（§8.2）
 *
 * `predict.mjs` 產出的是**逐科的邊際分布**。六科獨立抽樣會**嚴重低估
 * 多科組合的變異**——而個申的篩選常常用到多科（「國英數自四科總級分」）。
 * 四科獨立時總和的標準差是 2σ；四科完全相關時是 4σ。門檻設在平均之上
 * 兩級的話，這兩個假設算出來的通過率可以差一倍以上。
 *
 * 做法是 Gaussian copula：邊際分布原樣保留（這很重要，它們是校準過的），
 * 只用一個常態的相依結構把六科綁在一起。相關性從**該生歷次模考的科目間
 * 殘差**估出來。
 *
 * ## 為什麼用單因子而不是一般的相關矩陣
 *
 * 因為樣本量。六科有 15 個相關係數，而一位學生手上通常是 4 到 8 次模考
 * ——用 6 個觀測值估 15 個參數，估出來的矩陣**routinely 不是半正定的**，
 * 而 Cholesky 分解在那時候會失敗或算出 NaN。那個失敗的症狀很糟：
 * 抽樣出來的級分全是 NaN，通過率變成 0%，而畫面上是一個看起來很正常的
 * 「衝刺」標記。
 *
 * 單因子模型（`z_s = λ_s F + √(1−λ_s²) ε_s`）只有 6 個參數、**由構造
 * 保證半正定**，而它表達得出「這個學生某次考試整體狀況好」這個真正的
 * 共同因子。代價是它表達不出負相關與異質的結構——而那種結構本來就
 * 估不出來，估不出來的東西不值得表示。
 *
 * 一般的成對相關矩陣仍然照算並回報（那是給人看的、也是快照的一部分），
 * 只是**抽樣用的是從它擬合出來的因子負荷量**。兩者的差距本身就是一個
 * 訊號：差很多代表這位學生的科目結構不是單因子，那時該說的是
 * 「相關性估不準」而不是給一個更精細的數字。
 *
 * # 資料不足時的行為分三檔（§8.4）
 *
 * 可靠度低於 0.4 **不進模擬**，顯示「無法估計」並列出已知的門檻讓學生
 * 自行判斷；0.4 至 0.7 進模擬但強制標「不確定性較高」；高於 0.7 才正常
 * 呈現。**無論哪一種都不用相近校系的數字推估**——那會給出看起來精確
 * 但實際無根據的數字，而學生會照著它決定要不要填。
 *
 * # 第二階段不做任何機率預測（§14）
 *
 * 資料不存在：個申第二階段的錄取分數沒有全國統一表，臺大、政大等校
 * 根本不公布。所以每一個機率旁邊都要帶著 `STAGE_TWO_NOTE`——
 * 「通過第一階段機率 80%」不等於「錄取機率 80%」，而這兩件事在學生
 * 眼裡是同一句話。
 *
 * # 亂數必須可重現
 *
 * 學生會重整頁面。同樣的輸入給出不同的數字，比給出一個保守的數字更糟
 * ——他會一直重整到看到喜歡的那個。所以用固定種子的 PRNG，種子由輸入
 * 本身推出來並寫進 `SimulationRun.input`，而 `Math.random()` 在這個
 * 檔案裡一次都不出現。
 *
 * # 這個檔案與 `adviceGuard.mjs` 怎麼共存
 *
 * 見 §8。一句話：**機率只走確定性的那條路，AI 的文字裡永遠不出現機率。**
 */
// 相對路徑而不是 `@/lib/...`：這個檔案要能被 `node --test` 直接載入。
// 同一個理由見 lib/admissionSources.mjs 的檔頭。
import { normalCdf } from './predict.mjs';
import { sourceTrustOf, stalenessOf } from './admissionRef.mjs';

// ═════════════════════════════════════════════════════════════════
// §1 制度常數
// ═════════════════════════════════════════════════════════════════

/** 個人申請的志願上限。與 `lib/admission.mjs` 的 `APPLY_WISH_LIMIT` 同一件事。 */
export const APPLY_WISH_LIMIT = 6;

/** 規格書 §8.2 指定的抽樣次數。 */
export const DEFAULT_DRAWS = 10_000;

/**
 * 篩選倍率的上限，依學年度切換（規格書 §8.5）。
 *
 * 116 學年度以前是 3 倍，117 學年度起放寬到 4 倍。這個數字不進入任何
 * 機率計算——它只用來檢查學生抄進來的倍率有沒有超出制度可能的範圍，
 * 而抄錯倍率是「他看錯了分則的哪一欄」的訊號。
 */
export function sieveRatioMaxOf(year) {
  const y = Number(year);
  if (!Number.isFinite(y)) return null;
  return y >= 117 ? 4 : 3;
}

/**
 * 五標。定義是全國百分位（文件 A.2），而**它公布出來的形式是級分**
 * ——所以檢定標準「數 A 均標」換算成一個級分門檻要查當年度大考中心
 * 的統計，那是學生自己要查的一項（`admissionSources.mjs` 的
 * `GSAT_STATS` 那一步）。
 *
 * `percentile` 留在這裡是為了畫面上說得出「均標是全國第 50 百分位」，
 * 它不參與計算——**系統沒有全國累計表，所以換算不出來，只能收學生
 * 查到的級分**。
 */
export const FIVE_LEVELS = Object.freeze([
  Object.freeze({ key: 'TOP', label: '頂標', percentile: 88 }),
  Object.freeze({ key: 'FRONT', label: '前標', percentile: 75 }),
  Object.freeze({ key: 'AVERAGE', label: '均標', percentile: 50 }),
  Object.freeze({ key: 'BACK', label: '後標', percentile: 25 }),
  Object.freeze({ key: 'BOTTOM', label: '底標', percentile: 12 }),
]);

const FIVE_BY_LABEL = new Map(FIVE_LEVELS.map((f) => [f.label, f]));

/** 第二階段的說明。**這一段必須跟著每一個機率一起出現。** */
export const STAGE_TWO_NOTE =
  '這個數字是**通過第一階段篩選**的機率，不是錄取機率。通過第一階段只是取得' +
  '參加第二階段（審查資料、面試、筆試）的資格，而**第二階段本系統不做任何機率預測**' +
  '——個人申請第二階段的錄取分數沒有全國統一資料，臺大、政大等校根本不公布。' +
  '「通過第一階段 80%」與「錄取 80%」是兩件完全不同的事。';

/** 風險分層的界線（規格書 §8.3）。 */
export const TIER_SPRINT_MAX = 0.3;
export const TIER_SAFE_MIN = 0.7;

/** 「至少通過一個」低於這個值就主動提示（規格書 §8.5）。 */
export const AT_LEAST_ONE_ALERT = 0.5;

// ═════════════════════════════════════════════════════════════════
// §2 科目文字 → 科目代碼
//
// 學生抄簡章時寫的是中文（「數學A」「國英數自」），而級分分布的鍵是
// `Subject.code`。這一段是那個對照，而它**寧可回「看不懂」也不猜**：
// 猜錯科目的後果是拿英文的分布去比數學的門檻，而畫面上一切正常。
// ═════════════════════════════════════════════════════════════════

/**
 * 全稱與常見簡寫。**順序即比對順序，長的要排前面**——「數學A」必須
 * 比「數學」先比到，否則 `MATH_A` 永遠比不出來。
 */
const SUBJECT_ALIASES = Object.freeze([
  ['MATH_A', ['數學A', '數學a', '數學Ａ', '數A', '數a', '數Ａ']],
  ['MATH_B', ['數學B', '數學b', '數學Ｂ', '數B', '數b', '數Ｂ']],
  ['CHINESE', ['國文', '國語文', '國']],
  ['ENGLISH', ['英文', '英語文', '英語', '英']],
  ['SCIENCE', ['自然', '自']],
  ['SOCIAL', ['社會', '社']],
]);

/** 學測的六個採計科目。落點只看這六科（分科測驗不在個申的篩選裡）。 */
export const GSAT_SUBJECT_CODES = Object.freeze([
  'CHINESE',
  'ENGLISH',
  'MATH_A',
  'MATH_B',
  'SOCIAL',
  'SCIENCE',
]);

export const SUBJECT_LABELS = Object.freeze({
  CHINESE: '國文',
  ENGLISH: '英文',
  MATH_A: '數學A',
  MATH_B: '數學B',
  SOCIAL: '社會',
  SCIENCE: '自然',
});

/** 組合的裝飾字。「國英數自四科總級分」裡真正有意義的只有前四個字。 */
const COMBO_NOISE =
  /總?級分|總分|合計|加總|之和|的和|[一二三四五六兩]科|[1-6]科|以上|門檻|標準|級|分|\s|＋|\+|、|,|，|及|和|與|的/g;

/**
 * 一格篩選科目解析成一個或多個科目代碼。
 *
 * 三種情況：
 *
 *   「數學A」          → 單科
 *   「國英數自總級分」 → 四科的**總級分**（這一格是一個和，不是四關）
 *   「數」             → **看不懂**：分不出數 A 還是數 B
 *
 * 第三種是這一支唯一會回 `ambiguous` 的地方，而它必須回。個申的篩選
 * 常寫「數」，而數 A 與數 B 是兩份不同的卷子、兩個不同的級分——猜一個
 * 的話，一位只考數 B 的學生會被拿去比數 A 的門檻，通過率算出來完全
 * 是另一回事，而畫面上看不出任何異常。
 *
 * @returns {{subjects: string[], combo: boolean, ambiguous: boolean, raw: string}}
 */
export function parseSieveSubject(raw) {
  const text = String(raw ?? '').trim();
  const out = { subjects: [], combo: false, ambiguous: false, raw: text };
  if (!text) return out;

  // 先試單科全稱。整格就是一個科目時，這一步就結束。
  const stripped = text.replace(/\s|級分|門檻|標準/g, '');
  for (const [code, names] of SUBJECT_ALIASES) {
    if (names.includes(stripped)) {
      out.subjects = [code];
      return out;
    }
  }

  // 組合：把裝飾字拿掉之後逐字（或逐個「數A」）吃掉。
  let rest = text.replace(COMBO_NOISE, '');
  const found = [];
  let guard = 0;
  while (rest.length > 0 && guard < 20) {
    guard += 1;
    let hit = false;
    for (const [code, names] of SUBJECT_ALIASES) {
      for (const nm of names) {
        if (rest.startsWith(nm)) {
          found.push(code);
          rest = rest.slice(nm.length);
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    if (hit) continue;
    // 吃不掉的第一個字。「數」在這裡命中——它被 COMBO_NOISE 的 `分`
    // 與 `級` 保護不到，因為它本身就是一個科目的簡寫，只是不完整。
    if (rest.startsWith('數')) {
      out.ambiguous = true;
      return { ...out, subjects: [] };
    }
    return { ...out, subjects: [] };
  }

  if (found.length === 0) return out;
  // 重複的科目（「國國英」）代表抄錯了，不要靜靜去重。
  if (new Set(found).size !== found.length) return { ...out, subjects: [] };
  out.subjects = found;
  out.combo = found.length > 1;
  return out;
}

/**
 * 檢定標準的自由文字解析。
 *
 * 學生在 `AdmissionReference` 的 `QUALIFY` 那一格填的是照簡章抄的字串
 * （既有的介面提示就是這樣寫的：「在校成績前 20%、數A均標、英文前標」）。
 * 這一支把其中的**檢定標準**挑出來。
 *
 * # 為什麼括號裡的級分是必要的
 *
 * 因為「均標」是一個全國百分位，換算成級分要查當年度大考中心的統計，
 * 而**系統沒有那份表也不會去抓**。所以真正能拿來判定的形式是
 * 「數學A 均標(10)」——括號裡那個 10 是學生自己查到的當年度均標級分。
 * 只寫「數A均標」的話，這一支照樣認得出這一條規則，但把它標成
 * `grade: null`，而模擬會說「這一條檢定標準無法判定」**而不是當成通過**。
 *
 * 靜靜當成通過是這一段最糟的一種寫法：一位數 A 只有 7 級分的學生會看到
 * 一個含著「已通過檢定」的通過率，而他連報名的資格都沒有。
 *
 * @returns {{rules: {subjectCode: string, subjectLabel: string, standard: string|null,
 *   standardLabel: string|null, grade: number|null, raw: string}[],
 *   unparsed: string[], ambiguous: string[]}}
 */
export function parseQualifyText(raw) {
  const text = String(raw ?? '');
  const rules = [];
  const unparsed = [];
  const ambiguous = [];

  for (const chunkRaw of text.split(/[、,，;；/]|\s{2,}/)) {
    const chunk = chunkRaw.trim();
    if (!chunk) continue;

    // 在校成績百分比的門檻（「在校成績前 20%」「在校成績達全校前四分之一」）
    // **不是學測檢定標準**，它是繁星那一側的東西，而學生常常把兩者抄在
    // 同一格裡（既有介面的提示就是這樣示範的）。這裡明確跳過而不是當成
    // 看不懂——不跳的話，每一筆 QUALIFY 都會多出一條假的「無法判定」，
    // 而那句話會讓學生去找一個根本不存在的級分。
    if (/在校|百分|%|％/.test(chunk) && !/[頂前均後底]標/.test(chunk)) continue;

    let code = null;
    let alias = '';
    for (const [c, names] of SUBJECT_ALIASES) {
      for (const nm of names) {
        if (chunk.includes(nm) && nm.length > alias.length) {
          code = c;
          alias = nm;
        }
      }
    }
    const std = /[頂前均後底]標/.exec(chunk);
    const num = /(\d+(?:\.\d+)?)\s*級?分?/.exec(chunk.replace(/[（(]|[)）]/g, ' '));

    if (!code) {
      // 「數」但分不出 A/B：這一條要被看見。
      if (/數/.test(chunk) && (std || num)) ambiguous.push(chunk);
      else if (std) unparsed.push(chunk);
      continue;
    }
    if (!std && !num) {
      unparsed.push(chunk);
      continue;
    }

    const level = std ? FIVE_BY_LABEL.get(std[0]) : null;
    const grade = num ? Number(num[1]) : null;
    rules.push({
      subjectCode: code,
      subjectLabel: SUBJECT_LABELS[code] ?? code,
      standard: level?.key ?? null,
      standardLabel: level?.label ?? null,
      // 級分是 0 至 15 的整數。抄成 78（百分制）的那一次要被丟掉，
      // 否則這一條檢定標準永遠不會通過，而通過率會變成 0% 而不是報錯。
      grade: Number.isInteger(grade) && grade >= 0 && grade <= 15 ? grade : null,
      raw: chunk,
    });
  }

  return { rules, unparsed, ambiguous };
}

/** 把檢定標準折成一句人看得懂的話。 */
export function describeQualifyRule(rule) {
  const std = rule.standardLabel ? rule.standardLabel : '';
  const g = rule.grade === null ? '級分不明' : `${rule.grade} 級分以上`;
  return `${rule.subjectLabel}${std ? ` ${std}` : ''}（${g}）`;
}

// ═════════════════════════════════════════════════════════════════
// §3 可重現的亂數
//
// **`Math.random()` 在這個檔案裡一次都不出現。** 學生會重整頁面，而
// 同樣的輸入給出不同的數字比給出一個保守的數字更糟——他會一直重整
// 到看到喜歡的那個，然後照著它決定要不要填。
// ═════════════════════════════════════════════════════════════════

/**
 * 字串折成一個 32 位整數種子（FNV-1a）。
 *
 * 種子由**輸入本身**推出來，所以「同樣的輸入」在定義上就給同樣的
 * 結果，不必依賴呼叫端記得傳同一個種子。而它仍然會被寫進
 * `SimulationRun.input`，因為「輸入本身」包含了門檻資料的更新時間——
 * 資料變了種子就變了，而那時結果**應該**不一樣，只是要說得出為什麼。
 */
export function seedFrom(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32。小、快、週期 2³²，對 10000 次抽樣綽綽有餘。
 *
 * 選它而不是 Mersenne Twister 是因為它是十幾行看得完的程式碼——
 * 這個檔案的正確性靠的是「每一行都讀得懂」，而不是一個標準的名字。
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Box-Muller，**刻意不快取第二個變量**。
 *
 * 快取會讓「抽了幾個常態」與「消耗了幾個亂數」之間出現一個相位，
 * 於是同樣的種子在不同的呼叫順序下給出不同的序列。那是一個只在
 * 「多加一科」或「少一個志願」時才會出現的不可重現，而它會被當成
 * 資料變了。多花一半的亂數換一個不必解釋的性質，很值得。
 */
function normalOf(prng) {
  const u1 = Math.max(1e-12, prng());
  const u2 = prng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** 分布的累積機率。抽樣時做反函數用。 */
function cumulativeOf(distribution) {
  const cum = [];
  let acc = 0;
  for (const d of distribution) {
    acc += d.p;
    cum.push({ grade: d.grade, upTo: acc });
  }
  // 浮點數殘差讓最後一格差一點點到 1，於是 u = 0.9999 會掉出去。
  if (cum.length > 0) cum[cum.length - 1].upTo = 1;
  return cum;
}

/** 反累積：`u` 對到哪一個級分。 */
function quantileOf(cum, u) {
  for (const c of cum) {
    if (u <= c.upTo) return c.grade;
  }
  return cum[cum.length - 1].grade;
}

// ═════════════════════════════════════════════════════════════════
// §4 跨科相關性（§8.2）
// ═════════════════════════════════════════════════════════════════

/**
 * 一對科目至少要在這麼多次**同一場考試**裡同時出現，才用他自己的資料
 * 估相關係數。
 *
 * 4 是「相關係數的估計不再由一個點決定」的最低值：3 個點時任何一個
 * 離群值都會把 r 推到 ±0.9，而 r 是要被平方之後乘進變異數的——
 * 一個假的 0.9 會讓四科總和的變異數多出六成。
 */
export const MIN_PAIRS_FOR_CORR = 4;

/**
 * 估不出來時退回的預設相關係數。
 *
 * # 為什麼是一個正數，而且為什麼 0 才是危險的那個選擇
 *
 * 直覺會覺得「不知道就填 0」比較保守。**在這裡完全相反。** 多科總和的
 * 變異數是 `Σσ² + 2Σρσσ`，所以 ρ 填 0 會把變異數壓到最小，於是門檻
 * 在平均之上時通過率被低估、在平均之下時被高估——兩邊都是**假的精確**。
 * 規格書 §8.2 說的「獨立抽樣會嚴重低估多科組合的變異」講的就是這件事。
 *
 * 0.4 是往「變異大一點」的方向倒的保守值，而它也符合常識：同一位學生
 * 各科的級分本來就正相關（狀況好的那一天每一科都好一點，整體學力也
 * 會同時反映在幾科上）。
 */
export const DEFAULT_CORRELATION = 0.4;

/** 單因子負荷量的上限。1 代表六科完全連動，那不是一個學生。 */
const MAX_LOADING_RHO = 0.9;

/**
 * 從該生歷次模考的**科目間殘差**估相關性。
 *
 * 殘差取的是「這一次的級分 − 這一科自己的平均」。用平均而不是趨勢線，
 * 是因為趨勢線在 4 到 8 個點上本身就不穩，而拿一條不穩的線去算殘差
 * 會把趨勢的估計誤差搬進相關係數裡。
 *
 * 配對的鍵是 `examName`：schema 的唯一鍵是 `[userId, subjectCode, examName]`，
 * 所以同一個 `examName` 就是同一場考試。**這一點很重要**——用日期配對
 * 的話，兩天考完的模考會被拆成兩場，於是同時有兩科成績的場次數掉一半，
 * 相關性直接退回預設值。
 *
 * @param {{records: {subjectCode: string, examName?: string, examDate?: Date|string,
 *   grade: number}[], subjectCodes?: string[], defaultCorrelation?: number}} input
 * @returns {{matrix: object, pairs: object[], loadings: object, source: string,
 *   estimatedPairs: number, totalPairs: number, note: string}}
 */
export function estimateCorrelation({
  records = [],
  subjectCodes = null,
  defaultCorrelation = DEFAULT_CORRELATION,
} = {}) {
  /** examName → { subjectCode: grade } */
  const byExam = new Map();
  const bySubject = new Map();
  for (const r of records) {
    const code = String(r?.subjectCode ?? '');
    const g = Number(r?.grade);
    if (!code || !Number.isFinite(g)) continue;
    const key = String(r?.examName ?? '').trim() || `@${new Date(r?.examDate ?? 0).getTime()}`;
    const row = byExam.get(key) ?? {};
    row[code] = g;
    byExam.set(key, row);
    const list = bySubject.get(code) ?? [];
    list.push(g);
    bySubject.set(code, list);
  }

  const codes = (subjectCodes ?? [...bySubject.keys()]).filter((c) => bySubject.has(c)).sort();
  const mean = new Map(
    [...bySubject.entries()].map(([c, list]) => [c, list.reduce((a, b) => a + b, 0) / list.length]),
  );

  const exams = [...byExam.values()];
  const pairs = [];
  const matrix = {};
  for (const c of codes) matrix[c] = { [c]: 1 };

  let estimated = 0;
  for (let i = 0; i < codes.length; i += 1) {
    for (let j = i + 1; j < codes.length; j += 1) {
      const a = codes[i];
      const b = codes[j];
      const xs = [];
      const ys = [];
      for (const ex of exams) {
        if (!Number.isFinite(ex[a]) || !Number.isFinite(ex[b])) continue;
        xs.push(ex[a] - mean.get(a));
        ys.push(ex[b] - mean.get(b));
      }
      const n = xs.length;
      let r = null;
      if (n >= MIN_PAIRS_FOR_CORR) {
        const sxx = xs.reduce((acc, v) => acc + v * v, 0);
        const syy = ys.reduce((acc, v) => acc + v * v, 0);
        const sxy = xs.reduce((acc, v, k) => acc + v * ys[k], 0);
        // 某一科在這幾場裡級分完全沒變 → 分母 0。那不是「不相關」，
        // 是「算不出來」，所以回 null 而不是 0。
        if (sxx > 1e-9 && syy > 1e-9) {
          r = Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
          estimated += 1;
        }
      }
      const used = r === null ? defaultCorrelation : r;
      matrix[a][b] = round(used, 4);
      matrix[b][a] = round(used, 4);
      pairs.push({
        a,
        b,
        commonExams: n,
        observed: r === null ? null : round(r, 4),
        used: round(used, 4),
        fallback: r === null,
      });
    }
  }

  const totalPairs = (codes.length * (codes.length - 1)) / 2;
  const source = totalPairs === 0 ? 'DEFAULT' : estimated === totalPairs ? 'OWN' : estimated > 0 ? 'MIXED' : 'DEFAULT';

  // ── 單因子負荷量 ──────────────────────────────────────────
  //
  // λ_s = √ρ_s，其中 ρ_s 是這一科與其他科的平均相關係數（負的夾到 0
  // ——單因子表達不出負相關，而硬塞會讓 √ 變成 NaN）。這樣得到的
  // 隱含相關是 √(ρ_s ρ_t)，在各科相關係數相近時剛好還原它們。
  const loadings = {};
  for (const c of codes) {
    const others = codes.filter((o) => o !== c).map((o) => matrix[c][o]);
    const rho = others.length > 0 ? others.reduce((a, b) => a + b, 0) / others.length : 0;
    loadings[c] = round(Math.sqrt(Math.max(0, Math.min(MAX_LOADING_RHO, rho))), 4);
  }

  return {
    matrix,
    pairs,
    loadings,
    source,
    estimatedPairs: estimated,
    totalPairs,
    note:
      source === 'OWN'
        ? `六科之間的相關性用你自己 ${exams.length} 場模考的殘差估出來（${estimated} 對全部估得出來）。`
        : source === 'MIXED'
          ? `${totalPairs} 對科目裡有 ${estimated} 對估得出來，其餘同時有成績的場次不足 ` +
            `${MIN_PAIRS_FOR_CORR} 場，退回保守的預設值 ${defaultCorrelation}。` +
            '**這一層額外的不確定性會反映在下面每一個志願的可靠度上。**'
          : `你的模考場次還不足以估科目之間的相關性（一對科目要同時出現 ${MIN_PAIRS_FOR_CORR} 場以上），` +
            `所以全部用保守的預設值 ${defaultCorrelation}。預設值刻意是一個正數而不是 0：` +
            '獨立抽樣會**低估**多科組合的變異，而低估的方向會讓機率看起來比它該有的樣子更確定。' +
            '**這一層額外的不確定性會反映在下面每一個志願的可靠度上。**',
  };
}

// ═════════════════════════════════════════════════════════════════
// §5 可靠度評分（§8.4）
//
// 四個因子相乘，逐項說得出理由。**相乘而不是相加**是刻意的：任何一項
// 崩掉都會把整體拉下來，而那正是這個評分要表達的事——來源是聽同學說的、
// 或者只有一年的資料，其他項再好也不能讓它變成可以照著做決定的東西。
// ═════════════════════════════════════════════════════════════════

/** 三檔的界線。 */
export const RELIABILITY_FLOOR = 0.4;
export const RELIABILITY_GOOD = 0.7;

export const TIER_NO_ESTIMATE = 'NO_ESTIMATE';
export const TIER_HIGH_UNCERTAINTY = 'HIGH_UNCERTAINTY';
export const TIER_NORMAL = 'NORMAL';

/** 來源信任分（0 至 3）對到的因子。 */
const SOURCE_FACTOR = Object.freeze({ 3: 1, 2: 0.8, 1: 0.55, 0: 0.3 });

/** 過了幾個學年度對到的新鮮度因子。超出陣列長度就用地板值。 */
const FRESHNESS = Object.freeze([1, 0.9, 0.78, 0.62]);
const FRESHNESS_FLOOR = 0.45;

/** 查了超過一年沒再確認。招生資料一年全部重來一次。 */
const STALE_LOOKUP_PENALTY = 0.9;

/**
 * 第四個因子：**校正穩定度**。
 *
 * 文件 07 §4 的第四個因子指的是跨年度難度校正的穩定度，而**這一階段
 * 沒有做那個校正**——它需要大考中心的級分人數累計表（同一個「數學 A
 * 12 級分」在難度不同的兩年代表的相對位置不同），而系統沒有那份資料
 * 也不會去抓。
 *
 * 所以這個因子是一個小於 1 的常數，而它小於 1 的理由**就是那個校正
 * 沒做**。寫成 1.0（等於沒有這個因子）會讓評分看起來比它該有的樣子
 * 更有信心，而那個高出來的部分正好是被省略掉的那一項。
 */
export const MISSING_YEAR_CALIBRATION = 0.9;

/** 相關性退回預設值時的額外折扣（規格書 §8.2 要求反映在信心標示裡）。 */
export const CORR_FALLBACK_PENALTY = 0.9;

/**
 * 一個志願的門檻資料值多少信任。
 *
 * @param {{thresholds: {year: number, staleAfterYear?: number, sourceKind?: string,
 *   lookedUpAt?: Date|string, grades?: number[]}[],
 *   currentYear: number, now?: Date, correlationSource?: string}} input
 */
export function reliabilityOf({ thresholds = [], currentYear, now = new Date(), correlationSource = 'OWN' } = {}) {
  const years = [...new Set(thresholds.map((t) => Number(t.year)).filter(Number.isFinite))].sort(
    (a, b) => b - a,
  );

  if (thresholds.length === 0) {
    return {
      score: 0,
      tier: TIER_NO_ESTIMATE,
      years: [],
      factors: { source: 0, freshness: 0, programStability: 0, yearCalibration: MISSING_YEAR_CALIBRATION },
      notes: [
        '這個志願**還沒有任何一筆歷年篩選門檻**。沒有門檻就沒有可以比的東西，' +
          '所以這裡不會給機率——去委員會的「歷年篩選標準查詢」查，一年一筆輸入進來。',
      ],
    };
  }

  const notes = [];

  // ── 一、來源 ──────────────────────────────────────────────
  //
  // 取**平均**而不是最小值。最小值的意思是「加一筆聽同學說的就毀掉
  // 三筆官方資料」，而那會讓學生不敢輸入他手上真的有的東西——
  // 而不輸入的結果是系統連那一筆都不知道。
  const sourceFactor =
    thresholds.reduce((acc, t) => {
      const trust = sourceTrustOf(t.sourceKind);
      return acc + (SOURCE_FACTOR[trust.trust] ?? SOURCE_FACTOR[0]);
    }, 0) / thresholds.length;
  if (sourceFactor < 0.7) {
    notes.push(
      '這幾筆門檻的來源偏弱（聽說的、或自己記得的）。' +
        '去官方的歷年篩選標準查詢確認過再拿它做決定——那一頁的網址每年重新產生，' +
        '所以要從委員會首頁進去找。',
    );
  }

  // ── 二、新鮮度 ────────────────────────────────────────────
  //
  // 看**最新的那一筆**。歷年門檻本來就都是過去的年度（那是它的用途），
  // 所以重點不是「有沒有過期」而是「最近的那一年離現在多遠」。
  const newest = thresholds
    .slice()
    .sort((a, b) => Number(b.year) - Number(a.year))[0];
  const age = stalenessOf(newest, { currentYear, now });
  let freshness = FRESHNESS[age.staleBy] ?? FRESHNESS_FLOOR;
  if (age.old) {
    freshness *= STALE_LOOKUP_PENALTY;
    notes.push(
      `最新的那一筆是 ${age.ageDays} 天前查的。招生資料一年全部重來一次，值得再確認一次。`,
    );
  }
  if (age.staleBy >= 3) {
    notes.push(
      `最新的門檻是 ${newest.year} 學年度的，距現在 ${age.staleBy} 個學年度。` +
        '個申的門檻由當年報名者決定，三年前的池子與今年不是同一批人。',
    );
  }

  // ── 三、校系穩定度 ────────────────────────────────────────
  //
  // 同一個校系的門檻年年在跳，代表報名者池不穩（新設系、名額大幅變動、
  // 篩選標準改過），而那時歷年資料的參考價值本身就低。用第一個篩選
  // 科目的級分跨年度標準差當代理量——它是每一年都有的那一個數字。
  let programStability;
  if (years.length >= 3) {
    const firsts = thresholds
      .map((t) => Number(t.grades?.[0]))
      .filter((v) => Number.isFinite(v));
    const m = firsts.reduce((a, b) => a + b, 0) / firsts.length;
    const sd =
      firsts.length > 1
        ? Math.sqrt(firsts.reduce((a, v) => a + (v - m) ** 2, 0) / (firsts.length - 1))
        : 0;
    programStability = Math.max(0.4, Math.min(1, 1 - sd / 3));
    if (sd >= 1) {
      notes.push(
        `這個校系的門檻在這 ${years.length} 年裡跳動不小（第一篩選科目的標準差 ` +
          `${round(sd, 2)} 級分）。門檻由當年報名者決定，跳動大代表歷年資料的參考價值低。`,
      );
    }
  } else if (years.length === 2) {
    programStability = 0.85;
    notes.push('只有兩年的門檻。兩點連得出一條線，但看不出那條線是不是真的。');
  } else {
    programStability = 0.6;
    notes.push(
      '只有一年的門檻。一年看不出這個校系的門檻是穩定的還是每年在跳，' +
        '而個申的門檻由當年報名者決定——再查兩年會讓這個估計完全不同。',
    );
  }

  let score = sourceFactor * freshness * programStability * MISSING_YEAR_CALIBRATION;

  if (correlationSource !== 'OWN') {
    score *= CORR_FALLBACK_PENALTY;
    notes.push(
      '科目之間的相關性有一部分（或全部）用的是保守預設值而不是你自己的模考殘差，' +
        '所以多科組合的變異估得比較粗。這一層不確定性已經算進上面的可靠度。',
    );
  }

  score = Math.max(0, Math.min(1, score));
  const tier =
    score < RELIABILITY_FLOOR
      ? TIER_NO_ESTIMATE
      : score < RELIABILITY_GOOD
        ? TIER_HIGH_UNCERTAINTY
        : TIER_NORMAL;

  return {
    score: round(score, 3),
    tier,
    years,
    factors: {
      source: round(sourceFactor, 3),
      freshness: round(freshness, 3),
      programStability: round(programStability, 3),
      yearCalibration: MISSING_YEAR_CALIBRATION,
      correlation: correlationSource === 'OWN' ? 1 : CORR_FALLBACK_PENALTY,
    },
    lookedUpAt: newest.lookedUpAt ? new Date(newest.lookedUpAt).toISOString() : null,
    notes,
  };
}

/** 三檔的中文說法。畫面上要說得出這個標記是什麼意思。 */
export const TIER_LABELS = Object.freeze({
  NO_ESTIMATE: '無法估計',
  HIGH_UNCERTAINTY: '不確定性較高',
  NORMAL: '可以參考',
});

// ═════════════════════════════════════════════════════════════════
// §6 把志願與參考資料折成模擬吃得下的形狀
//
// 這一段是純函式，所以解析錯誤（科目看不懂、級分抄成百分制）在
// 沒有資料庫的情況下就測得出來。資料層只負責把列讀出來丟給它。
// ═════════════════════════════════════════════════════════════════

/**
 * 大學名稱是不是同一所。與 `lib/star.mjs` 的 `sameInstitution` 同一條
 * 規則，但**刻意各寫一份**：那一支被 39 項繁星測試釘著，改動它要動到
 * 那些測試；而這裡若日後要放寬（例如個申要比對到「系」），放寬的是
 * 這一份。只折異體字與空白，**不做模糊比對**——猜對了省一次輸入，
 * 猜錯了把甲校的門檻掛到乙校的志願上，而那個錯誤看不出來。
 */
function sameProgram(a, b) {
  const fold = (s) =>
    String(s ?? '')
      .replace(/[\s　]+/g, '')
      .replace(/臺/g, '台')
      .replace(/國立|私立/g, '');
  return fold(a) === fold(b) && fold(a) !== '';
}

/**
 * 一個志願的規格。
 *
 * @param {{
 *   wishes: {id?: string, rank?: number, channel?: string, institutionName: string,
 *     programName?: string|null}[],
 *   references: {kind: string, year: number, institutionName: string, programName?: string|null,
 *     value: object, sourceKind?: string, lookedUpAt?: Date|string, staleAfterYear?: number}[],
 *   year: number, now?: Date, correlationSource?: string,
 * }} input
 */
export function buildWishSpecs({
  wishes = [],
  references = [],
  year,
  now = new Date(),
  correlationSource = 'OWN',
} = {}) {
  const sieveRefs = references.filter((r) => r.kind === 'SIEVE_THRESHOLD');
  const qualifyRefs = references.filter((r) => r.kind === 'QUALIFY');
  const used = new Set();

  const specs = wishes
    .filter((w) => (w.channel ?? 'APPLY') === 'APPLY')
    .map((w) => {
      const match = (r) =>
        sameProgram(r.institutionName, w.institutionName) &&
        // 系沒填的門檻資料**照樣掛上去**：學生查簡章時常常只記了學校與級分。
        // 掛錯系的風險由畫面上標「這一筆沒有系名」承擔，而漏掉的成本是
        // 他看不到自己剛剛才輸入的東西。
        (!r.programName || !w.programName || sameProgram(r.programName, w.programName));

      const mine = sieveRefs.filter(match).sort((a, b) => Number(b.year) - Number(a.year));
      for (const r of mine) used.add(r);

      const problems = [];

      // ── 篩選：取**最新那一年**的科目順序與門檻 ────────────
      //
      // 不平均、不取最寬鬆的那一年。理由是篩選科目的**順序**是簡章
      // 訂的，而它可能改；把三年的級分平均起來會產生一個沒有任何一年
      // 真的長這樣的門檻，而那個數字看起來比三個真實的數字更精確。
      const latest = mine[0] ?? null;
      const stages = [];
      if (latest) {
        const subjects = Array.isArray(latest.value?.subjects) ? latest.value.subjects : [];
        const grades = Array.isArray(latest.value?.grades) ? latest.value.grades : [];
        const multiples = Array.isArray(latest.value?.multiples) ? latest.value.multiples : [];
        const cap = sieveRatioMaxOf(year);
        for (const [i, raw] of subjects.entries()) {
          const parsed = parseSieveSubject(raw);
          const threshold = Number(grades[i]);
          const multiple = Number.isFinite(Number(multiples[i])) ? Number(multiples[i]) : null;
          if (parsed.ambiguous) {
            problems.push(
              `篩選科目「${raw}」分不出數學A還是數學B。這兩科是兩份不同的卷子、` +
                '兩個不同的級分，猜一個的話通過率算出來完全是另一回事。' +
                '請把那一筆改成「數學A」或「數學B」。',
            );
            continue;
          }
          if (parsed.subjects.length === 0) {
            problems.push(
              `篩選科目「${raw}」看不懂。可以寫「國文」「數學A」這種全稱，` +
                '或「國英數自」這種組合（代表四科總級分）。',
            );
            continue;
          }
          if (!Number.isInteger(threshold) || threshold < 0 || threshold > 15 * parsed.subjects.length) {
            problems.push(
              `「${raw}」對到的門檻「${grades[i]}」不是一個合理的級分` +
                `（${parsed.combo ? `${parsed.subjects.length} 科總級分上限 ${15 * parsed.subjects.length}` : '單科 0 至 15'}）。` +
                '是不是把百分比或原始分數填進來了？',
            );
            continue;
          }
          if (multiple !== null && cap !== null && multiple > cap) {
            problems.push(
              `「${raw}」的倍率 ${multiple} 超過 ${year} 學年度的上限 ${cap} 倍。` +
                '倍率不影響這裡的計算（門檻是查來的實際結果），但超出上限代表' +
                '抄的時候看錯了分則的欄位，那一筆門檻也值得再確認。',
            );
          }
          stages.push({
            label: parsed.combo
              ? `${parsed.subjects.map((c) => SUBJECT_LABELS[c] ?? c).join('＋')} 總級分`
              : (SUBJECT_LABELS[parsed.subjects[0]] ?? parsed.subjects[0]),
            subjects: parsed.subjects,
            combo: parsed.combo,
            threshold,
            multiple,
            raw: String(raw),
          });
        }
      }

      // ── 檢定標準 ──────────────────────────────────────────
      const qRules = [];
      for (const r of qualifyRefs.filter(match)) {
        used.add(r);
        const parsed = parseQualifyText(r.value?.rules);
        qRules.push(...parsed.rules);
        for (const a of parsed.ambiguous) {
          problems.push(
            `檢定標準「${a}」分不出數學A還是數學B，所以這一條沒有檢查。` +
              '請把科目寫成全稱。',
          );
        }
      }
      // 同一科重複時取**最嚴**的那一條：兩筆資料寫了不同的檢定標準，
      // 代表其中一筆抄錯或年度不同，而往嚴的方向倒不會讓學生誤以為
      // 自己過了一個其實沒過的門檻。
      const byCode = new Map();
      for (const r of qRules) {
        const cur = byCode.get(r.subjectCode);
        if (!cur || (r.grade ?? -1) > (cur.grade ?? -1)) byCode.set(r.subjectCode, r);
      }
      const qualify = [...byCode.values()];
      for (const q of qualify) {
        if (q.grade === null) {
          problems.push(
            `檢定標準「${describeQualifyRule(q)}」沒有對應的級分，所以**這一條無法判定**。` +
              '五標（頂標、前標、均標…）是全國百分位，換算成級分要查當年度大考中心的' +
              '統計——系統沒有那份表也不會去抓。查到之後把它寫成「' +
              `${q.subjectLabel} ${q.standardLabel ?? '均標'}(級分)」的形式。`,
          );
        }
      }

      const reliability = reliabilityOf({
        thresholds: mine.map((r) => ({
          year: r.year,
          staleAfterYear: r.staleAfterYear,
          sourceKind: r.sourceKind,
          lookedUpAt: r.lookedUpAt,
          grades: Array.isArray(r.value?.grades) ? r.value.grades.map(Number) : [],
        })),
        currentYear: year,
        now,
        correlationSource,
      });

      return {
        wishId: w.id ?? null,
        rank: w.rank ?? null,
        institutionName: w.institutionName,
        programName: w.programName ?? null,
        stages,
        qualify,
        reliability,
        thresholdYears: mine.map((r) => Number(r.year)),
        thresholdRefs: mine.map((r) => ({
          year: Number(r.year),
          subjects: Array.isArray(r.value?.subjects) ? r.value.subjects.map(String) : [],
          grades: Array.isArray(r.value?.grades) ? r.value.grades.map(Number) : [],
          sourceLabel: sourceTrustOf(r.sourceKind).label,
          lookedUpAt: r.lookedUpAt ? new Date(r.lookedUpAt).toISOString().slice(0, 10) : null,
        })),
        problems,
      };
    })
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

  return {
    specs,
    /**
     * 查到了但對不上任何個申志願的門檻。**要列出來而不是丟掉**：最常見
     * 的原因是他在比較一個還沒填成志願的校系（那是好事），第二常見的是
     * 校名打錯。靜靜吞掉的症狀是「我輸入的資料不見了」。
     */
    unmatched: sieveRefs.filter((r) => !used.has(r)),
  };
}

// ═════════════════════════════════════════════════════════════════
// §7 蒙地卡羅
// ═════════════════════════════════════════════════════════════════

/**
 * 一組六科級分對一個志願的判定。
 *
 * 順序是**先檢定、再篩選**，因為制度上就是這樣：沒過檢定標準連報名
 * 的資格都沒有，篩選是報名之後的事。倒過來寫的話，一位檢定沒過的
 * 學生會看到「你在第 2 關被篩掉」——那句話暗示他過了檢定。
 */
export function evaluateWish(draw, spec) {
  for (const q of spec.qualify) {
    if (q.grade === null) continue; // 無法判定的不當成不通過，但呼叫端要標出來
    const g = draw[q.subjectCode];
    if (!Number.isFinite(g)) return { passed: false, stage: null, why: 'MISSING_SUBJECT' };
    if (g < q.grade) return { passed: false, stage: null, why: 'QUALIFY', rule: q };
  }
  for (const [i, s] of spec.stages.entries()) {
    let value = 0;
    for (const code of s.subjects) {
      const g = draw[code];
      if (!Number.isFinite(g)) return { passed: false, stage: i, why: 'MISSING_SUBJECT' };
      value += g;
    }
    if (value < s.threshold) return { passed: false, stage: i, why: 'SIEVE' };
  }
  return { passed: true, stage: null, why: null };
}

/**
 * 一次落點模擬。
 *
 * @param {{
 *   marginals: Record<string, {grade: number, p: number}[]>,
 *   specs: object[],
 *   correlation?: {loadings?: Record<string, number>, source?: string},
 *   draws?: number, seed?: number|string|null, year: number,
 *   now?: Date, dataAsOf?: Date|string|null,
 * }} input
 */
export function simulatePlacement({
  marginals = {},
  specs = [],
  correlation = null,
  draws = DEFAULT_DRAWS,
  seed = null,
  year,
  now = new Date(),
  dataAsOf = null,
} = {}) {
  const nDraws = Math.max(1, Math.floor(Number(draws) || DEFAULT_DRAWS));
  const loadings = correlation?.loadings ?? {};
  const corrSource = correlation?.source ?? 'DEFAULT';

  // 抽樣要用到的科目：任何一個志願的檢定或篩選提到的。多抽沒有意義，
  // 少抽會讓那個志願變成 MISSING_SUBJECT。
  const needed = new Set();
  for (const s of specs) {
    for (const q of s.qualify) needed.add(q.subjectCode);
    for (const st of s.stages) for (const c of st.subjects) needed.add(c);
  }
  const codes = [...needed].sort();
  const sampleCodes = codes.filter((c) => Array.isArray(marginals[c]) && marginals[c].length > 0);
  const missing = codes.filter((c) => !sampleCodes.includes(c));

  const cum = new Map(sampleCodes.map((c) => [c, cumulativeOf(marginals[c])]));

  // ── 種子 ──────────────────────────────────────────────────
  //
  // 由輸入本身推出來，所以「同樣的輸入」在定義上就給同樣的結果。
  // 快照裡存的是這個數字，重跑時傳回來即可完全重現。
  const fingerprint = JSON.stringify({
    year,
    draws: nDraws,
    codes: sampleCodes,
    marginals: sampleCodes.map((c) => marginals[c].map((d) => d.p)),
    loadings: sampleCodes.map((c) => loadings[c] ?? 0),
    specs: specs.map((s) => [
      s.institutionName,
      s.programName,
      s.stages.map((x) => [x.subjects, x.threshold]),
      s.qualify.map((q) => [q.subjectCode, q.grade]),
    ]),
  });
  const usedSeed = seed === null || seed === undefined ? seedFrom(fingerprint) : seedFrom(String(seed));
  const prng = mulberry32(usedSeed);

  // ── 每個志願的統計 ────────────────────────────────────────
  const estimable = specs.map(
    (s) =>
      s.reliability.tier !== TIER_NO_ESTIMATE &&
      s.stages.length > 0 &&
      [...s.stages.flatMap((x) => x.subjects), ...s.qualify.map((q) => q.subjectCode)].every((c) =>
        sampleCodes.includes(c),
      ),
  );

  const pass = specs.map(() => 0);
  const failQualify = specs.map(() => 0);
  const failStage = specs.map((s) => s.stages.map(() => 0));
  let anyPass = 0;
  const passCountHist = new Array(specs.length + 1).fill(0);

  const draw = {};
  for (let d = 0; d < nDraws; d += 1) {
    // 共同因子：這一次考試這位學生整體的狀況。
    const f = normalOf(prng);
    for (const c of sampleCodes) {
      const lam = Math.max(0, Math.min(1, Number(loadings[c]) || 0));
      const z = lam * f + Math.sqrt(Math.max(0, 1 - lam * lam)) * normalOf(prng);
      draw[c] = quantileOf(cum.get(c), normalCdf(z));
    }

    let passed = 0;
    for (const [i, s] of specs.entries()) {
      if (!estimable[i]) continue;
      const r = evaluateWish(draw, s);
      if (r.passed) {
        pass[i] += 1;
        passed += 1;
      } else if (r.why === 'QUALIFY') {
        failQualify[i] += 1;
      } else if (r.why === 'SIEVE' && r.stage !== null) {
        failStage[i][r.stage] += 1;
      }
    }
    passCountHist[passed] += 1;
    if (passed > 0) anyPass += 1;
  }

  const wishes = specs.map((s, i) => {
    const can = estimable[i];
    const rate = can ? pass[i] / nDraws : null;
    const tier = s.reliability.tier;
    const risk = rate === null ? null : rate < TIER_SPRINT_MAX ? 'SPRINT' : rate > TIER_SAFE_MIN ? 'SAFE' : 'STEADY';
    const notes = [...s.reliability.notes, ...s.problems];

    if (!can) {
      if (s.stages.length === 0) {
        notes.unshift(
          '沒有可用的篩選門檻，所以**無法估計**。這不是還沒算完——' +
            '沒有門檻就沒有可以比的東西。',
        );
      } else if (tier === TIER_NO_ESTIMATE) {
        notes.unshift(
          `這個志願的資料可靠度是 ${s.reliability.score}（低於 ${RELIABILITY_FLOOR}），` +
            '所以**不進入模擬，顯示「無法估計」**。下面列出你已知的門檻供你自己判斷。' +
            '**系統不會拿相近校系的數字推估**——那會給出一個看起來精確但沒有根據的百分比。',
        );
      } else {
        const lack = [
          ...new Set(
            [...s.stages.flatMap((x) => x.subjects), ...s.qualify.map((q) => q.subjectCode)].filter(
              (c) => !sampleCodes.includes(c),
            ),
          ),
        ];
        notes.unshift(
          `這個志願用到 ${lack.map((c) => SUBJECT_LABELS[c] ?? c).join('、')}，` +
            '而這幾科的級分預測**資料不足**（模考次數不夠，見級分預測那一頁）。' +
            '用一個先驗寬度的假分布去抽樣會算出一個看起來正常的機率，所以這裡不算。',
        );
      }
    }

    return {
      wishId: s.wishId,
      rank: s.rank,
      institutionName: s.institutionName,
      programName: s.programName,
      /** 三檔（§8.4）。`NO_ESTIMATE` 時 `passRate` 一定是 null。 */
      tier: can ? tier : TIER_NO_ESTIMATE,
      tierLabel: TIER_LABELS[can ? tier : TIER_NO_ESTIMATE],
      /** **通過第一階段**的機率。不是錄取機率。 */
      passRate: rate === null ? null : round(rate, 4),
      risk,
      reliability: s.reliability,
      /** 資料基礎：用了哪幾年、來源、什麼時候查的（§8.4 要求）。 */
      thresholdYears: s.thresholdYears,
      thresholdRefs: s.thresholdRefs,
      stages: s.stages.map((st, k) => ({
        ...st,
        /** 這一關擋掉的比例（在所有抽樣中）。看得出主要卡在哪一科。 */
        failRate: can ? round(failStage[i][k] / nDraws, 4) : null,
      })),
      qualify: s.qualify.map((q) => ({ ...q, describe: describeQualifyRule(q) })),
      qualifyFailRate: can ? round(failQualify[i] / nDraws, 4) : null,
      undecidableQualify: s.qualify.filter((q) => q.grade === null).length,
      notes,
      problems: s.problems,
    };
  });

  return {
    year,
    computedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    dataAsOf: dataAsOf ? new Date(dataAsOf).toISOString() : null,
    draws: nDraws,
    seed: usedSeed,
    correlation: {
      source: corrSource,
      loadings,
      note: correlation?.note ?? '',
      matrix: correlation?.matrix ?? null,
      pairs: correlation?.pairs ?? null,
    },
    missingSubjects: missing,
    wishes,
    combo: comboAnalysis(wishes, passCountHist, anyPass, nDraws),
    stageTwoNote: STAGE_TWO_NOTE,
  };
}

/**
 * 六個志願的組合分析（§8.3）。
 *
 * # 「至少通過一個」為什麼不能用 `1 − Π(1 − p_i)`
 *
 * 因為那個公式假設六個志願互相獨立，而它們**共用同一組級分**——
 * 數學考壞的那一天，用到數學的四個志願會一起失手。獨立公式算出來的
 * 「至少通過一個」會**顯著高估**，而那正是學生最想聽到的方向。
 *
 * 所以這個數字直接從抽樣裡數：每一次抽樣得到一組六科級分，看那一組
 * 之下有沒有任何一個志願過關。兩個數字都回報，差距本身就是「跨科
 * 相關性有多重要」的證據。
 */
export function comboAnalysis(wishes, passCountHist, anyPass, nDraws) {
  const estimated = wishes.filter((w) => w.passRate !== null);
  const excluded = wishes.filter((w) => w.passRate === null);

  const expectedPasses = estimated.reduce((a, w) => a + w.passRate, 0);
  const atLeastOne = nDraws > 0 ? anyPass / nDraws : 0;
  const independentAtLeastOne =
    estimated.length === 0 ? 0 : 1 - estimated.reduce((a, w) => a * (1 - w.passRate), 1);

  const tiers = {
    sprint: estimated.filter((w) => w.risk === 'SPRINT'),
    steady: estimated.filter((w) => w.risk === 'STEADY'),
    safe: estimated.filter((w) => w.risk === 'SAFE'),
  };

  const warnings = [];
  if (estimated.length > 0 && tiers.sprint.length === estimated.length) {
    warnings.push({
      code: 'ALL_SPRINT',
      text:
        `算得出機率的 ${estimated.length} 個志願**全部落在衝刺區**（通過機率低於 ` +
        `${Math.round(TIER_SPRINT_MAX * 100)}%）。` +
        `這樣配的「至少通過一個」是 ${pct(atLeastOne)}——也就是` +
        `有 ${pct(1 - atLeastOne)} 的機會六個都沒過第一階段。` +
        '系統不會替你改志願，但這個數字你要看到。' +
        (excluded.length > 0
          ? `另外還有 ${excluded.length} 個志願的資料不足以估計，它們**沒有被算成 0**，` +
            '但也沒有被算成保底。'
          : ''),
    });
  }
  if (estimated.length > 0 && atLeastOne < AT_LEAST_ONE_ALERT) {
    warnings.push({
      code: 'LOW_AT_LEAST_ONE',
      text:
        `「至少通過一個」只有 ${pct(atLeastOne)}，低於一半。` +
        '個人申請最多六個志願，而六個都沒過第一階段的話，這個管道今年就結束了。',
    });
  }
  if (estimated.length > 0 && tiers.safe.length === 0) {
    warnings.push({
      code: 'NO_SAFE',
      text:
        `沒有任何一個志願落在保底區（通過機率高於 ${Math.round(TIER_SAFE_MIN * 100)}%）。` +
        '這不是錯的配法，但它代表你沒有留任何一個「幾乎一定過第一階段」的位置。',
    });
  }
  if (excluded.length > 0) {
    warnings.push({
      code: 'EXCLUDED',
      text:
        `${excluded.length} 個志願**沒有進入模擬**（資料可靠度不足、或用到的科目級分資料不足）。` +
        '它們不算在上面的期望通過數與「至少通過一個」裡——' +
        '**當成 0 會讓那幾個志願看起來比它們該有的樣子更沒希望**，' +
        '當成保底則更糟。要讓它們進來就把那幾年的門檻補齊。',
    });
  }
  if (wishes.length > APPLY_WISH_LIMIT) {
    warnings.push({
      code: 'OVER_LIMIT',
      text: `個人申請至多 ${APPLY_WISH_LIMIT} 個志願，這裡有 ${wishes.length} 個。`,
    });
  }

  return {
    estimated: estimated.length,
    excluded: excluded.length,
    /** 期望通過數。**只加算得出機率的那幾個。** */
    expectedPasses: round(expectedPasses, 3),
    /** 至少通過一個。**從抽樣直接數出來的（考慮了跨科相關性）。** */
    atLeastOne: round(atLeastOne, 4),
    /**
     * 假設六個志願互相獨立會算出來的「至少通過一個」。
     * **不是要拿來用的，是要拿來對照的**——它與上面那個的差距就是
     * 「六個志願共用同一組級分」這件事的份量。
     */
    independentAtLeastOne: round(independentAtLeastOne, 4),
    /** 通過幾個的分布。0 那一格就是「六個都沒過」。 */
    passCountDistribution: passCountHist.map((c, k) => ({ passes: k, p: round(c / nDraws, 4) })),
    tiers: {
      sprint: tiers.sprint.map((w) => w.wishId ?? w.institutionName),
      steady: tiers.steady.map((w) => w.wishId ?? w.institutionName),
      safe: tiers.safe.map((w) => w.wishId ?? w.institutionName),
    },
    warnings,
  };
}

// ═════════════════════════════════════════════════════════════════
// §8 與 `adviceGuard.mjs` 怎麼共存
//
// 落點模擬的輸出**是機率**，而 `lib/adviceGuard.mjs` 會擋掉所有機率
// 形式的輸出。兩者不衝突，因為它們管的是**兩條不同的通道**：
//
//   確定性通道（這個檔案）
//     數字是計算出來的。輸入有快照（`SimulationRun.input`）、亂數有
//     固定種子，所以任何一個數字都可以被重算出一模一樣的值。
//     它帶著自己的資料基礎（哪幾年、什麼來源、可靠度分數、查詢日期）
//     與 `STAGE_TWO_NOTE` 一起顯示，而那幾樣東西是計算的一部分，
//     不是文案。
//
//   生成通道（AI 老師，`lib/admissionRefDb.ts` 的 `adviceFor`）
//     數字是**寫出來的**。模型沒有辦法保證它寫的那個數字是剛剛算出來
//     的那一個，而一個看起來一樣的數字讀者分不出來。
//
// 所以規則是：**機率只走確定性通道，AI 的文字裡永遠不出現機率。**
//
// 這一條在程式碼上的落實方式是 `placementAdvicePayload()`：要送給模型
// 的脈絡裡**沒有任何機率欄位**。不是靠提示詞要求模型不要提，也不是
// 靠把數字加進 `adviceFacts()` 的白名單——後者行不通，而那正好證明了
// 這個設計是對的：`checkAdvice()` 的 `ODDS_PREDICTION` 規則擋的是
// 「機率詞 + 數字」這個**句型**，與那個數字有沒有來源無關。也就是說
// 即使把模擬算出來的 68 加進白名單，「通過機率 68%」照樣會被擋掉。
//
// 那不是閘門的缺陷，是它的設計：一段由模型寫出來的、含著機率的句子，
// 讀者沒有辦法分辨它是抄來的還是編的。要看機率就去看那張表，
// 那裡的每一個數字旁邊都有它的資料基礎。
// ═════════════════════════════════════════════════════════════════

/**
 * 要送給 AI 老師的落點脈絡。**不含任何機率。**
 *
 * 回傳裡故意只有「這個志願的資料長什麼樣」與「缺什麼」——那才是模型
 * 幫得上忙的地方（提醒他去補哪一年的門檻、指出檢定標準還沒換算成
 * 級分）。機率留在畫面上那張表裡。
 *
 * 有測試釘著這一支的輸出裡不出現 `passRate`、`atLeastOne` 這一類欄位，
 * 以及任何一個志願的通過率數字——多一個欄位就要多改一次那個測試，
 * 而那正是我們要的：這件事不該被順手加進去。
 */
export function placementAdvicePayload(result) {
  return {
    year: result.year,
    /** 逐志願，只有資料的樣子。 */
    wishes: (result.wishes ?? []).map((w) => ({
      rank: w.rank,
      institution_name: w.institutionName,
      program_name: w.programName,
      /** 三檔的**標籤**，不是分數也不是機率。 */
      data_tier: w.tierLabel,
      threshold_years: w.thresholdYears,
      threshold_sources: (w.thresholdRefs ?? []).map((r) => r.sourceLabel),
      /** 篩選科目的順序。這是簡章的公開事實。 */
      sieve_subjects: (w.stages ?? []).map((s) => s.label),
      /** 檢定標準有沒有換算成級分。沒有的話這是最該提醒的一件事。 */
      undecidable_qualify: w.undecidableQualify,
      problems: w.problems ?? [],
    })),
    /** 資料缺口的摘要。不含機率，也不含期望通過數。 */
    data_gaps: (result.wishes ?? [])
      .filter((w) => w.tier === TIER_NO_ESTIMATE)
      .map((w) => `${w.institutionName}${w.programName ?? ''}：資料不足以估計`),
    correlation_source: result.correlation?.source ?? null,
    stage_two_note: STAGE_TWO_NOTE,
  };
}

const pct = (v) => `${Math.round(v * 100)}%`;

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
