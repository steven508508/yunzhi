/**
 * 學生自己查來的升學參考資料：信任度、過期判定、以及**隔離**。
 *
 * # 這個檔案在防的是什麼
 *
 * 一個沒有來源的數字，在三個月後與一個有來源的長得一模一樣。而學生會
 * 照著它決定要不要填某個志願——那是一個不可逆的決定，個申的放棄期限
 * 只有四天。所以這裡的每一支函式都在回答同一個問題：**這個數字值多少
 * 信任，而且它憑什麼？**
 *
 * 三件事分開處理，因為它們會各自壞掉：
 *
 *   · **來源**（誰說的）→ `sourceTrustOf`
 *   · **新鮮度**（什麼時候查的、學年度過了沒有）→ `stalenessOf`
 *   · **能不能影響別人**（`forSelfOnly`）→ `starParticipants`
 *
 * # 第三件是最危險的一件，而它完全沒有症狀
 *
 * 學生自己輸入的在校百分比**不進入校內賽局模擬**。理由不是隱私，是
 * 正確性：模擬算的是**跨學生**的相對序位，所以甲同學把自己的百分比
 * 打錯成 5%，乙同學看到的序位就跟著錯——而乙完全不知道，他看到的
 * 是一個完全正常的畫面上一個完全正常的數字。
 *
 * 這一條在程式碼上的落實方式是 `starParticipants()`：它同時吃教務處
 * 匯入的 `AcademicRank` 與學生自己輸入的參考資料，而它**只用前者**，
 * 並把後者列進 `ignoredSelfEntered` 報出來。做成一支「兩個都收、只用
 * 一個」的函式而不是「只收一個」，是因為前者測得出來：測試餵它一個
 * 錯得很誇張的自填百分比，然後斷言其他學生的序位一個字都沒變。
 *
 * 會被寫壞的方式很具體，而且它是出於好意——「教務處還沒匯這位學生的
 * 百分比，但他自己填了，那就用他填的吧」。那個修改讓一位學生的自填
 * 數字排進了全校的隊伍裡。
 *
 * # 為什麼是 .mjs
 *
 * 與 `lib/admission.mjs`、`lib/star.mjs` 同一個理由：會算錯的東西要能
 * 在沒有資料庫的情況下驗。這裡每一支都是純函式，`tests/admissionRef.test.mjs`
 * 直接餵物件。資料層（`lib/admissionRefDb.ts`）只負責讀出來丟給它算。
 */

// ═════════════════════════════════════════════════════════════════
// §1 來源
// ═════════════════════════════════════════════════════════════════

/**
 * 五種來源，對應 schema 的 `SourceKind`。
 *
 * # 為什麼一定要有 HEARSAY，而且它的文案要好聽
 *
 * 因為不給「聽同學說的」這個選項的話，學生會選「官方文件」——他手上
 * 就是有一個數字，而選單裡沒有一個選項描述得出它的來歷。那筆資料從此
 * 帶著一個假的可信度，而且再也分不出來。
 *
 * 所以 HEARSAY 的標籤刻意寫得像一件正常的事（它本來就是），而不是
 * 「不可靠來源」這種讓人不想選的字。**誠實要比較好選，才會有人選。**
 *
 * `trust` 是 0 至 3 的整數，只用來排序與分級，不是機率也不是權重——
 * 它不會被乘進任何計算裡。
 */
export const SOURCE_KINDS = [
  {
    value: 'OFFICIAL_DOC',
    label: '官方文件',
    hint: '簡章 PDF、委員會的查詢頁、大考中心的統計表。填網址或文件名稱。',
    trust: 3,
  },
  {
    value: 'SCHOOL_OFFICE',
    label: '學校教務處給的',
    hint: '在校百分比、校內推薦辦法。填「教務處 X 老師」或那張紙的名稱。',
    trust: 3,
  },
  {
    value: 'CRAM_TEACHER',
    label: '補習班老師給的',
    hint: '老師上課講的、或發的講義。填是哪位老師、哪一堂。',
    trust: 2,
  },
  {
    value: 'STUDENT_NOTE',
    label: '我自己從別處抄來的，或記得的',
    hint: '看過但找不回原始出處的。誠實選這一個比選「官方文件」有用。',
    trust: 1,
  },
  {
    value: 'HEARSAY',
    label: '聽同學說的、網路論壇、坊間工具',
    hint: '這是一個可以選的選項。填聽誰說的、在哪裡看到的。',
    trust: 0,
  },
];

