'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { Form, submitJson } from '@/components/Form';
import { Note } from '@/components/Feedback';

type Saved = { saved: number; unchanged: number; skipped: { subjectCode: string; reason: string }[] };

/**
 * 「把現在的預測存一份」。
 *
 * # 為什麼這是一顆按鈕而不是自動的
 *
 * 因為 `GradePrediction` 不是快取，是**證據**：它存的是「我們在某一天
 * 對你說了什麼」，等學測成績出來之後拿來對答案。若它在每次讀頁面時
 * 自動寫入，那張表會塞滿同一個預測的幾百份複本，而校準曲線的每一筆
 * 權重就變成「這位學生重整了幾次頁面」。
 *
 * # 為什麼要告訴學生「沒有變化就不會多存一份」
 *
 * 因為按了按鈕而畫面上的歷史沒有變長，看起來像壞了。
 */
export default function SnapshotButton({
  year,
  confidence,
}: {
  year: number;
  confidence: number;
}) {
  const router = useRouter();
  const [out, setOut] = useState<Saved | null>(null);

  return (
    <Form
      onSubmit={async () => {
        const res = await submitJson<{ saved: Saved }>('/api/admission/predict', {
          json: { year, confidence },
        });
        setOut(res.saved);
        router.refresh();
      }}
    >
      {({ busy }) => (
        <>
          <div className="yz-actions" style={{ justifyContent: 'flex-start' }}>
            <Button type="submit" variant="primary" busy={busy} busyLabel="存起來…">
              把現在的預測存一份
            </Button>
            <span className="yz-hint" style={{ margin: 0 }}>
              存下來的是<strong>區間與信心</strong>，學測成績公布後系統會自動補上實際級分，
              然後老師端算得出這套預測到底準不準。區間沒有變化的話不會多存一份。
            </span>
          </div>
          {out && (
            <Note tone="info">
              存了 {out.saved} 科
              {out.unchanged > 0 && `，${out.unchanged} 科與上一份完全一樣（沒有再存一份）`}
              {out.skipped.length > 0 && (
                <>
                  ，另外 {out.skipped.length} 科<strong>資料不足所以沒有存</strong>——
                  它們沒有區間可以存，而編一個區間存進去會讓校準曲線看起來很健康，
                  卻剛好毀掉唯一能檢查樣本門檻訂得對不對的機制。
                </>
              )}
              。
            </Note>
          )}
        </>
      )}
    </Form>
  );
}
