/**
 * 教職員帳號的建立、改角色、停用與重設密碼。
 *
 * # 為什麼初始密碼顯示在對話框裡而不是表格上
 *
 * 因為它只能被看到一次，而**表格上的東西會被截圖、會留在畫面上、
 * 會被下一位走過來的人看到**。對話框是強制的：管理員要嘛抄下來，
 * 要嘛關掉重來。與班級頁的重設密碼同一個做法（見
 * `classes/[classId]/ResetPassword.tsx` 的檔頭），兩處看起來一致——
 * 一致本身就是安全性：使用者只需要學會一次「這串字關掉就沒了」。
 *
 * # 為什麼這一支刻意不在拿到密碼之後 `router.refresh()`
 *
 * refresh 會重新拉一次伺服器元件並重新調和整棵樹，而新密碼只存在於
 * 這個元件的 state 裡。只要那次調和讓元件重新掛載（表格重排、列的
 * key 變了），**那串字就永遠消失了**——它沒有第二個副本，而管理員
 * 還沒抄。所以先顯示密碼，等他按「我抄好了」關掉之後才 refresh。
 *
 * # 為什麼危險的按鈕在前端也要判斷一次
 *
 * 伺服器端擋得住（`lib/staffRules.mjs`），但一顆按下去必定被退回的
 * 按鈕，對使用者來說與「壞掉的按鈕」沒有分別。前端擋的是誤觸與
 * 白按一次的挫折，伺服器端擋的是規則——兩邊都要有。
 *
 * # 為什麼「停用」與「刪除」兩顆都要有
 *
 * 因為停用**不釋放登入代號**。`@@unique([tenantId, username])` 之下，
 * 一個停用的帳號仍然佔著 `T001`，而新來接手的老師最自然的代號正是
 * `T001`——建立時會撞鍵，而錯誤訊息說「已經有人在用了」，
 * 那個人是一位半年前離職的老師。
 *
 * 停用是可逆的（留職停薪、先關掉再說），刪除是離職。
 * 兩者的差別要寫在確認視窗裡，否則使用者會挑錯那一顆。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { SelectField, TextField } from '@/components/Field';
import { Empty, Note } from '@/components/Feedback';
import { Form, submitJson, useAction } from '@/components/Form';
import { Table } from '@/components/Table';

export type Staff = {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  systemRole: string;
  roleLabel: string;
  status: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  /** 被指派了幾筆「這個班的這一科」。0 表示他登得進來但什麼都看不到。 */
  teaching: number;
};

type Credential = {
  userId: string;
  username: string;
  displayName: string;
  password: string;
};

/**
 * 一次性密碼的呈現。
 *
 * 用 `<output>` 而不是 `<span>`：它有隱含的 `aria-live`，讀螢幕的人
 * 在密碼出現的當下就會聽到，而不必自己找。這串字的整個用途就是
 * 「現在把它唸出來或抄下來」。
 */
function Secret({ value }: { value: string }) {
  return <output className="yz-secret">{value}</output>;
}

