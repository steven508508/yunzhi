/**
 * 學習歷程的制度規則：件數、容量、字數，以及送出前的那一份清單。
 *
 * # 為什麼這一份要獨立而且是純函式
 *
 * 因為它擋的是**學生**，而擋錯的方向特別惡劣：系統說「你超過 10 件了」
 * 而他其實只有 9 件，他會相信系統然後刪掉一件該留的。刪掉之後那件
 * 素材通常就沒了——他不會為了系統的一句話去重新做一份實驗報告。
 *
 * 所以每一條規則都要能在沒有資料庫的情況下驗，與 `lib/grading.mjs`、
 * `lib/release.mjs` 同一個分工：**會算錯的東西要能被單獨測。**
 *
 * # 上限是資料，不是常數
 *
 * 每年簡章可能改，所以數字全部從 `PortfolioLimitSet` 進來
 * （`limitsOf()` 只在完全沒有建檔時退回一份預設值，而且會標
 * `isDefault`，讓畫面說得出「這是預設值，去對當年度的簡章」）。
 * 寫死在程式裡的那一版，明年會用去年的規則擋住學生而且沒有人知道。
 *
 * # 最多人搞錯的那一條
 *
 * **「多元表現綜整心得」（代碼 N）有 800 字加 3 張圖的明文限制，
 * 但它不計入 10 件多元表現的額度。**
 *
 * 這一條寫錯的症狀是：一位已經上傳 10 件多元表現的學生，寫完綜整心得
 * 之後被系統告知「多元表現已達上限」——而綜整心得**本來就是必要的
 * 一項**，它不是第 11 件，它根本不在那個計數裡。他會刪掉一件真的多元
 * 表現去換綜整心得的位置，而那是一個純粹由 bug 造成的損失。
 *
 * 所以計數這件事只有一個入口（`countItems`），而 `N` 的排除寫在
 * `countsTowardDiverseQuota()` 這一支上面，有名字、有註解、有測試。
 * 不要在別的地方再數一次——第二份實作不會記得這一條。
 *
 * # 學年與學期
 *
 * 「每學年至多 6 件」的「學年」指的是高一、高二、高三，不是民國學年度。
 * `PortfolioItem.semester` 存的是「高二上」這種人寫的字串，所以
 * `gradeYearOf()` 要能容忍各種寫法（高二上／高2上／二上／11年級上）。
 * 認不出來的一律歸到 `UNKNOWN` 並**單獨成一組**——把它併進任何一個
 * 學年都會讓那一年虛胖，然後擋住學生。
 */

// ─────────────────────────────────────────────────────────────────
// 上限
// ─────────────────────────────────────────────────────────────────

/**
 * 完全沒有建檔時的預設值。
 *
 * **這些數字只是預設值。** 它們抄自 115 學年度的規則，而簡章逐年公告；
 * 畫面上必須提醒管理員去對當年度的簡章，所以 `limitsOf()` 回傳的物件
 * 帶著 `isDefault` 與 `sourceRef: null`——沒有來源的上限不該長得跟
 * 有人負責的上限一樣。
 */
export const DEFAULT_LIMITS = {
  outcomePerYear: 6,
  diversePerYear: 10,
  outcomeSelected: 3,
  diverseSelected: 10,
  summaryChars: 800,
  summaryImages: 3,
  docBytes: 4 * 1024 * 1024,
  mediaBytes: 10 * 1024 * 1024,
};

/**
 * 把資料庫那一列（或 null）折成計算要用的形狀。
 *
 * @param {object|null} row `PortfolioLimitSet` 的一列
 * @returns {typeof DEFAULT_LIMITS & {isDefault: boolean, sourceRef: string|null, year: number|null}}
 */
export function limitsOf(row) {
  if (!row) {
    return { ...DEFAULT_LIMITS, isDefault: true, sourceRef: null, year: null };
  }
  const pick = (k) => (Number.isFinite(row[k]) ? row[k] : DEFAULT_LIMITS[k]);
  return {
    outcomePerYear: pick('outcomePerYear'),
    diversePerYear: pick('diversePerYear'),
    outcomeSelected: pick('outcomeSelected'),
    diverseSelected: pick('diverseSelected'),
    summaryChars: pick('summaryChars'),
    summaryImages: pick('summaryImages'),
    docBytes: pick('docBytes'),
    mediaBytes: pick('mediaBytes'),
    isDefault: false,
    sourceRef: row.sourceRef ?? null,
    year: Number.isFinite(row.year) ? row.year : null,
  };
}

/**
 * 給管理員看的一句話。**上限是預設值時一定要顯示。**
 *
 * 不是提醒他「系統很貼心」，是提醒他這幾個數字**現在沒有人負責**：
 * 沒有人說得出它們抄自哪一份簡章的哪一頁，而它們會擋住學生。
 */
export const LIMITS_UNVERIFIED_NOTE =
  '這一年度還沒有人建檔，畫面上用的是預設值（抄自 115 學年度）。' +
  '**請對照當年度的簡章逐項確認**——件數與容量上限每年可能改，' +
  '而錯的方向是系統告訴學生「你超過上限了」而他其實沒有，' +
  '然後他會刪掉一件該留的。';

