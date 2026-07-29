/**
 * 改一位學生的姓名與學號、退補、以及個資刪除。
 *
 * # 為什麼這幾件事擠在同一顆按鈕後面
 *
 * 因為它們共用同一個問題：「這一列的這個人，不對了」。
 * 名字打錯（每學期 5–10 次）、學號打錯、退費不來了、家長來信要求
 * 刪除資料——櫃檯遇到的時候手上只有名冊那一列。分成四個入口的話，
 * 他要先知道哪一件事在哪裡。
 *
 * # 三段的危險程度不同，所以版面上分三段
 *
 *   改資料　　可逆，每學期都在做　　　　　　→ 直接是一張表單
 *   退補　　　可逆（放得回來），一學期十幾次 → 確認視窗
 *   個資刪除　**不可逆**，一學期一兩次　　　→ 確認視窗＋要打出姓名
 *
 * 最後一段刻意放在最下面而且隔一段距離：它與上面那兩件不是同一種
 * 東西，而每天在按前兩顆的人不該一直看到它。
 *
 * # 改學號會把他登出
 *
 * 他正拿著舊學號在登入。不講出來的話，他明天照著舊學號打、登不進去、
 * 試五次把帳號鎖住，而櫃檯完全不知道發生了什麼。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { TextField } from '@/components/Field';
import { Note } from '@/components/Feedback';
import { Form, submitJson, useAction } from '@/components/Form';

export type EditableStudent = {
  id: string;
  username: string;
  displayName: string;
  guardianEmail: string | null;
  status: string;
};

export default function StudentEditor({
  student,
  mayErase,
}: {
  student: EditableStudent;
  /** 個資刪除只有管理員做得到。導師看不到那一段。 */
  mayErase: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [typed, setTyped] = useState('');
  const { busy, error, clearError, run } = useAction();

  const archived = student.status === 'ARCHIVED';

  async function patch(json: Record<string, unknown>, close: () => void) {
    const ok = await run(async () => {
      await submitJson(`/api/students/${student.id}`, { method: 'PATCH', json });
    });
    if (ok) {
      close();
      router.refresh();
    }
  }

  return (
    <>
      <Button variant="quiet" onClick={() => setOpen(true)}>
        編輯
      </Button>

      <Dialog
        open={open}
        onClose={() => {
          if (busy) return;
          clearError();
          setOpen(false);
        }}
        title={`${student.displayName}（${student.username}）`}
      >
        <EditForm
          student={student}
          onDone={() => {
            setOpen(false);
            router.refresh();
          }}
        />

        <div className="yz-editor__part">
          <h3 className="yz-editor__head">{archived ? '放回可登入' : '退補'}</h3>
          {archived ? (
            <>
              <p className="yz-hint" style={{ marginBottom: 10 }}>
                這個帳號目前是停用的，他登不進來。放回來之後他原本的密碼還有效——
                忘記了請用「重設密碼」。<strong>班籍不會跟著回來</strong>，
                要入班請重新匯入名冊或從「已移出的學生」復原。
              </p>
              <Button
                onClick={() => void patch({ status: 'ACTIVE' }, () => setOpen(false))}
                busy={busy}
                busyLabel="處理中…"
              >
                放回可登入
              </Button>
            </>
          ) : (
            <>
              <p className="yz-hint" style={{ marginBottom: 10 }}>
                他退費不來了。停用會把他移出所有班級、立刻登出所有裝置，而且他再也
                登不進來。<strong>成績與作答全部保留</strong>，之後放得回來。
              </p>
              <Button variant="quiet" onClick={() => setArchiving(true)} disabled={busy}>
                退補（停用這個帳號）
              </Button>
            </>
          )}
        </div>

        {/* 個資刪除隔一段距離，而且只有管理員看得到。
            它與上面那兩件不是同一種東西——上面是班務，這一件是機構對
            個資法的責任，而且按下去沒有回頭路。 */}
        {mayErase && (
          <div className="yz-editor__part yz-danger" style={{ marginTop: 18 }}>
            <h3 className="yz-editor__head">刪除個人資料</h3>
            <p className="yz-hint" style={{ marginBottom: 10 }}>
              家長依個資法第 11 條要求刪除時用這一個。<strong>不可逆。</strong>
            </p>
            <Button variant="danger" onClick={() => setErasing(true)} disabled={busy}>
              刪除這位學生的個人資料
            </Button>
          </div>
        )}

        {error && <Note tone="error">{error}</Note>}
      </Dialog>

      {/* 退補 */}
      <ConfirmDialog
        open={archiving}
        onClose={() => {
          if (busy) return;
          clearError();
          setArchiving(false);
        }}
        busy={busy}
        title={`停用「${student.displayName}」的帳號`}
        confirmLabel="停用這個帳號"
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              他會<strong>立刻被登出所有裝置</strong>，而且再也登不進來。
              系統同時把他移出<strong>所有</strong>班級，所以他不會再收到任何任務、
              也不算進任何一個班的應交人數。
            </p>
            <p style={{ marginBottom: 12 }}>
              他過去的作答與成績<strong>全部保留</strong>，班級統計照樣算他那幾份。
              這不是刪除——之後可以放回來。要真的清掉他的個人資料是另一個動作。
            </p>
            <p className="yz-hint">誰在什麼時候停用了誰會寫進稽核記錄，行為人是你。</p>
            {error && <p className="yz-field__err">{error}</p>}
          </>
        }
        onConfirm={() => void patch({ status: 'ARCHIVED' }, () => {
          setArchiving(false);
          setOpen(false);
        })}
      />

      {/* 個資刪除 */}
      <ConfirmDialog
        open={erasing}
        onClose={() => {
          if (busy) return;
          clearError();
          setTyped('');
          setErasing(false);
        }}
        busy={busy}
        title={`刪除「${student.displayName}」的個人資料`}
        confirmLabel={
          typed.trim() === student.displayName ? '確定刪除，不可復原' : '請先打出他的姓名'
        }
        confirmDisabled={typed.trim() !== student.displayName}
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              <strong>這個動作不可逆。</strong>會被清掉的是：姓名、學號、信箱、
              家長信箱、生日、密碼、同意紀錄，以及所有家長綁定。他的帳號從此登不進來。
            </p>
            <p style={{ marginBottom: 12 }}>
              <strong>他的作答與成績會留下來。</strong>那是刻意的：一場 30 人的段考，
              班級平均、各題答對率與級分是拿那 30 份算出來的——抽掉一份，
              去年那場考試的平均會在今天改變，而已經印給家長看過的成績單就對不上了。
            </p>
            <p style={{ marginBottom: 12 }}>
              所以刪除之後，成績表上那一列還在，<strong>名字變成「已刪除的學生」</strong>。
              他原本的學號會被放回去，日後新生用得到。
            </p>
            <p className="yz-hint" style={{ marginBottom: 12 }}>
              誰在什麼時候刪除了誰會寫進稽核記錄（記的是動作，不是被刪掉的內容），行為人是你。
            </p>
            <TextField
              label="請打出這位學生的姓名以確認"
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
              hint={`要完全相同：${student.displayName}`}
              autoComplete="off"
              disabled={busy}
            />
            {error && <p className="yz-field__err">{error}</p>}
          </>
        }
        onConfirm={() =>
          void patch({ erase: true }, () => {
            setTyped('');
            setErasing(false);
            setOpen(false);
          })
        }
      />
    </>
  );
}

