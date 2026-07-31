/**
 * 選項與答案鍵的正規化。**純函式，沒有任何相依。**
 *
 * 放在這裡而不是寫在 commit.ts 裡，是因為它有兩個呼叫端：
 * 正式路徑（`lib/commit.ts`）與端到端測試用的 `tools/commit-shim.mjs`
 * （測試環境沒有 Prisma 引擎，所以那支是另一份實作）。
 *
 * 兩份實作分歧的風險是這個專案目前最脆弱的一處——測試會綠燈而
 * 正式環境會壞。把「會算錯答案」的那一段抽出來共用，至少讓最危險
 * 的部分只有一份。
 *
 * 寫成 .mjs 而不是 .ts：commit-shim 是直接跑在 node 上的，
 * 不經過 TypeScript 編譯。型別由同名的 .d.ts 提供。
 */

/**
 * 把選項重新編號，並把答案鍵一起對映過去。
 *
 * **這兩件事不能分開做。** 選項序號必須從 1 連續（`questions` 的
 * 選擇題檢核要求），所以丟掉內容為空的選項之後要重新編號；而
 * `answerKeys` 存的就是那個序號。分開做的話：
 *
 *     原稿  (1)60元 (2)70元 (3)80元 (4)90元   answerKeys=[4]
 *     掃描漏抓 (2)                            → 重編號後 4 應該變成 3
 *     入庫    (1)60元 (2)80元 (3)90元         answerKeys=[4] ← 指到「90元」以外的東西
 *
 * 沒有任何錯誤訊息。題目以 DRAFT 入庫，老師發布之後每一個
 * 答對的學生都被判錯。`answerKeys` 是 `Int[]`，對 `question_options`
 * 沒有外鍵也沒有 CHECK，資料庫層完全擋不住。
 *
 * @param {unknown} raw 候選題上的 options（JSON 欄位，形狀不保證）
 * @param {number[]} answerKeys 原稿的答案鍵
 * @returns {{options: {order:number,label:string,content:string}[],
 *            answerKeys: number[], dropped: number[], duplicates: string[][]}}
 *          dropped 是**對不上任何選項**的答案鍵。有值就代表這一題
 *          不該入庫——不猜、不硬塞、不靜默丟掉。
 *          duplicates 是**內容一模一樣的選項**，成對列出標籤。理由見下。
 */
export function normalizeOptions(raw, answerKeys = []) {
  if (!Array.isArray(raw)) {
    return { options: [], answerKeys: [...answerKeys], dropped: [], duplicates: [] };
  }

  const kept = [];
  for (const [i, o] of raw.entries()) {
    if (!o || typeof o !== 'object') continue;
    const content = String(o.content ?? '').trim();
    if (!content) continue;
    const order = Number(o.order) || i + 1;
    kept.push({ order, label: String(o.label ?? order), content });
  }
  kept.sort((a, b) => a.order - b.order);

  const remap = new Map();
  const options = kept.map((o, i) => {
    remap.set(o.order, i + 1);
    return { ...o, order: i + 1 };
  });

  // ── 兩個選項一模一樣 ────────────────────────────────────────────
  //
  // 這是「有東西被讀掉了」最可靠的徵兆，而被讀掉的通常是最細的
  // 那一筆：向量的箭頭（$\vec{v}$ → $v$）、指數的上標、負號、單位。
  // 物理與數學最常中招。
  //
  // 症狀與上面那個 dropped 是同一類，只是更隱蔽：選項數量對、答案
  // 是合法的序號、校對者一眼掃過去不會停。但兩個無法區分的選項
  // 意味著這一題沒有唯一解，而每一個選到「另一個一樣的」的學生
  // 都被判錯——沒有任何跡象。
  const byContent = new Map();
  const duplicates = [];
  for (const o of options) {
    const key = o.content.replace(/\s+/g, ' ');
    if (byContent.has(key)) duplicates.push([byContent.get(key), o.label]);
    else byContent.set(key, o.label);
  }

  const mapped = [];
  const dropped = [];
  for (const k of answerKeys) {
    const to = remap.get(k);
    if (to === undefined) dropped.push(k);
    else mapped.push(to);
  }
  mapped.sort((a, b) => a - b);
  return { options, answerKeys: mapped, dropped, duplicates };
}

// ─────────────────────────────────────────────────────────────────
// 附圖的歸屬
// ─────────────────────────────────────────────────────────────────

