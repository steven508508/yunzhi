/**
 * 代替學生把一份卡住的作答收掉。
 *
 * # 這顆按鈕在補救什麼
 *
 * 一份作答的時間到了，但沒有人按下交卷——學生的筆電沒電、瀏覽器
 * 被關掉、網路斷了而且沒有再回來。那一份會永遠停在「進行中」：
 * 伺服器不收他的答案了（時間到了），但也沒有人把它結算掉。
 *
 * 那個學生看到的是「已完成，已作答 1 次」，沒有分數、沒有按鈕；
 * 老師看到的是全班少一個人交卷，而少的那一個在成績表上根本不存在。
 * **他寫過的答案還在資料庫裡，只是沒有任何一條路徑走得到它。**
 *
 * 收掉之後那些答案就會照一般流程自動計分，出現在上面的全班列表裡。
 *
 * # 為什麼要確認視窗
 *
 * 因為結果是「這位學生立刻有了一個分數」，而那個分數只算他寫完的
 * 部分——沒寫到的題目都是 0。這是對的（時間到了就是這個結果），
 * 但老師按下去之前要知道自己按的是什麼，尤其是當那份只寫了三題的
 * 時候：正確的處置可能是安排補考，而不是給他一個 12 分。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { submitJson, useAction } from '@/components/Form';

export function FinalizeOne({
  attemptId,
  who,
  answered,
  total,
}: {
  attemptId: string;
  who: string;
  /** 已經寫了幾題。確認視窗要說得出來——它決定老師該不該按。 */
  answered: number;
  /** 卷面題數。 */
  total: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { busy, error, clearError, run } = useAction();

  return (
    <>
      <Button variant="quiet" onClick={() => setOpen(true)} disabled={busy}>
        代為結算
      </Button>
      {error && <span className="yz-warn yz-grade__sub">{error}</span>}

      <ConfirmDialog
        open={open}
        onClose={() => {
          if (busy) return;
          clearError();
          setOpen(false);
        }}
        busy={busy}
        title={`代「${who}」結算這一份`}
        confirmLabel="結算並計分"
        onConfirm={() =>
          void run(async () => {
            await submitJson(`/api/attempts/${attemptId}/finalize`);
            setOpen(false);
            router.refresh();
          })
        }
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              這一份會被記成交卷並立刻計分。
              <strong>
                {who}只寫了 {answered} / {total} 題
              </strong>
              ，沒有作答的題目一律 0 分——他的分數就是這樣算出來的。
            </p>
            <p style={{ marginBottom: 12 }}>
              作答時間已經結束，所以這個動作<strong>不會弄丟他任何已經寫下的答案</strong>
              ：時間到之後系統本來就不再收他的作答了。
            </p>
            <p className="yz-hint">
              如果他是因為當機或斷線而沒寫完，正確的處置可能是安排補考
              （在任務設定裡把作答次數加一次），而不是收下這個分數。
              這筆結算會記在稽核裡，行為人是你。
            </p>
          </>
        }
      />
    </>
  );
}
