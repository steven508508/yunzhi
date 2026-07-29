/**
 * 清單的分頁、搜尋與篩選。**純函式，不碰資料庫。**
 *
 * # 這一支補的是「第一天完美、第三個月無解」的那一類
 *
 * `/grades` 取 60 筆、`/assignments` 取 100 筆、`/bank` 取 100 筆，
 * 三頁都沒有分頁。7 個班 × 3 科 × 每週各一份 = 21 份／週，
 * **第三週越過 60、第五週越過 100**。而超過之後兩頁的提示互相指向
 * 對方（成績說「請從派卷進去」、派卷說「請到成績」），所以開學第一
 * 個月的每一場考試，從第三個月起在兩個入口同時消失。
 *
 * 資料完好，入口消失——而對使用者來說兩者沒有差別。
 *
 * # 為什麼是純函式而不是一個共用元件
 *
 * 因為三頁的欄位、權限範圍、排序都不同，共用元件只會變成一堆設定
 * 參數（`components/Table.tsx` 的檔頭刻意不做分頁，理由相同）。
 * 會出錯的其實只有那幾個**邊界**：
 *
 *   · 頁碼是 0、負數、`abc`、`1e9` —— 都會變成 `skip: NaN`，
 *     而 Prisma 對 NaN 的反應是丟出一個看不出原因的錯誤
 *   · 「還有沒有下一頁」用 `take + 1` 判斷，而多取的那一筆
 *     **不能被畫出來**——漏掉 slice 的話每一頁最後多一列，
 *     而它會在下一頁重覆出現
 *   · 最後一頁被刪光之後，`page` 還停在那裡 → 永遠空白的畫面
 *
 * 這幾件事每一頁各寫一次就是各錯一次，而且症狀都不是當機。
 */

/** 一頁幾筆。三頁共用同一個數字，讓「下一頁」在每一頁都是同一件事。 */
export const PAGE_SIZE = 40;

/**
 * 把網址上的 `?page=` 讀成一個安全的頁碼（1 起算）。
 *
 * 讀不懂、小於 1、或大得離譜的一律回 1。**不是丟錯**：這個值來自
 * 網址列，使用者手改或者連結被截斷都會發生，而一個 500 頁面對
 * 「頁碼打錯」是過度的反應。
 *
 * 上限 10 000 是為了擋 `?page=99999999999`——那會變成一次
 * `OFFSET 4e11` 的查詢，Postgres 會認真地掃過去。
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function parsePage(raw) {
  const n = Number.parseInt(String(raw ?? '1'), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 10_000);
}

/**
 * 這一頁要 `skip` 幾筆、`take` 幾筆。
 *
 * `take` 是 `size + 1`：**多取一筆只為了知道後面還有沒有**。
 * 用 `count()` 另外查一次也做得到，但那是每一頁多一次全表掃描，
 * 而我們要的只是一個布林值。
 *
 * @param {unknown} page
 * @param {number} [size]
 * @returns {{ skip: number, take: number, page: number, size: number }}
 */
export function pageQuery(page, size = PAGE_SIZE) {
  const p = parsePage(page);
  return { skip: (p - 1) * size, take: size + 1, page: p, size };
}

/**
 * 把多取一筆的結果切成「這一頁的資料」與「還有沒有下一頁」。
 *
 * **一定要用回傳的 `rows`，不能用傳進來的那個陣列。** 直接畫原陣列的
 * 話，每一頁的最後會多出一列，而它在下一頁的第一列重覆出現——
 * 看的人會以為資料重複了。
 *
 * @template T
 * @param {readonly T[]} rows 多取一筆的查詢結果
 * @param {unknown} page
 * @param {number} [size]
 * @returns {{ rows: T[], page: number, hasNext: boolean, hasPrev: boolean, from: number, to: number }}
 */
export function pageSlice(rows, page, size = PAGE_SIZE) {
  const p = parsePage(page);
  const hasNext = rows.length > size;
  return {
    rows: hasNext ? rows.slice(0, size) : rows,
    page: p,
    hasNext,
    hasPrev: p > 1,
    /** 這一頁第一列在整份清單裡是第幾筆（1 起算）。給「第 41–80 筆」用。 */
    from: rows.length === 0 ? 0 : (p - 1) * size + 1,
    to: (p - 1) * size + (hasNext ? size : rows.length),
  };
}

/**
 * 保留現有的查詢字串，只改其中幾個鍵。分頁與篩選的連結都靠它。
 *
 * # 為什麼這一支非有不可
 *
 * 因為「翻到第 2 頁」不能把使用者剛選好的科目與日期丟掉，而
 * 「換一個科目」必須把頁碼歸零——停在第 5 頁換科目的結果是一片空白，
 * 而使用者看到的是「這一科沒有東西」。
 *
 * 值是 `undefined` 或空字串的鍵會被拿掉，所以「全部」這個選項不必
 * 特別處理，網址也不會累積一串空參數。
 *
 * @param {string} base 例如 `/grades`
 * @param {Record<string, string | undefined>} current 目前的查詢參數
 * @param {Record<string, string | undefined>} patch 這次要改的
 * @returns {string}
 */