// ─────────────────────────────────────────────────────────────────
// 代碼與分類
// ─────────────────────────────────────────────────────────────────

/**
 * 官方代碼 B–T 的中文名。**代碼本身是招生端的語言**，學生看到的是
 * 「B 書面報告」而不是只有一個 B——他手上那份簡章寫的就是這個。
 */
export const ITEM_CODES = [
  { code: 'B', label: '書面報告', category: 'COURSE_OUTCOME' },
  { code: 'C', label: '實作作品', category: 'COURSE_OUTCOME' },
  { code: 'D', label: '自然科學探究與實作成果', category: 'COURSE_OUTCOME' },
  { code: 'E', label: '社會領域探究活動成果', category: 'COURSE_OUTCOME' },
  { code: 'F', label: '高中自主學習計畫與成果', category: 'DIVERSE_PERFORMANCE' },
  { code: 'G', label: '社團活動經驗', category: 'DIVERSE_PERFORMANCE' },
  { code: 'H', label: '擔任幹部經驗', category: 'DIVERSE_PERFORMANCE' },
  { code: 'I', label: '服務學習經驗', category: 'DIVERSE_PERFORMANCE' },
  { code: 'J', label: '競賽表現', category: 'DIVERSE_PERFORMANCE' },
  { code: 'K', label: '非修課紀錄之成果作品', category: 'DIVERSE_PERFORMANCE' },
  { code: 'L', label: '檢定證照', category: 'DIVERSE_PERFORMANCE' },
  { code: 'M', label: '特殊優良表現證明', category: 'DIVERSE_PERFORMANCE' },
  { code: 'N', label: '多元表現綜整心得', category: 'DIVERSE_PERFORMANCE' },
];

/** 代碼 → 那一列。認不得的代碼回 null，由呼叫端決定要不要擋。 */
export function itemCodeInfo(code) {
  const key = String(code ?? '').trim().toUpperCase();
  return ITEM_CODES.find((c) => c.code === key) ?? null;
}

/**
 * 多元表現綜整心得的代碼。
 *
 * 抽成一個具名常數而不是到處寫 `'N'`，是因為這個字母在下面兩個地方
 * 各有一個**方向相反**的用途：它要被排除在件數之外，又要被檢查字數與
 * 圖片數。寫成字面量的話，日後有人改其中一處而漏掉另一處，
 * 症狀是「綜整心得沒有被檢查字數」——那不會有人發現，直到上傳被退件。
 */
export const DIVERSE_SUMMARY_CODE = 'N';

/**
 * 這一件算不算進「多元表現至多 10 件」的額度。
 *
 * **綜整心得（N）不算。** 它有自己的限制（800 字 + 3 圖，見
 * `checkSummaryEssay`），而且它是必要的一項而不是第 11 件多元表現。
 * 這是本模組最多人搞錯的一條規則，所以它是一支有名字的函式，
 * 不是某個 filter 裡的一個 `!==`。
 */
export function countsTowardDiverseQuota(item) {
  if (!item) return false;
  if (item.category !== 'DIVERSE_PERFORMANCE') return false;
  return String(item.itemCode ?? '').trim().toUpperCase() !== DIVERSE_SUMMARY_CODE;
}

// ─────────────────────────────────────────────────────────────────
// 學年
// ─────────────────────────────────────────────────────────────────

/** 高一／高二／高三，以及認不出來的那一組。 */
export const GRADE_YEARS = ['G1', 'G2', 'G3', 'UNKNOWN'];

export const GRADE_YEAR_LABELS = {
  G1: '高一',
  G2: '高二',
  G3: '高三',
  UNKNOWN: '沒有標學期',
};

const GRADE_PATTERNS = [
  [/(高一|高1|一年級|10年級|G1|H1)/i, 'G1'],
  [/(高二|高2|二年級|11年級|G2|H2)/i, 'G2'],
  [/(高三|高3|三年級|12年級|G3|H3)/i, 'G3'],
];

/**
 * 「高二上」→ `G2`。
 *
 * 認不出來的回 `UNKNOWN` 而**不是**猜一個。猜錯的代價是那一學年憑空
 * 多一件，然後在他真的要上傳第 6 件時擋住他；而 `UNKNOWN` 單獨成一組
 * 的代價只是畫面上多一列「沒有標學期（2 件）」，他自己看得懂要去補。
 *
 * 只有「一上」這種沒有「高」字的寫法會落到 `UNKNOWN`：那種寫法在
 * 補習班的名冊裡同時可能指國中，猜不得。
 */
export function gradeYearOf(semester) {
  const s = String(semester ?? '').trim();
  if (!s) return 'UNKNOWN';
  for (const [re, year] of GRADE_PATTERNS) {
    if (re.test(s)) return year;
  }
  return 'UNKNOWN';
}