/**
 * 附圖標記。`![[a:fig1]]` 指向資產清單裡 id 為 `fig1` 的那一張。
 *
 * **這條規則全系統有三份，寬窄必須一模一樣**：這裡、`lib/math.mjs` 的
 * `ASSET_REF`（畫面上真的把圖排出來的那一支）、`apps/ai/pipeline/canonical.py`
 * 的 `ASSET_REF`（管線那邊驗「圖都對得起來」的那一支）。
 *
 * 為什麼不直接用 `lib/math.mjs` 匯出的那一份：這個檔案刻意零相依
 * （理由見檔頭——`tools/commit-shim.mjs` 是直接跑在 node 上的），而
 * math.mjs 匯入 katex 與 mhchem。為了共用一個正規表示式把整個 KaTeX
 * 拉進入庫路徑不划算。代價是三份要同步，所以
 * `tests/questionShape.test.mjs` 有一條測試把這裡與 math.mjs 的行為
 * 釘在一起——寬窄一旦分歧，症狀是「管線說圖都對得起來，畫面上卻
 * 印出一串 ![[a:...]]」，而那串東西看起來就像 AI 抽壞了字。
 *
 * **已知的唯一差異**：math.mjs 是先切數學式再找標記，所以寫在
 * `$…$` 裡面的標記那邊不算、這裡算。方向是安全的（這裡比較嚴，
 * 只會多擋不會少放），完整的理由與代價寫在那條測試裡。
 */
const ASSET_REF = /!\[\[a:([A-Za-z0-9_-]{1,32})\]\]/g;