const SOURCE_BY_VALUE = new Map(SOURCE_KINDS.map((s) => [s.value, s]));

/** 這個來源的標籤與信任分。認不出來的一律當成最低分。 */
export function sourceTrustOf(sourceKind) {
  const hit = SOURCE_BY_VALUE.get(sourceKind);
  if (hit) return hit;
  // 認不出來時**不要當成中等**。新增一種來源而忘記加到上面那份清單時，
  // 它會被當成「不知道哪來的」——那是對的，而不是靜靜給它一個中間值。
  return { value: String(sourceKind ?? ''), label: '來源不明', hint: '', trust: 0 };
}

// ═════════════════════════════════════════════════════════════════
// §2 資料種類
// ═════════════════════════════════════════════════════════════════

/**
 * `AdmissionReference.kind` 與它的 `value` 形狀。
 *
 * `kind` 決定 `value` 怎麼讀，兩者要一起解讀（schema 註解寫的就是這件
 * 事）。做成一份帶 `shape` 的清單，是為了讓輸入介面、驗證與摘要三處
 * 共用同一份定義——散在三處的話，新增一種 kind 時只會有一處被改到，
 * 而漏掉的那一處的症狀是那一種資料存進去了卻不出現在建議裡。
 */
export const REF_KINDS = [
  {
    value: 'STAR_ROUND1',
    label: '繁星第一輪錄取標準',
    shape: 'percentile',
    /** 這一項是不是「某個校系的門檻」。建議要拿它跟自己的百分比比。 */
    threshold: true,
    unit: '%',
    hint: '該校系第一輪**最後一名錄取者**的在校成績百分比。不是平均，是最後一名。',
  },
  {
    value: 'STAR_ROUND2',
    label: '繁星第二輪錄取標準',
    shape: 'percentile',
    threshold: true,
    unit: '%',
    hint: '第二輪最後一名錄取者的在校百分比。不是每個校系都會公布。',
  },
  {
    value: 'STAR_VACANCY',
    label: '繁星缺額數',
    shape: 'count',
    threshold: false,
    unit: '名',
    hint: '該校系當年度第一輪之後的缺額。有缺額才有第二輪。',
  },
  {
    value: 'SIEVE_THRESHOLD',
    label: '個申篩選門檻級分',
    shape: 'sieve',
    threshold: false,
    unit: '級分',
    hint: '各校系實際篩到的級分組合。個申的門檻由當年報名者決定，歷年只是參考。',
  },
  {
    value: 'QUALIFY',
    label: '校系門檻與檢定標準',
    shape: 'rules',
    threshold: false,
    unit: '',
    hint: '簡章寫的在校百分比門檻（前 20%、30%…）與學測檢定標準（數 A 均標…）。',
  },
  {
    value: 'MY_PERCENTILE',
    label: '我自己的在校百分比',
    shape: 'percentile',
    threshold: false,
    unit: '%',
    /**
     * **只用於你自己的建議。** 這句話要出現在介面上，理由見檔頭：
     * 它不進入模擬，所以不會影響任何其他同學看到的序位。
     */
    selfOnly: true,
    hint: '五學期在校成績的全校排名百分比（越小越好）。教務處給的那個數字。',
  },
  {
    value: 'NOTE',
    label: '其他補充',
    shape: 'text',
    threshold: false,
    unit: '',
    hint: '沒有結構的補充，例如校內推薦辦法的重點、承辦老師交代的事。',
  },
];

const KIND_BY_VALUE = new Map(REF_KINDS.map((k) => [k.value, k]));

export function refKindOf(kind) {
  return KIND_BY_VALUE.get(kind) ?? null;
}

