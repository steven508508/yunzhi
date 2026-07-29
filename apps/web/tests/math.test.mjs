/**
 * 數學式與化學式的排版。
 *
 * # 這一支守的是三種完全不同的災難
 *
 * **一、整站的儲存型 XSS。** 排出來的東西會經過
 * `dangerouslySetInnerHTML`，而題目內容來自 AI 抽取與老師輸入。
 * 非數學的那些純文字片段是我們自己拼進 HTML 字串的——漏掉一次轉義，
 * 一題被寫進題庫，之後每一個打開那一題的老師與學生都中。
 * 這一條寫錯不會有任何症狀，直到有人示範給你看。
 *
 * **二、一題壞掉就整頁白畫面。** 題庫裡一定會有抽壞的式子（缺右括號、
 * 全形符號沒換掉）。在 server component 裡丟出例外等於整頁 500——
 * 學生打不開的不是那一題，是整份檢討。
 *
 * **三、落單的 `$` 把半題吃掉。** 這一種最陰險：畫面上有東西、沒有
 * 錯誤、只是題幹從某個字開始變成一團排版過的亂碼，而學生沒有別的
 * 地方可以看到那半題。
 *
 * 所以每一個測試的註解寫的是**錯了會怎樣**。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  escapeHtml,
  figureAlt,
  hasMath,
  readAssets,
  referencedAssets,
  renderMathHtml,
  splitMath,
} from '../lib/math.mjs';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 只取每一段的種類，比對切分結果時比整個物件好讀。 */
const kinds = (src) => splitMath(src).map((s) => s.kind);
const values = (src) => splitMath(src).map((s) => s.value);

// ─────────────────────────────────────────────────────────────────
// 一、切分
// ─────────────────────────────────────────────────────────────────

test('$…$ 是行內式，前後的字留在原地', () => {
  // 錯的話：題幹的中文被吃進數學式，排出來是一行斜體的注音符號。
  assert.deepEqual(kinds('求 $x^2$ 的值'), ['text', 'inline', 'text']);
  assert.deepEqual(values('求 $x^2$ 的值'), ['求 ', 'x^2', ' 的值']);
});

test('$$…$$ 是獨立公式，而且不會被當成兩個空的行內式', () => {
  // 錯的話：`$$x$$` 會切成「空的行內式 + x + 空的行內式」，
  // 畫面上是一個 x 加兩個排不出來的紅色 `$$`。
  assert.deepEqual(kinds('由此得 $$E = mc^2$$'), ['text', 'display']);
  assert.deepEqual(values('由此得 $$E = mc^2$$'), ['由此得 ', 'E = mc^2']);
});

test('一段裡有好幾個式子時每一個都切得出來', () => {
  const src = '設 $a=1$、$b=2$，則 $a+b=3$';
  assert.deepEqual(kinds(src), ['text', 'inline', 'text', 'inline', 'text', 'inline']);
});

test('\\$ 是錢，不是數學式的開頭', () => {
  // 匯入管線那邊的約定也是這一條（canonical.py 的
  // `MATH_DELIM = (?<!\\)\$`）。兩邊不一致的話，老師照著規範寫的
  // `\$100` 會變成一個排不出來的紅色式子。
  assert.deepEqual(splitMath('定價 \\$100 元'), [{ kind: 'text', value: '定價 $100 元' }]);
  assert.equal(renderMathHtml('定價 \\$100 元'), '定價 $100 元');
});

test('\\$ 在數學式裡不會被當成收尾', () => {
  // 錯的話：`$\text{\$5}$` 會在中間斷開，後半段的 `}$` 變成散落的字元。
  assert.deepEqual(kinds('$\\text{\\$5}$'), ['inline']);
  assert.deepEqual(values('$\\text{\\$5}$'), ['\\text{\\$5}']);
});

