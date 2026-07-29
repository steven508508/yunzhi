/**
 * 對話本體。
 *
 * # 為什麼與入口分成兩個檔案
 *
 * 因為它 import 了 `MathText`，而 `MathText` 會把 KaTeX（約 280 KB，
 * gzip 後約 80 KB）拉進 client bundle。合在一起的話，**每一位打開
 * 檢討頁的學生都要先下載 KaTeX**——包括只想看自己幾分、根本不會
 * 點開對話的那大多數人，而他們多半在手機的行動網路上。
 *
 * 分開之後這一份走 `next/dynamic` 動態載入：按下「問智慧老師」
 * 那一刻才下載。那時候本來就要等一次 API 往返，多的幾十 KB
 * 藏在那次等待裡。
 *
 * 排版的規則只有一份（`lib/math.mjs`），這裡只是把它接到 React 上，
 * 所以「同一題在檢討頁排得出來、在對話裡排不出來」不會發生。
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/Button';
import { MathText } from '@/components/MathText';

import type { SessionView } from './Tutor';

const MODES: { key: string; label: string; hint: string }[] = [
  // 三顆按鈕的文案用學生的話寫，不用「策略」的話寫。
  // 「Small tip 策略」對他沒有意義，「給我一點提示就好」有。
  { key: 'SMALL_TIP', label: '給我一點提示', hint: '我大概會，只是卡在某一步' },
  { key: 'STEP_BY_STEP', label: '一步一步帶我', hint: '從頭帶我想一次' },
  { key: 'BASIC_TOPIC', label: '回頭講基本觀念', hint: '這個單元我根本沒懂' },
];

export function TutorChat({
  order,
  initial,
  onClose,
}: {
  order: number;
  initial: SessionView;
  onClose: () => void;
}) {
  const [session, setSession] = useState<SessionView>(initial);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  /** 樂觀顯示的自己那一句。送失敗時要收回來，不然他會以為送出去了。 */
  const [pending, setPending] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // 新訊息進來就捲到底。**只捲對話區，不捲整頁**——整頁捲動會把
  // 學生正在對照的題目與解析推出畫面外，而他就是為了對照才打開的。
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.messages.length, pending, sending]);

  // 虛擬鍵盤。visualViewport 是唯一知道「鍵盤佔掉多少」的東西；
  // 沒有它的瀏覽器（桌機）這一段不會做任何事。
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : undefined;
    if (!vv) return;
    const onResize = () => {
      if (document.activeElement !== inputRef.current) return;
      composerRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body || sending) return;
      setSending(true);
      setError(null);
      setPending(body);
      setDraft('');
      try {
        const res = await fetch(`/api/tutor/${encodeURIComponent(session.sessionId)}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: body, mode: mode ?? undefined }),
        });
        const json = await res.json();
        if (!res.ok) {
          setError(json.error ?? '送不出去');
          // 把他打的字放回輸入框。重打一次是最讓人放棄的事。
          setDraft(body);
          return;
        }
        setSession(json.session);
      } catch {
        setError('連不上伺服器。你的訊息沒有送出去。');
        setDraft(body);
      } finally {
        setPending(null);
        setSending(false);
      }
    },
    [mode, sending, session.sessionId],
  );

  const finish = useCallback(
    async (resolved: boolean) => {
      try {
        const res = await fetch(`/api/tutor/${encodeURIComponent(session.sessionId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ resolved }),
        });
        if (res.ok) setSession(await res.json());
      } catch {
        // 結束失敗不必打擾學生：對話留在 OPEN 的後果只是他下次
        // 點進來會接續同一段，那本來就是想要的行為。
      }
      if (!resolved) onClose();
    },
    [onClose, session.sessionId],
  );

  const closed = session.status !== 'OPEN';
  const askedStuck = session.stuckAt !== null;

  return (
    <section className="yz-tutor" aria-label={`第 ${order} 題的智慧老師`}>
      <div className="yz-tutor__head">
        <h4 className="yz-tutor__title">智慧老師</h4>
        {/* 一句話說清楚它會做什麼、不會做什麼。沒有這一句的話，
            學生前三則都在試「你就直接跟我說答案嘛」。 */}
        <p className="yz-tutor__sub">
          它不會直接給答案——答案跟解析就在上面，你想看隨時看得到。
          它做的是問你問題、陪你想。
        </p>
        <button type="button" className="yz-tutor__x" onClick={() => finish(false)} aria-label="收起對話">
          收起
        </button>
      </div>

      <div className="yz-tutor__log" ref={listRef} role="log" aria-live="polite">
        {session.messages.map((m) => (
          <div key={m.id} className={`yz-tutor__msg yz-tutor__msg--${m.role.toLowerCase()}`}>
            <span className="yz-tutor__who">{m.role === 'STUDENT' ? '你' : '老師'}</span>
            {/* 引導裡全是式子。這一段沒有排出來的話，
                「先求 $\vec{F}=m\vec{a}$」會變成一串讀不下去的符號。 */}
            <div className="yz-tutor__body">
              <MathText>{m.content}</MathText>
            </div>
          </div>
        ))}
        {pending && (
          <div className="yz-tutor__msg yz-tutor__msg--student yz-tutor__msg--pending">
            <span className="yz-tutor__who">你</span>
            <div className="yz-tutor__body">{pending}</div>
          </div>
        )}
        {sending && (
          // 「老師正在想」而不是一個轉圈的圈圈。等 3 秒的時候，
          // 知道對方在做什麼與不知道，是完全不同的 3 秒。
          <div className="yz-tutor__msg yz-tutor__msg--tutor yz-tutor__thinking">
            <span className="yz-tutor__who">老師</span>
            <div className="yz-tutor__body">正在想怎麼問你…</div>
          </div>
        )}
      </div>

      {closed ? (
        <div className="yz-tutor__done">
          {session.resolvedAt ? '很好，這一題就到這裡。' : '這一段對話結束了。'}
          <button type="button" className="yz-tutor__quiet" onClick={onClose}>
            收起
          </button>
        </div>
      ) : (
        <>
          {/* 開場的卡點選項。手機上點一下比打字快得多，而第一句
              打不打得出來，決定了這段對話會不會發生。 */}
          {!askedStuck && (
            <div className="yz-tutor__chips" role="group" aria-label="你卡在哪裡">
              {session.openingChoices.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="yz-tutor__chip"
                  disabled={sending}
                  onClick={() => send(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          )}

          {/* 三種模式。預設由系統依卡點與前置掌握度判斷（見 pickMode），
              學生按了就以他的為準——他比系統更知道自己現在要什麼。
              **這三顆裡面沒有一顆是「直接看答案」**，那是刻意的。 */}
          {askedStuck && (
            <div className="yz-tutor__modes" role="group" aria-label="想要哪一種教法">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  title={m.hint}
                  aria-pressed={mode === m.key}
                  className={`yz-tutor__mode${mode === m.key ? ' yz-tutor__mode--on' : ''}`}
                  onClick={() => setMode(mode === m.key ? null : m.key)}
                >
                  {m.label}
                </button>
              ))}
              {mode === null && <span className="yz-tutor__modehint">（沒選的話由老師判斷）</span>}
            </div>
          )}

          <div className="yz-tutor__composer" ref={composerRef}>
            <textarea
              ref={inputRef}
              className="yz-tutor__input"
              rows={2}
              value={draft}
              maxLength={2000}
              placeholder={askedStuck ? '把你想到的寫下來，寫錯也沒關係' : '你卡在哪裡？'}
              disabled={sending}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                // Enter 送出、Shift+Enter 換行——但**只在桌機**。
                // 手機的 Enter 是換行鍵，攔截它會讓學生沒辦法分段。
                if (e.key === 'Enter' && !e.shiftKey && !isTouch()) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
              onFocus={() => {
                // 鍵盤彈出來要一點時間，立刻捲會捲到舊的位置。
                setTimeout(
                  () => composerRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }),
                  300,
                );
              }}
            />
            <div className="yz-tutor__acts">
              <Button variant="primary" busy={sending} busyLabel="送出中" onClick={() => send(draft)}>
                送出
              </Button>
              {/* 「我懂了」是這一段對話唯一的成功結局，而且是學生自己
                  宣告的。系統不替他判斷懂了沒——schema 的欄位註解
                  說得很清楚，沒有按不代表沒懂。 */}
              <Button variant="quiet" onClick={() => finish(true)} disabled={sending}>
                我懂了
              </Button>
            </div>
          </div>

          {error && (
            <p className="yz-tutor__err" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** 觸控裝置。用來決定 Enter 要不要當成送出。 */
function isTouch(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}