/**
 * 把使用者填的東西折成 `value` 該有的形狀，順便驗它。
 *
 * 回 `{ ok, value, error }`。**驗不過就不要存**——一筆 `kind` 是
 * `STAR_ROUND1` 而 `value` 裡沒有 percentile 的資料，在建議那一側
 * 會被安靜地跳過，而學生明明看到它躺在清單裡。
 */
export function buildRefValue(kind, input = {}) {
  const meta = refKindOf(kind);
  if (!meta) return { ok: false, value: null, error: `不認得的資料種類「${kind}」` };

  const num = (v) => {
    const cleaned = String(v ?? '')
      .replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/%|％/g, '')
      .trim();
    return cleaned === '' ? NaN : Number(cleaned);
  };

  switch (meta.shape) {
    case 'percentile': {
      const percentile = num(input.percentile);
      if (!Number.isFinite(percentile)) {
        return { ok: false, value: null, error: '請填一個百分比數字（例如 15.2）' };
      }
      // 在校百分比是 0 到 100，越小越好。超出範圍多半是把班排名或 PR 值
      // 填進來了，那兩個的方向與尺度都不一樣——PR 90 是很好，百分比 90
      // 是很差，而系統看不出使用者填的是哪一種。
      if (percentile < 0 || percentile > 100) {
        return {
          ok: false,
          value: null,
          error: `百分比要在 0 至 100 之間（越小越好），${percentile} 不在範圍內。填的是 PR 值嗎？`,
        };
      }
      return { ok: true, value: { percentile }, error: '' };
    }
    case 'count': {
      const count = num(input.count);
      if (!Number.isInteger(count) || count < 0) {
        return { ok: false, value: null, error: '缺額要填一個 0 以上的整數' };
      }
      return { ok: true, value: { count }, error: '' };
    }
    case 'sieve': {
      const subjects = String(input.subjects ?? '')
        .split(/[、,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const grades = String(input.grades ?? '')
        .split(/[、,，\s]+/)
        .map((s) => num(s))
        .filter((n) => Number.isFinite(n));
      if (subjects.length === 0 || grades.length === 0) {
        return { ok: false, value: null, error: '請填篩選科目與對應的級分（例如「國文、英文」與「13、12」）' };
      }
      if (subjects.length !== grades.length) {
        return {
          ok: false,
          value: null,
          error: `科目有 ${subjects.length} 個，級分有 ${grades.length} 個，數量對不上`,
        };
      }
      return { ok: true, value: { subjects, grades }, error: '' };
    }
    case 'rules': {
      const rules = String(input.rules ?? '').trim();
      if (!rules) return { ok: false, value: null, error: '請寫下你查到的門檻或檢定標準' };
      return { ok: true, value: { rules }, error: '' };
    }
    case 'text': {
      const text = String(input.text ?? '').trim();
      if (!text) return { ok: false, value: null, error: '請寫下要記的內容' };
      return { ok: true, value: { text }, error: '' };
    }
    default:
      return { ok: false, value: null, error: `資料種類「${kind}」還沒有對應的形狀` };
  }
}

/** 把 `value` 折成一句人看得懂的話。清單與建議共用。 */
export function describeRefValue(kind, value) {
  const meta = refKindOf(kind);
  const v = value ?? {};
  if (!meta) return '';
  switch (meta.shape) {
    case 'percentile':
      return Number.isFinite(v.percentile) ? `${v.percentile}%` : '（沒有數字）';
    case 'count':
      return Number.isFinite(v.count) ? `${v.count} 名` : '（沒有數字）';
    case 'sieve':
      return Array.isArray(v.subjects) && Array.isArray(v.grades)
        ? v.subjects.map((s, i) => `${s} ${v.grades[i]} 級分`).join('、')
        : '（沒有內容）';
    case 'rules':
      return String(v.rules ?? '');
    case 'text':
      return String(v.text ?? '');
    default:
      return '';
  }
}

/** 這一筆資料裡的數字。閘門靠它判斷建議裡的數字有沒有來源。 */
export function numbersIn(kind, value) {
  const meta = refKindOf(kind);
  const v = value ?? {};
  const out = [];
  const push = (n) => {
    if (Number.isFinite(n)) out.push(String(n));
  };
  if (!meta) return out;
  if (meta.shape === 'percentile') push(v.percentile);
  if (meta.shape === 'count') push(v.count);
  if (meta.shape === 'sieve' && Array.isArray(v.grades)) v.grades.forEach(push);
  // rules 與 text 是自由文字。裡面的數字也要算進來——學生把「前 20%」
  // 寫在門檻那一欄時，建議提到 20% 是有來源的，不該被閘門當成編的。
  if (meta.shape === 'rules' || meta.shape === 'text') {
    const raw = meta.shape === 'rules' ? v.rules : v.text;
    for (const m of String(raw ?? '').matchAll(/\d+(?:\.\d+)?/g)) out.push(m[0]);
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════
// §3 過期
//
// `staleAfterYear` 讓資料自己過期。學年度換了，去年的錄取標準**仍然
// 有參考價值**（歷年趨勢是唯一可用的東西），但它必須被標成「這是 115
// 學年度的資料，你現在看的是 116」。不標的話，一份三年前的數字會被當
// 成今年的門檻——而那正是學生最想要的那種誤讀。
// ═════════════════════════════════════════════════════════════════

/** 一天有幾毫秒。 */
const DAY = 86_400_000;

/** 超過這麼多天沒有再查過，就算「舊的」。一個招生年度的長度。 */
export const STALE_DAYS = 365;

/**
 * 這一筆過期了嗎，以及舊到什麼程度。
 *
 * @param {{year?: number, staleAfterYear?: number, lookedUpAt?: Date|string}} ref
 * @param {{currentYear: number, now?: Date}} ctx
 */
export function stalenessOf(ref, { currentYear, now = new Date() } = {}) {
  const after = Number.isFinite(ref?.staleAfterYear) ? ref.staleAfterYear : ref?.year;
  const cur = Number(currentYear);
  const staleBy = Number.isFinite(after) && Number.isFinite(cur) ? Math.max(0, cur - after) : 0;

  const at = ref?.lookedUpAt ? new Date(ref.lookedUpAt) : null;
  const ageDays =
    at && !Number.isNaN(at.getTime())
      ? Math.max(0, Math.floor((now.getTime() - at.getTime()) / DAY))
      : null;

  return {
    /** 學年度已經過了。 */
    stale: staleBy > 0,
    /** 過了幾個學年度。 */
    staleBy,
    /** 查到這筆資料距今幾天。查詢日期缺漏時是 null（schema 不允許，但別當機）。 */
    ageDays,
    /** 查了超過一年沒再確認。 */
    old: ageDays !== null && ageDays > STALE_DAYS,
  };
}

// ═════════════════════════════════════════════════════════════════
// §4 信任度
//
// 輸入之後要**立刻看得出這筆資料值多少信任**。官方文件 vs 聽同學說的、
// 今年 vs 三年前——這兩件事都會讓同一個數字的意義完全不同，而它們在
// 資料庫裡長得一樣。
// ═════════════════════════════════════════════════════════════════

/** 三級。刻意不給分數——一個 0.72 的可信度分數本身就是一種假精確度。 */
export const TRUST_SOLID = 'SOLID';
export const TRUST_WORKABLE = 'WORKABLE';
export const TRUST_WEAK = 'WEAK';

export const TRUST_LABELS = {
  SOLID: '可以照著做決定',
  WORKABLE: '可以參考',
  WEAK: '只能當線索',
};

/**
 * 這一筆值多少信任。
 *
 * 規則刻意簡單而且往保守的方向倒：
 *
 *   · 聽同學說的**永遠**只是線索。不管多新、不管抄得多像。
 *   · 學年度過了，降一級。**不是丟掉**——歷年趨勢是繁星唯一可用的
 *     東西，去年的門檻仍然有意義，只是不能當成今年的。
 *   · 查了超過一年沒再確認，降一級。
 *
 * 回傳裡的 `notes` 是給人看的句子，畫面直接印。做成句子而不是旗標，
 * 是因為「這是 114 學年度的資料，你現在看 116」這句話比一個灰色的
 * 「過期」標籤有用得多——後者學生會直接忽略。
 */
export function trustOf(ref, { currentYear, now = new Date() } = {}) {
  const src = sourceTrustOf(ref?.sourceKind);
  const age = stalenessOf(ref, { currentYear, now });
  const notes = [];

  let level = src.trust >= 3 ? TRUST_SOLID : src.trust >= 1 ? TRUST_WORKABLE : TRUST_WEAK;

  if (src.trust === 0) {
    notes.push('來源是聽說的，所以不管多新都只能當線索——去官方文件確認過再拿它做決定。');
  }
  if (age.stale) {
    level = level === TRUST_SOLID ? TRUST_WORKABLE : TRUST_WEAK;
    notes.push(
      `這是 ${ref.staleAfterYear ?? ref.year} 學年度的資料，你現在看的是 ${currentYear} 學年度` +
        `（過了 ${age.staleBy} 個學年度）。歷年趨勢仍然有參考價值，但它不是今年的門檻。`,
    );
  }
  if (age.old) {
    level = level === TRUST_SOLID ? TRUST_WORKABLE : TRUST_WEAK;
    notes.push(`你是 ${age.ageDays} 天前查的。招生資料一年全部重來一次，值得再確認一次。`);
  }

  return {
    level,
    label: TRUST_LABELS[level],
    sourceLabel: src.label,
    sourceTrust: src.trust,
    ...age,
    notes,
  };
}

// ═════════════════════════════════════════════════════════════════
// §5 隔離：學生自己輸入的百分比不進入模擬
//
// **這一節是整個檔案最重要的一段。** 理由見檔頭：模擬算的是跨學生的
// 相對序位，一個人填錯會讓別人看到錯的位置而不自知。
// ═════════════════════════════════════════════════════════════════

/**
 * 組出繁星校內賽局的參賽名單。
 *
 * 兩份輸入都收，**但只用教務處那一份**：
 *
 *   · `officialRanks` 是教務處匯入的 `AcademicRank`。**唯一的百分比來源。**
 *   · `references` 是學生自己輸入的參考資料。裡面可能有 `MY_PERCENTILE`，
 *     而它**一筆都不會被用來排序**——只被列進 `ignoredSelfEntered`。
 *
 * # 為什麼要收一份不會用的輸入
 *
 * 因為這樣才測得出來。做成「只收 officialRanks」的函式，測試只能斷言
 * 它做了它做的事；收兩份而只用一份，測試可以餵一個錯得很誇張的自填
 * 百分比（5% 而真實是 60%），然後斷言**其他學生的序位一個字都沒變**。
 * 那一條斷言就是這個決定的護欄。
 *
 * 而且 `ignoredSelfEntered` 有實際用途：畫面要說得出「你自己填的那個
 * 數字沒有進入模擬」。不說的話，學生填了之後看到序位沒變，會以為系統
 * 壞了然後再填一次。
 *
 * @param {{
 *   wishes: {userId: string, institutionName: string, starGroup: number, wishRank?: number}[],
 *   officialRanks: {userId: string, percentile: number}[],
 *   references: {userId: string, kind: string, value: object, forSelfOnly?: boolean}[],
 * }} input
 */
export function starParticipants({ wishes = [], officialRanks = [], references = [] } = {}) {
  const official = new Map();
  for (const r of officialRanks) {
    if (Number.isFinite(r?.percentile)) official.set(r.userId, r.percentile);
  }

  const participants = wishes.map((w) => ({
    userId: w.userId,
    // 教務處沒有匯這位學生的百分比時傳 null，**不要拿學生自填的補上，
    // 也不要傳 100**。`star.mjs` 會把他歸到 `unranked`，而那是對的：
    // 真正的問題是承辦人少匯了一列，不是這位學生排最後。
    percentile: official.has(w.userId) ? official.get(w.userId) : null,
    institutionName: w.institutionName,
    starGroup: w.starGroup,
    wishRank: w.wishRank,
  }));

  /**
   * 被刻意忽略的自填百分比。
   * @type {{userId: string, percentile: number, reason: string}[]}
   */
  const ignoredSelfEntered = [];
  for (const ref of references) {
    if (ref?.kind !== 'MY_PERCENTILE') continue;
    const p = ref.value?.percentile;
    if (!Number.isFinite(p)) continue;
    ignoredSelfEntered.push({
      userId: ref.userId,
      percentile: p,
      reason:
        '學生自己輸入的在校百分比只用於他自己的建議，不進入校內賽局模擬——' +
        '一個人填錯會讓其他同學看到錯的序位，而他們不會知道。' +
        '模擬只吃教務處匯入的那一份。',
    });
  }

  return { participants, ignoredSelfEntered };
}

// ═════════════════════════════════════════════════════════════════
// §6 建議的資料基礎
//
// AI 老師拿到的不是一堆原始列，而是這一支整理出來的「事實」。整理在
// 純函式裡的用意有兩個：**閘門要拿同一份事實去驗證輸出**（建議裡的
// 每一個數字都要對得回一筆參考資料），而且**資料缺什麼要算得出來**
// ——「只查了一年」這件事比任何結論都有用。
// ═════════════════════════════════════════════════════════════════

/**
 * @param {{
 *   references: object[],
 *   officialPercentile?: number|null,
 *   wishes?: object[],
 *   year: number,
 *   now?: Date,
 * }} input
 */
export function adviceBasis({
  references = [],
  officialPercentile = null,
  wishes = [],
  year,
  now = new Date(),
} = {}) {
  const withTrust = references.map((r) => ({
    ...r,
    describe: describeRefValue(r.kind, r.value),
    trust: trustOf(r, { currentYear: year, now }),
  }));

  const thresholds = withTrust
    .filter((r) => refKindOf(r.kind)?.threshold)
    .sort((a, b) => b.year - a.year);

  const selfPercentileRef = withTrust
    .filter((r) => r.kind === 'MY_PERCENTILE')
    .sort((a, b) => new Date(b.lookedUpAt ?? 0) - new Date(a.lookedUpAt ?? 0))[0] ?? null;

  const starWishes = wishes.filter((w) => w.channel === 'STAR');

  // ── 資料缺什麼 ────────────────────────────────────────────
  //
  // **這一段比結論有用。** 學生只查了一年就想要一個答案，而正確的
  // 回應是「只有一年看不出趨勢，去把前兩年也查一下」——那句話他做得到，
  // 而一個建立在單點上的結論他只能相信或不信。
  const gaps = [];
  const yearsWithThreshold = [...new Set(thresholds.map((t) => t.year))];

  /**
   * **逐校系**的年份。
   *
   * 「近三年」講的一定是某一個校系的門檻，所以年數要一個校系一個校系
   * 地數。合起來數的後果很具體：臺大 114、清大 113、成大 112 各一筆，
   * 三個不同的年份，於是「你查到臺大近三年的門檻相當穩定」通過了閘門
   * ——而臺大只有一年。
   *
   * 同一個錯誤還會關掉最有用的那句提示：合起來數是 3，於是
   * `ONE_YEAR_ONLY`（「去把前兩年補上」）對這三個校系一個都不會出現。
   *
   * 分組的鍵是「大學 × 系 × 學群」，因為門檻本來就是逐校系公布的；
   * 只用大學名分組的話，臺大電機與臺大財金會被當成同一條趨勢。
   */
  const byTarget = new Map();
  for (const t of thresholds) {
    const key = [t.institutionName ?? '', t.programName ?? '', t.starGroup ?? ''].join('｜');
    const hit = byTarget.get(key) ?? {
      key,
      institutionName: t.institutionName ?? '',
      programName: t.programName ?? null,
      starGroup: t.starGroup ?? null,
      label: [t.institutionName, t.programName, t.starGroup ? `第 ${t.starGroup} 類學群` : '']
        .filter(Boolean)
        .join(' '),
      years: [],
    };
    if (!hit.years.includes(t.year)) hit.years.push(t.year);
    byTarget.set(key, hit);
  }
  const targets = [...byTarget.values()].map((t) => ({
    ...t,
    years: [...t.years].sort((a, b) => b - a),
  }));
  /** 任何一個校系最多有幾年。閘門的「近三年」驗的是這個數字。 */
  const maxYearsPerTarget = targets.reduce((n, t) => Math.max(n, t.years.length), 0);

  if (starWishes.length > 0 && thresholds.length === 0) {
    gaps.push({
      code: 'NO_THRESHOLD',
      text:
        '你填了繁星志願，但還沒有輸入任何一筆該校系的錄取標準。' +
        '沒有門檻可以對照，所以現在沒有辦法說你落在哪裡。',
      lookFor: 'STAR_ROUND1',
    });
  }
  // 一個校系一句。年份最少的排前面——那是最值得先補的那一個。
  for (const t of [...targets].sort((a, b) => a.years.length - b.years.length)) {
    const where = t.label || '你查的那個校系';
    if (t.years.length === 1) {
      const only = t.years[0];
      gaps.push({
        code: 'ONE_YEAR_ONLY',
        text:
          `${where}你只查到 ${only} 學年度一年的錄取標準。一年看不出趨勢——` +
          `建議把 ${only - 1} 與 ${only - 2} 學年度也查一下，三年放在一起才看得出` +
          '這個校系的門檻是穩定的還是每年在跳。',
        lookFor: 'STAR_ROUND1',
        target: t.label,
      });
    } else if (t.years.length === 2) {
      gaps.push({
        code: 'TWO_YEARS_ONLY',
        text:
          `${where}你查到 ${t.years.join('、')} 兩年的錄取標準。再補一年會好得多——` +
          '兩點連得出一條線，但看不出那條線是不是真的。',
        lookFor: 'STAR_ROUND1',
        target: t.label,
      });
    }
  }
  if (officialPercentile === null && !selfPercentileRef) {
    gaps.push({
      code: 'NO_OWN_PERCENTILE',
      text:
        '教務處還沒有匯入你的在校成績百分比，你自己也還沒有輸入。' +
        '沒有這個數字，任何門檻都沒有辦法拿來比。',
      lookFor: 'MY_PERCENTILE',
    });
  }
  if (thresholds.length > 0 && thresholds.every((t) => t.trust.level === TRUST_WEAK)) {
    gaps.push({
      code: 'ALL_WEAK',
      text:
        '你輸入的錄取標準全部只能當線索（來源是聽說的、或已經過了學年度）。' +
        '去官方文件確認過再拿它做決定。',
      lookFor: 'STAR_ROUND1',
    });
  }

  // ── 閘門要用的數字白名單 ──────────────────────────────────
  const numbers = new Set();
  for (const r of withTrust) for (const n of numbersIn(r.kind, r.value)) numbers.add(n);
  if (Number.isFinite(officialPercentile)) numbers.add(String(officialPercentile));

  return {
    year,
    references: withTrust,
    thresholds,
    /** 教務處匯入的那一份。**這一份才是模擬用的。** */
    officialPercentile,
    /** 學生自己輸入的。只用於他自己的建議。 */
    selfPercentile: selfPercentileRef?.value?.percentile ?? null,
    selfPercentileRef,
    starWishes,
    gaps,
    /** 全部門檻資料涵蓋的年份（跨校系合計）。**不要拿它驗「近三年」。** */
    yearsWithThreshold,
    /** 逐校系的年份。 */
    targets,
    /** 任何**單一校系**最多有幾年。「近三年」要靠它驗。 */
    maxYearsPerTarget,
    numbers: [...numbers],
    hasOfficialDoc: withTrust.some((r) => r.sourceKind === 'OFFICIAL_DOC'),
    hasSchoolOffice: withTrust.some((r) => r.sourceKind === 'SCHOOL_OFFICE'),
  };
}
