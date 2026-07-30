/**
 * 頂部導覽列。
 *
 * # 為什麼這一支值得單獨存在
 *
 * 在此之前 `(app)/layout.tsx` 只做登入檢查，**畫面上沒有任何導覽**。
 * 實際後果是：登入後被丟到 `/import`，然後就沒有任何方式走到題庫、
 * 班級或知識點——那幾頁都做好了，只是沒有人到得了。使用者唯一的
 * 出路是自己猜網址。
 *
 * # 為什麼是 client component
 *
 * 因為 `aria-current` 要知道現在在哪一頁，而伺服器元件讀不到網址。
 * 沒有 `aria-current` 的導覽列，讀螢幕的人聽到的是五個一模一樣的
 * 連結，沒有任何線索說明自己在哪——粗體與底線是給看得見的人的。
 *
 * 角色過濾**不在這裡做**：`items` 已經由伺服器端用 `navFor()` 篩過，
 * 所以瀏覽器連「有這個連結存在」都不會知道。
 */
'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button } from '@/components/Button';
import { activeHref, ROLE_LABELS, type NavItem } from '@/lib/nav';

/**
 * 收件匣把幾則標成已讀之後，用它通知導覽列重新問一次未讀數。
 *
 * 匯出成一個常數而不是兩邊各打一次字串：打錯的話**不會有任何錯誤，
 * 只是那個數字不再更新**，而那是這個功能最容易失敗的地方。
 */
export const UNREAD_CHANGED = 'yz:unread-changed';

/**
 * 未讀數。
 *
 * # 為什麼是在瀏覽器端問，而不是由版面算好傳進來
 *
 * 因為它必須**在不重新載入整頁的情況下跟著變**。使用者在收件匣裡
 * 把幾則標成已讀，而那個數字如果是伺服器元件在頁面載入時算好的一個
 * 字面值，它會停在原本的數字——**於是那個紅點永遠不歸零，而一週
 * 之後沒有人再看它**。
 *
 * # 兩個觸發點，缺一個都會讓數字停住
 *
 *   · **換頁時**（依賴 `pathname`）。剛剛產生的通知在下一次換頁
 *     就看得到。
 *   · **收到 `UNREAD_CHANGED` 事件時**。`router.refresh()` 只重跑
 *     伺服器元件，client component 的 effect 依賴沒變就不會再跑——
 *     所以在收件匣裡標記已讀之後，光靠 refresh 這個數字不會動。
 *
 * 不做定時輪詢：每一個開著頁面的瀏覽器每分鐘敲一次資料庫，而同一台
 * 機器同時要服務正在考試的學生（理由與工作者把匯入併發設成 1 相同）。
 *
 * 失敗一律當成 0：這個數字畫在每一頁上，讓它有能力顯示錯誤
 * 等於把一個裝飾品放到承重牆上。
 */
function useUnread(pathname: string): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    // 元件卸載後不要再 setState（換頁很快時真的會發生）。
    let alive = true;
    const ask = () => {
      fetch('/api/notifications/unread')
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => {
          if (alive && b && typeof b.unread === 'number') setN(b.unread);
        })
        .catch(() => {});
    };
    ask();
    window.addEventListener(UNREAD_CHANGED, ask);
    return () => {
      alive = false;
      window.removeEventListener(UNREAD_CHANGED, ask);
    };
  }, [pathname]);
  return n;
}

export function Nav({
  items,
  displayName,
  systemRole,
}: {
  items: NavItem[];
  displayName: string;
  systemRole: string;
}) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const current = activeHref(pathname);
  const unread = useUnread(pathname);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      // 就算請求失敗也要離開這個畫面：cookie 可能已經清掉了，
      // 留在原地只會看到一堆查不到資料的空白區塊。
      // replace 而不是 push——登出後按上一頁不該回到內部畫面。
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <nav className="yz-nav" aria-label="主導覽">
      <Link
        href="/"
        className="yz-nav__brand"
        aria-current={pathname === '/' ? 'page' : undefined}
      >
        雲端智學
      </Link>

      {/* 學生與家長目前一個項目都沒有，那就不要留一個空的清單在版面裡。 */}
      {items.length > 0 && (
        <ul className="yz-nav__links">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="yz-nav__link"
                aria-current={current === item.href ? 'page' : undefined}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="yz-nav__right">
        <span>
          {displayName}
          <span className="yz-nav__role">{ROLE_LABELS[systemRole] ?? systemRole}</span>
        </span>
        {/* 通知放在這裡而不是 NAV_ITEMS 裡，理由與旁邊的「更換密碼」
            一樣：**每一個角色都有，而且只關於他自己。** 放進主導覽會
            打亂那一份清單刻意的順序（老師的動線是題庫→匯入→考卷→
            派卷→成績，而通知會插在最前面，因為前面幾項對學生是被
            過濾掉的）。

            未讀數只在真的有未讀的時候才畫。**一個寫著 0 的紅點是最快
            被學會忽略的東西**，而那正是這個功能最容易失敗的地方。
            超過 99 顯示「99+」：三位數會把導覽列撐開，而 100 與 137
            對使用者是同一個意思。 */}
        <Link
          href="/inbox"
          className="yz-nav__link"
          aria-current={pathname === '/inbox' ? 'page' : undefined}
        >
          通知
          {unread > 0 && (
            <span className="yz-nav__badge">
              {unread > 99 ? '99+' : unread}
              {/* 數字本身讀螢幕的人聽到的是一串沒有上下文的字。 */}
              <span className="yz-sr">則未讀</span>
            </span>
          )}
        </Link>
        {/* 更換密碼放在這裡而不是 NAV_ITEMS 裡，因為它**每個角色都有**
            ——放進主導覽等於在學生唯一的一個項目旁邊多一個他一學期
            用一次的東西。但它不能只存在於強制更換那條路（/password，
            由 mustChangePassword 觸發）：學生後來想自己換一組時，
            那條路走不到，唯一的方法是猜網址。密碼被同學看到是每一週
            都會發生的事，而系統裡沒有出口。 */}
        <Link
          href="/settings/password"
          className="yz-nav__link"
          aria-current={pathname === '/settings/password' ? 'page' : undefined}
        >
          更換密碼
        </Link>
        <Button
          variant="quiet"
          className="yz-nav__out"
          onClick={signOut}
          busy={busy}
          busyLabel="登出中…"
        >
          登出
        </Button>
      </div>
    </nav>
  );
}
