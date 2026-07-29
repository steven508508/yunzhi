/**
 * 把題目內容裡的數學式與化學式排出來。
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
 * 把一段混排的內容切成文字與數學式。
 *
 * 回傳的每一段都帶 `kind`：`text` 是純文字（**還沒轉義**），
 * `inline` 與 `display` 的 `value` 是分隔符裡面的 TeX（不含分隔符）。
 *
 * 切分與渲染刻意分開：切分是純字串處理，沒有相依，所以測得動；
 * 而會出錯的邊界情況（跳脫、落單分隔符、錢）全部在這一層。
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

    text += ch;
    i += 1;
  }

  flush();
  return out;
}

/** 這一段裡面有沒有數學式。用切分結果判斷，與實際渲染的行為一致。 */
export function hasMath(source) {
  return splitMath(source).some((seg) => seg.kind !== 'text');
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
 */
export function renderMathHtml(source) {
  let html = '';
  for (const seg of splitMath(source)) {
    html += seg.kind === 'text' ? escapeHtml(seg.value) : renderOne(seg.value, seg.kind === 'display');
  }
  return html;
}
