/**
 * 重設密碼的兩顆按鈕。
 *
 * # 這兩顆按鈕在補什麼
 *
 * 初始密碼只在名冊匯入的那一次回傳，之後系統裡**沒有任何介面可以
 * 重設**。兩百位學生第一次登入，忘記密碼的一定不只一個，而在此之前
 * 唯一的解法是「把整份名冊再匯一次」——那會動到不該被動到的人。
 *
 * # 為什麼分成兩顆，而且一顆刻意難按
 *
 *   **這一位**（名冊每一列）是在處理個案：學生站在櫃檯說登不進去。
 *   它要快——問一次「確定嗎」，然後給出密碼。
 *
 *   **整班**會讓全班現有的密碼同時失效，包含那些早就改過、自己記得
 *   的人。按錯的代價是三十個人明天早上都登不進去，而其中沒有一個人
 *   知道為什麼。所以它要求打出班級名稱：那擋掉的不只是誤觸，
 *   還有**按到隔壁那一班**——而後者光靠「確定嗎」擋不住。
 *
 * # 為什麼密碼顯示在對話框裡而不是表格上
 *
 * 因為它只能被看到一次，而**表格上的東西會被截圖、會留在畫面上、
 * 會被下一位走過來的學生看到**。對話框是強制的：老師要嘛抄下來，
 * 要嘛關掉重來。畫面上把這件事講死，不留任何「等一下再看」的空間。
 *
 * # 為什麼這一支刻意不呼叫 `router.refresh()`
 *
 * 其他幾顆按鈕（登錄同意、移出班級、作廢）成功之後都會 refresh，
 * 因為畫面上有東西變了。**這裡沒有**：名冊上沒有任何一欄會因為
 * 重設密碼而改變。
 *
 * 而 refresh 在這裡是有風險的：它會重新拉一次伺服器元件並重新調和
 * 整棵樹，而新密碼只存在於這個元件的 state 裡。只要那次調和讓元件
 * 重新掛載（表格重排、列的 key 變了、Suspense 邊界重跑），**那串字
 * 就永遠消失了**——它沒有第二個副本，而老師還沒抄。
 *
 * 為了一個不會變的畫面，換一個「密碼憑空不見」的機會，不划算。
 */
'use client';

