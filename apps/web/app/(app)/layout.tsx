import { redirect } from 'next/navigation';

import { Nav } from '@/components/Nav';
import { requireUser } from '@/lib/auth';
import { navFor } from '@/lib/nav';

/**
 * 登入之後的所有頁面共用這一層：檢查身分，然後給一條導覽列。
 *
 * 導覽列的項目在**這裡**依角色篩掉（`navFor`），不是在瀏覽器端隱藏——
 * 學生拿到的頁面原始碼裡，連「有匯入這個地方」都不會出現。
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (!user) redirect('/login');
  // 初始密碼會出現在設定檔與備份中，不該長期有效
  if (user.mustChangePassword) redirect('/password?first=1');

  return (
    <div className="yz-shell">
      <Nav
        items={navFor(user.systemRole)}
        displayName={user.displayName}
        systemRole={user.systemRole}
      />
      <div className="yz-shell__main">{children}</div>
    </div>
  );
}