export default function StaffEditor({
  me,
  staff,
  roles,
  activeSysAdmins,
}: {
  me: { id: string; systemRole: string };
  staff: Staff[];
  roles: { value: string; label: string }[];
  activeSysAdmins: number;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(staff.length === 0);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [editing, setEditing] = useState<Staff | null>(null);
  const [suspending, setSuspending] = useState<Staff | null>(null);
  const [resetting, setResetting] = useState<Staff | null>(null);
  const [removing, setRemoving] = useState<Staff | null>(null);
  const [typed, setTyped] = useState('');
  // 兩組動作狀態，不是一組。對話框裡的錯誤要顯示在對話框裡（使用者的
  // 視線在那裡），表格裡那顆「重新啟用」的錯誤要顯示在表格上方——
  // 共用一個 `error` 的話，其中一則訊息會出現在一個沒有打開的對話框裡，
  // 而畫面上是一顆按了沒反應的按鈕。
  const { busy, error, clearError, run } = useAction();
  const row = useAction();

  // 只有系統管理員給得起系統管理員（見 lib/staffRules.mjs 的 checkGrant）。
  // 校務管理員看到那個選項卻選不了，比看不到更令人困惑。
  const grantable = roles.filter(
    (r) => r.value !== 'SYS_ADMIN' || me.systemRole === 'SYS_ADMIN',
  );

  /** 這一位是不是「唯一一位可以登入的系統管理員」。 */
  const isLastAdmin = (s: Staff) =>
    s.systemRole === 'SYS_ADMIN' && s.status === 'ACTIVE' && activeSysAdmins <= 1;

  /** 這個帳號動不動得了。動不了時回一句給人看的理由。 */
  function lockedReason(s: Staff): string | null {
    if (s.systemRole === 'SYS_ADMIN' && me.systemRole !== 'SYS_ADMIN') {
      return '只有系統管理員能修改系統管理員的帳號';
    }
    return null;
  }

  /**
   * 角色改不改得了。伺服器端（lib/staffRules.mjs）擋的是同一組情況——
   * 這裡多擋一次是為了不要給出一顆按下去必定被退回的按鈕，
   * 那對使用者來說與壞掉的按鈕沒有分別。
   */
  function roleLockReason(s: Staff): string | null {
    const locked = lockedReason(s);
    if (locked) return locked;
    if (s.id === me.id) return '改不了自己的角色';
    if (isLastAdmin(s)) return '唯一的系統管理員';
    return null;
  }

  async function reactivate(s: Staff) {
    const ok = await row.run(async () => {
      await submitJson(`/api/staff/${s.id}`, { method: 'PATCH', json: { status: 'ACTIVE' } });
    });
    if (ok) router.refresh();
  }

  async function suspend(s: Staff) {
    const ok = await run(async () => {
      await submitJson(`/api/staff/${s.id}`, { method: 'PATCH', json: { status: 'SUSPENDED' } });
    });
    if (ok) {
      setSuspending(null);
      router.refresh();
    }
  }

  async function remove(s: Staff) {
    const ok = await run(async () => {
      await submitJson(`/api/staff/${s.id}`, { method: 'DELETE' });
    });
    if (ok) {
      setRemoving(null);
      setTyped('');
      router.refresh();
    }
  }

  return (
    <>
      {adding ? (
        <div className="yz-card" style={{ marginBottom: 22 }}>
          <h2 className="yz-card__title">新增教職員帳號</h2>
          <NewStaffForm
            roles={grantable}
            onDone={(c) => {
              setAdding(false);
              // 先給密碼，refresh 等他關掉對話框才做——理由見檔頭。
              setCredential(c);
            }}
            onCancel={staff.length === 0 ? undefined : () => setAdding(false)}
          />
        </div>
      ) : (
        <div style={{ marginBottom: 20 }}>
          <Button variant="primary" onClick={() => setAdding(true)}>
            新增教職員帳號
          </Button>
        </div>
      )}

      {/* 改帳號開一張卡片，而不是在表格裡放一個一選就送出的下拉。
          兩個理由：角色異動是**發權限**，不該是一次滑鼠滾輪的意外；
          而且表格裡的下拉沒有地方顯示伺服器退回的理由，
          使用者看到的會是一顆選了又跳回去的控制項。 */}
      {editing && (
        <div className="yz-card" style={{ marginBottom: 22 }}>
          <h2 className="yz-card__title">
            改「{editing.displayName}」的帳號
          </h2>
          <RoleForm
            // key 讓換一位編輯時整個表單重建。少了它，React 會沿用同一個
            // 元件實例，而下拉的初始值只在第一次掛載時讀——畫面上是
            // 「改王老師」，格子裡卻是上一位的角色，存下去就改錯人了。
            key={editing.id}
            staff={editing}
            roles={grantable}
            roleLocked={roleLockReason(editing)}
            onDone={() => {
              setEditing(null);
              router.refresh();
            }}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      {row.error && <Note tone="error">{row.error}</Note>}

      <Table
        caption="教職員一覽"
        columns={[
          {
            key: 'n',
            head: '姓名',
            cell: (s: Staff) => (
              <>
                {s.displayName}
                {s.id === me.id && <span className="yz-muted">（你自己）</span>}
                {s.status !== 'ACTIVE' && <span className="yz-warn">（已停用）</span>}
              </>
            ),
          },
          { key: 'u', head: '登入帳號', cell: (s: Staff) => s.username },
          {
            key: 'r',
            head: '角色',
            cell: (s: Staff) => (
              <>
                {s.roleLabel}
                {/* 改不了的三種情況各自說出理由。只是把按鈕藏起來的話，
                    看的人會以為系統壞了，然後去找別的路徑試。 */}
                {roleLockReason(s) && (
                  <span className="yz-muted">（{roleLockReason(s)}）</span>
                )}
              </>
            ),
          },
          {
            key: 't',
            head: '授課',
            numeric: true,
            cell: (s: Staff) =>
              s.teaching > 0 ? (
                s.teaching
              ) : (
                // 0 不是「還沒設定」那麼輕的事：這位老師登得進來，
                // 但成績、派卷、題庫的科目篩選對他全是空的。
                <span className="yz-warn" title="還沒指派任何班級科目，他看不到任何成績">
                  未指派
                </span>
              ),
          },
          {
            key: 'l',
            head: '最後登入',
            cell: (s: Staff) =>
              s.lastLoginAt ? (
                <>
                  {s.lastLoginAt}
                  {/* 還帶著臨時密碼的人要看得出來：他若把那張紙弄丟了，
                      正確的下一步是重設，而不是等他自己想起來。 */}
                  {s.mustChangePassword && (
                    <span className="yz-muted">仍是臨時密碼</span>
                  )}
                </>
              ) : (
                <span className="yz-muted">從未登入</span>
              ),
          },
          {
            key: 'act',
            head: <span className="yz-sr">動作</span>,
            cell: (s: Staff) => {
              const locked = lockedReason(s);
              if (locked) return <span className="yz-muted">{locked}</span>;
              return (
                <span className="yz-rowacts" style={{ justifyContent: 'flex-end' }}>
                  {/* 「改帳號」不再被 roleLockReason 停用。
                      姓名與登入代號**永遠改得動**——它們不發任何權限，
                      而在此之前這顆按鈕連同姓名一起被鎖住，於是唯一的
                      系統管理員（多半就是主任自己）的名字打錯了就是一輩子。
                      角色那一格在表單裡另外鎖，理由也印在旁邊。 */}
                  <Button
                    variant="quiet"
                    onClick={() => setEditing(s)}
                    disabled={busy || row.busy}
                  >
                    改帳號
                  </Button>
                  <Button variant="quiet" onClick={() => setResetting(s)} disabled={busy || row.busy}>
                    重設密碼
                  </Button>
                  {s.status === 'ACTIVE' ? (
                    <Button
                      variant="quiet"
                      onClick={() => setSuspending(s)}
                      disabled={busy || row.busy || s.id === me.id || isLastAdmin(s)}
                      title={
                        s.id === me.id
                          ? '不能停用自己的帳號'
                          : isLastAdmin(s)
                            ? '這是唯一一位可以登入的系統管理員'
                            : undefined
                      }
                    >
                      停用
                    </Button>
                  ) : (
                    <Button
                      onClick={() => void reactivate(s)}
                      busy={row.busy}
                      busyLabel="啟用中…"
                      disabled={busy}
                    >
                      重新啟用
                    </Button>
                  )}
                  {/* 刪除排在最後。它與旁邊那幾顆不是同一種東西：
                      停用可逆、刪除不可逆，而且只有刪除會把登入代號
                      放回去給下一位老師用。 */}
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setTyped('');
                      setRemoving(s);
                    }}
                    disabled={busy || row.busy || s.id === me.id || isLastAdmin(s)}
                    title={
                      s.id === me.id
                        ? '不能刪除自己的帳號'
                        : isLastAdmin(s)
                          ? '這是唯一一位可以登入的系統管理員'
                          : '離職。會把登入代號放回去給別人用'
                    }
                  >
                    刪除
                  </Button>
                </span>
              );
            },
          },
        ]}
        rows={staff}
        rowKey={(s) => s.id}
        selectedKey={editing?.id ?? null}
        empty={
          <Empty
            title="還沒有教職員帳號"
            hint="除了安裝時建立的管理員之外還沒有人。老師要有帳號才登得進來，才指派得了授課班級。"
          />
        }
      />

      {/* 停用 */}
      <ConfirmDialog
        open={suspending !== null}
        onClose={() => {
          if (busy) return;
          clearError();
          setSuspending(null);
        }}
        busy={busy}
        title={suspending ? `停用「${suspending.displayName}」的帳號` : ''}
        confirmLabel="停用這個帳號"
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              他會<strong>立刻被登出所有裝置</strong>，而且再也登不進來，直到有人重新啟用。
            </p>
            <p style={{ marginBottom: 12 }}>
              他出過的題目、組過的卷子、派過的任務與批改記錄<strong>全部保留</strong>，
              授課指派也還在——重新啟用之後一切照舊。停用不是刪除。
            </p>
            {suspending && suspending.teaching > 0 && (
              <p style={{ marginBottom: 12 }}>
                他目前有 <strong>{suspending.teaching} 筆授課指派</strong>。
                那幾個班的那幾科<strong>會少一位改得動成績的人</strong>——
                停用之前先確認還有別人接得起來。
              </p>
            )}
            <p className="yz-hint">誰在什麼時候停用了誰會寫進稽核記錄，行為人是你。</p>
            {error && <p className="yz-field__err">{error}</p>}
          </>
        }
        onConfirm={() => suspending && void suspend(suspending)}
      />

      {/* 刪除（離職）。與停用分開，理由見檔頭。 */}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => {
          if (busy) return;
          clearError();
          setTyped('');
          setRemoving(null);
        }}
        busy={busy}
        title={removing ? `刪除「${removing.displayName}」的帳號` : ''}
        confirmLabel={
          removing && typed.trim() === removing.username ? '確定刪除，不可復原' : '請先打出登入帳號'
        }
        confirmDisabled={!removing || typed.trim() !== removing.username}
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              <strong>這是離職用的，而且不可逆。</strong>只是要暫時關掉他的帳號，
              請用「停用」——那個放得回來。
            </p>
            <p style={{ marginBottom: 12 }}>
              刪除會把姓名與信箱清掉、密碼作廢、所有裝置登出，而且
              <strong>把登入帳號「{removing?.username}」放回去</strong>。
              停用不會放——所以新來接手的老師若要用同一個代號，只有刪除做得到。
            </p>
            {removing && removing.teaching > 0 && (
              <p style={{ marginBottom: 12 }}>
                他目前有 <strong>{removing.teaching} 筆授課指派</strong>，會一起被清掉，
                導師身分也是。那幾個班的那幾科<strong>會少一位改得動成績的人</strong>——
                刪除之前先確認有別人接得起來。
              </p>
            )}
            <p style={{ marginBottom: 12 }}>
              他出過的題目、組過的卷子、派過的任務與批改記錄<strong>全部保留</strong>，
              建立者會顯示成「已刪除的帳號」。抽掉那些會讓歷史成績對不回任何人。
            </p>
            <p className="yz-hint" style={{ marginBottom: 12 }}>
              誰在什麼時候刪除了誰會寫進稽核記錄，行為人是你。
            </p>
            <TextField
              label="請打出他的登入帳號以確認"
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
              hint={`要完全相同：${removing?.username ?? ''}`}
              autoComplete="off"
              disabled={busy}
            />
            {error && <p className="yz-field__err">{error}</p>}
          </>
        }
        onConfirm={() => removing && void remove(removing)}
      />

      {/* 重設密碼 */}
      <ConfirmDialog
        open={resetting !== null}
        onClose={() => {
          if (busy) return;
          clearError();
          setResetting(null);
        }}
        busy={busy}
        title={resetting ? `重設「${resetting.displayName}」的密碼` : ''}
        confirmLabel="產生新密碼"
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              系統會產生一組新的臨時密碼，<strong>只顯示這一次</strong>，請當場交給他。
              他<strong>目前的密碼會立刻失效</strong>，而且所有裝置上的登入都會被登出。
            </p>
            <p style={{ marginBottom: 12 }}>
              如果他之前試錯太多次被鎖住了，這次重設也會一併解鎖——不必等 15 分鐘。
            </p>
            <p className="yz-hint">
              誰在什麼時候重設了誰的密碼會寫進稽核記錄，行為人是你。密碼本身不會被記錄在任何地方。
            </p>
            {error && <p className="yz-field__err">{error}</p>}
          </>
        }
        onConfirm={() =>
          void run(async () => {
            if (!resetting) return;
            const r = await submitJson<{ credential: Credential }>(
              `/api/staff/${resetting.id}/password`,
            );
            setResetting(null);
            setCredential(r.credential);
          })
        }
      />

      {/* 一次性密碼 */}
      <Dialog
        open={credential !== null}
        onClose={() => {
          setCredential(null);
          router.refresh();
        }}
        title={credential ? `${credential.displayName}的登入資訊` : ''}
        footer={
          <Button
            variant="primary"
            onClick={() => {
              setCredential(null);
              router.refresh();
            }}
          >
            我抄好了，關閉
          </Button>
        }
      >
        <Note tone="warn">
          這串字<b>關掉就看不到了</b>，系統裡沒有第二個副本——請現在當場交給他。
          他下次登入時會被要求換成自己的密碼。
        </Note>
        <dl className="yz-cred">
          <div>
            <dt>登入帳號</dt>
            <dd>{credential?.username}</dd>
          </div>
          <div>
            <dt>臨時密碼</dt>
            <dd>{credential && <Secret value={credential.password} />}</dd>
          </div>
        </dl>
        <p className="yz-hint">
          帳號建好之後他就登得進來了，但<b>還看不到任何成績</b>——
          要到班級頁把他指派成某個班某一科的授課老師，或指派成導師。
        </p>
      </Dialog>
    </>
  );
}

