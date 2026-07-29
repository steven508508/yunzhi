/**
 * 一題的人工給分。
 *
 * # 為什麼這一格只是一個輸入框
 *
 * 因為它要出現在**每一題旁邊**，而老師改一份作文卷是連續打十次分數。
 * 做成對話框的話，那是十次開關；做成一整頁的表單，中途離開就全部
 * 不見。所以它是就地輸入、就地送出，送完那一列直接顯示新的分數。
 *
 * # 為什麼送出之後要重新整理整頁
 *
 * 因為總分與「已評分 / 待評分」跟著變，而那兩個數字在頁首。只更新
 * 這一列的話，老師改完作文之後看到的還是「待評分」，然後他會再改
 * 一次——而第二次改的是同一個值。
 *
 * # 為什麼「取消人工分數」要單獨一顆
 *
 * 給錯分要收得回來，而收回去的意思是「回到自動計分」，不是「給 0 分」。
 * 兩者在客觀題上差很多：前者讓那一題重新照標準答案判，後者是老師
 * 明確地判它 0 分。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { submitJson, useAction } from '@/components/Form';

export function ScoreOne({
  attemptId,
  questionId,
  order,
  max,
  current,
  manual,
}: {
  attemptId: string;
  questionId: string;
  /** 題號。輸入框的標籤要說得出是第幾題，否則讀螢幕的人聽到的是十個「分數」。 */
  order: number;
  /** 這一題的配分（快照）。 */
  max: number;
  current: number | null;
  /** 現在這個分數是不是人給的。決定要不要畫「取消人工分數」。 */
  manual: boolean;
}) {
  const router = useRouter();
  const [score, setScore] = useState(current === null ? '' : String(current));
  const [note, setNote] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  function send(value: number | null) {
    return run(async () => {
      setDone(null);
      await submitJson(`/api/attempts/${attemptId}/score`, {
        json: { questionId, score: value, note: note.trim() || null },
      });
      setDone(value === null ? '已改回自動計分' : `已給 ${value} 分`);
      router.refresh();
    });
  }

  return (
    <div className="yz-score">
      <label className="yz-score__lab" htmlFor={`score-${questionId}`}>
        第 {order} 題給分
      </label>
      <input
        id={`score-${questionId}`}
        className="yz-in yz-score__in"
        type="number"
        min={0}
        max={max}
        step="0.5"
        value={score}
        disabled={busy}
        onChange={(e) => setScore(e.currentTarget.value)}
      />
      <span className="yz-score__max">／ {max} 分</span>
      <input
        className="yz-in yz-score__note"
        type="text"
        value={note}
        disabled={busy}
        placeholder="為什麼是這個分數（家長問起時只剩這一句）"
        onChange={(e) => setNote(e.currentTarget.value)}
      />
      <Button
        variant="quiet"
        busy={busy}
        busyLabel="存檔中"
        disabled={score.trim() === ''}
        onClick={() => void send(Number(score))}
      >
        給分
      </Button>
      {manual && (
        <Button variant="quiet" disabled={busy} onClick={() => void send(null)}>
          取消人工分數
        </Button>
      )}
      {done && <span className="yz-grade__sub">{done}</span>}
      {error && <span className="yz-warn yz-grade__sub">{error}</span>}
    </div>
  );
}