// ─────────────────────────────────────────────────────────────────
// 件數
// ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} PortfolioItemLike
 * @property {string} [id]
 * @property {string} category
 * @property {string} itemCode
 * @property {string|null} [semester]
 * @property {string[]} [selectedFor]
 * @property {number|null} [fileBytes]
 * @property {string|null} [fileKind]
 * @property {string} [title]
 */

/**
 * 上傳中央資料庫的件數：**逐學年**算，課程學習成果與多元表現分開。
 *
 * @param {PortfolioItemLike[]} items
 * @param {ReturnType<typeof limitsOf>} limits
 * @returns {{
 *   byYear: {year: string, label: string,
 *            outcome: {used: number, max: number, over: boolean},
 *            diverse: {used: number, max: number, over: boolean, summaryExcluded: number}}[],
 *   over: boolean,
 * }}
 *
 * `summaryExcluded` 會被畫面印出來（「另有 1 件綜整心得，不計入額度」）。
 * 不印的話，學生數自己的檔案是 11 件而系統說 10 件，他會以為系統壞了
 * 然後去刪東西——**能被驗證的數字比正確的數字重要**。
 */
export function countCentralUpload(items, limits = limitsOf(null)) {
  const buckets = new Map();
  const ensure = (year) => {
    if (!buckets.has(year)) {
      buckets.set(year, { outcome: 0, diverse: 0, summaryExcluded: 0 });
    }
    return buckets.get(year);
  };

  for (const it of items ?? []) {
    const b = ensure(gradeYearOf(it.semester));
    if (it.category === 'COURSE_OUTCOME') b.outcome += 1;
    else if (it.category === 'DIVERSE_PERFORMANCE') {
      if (countsTowardDiverseQuota(it)) b.diverse += 1;
      else b.summaryExcluded += 1;
    }
  }

  const byYear = GRADE_YEARS.filter((y) => buckets.has(y)).map((year) => {
    const b = buckets.get(year);
    return {
      year,
      label: GRADE_YEAR_LABELS[year],
      outcome: {
        used: b.outcome,
        max: limits.outcomePerYear,
        over: b.outcome > limits.outcomePerYear,
      },
      diverse: {
        used: b.diverse,
        max: limits.diversePerYear,
        over: b.diverse > limits.diversePerYear,
        summaryExcluded: b.summaryExcluded,
      },
    };
  });

  return { byYear, over: byYear.some((y) => y.outcome.over || y.diverse.over) };
}

/**
 * 個人申請階段**逐校系**勾選的件數。
 *
 * 與上傳中央資料庫是兩套完全不同的上限（3 件／10 件 vs 6 件／10 件），
 * 而且這一套**不分學年**——勾選的是三年份裡挑出來的那幾件。
 * 兩套合成一支函式的話，其中一邊的「每學年」會悄悄套到另一邊。
 *
 * @param {PortfolioItemLike[]} items
 * @param {ReturnType<typeof limitsOf>} limits
 * @param {string[]} [programRefs] 只算這幾個校系；不給就算所有出現過的
 */
export function countSelected(items, limits = limitsOf(null), programRefs) {
  const seen = new Map();
  const ensure = (ref) => {
    if (!seen.has(ref)) seen.set(ref, { outcome: 0, diverse: 0, summaryExcluded: 0 });
    return seen.get(ref);
  };
  for (const ref of programRefs ?? []) ensure(ref);

  for (const it of items ?? []) {
    for (const ref of it.selectedFor ?? []) {
      if (programRefs && !programRefs.includes(ref)) continue;
      const b = ensure(ref);
      if (it.category === 'COURSE_OUTCOME') b.outcome += 1;
      else if (it.category === 'DIVERSE_PERFORMANCE') {
        if (countsTowardDiverseQuota(it)) b.diverse += 1;
        else b.summaryExcluded += 1;
      }
    }
  }

  const byProgram = [...seen.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([programRef, b]) => ({
      programRef,
      outcome: {
        used: b.outcome,
        max: limits.outcomeSelected,
        over: b.outcome > limits.outcomeSelected,
      },
      diverse: {
        used: b.diverse,
        max: limits.diverseSelected,
        over: b.diverse > limits.diverseSelected,
        summaryExcluded: b.summaryExcluded,
      },
    }));

  return { byProgram, over: byProgram.some((p) => p.outcome.over || p.diverse.over) };
}

/**
 * 新增一件之前先問：加得下嗎。
 *
 * 回的是「加了會不會超過」而不是「現在有沒有超過」——**這兩個問題的
 * 答案在邊界上剛好相反**（現在正好 6 件時「有沒有超過」是否，
 * 「加得下嗎」也是否，但現在 5 件時兩者不同），而寫錯的方向是讓他
 * 傳到第 7 件才在中央資料庫端被退。
 *
 * @returns {{ok: boolean, reason: string|null}}
 */
