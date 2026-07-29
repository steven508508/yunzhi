/**
 * 考試進行中的自動更新。
 *
 * # 為什麼這一頁需要它
 *
 * 監考老師在考試中就是盯著這一頁看誰交了、誰卡住了。`force-dynamic`
 * 只保證每一次請求都重算，**它不會自己重新請求**——所以畫面上的
 * 數字一動也不動，而老師唯一的辦法是一直按 F5。按 F5 的代價不只是
 * 麻煩：捲軸會跳回最上面，而他正在看的是名單的下半段。
 *
 * `router.refresh()` 不一樣——它只重新取得 server component 的內容，
 * 捲動位置與展開狀態都留著。
 *
 * # 為什麼可以關掉，而且預設只在「有人還在寫」時開
 *
 * 一份三個月前的考試不會再變，每 30 秒打一次伺服器只是浪費。
 * 而考試中的那一頁，關掉的自由要留給老師——他可能正在對照名單唸
 * 學號，而畫面在他唸到一半時重繪。
 *
 * 30 秒與作答頁的校時同一個節奏（`CLOCK_SYNC_MS`）。學生的倒數本來
 * 就是每 30 秒跟伺服器對一次，兩邊用同一個數字，老師看到的狀態
 * 與學生螢幕上的落差最多就是這麼多。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const REFRESH_MS = 30_000;

export function Live({ defaultOn }: { defaultOn: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(defaultOn);
  const [at, setAt] = useState<string | null>(null);

  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => {
      // 分頁在背景時不打——瀏覽器會節流計時器，而老師沒在看。
      // 他切回來的時候會觸發下面那個 visibilitychange。
      if (document.visibilityState !== 'visible') return;
      router.refresh();
      setAt(new Date().toLocaleTimeString('zh-TW', { hour12: false }));
    }, REFRESH_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        router.refresh();
        setAt(new Date().toLocaleTimeString('zh-TW', { hour12: false }));
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [on, router]);

  return (
    <label className="yz-live">
      <input type="checkbox" checked={on} onChange={(e) => setOn(e.currentTarget.checked)} />
      <span>每 30 秒自動更新</span>
      {on && at && <span className="yz-muted">上次 {at}</span>}
      {!on && (
        <button
          type="button"
          className="yz-live__now"
          onClick={() => {
            router.refresh();
            setAt(new Date().toLocaleTimeString('zh-TW', { hour12: false }));
          }}
        >
          現在更新一次
        </button>
      )}
    </label>
  );
}
