/**
 * 把題目內容裡的數學式、化學式與附圖排出來。
 *
 * # 為什麼附圖的標記也在這一支
 *
 * 因為它們**混在同一段文字裡**：`已知 $x>0$，![[a:fig1]] 中的角 A 為…`。
 * 分兩層處理的話，先跑數學再切圖的那一層會拿到已經是 HTML 的字串，
 * 而在 HTML 裡找標記要嘛誤中 KaTeX 排出來的內容、要嘛得再解析一次；
 * 反過來先切圖的那一層又會把 `$…$` 從中間剖開。切分只能做一次，
 * 而這裡就是那一次。
 *
 * # 這一支處理的是「抽出來了卻印不出來」
 *
 * 匯入管線費了很大力氣把 `$\vec{F}$`、`$\ce{2H2 + O2 -> 2H2O}$` 從題本裡
 * 讀出來（見 apps/ai/pipeline/canonical.py 的 VEC_REF 與 CHEM_REF），
 * 而畫面上一直是把那串反斜線原樣印出來。學生看到的是
 * `$\ce{2H2 + O2 -> 2H2O}$`，老師在校對頁看到的也是同一串——
 * **他根本沒辦法用那個畫面確認式子有沒有抽對**，而校對頁存在的
 * 唯一理由就是那件事。
 *
 * # 為什麼是字串處理而不是丟給正規表示式
 *
 * 分隔符的規則不是「找出成對的 $」那麼單純，有三種東西會咬到：
 *
 *   · `\$` 是錢，不是數學式的開頭（管線的 MATH_DELIM 也是這樣定的）
 *   · `\\` 是換行，它後面那個字元不能被當成跳脫的對象
 *   · 落單的 `$` 一定會出現（AI 抽壞、老師手打漏一個）
 *
 * 第三種是這裡最重要的一條：落單的 `$` **只變成一個錢字號，不會把
 * 後面整段話吃掉**。用正規表示式配對的寫法在這一種情況下會把題幹
 * 剩下的一半當成數學式排版，排出來是一團亂碼，而學生沒有別的地方
 * 可以看到那半題。
 *
 * # 為什麼行內數學式對空白這麼挑
 *
 * 因為英文科的閱讀測驗裡有錢：
 *
 *     The ticket costs $25, but the VIP seat costs $60.
 *
 * 單純配對的話，`25, but the VIP seat costs ` 會被當成一個數學式。
 * 所以行內的 `$…$` 多要求兩件事——內容不以空白開頭或結尾、而且不跨行。
 * 上面那一句的收尾 `$` 前面是空白，配對就不成立，兩個 `$` 都退回普通
 * 字元。代價是老師手打的 `$ x $`（分隔符旁邊多打了空格）不會被當成
 * 數學式，而那一種**在畫面上看得見**（原樣印出 `$ x $`），老師自己
 * 就會改掉；被吃掉的半題則沒有任何線索。
 *
 * # 這裡是全站儲存型 XSS 的唯一入口
 *
 * 輸出是要塞進 `dangerouslySetInnerHTML` 的 HTML 字串，而題目內容
 * 來自 AI 抽取與老師輸入——兩個都不可信。KaTeX 自己會轉義它收到的
 * TeX（實測 `<script>` 會變成 `&lt;script&gt;`），但**非數學的那些
 * 純文字片段是我們自己拼進去的**，漏掉一次轉義就是整站的儲存型 XSS：
 * 一題被寫進題庫，之後每一個打開那一題的老師與學生都中。
 * 所以 `escapeHtml` 不是防禦性程式設計，是這一支的主要工作。
 */
import katex from 'katex';

/**
 * mhchem 是**副作用匯入**：它把 `\ce` 與 `\pu` 註冊進 KaTeX 的巨集表，
 * 沒有任何具名匯出。所以它必須在第一次 `renderToString` 之前執行到，
 * 而 ESM 的靜態匯入保證了這件事（匯入求值早於模組本體）。
 *
 * 少了這一行的症狀不是報錯，是每一條化學反應式都變成紅色的
 * `\ce{2H2 + O2 -> 2H2O}`——KaTeX 不認得 `\ce`，就當成未定義的命令。
 */
import 'katex/contrib/mhchem';

/**
 * 全站共用的排版選項。
 *
 * 每一項都是為了擋掉一種具體的災難，不是抄來的預設值：
 */
