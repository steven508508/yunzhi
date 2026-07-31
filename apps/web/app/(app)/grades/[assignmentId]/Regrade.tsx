/**
 * 重新計分的兩顆按鈕。
 *
 * 分成兩顆是刻意的，因為它們是兩件不同的事：
 *
 *   **這一份**（表格每一列）是在處理個案——某個學生的分數看起來
 *   不對，重算一次確認。
 *
 *   **全班**是一個影響所有人的決定——標準答案改了、某一題送分。
 *   它會寫一筆稽核記錄，含每一位分數有變動的人。所以它要問一次
 *   「為什麼」：事後家長問「為什麼我小孩的分數變了」時，
 *   那一欄是唯一答得出來的東西。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { TextField } from '@/components/Field';
import { Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';

/** 單獨重算一份。表格裡的小按鈕。 */
export function RegradeOne({ attemptId, who }: { attemptId: string; who: string }) {
  const router = useRouter();
  const { busy, error, run } = useAction();

  return (
    <>
      <Button
        variant="quiet"
        busy={busy}
        busyLabel="計分中"
        // 這一顆不問「確定嗎」是刻意的：用現在的標準答案重算一份是
        // 冪等的，學生選了什麼不會被動到，按錯了再按一次就好。
        // 會改到全班的那一顆才需要確認，見下面。
        onClick={() =>
          void run(async () => {
            await submitJson(`/api/attempts/${attemptId}/grade`, {
              json: { reason: `單份重新計分（${who}）` },
            });
            router.refresh();
          })
        }
      >
        重新計分
      </Button>
      {error && <span className="yz-warn yz-grade__sub">{error}</span>}
    </>
  );
}

export type RegradeAllResult = {
  attempts: number;
  changedAttempts: number;
  needsReview: number;
  pendingManual: number;
  failures: number;
};

/** 全班重算。要填理由，因為它會寫進稽核。 */
export function RegradeAll({
  action,
  affected,
}: {
  action: (reason: string) => Promise<RegradeAllResult | { error: string }>;
  /** 會被重算的份數。確認視窗要說得出這個數字。 */
  affected: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const { busy, error, clearError, run } = useAction();
  const [done, setDone] = useState<RegradeAllResult | null>(null);

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        全班重新計分
      </Button>

      {done && (
        <Note tone="info">
          重算了 {done.attempts} 份，其中 {done.changedAttempts} 份的分數有變動。
          {done.needsReview > 0 && `　還有 ${done.needsReview} 題需要人工確認。`}
          {done.pendingManual > 0 && `　另有 ${done.pendingManual} 題非選題等待評分。`}
          {done.failures > 0 && `　${done.failures} 份算不出來，見下方。`}
        </Note>
      )}

      <ConfirmDialog
        open={open}
        onClose={() => {
          if (busy) return;
          clearError();
          setOpen(false);
        }}
        busy={busy}
        title="全班重新計分"
        confirmLabel={`重算這 ${affected} 份`}
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              這 <strong>{affected} 位學生</strong>的分數會用<strong>現在的標準答案</strong>
              重新計算，可能上升也可能下降，而且會立刻反映在他們自己看得到的成績上。
              學生原本選了什麼不會被改動——重算只動分數欄位。
              這筆異動連同每一位分數變動的學生會寫進稽核記錄。
            </p>
            {/* 「他們會不會知道」是老師按下去之前一定會想到的問題，
                而在通知接上之前這一頁答不出來（學生要自己點進去才會
                發現分數變了）。現在答得出來，就要寫在這裡。
                通知裡不寫新舊分數：收件人裡有還沒放行的那幾份，
                而放行時機是老師的決定。 */}
            <p style={{ marginBottom: 12 }} className="yz-hint">
              分數<strong>真的有變動</strong>的學生會收到一則通知（只說「重新算過」，
              不寫新舊分數），而且那一則關不掉。成績還沒放行的任務不送——
              那時他還看不到分數。
            </p>
            {error && <p className="yz-field__err">{error}</p>}
            <TextField
              label="為什麼要重算"
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              hint="例如「第 7 題標準答案原為 (2)，更正為 (3)」或「第 12 題全班送分」。事後只剩這一句說得出原因。"
            />
          </>
        }
        onConfirm={() =>
          void run(async () => {
            const r = await action(reason.trim());
            // server action 的失敗是回傳值而不是例外（它要把訊息帶過
            // 網路），在這裡轉回例外，錯誤的顯示才有單一路徑。
            if ('error' in r) throw new Error(r.error);
            setDone(r);
            setOpen(false);
            router.refresh();
          })
        }
      />
    </>
  );
}