export function mayAddItem(items, candidate, limits = limitsOf(null)) {
  const next = [...(items ?? []), candidate];
  const before = countCentralUpload(items ?? [], limits);
  const after = countCentralUpload(next, limits);
  const year = gradeYearOf(candidate?.semester);
  const bYear = before.byYear.find((y) => y.year === year);
  const aYear = after.byYear.find((y) => y.year === year);
  if (!aYear) return { ok: true, reason: null };

  // 只在「加了才超過」時擋。本來就超過的（例如上限被調小了）不該
  // 讓他連動都不能動——那會把他鎖死在一個他無法修正的狀態裡。
  if (aYear.outcome.over && !(bYear?.outcome.over ?? false)) {
    return {
      ok: false,
      reason:
        `${aYear.label}的課程學習成果已經有 ${bYear?.outcome.used ?? 0} 件，` +
        `上限是 ${limits.outcomePerYear} 件。要加這一件的話，得先移掉一件。`,
    };
  }
  if (aYear.diverse.over && !(bYear?.diverse.over ?? false)) {
    return {
      ok: false,
      reason:
        `${aYear.label}的多元表現已經有 ${bYear?.diverse.used ?? 0} 件，` +
        `上限是 ${limits.diversePerYear} 件。要加這一件的話，得先移掉一件。` +
        (aYear.diverse.summaryExcluded > 0
          ? `（綜整心得不算在這 ${limits.diversePerYear} 件裡，所以你看到的檔案數會比這個數字多。）`
          : ''),
    };
  }
  return { ok: true, reason: null };
}

// ─────────────────────────────────────────────────────────────────
// 容量
// ─────────────────────────────────────────────────────────────────

/** 檔案的兩種類別。上限差 2.5 倍，所以分錯類的後果是被退件。 */
export const FILE_KINDS = [
  { value: 'DOC', label: '文件（PDF）' },
  { value: 'MEDIA', label: '影音' },
];

const MB = (n) => `${(n / 1024 / 1024).toFixed(0)}MB`;

/**
 * 單件容量。**上限是中央資料庫端的**，不是本系統的。
 *
 * 也就是說：在這裡上傳成功不代表送得上去。所以這一支在**上傳當下**
 * 就要擋，而不是等到送出前的確認清單——那時候他手上可能只剩那一份
 * 檔案，重做來不及。
 *
 * @returns {{ok: boolean, reason: string|null}}
 */
export function checkFileSize(item, limits = limitsOf(null)) {
  const bytes = Number(item?.fileBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: true, reason: null };
  const kind = item?.fileKind === 'MEDIA' ? 'MEDIA' : 'DOC';
  const max = kind === 'MEDIA' ? limits.mediaBytes : limits.docBytes;
  if (bytes <= max) return { ok: true, reason: null };
  return {
    ok: false,
    reason:
      `這一件是 ${(bytes / 1024 / 1024).toFixed(1)}MB，` +
      `中央資料庫的${kind === 'MEDIA' ? '影音' : '文件'}上限是 ${MB(max)}。` +
      (kind === 'DOC'
        ? '把圖片的解析度降下來通常就夠了——掃描的紙本每頁壓到 150dpi 大約會少一半。'
        : '影音超過上限時，多半是解析度開太高；1080p 三分鐘大約就到上限了。'),
  };
}

// ─────────────────────────────────────────────────────────────────
// 字數
// ─────────────────────────────────────────────────────────────────

/**
 * 中文的「字數」。
 *
 * 招生端算的是**字**不是 code point：全形標點算不算各校寫法不一，
 * 而空白與換行一定不算。這裡採「扣掉空白與換行之後的字元數」，
 * 並在畫面上說明採計方式——與其偷偷用一種算法，不如講出來讓學生
 * 自己保留餘裕。
 *
 * 用 `Array.from` 而不是 `.length`：`String.length` 數的是 UTF-16
 * 單元，一個表情符號或罕用字（𠮟）會被算成兩個字。
 */
export function charCountOf(text) {
  return Array.from(String(text ?? '').replace(/\s+/g, '')).length;
}

export const CHAR_COUNT_NOTE = '字數不計空白與換行。各校對標點的採計方式不一，抓一點餘裕比較安全。';

/**
 * 綜整心得（N）的 800 字 + 3 圖。
 *
 * **這是這一項唯一有全國明文上限的地方。** 學習歷程自述（O/P/Q）的
 * 頁數字數由各校系自訂、全國沒有統一上限，所以那三項這裡不給數字，
 * 只檢查子項齊不齊（見 `checkSelfStatement`）。給一個編出來的上限
 * 比不給更糟——學生會照著砍，而他砍掉的那幾百字可能正是該校系想看的。
 *
 * @returns {{code: string, ok: boolean, detail: string}[]}
 */
