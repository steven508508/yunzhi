import { redirect } from 'next/navigation';

/**
 * KaTeX 的樣式表**只在這裡匯入這一次**。
 *
 * 每個用到 <MathText> 的元件各自 import 一份的話，打包器會去重、但
 * 載入順序會跟著元件樹跑，而 KaTeX 的樣式對順序敏感（它自己就有
 * 好幾層以特異度覆寫的規則）。放在這一層則是一條確定的規則：
 * 登入之後的每一頁都有，而且只有一份。
 *
 * **不可以改成 CDN。** 字型（.woff2）與樣式全部走 npm 套件的本地檔案，
 * 由打包器連字型一起吐進 .next/static。理由與 app/layout.tsx 拿掉
 * Google Fonts 完全相同：這套系統部署在補習班機房的封閉網段，
 * 資料不能離開校內，而對外的請求在那裡是 ERR_TUNNEL_CONNECTION_FAILED。
 * 從 CDN 載 KaTeX 的失效方式比字型更糟——字型退回系統預設還讀得懂，
 * 數學式沒有那份 CSS 會變成上下標全部攤平的一串亂碼。
 *
 * 登入頁與改密碼頁在這一層外面，不會付這個成本（它們沒有數學式）。
 */
import 'katex/dist/katex.min.css';

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
