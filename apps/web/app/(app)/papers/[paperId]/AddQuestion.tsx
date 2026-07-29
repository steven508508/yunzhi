'use client';

import { useRouter } from 'next/navigation';

import { Button } from '@/components/Button';
import { Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';

/**
 * 加一題進卷子。
 *
 * 不用 `Form` 元件：這裡沒有欄位，就是一顆按鈕。但 `Form` 幫忙做的
 * 兩件事仍然要自己做——**送出中要停用**（連點兩下會送兩次，第二次
 * 拿到「這一題已經在卷子上了」這種看起來像壞掉的錯誤），以及
 * **錯誤要看得見**（伺服器會回「這一題還沒有人校對過」這類說明，
 * 丟掉的話使用者只看到按了沒反應）。
 */
export default function AddQuestion({
  paperId,
  questionId,
}: {
  paperId: string;
  questionId: string;
}) {
  const router = useRouter();
  const { busy, error, run } = useAction();

  return (
    <>
      <Button
        busy={busy}
        busyLabel="加入中…"
        onClick={() =>
          void run(async () => {
            await submitJson(`/api/papers/${paperId}/items`, { json: { questionId } });
            // 兩欄都要更新：左邊要標成「已在第 N 題」，右邊要多一列。
            router.refresh();
          })
        }
      >
        加入
      </Button>
      {error && <Note tone="error">{error}</Note>}
    </>
  );
}