export function checkSummaryEssay(essay, limits = limitsOf(null)) {
  const out = [];
  const chars = Number.isFinite(essay?.charCount) ? essay.charCount : charCountOf(essay?.body);
  const images = Number.isFinite(essay?.imageCount) ? essay.imageCount : 0;

  out.push({
    code: 'SUMMARY_CHARS',
    ok: chars <= limits.summaryChars,
    detail:
      chars <= limits.summaryChars
        ? `${chars} 字，上限 ${limits.summaryChars} 字。`
        : `${chars} 字，超過上限 ${limits.summaryChars} 字 ${chars - limits.summaryChars} 字。`,
  });
  out.push({
    code: 'SUMMARY_IMAGES',
    ok: images <= limits.summaryImages,
    detail:
      images <= limits.summaryImages
        ? `${images} 張圖，上限 ${limits.summaryImages} 張。`
        : `${images} 張圖，超過上限 ${limits.summaryImages} 張。`,
  });
  return out;
}

/**
 * O/P/Q 三個子項。**必須合併成一個 PDF**，所以缺一項就是整份不完整。
 *
 * 只有這一份清單，`checkSelfStatement` 直接讀它。抄第二份的話，日後
 * 有人在其中一份加了子項，症狀是「清單上顯示齊全但送出時被退」。
 */
export const SELF_STATEMENT_KINDS = [
  { kind: 'REFLECTION', code: 'O', label: '高中學習歷程反思' },
  { kind: 'MOTIVATION', code: 'P', label: '就讀動機' },
  { kind: 'PLAN', code: 'Q', label: '未來學習計畫與生涯規劃' },
];

/**
 * 三個子項齊不齊。
 *
 * 空白的算缺——**存在一列但 body 是空的**是最常見的情形（學生開了草稿
 * 就去做別的事了），而那在資料庫層面看起來與寫完了一模一樣。
 */
export function checkSelfStatement(essays) {
  const have = new Map();
  for (const e of essays ?? []) {
    if (charCountOf(e?.body) > 0) have.set(e.kind, e);
  }
  return SELF_STATEMENT_KINDS.map((s) => ({
    code: `SELF_${s.code}`,
    ok: have.has(s.kind),
    detail: have.has(s.kind)
      ? `${s.code} ${s.label}：${charCountOf(have.get(s.kind).body)} 字。`
      : `${s.code} ${s.label}：還沒有寫。三個子項要合併成一個 PDF，缺一項就送不出去。`,
  }));
}

// ─────────────────────────────────────────────────────────────────
// 送出前的確認清單（§9.4）
//
// 這一份技術含量低但實用價值高。實務上因為技術性疏失——少傳一項、
// 超過大小、搞錯擇一規則——而吃虧的案例意外地多，而它們每一件都是
// 可以用一份清單避免的。
// ─────────────────────────────────────────────────────────────────

/** 第二階段上傳的兩種方式。**每一校系只能擇一，不得混搭。** */
export const UPLOAD_MODES = [
  { value: 'CENTRAL', label: '勾選中央資料庫' },
  { value: 'PDF', label: '自行上傳 PDF' },
];

/** 起始日全國統一。截止日各校自訂，所以那一項在清單裡是逐校系問的。 */
export const UPLOAD_OPEN_MONTH_DAY = '04-30';
/** 系統每日開放時間。 */
export const UPLOAD_DAILY_OPEN_HOUR = 9;
export const UPLOAD_DAILY_CLOSE_HOUR = 21;

/**
 * 送出前的逐項核對。
 *
 * @param {object} input
 * @param {PortfolioItemLike[]} input.items
 * @param {object[]} input.essays
 * @param {{programRef: string, name?: string, mode?: string|null, deadline?: string|null}[]} input.programs
 * @param {ReturnType<typeof limitsOf>} input.limits
 * @param {Date} [input.now] 注入時鐘。**不要在這裡讀 `new Date()`**——
 *   「現在是不是開放時間」這件事沒有辦法在測試裡固定，而它正是最需要
 *   被固定下來測的一條（09:00 前一分鐘與 21:00 後一分鐘各一個案例）。
 * @returns {{items: {code: string, label: string, ok: boolean, severity: 'BLOCK'|'WARN'|'INFO', detail: string}[],
 *            blocking: number, warning: number}}
 *
 * 三種嚴重度而不是兩種：`BLOCK` 是「這樣送出去一定出事」，`WARN` 是
 * 「可能出事，你自己確認」，`INFO` 是「沒事，但你要知道」。全部做成
 * BLOCK 的話，學生會學會忽略整份清單——而那時真正的 BLOCK 也一起被
 * 忽略了。
 */
