/**
 * 題目內容。凡是會出現數學式或化學式的地方都走這一個。
 *
 * # 為什麼不叫 Math
 *
 * 因為 `Math` 是 JavaScript 的全域物件，而 `import { Math }` 會在整個
 * 模組範圍內把它蓋掉。作答頁靠 `Math.max` 算倒數、靠 `Math.min` 換題，
 * 檢討頁靠 `Math.round` 收分數的小數——**這三樣會在匯入的那一刻
 * 同時失效**。TypeScript 會擋下來，但那個錯誤訊息（Property 'round'
 * does not exist）指的地方跟原因差了十萬八千里，找起來很久。
 * 名字裡的 Text 也剛好說明了它收的是混排的內容，不是一條純算式。
 *
 * # 為什麼只有一個檔案，沒有分成 server 版與 client 版
 *
 * 這個檔案**沒有 `'use client'`**，所以它在兩種脈絡下都成立：
 *
 *   · 被 server component 匯入（題庫、組卷、檢討頁）→ 在伺服器端排好，
 *     瀏覽器只收到 HTML。零 JavaScript、沒有 hydration 閃爍，
 *     而且檢討頁的正確答案與解析不會經過 client 的 props。
 *   · 被 client component 匯入（作答頁、匯入校對）→ 跟著進 client bundle。
 *
 * 拆成兩份的代價是兩條會分岐的程式路徑，而它們一旦分岐，症狀是
 * 「同一題在作答時排得出來、在檢討頁排不出來」——沒有人會想到去比對
 * 兩個檔案。切分與轉義的規則只有一份（lib/math.mjs），這裡只是把它
 * 接到 React 上。
 *
 * 作答頁與校對頁因此會多背 KaTeX 的體積（約 280 KB，gzip 後約 80 KB）。
 * 那兩頁的內容都是打開之後才從 API 拿的，伺服器端排不了。考場是校內
 * 網段、而且這兩頁本來就會停留很久，這個交換划得來。
 *
 * # 為什麼是 dangerouslySetInnerHTML
 *
 * KaTeX 排出來的是一棵幾百個節點的 span 樹，沒有辦法用 JSX 表達。
 * 所有的轉義都在 lib/math.mjs 做完了——**純文字片段先過 escapeHtml，
 * 數學式交給 KaTeX（它會轉義自己的輸入，而且 trust:false 關掉了會
 * 產生連結與內嵌樣式的命令）**。那一支的檔頭寫了為什麼漏掉一次
 * 就是全站的儲存型 XSS。
 *
 * # 沒有內容時回傳 null
 *
 * 題幹是 `string | null` 的地方不少（匯入的候選題目、題組的前導敘述）。
 * 讓呼叫端每次都寫一次 `{x && <Math>{x}</Math>}` 只會漏掉，
 * 而漏掉的症狀是畫面上多一個空的 span 撐出來的行高。
 */
import { renderMathHtml } from '@/lib/math.mjs';

export function MathText({
  children,
  className,
}: {
  /** 混排的內容。`$…$` 是行內式、`$$…$$` 是獨立公式，`\$` 是錢。 */
  children: string | null | undefined;
  className?: string;
}) {
  if (children == null || children === '') return null;

  return (
    // 一律是 span：獨立公式 KaTeX 產的也是 span（.katex-display），
    // 所以放進 <p>、<li>、<td> 裡都是合法的 HTML。用 div 的話，
    // 現有那些把題幹包在 span 裡的版面會產生無效的巢狀結構，
    // 而瀏覽器修正它的方式是把 div 移到外面——版面會當場散掉。
    <span
      className={className ? `yz-math ${className}` : 'yz-math'}
      dangerouslySetInnerHTML={{ __html: renderMathHtml(children) }}
    />
  );
}