import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { TextField } from '@/components/Field';
import { Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';

type Credential = {
  userId: string;
  username: string;
  displayName: string;
  password: string;
  /** 這位學生正在作答時的提醒。伺服器算的，因為只有它知道。 */
  warning?: string | null;
};

/**
 * 一次性密碼的呈現。
 *
 * 用 `<output>` 而不是 `<span>`：它有隱含的 `aria-live`，讀螢幕的人
 * 在密碼出現的當下就會聽到，而不必自己找。這串字的整個用途就是
 * 「現在把它唸出來或抄下來」。
 */
function Secret({ value }: { value: string }) {
  return (
    <output className="yz-secret">
      {value}
    </output>
  );
}

/** 抄好之前不准關。關掉之後這串字就沒有第二個副本了。 */
function OneTimeNotice({ count }: { count: number }) {
  return (
    <Note tone="warn">
      {count === 1 ? '這串字' : `這 ${count} 組密碼`}
      <b>關掉就看不到了</b>，系統裡沒有第二個副本——請現在當場抄給
      {count === 1 ? '學生' : '學生們'}。學生下次登入時會被要求換成自己的密碼。
    </Note>
  );
}

// ─────────────────────────────────────────────────────────────────
// 這一位
// ─────────────────────────────────────────────────────────────────

export function ResetOne({
  studentId,
  studentName,
  username,
}: {
  studentId: string;
  studentName: string;
  username: string;
}) {
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState<Credential | null>(null);
  const { busy, error, clearError, run } = useAction();

  return (
    <>
      <Button variant="quiet" onClick={() => setAsking(true)} disabled={busy}>
        重設密碼
      </Button>

      <ConfirmDialog
        open={asking}
        onClose={() => {
          if (busy) return;
          clearError();
          setAsking(false);
        }}
        busy={busy}
        title={`重設「${studentName}」的密碼`}
        confirmLabel="產生新密碼"
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              系統會產生一組新的臨時密碼，<strong>只顯示這一次</strong>，請當場抄給他。
              他<strong>目前的密碼會立刻失效</strong>，而且所有裝置上的登入都會被登出。
            </p>
            <p style={{ marginBottom: 12 }}>
              如果他之前試錯太多次被鎖住了，這次重設也會一併解鎖——不必等 15 分鐘。
            </p>
            <p className="yz-hint">
              誰在什麼時候重設了誰的密碼會寫進稽核記錄，行為人是你。
              密碼本身不會被記錄在任何地方。
            </p>
            {error && <p className="yz-field__err">{error}</p>}
          </>
        }
        onConfirm={() =>
          void run(async () => {
            const r = await submitJson<{ credential: Credential }>(
              `/api/students/${studentId}/password`,
            );
            setAsking(false);
            setDone(r.credential);
          })
        }
      />

      <Dialog
        open={done !== null}
        onClose={() => setDone(null)}
        title={`${studentName}的新密碼`}
        footer={
          <Button variant="primary" onClick={() => setDone(null)}>
            我抄好了，關閉
          </Button>
        }
      >
        <OneTimeNotice count={1} />
        <dl className="yz-cred">
          <div>
            <dt>學號</dt>
            <dd>{username}</dd>
          </div>
          <div>
            <dt>新密碼</dt>
            <dd>{done && <Secret value={done.password} />}</dd>
          </div>
        </dl>
        {done?.warning && <Note tone="warn">{done.warning}</Note>}
      </Dialog>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────
// 整班
// ─────────────────────────────────────────────────────────────────

export function ResetClass({
  classId,
  className,
  students,
}: {
  classId: string;
  className: string;
  /** 會被重設的人數。確認視窗要說得出這個數字。 */
  students: number;
}) {
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState('');
  const [done, setDone] = useState<Credential[] | null>(null);
  const { busy, error, clearError, run } = useAction();

  const matches = typed.trim() === className;

  // 整班的結果攤在頁面上而不是塞進對話框，理由是**列印**。
  // 三十組密碼要能印成一張紙帶去教室發，而瀏覽器列印 modal
  // `<dialog>` 的行為各家不同（有的印整頁而蓋掉對話框、有的只印
  // 對話框）——那不是可以在上線當天才發現的事。名冊匯入那一塊
  // 也是同樣的做法，兩處看起來一致。
  if (done) {
    return (
      <div className="yz-card" style={{ marginBottom: 22 }}>
        <h2 className="yz-card__title">{className}的新密碼</h2>
        <OneTimeNotice count={done.length} />
        <table className="yz-table">
          <caption className="yz-sr">{className}重設後的新密碼</caption>
          <thead>
            <tr>
              <th scope="col">學號</th>
              <th scope="col">姓名</th>
              <th scope="col">新密碼</th>
            </tr>
          </thead>
          <tbody>
            {done.map((c) => (
              <tr key={c.userId}>
                <td>{c.username}</td>
                <td>{c.displayName}</td>
                <td>
                  <Secret value={c.password} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="yz-actions">
          <span className="yz-actions__spacer" />
          <Button onClick={() => window.print()}>列印這一頁</Button>
          <Button variant="primary" onClick={() => setDone(null)}>
            我印好了，關閉
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <Button variant="quiet" onClick={() => setAsking(true)} disabled={busy}>
        重設全班密碼
      </Button>

      <ConfirmDialog
        open={asking}
        onClose={() => {
          if (busy) return;
          clearError();
          setAsking(false);
        }}
        busy={busy}
        title={`重設「${className}」全班的密碼`}
        confirmLabel={matches ? `重設這 ${students} 位的密碼` : '請先打出班級名稱'}
        confirmDisabled={!matches}
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              這 <strong>{students} 位學生</strong>現在的密碼會<strong>同時失效</strong>，
              包含那些已經改過、自己記得的人。他們全部會被登出，
              而且要拿到新密碼才進得來。
            </p>
            <p style={{ marginBottom: 12 }}>
              新密碼<strong>只顯示這一次</strong>，關掉就取不回來了。
              按下去之前請先確定你有紙筆或印表機。
            </p>
            <p className="yz-hint" style={{ marginBottom: 12 }}>
              只有一位學生登不進去的話，請用名冊上那一列的「重設密碼」——
              那不會影響其他人。
            </p>
            {error && <p className="yz-field__err">{error}</p>}
            <TextField
              label="請完整打出班級名稱以確認"
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
              // 這一格不是儀式。它擋的是「按到隔壁那一班」——那種錯
              // 用「確定嗎」擋不住，因為按的人本來就很確定。
              hint={`要打的是：${className}`}
              autoComplete="off"
            />
          </>
        }
        onConfirm={() => {
          if (!matches) return;
          void run(async () => {
            const r = await submitJson<{ credentials: Credential[] }>(
              `/api/classes/${classId}/passwords`,
              { json: { confirmName: typed.trim() } },
            );
            setAsking(false);
            setTyped('');
            setDone(r.credentials);
          });
        }}
      />

    </>
  );
}