export function submissionChecklist(input) {
  const {
    items = [],
    essays = [],
    programs = [],
    limits = limitsOf(null),
    now = new Date(),
  } = input ?? {};

  /** @type {{code: string, label: string, ok: boolean, severity: 'BLOCK'|'WARN'|'INFO', detail: string}[]} */
  const out = [];
  const add = (code, label, ok, severity, detail) =>
    out.push({ code, label, ok, severity, detail });

  // ── 一、開放期間 ────────────────────────────────────────────
  const y = now.getFullYear();
  const openDay = new Date(`${y}-${UPLOAD_OPEN_MONTH_DAY}T00:00:00`);
  add(
    'WINDOW_START',
    '起始日 4/30',
    now >= openDay,
    'INFO',
    now >= openDay
      ? '已經過了全國統一的起始日。'
      : `第二階段上傳系統全國統一從 ${y} 年 4 月 30 日起開放。現在還沒開，先把東西準備好。`,
  );

  const h = now.getHours();
  const inHours = h >= UPLOAD_DAILY_OPEN_HOUR && h < UPLOAD_DAILY_CLOSE_HOUR;
  add(
    'WINDOW_DAILY',
    '每日 09:00 至 21:00',
    inHours,
    'WARN',
    inHours
      ? `現在是 ${String(h).padStart(2, '0')} 點，在開放時間內。`
      : `甄選會的系統每天只開 09:00 到 21:00，現在是 ${String(h).padStart(2, '0')} 點。` +
        '這一條最常害到人的地方是截止日當天——21:00 一到就關，不是 23:59。',
  );

  // ── 二、逐校系：擇一規則與截止日 ────────────────────────────
  //
  // **擇一不得混搭**是這一段的重點。它不是「建議選一種」，是同一個
  // 校系裡你勾了中央資料庫就不能再自行上傳 PDF，反之亦然。
  const noMode = programs.filter((p) => !p.mode);
  add(
    'MODE_CHOSEN',
    '每一校系都選好了要用哪一種上傳方式',
    noMode.length === 0,
    'BLOCK',
    noMode.length === 0
      ? `${programs.length} 個校系都選好了。`
      : `還有 ${noMode.length} 個校系沒選：${noMode.map((p) => p.name ?? p.programRef).join('、')}。` +
        '「勾選中央資料庫」與「自行上傳 PDF」每一校系只能擇一，而且**不得混搭**。',
  );

  const mixed = programs.filter((p) => p.mode === 'MIXED');
  add(
    'MODE_NOT_MIXED',
    '沒有校系同時用了兩種方式',
    mixed.length === 0,
    'BLOCK',
    mixed.length === 0
      ? '沒有混搭。'
      : `${mixed.map((p) => p.name ?? p.programRef).join('、')} 同時登記了兩種方式。` +
        '這在甄選會的系統上是做不到的，會在送出時被擋，而那時候可能已經是截止日當天。',
  );

  const noDeadline = programs.filter((p) => !p.deadline);
  add(
    'DEADLINE_KNOWN',
    '每一校系的截止日都查過了',
    noDeadline.length === 0,
    'WARN',
    noDeadline.length === 0
      ? '都填了。'
      : `${noDeadline.map((p) => p.name ?? p.programRef).join('、')} 還沒填截止日。` +
        '**起始日全國統一 4/30，但截止日是各大學各自規定的**——' +
        '把最早的那一個當成自己的期限比較安全。',
  );

  // ── 三、件數與容量 ──────────────────────────────────────────
  const central = countCentralUpload(items, limits);
  add(
    'COUNT_CENTRAL',
    '上傳中央資料庫的件數在上限內',
    !central.over,
    'BLOCK',
    central.over
      ? central.byYear
          .filter((yy) => yy.outcome.over || yy.diverse.over)
          .map(
            (yy) =>
              `${yy.label}：課程學習成果 ${yy.outcome.used}/${yy.outcome.max}、` +
              `多元表現 ${yy.diverse.used}/${yy.diverse.max}`,
          )
          .join('；')
      : central.byYear
          .map(
            (yy) =>
              `${yy.label} ${yy.outcome.used}/${yy.outcome.max} 與 ${yy.diverse.used}/${yy.diverse.max}` +
              (yy.diverse.summaryExcluded > 0
                ? `（另有綜整心得 ${yy.diverse.summaryExcluded} 件，不計入額度）`
                : ''),
          )
          .join('；') || '還沒有任何素材。',
  );

  const refs = programs.map((p) => p.programRef);
  const selected = countSelected(items, limits, refs);
  add(
    'COUNT_SELECTED',
    '個人申請勾選的件數在上限內',
    !selected.over,
    'BLOCK',
    selected.over
      ? selected.byProgram
          .filter((p) => p.outcome.over || p.diverse.over)
          .map(
            (p) =>
              `${p.programRef}：課程學習成果 ${p.outcome.used}/${p.outcome.max}、` +
              `多元表現 ${p.diverse.used}/${p.diverse.max}`,
          )
          .join('；')
      : `每一校系的勾選都在 ${limits.outcomeSelected} 件與 ${limits.diverseSelected} 件之內。`,
  );

  const oversize = (items ?? []).filter((it) => !checkFileSize(it, limits).ok);
  add(
    'FILE_SIZE',
    '沒有單件超過中央資料庫的容量上限',
    oversize.length === 0,
    'BLOCK',
    oversize.length === 0
      ? `文件上限 ${MB(limits.docBytes)}、影音上限 ${MB(limits.mediaBytes)}，都在範圍內。`
      : `${oversize.map((it) => it.title ?? '（沒有標題）').join('、')} 超過上限。` +
        '這一項在上傳當下就擋過一次了，會出現在這裡通常是上限被調過。',
  );

  // ── 四、必要子項 ────────────────────────────────────────────
  for (const s of checkSelfStatement(essays)) {
    add(
      s.code,
      '學習歷程自述的三個子項',
      s.ok,
      'BLOCK',
      s.detail,
    );
  }

  const summary = (essays ?? []).find((e) => e.kind === 'DIVERSE_SUMMARY');
  if (summary) {
    for (const c of checkSummaryEssay(summary, limits)) {
      add(c.code, '多元表現綜整心得的字數與圖片', c.ok, 'BLOCK', c.detail);
    }
  } else {
    add(
      'SUMMARY_MISSING',
      '多元表現綜整心得',
      false,
      'WARN',
      '還沒有寫。綜整心得（代碼 N）是多元表現的一部分，' +
        `有 ${limits.summaryChars} 字加 ${limits.summaryImages} 張圖的明文限制，` +
        '**但它不計入 10 件多元表現的額度**——不要為了它去刪別的東西。',
    );
  }

  // ── 五、不可逆 ──────────────────────────────────────────────
  add(
    'IRREVERSIBLE',
    '送出確認後不得修改',
    true,
    'INFO',
    '按下確認之後就改不了了，這是甄選會系統的規則不是本系統的。' +
      '上面每一項都對過之後再送——這一份清單存在的理由就是這一句話。',
  );

  return {
    items: out,
    blocking: out.filter((x) => !x.ok && x.severity === 'BLOCK').length,
    warning: out.filter((x) => !x.ok && x.severity === 'WARN').length,
  };
}