const KATEX_OPTIONS = {
  /**
   * **這一項是這頁不會變白畫面的原因。** 題庫裡一定會有 AI 抽壞的
   * 式子（缺右括號、全形符號沒換掉）。丟出例外的話，React 在伺服器端
   * 渲染時整頁失敗，學生看到的是錯誤頁而不是「其中一題排不出來」。
   */
  throwOnError: false,
  /** 排不出來的式子印成硃砂紅的原始碼。與設計語彙的校對記號同色。 */
  errorColor: '#8C3A2B',
  /**
   * `strict` 預設是 `'warn'`，而題目裡到處是 `\text{公尺}` 這種
   * 中文——每渲染一次就往伺服器 log 丟一行 unicodeTextInMathMode。
   * 一頁五十題就是五十行，真正的錯誤會被埋掉。這裡要的行為
   * （照排出來）與 warn 相同，差別只在不吵。
   */
  strict: 'ignore',
  /**
   * `\href`、`\includegraphics`、`\htmlStyle` 這一類會把外部 URL 與
   * 任意樣式帶進畫面的命令一律不放行。題目內容不可信，而這套系統
   * 部署在封閉網段——一個 `\includegraphics{http://…}` 既是對外連線，
   * 也是一條追蹤像素。這是 KaTeX 的預設值，寫出來是因為它值得被看見。
   */
  trust: false,
  /**
   * `\rule{9999em}{9999em}` 排出來會把整頁版面撐爛。預設是 Infinity，
   * 也就是完全信任內容給的尺寸——而內容正是不可信的那一方。
   */
  maxSize: 50,
  /** 巨集展開上限，擋 `\def` 寫出來的無限迴圈。這是預設值。 */
  maxExpand: 1000,
  /**
   * 同時輸出 MathML。讀螢幕的人靠它才聽得到式子——只有 HTML 的話
   * 讀出來是一串沒有意義的單字元。規格書要求 WCAG 2.1 AA。
   */
  output: 'htmlAndMathml',
};

/**
 * HTML 轉義。
 *
 * 五個字元都要轉：`<` `>` 擋標籤，`&` 擋實體，`"` `'` 擋屬性值逃逸
 * （輸出也會被放進 `title="…"`）。少轉 `&` 的話 `&lt;script&gt;`
 * 這種已經轉義過的內容會被還原成真的標籤。
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 從 `from` 開始找收尾的分隔符，回傳它的索引；找不到回 -1。
 *
 * 跳脫序列整組跳過（`\$` 在數學模式裡是錢字號、`\\` 是換行），
 * 否則 `$\text{\$5}$` 這種會在中間就被切斷。
 */
function findClosing(src, from, display) {
  let i = from;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '$') {
      if (!display) return i;
      if (src[i + 1] === '$') return i;
      // 獨立公式裡的單一個 `$`（例如 `\text{$x$}`）不是收尾，繼續找。
      i += 1;
      continue;
    }
    // 行內數學式不跨行。漏掉的收尾分隔符不該把下一段話一起吃掉。
    if (!display && ch === '\n') return -1;
    i += 1;
  }
  return -1;
}

/** 這一段像不像數學式。理由見檔頭「為什麼行內數學式對空白這麼挑」。 */
function looksLikeMath(body, display) {
  if (body.trim() === '') return false;
  if (display) return true;
  return !/^\s/.test(body) && !/\s$/.test(body);
}

/**
 * 附圖標記。`![[a:fig1]]` 指向資產清單裡 id 為 `fig1` 的那一張。
 *
 * 這條規則**必須與 `apps/ai/pipeline/canonical.py` 的 `ASSET_REF` 一模一樣**
 * （含 id 只收 `[A-Za-z0-9_-]{1,32}`）。兩邊寬窄不同的症狀是：管線那邊
 * 驗過說「這一題的圖都對得起來」，畫面上卻印出一串 `![[a:...]]`，
 * 而那串東西在校對介面看起來就像 AI 抽壞了字。
 *
 * 用 `y` 旗標從指定位置起配對，不掃全文——`splitMath` 是逐字走的，
 * 每個位置都跑一次全域搜尋會變成 O(n²)，而閱讀測驗的素材有好幾千字。
 */
const ASSET_REF = /!\[\[a:([A-Za-z0-9_-]{1,32})\]\]/y;

