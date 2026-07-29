/**
 * 一份已經派出去的任務：改時間、取消。
 *
 * # 這兩件事之前完全沒有入口
 *
 * `PATCH /api/assignments/:id` 與 `DELETE` 都寫好了、`lib/assignment.ts`
 * 的規則也齊全（哪幾欄開始作答之後就凍結、有人作答就不准刪），
 * **但整個介面沒有任何一個地方呼叫它們**。派出去就定型了。
 *
 * 而「派錯了」與「再延一天」是這個系統裡最常見的兩個請求：
 *
 *   · 截止時間打成上個月 → 兩百個學生同時看到「已逾期，沒有作答記錄」，
 *     而老師唯一能做的事是再派一份，然後那份錯的永遠留在列表上
 *   · 考試當天有人請假、或者網路出問題要延長 → 沒有辦法延
 *
 * 兩者都不會有錯誤訊息，畫面也完全正常——它就只是改不了。
 *
 * # 為什麼只提供「進行中還改得動」的那幾欄
 *
 * 試卷、模式、時限、兩個隨機設定在第一個人開始作答之後就凍結了
 * （見 `lib/assignment.ts`：改了會讓已經開始的人與還沒開始的人拿到
 * 不同的考試，而他們的成績會被放在同一張表上比較）。把那幾欄畫出來
 * 再讓伺服器擋，等於請老師去試——他會以為是系統壞了。
 *
 * 所以這裡只放本來就該在進行中調整的：名稱、開放與截止、遲交、
 * 次數、以及成績開放時機。要換卷子或改時限，正確的做法是另外派一份。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { CheckField, SelectField, TextField } from '@/components/Field';
import { Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';

export type EditableAssignment = {
  id: string;
  title: string;
  /** ISO 字串。伺服器存 UTC，轉成輸入框要的本地時間在下面做。 */
  openAt: string | null;
  dueAt: string | null;
  allowLate: boolean;
  maxAttempts: number;
  releasePolicy: string;
  /** 已經有幾份作答。有的話就刪不掉，而且要在確認視窗說出這個數字。 */
  attempts: number;
};

