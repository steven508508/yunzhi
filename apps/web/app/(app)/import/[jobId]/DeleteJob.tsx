'use client';

/**
 * 刪掉一份題本。
 *
 * 裝機與試跑會累積一堆垃圾工作——辨識失敗的、傳錯檔的、測試用的。
 * 每一份都佔著原檔與整份的頁面影像（200 頁的掃描件是好幾百 MB）。
 *
 * **預設不動已入庫的題目。** 勾選才連帶刪除，而且只刪還沒被用過的：
 * 已在卷子上或已有學生作答的照樣擋下來（資料庫層的 onDelete: Restrict）。
 * 那些會列在回報裡，不會安靜地略過。
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { ConfirmDialog } from '@/components/Dialog';

export function DeleteJob({
  jobId,
  title,
  committedCount,
}: {
  jobId: string;
  title: string;
  /** 這份題本已經入庫的題目數。0 就不必顯示連帶刪除的選項。 */
  committedCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [withQuestions, setWithQuestions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/import/${jobId}${withQuestions ? '?withQuestions=1' : ''}`,
        { method: 'DELETE' },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `刪除失敗（${res.status}）`);
        setOpen(false);
        return;
      }
      if (body.blockedQuestions?.length) {
        // 不轉頁：使用者需要看到哪幾題沒被刪掉，以及為什麼。
        setError(
          `題本已刪除。有 ${body.blockedQuestions.length} 題因為已在卷子上或已有學生作答而保留在題庫裡。`,
        );
        setOpen(false);
        setTimeout(() => router.push('/import'), 4000);
        return;
      }
      router.push('/import');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-rose-700 underline underline-offset-4 hover:text-rose-800 dark:text-rose-300"
      >
        刪除這份題本
      </button>

      <ConfirmDialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        onConfirm={() => void run()}
        title={`刪除「${title}」`}
        confirmLabel="刪除題本"
        busy={busy}
        consequence={
          <>
            匯入紀錄、候選題、頁面影像與上傳的原檔都會被刪除，
            <strong>這個動作不能復原</strong>。
            {committedCount > 0 && (
              <>
                <br />
                <br />
                這份題本已經有 <strong>{committedCount}</strong> 題入庫。預設
                <strong>留著它們</strong>——入庫之後就是獨立的題庫條目，
                可能已經被編輯或選進卷子。
                <br />
                <label className="mt-2 flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={withQuestions}
                    onChange={(e) => setWithQuestions(e.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    連同這 {committedCount} 題一起刪除（匯錯科目、辨識全錯時用）。
                    已在卷子上或已有學生作答的題目仍會被保留，刪除後會告訴你有幾題。
                  </span>
                </label>
              </>
            )}
          </>
        }
      />
    </>
  );
}