/**
 * 改帳號：姓名、登入代號、信箱、角色。
 *
 * # 為什麼四個欄位在同一張表單裡
 *
 * 因為它們是同一件事的四個面向——「這個帳號的資料不對了」。
 * 管理員拿到的通常是一整份更正單（名字打錯、順便換一個代號），
 * 而分成四次送出是四次等待與四次可能失敗。
 *
 * 但**角色那一格會被單獨鎖住**（最後一位系統管理員、自己的角色），
 * 而姓名與代號永遠改得動：它們不發任何權限。合在一起鎖的話，
 * 唯一的系統管理員——多半就是主任自己——的名字打錯了就是一輩子。
 *
 * # 改代號會把他登出
 *
 * 他正拿著舊代號在登入。不講出來的話，他明天照著舊代號打、登不進去、
 * 試五次把帳號鎖住，而管理員完全不知道發生了什麼。
 */
function RoleForm({
  staff,
  roles,
  roleLocked,
  onDone,
  onCancel,
}: {
  staff: Staff;
  roles: { value: string; label: string }[];
  /** 角色改不了的話，是為什麼。姓名與代號不受它影響。 */
  roleLocked: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState(staff.displayName);
  const [username, setUsername] = useState(staff.username);
  const [email, setEmail] = useState(staff.email ?? '');
  const [systemRole, setSystemRole] = useState(staff.systemRole);

  const idChanged = username.trim() !== staff.username;

  return (
    <Form
      onSubmit={async () => {
        await submitJson(`/api/staff/${staff.id}`, {
          method: 'PATCH',
          json: {
            displayName: displayName.trim(),
            username: username.trim(),
            email: email.trim() || null,
            // 鎖住時完全不送這個欄位。送一個「與現在相同」的值也行，
            // 但那會讓伺服器多跑一次規則檢查，而其中一條是
            // 「不能改自己的角色」——主任改自己的名字時會被那一條擋下來。
            ...(roleLocked ? {} : { systemRole }),
          },
        });
        onDone();
      }}
    >
      {({ busy }) => (
        <>
          <div className="yz-row">
            <TextField
              label="姓名"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.currentTarget.value)}
              hint="老師與學生在畫面上看到的名字，導覽列右上角的也是這一個。"
              autoFocus
            />
            <TextField
              label="登入帳號"
              required
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              hint={
                idChanged
                  ? '改了之後他會被立刻登出，而且要用新代號才登得進來——記得當場告訴他。密碼不變。'
                  : '教師代號，例如 T001。中間不能有空白——他會照著它打。'
              }
              autoComplete="off"
            />
          </div>
          <SelectField
            label="角色"
            required
            value={systemRole}
            onChange={(e) => setSystemRole(e.currentTarget.value)}
            disabled={roleLocked !== null}
            hint={
              roleLocked
                ? `這個帳號的角色改不了：${roleLocked}。姓名與登入帳號不受影響，照樣改得動。`
                : `目前是${staff.roleLabel}。` +
                  '改成老師之後，他只看得到自己被指派的班級與科目——' +
                  '原本看得到的成績會在下一次重新整理時消失，而他不會收到通知。'
            }
          >
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
            {/* 現任角色若不在可指派清單裡，仍然要顯示得出來，
                否則下拉會落在第一個選項上，看起來像他已經被降級了。 */}
            {!roles.some((r) => r.value === staff.systemRole) && (
              <option value={staff.systemRole}>{staff.roleLabel}</option>
            )}
          </SelectField>
          <TextField
            label="信箱"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            hint="選填，而且系統目前不會寄任何信。清空請把格子留白。"
            autoComplete="off"
          />
          <div className="yz-actions">
            <span className="yz-actions__spacer" />
            <Button variant="quiet" onClick={onCancel} disabled={busy}>
              取消
            </Button>
            <Button type="submit" variant="primary" busy={busy} busyLabel="儲存中…">
              儲存
            </Button>
          </div>
        </>
      )}
    </Form>
  );
}

