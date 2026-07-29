/**
 * 智慧老師的對話介面。
 *
 * # 這一塊在檢討頁上的位置是刻意的
 *
 * 它在每一題的**最下面**，正確答案與解析的下方。這個順序就是三層
 * 設限的第三層：**對話框裡沒有「直接看答案」的捷徑，因為答案就在
 * 它上面。** 學生想看隨時看得到——但那是他自己往上捲去看，
 * 不是 AI 講給他聽。
 *
 * 看起來只是排版，實際上是這個功能與「一個比較慢的解析」的分界。
 *
 * # 為什麼答對的題目也能問，但不主動推
 *
 * 答對的題目按鈕是灰的一行小字，答錯的是一顆看得見的按鈕。理由是
 * 猜對的人自己知道他是猜的——他會去找入口；而每一題都推一次
 * 「要不要問問看」，第三題之後就變成背景噪音，那時候他答錯的那一題
 * 也一起變成噪音了。
 *
 * # 手機
 *
 * 學生多半在手機上檢討，而手機上這種介面最常見的壞法是**輸入框被
 * 虛擬鍵盤蓋住**。做法有三：
 *
 *   一、輸入框留在正常文件流裡，**不用 `position: fixed`**。
 *       iOS 的鍵盤彈出時不會改變 fixed 元素的定位基準，於是它會被
 *       蓋在鍵盤底下，而且捲不出來。
 *   二、`visualViewport` 的 resize 事件觸發時把輸入框捲進可視範圍。
 *       那是唯一一個真的知道「鍵盤佔掉多少高度」的 API。
 *   三、輸入框字級 16px。小於 16px 時 iOS Safari 會自動放大整頁，
 *       而放大之後版面會位移——學生打字打到一半畫面自己跳走。
 */
'use client';

import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';

import { Button } from '@/components/Button';

export type Message = {
  id: string;
  role: 'STUDENT' | 'TUTOR';
  content: string;
  createdAt: string;
};

export type SessionView = {
  sessionId: string;
  status: string;
  stuckAt: string | null;
  resolvedAt: string | null;
  messageCount: number;
  messages: Message[];
  openingChoices: string[];
};

/**
 * 對話本體是動態載入的。理由見 TutorChat.tsx 的檔頭：KaTeX 不該由
 * 「只想看自己幾分」的那大多數人買單。
 *
 * `ssr: false` 是因為這一塊本來就沒有伺服器端可渲染的內容——
 * 對話要先 POST 開一段 session 才存在。
 */
const TutorChat = dynamic(() => import('./TutorChat').then((m) => m.TutorChat), {
  ssr: false,
  loading: () => <p className="yz-tutor__loading">正在開對話…</p>,
});

export function TutorEntry({
  attemptId,
  questionId,
  order,
  wrong,
}: {
  attemptId: string;
  questionId: string;
  order: number;
  /** 答錯或沒作答。決定入口長成一顆按鈕還是一行小字。 */
  wrong: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/tutor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId, questionId }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? '打不開');
        return;
      }
      setSession(body);
      setOpen(true);
    } catch {
      setError('連不上伺服器。網路好一點的時候再試一次。');
    } finally {
      setBusy(false);
    }
  }, [attemptId, questionId]);

  if (!open) {
    return (
      <div className="yz-tutor__entry">
        {wrong ? (
          <Button variant="primary" busy={busy} busyLabel="正在開" onClick={start}>
            這一題我還是不懂，問智慧老師
          </Button>
        ) : (
          // 答對的題目：一行灰字。看得到，但不會擠到畫面上。
          <button type="button" className="yz-tutor__quiet" onClick={start} disabled={busy}>
            答對了但想再確認一下？可以問智慧老師
          </button>
        )}
        {error && <p className="yz-tutor__err">{error}</p>}
      </div>
    );
  }

  return (
    <TutorChat
      order={order}
      initial={session!}
      onClose={() => setOpen(false)}
    />
  );
}