/** 這一段文字引用了哪幾張附圖，依出現順序、去重。 */
export function referencedAssetIds(text) {
  const src = text == null ? '' : String(text);
  const out = [];
  for (const m of src.matchAll(ASSET_REF)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * 這一段文字裡**指不到任何一張圖**的標記 id。
 *
 * 給已經分好欄位的資料用（題庫裡的題目：`Question.contentAssets`、
 * `QuestionOption.assets`、`QuestionGroup.stimulusAssets` 各存各的），
 * 那時候沒有一個平的清單可以餵給 `partitionAssets`。
 *
 * 有值就代表學生會在那個位置看到一行「這裡有一張附圖，但系統找不到它」。
 */
export function missingAssetRefs(text, assets) {
  const known = new Set();
  for (const a of Array.isArray(assets) ? assets : []) {
    if (a && typeof a === 'object' && typeof a.id === 'string' && a.id) known.add(a.id);
  }
  return referencedAssetIds(text).filter((id) => !known.has(id));
}

/**
 * 把一題的附圖分給它該去的地方：題組素材、題幹、各個選項。
 *
 * # 為什麼要分
 *
 * 匯入管線把一題用到的圖**全部放在一個平的清單**上
 * （`ImportCandidate.assets`），因為那時候還不知道它們會被寫進哪一欄。
 * 資料庫這一端則是分三處存的：`QuestionGroup.stimulusAssets`、
 * `Question.contentAssets`、`QuestionOption.assets`——而渲染端
 * （`<MathText assets={…}>`）一次只收一段文字與它自己的那一份清單。
 *
 * 不分的後果不是「圖少了一張」，是**整題無法作答**：物理題四個選項
 * 是四張力圖時，選項各自印一行「〔這裡有一張附圖，但系統找不到它〕」，
 * 而那四張圖因為 id 沒被題幹用到，會被 `MathText` 的 `rest` 一起堆到
 * 題幹後面——四張沒有標號的圖配四個沒有圖的選項。
 *
 * # 為什麼是「算出來」而不是「存一份在選項裡」
 *
 * 另一個看起來也合理的選項是讓管線在 `options` 這個 Json 裡就多存一個
 * `assets` 欄位。不選它的理由是**那會有兩份真相**：標記寫在文字裡、
 * 歸屬存在旁邊，而老師在校對頁把 `![[a:o1]]` 從甲選項剪到乙選項時
 * 只會改到文字。歸屬由文字算出來的話，剪貼之後自然就對了。
 *
 * 同一個函式同時被校對頁（畫預覽）與入庫（寫資料庫）呼叫，這是
 * 「校對畫面等於學生畫面」這條驗收標準唯一守得住的作法。
 *
 * # 沒有被任何標記指到的圖去哪裡
 *
 * 跟著題幹（`contentAssets`）。講義那條路用垂直重疊把圖分派給題目，
 * 產出的圖本來就沒有 id、題幹裡也沒有標記，而 `MathText` 會把它們
 * 排在題幹後面——那是主要路徑，不是補漏（見 components/MathText.tsx）。
 *
 * @param {{assets?: unknown, stimulus?: unknown, content?: unknown,
 *          options?: unknown}} input
 * @returns {{stimulusAssets: object[], contentAssets: object[],
 *            optionAssets: {order:number,label:string,assets:object[]}[],
 *            missing: {where:string,id:string}[]}}
 *          `missing` 是**指向不存在的圖的標記**。有值就代表學生會在
 *          那個位置看到一行「這裡有一張附圖，但系統找不到它」。
 */
export function partitionAssets({ assets, stimulus, content, options } = {}) {
  const list = Array.isArray(assets)
    ? assets.filter((a) => Boolean(a) && typeof a === 'object')
    : [];
  const byId = new Map();
  for (const a of list) {
    if (typeof a.id === 'string' && a.id && !byId.has(a.id)) byId.set(a.id, a);
  }

  const used = new Set();
  const missing = [];
  /** 一段文字要的那幾張圖，依標記出現的順序。 */
  const pick = (text, where) => {
    const out = [];
    for (const id of referencedAssetIds(text)) {
      const a = byId.get(id);
      if (!a) {
        missing.push({ where, id });
        continue;
      }
      used.add(id);
      out.push(a);
    }
    return out;
  };

  const stimulusAssets = pick(stimulus, '題組前導敘述');
  const contentAssets = pick(content, '題幹');

  const rows = Array.isArray(options) ? options : [];
  const optionAssets = rows.map((o, i) => {
    const order = Number(o?.order) || i + 1;
    const label = String(o?.label ?? order);
    return { order, label, assets: pick(o?.content, `選項 (${label})`) };
  });

  // 沒有被任何標記指到的一律跟著題幹。**順序照原清單**，不是照
  // 被發現的順序——`figureAlt` 用索引編號（「本題附圖（2）」），
  // 順序抖動的話同一張圖在兩個畫面上會有兩個編號。
  for (const a of list) {
    if (typeof a.id === 'string' && a.id && used.has(a.id)) continue;
    contentAssets.push(a);
  }

  return { stimulusAssets, contentAssets, optionAssets, missing };
}

/**
 * 題目附圖，入庫時的形狀。
 *
 * # 為什麼在這裡而不是在 commit.ts 裡
 *
 * 與 `normalizeOptions` 同一個理由：它有兩個呼叫端（`lib/commit.ts`
 * 與端到端測試用的 `tools/commit-shim.mjs`），而兩份實作分歧的方向
 * 若是「測試那份少一個欄位」，測試會綠燈而正式環境會壞。
 *
 * # 漏一個欄位的症狀
 *
 * **整條路都對，只有入庫之後圖不見了**，而校對介面上看起來完全正常
 * ——那一頁讀的是 `ImportCandidate.assets`，不是這裡寫出去的東西。
 * 所以每個欄位都要說得出它是給誰用的：
 *
 *   · `id`   —— 題幹裡 `![[a:fig1]]` 指的名字。**漏掉它，圖還在，但
 *                沒有任何標記對得到它**，於是題幹中間留著一句
 *                「這裡有一張附圖，但系統找不到它」，圖被擠到題幹
 *                後面——幾何題的「如右圖」就指向了錯的地方。
 *   · `alt`  —— 替代文字。用螢幕閱讀器的學生聽到的就是它。
 *   · `width`/`height` —— 這張圖該畫多大（CSS 像素，由裁圖那一刻的
 *                原稿幾何換算，見 apps/ai/pipeline/figures.py 的
 *                `display_size`）。沒有它們的圖在載入完成的那一刻會把
 *                整段題幹往下推，而學生正在讀。
 *   · `page`/`bbox` —— 回頭對照原稿用。
 *
 * 沒有物件鍵的項目一律丟掉：沒有鍵就沒有圖可顯示，留著只會在畫面上
 * 變成一個破圖。回傳空陣列時給 `undefined`，讓「有沒有圖」的查詢
 * 單純一點（那一欄存 null 而不是 `[]`）。
 */
export function normalizeAssets(raw) {
  if (!Array.isArray(raw)) return undefined;

  /** 0、負數、字串都不是尺寸。`width="0"` 的圖在瀏覽器上不存在。 */
  const size = (v) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;

  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    if (typeof a.key !== 'string' || !a.key) continue;
    out.push({
      id: typeof a.id === 'string' && a.id ? a.id : null,
      key: a.key,
      page: typeof a.page === 'number' ? a.page : null,
      bbox: a.bbox ?? null,
      // 模型抽到的替代文字優先；沒有就用圖內的文字（座標軸標籤、點名）
      // 頂著。正式的替代文字要由 AI 依題幹生成（文件 01 的無障礙要求），
      // 那是另一個階段——但**在那之前也不可以是空字串**：空字串在無障礙
      // 的約定裡是「這張圖純裝飾，跳過它」，而這裡的圖是題目的條件。
      // 真的沒有素材時由渲染端補上「第 3 題附圖」（lib/math.mjs 的 figureAlt）。
      alt:
        typeof a.alt === 'string' && a.alt.trim()
          ? a.alt.trim()
          : Array.isArray(a.labels)
            ? a.labels.filter((t) => typeof t === 'string').join(' ')
            : '',
      caption: typeof a.caption === 'string' ? a.caption : '',
      width: size(a.width),
      height: size(a.height),
      kind: typeof a.kind === 'string' ? a.kind : 'FIGURE',
    });
  }
  return out.length ? out : undefined;
}
