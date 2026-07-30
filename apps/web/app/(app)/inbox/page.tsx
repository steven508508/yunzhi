/**
 * 收件匣。每一個角色都有，而且每一個角色看到的是不同的事情。
 *
 * # 這一頁與首頁待辦的分界，以及為什麼分界比功能重要
 *
 * **首頁待辦回答「現在該做什麼」，收件匣回答「發生了什麼事」。**
 *
 * 兩者混在一起的話，兩邊都會變得沒有人看，而失敗的方式很具體：
 *
 *   · 收件匣如果也列「還有 3 份題本沒校對」，那一列會**每天出現一次**
 *     直到他校完——於是收件匣變成一份重複的待辦清單，而重複的清單
 *     沒有人會讀第二份。
 *   · 首頁待辦如果也列「你的作答在上週被作廢了」，那一列**永遠不會
 *     消失**（作廢沒有「處理完」的狀態），於是待辦清單再也不能歸零，
 *     而一份不能歸零的待辦清單等於沒有待辦清單。
 *
 * 所以規則是：
 *
 *   待辦    **由狀態算出來。** 「有 3 份沒校對」是一個查詢的結果，
 *           處理完就自己消失，而且不管它是什麼時候變成這樣的。
 *   收件匣  **由事件算出來。** 在狀態改變的那一刻產生一則，之後
 *           不管它有沒有被處理。看過就沉下去，永遠不再重播。
 *
 * 具體的後果：收件匣裡**沒有任何「還有 N 件未處理」的播報**
 * （`grading.pending` 一份任務只通知一次，不是每天一次），而首頁
 * 待辦裡沒有任何歷史。
 *
 * # 未讀數怎麼歸零（三道機制，缺一道就變成一個沒人理的紅點）
 *
 *   一、**打開這一頁就把畫面上那幾則標成已讀**（`MarkRead`，掛載時
 *       送一次）。這是唯一能保證數字歸零的機制——用「處理完那件事」
 *       當條件的話，一則「作業快到期」在他寫完作業之後仍然是未讀。
 *   二、**清單超過一頁時有「全部標成已讀」**。少了它，累積三個月的
 *       帳號要翻六頁才歸零，而沒有人會翻。
 *   三、**未讀只算最近 30 天**（`UNREAD_HORIZON_DAYS`）。三個月前
 *       沒點開的東西不該讓今天的作廢通知看起來一樣不重要。
 *
 * 而**沒有未讀時完全不畫那個數字**（見 `components/Nav.tsx`）——
 * 一個寫著 0 的紅點是最快被學會忽略的東西。
 *
 * # 手機優先
 *
 * 學生與家長多半在手機上。所以一則就是一個區塊、標題與內文各一行、
 * 下一步是一個佔滿寬度好按的連結——不是一張有欄位的表。
 * 表在 360 像素寬的螢幕上會把「下一步」擠到看不見，而**那是這一頁
 * 唯一真正重要的東西**。
 */
import Link from 'next/link';

import { Empty } from '@/components/Feedback';
import { listInbox } from '@/lib/notifyDb';
import { render } from '@/lib/notifyTemplates.mjs';
import { scopedPage } from '@/lib/page';

import MarkRead from './MarkRead';

export const dynamic = 'force-dynamic';

/** 一頁幾則。手機上一則約佔一屏的四分之一，40 則要滑很久但滑得完。 */
const PAGE = 40;

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ before?: string }>;
}) {
  const sp = await searchParams;
  return scopedPage(async (user) => {
    // 游標讀不懂就當成沒有給（回到第一頁）。這個值來自網址列，
    // 手改與連結被截斷都會發生，而一個 500 對「網址打錯」是過度反應。
    const beforeAt = parseBefore(sp?.before);
    const { rows, hasMore } = await listInbox(user.id, { take: PAGE, before: beforeAt });
    const unreadIds = rows.filter((r) => r.readAt == null).map((r) => r.id);

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>通知</h1>
          <p className="yz-panel__sub">
            這裡是發生過的事。要知道現在該做什麼，看<Link href="/">首頁</Link>。
            　·　<Link href="/settings/notifications">通知設定</Link>
          </p>
        </div>

        {/* 掛載時把這一頁上未讀的那幾則標起來。放在清單之前，
            是為了讓它在瀏覽器解析到內容之前就開始送。 */}
        <MarkRead ids={unreadIds} showMarkAll={hasMore || unreadIds.length >= PAGE} />

        {rows.length === 0 ? (
          <Empty
            title={beforeAt ? '沒有更早的通知了' : '目前沒有通知'}
            hint={
              beforeAt ? (
                <Link href="/inbox">回到最新的</Link>
              ) : (
                '有事情發生的時候會出現在這裡：作業快到期、成績開放、老師動了你的卷子。' +
                '不想收某一類的話，到通知設定裡關掉。'
              )
            }
          />
        ) : (
          <ul className="yz-inbox">
            {rows.map((row) => {
              const v = render(row.templateKey, row.payload);
              const fresh = row.readAt == null;
              return (
                <li
                  key={row.id}
                  className={`yz-inbox__item${fresh ? ' yz-inbox__item--new' : ''}`}
                >
                  <div className="yz-inbox__head">
                    <span className="yz-inbox__title">{v.title}</span>
                    {/* 時間用 <time>，而且 dateTime 是完整的 ISO——
                        畫面上只寫得下「9/8 15:59」，而讀螢幕的人與
                        任何要對時間的人需要完整的那一份。 */}
                    <time className="yz-inbox__when" dateTime={row.createdAt.toISOString()}>
                      {fmtWhen(row.createdAt)}
                    </time>
                  </div>
                  <p className="yz-inbox__body">{v.body}</p>
                  <Link className="yz-inbox__act" href={v.href}>
                    {v.action}
                  </Link>
                  {fresh && <span className="yz-sr">（未讀）</span>}
                </li>
              );
            })}
          </ul>
        )}

        {/* 游標分頁而不是頁碼：這份清單的頭一直在長，用 skip 的話
            讀完第一頁、期間來了兩則新的，第二頁會把第一頁最後兩則
            再顯示一次——而使用者會以為自己看漏了。理由同
            `lib/notify.mjs` 的 `inboxPage`。 */}
        {(hasMore || beforeAt) && (
          <nav className="yz-pager" aria-label="分頁">
            {beforeAt ? (
              <Link className="yz-btn yz-btn--quiet" href="/inbox" rel="prev">
                回到最新的
              </Link>
            ) : (
              <span className="yz-pager__gap" aria-hidden="true" />
            )}
            <span className="yz-pager__at">
              {rows.length > 0 ? `${rows.length} 則` : ''}
            </span>
            {hasMore && rows.length > 0 ? (
              <Link
                className="yz-btn yz-btn--quiet"
                href={`/inbox?before=${encodeURIComponent(
                  rows[rows.length - 1].createdAt.toISOString(),
                )}`}
                rel="next"
              >
                更早的
              </Link>
            ) : (
              <span className="yz-pager__gap" aria-hidden="true" />
            )}
          </nav>
        )}
      </main>
    );
  });
}

/** 網址上的游標。讀不懂一律回 null（= 第一頁）。 */
function parseBefore(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 時間一律台灣時間。伺服器多半跑在 UTC，直接印會差八小時。
 *
 * 今年的省略年份：收件匣上絕大多數是最近幾天的東西，而多印一個
 * 「2026/」在 360 像素寬的螢幕上會把標題擠掉一行。
 */
function fmtWhen(d: Date): string {
  const nowYear = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
  }).format(new Date());
  const sameYear =
    new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric' }).format(d) ===
    nowYear;
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}