test('落單的 $ 只變成一個錢字號，不會把後面整段吃掉', () => {
  // 這是這一支最重要的一條。AI 抽壞或老師手打漏一個 `$` 一定會發生，
  // 而把後面半題當成數學式排版的話，那半題就消失了——沒有錯誤訊息，
  // 學生也沒有別的地方看得到它。
  const src = '若 $x = 1，則 y = 2，請問 z 為何？';
  assert.deepEqual(kinds(src), ['text']);
  assert.equal(renderMathHtml(src), '若 $x = 1，則 y = 2，請問 z 為何？');
});

test('英文閱測裡的兩筆金額不會被配成一個數學式', () => {
  // 錯的話：`25, but the VIP seat costs ` 會被當成式子排出來，
  // 學生讀到的句子中間出現一段斜體亂碼。學測英文一定有這種句子。
  const src = 'The ticket costs $25, but the VIP seat costs $60.';
  assert.deepEqual(kinds(src), ['text']);
  assert.equal(renderMathHtml(src), 'The ticket costs $25, but the VIP seat costs $60.');
});

test('行內式不跨行', () => {
  // 換行之後多半已經是下一段話了。讓它跨行的話，一個漏掉的收尾分隔符
  // 會把接下來的整個段落吞掉。
  assert.deepEqual(kinds('第一行 $x\n第二行 y$ 結束'), ['text']);
});

test('hasMath 與實際切分的結果一致', () => {
  assert.equal(hasMath('求 $x^2$ 的值'), true);
  assert.equal(hasMath('定價 \\$100 元'), false, '\\$ 是錢，不該讓校對頁多畫一條預覽');
  assert.equal(hasMath('沒有任何式子'), false);
  assert.equal(hasMath(null), false, '題幹是 null 的候選題目不少，不能丟例外');
});

// ─────────────────────────────────────────────────────────────────
// 二、轉義（XSS）
// ─────────────────────────────────────────────────────────────────