// ─────────────────────────────────────────────────────────────────
// AI 使用層級（§9.2）
//
// 教育部 113 年 12 月 13 日函文要求教師**事前明定**四種使用層級之一。
// 「事前明定」的意思就是有些事不准做——所以超出層級的功能是**停用**，
// 不是「可以用但要標註」。
// ─────────────────────────────────────────────────────────────────

/**
 * 四個層級各自允許什麼。
 *
 * # 排序的軸線是「AI 介入的時點離產出有多近」
 *
 * 不是「AI 有多聰明」也不是「用了多少 token」，而是**它在學生的哪一個
 * 階段插進來**。這條軸線可以解釋為什麼「選件討論」比「撰寫回饋」更寬：
 * 撰寫回饋看的是他已經寫完的東西（他的想法已經成形），選件討論發生在
 * 他還沒決定的當下——那是最接近共同創作的一種介入，所以放在最寬的一級。
 *
 * 用「哪個功能比較危險」排的話會排成另一個順序，而那個順序沒有辦法向
 * 學生或家長解釋。這一條可以。
 *
 * # 兩件事在每一級都可用，包含層級 1
 *
 * **制度檢查（RULE_CHECK）**：字數、件數、必要子項。它是純規則，
 * 一行都不呼叫模型，所以它根本不是「AI 使用」。把它關掉只會讓層級 1
 * 的學生失去件數上限的保護，而那與這條規定的目的無關。
 *
 * **揭露聲明（DISCLOSURE_STATEMENT）**：它是這整套規定的**執行機制**。
 * 關掉它等於讓層級 1 的學生交不出必要的揭露——而層級 1 的學生剛好是
 * 最不需要擔心的那一群（他的聲明內容是「未使用」，由程式組出來，
 * 見 `portfolioGuard.mjs` 的 `safeStatement()`，同樣不呼叫模型）。
 */
export const AI_LEVELS = [
  {
    level: 1,
    label: '第 1 級：不得使用',
    summary: '任何會把學生的文字或素材送進模型的功能全部停用。',
    allows: ['RULE_CHECK', 'DISCLOSURE_STATEMENT'],
    why:
      '適用於老師希望學生完全自己完成的班級。制度檢查與揭露聲明仍然可用，' +
      '因為前者是純規則不呼叫模型，後者是這條規定本身的執行機制——' +
      '關掉揭露聲明會讓這一級的學生交不出必要的揭露。',
  },
  {
    level: 2,
    label: '第 2 級：得用於背景理解與素材回想',
    summary: '加開素材提示。AI 讀得到他的學習軌跡，讀不到他寫的草稿。',
    allows: ['RULE_CHECK', 'DISCLOSURE_STATEMENT', 'MATERIAL_HINT'],
    why:
      '素材提示用的是他自己的成績與作答軌跡（「你在高二下的物理成績有明顯進步，' +
      '那段時間發生了什麼」），輸出是問題不是文字。它幫學生想起自己的經歷，' +
      '而回想不是撰寫。',
  },
  {
    level: 3,
    label: '第 3 級：得用於對已完成內容的回饋',
    summary: '加開撰寫回饋與面試結構回饋。AI 讀得到他寫完的東西，只能提問與指出。',
    allows: [
      'RULE_CHECK',
      'DISCLOSURE_STATEMENT',
      'MATERIAL_HINT',
      'WRITING_FEEDBACK',
      'INTERVIEW_FEEDBACK',
    ],
    why:
      '這兩項的共同點是**他已經產出了東西**，AI 做的是看完之後指出具體性不足、' +
      '前後不一致、或制度上不合。介入的時點在產出之後，所以那份產出仍然是他的。',
  },
  {
    level: 4,
    label: '第 4 級：得用於構思階段的討論',
    summary: '全部開放。含選件討論——他還沒決定的當下，AI 陪他一起想。',
    allows: [
      'RULE_CHECK',
      'DISCLOSURE_STATEMENT',
      'MATERIAL_HINT',
      'WRITING_FEEDBACK',
      'INTERVIEW_FEEDBACK',
      'SELECTION_DISCUSS',
    ],
    why:
      '選件討論發生在他還沒決定要送哪三件的時候，是四項裡介入時點最早、' +
      '最接近共同創作的一種。**即使在這一級，代寫仍然被閘門擋著**——' +
      '層級管的是「哪些功能可以用」，不是「可以放寬到什麼程度」。',
  },
];

