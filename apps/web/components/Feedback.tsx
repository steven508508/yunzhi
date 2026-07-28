/**
 * 四種「畫面上沒有正常內容」的狀態。
 *
 * 這四種是同一件事的四個面向，而它們最容易被寫成同一個東西：
 * 一個轉圈的圖示，或者更糟——什麼都沒有。
 *
 *   載入中   還在等，什麼都還不知道
 *   空的     查完了，真的沒有東西
 *   出錯了   查失敗了，這與「沒有東西」完全不同
 *   沒權限   有東西，但這個人不該看
 *
 * **把「出錯」畫成「空的」是最常見也最貴的一種偷懶**：老師會以為
 * 題庫是空的，然後重新匯入一次已經在裡面的題本。
 *
 * 所以每一種都有自己的樣子，而且每一種都要求呼叫端說出
 * 「接下來能做什麼」——一個沒有出路的錯誤畫面等於一條死路。
 */
import type { ReactNode } from 'react';

export function Loading({ what = '載入中' }: { what?: string }) {
  return (
    // aria-live="polite"：內容到位時讀螢幕的人會被告知，
    // 但不會打斷他正在聽的東西。
    <div className="yz-state" aria-live="polite" aria-busy="true">
      <p className="yz-state__main">{what}…</p>
    </div>
  );
}

export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  /** 為什麼是空的，以及怎麼讓它不空。 */
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="yz-state">
      <p className="yz-state__main">{title}</p>
      {hint && <p className="yz-state__sub">{hint}</p>}
      {action && <div className="yz-state__act">{action}</div>}
    </div>
  );
}

/**
 * 出錯了。
 *
 * `detail` 放給人看的原因，`action` 放下一步。兩者都不給的話，
 * 使用者只能重新整理然後希望它自己好——那不是錯誤處理，
 * 是把問題丟回去。
 */
export function ErrorBox({
  title = '出了點問題',
  detail,
  action,
}: {
  title?: string;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="yz-state yz-state--error" role="alert">
      <p className="yz-state__main">{title}</p>
      {detail && <p className="yz-state__sub">{detail}</p>}
      {action && <div className="yz-state__act">{action}</div>}
    </div>
  );
}

export function Denied({
  what = '這個頁面',
  why,
}: {
  what?: string;
  /** 為什麼沒有權限。**要說得出來**——「沒有權限」是句廢話。 */
  why?: ReactNode;
}) {
  return (
    <div className="yz-state" role="alert">
      <p className="yz-state__main">你沒有{what}的權限</p>
      {why && <p className="yz-state__sub">{why}</p>}
    </div>
  );
}

/**
 * 行內的提醒。用在表單頂端或區塊上方，不佔整個畫面。
 *
 * `tone` 只有三種，而且刻意沒有「成功」——成功不需要一塊綠色的東西
 * 來說，畫面上出現了正確的結果本身就是成功。多一塊綠色只是噪音。
 */
export function Note({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error';
  children: ReactNode;
}) {
  return (
    <p
      className={`yz-note yz-note--${tone}`}
      role={tone === 'error' ? 'alert' : undefined}
    >
      {children}
    </p>
  );
}
