/**
 * 自己更換密碼。
 *
 * # 為什麼這一頁要存在，而 `/password` 已經有一個
 *
 * `/password` 是**強制**的那一條路：`(app)/layout.tsx` 看到
 * `mustChangePassword` 就把人踢過去，所以它刻意在版面外面（沒有導覽列
 * ——那時候還不該讓人到處逛）。
 *
 * 但學生後來想自己換一組密碼時，那條路走不到：他沒有 `mustChangePassword`，
 * 而導覽列上沒有任何連結指向 `/password`。**唯一的方法是自己猜網址。**
 * 密碼被同學看到、或用了太久想換掉，是每一週都會發生的事，而系統裡
 * 沒有出口。
 *
 * 所以這一頁在版面裡面（有導覽列，換完能回得去），走的是同一支 API。
 *
 * # 為什麼不做「忘記密碼」的自助流程
 *
 * 因為這些學生多半沒有登記 email，而系統跑在補習班的封閉網段裡，
 * 對外的 SMTP 是 ERR_TUNNEL_CONNECTION_FAILED。忘記密碼的實際流程是
 * 「跟老師講，老師當場給一組新的」——那條路在班級名冊頁上（重設密碼）。
 * 這一頁處理的是**記得舊密碼、想換一組**，兩件事不一樣。
 */
import Link from 'next/link';

import { scopedPage } from '@/lib/page';
import ChangePassword from './ChangePassword';

export const dynamic = 'force-dynamic';

export default async function PasswordSettingsPage() {
  // 這一頁不查資料庫，但仍然走 `scopedPage`：它要的是登入檢查
  // （沒登入就導到登入頁），而那件事不該每一頁自己寫一次。
  return scopedPage(async (user) => (
    <main className="yz-panel">
      <div className="yz-panel__head">
        <h1>更換密碼</h1>
        <p className="yz-panel__sub">
          {user.displayName}（{user.username}）　·　<Link href="/">回到首頁</Link>
        </p>
      </div>
      <ChangePassword username={user.username} />
    </main>
  ));
}
