'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { Note } from '@/components/Feedback';
import { TextField } from '@/components/Field';
import { Form, submitJson, useAction } from '@/components/Form';

/**
 * 卷子本身的操作：更名、改狀態、刪除。
 *
 * 狀態那顆按鈕是這個畫面最重要的一個動作——**沒有按下它，這份卷子
 * 派不出去**，而那件事在畫面上完全看不出來。所以它不是藏在選單裡的
 * 一個選項，而是一顆帶著說明的按鈕。
 */
export default function PaperTools({
  paperId,
  title,
  status,
  itemCount,
  totalScore,
}: {
  paperId: string;
  title: string;
  status: string;
  itemCount: number;
  totalScore: number;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(title);
  const { busy, error, run } = useAction();
  const [confirmDelete, setConfirmDelete] = useState(false);

  function patch(body: Record<string, unknown>) {
    return run(async () => {
      await submitJson(`/api/papers/${paperId}`, { method: 'PATCH', json: body });
      router.refresh();
    });
  }

  if (renaming) {
    return (
      <div className="yz-card" style={{ marginBottom: 18 }}>
        <Form
          onSubmit={async () => {
            await submitJson(`/api/papers/${paperId}`, {
              method: 'PATCH',
              json: { title: name },
            });
            setRenaming(false);
            router.refresh();
          }}
        >
          {({ busy: b }) => (
            <>
              <TextField
                label="卷名"
                required
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                autoFocus
              />
              <div className="yz-actions">
                <span className="yz-actions__spacer" />
                <Button variant="quiet" onClick={() => setRenaming(false)} disabled={b}>
                  取消
                </Button>
                <Button type="submit" variant="primary" busy={b}>
                  改名
                </Button>
              </div>
            </>
          )}
        </Form>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 18 }}>
      {error && <Note tone="error">{error}</Note>}

      {status === 'DRAFT' && (
        <Note>
          這份卷子是草稿，還派不出去。
          {itemCount === 0
            ? '先從左邊挑幾題。'
            : totalScore === 0
              ? '每一題都是 0 分，先給配分。'
              : `${itemCount} 題、共 ${totalScore} 分。確認無誤就標記為可派發。`}
        </Note>
      )}
      {status === 'ARCHIVED' && <Note tone="warn">這份卷子已封存，不能再派新的任務。</Note>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <Button onClick={() => setRenaming(true)} disabled={busy}>
          改名
        </Button>

        {status === 'DRAFT' && (
          <Button
            variant="primary"
            busy={busy}
            busyLabel="處理中…"
            onClick={() => patch({ status: 'READY' })}
          >
            標記為可派發
          </Button>
        )}
        {status === 'READY' && (
          <Button busy={busy} onClick={() => patch({ status: 'DRAFT' })}>
            退回草稿再修改
          </Button>
        )}
        {status !== 'ARCHIVED' ? (
          <Button busy={busy} onClick={() => patch({ status: 'ARCHIVED' })}>
            封存
          </Button>
        ) : (
          <Button busy={busy} onClick={() => patch({ status: 'DRAFT' })}>
            取消封存
          </Button>
        )}

        <span className="yz-actions__spacer" />
        <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
          刪除
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => !busy && setConfirmDelete(false)}
        onConfirm={() =>
          void run(async () => {
            await submitJson(`/api/papers/${paperId}`, { method: 'DELETE' });
            router.push('/papers');
          }).then((ok) => {
            // 失敗時關掉對話框，錯誤才看得見——它顯示在對話框後面的
            // 頁面上，而原生 <dialog> 是頂層堆疊，蓋著的話等於沒顯示。
            if (!ok) setConfirmDelete(false);
          })
        }
        title={`刪除「${title}」`}
        confirmLabel="刪除這份卷子"
        busy={busy}
        consequence={
          <>
            這份卷子上的 {itemCount} 題會從卷子上移除，<strong>題目本身留在題庫裡</strong>
            ，不會被刪掉。已經派過任務的卷子刪不掉——那些任務的成績要靠它才知道
            每一題值幾分。
          </>
        }
      />
    </div>
  );
}
