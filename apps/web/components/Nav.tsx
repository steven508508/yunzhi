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
import { useState } from 'react';

import { Button } from '@/components/Button';
import { activeHref, ROLE_LABELS, type NavItem } from '@/lib/nav';

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
