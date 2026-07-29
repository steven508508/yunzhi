/**
 * 名冊上的家長：一位學生一個對話框。
 *
 * # 為什麼是對話框而不是名冊上的一欄
 *
 * 因為一位學生可能有兩位監護人，而一位家長可能有兩個孩子——
 * 攤在表格裡的話那一欄的高度會跟著人數變，而名冊的其他每一欄都是
 * 一行。表格上留的是一個數字（接了幾位、有幾位還沒交付密碼），
 * 那是掃視得了的；要動它才進對話框。
 *
 * # 三件事在同一個對話框裡
 *
 * 新增、移除、重設密碼。分成三個入口的話，櫃檯處理「家長說他登不
 * 進去」時要在三個地方之間跳——而那三件事在現場其實是同一段對話。
 *
 * # 為什麼密碼顯示在對話框裡而且不 refresh
 *
 * 與 `ResetPassword.tsx` 完全相同的兩個理由：表格上的東西會被截圖、
 * 會留在畫面上；而 `router.refresh()` 會重新調和整棵樹，只要那次
 * 調和讓元件重新掛載，那串字就永遠消失了——它沒有第二個副本，
 * 而櫃檯還沒抄。**所以拿到密碼的那一刻不 refresh，關掉對話框才 refresh。**
 */
