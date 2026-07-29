/**
 * 依名冊上的家長信箱，一次把整個班的家長帳號建起來。
 *
 * # 為什麼這顆按鈕非有不可
 *
 * 名冊匯入時本來就會做一次（見 `api/classes/[classId]/roster/route.ts`），
 * 但那一次涵蓋不到最常見的情況：**第一份名冊上家長信箱那一欄是空的**，
 * 過幾天櫃檯才收齊回條、逐位補進去。沒有這顆按鈕的話，唯一的辦法是
 * 把整份名冊再匯一次——而那會動到不該被動到的人。
 *
 * 它是冪等的：已經接好的不重建、既有帳號不重設密碼。所以按幾次都一樣，
 * 而「不確定剛剛那次有沒有成功」時再按一次是安全的。
 *
 * # 為什麼結果攤在頁面上而不是對話框
 *
 * 因為**列印**。三十組家長密碼要能印成一張紙，而瀏覽器列印 modal
 * `<dialog>` 的行為各家不同（有的印整頁而蓋掉對話框、有的只印對話框）
 * ——那不是可以在上線當天才發現的事。名冊匯入與整班重設密碼也是
 * 同樣的做法，三處看起來一致。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';

type Result = {
  className: string;
  created: number;
  linked: number;
  alreadyLinked: number;
  withoutEmail: number;
  skipped: { student: string; email: string; why: string }[];
  credentials: { username: string; displayName: string; childName: string; password: string }[];
};

export default function GuardianBatch({
  classId,
  className,
  candidates,
}: {
  classId: string;
  className: string;
  /** 名冊上填了家長信箱、但還沒有任何家長連結的人數。0 時整塊不出現。 */
  candidates: number;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState<Result | null>(null);
  const { busy, error, clearError, run } = useAction();

  if (done) {
    return (
      <div className="yz-card" style={{ marginBottom: 22 }}>
        <h2 className="yz-card__title">{className}的家長帳號</h2>
        <Note>
          新開 {done.created} 個家長帳號、接上 {done.linked} 條連結
          {done.alreadyLinked > 0 && `、${done.alreadyLinked} 條本來就接好了`}
          {done.withoutEmail > 0 && `。另外有 ${done.withoutEmail} 位名冊上沒有填家長信箱`}。
        </Note>

        {done.skipped.length > 0 && (
          <>
            <Note tone="warn">
              有 {done.skipped.length} 位接不上。改好之後再按一次就好——
              已經接好的不會被重做。
            </Note>
            <ul style={{ marginLeft: 18, fontSize: 12.5, lineHeight: 2 }}>
              {done.skipped.slice(0, 20).map((s, i) => (
                <li key={i}>
                  {s.student}（{s.email}）：{s.why}
                </li>
              ))}
              {done.skipped.length > 20 && <li>…還有 {done.skipped.length - 20} 位</li>}
            </ul>
          </>
        )}

        {done.credentials.length === 0 ? (
          <Note>
            沒有新開帳號——這些信箱在系統裡都已經有家長帳號了，只是把孩子接上去。
            家長忘記密碼的話，用名冊那一列「家長」裡的「重設密碼」。
          </Note>
        ) : (
          <>
            <Note tone="warn">
              下面是 {done.credentials.length} 組新帳號的初始密碼。
              <b>離開這一頁之後就取不回來了</b>，請先列印或抄下來。
              家長第一次登入時會被要求更換密碼。
            </Note>
            <table className="yz-table">
              <caption className="yz-sr">{className}新開的家長帳號與初始密碼</caption>
              <thead>
                <tr>
                  <th scope="col">家長帳號（信箱）</th>
                  <th scope="col">孩子</th>
                  <th scope="col">初始密碼</th>
                </tr>
              </thead>
              <tbody>
                {done.credentials.map((c) => (
                  <tr key={c.username}>
                    <td>{c.username}</td>
                    <td>{c.childName}</td>
                    <td>
                      <output className="yz-secret">{c.password}</output>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="yz-hint" style={{ marginTop: 10 }}>
              交給家長之後，到名冊那一列的「家長」裡按「已交付」。
              沒有標記的連結<strong>不會收到系統寄出的任何通知</strong>——
              那是為了避免把成績寄到一個打錯的信箱。
            </p>
          </>
        )}

        <div className="yz-actions">
          <span className="yz-actions__spacer" />
          <Button onClick={() => window.print()}>列印這一頁</Button>
          <Button
            variant="primary"
            onClick={() => {
              setDone(null);
              router.refresh();
            }}
          >
            我抄好了，完成
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="yz-card" style={{ marginBottom: 22 }}>
      <h2 className="yz-card__title">還有 {candidates} 位的家長帳號沒建</h2>
      <p className="yz-hint" style={{ marginBottom: 10 }}>
        名冊上填了家長信箱、但還沒有家長帳號的有 {candidates} 位。
        建好之後家長就登得進來看孩子的任務與成績——
        <strong>看不到逐題作答、檢討與智慧老師的對話</strong>。
        新帳號的初始密碼<strong>只顯示這一次</strong>，按下去之前請先確定有紙筆或印表機。
      </p>
      {error && <Note tone="error">{error}</Note>}
      <div className="yz-actions">
        <span className="yz-actions__spacer" />
        <Button variant="primary" onClick={() => setAsking(true)} disabled={busy}>
          建立家長帳號
        </Button>
      </div>

      <ConfirmDialog
        open={asking}
        onClose={() => {
          if (busy) return;
          clearError();
          setAsking(false);
        }}
        busy={busy}
        title={`為「${className}」建立家長帳號`}
        confirmLabel={`建立這 ${candidates} 位的家長帳號`}
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              系統會依名冊上的家長信箱開帳號並接到孩子身上。
              同一個信箱只會有一個帳號——兄弟姊妹會接到同一位家長底下。
            </p>
            <p style={{ marginBottom: 12 }}>
              新帳號的初始密碼<strong>只顯示這一次</strong>，關掉就取不回來了。
              已經存在的家長帳號<strong>不會被重設密碼</strong>（他可能正在用它看另一個孩子）。
            </p>
            <p className="yz-hint">
              這個動作可以重複執行：已經接好的不會被重做，所以不確定剛剛有沒有成功時，
              再按一次是安全的。
            </p>
            {error && <p className="yz-field__err">{error}</p>}
          </>
        }
        onConfirm={() =>
          void run(async () => {
            const r = await submitJson<{ result: Result }>(
              `/api/classes/${classId}/guardians`,
            );
            setAsking(false);
            setDone(r.result);
            // **這裡不 refresh。** 初始密碼只存在於這個元件的 state 裡，
            // 而 refresh 會重新調和整棵樹——只要那次調和讓元件重新掛載，
            // 那些密碼就永遠消失了，而櫃檯還沒抄。關閉時才 refresh。
          })
        }
      />
    </div>
  );
}
