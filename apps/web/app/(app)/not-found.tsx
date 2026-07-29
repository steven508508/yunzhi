import Link from 'next/link';

import { Empty } from '@/components/Feedback';

/**
 * 找不到這個東西。
 *
 * 沒有這一支的話，`notFound()` 會落到 Next 內建的頁面上——一個
 * 英文的「404 | This page could not be found.」，出現在一個
 * 從頭到尾都是繁體中文的系統裡，而且沒有導覽列、也沒有任何出路。
 *
 * 老師會踩到它的實際情境很具體：把某份考卷的網址加了書籤，
 * 那份卷子後來被刪掉或封存了；或者從別人轉貼的訊息點進一個
 * 舊的任務連結。那時他需要知道的不是狀態碼，是「回哪裡去」。
 *
 * 放在 `(app)` 這一層而不是根目錄：登入後的頁面才有導覽列，
 * 而有導覽列的 404 本身就給了出路。
 */
export default function NotFound() {
  return (
    <main className="yz-panel">
      <Empty
        title="找不到這個頁面"
        hint="它可能已經被刪除或封存了，也可能是網址少了一段。從下面任一個地方重新找起。"
        action={
          <>
            <Link href="/papers">考卷</Link>
            <Link href="/assignments">派卷</Link>
            <Link href="/grades">成績</Link>
          </>
        }
      />
    </main>
  );
}