'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { TextField } from '@/components/Field';
import { Loading, Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';

type GuardianRow = {
  linkId: string;
  guardianId: string;
  username: string;
  displayName: string;
  active: boolean;
  delivered: boolean;
  children: number;
};

type Credential = { username: string; displayName: string; password: string };

/**
 * 一次性密碼的呈現。與名冊那一支用同一個 `<output>`：它有隱含的
 * `aria-live`，讀螢幕的人在密碼出現的當下就會聽到。
 */
function Secret({ value }: { value: string }) {
  return <output className="yz-secret">{value}</output>;
}

export default function Guardians({
  studentId,
  studentName,
  linked,
  undelivered,
}: {
  studentId: string;
  studentName: string;
  /** 伺服器端算好的數字。開啟對話框之前就要看得到。 */
  linked: number;
  undelivered: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<GuardianRow[] | null>(null);
  const [email, setEmail] = useState('');
  const [credential, setCredential] = useState<Credential | null>(null);
  const [removing, setRemoving] = useState<GuardianRow | null>(null);
  const [dirty, setDirty] = useState(false);
  const { busy, error, clearError, run } = useAction();

  const load = useCallback(async () => {
    const r = await fetch(`/api/guardians?studentId=${encodeURIComponent(studentId)}`);
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error ?? `伺服器回應 ${r.status}`);
    setRows(data.guardians as GuardianRow[]);
  }, [studentId]);

  useEffect(() => {
    if (!open) return;
    void run(load);
  }, [open, load, run]);

  function close() {
    if (busy) return;
    setOpen(false);
    setRows(null);
    setEmail('');
    setCredential(null);
    clearError();
    // 名冊上那一欄的數字變了才 refresh，而且是在關閉之後——
    // 開著的時候 refresh 會讓對話框裡的密碼消失。
    if (dirty) {
      setDirty(false);
      router.refresh();
    }
  }

  return (
    <>
      <Button variant="quiet" onClick={() => setOpen(true)}>
        家長
        {linked > 0 && (
          <span className={undelivered > 0 ? 'yz-warn' : undefined}>
            {' '}
            {linked}
            {undelivered > 0 && ' ⋯'}
          </span>
        )}
      </Button>

      <Dialog
        open={open}
        onClose={close}
        title={`${studentName}的家長`}
        footer={
          <Button variant="primary" onClick={close} disabled={busy}>
            關閉
          </Button>
        }
      >
        {error && <Note tone="error">{error}</Note>}

        {credential && (
          <>
            <Note tone="warn">
              這串字<b>關掉就看不到了</b>，系統裡沒有第二個副本——請現在當場抄給家長。
              他第一次登入時會被要求換成自己的密碼。
            </Note>
            <dl className="yz-cred">
              <div>
                <dt>登入帳號</dt>
                <dd>{credential.username}</dd>
              </div>
              <div>
                <dt>初始密碼</dt>
                <dd>
                  <Secret value={credential.password} />
                </dd>
              </div>
            </dl>
            <p className="yz-hint" style={{ marginBottom: 12 }}>
              交給家長之後請按下面那一列的「已交付」。沒有標記的連結
              <strong>不會收到系統寄出的任何通知</strong>——那是為了避免把成績
              寄給一個打錯的信箱。
            </p>
          </>
        )}

        {rows === null ? (
          <Loading what="讀取家長連結" />
        ) : rows.length === 0 ? (
          <p className="yz-hint" style={{ marginBottom: 12 }}>
            這位學生目前沒有連結任何家長帳號。填下面的信箱新增——
            信箱已經有家長帳號的話會直接接上去（一位家長可以有兩個孩子），
            沒有的話系統會開一個並給你一組初始密碼。
          </p>
        ) : (
          <ul className="yz-glink">
            {rows.map((g) => (
              <li key={g.linkId}>
                <span className="yz-glink__who">
                  <b>{g.username}</b>
                  <span className="yz-hint">
                    {g.displayName}
                    {g.children > 1 && `　·　接著 ${g.children} 個孩子`}
                    {!g.active && <span className="yz-warn">　·　帳號已停用</span>}
                    {!g.delivered && <span className="yz-warn">　·　密碼還沒交付</span>}
                  </span>
                </span>
                <span className="yz-rowacts">
                  <Button
                    variant="quiet"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await submitJson(`/api/guardians/${g.linkId}`, {
                          method: 'PATCH',
                          json: { delivered: !g.delivered },
                        });
                        setDirty(true);
                        await load();
                      })
                    }
                  >
                    {g.delivered ? '撤回交付' : '已交付'}
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const r = await submitJson<{ credential: Credential }>(
                          `/api/guardians/${g.linkId}/password`,
                        );
                        setDirty(true);
                        setCredential(r.credential);
                        await load();
                      })
                    }
                  >
                    重設密碼
                  </Button>
                  <Button variant="quiet" disabled={busy} onClick={() => setRemoving(g)}>
                    移除
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="yz-glink__add">
          <TextField
            label="新增家長（用信箱）"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            hint="這個信箱就是家長的登入帳號。同一個信箱在系統裡只會有一個帳號。"
            autoComplete="off"
          />
          <Button
            variant="primary"
            busy={busy}
            disabled={!email.trim()}
            onClick={() =>
              void run(async () => {
                const r = await submitJson<{ created: boolean; credential: Credential | null }>(
                  '/api/guardians',
                  { json: { studentId, email: email.trim() } },
                );
                setEmail('');
                setDirty(true);
                setCredential(r.credential);
                await load();
              })
            }
          >
            新增
          </Button>
        </div>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => {
          if (!busy) setRemoving(null);
        }}
        busy={busy}
        title={`移除「${removing?.username ?? ''}」`}
        confirmLabel="移除這個連結"
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              移除之後這位家長<strong>立刻看不到{studentName}的任何資料</strong>，
              而且正在看的畫面也會被登出。
            </p>
            <p style={{ marginBottom: 12 }}>
              {removing && removing.children > 1 ? (
                <>
                  他還接著另外 {removing.children - 1} 個孩子，
                  所以<strong>帳號會留著</strong>，只是少了這一位。
                </>
              ) : (
                <>
                  這是他唯一的孩子，所以<strong>帳號會一併停用</strong>。
                  之後再接到別的學生身上時會自動恢復。
                </>
              )}
            </p>
            <p className="yz-hint">
              誰在什麼時候移除了誰的連結會寫進稽核記錄，行為人是你。
            </p>
          </>
        }
        onConfirm={() =>
          void run(async () => {
            if (!removing) return;
            const res = await fetch(`/api/guardians/${removing.linkId}`, { method: 'DELETE' });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error ?? `伺服器回應 ${res.status}`);
            setRemoving(null);
            setDirty(true);
            await load();
          })
        }
      />
    </>
  );
}