/**
 * 把一段混排的內容切成文字、數學式與附圖。
 *
 * 回傳的每一段都帶 `kind`：`text` 是純文字（**還沒轉義**），
 * `inline` 與 `display` 的 `value` 是分隔符裡面的 TeX（不含分隔符），
 * `asset` 的 `value` 是附圖的 id（不含 `![[a:` 與 `]]`）。
 *
 * 切分與渲染刻意分開：切分是純字串處理，沒有相依，所以測得動；
 * 而會出錯的邊界情況（跳脫、落單分隔符、錢、寫壞的標記）全部在這一層。
 */
export function splitMath(source) {
  const src = source == null ? '' : String(source);
  const out = [];
  let text = '';

  const flush = () => {
    if (text !== '') {
      out.push({ kind: 'text', value: text });
      text = '';
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === '\\') {
      const next = src[i + 1];
      if (next === undefined) {
        text += ch;
        i += 1;
        continue;
      }
      // `\$` 是錢字號，不是數學式的開頭。這是管線那邊的約定
      // （canonical.py 的 `MATH_DELIM = (?<!\\)\$`），兩邊要一致。
      if (next === '$') {
        text += '$';
        i += 2;
        continue;
      }
      // 其他跳脫序列在數學式外沒有意義，原樣留著。整組跳過是為了
      // 讓 `\\$` 的那個 `$` 仍然算數學式的開頭。
      text += ch + next;
      i += 2;
      continue;
    }

    if (ch === '$') {
      const display = src[i + 1] === '$';
      const width = display ? 2 : 1;
      const close = findClosing(src, i + width, display);
      if (close >= 0) {
        const body = src.slice(i + width, close);
        if (looksLikeMath(body, display)) {
          flush();
          out.push({ kind: display ? 'display' : 'inline', value: body });
          i = close + width;
          continue;
        }
      }
      // 落單或不像數學式的 `$`：當成普通字元，**只吃掉自己**。
      text += ch;
      i += 1;
      continue;
    }

    if (ch === '!' && src[i + 1] === '[') {
      ASSET_REF.lastIndex = i;
      const m = ASSET_REF.exec(src);
      if (m) {
        flush();
        out.push({ kind: 'asset', value: m[1] });
        i += m[0].length;
        continue;
      }
      // 寫壞的標記（`![[a:]]`、少一個括號、id 太長）**只吃掉那個驚嘆號**，
      // 剩下的原樣留在文字裡。整段吞掉的話，畫面上是題幹從某個字開始
      // 少了一截，而老師在校對介面看不出少了什麼；留著至少看得見
      // 那串壞掉的標記，才有人會去修。
      text += ch;
      i += 1;
      continue;
    }

    text += ch;
    i += 1;
  }

  flush();
  return out;
}

/** 這一段裡面有沒有數學式或附圖。用切分結果判斷，與實際渲染的行為一致。 */
export function hasMath(source) {
  return splitMath(source).some((seg) => seg.kind !== 'text');
}

/** 這一段引用了哪幾張附圖，依出現順序、去重。 */
export function referencedAssets(source) {
  const seen = [];
  for (const seg of splitMath(source)) {
    if (seg.kind === 'asset' && !seen.includes(seg.value)) seen.push(seg.value);
  }
  return seen;
}

/**
 * 排一個式子。
 *
 * `throwOnError: false` 已經讓 KaTeX 把「看不懂的 TeX」自己畫成紅字，
 * 但那只涵蓋它自己丟的 ParseError。巨集展開超限、內部狀態壞掉這一類
 * 會丟別的例外出來，而在 server component 裡那等於整頁 500。
 * 所以外面還要再包一層——**一題壞掉就整頁打不開是不能接受的**。
 */
function renderOne(tex, display) {
  try {
    return katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    const delim = display ? '$$' : '$';
    return (
      `<span class="yz-math__bad" title="${escapeHtml(why)}">` +
      escapeHtml(delim + tex + delim) +
      '</span>'
    );
  }
}

