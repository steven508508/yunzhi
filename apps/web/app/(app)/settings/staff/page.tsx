import { mayUse, ROLE_LABELS } from '@/lib/nav';
import { scopedPage } from '@/lib/page';
import { listStaff } from '@/lib/staff';
import { ASSIGNABLE_ROLES } from '@/lib/staffRules.mjs';
import { Denied, Note } from '@/components/Feedback';
import StaffEditor from './StaffEditor';

export const dynamic = 'force-dynamic';

const AREA = '/settings/staff';

export default async function StaffPage() {
  return scopedPage(async (user) => {
    if (!mayUse(user.systemRole, AREA)) {
      return (
        <main className="yz-panel">
          <Denied
            what="教職員帳號"
            why="帳號與角色決定了誰看得到哪些學生的成績與個人資料，所以只有管理員能改。"
          />
        </main>
      );
    }

    const staff = await listStaff();

    // 「還剩幾個可以登入的系統管理員」要在伺服器端算，因為畫面上
    // 那幾顆按鈕要不要停用取決於它。前端自己數列表也數得出來，
    // 但那份列表可能已經過期（另一個分頁剛剛停用了一個），
    // 而按下去被退回的訊息看起來像系統壞了。
    const activeSysAdmins = staff.filter(
      (s) => s.systemRole === 'SYS_ADMIN' && s.status === 'ACTIVE',
    ).length;

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>教職員</h1>
          <p className="yz-panel__sub">
            老師、學科召集人與管理員的帳號都在這裡建立。
            建好之後還要到<b>班級頁指派他教哪個班的哪一科</b>——
            沒有指派的老師登得進來，但看不到任何成績，也派不了卷子。
          </p>
        </div>

        <Note tone="info">
          <b>學生帳號不從這裡建立。</b>
          學生走班級頁的名冊匯入，那條路徑會一併處理家長同意、入班與初始密碼列印。
          從這裡建出來的學生不在任何班上，也登不進去。
        </Note>

        {activeSysAdmins === 1 && (
          <Note tone="warn">
            目前只有一位可以登入的系統管理員。他忘記密碼或帳號被鎖住時，
            系統裡<b>沒有任何一條救得回來的路徑</b>——只能進機房改資料庫。
            建議再指派一位，兩個人不會同時忘記。
          </Note>
        )}

        <StaffEditor
          me={{ id: user.id, systemRole: user.systemRole }}
          staff={staff.map((s) => ({
            id: s.id,
            username: s.username,
            displayName: s.displayName,
            email: s.email,
            systemRole: s.systemRole,
            roleLabel: ROLE_LABELS[s.systemRole] ?? s.systemRole,
            status: s.status,
            lastLoginAt: s.lastLoginAt ? s.lastLoginAt.toLocaleDateString('zh-TW') : null,
            mustChangePassword: s.mustChangePassword,
            teaching: s._count.subjectTeaching,
          }))}
          roles={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] ?? r }))}
          activeSysAdmins={activeSysAdmins}
        />
      </main>
    );
  });
}
