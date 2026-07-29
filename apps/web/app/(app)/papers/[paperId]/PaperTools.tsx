'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { Note } from '@/components/Feedback';
import { TextAreaField, TextField } from '@/components/Field';
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
  instructions,
  status,
  itemCount,
  totalScore,
}: {
  paperId: string;
  title: string;
  instructions: string | null;
  status: string;
  itemCount: number;
  totalScore: number;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(title);
  const [inst, setInst] = useState(instructions ?? '');
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
              // 兩欄一起送。分開兩顆按鈕的話，改完卷名忘了改說明，
              // 而說明是印在考卷最上方的那一段。
              json: { title: name, instructions: inst },
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
              {/* 這一欄 schema、lib 與 API 一路都收，只是從來沒有地方填。
                  它印在考卷最上方，而「不可使用計算機」這種話沒有地方寫，
                  老師只能口頭講——分兩個時段考的兩班就不一定聽到同一句。 */}
              <TextAreaField
                label="考試說明"
                value={inst}
                onChange={(e) => setInst(e.currentTarget.value)}
                rows={3}
                hint="印在考卷與作答畫面最上方。例如「本卷共 25 題，第 1–20 題單選、第 21–25 題選填，不可使用計算機」。"
              />
              <div className="yz-actions">
                <span className="yz-actions__spacer" />
                <Button variant="quiet" onClick={() => setRenaming(false)} disabled={b}>
                  取消
                </Button>
                <Button type="submit" variant="primary" busy={b}>
                  存起來
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
              : `${itemCount} 題、共 ${totalScore} 分。`}
          {itemCount > 0 && totalScore > 0 && (
            <>
              {' '}
              標記為可派發之前，先到{' '}
              <a href={`/papers/${paperId}/preview`}>整卷預覽</a>{' '}
              把它從頭到尾看一次——那是這份卷子在學生打開它之前唯一被看過的機會。
            </>
          )}
        </Note>
      )}
      {status === 'ARCHIVED' && <Note tone="warn">這份卷子已封存，不能再派新的任務。</Note>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <Button onClick={() => setRenaming(true)} disabled={busy}>
          編輯卷頭
        </Button>

        {/* 複製。「上次段考那份改幾題」是出卷最常見的起點，而在此之前
            那件事等於從幾百題裡重挑一次。它也是「有人已經開始作答」
            那句錯誤訊息（「請另外建一份」）唯一走得通的出路。 */}
        <Button
          busy={busy}
          busyLabel="複製中…"
          onClick={() =>
            void run(async () => {
              const r = await submitJson<{ paper: { id: string } }>(
                `/api/papers/${paperId}/duplicate`,
                { json: {} },
              );
              // 直接進複本。留在原地的話，老師會以為沒有反應然後再按一次，
              // 而那會產生第二份複本。
              router.push(`/papers/${r.paper.id}`);
            })
          }
        >
          複製這份卷子
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