/**
 * 老師還沒設定時的層級。
 *
 * `null` 而不是一個數字。**「沒有設定」與「設定為第 1 級」是兩件事**：
 * 前者是老師還沒做這個動作，後者是他決定了。折成同一個值的話，畫面上
 * 就說不出「請老師去設定」這句話，而學生會以為老師選了最嚴的一級然後
 * 去問他為什麼。
 */
export const AI_LEVEL_UNSET = null;

/**
 * 學生在多個班級時取**最嚴的一級**。
 *
 * 一位老師為他的班級設了第 1 級，意思就是「這個班的學生不要用」。
 * 取最寬的話，學生只要另外加入一個第 4 級的班就整組失效——而那位
 * 老師不會知道。取最嚴會誤傷（他在別的班本來可以用），但誤傷的症狀
 * 是他來問，而放行的症狀是沒有人知道。
 *
 * @param {(number|null|undefined)[]} levels 各班級的設定，沒設定的傳 null
 * @returns {number|null} 沒有任何一班設定過就回 null
 */
export function effectiveAiLevel(levels) {
  const set = (levels ?? []).filter((l) => Number.isInteger(l) && l >= 1 && l <= 4);
  if (set.length === 0) return AI_LEVEL_UNSET;
  return Math.min(...set);
}

/**
 * 這一級可以用這個功能嗎。
 *
 * **沒有設定（null）一律不准。** 「事前明定」的意思是老師要先做一個
 * 決定，沒做就是沒做——除了兩個在每一級都開的例外（制度檢查與揭露
 * 聲明，理由見 `AI_LEVELS` 的註解），其餘一律停用並在畫面上說出
 * 「請老師先設定」。往放行的方向倒的話，這條規定就等於沒有。
 *
 * @param {number|null} level
 * @param {string} feature `PortfolioAiFeature` 的值
 */
export function aiFeatureAllowed(level, feature) {
  const always = AI_LEVELS[0].allows;
  if (always.includes(feature)) return true;
  const row = AI_LEVELS.find((l) => l.level === level);
  if (!row) return false;
  return row.allows.includes(feature);
}

/** 被停用時給學生看的一句話。**要說得出是誰決定的、去問誰。** */
export function aiDisabledReason(level, feature) {
  const label = AI_FEATURE_LABELS[feature] ?? feature;
  if (level === AI_LEVEL_UNSET) {
    return (
      `「${label}」還不能用：教育部要求老師**事前明定** AI 使用層級，` +
      '而你的班級還沒有設定。請老師到班級頁設定之後就會開。'
    );
  }
  const row = AI_LEVELS.find((l) => l.level === level);
  return (
    `「${label}」在你班級的 AI 使用層級（${row?.label ?? `第 ${level} 級`}）之外，` +
    '所以停用。這是老師事前明定的範圍，不是系統的限制——想調整的話跟老師談。'
  );
}

export const AI_FEATURE_LABELS = {
  WRITING_FEEDBACK: '撰寫回饋',
  MATERIAL_HINT: '素材提示',
  SELECTION_DISCUSS: '選件討論',
  RULE_CHECK: '制度檢查',
  INTERVIEW_FEEDBACK: '面試結構回饋',
  DISCLOSURE_STATEMENT: '揭露聲明',
};

/** 揭露聲明裡要怎麼稱呼這一類互動。**與功能名稱分開**，理由見下。 */
export const AI_FEATURE_DISCLOSURE_PHRASES = {
  // 聲明是要貼進學習歷程檔案給招生委員看的，所以用的是他們的語言
  // （「文字具體性與邏輯一致性的回饋」），不是系統的功能名（「撰寫回饋」）。
  // 共用一份字串的話，改介面上的功能名會連帶改掉學生已經產出的聲明用語，
  // 而那份聲明是他要負責的文件。
  WRITING_FEEDBACK: '文字具體性與邏輯一致性的回饋',
  MATERIAL_HINT: '從個人學習紀錄回想素材的提問',
  SELECTION_DISCUSS: '成果選件的討論',
  RULE_CHECK: '字數與件數等格式的檢查',
  INTERVIEW_FEEDBACK: '面試回答結構的回饋',
  DISCLOSURE_STATEMENT: '本聲明的草擬',
};