/** 新增。角色清單由伺服器端傳進來，前端不自己列第二份。 */
function NewStaffForm({
  roles,
  onDone,
  onCancel,
}: {
  roles: { value: string; label: string }[];
  onDone: (c: Credential) => void;
  onCancel?: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  // 預設老師。絕大多數新帳號都是老師，而預設值選錯的方向要往
  // 「權限比較小」倒——多給了不會有人來講。
  const [systemRole, setSystemRole] = useState(roles[0]?.value ?? 'TEACHER');

  return (
    <Form
      onSubmit={async () => {
        const r = await submitJson<{ credential: Credential }>('/api/staff', {
          json: {
            displayName: displayName.trim(),
            username: username.trim(),
            systemRole,
            email: email.trim() || null,
          },
        });
        onDone(r.credential);
      }}
    >
      {({ busy }) => (
        <>
          <div className="yz-row">
            <TextField
              label="姓名"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.currentTarget.value)}
              hint="老師與學生在畫面上看到的名字。"
              autoFocus
            />
            <TextField
              label="登入帳號"
              required
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              hint="教師代號，例如 T001。中間不能有空白——他會照著它打。"
              autoComplete="off"
            />
          </div>
          <SelectField
            label="角色"
            required
            value={systemRole}
            onChange={(e) => setSystemRole(e.currentTarget.value)}
            hint="老師只看得到自己被指派的班級與科目；學科召集人跨班看同一科；管理員看得到全部，還能開班、改科目與帳號。"
          >
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </SelectField>
          <TextField
            label="信箱"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            hint="選填，而且系統目前不會寄任何信（機房沒有對外的寄信管道）。留著是為了日後對得上人。"
            autoComplete="off"
          />
          <div className="yz-actions">
            <span className="yz-actions__spacer" />
            {onCancel && (
              <Button variant="quiet" onClick={onCancel} disabled={busy}>
                取消
              </Button>
            )}
            <Button type="submit" variant="primary" busy={busy} busyLabel="建立中…">
              建立帳號並產生密碼
            </Button>
          </div>
        </>
      )}
    </Form>
  );
}