/**
 * ISO（UTC）轉成 `<input type="datetime-local">` 要的字串。
 *
 * **不能直接 `iso.slice(0, 16)`。** 那會把 UTC 當成本地時間，
 * 於是一個晚上八點截止的任務，打開編輯視窗顯示的是中午十二點；
 * 老師沒注意就按了儲存，截止時間真的變成中午——而畫面上看起來
 * 完全正常，只是差了八小時。
 */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function AssignmentTools({ assignment }: { assignment: EditableAssignment }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { busy, error, clearError, run } = useAction();

  const [title, setTitle] = useState(assignment.title);
  const [openAt, setOpenAt] = useState(toLocalInput(assignment.openAt));
  const [dueAt, setDueAt] = useState(toLocalInput(assignment.dueAt));
  const [allowLate, setAllowLate] = useState(assignment.allowLate);
  const [maxAttempts, setMaxAttempts] = useState(String(assignment.maxAttempts));
  const [releasePolicy, setReleasePolicy] = useState(assignment.releasePolicy);

  const started = assignment.attempts > 0;

  function reopen() {
    // 每次打開都用伺服器上的現值重來。留著上一次沒存的編輯，
    // 老師會以為那是現在的設定。
    clearError();
    setTitle(assignment.title);
    setOpenAt(toLocalInput(assignment.openAt));
    setDueAt(toLocalInput(assignment.dueAt));
    setAllowLate(assignment.allowLate);
    setMaxAttempts(String(assignment.maxAttempts));
    setReleasePolicy(assignment.releasePolicy);
    setEditing(true);
  }

  return (
    <>
      <span style={{ display: 'inline-flex', gap: 6 }}>
        <Button variant="quiet" onClick={reopen} disabled={busy}>
          調整
        </Button>
        {!started && (
          <Button variant="quiet" onClick={() => setRemoving(true)} disabled={busy}>
            取消派發
          </Button>
        )}
      </span>

      <Dialog
        open={editing}
        onClose={() => {
          if (busy) return;
          clearError();
          setEditing(false);
        }}
        title={`調整「${assignment.title}」`}
        footer={
          <>
            <Button variant="quiet" onClick={() => !busy && setEditing(false)} disabled={busy}>
              取消
            </Button>
            <Button
              variant="primary"
              busy={busy}
              busyLabel="儲存中"
              onClick={() =>
                void run(async () => {
                  await submitJson(`/api/assignments/${assignment.id}`, {
                    method: 'PATCH',
                    json: {
                      title,
                      // 空的時間欄位要送 null 而不是空字串：伺服器用
                      // z.coerce.date() 解析，空字串會變成 Invalid Date，
                      // 而錯誤訊息是一句沒有人看得懂的 zod 抱怨。
                      openAt: openAt ? new Date(openAt).toISOString() : null,
                      dueAt: dueAt ? new Date(dueAt).toISOString() : null,
                      allowLate,
                      maxAttempts: Number(maxAttempts) || 1,
                      releasePolicy,
                    },
                  });
                  setEditing(false);
                  router.refresh();
                })
              }
            >
              儲存
            </Button>
          </>
        }
      >
        {error && <Note tone="error">{error}</Note>}

        {started && (
          <Note tone="warn">
            已經有 {assignment.attempts} 份作答記錄。這裡列出來的都還改得動，
            但試卷、模式、作答時限與隨機設定已經凍結——改了會讓已經開始的人
            與還沒開始的人拿到不同的考試。那幾樣要換，請另外派一份。
          </Note>
        )}

        <TextField
          label="任務名稱"
          required
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          hint="學生在自己的任務清單上看到的就是它。"
        />
        <div className="yz-row">
          <TextField
            label="開放時間"
            type="datetime-local"
            value={openAt}
            onChange={(e) => setOpenAt(e.currentTarget.value)}
            hint="留白代表立刻開放。"
          />
          <TextField
            label="截止時間"
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.currentTarget.value)}
            // 舊的提示寫「要立刻結束這場考試，把它改成現在」——**那不會
            // 停止正在寫的人**：每一份作答的到期時刻是開始那一刻算好
            // 寫死的，`attemptWritable` 只看它，不看任務的截止時間。
            // 改截止只擋得住還沒開始的人。真的要停現在這一場，用任務
            // 內頁的「立刻結束這場考試」。
            hint="只影響還沒開始作答的人。留白代表不設截止。"
          />
        </div>
        {started && (
          <Note tone="warn">
            已經開始作答的人<strong>不受截止時間影響</strong>——他們的到期時刻在按下
            「開始作答」的那一刻就算好了。要延長或立刻結束<strong>現在這一場</strong>，
            請到這份任務的內頁（任務名稱是連結）。
            {releasePolicy === 'ON_DUE' && (
              <>
                　另外，這一份設定為「截止後開放」，所以往後延截止時間會讓
                <strong>已經看得到檢討的學生再次看不到</strong>，直到新的截止時間。
              </>
            )}
          </Note>
        )}
        <div className="yz-row">
          <TextField
            label="可作答次數"
            type="number"
            min={1}
            max={50}
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(e.currentTarget.value)}
            hint="要讓某位學生重考，加一次。調低不會作廢已經寫過的那幾次。"
          />
          <SelectField
            label="成績與解析什麼時候給看"
            value={releasePolicy}
            onChange={(e) => setReleasePolicy(e.currentTarget.value)}
            hint="選「老師手動放行」的話，要另外到成績頁按放行，學生才看得到。"
          >
            <option value="IMMEDIATE">每題作答後</option>
            <option value="ON_SUBMIT">交卷後</option>
            <option value="ON_DUE">截止後</option>
            <option value="MANUAL">老師手動放行</option>
            <option value="NEVER">不開放</option>
          </SelectField>
        </div>
        <CheckField
          label="截止後仍可作答（會標記為遲交）"
          checked={allowLate}
          onChange={(e) => setAllowLate(e.currentTarget.checked)}
        />
      </Dialog>

      <ConfirmDialog
        open={removing}
        onClose={() => {
          if (busy) return;
          clearError();
          setRemoving(false);
        }}
        busy={busy}
        title={`取消派發「${assignment.title}」`}
        confirmLabel="取消這個任務"
        onConfirm={() =>
          void run(async () => {
            await submitJson(`/api/assignments/${assignment.id}`, { method: 'DELETE' });
            setRemoving(false);
            router.refresh();
          }).then((ok) => {
            // 失敗時關掉對話框，錯誤才看得見——原生 <dialog> 是頂層堆疊，
            // 蓋著頁面的話下面的訊息等於沒顯示。
            if (!ok) setRemoving(false);
          })
        }
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              這個任務會從學生的任務清單上消失。
              <strong>目前還沒有任何人作答，所以不會有成績被刪掉。</strong>
            </p>
            <p className="yz-hint">
              已經有人作答的任務刪不掉——那些記錄是成績的來源。
              要停止一場進行中的考試，請用「調整」把截止時間改成現在。
            </p>
          </>
        }
      />
      {error && !editing && !removing && <Note tone="error">{error}</Note>}
    </>
  );
}