export function keepQuery(base, current, patch) {
  const merged = { ...current, ...patch };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `${base}?${s}` : base;
}

/**
 * 把 `?from=2026-09-01&to=2026-09-30` 讀成一個日期區間。
 *
 * 三件事刻意這樣做：
 *
 *   · **`to` 含當天。** 使用者填的 9/30 指的是「到 9 月 30 日為止」，
 *     而 `lte: 2026-09-30T00:00:00` 會把那一整天排除掉——一份 9/30
 *     下午截止的考試不見了，而畫面上完全看不出原因。所以往後加一天
 *     並用 `lt`。
 *   · **用台北時區的午夜**，不是 UTC 的。資料庫存 UTC、伺服器多半跑
 *     UTC，用 UTC 午夜切的話 9/1 08:00 之前截止的考試會落到 8 月。
 *     台北固定 UTC+8，沒有日光節約，所以減 8 小時就是那一天的開始。
 *   · **讀不懂就當作沒填**，不丟錯。這個值來自網址列。
 *
 * 回傳 `null` 代表這一端不設限。
 *
 * @param {unknown} fromRaw
 * @param {unknown} toRaw
 * @returns {{ gte: Date | null, lt: Date | null }}
 */
export function parseDayRange(fromRaw, toRaw) {
  return { gte: dayStartTaipei(fromRaw), lt: dayStartTaipei(toRaw, 1) };
}

/** 台北時區某一天的午夜（＝ UTC 的前一天 16:00）。`plusDays` 用在含當天的上界。 */
function dayStartTaipei(raw, plusDays = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];

  // **這一段不能省，而且不能只查 NaN。** `Date.UTC` 對 2026-02-30
  // 不會回 NaN，它會安靜地進位成 3 月 2 日——於是使用者填了一個不存在
  // 的日期，得到一個看起來完全正常、只是少了兩天資料的區間。
  // 所以先用同一組數字建一次日期，比對月與日有沒有被改掉。
  // （`lib/academicYear.ts` 的 `parseDay` 出於同一個理由做同一件事。）
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;

  // 台北固定 UTC+8 而且沒有日光節約，所以「那一天的 00:00」就是
  // UTC 的前一天 16:00。`plusDays` 讓上界含當天（見 `parseDayRange`）。
  return new Date(Date.UTC(y, mo - 1, d + plusDays, -8, 0, 0));
}

/**
 * 這次要看哪一個學年度。
 *
 * # 為什麼這件事要有一支函式
 *
 * 因為 `AcademicYear.isCurrent` 在此之前**唯一有行為的使用**是開班
 * 對話框的下拉預選。班級列表、成績、派卷、學生的任務清單全部沒有
 * 年度條件——第二年開學時列表上是十四個班，其中七個已經沒有人了，
 * 而看的人分不出是哪七個。
 *
 * 「預設當前、可以切歷史」這件事看起來只有兩行，但它有三個會安靜
 * 出錯的地方：
 *
 *   · **網址上的 id 不存在**（舊書籤、被刪掉的年度）→ 直接拿去查會
 *     得到一張空表，而使用者看到的是「這一年沒有班」
 *   · **一個學年度都還沒建** → `current` 是 undefined，
 *     若因此回一個 undefined 的篩選條件，Prisma 會查出全部或丟錯
 *   · **沒有任何一年是當前的**（有人把當前那一筆刪了）→ 預設值沒有
 *     依據，此時該顯示全部而不是空的
 *
 * 回 `null` 代表「不限年度」，那正好可以直接展開成一個空的 where。
 *
 * @param {unknown} raw 網址上的 `?year=`。`'all'` 代表全部年度。
 * @param {readonly {id: string, isCurrent?: boolean}[]} years 這個機構的學年度
 * @returns {string | null} 要篩的學年度 id，或 `null`（全部）
 */
export function resolveYearFilter(raw, years) {
  const param = String(raw ?? '').trim();
  if (param === 'all') return null;
  if (param) {
    // 認不得的 id 一律退回預設，**不是查一個不存在的年度**。
    // 後者得到的是一張空表，而空表與「這一年沒有班」長得一模一樣。
    const hit = years.find((y) => y.id === param);
    if (hit) return hit.id;
  }
  return years.find((y) => y.isCurrent)?.id ?? null;
}

/**
 * 搜尋字串。前後空白拿掉，太長的截斷。
 *
 * 截斷而不是拒絕：搜尋框被貼進一整段文字是常見的事（複製了一整列），
 * 而回一句「太長」對使用者沒有任何幫助。空字串回 `null`，
 * 讓呼叫端可以直接 `...(q ? {...} : {})`。
 *
 * @param {unknown} raw
 * @param {number} [max]
 * @returns {string | null}
 */
export function parseSearch(raw, max = 80) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  return s.slice(0, max);
}