/**
 * 把一段混排的內容排成 HTML 字串。
 *
 * **這個回傳值會被塞進 `dangerouslySetInnerHTML`**，所以純文字片段
 * 一律先過 `escapeHtml`。KaTeX 的輸出本身是可信的（它轉義自己的輸入，
 * 而且 `trust: false` 關掉了會產生連結與內嵌樣式的命令）。
 *
 * 附圖排成一個**看得出是圖的小記號**而不是真的 `<img>`：這一支只收
 * 一個字串，沒有資產清單也就沒有物件鍵可以指。真的要把圖畫出來的
 * 呼叫端走 `<MathText assets={…}>`，它會自己處理 asset 那幾段。
 * 留一個記號而不是原樣印出 `![[a:fig1]]`，是因為後者在題庫清單上
 * 看起來就像 AI 抽壞了字，而且會佔掉整行的寬度。
 */
export function renderMathHtml(source) {
  let html = '';
  for (const seg of splitMath(source)) {
    if (seg.kind === 'text') html += escapeHtml(seg.value);
    else if (seg.kind === 'asset') html += '<span class="yz-fig__ref">〔附圖〕</span>';
    else html += renderOne(seg.value, seg.kind === 'display');
  }
  return html;
}

// ─────────────────────────────────────────────────────────────────
// 附圖清單
//
// `Question.contentAssets`、`QuestionOption.assets`、
// `ImportCandidate.assets` 三個欄位都是 Json，形狀由匯入管線寫入
// （見 lib/commit.ts 的 normalizeAssets）。**這裡不假設它一定是
// 那個形狀**：舊資料、手改過的列、或管線改版都可能塞進別的東西，
// 而一個 `.map` 丟出的 TypeError 會讓整題變成一片白——在作答中。
// ─────────────────────────────────────────────────────────────────

/** 這個值是不是一個正數。寬高只有正數才有意義（0 會讓瀏覽器算出 0 高）。 */
function positive(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

/**
 * 把 Json 欄位讀成附圖清單。壞掉的項目直接略過，不丟例外。
 *
 * `width`／`height` 是**裁圖時量到的像素尺寸**，給 `<img>` 的 width/height
 * 屬性用。沒有它們的圖在載入完成的那一刻會把整段文字往下推——學生
 * 正在讀第三行，畫面忽然跳掉兩公分，而他不知道自己讀到哪裡了。
 * 舊資料沒有這兩欄（裁圖那時候還沒量），所以它們是可有可無的。
 */
export function readAssets(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const key = a.key;
    if (typeof key !== 'string' || key === '') continue;
    out.push({
      // id 是題幹裡 `![[a:id]]` 指的那個名字。沒有 id 的圖對不到任何
      // 標記，會被排在題幹後面——講義那條路（切分階段用垂直重疊分派）
      // 產出的圖本來就沒有 id，那是正常的，不是資料壞了。
      id: typeof a.id === 'string' && a.id ? a.id : null,
      key,
      alt: typeof a.alt === 'string' ? a.alt.trim() : '',
      caption: typeof a.caption === 'string' ? a.caption.trim() : '',
      labels: Array.isArray(a.labels) ? a.labels.filter((t) => typeof t === 'string' && t.trim()) : [],
      width: positive(a.width),
      height: positive(a.height),
      kind: typeof a.kind === 'string' ? a.kind : 'FIGURE',
    });
  }
  return out;
}

/**
 * 替代文字。
 *
 * # 為什麼不可以是空字串
 *
 * `alt=""` 在無障礙的約定裡是「這張圖純裝飾，跳過它」。而這裡的圖
 * 是**題目的條件**——幾何題的角度、函數的圖形、實驗的裝置。跳過它
 * 等於這一題對用螢幕閱讀器的學生少了一個條件，而他不會知道少了什麼：
 * 畫面上什麼都沒有發生。
 *
 * 所以沒有圖說時退回一個**可辨識的位置描述**（「第 3 題附圖」），
 * 至少讓他知道「這裡有一張圖，我需要有人念給我聽」。這比空字串
 * 差得遠，但比空字串誠實。
 *
 * 素材的優先序：AI 抽的 alt → 原稿的圖說（「▲圖一」）→ 圖內的文字
 * （座標軸標籤、點名）→ 位置描述。
 */
export function figureAlt(asset, { label = '', index = 0, count = 1 } = {}) {
  const written = asset?.alt || asset?.caption || (asset?.labels ?? []).join('　').trim();
  if (written) return written;
  const where = label ? `${label}附圖` : '本題附圖';
  // 一題有好幾張圖時要編號，否則讀螢幕的人聽到三次一模一樣的
  // 「第 3 題附圖」，分不出正在講哪一張。
  return count > 1 ? `${where}（${index + 1}）` : where;
}
