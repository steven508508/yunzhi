/**
 * 「看過了」。
 *
 * # 為什麼標記已讀是一個副作用而不是一顆按鈕
 *
 * 因為要求是「未讀數不能是一個永遠不會歸零的紅點」，而**任何需要
 * 使用者多按一下的歸零機制都不會歸零**——他點進來看到內容，
 * 那件事對他來說已經結束了，不會再去按一顆寫著「我看過了」的按鈕。
 *
 * 所以掛載時就送。送的是**這一頁上真的畫出來的那幾則的 id**，
 * 不是「全部」：第二頁的東西他還沒看到，而把沒看到的標成看過了，
 * 等於讓那幾則永遠不會再被注意到。
 *
 * # 為什麼要同時 refresh 與發一個事件
 *
 * `router.refresh()` 讓這一頁上的未讀底色消失（那是伺服器元件畫的）。
 * 但導覽列上那個數字在另一棵樹上，而且是 client component——
 * **refresh 不會重跑它的 effect**，於是使用者看完通知回到首頁，
 * 導覽列上還寫著 3，而他會再點一次進來確認，然後發現一樣。
 *
 * 所以另外發一個 `UNREAD_CHANGED` 事件。用瀏覽器的事件而不是把
 * 狀態提到共用的地方，是因為這兩個元件之間沒有別的關係，
 * 而為了一個數字牽一條 context 進來，代價會付在每一個頁面上。
 *
 * # 為什麼失敗完全不出聲
 *
 * 標記已讀失敗的後果是那個數字沒有掉。那是使用者看得見的（他下一次
 * 進來還是那幾則沒有底色），而在畫面頂端放一塊紅色的「標記已讀失敗」
 * 只會讓他以為通知本身壞了。**這一支不是他要求的動作**，
 * 所以它的失敗不該打斷他正在讀的東西。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/Button';
import { UNREAD_CHANGED } from '@/components/Nav';

/** 標記已讀之後，讓導覽列上的未讀數跟著更新。見 `components/Nav.tsx`。 */
function announce() {
  window.dispatchEvent(new Event(UNREAD_CHANGED));
}

export default function MarkRead({
  ids,
  showMarkAll,
}: {
  ids: string[];
  /** 清單超過一頁時才畫「全部標成已讀」。一頁列得完的話它是多餘的。 */
  showMarkAll: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // 送過的**那一組 id** 不再送。React 在開發模式會把 effect 跑兩次，
  // 而第二次是一次沒有意義的往返（伺服器端的 where 帶了 readAt: null，
  // 所以不會出錯，但也不必打）。
  //
  // **記的是 id 的組合，不是一個「送過了沒」的布林值。** 布林值在
  // 第一頁是對的，翻到第二頁就失效：`/inbox?before=…` 是同一個元件
  // 在 React 樹上的同一個位置，state 與 ref 都保留下來，於是 `ids`
  // 換了一整批而 effect 直接 return——第二頁之後的通知永遠不會被
  // 標成已讀，導覽列上的數字停在 60 不動。收件匣那三道歸零機制裡
  // 的第一道，從第二頁起就不作用了。
  const sentKey = useRef<string | null>(null);

  const key = ids.join(',');
  useEffect(() => {
    if (ids.length === 0 || sentKey.current === key) return;
    sentKey.current = key;
    void fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
      .then(() => {
        announce();
        router.refresh();
      })
      .catch(() => {
        // 見檔頭：不出聲。
      });
    // key 而不是 ids：陣列每次 render 都是新的物件，會讓 effect
    // 每次都重跑（雖然 sent 擋住了，但那是靠一個 ref 兜的）。
  }, [key, ids, router]);

  if (!showMarkAll) return null;

  async function markAll() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
    } finally {
      // 就算請求失敗也要重新整理：可能只是回應掉了而伺服器已經寫入，
      // 而留在原地會顯示一份與伺服器不同的狀態。
      setBusy(false);
      announce();
      router.refresh();
    }
  }

  return (
    <div className="yz-inbox__bar">
      <Button variant="quiet" onClick={markAll} busy={busy} busyLabel="處理中…">
        全部標成已讀
      </Button>
      <span className="yz-inbox__barnote">
        通知不只這一頁。全部標成已讀之後，導覽列上的數字會歸零，
        但通知本身還在，往下翻得到。
      </span>
    </div>
  );
}
