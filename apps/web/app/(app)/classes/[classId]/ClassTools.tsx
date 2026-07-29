/**
 * 改班名與封存班級。
 *
 * # 這兩件事在此之前都做不到
 *
 * `renameClass` 與 `deactivateClass`（`lib/roster.ts`）寫好了、有重複
 * 檢查、有稽核，但**沒有任何呼叫端**，而班級沒有 PATCH 路由。於是：
 *
 *   · 班名打錯就是一輩子。而第一天正是最容易打錯、也最容易發現命名
 *     規則要改的那一天——七個班的名字要一次想好。
 *   · 舊學年度的班永遠留在 `/classes` 上。第二年開學時列表是 14 個班，
 *     其中 7 個已經沒有人了，而看的人分不出是哪 7 個。
 *
 * # 為什麼封存與「結算學年度」是兩顆按鈕
 *
 * 封存是單一個班的事（這個班解散了、併班了）；結算是整個學年度的事
 * （`/settings/years` 的那一顆），它會一次收掉底下所有班的名冊。
 * 一個班一個班按七次也做得到，但那正是這一份要消滅的東西。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { TextField } from '@/components/Field';
import { Note } from '@/components/Feedback';
import { Form, submitJson, useAction } from '@/components/Form';

export default function ClassTools({
  classId,
  className,
  active,
  members,
}: {
  classId: string;
  className: string;
  active: boolean;
  /** 目前在籍的人數。封存的確認視窗要說得出這個數字。 */
  members: number;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const { busy, error, clearError, run } = useAction();

  async function setActive(next: boolean) {
    const ok = await run(async () => {
      await submitJson(`/api/classes/${classId}`, {
        method: 'PATCH',
        json: { active: next },
      });
    });
    if (ok) {
      setArchiving(false);
      router.refresh();
    }
  }

  return (
    <>
      <span className="yz-rowacts">
        <Button variant="quiet" onClick={() => setRenaming(true)} disabled={busy}>
          改班名
        </Button>
        {active ? (
          <Button variant="quiet" onClick={() => setArchiving(true)} disabled={busy}>
            封存這個班
          </Button>
        ) : (
          <Button onClick={() => void setActive(true)} busy={busy} busyLabel="啟用中…">
            重新啟用
          </Button>
        )}
      </span>
      {error && <Note tone="error">{error}</Note>}

      <Dialog
        open={renaming}
        onClose={() => {
          if (busy) return;
          clearError();
          setRenaming(false);
        }}
        title={`改「${className}」的名稱`}
      >
        <RenameForm
          classId={classId}
          className={className}
          onDone={() => {
            setRenaming(false);
            router.refresh();
          }}
        />
      </Dialog>

      <ConfirmDialog
        open={archiving}
        onClose={() => {
          if (busy) return;
          clearError();
          setArchiving(false);
        }}
        busy={busy}
        title={`封存「${className}」`}
        confirmLabel="封存這個班"
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              這個班會從班級列表的預設檢視、以及派卷的班級勾選清單上消失。
              <strong>名冊、成績與作答全部留著</strong>，之後隨時可以重新啟用。
              封存不是刪除。
            </p>
            <p style={{ marginBottom: 12 }}>
              目前在籍的 <strong>{members} 位學生的班籍不會被動到</strong>——
              他們仍然算在這個班上，也仍然收得到這個班還沒截止的任務。
              要一次把整個學年度的名冊收乾淨，請用「學年度」那一頁的「結算」。
            </p>
            <p className="yz-hint">誰在什麼時候封存了哪個班會寫進稽核記錄，行為人是你。</p>
            {error && <p className="yz-field__err">{error}</p>}
          </>
        }
        onConfirm={() => void setActive(false)}
      />
    </>
  );
}

function RenameForm({
  classId,
  className,
  onDone,
}: {
  classId: string;
  className: string;
  onDone: () => void;
}) {
  const [name, setName] = useState(className);

  return (
    <Form
      onSubmit={async () => {
        await submitJson(`/api/classes/${classId}`, {
          method: 'PATCH',
          json: { name: name.trim() },
        });
        onDone();
      }}
    >
      {({ busy }) => (
        <>
          <TextField
            label="班級名稱"
            required
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            hint="學生在自己的畫面上會看到這個名稱。同一個學年度裡不能重複。"
            autoFocus
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
