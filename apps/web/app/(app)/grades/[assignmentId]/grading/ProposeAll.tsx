/**
 * 「請 AI 先評這一題的全部」那一顆按鈕。
 *
 * # 為什麼它要說出成本
 *
 * 因為一次是 N 份 × 3 次呼叫（每一份評三次是為了量離散度，見
 * `aggregateSamples`），而每一次的輸入含題幹、規準與整篇作文。
 * 那是這個系統裡單次最貴的動作。按鈕上不寫的話，老師會在三十份的
 * 任務上按五次然後月中收到「AI 用量已到上限」。
 *
 * # 為什麼預設不重評已經有建議的
 *
 * 因為重評會把老師的決定清掉（`proposeGrade` 會把 `decidedBy` 設回
 * null——資料庫的 CHECK 要求 PENDING 不可以有決定者）。已經決定過的
 * 一律跳過，還沒決定但已有建議的預設也跳過：那一份的建議老師還沒看，
 * 重評只是把同一件事再花一次錢。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';

type BatchResult = {
  batch?: { done: number; blocked: number; skipped: number; failed: number; errors: string[] };
};

export function ProposeAll({
  assignmentId,
  questionId,
  waiting,
  pending,
  total,
}: {
  assignmentId: string;
  questionId: string;
  /** 已經有建議、還沒有人決定的份數。 */
  waiting: number;
  /** 還沒有分數的份數。 */
  pending: number;
  total: number;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  function go(redo: boolean) {
    void run(async () => {
      setMsg(null);
      const res = await submitJson<BatchResult>('/api/proposals', {
        json: { assignmentId, questionId, redo },
      });
      const b = res?.batch;
      setMsg(
        b
          ? `評好 ${b.done} 份` +
            (b.blocked > 0 ? `，${b.blocked} 份被安全規則擋下（那幾份沒有建議）` : '') +
            (b.skipped > 0 ? `，跳過 ${b.skipped} 份（已經有建議或已決定）` : '') +
            (b.failed > 0 ? `，${b.failed} 份失敗：${b.errors.join('；')}` : '')
          : '跑完了',
      );
      router.refresh();
    });
  }

  return (
    <div className="yz-prop__batchbar">
      <span className="yz-prop__asktext">
        全班 {total} 份，{pending} 份還沒有分數
        {waiting > 0 && `，${waiting} 份有建議等你決定`}。
      </span>
      <Button
        variant="quiet"
        busy={busy}
        busyLabel="AI 正在讀全班的答案（會跑一陣子）"
        disabled={total === 0}
        onClick={() => go(false)}
      >
        請 AI 先評沒有建議的
      </Button>
      <Button variant="quiet" disabled={busy || total === 0} onClick={() => go(true)}>
        全部重評
      </Button>
      <p className="yz-grade-hint">
        每一份會評三次再取中位數（差距大的會標成「判斷不穩」），所以一次是
        {total * 3} 次模型呼叫——這是系統裡單次最貴的動作，不要重複按。
        <strong>「全部重評」會清掉已經做過的決定</strong>，只在改過規準或提示詞之後用。
      </p>
      {msg && <Note tone="info">{msg}</Note>}
      {error && <Note tone="error">{error}</Note>}
    </div>
  );
}
