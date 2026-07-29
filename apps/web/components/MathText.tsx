/**
 * 題目內容。凡是會出現數學式、化學式或附圖的地方都走這一個。
 *
 * # 為什麼附圖也在這裡
 *
 * 因為 `![[a:fig1]]` 混在題幹的文字裡（`已知 $x>0$，![[a:fig1]] 中…`），
 * 而切分只能做一次——理由寫在 lib/math.mjs 的檔頭。呼叫端要做的只有
 * 把那一欄 Json 傳進來：`<MathText assets={q.contentAssets}>`。
 *
 * 沒傳 `assets` 時標記會排成一個「〔附圖〕」的小記號而不是原樣印出。
 * 那是給題庫清單那種一列只有一行的地方用的，不是漏接。
 *
 * # 為什麼不乾脆讓整支變成 client component
 *
 * 見下面「為什麼只有一個檔案」。真的需要瀏覽器的只有「圖載入失敗了
 * 沒有」這一件事，而它被關進 components/Figure.tsx 那一小塊裡——
 * 沒有圖的題目仍然是零 JavaScript 的伺服器渲染。
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
import type { ReactNode } from 'react';

import { Figure } from '@/components/Figure';
import { figureAlt, readAssets, renderMathHtml, splitMath } from '@/lib/math.mjs';
import type { QuestionAsset } from '@/lib/math.mjs';

/** 附圖網址的預設前綴。後面直接接上編碼過的物件鍵。 */
const DEFAULT_ASSET_BASE = '/api/assets?key=';

export function MathText({
  children,
  className,
  assets,
  assetBase = DEFAULT_ASSET_BASE,
  label,
  assetLoading = 'lazy',
}: {
  /**
   * 混排的內容。`$…$` 是行內式、`$$…$$` 是獨立公式，`\$` 是錢，
   * `![[a:fig1]]` 是附圖。
   */
  children: string | null | undefined;
  className?: string;
  /**
   * 這一段的附圖。直接餵 `Question.contentAssets` 這類 Json 欄位即可，
   * 形狀壞掉的項目會被略過（見 lib/math.mjs 的 readAssets）。
   *
   * **不給就不會有圖**：`![[a:…]]` 會排成一個「〔附圖〕」的小記號。
   * 那是清單、預覽這類只要一行的地方要的行為，不是遺漏。
   */
  assets?: unknown;
  /**
   * 附圖網址的前綴，後面接上編碼過的物件鍵。
   *
   * 為什麼要可以換：權限判斷跟著**脈絡**走，而不同脈絡問的問題不一樣。
   * 校對介面問「你教不教這份題本的科目」（`/api/import/[jobId]/image`）、
   * 卷子預覽問「這張圖在不在這份卷子上」（`/api/papers/[paperId]/image`）、
   * 作答與檢討問「這是不是你自己的那一份」（`/api/assets?attempt=…`）。
   * 一支路由要同時回答這三個，就會變成一串誰也不敢改的 if。
   */
  assetBase?: string;
  /** 「第 3 題」。沒有圖說時用它組出替代文字，見 lib/math.mjs 的 figureAlt。 */
  label?: string;
  /** 要印出來的畫面傳 `eager`，理由見 components/Figure.tsx。 */
  assetLoading?: 'lazy' | 'eager';
}) {
  if (children == null || children === '') return null;

  const list = readAssets(assets);
  const segments = splitMath(children);
  const hasRef = segments.some((s) => s.kind === 'asset');

  // 兩種情況走原本那條路（一個 React 節點）：
  //
  //   · 沒有圖也沒有標記 —— 絕大多數的題目
  //   · **呼叫端根本沒傳 `assets`** —— 那是「這個畫面不畫圖」（題庫清單
  //     一列只有一行、檢討頁收合時的預覽），標記會排成「〔附圖〕」。
  //
  // 第二條要用 `undefined` 判斷而不是「清單是空的」：`assets={null}`
  // 是**傳了但這一題沒有圖**，而題幹裡卻有標記——那是圖真的不見了，
  // 要讓人看見。兩者混為一談的話，題庫清單上每一題都會跳出一行紅字。
  if (assets === undefined || (list.length === 0 && !hasRef)) {
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

  const byId = new Map<string, QuestionAsset>();
  for (const a of list) if (a.id) byId.set(a.id, a);

  const used = new Set<string>();
  const parts: ReactNode[] = [];
  let buffer = '';
  let figureNo = 0;

  const flush = (key: string) => {
    if (buffer === '') return;
    parts.push(
      <span key={key} dangerouslySetInnerHTML={{ __html: renderMathHtml(buffer) }} />,
    );
    buffer = '';
  };

  segments.forEach((seg, i) => {
    if (seg.kind !== 'asset') {
      // 文字與數學式重新拼回原始碼再一起排：`splitMath` 的切分是可逆的
      // （`text` 段沒有動過、數學式把分隔符補回去），所以拼回去等於
      // 沒切過。分段各自 renderMathHtml 才是錯的——`$a$` 與 `$b$` 之間
      // 的那句中文會被算成兩段不同的內容，標點的間距就跑掉了。
      buffer +=
        seg.kind === 'text'
          ? seg.value
          : seg.kind === 'display'
            ? `$$${seg.value}$$`
            : `$${seg.value}$`;
      return;
    }

    flush(`t${i}`);
    const asset = byId.get(seg.value);
    if (!asset) {
      // 標記指向一張不存在的圖。**這要看得見**：題幹寫著「如右圖」而
      // 圖不見了，學生會以為題目就長這樣。原樣印 `![[a:fig1]]` 也不行，
      // 那看起來像亂碼而不是像「這裡少了一張圖」。
      parts.push(
        <span key={`m${i}`} className="yz-fig__ref yz-fig__ref--missing" role="alert">
          〔這裡有一張附圖，但系統找不到它〕
        </span>,
      );
      return;
    }
    used.add(seg.value);
    const no = figureNo++;
    parts.push(
      <Figure
        key={`a${i}`}
        inline
        src={assetBase + encodeURIComponent(asset.key)}
        alt={figureAlt(asset, { label, index: no, count: list.length })}
        width={asset.width}
        height={asset.height}
        loading={assetLoading}
      />,
    );
  });
  flush('tail');

  // 沒有被任何標記指到的圖排在後面。
  //
  // **不是防禦性的補漏，是主要路徑。** 講義那條路（切分階段用垂直重疊
  // 把圖分派給題目）產出的圖根本沒有 id，題幹裡也沒有標記——那些圖
  // 只有這裡會畫出來。漏掉的話，整份講義匯進來的幾何題全部沒有圖，
  // 而校對介面上看起來完全正常。
  const rest = list.filter((a) => !a.id || !used.has(a.id));
  if (rest.length > 0) {
    parts.push(
      <span key="rest" className="yz-figs">
        {rest.map((a, i) => (
          <Figure
            key={a.key}
            src={assetBase + encodeURIComponent(a.key)}
            alt={figureAlt(a, { label, index: figureNo + i, count: list.length })}
            width={a.width}
            height={a.height}
            loading={assetLoading}
          />
        ))}
      </span>,
    );
  }

  return <span className={className ? `yz-math ${className}` : 'yz-math'}>{parts}</span>;
}
