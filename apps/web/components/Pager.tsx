/**
 * 上一頁／下一頁。
 *
 * # 為什麼是元件而不是每一頁自己寫
 *
 * `components/Table.tsx` 的檔頭刻意不做分頁，理由是「每個畫面的需求
 * 都不同」——那對**篩選**是對的，對這個不是。這裡只有兩顆連結加一句
 * 「第 41–80 筆」，三頁一模一樣，而各寫一次會各漏掉同一件事：
 *
 *   · 上一頁在第 1 頁時仍然畫得出來 → 按下去回到第 1 頁，看起來像壞了
 *   · 下一頁在最後一頁仍然畫得出來 → 按下去是一片空白
 *   · 翻頁時把使用者剛選好的科目與日期弄丟了
 *
 * 最後那一件最貴：它讓篩選變成「只在第一頁有用」的功能。
 * 所以這裡不自己組網址，由呼叫端用 `keepQuery` 給——那一支會保留
 * 現有的查詢字串（`lib/listing.mjs`，有測試）。
 *
 * # 沒有頁碼清單
 *
 * 不畫「1 2 3 … 27」，因為要知道總頁數就得多一次 `count()`，
 * 而那是每一次翻頁多一次全表掃描。清單本身是按時間排的，
 * 使用者要找的東西用篩選比用頁碼快——第 14 頁對他不代表任何意義。
 */
import Link from 'next/link';

export function Pager({
  page,
  hasPrev,
  hasNext,
  from,
  to,
  hrefFor,
  unit = '筆',
}: {
  page: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** 這一頁的第一筆與最後一筆在整份清單裡的序號。 */
  from: number;
  to: number;
  /** 給一個頁碼，回那一頁的網址。呼叫端用 `keepQuery` 保留篩選。 */
  hrefFor: (page: number) => string;
  unit?: string;
}) {
  // 一頁就列得完時完全不畫。一組永遠停用的按鈕比沒有更吵。
  if (!hasPrev && !hasNext) return null;

  return (
    <nav className="yz-pager" aria-label="分頁">
      {hasPrev ? (
        <Link className="yz-btn yz-btn--quiet" href={hrefFor(page - 1)} rel="prev">
          上一頁
        </Link>
      ) : (
        // 佔位而不是不畫：少了它，「下一頁」會在第 1 頁跳到左邊，
        // 而使用者的手指已經記住了它的位置。
        <span className="yz-pager__gap" aria-hidden="true" />
      )}
      <span className="yz-pager__at">
        第 {from}–{to} {unit}
      </span>
      {hasNext ? (
        <Link className="yz-btn yz-btn--quiet" href={hrefFor(page + 1)} rel="next">
          下一頁
        </Link>
      ) : (
        <span className="yz-pager__gap" aria-hidden="true" />
      )}
    </nav>
  );
}