/**
 * 改姓名、學號與家長信箱。
 *
 * 三個欄位一起送，而不是各自一顆「儲存」：櫃檯拿到的通常是一整份
 * 更正單（名字錯了、順便補上家長信箱），而三次送出是三次等待。
 */
function EditForm({
  student,
  onDone,
}: {
  student: EditableStudent;
  onDone: () => void;
}) {
  const [displayName, setDisplayName] = useState(student.displayName);
  const [username, setUsername] = useState(student.username);
  const [guardianEmail, setGuardianEmail] = useState(student.guardianEmail ?? '');

  const idChanged = username.trim() !== student.username;

  return (
    <Form
      onSubmit={async () => {
        await submitJson(`/api/students/${student.id}`, {
          method: 'PATCH',
          json: {
            displayName: displayName.trim(),
            username: username.trim(),
            guardianEmail: guardianEmail.trim() || null,
          },
        });
        onDone();
      }}
    >
      {({ busy }) => (
        <>
          <TextField
            label="姓名"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.currentTarget.value)}
            hint="他自己與老師在畫面上看到的名字。成績表與名冊上的也是這一個。"
            autoFocus
          />
          <TextField
            label="學號（登入帳號）"
            required
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
            hint={
              idChanged
                ? '改了之後他會被立刻登出，而且要用新學號才登得進來——記得當場告訴他。密碼不變。'
                : '他登入時打的就是這一串。中間不能有空白。'
            }
            autoComplete="off"
          />
          <TextField
            label="家長信箱"
            type="email"
            value={guardianEmail}
            onChange={(e) => setGuardianEmail(e.currentTarget.value)}
            hint="選填。目前系統不會寄任何信（機房沒有對外的寄信管道），留著是為了日後對得上人。"
            autoComplete="off"
          />
          <div className="yz-actions">
            <span className="yz-actions__spacer" />
            <Button type="submit" variant="primary" busy={busy} busyLabel="儲存中…">
              儲存
            </Button>
          </div>
        </>
      )}
    </Form>
  );
}