test('純文字片段裡的 HTML 被轉義，沒有可執行的 script', () => {
  // 錯的話就是全站的儲存型 XSS：一題寫進題庫，每一個打開它的人都中。
  const out = renderMathHtml('<script>alert(1)</script> 求 $x$');
  assert.doesNotMatch(out, /<script/i, '輸出裡有真的 <script 標籤');
  assert.doesNotMatch(out, /<\/script>/i);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('屬性值也逃不出去', () => {
  // `"` 與 `'` 沒轉的話，塞進 title="…" 的內容可以自己收尾再加
  // onerror=——而錯誤訊息（帶原始碼）正是會被放進 title 的東西。
  const out = renderMathHtml(`"><img src=x onerror=alert(1)>`);
  assert.doesNotMatch(out, /<img/i);
  assert.match(out, /&quot;&gt;/);
  assert.equal(escapeHtml(`'"&<>`), '&#39;&quot;&amp;&lt;&gt;');
});

test('已經轉義過的內容不會被還原成標籤', () => {
  // 少轉 `&` 的經典後果：`&lt;script&gt;` 進了 innerHTML 之後
  // 又變回真的 <script>。
  const out = renderMathHtml('&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.doesNotMatch(out, /<script/i);
  assert.match(out, /&amp;lt;script&amp;gt;/);
});

test('數學式裡的 HTML 也出不來', () => {
  // KaTeX 自己會轉義它收到的 TeX，但這件事值得有一條測試盯著——
  // 換版本或換渲染器的時候，這裡會先紅。
  const out = renderMathHtml('$<script>alert(1)</script>$');
  assert.doesNotMatch(out, /<script/i);
});

test('trust 沒有被打開，\\href 不會變成真的連結', () => {
  // 打開的話，題目內容就能在畫面上種一個往外連的連結——
  // 這套系統部署在封閉網段，對外連線本身就是違反前提的事。
  const out = renderMathHtml('$\\href{https://example.com}{按我}$');
  assert.doesNotMatch(out, /<a\s/i, 'KaTeX 的 trust 被打開了');
});

// ─────────────────────────────────────────────────────────────────
// 三、壞掉的式子
// ─────────────────────────────────────────────────────────────────

test('排不出來的式子不丟例外，而且後面的內容照樣出現', () => {
  // 在 server component 裡丟例外等於整頁 500。學生打不開的不是
  // 那一題，是整份檢討。
  const src = '前面 $\\frac{1$ 後面 $x^2$ 結尾';
  let out;
  assert.doesNotThrow(() => {
    out = renderMathHtml(src);
  });
  assert.match(out, /前面/);
  assert.match(out, /結尾/, '壞掉的式子把後面的內容一起吃掉了');
  assert.match(out, /katex-error|yz-math__bad/, '壞掉的式子沒有被標出來');
});

test('壞掉的式子印的是原始碼，而且原始碼也轉義過', () => {
  // 老師要靠這一行知道該回去改什麼，所以原始碼要看得到；
  // 而那串原始碼同樣不可信——KaTeX 的錯誤訊息會把它原封不動帶出來。
  const out = renderMathHtml('$<b>\\frac{1$');
  assert.doesNotMatch(out, /<b>/, '錯誤訊息裡的標籤沒有轉義');
});

test('空的分隔符不會產生空白的式子', () => {
  // `$$` 與 `$ $` 這種多半是抽取留下的殘骸。當成式子排的話，
  // 畫面上會多出一個看不見卻佔位的東西。
  assert.deepEqual(kinds('前 $$ 後'), ['text']);
  assert.deepEqual(kinds('前 $ $ 後'), ['text']);
});

test('null 與空字串不會炸', () => {
  assert.equal(renderMathHtml(null), '');
  assert.equal(renderMathHtml(undefined), '');
  assert.equal(renderMathHtml(''), '');
});

// ─────────────────────────────────────────────────────────────────
// 四、真的排出來了（不是原始碼）
// ─────────────────────────────────────────────────────────────────

/** 排出來的東西應該有 KaTeX 的結構，而且看不到原始的反斜線命令。 */
function typeset(src) {
  const out = renderMathHtml(src);
  assert.match(out, /class="katex"/, `${src} 沒有被排版`);
  assert.doesNotMatch(out, /class="katex-error"/, `${src} 排不出來`);
  return out;
}

test('\\ce{} 由 mhchem 排出來', () => {
  // 沒有 `import 'katex/contrib/mhchem'` 的症狀不是報錯，是每一條
  // 化學反應式都變成一行紅色的 `\ce{...}`——KaTeX 不認得 \ce。
  const out = typeset('$\\ce{2H2 + O2 -> 2H2O}$');
  // `<annotation>` 裡本來就會有原始的 TeX（KaTeX 一律附上，讓輔助科技
  // 與複製貼上拿得到來源），它不顯示在畫面上。要看的是那一段以外
  // 還有沒有殘留的 `\ce`——有的話就是 mhchem 沒載入，KaTeX 不認得
  // 這個命令，畫面上會是一行紅色的原始碼。
  const visible = out.replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/g, '');
  assert.doesNotMatch(visible, /\\ce/, '\\ce 原封不動留在輸出裡，mhchem 沒有載入');
  // 下標是 mhchem 有在做事的證據：2H2 要排成 2H₂ 才對。
  assert.match(out, /<msub>/, '化學式沒有下標，H2O 會排成一條直線');
  assert.match(out, /→|rightarrow|\u2192/, '反應箭頭 -> 沒有變成箭頭');
});

test('\\ce{} 的電荷與可逆箭頭也排得出來', () => {
  typeset('$\\ce{CH3COOH <=> CH3COO- + H+}$');
  typeset('$\\ce{H2SO4}$');
});

test('向量的箭頭排得出來', () => {
  // 箭頭掉了就是另一個物理量：$v$ 是速率、$\vec{v}$ 是速度。
  // 物理大量在這個區別上出題，而畫面是學生唯一看得到它的地方。
  typeset('$\\vec{F} = m\\vec{a}$');
  typeset('$\\overrightarrow{AB}$');
  typeset('$\\hat{n}$');
  typeset('$\\overline{AB}$');
});

test('上下標、分數、根號排得出來', () => {
  const out = typeset('$\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$');
  assert.match(out, /mfrac/, '分數沒有排成分數');
  assert.match(out, /msqrt/, '根號沒有排成根號');
  typeset('$x_1^2 + x_2^2$');
});

test('獨立公式用的是 displayMode', () => {
  // 行內模式排出來的分數會被壓扁成 a/b 的高度，而獨立公式
  // 存在的理由就是不要被壓扁。
  const out = renderMathHtml('$$\\frac{1}{2}$$');
  assert.match(out, /katex-display/, '$$…$$ 沒有用 displayMode');
  assert.doesNotMatch(renderMathHtml('$\\frac{1}{2}$'), /katex-display/);
});

test('式子裡的中文不會讓伺服器 log 每次都多一行警告', () => {
  // KaTeX 的 strict 預設是 'warn'，而題目裡到處是 \text{公尺}。
  // 一頁五十題就是五十行 unicodeTextInMathMode，真正的錯誤會被埋掉。
  const warn = console.warn;
  const seen = [];
  console.warn = (...args) => seen.push(args.join(' '));
  try {
    typeset('$v = 3\\ \\text{公尺/秒}$');
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(seen, [], `KaTeX 的 strict 沒有關掉：${seen[0] ?? ''}`);
});

// ─────────────────────────────────────────────────────────────────
// 五、附圖標記
//
// 這一組守的是「一道幾何題在學生畫面上長什麼樣」。三種壞法：
//
//   · 標記沒被認出來 → 題幹中間印著一串 `![[a:fig1]]`，看起來像亂碼
//   · 標記被吃太多 → 題幹從那個字開始少了一截，而沒有任何錯誤
//   · 替代文字是空字串 → 用螢幕閱讀器的學生**這一題少了一個條件**，
//     而畫面上什麼都沒有發生
// ─────────────────────────────────────────────────────────────────

test('附圖標記切得出來，前後的字留在原地', () => {
  // 錯的話：畫面上是「如圖 ![[a:fig1]]，求 x」——那串東西在校對介面
  // 看起來就像 AI 抽壞了字，老師會把它刪掉，然後圖就永遠對不回來了。
  assert.deepEqual(kinds('如圖 ![[a:fig1]]，求 x'), ['text', 'asset', 'text']);
  assert.deepEqual(values('如圖 ![[a:fig1]]，求 x'), ['如圖 ', 'fig1', '，求 x']);
});

test('附圖標記與數學式混在同一段時兩種都切得出來', () => {
  // 這是實際的內容長相。分兩層處理（先數學再圖、或先圖再數學）
  // 一定會有一層拿到被另一層剖開的字串，理由見 lib/math.mjs 檔頭。
  const src = '已知 $x>0$，![[a:f1]] 中 $\angle A = 30^\circ$';
  assert.deepEqual(kinds(src), ['text', 'inline', 'text', 'asset', 'text', 'inline']);
  assert.deepEqual(
    values(src),
    ['已知 ', 'x>0', '，', 'f1', ' 中 ', '\angle A = 30^\circ'],
  );
});

test('標記不會把數學式的分隔符吃掉', () => {
  // `![[a:f1]]$x$` 中間沒有空白。標記多吃一個字元的話，後面那個
  // `$` 就落單了，而落單的 `$` 會讓整段話變成一個錢字號加半題。
  assert.deepEqual(kinds('![[a:f1]]$x$'), ['asset', 'inline']);
  assert.deepEqual(values('![[a:f1]]$x$'), ['f1', 'x']);
});

test('一段裡有好幾張圖，每一張都切得出來而且順序不變', () => {
  const src = '![[a:f1]] 與 ![[a:f2]]';
  assert.deepEqual(values(src), ['f1', ' 與 ', 'f2']);
  assert.deepEqual(referencedAssets(src), ['f1', 'f2']);
  assert.deepEqual(referencedAssets('![[a:f1]] 又 ![[a:f1]]'), ['f1'], '同一張圖只算一次');
});

test('寫壞的標記不炸頁面，也不會吞掉後面的內容', () => {
  // 四種壞法都真的出現過：id 空的、少一個括號、id 太長（模型把整句
  // 圖說塞進去）、只有半個開頭。**共通的要求是後面那句話還在**——
  // 被吞掉的半題沒有任何線索，學生也沒有別的地方看得到它。
  for (const bad of [
    '![[a:]] 求 x',
    '![[a:f1] 求 x',
    `![[a:${'z'.repeat(40)}]] 求 x`,
    '![[ 求 x',
    '![a:f1]] 求 x',
  ]) {
    const segs = splitMath(bad);
    assert.deepEqual(
      segs.map((s) => s.kind),
      ['text'],
      `「${bad}」被當成了附圖標記`,
    );
    assert.equal(segs[0].value, bad, `「${bad}」被吃掉了一部分`);
    assert.match(renderMathHtml(bad), /求 x/, `「${bad}」後面的內容不見了`);
  }
});

test('沒有資產清單時標記排成記號，不是原樣印出、也不是消失', () => {
  // 題庫清單一列只有一行，放不下圖。但「這一題有圖」是掃視時要
  // 知道的事，所以不能消失；原樣印出來則會佔掉整行的寬度。
  const out = renderMathHtml('如圖 ![[a:fig1]]，求 x');
  assert.doesNotMatch(out, /!\[\[a:/, '原始碼被原樣印出來了');
  assert.match(out, /yz-fig__ref/);
  assert.match(out, /如圖/);
  assert.match(out, /求 x/);
});

test('hasMath 把附圖也算進去', () => {
  // 校對介面靠它決定要不要畫「排出來」那一格。只有圖沒有式子的
  // 題目不畫的話，老師就看不到那張圖對不對。
  assert.equal(hasMath('如圖 ![[a:fig1]]'), true);
});

test('readAssets 濾掉壞掉的項目，不丟例外', () => {
  // 這一欄是 Json，內容來自匯入管線與手改過的列。丟 TypeError 的話
  // 整題變成一片白——在作答中。
  assert.deepEqual(readAssets(null), []);
  assert.deepEqual(readAssets('not an array'), []);
  assert.deepEqual(readAssets([null, 42, {}, { key: '' }]), [], '沒有 key 的項目沒有圖可顯示');

  const [a] = readAssets([
    { id: 'f1', key: 't/x/import/j/fig/0001-00.png', alt: ' 座標圖 ', width: 640, height: 480 },
  ]);
  assert.equal(a.id, 'f1');
  assert.equal(a.alt, '座標圖');
  assert.equal(a.width, 640);
  assert.equal(a.height, 480);
});

test('壞掉的寬高不會變成 <img> 上的 0', () => {
  // `width="0"` 的圖在瀏覽器上是不存在的——而資料庫裡的 0、負數、
  // 字串都可能出現（管線改版、手動修資料）。
  const [a] = readAssets([{ key: 'k', width: 0, height: -3 }]);
  assert.equal(a.width, null);
  assert.equal(a.height, null);
  const [b] = readAssets([{ key: 'k', width: '640', height: NaN }]);
  assert.equal(b.width, null);
  assert.equal(b.height, null);
});

test('替代文字永遠不是空字串', () => {
  // `alt=""` 的約定是「這張圖純裝飾，跳過它」。而這裡的圖是題目的
  // **條件**——跳過它等於這一題對用螢幕閱讀器的學生少了一個條件，
  // 而他不會知道少了什麼。
  const [bare] = readAssets([{ key: 'k' }]);
  assert.equal(figureAlt(bare, { label: '第 3 題' }), '第 3 題附圖');
  assert.equal(figureAlt(bare), '本題附圖', '沒有題號時也要說得出這是什麼');
  assert.equal(figureAlt(null), '本題附圖', '資料壞掉時也不可以是空字串');
});

test('有圖說就用圖說，沒有才退回位置描述', () => {
  const [withAlt] = readAssets([{ key: 'k', alt: '△ABC 中，D 為 BC 的中點' }]);
  assert.equal(figureAlt(withAlt, { label: '第 3 題' }), '△ABC 中，D 為 BC 的中點');

  const [withCaption] = readAssets([{ key: 'k', caption: '▲圖一' }]);
  assert.equal(figureAlt(withCaption), '▲圖一');

  // 圖內的文字（座標軸標籤、點名）比「本題附圖」有用一點點，
  // 但比真的圖說差得多——所以排在最後一個素材。
  const [withLabels] = readAssets([{ key: 'k', labels: ['O', 'x', 'y'] }]);
  assert.match(figureAlt(withLabels), /O/);
});

test('一題有好幾張圖時替代文字要編號', () => {
  // 讀螢幕的人連續聽到三次一模一樣的「第 3 題附圖」，分不出正在
  // 講哪一張——而幾何題的兩張圖常常就是題目要比較的東西。
  const [a] = readAssets([{ key: 'k' }]);
  assert.equal(figureAlt(a, { label: '第 3 題', index: 0, count: 3 }), '第 3 題附圖（1）');
  assert.equal(figureAlt(a, { label: '第 3 題', index: 2, count: 3 }), '第 3 題附圖（3）');
});

// ─────────────────────────────────────────────────────────────────
// 六、樣式與字型：本地檔案，只載入一次
// ─────────────────────────────────────────────────────────────────

test('KaTeX 的樣式表只被匯入一次，而且是在登入後的共用版面', () => {
  // 每個元件各自 import 一份的話，載入順序會跟著元件樹跑，而
  // KaTeX 的樣式有好幾層以特異度互相覆寫的規則。
  const files = collectSources(WEB);
  const importers = files.filter((f) => /['"]katex\/dist\/katex(\.min)?\.css['"]/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(
    importers.map((f) => path.relative(WEB, f)),
    ['app/(app)/layout.tsx'],
    'katex 的 CSS 不是只在 app/(app)/layout.tsx 匯入一次',
  );
});

test('沒有任何地方從 CDN 載 KaTeX', () => {
  // 業主明講資料不能離開校內，而機房是封閉網段——對外請求在那裡是
  // ERR_TUNNEL_CONNECTION_FAILED。失效的方式特別糟：沒有那份 CSS 的
  // 數學式不會報錯，只是上下標全部攤平成一串亂碼。
  for (const file of collectSources(WEB)) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      src,
      /(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)[^\s'"]*katex/i,
      `${path.relative(WEB, file)} 從 CDN 載 KaTeX`,
    );
  }
});

test('字型檔真的在套件裡，樣式表指到的路徑不是空的', () => {
  // 指到不存在的路徑不會報錯，只會靜靜地退回系統字型——而 KaTeX 的
  // 版面（根號的勾、大括號的接縫）完全靠那幾個字型檔拼出來，
  // 退回去之後排出來的是一堆對不齊的碎片。
  const dist = path.join(WEB, '../../node_modules/katex/dist');
  const css = readFileSync(path.join(dist, 'katex.min.css'), 'utf8');
  const refs = [...css.matchAll(/url\(([^)]+)\)/g)]
    .map((m) => m[1].replace(/["']/g, '').trim())
    .filter((u) => !u.startsWith('data:'));
  assert.ok(refs.length > 0, 'katex.min.css 裡沒有任何字型參照，套件是不是壞了');
  for (const ref of refs) {
    assert.ok(existsSync(path.join(dist, ref)), `katex.min.css 指向不存在的 ${ref}`);
  }
});

/** apps/web 底下所有自己寫的原始碼。 */
function collectSources(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|mjs|css)$/.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}
