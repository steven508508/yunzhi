'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MathText } from '@/components/MathText';
import type { CandidateView } from '@/lib/candidates';
import { hasMath } from '@/lib/math.mjs';

/**
 * 題本匯入校對。
 *
 * 驗收標準是老師給的具體數字：**50 題 20 分鐘**，等於每題 24 秒。
 * 介面的每一個決定都是為了那 24 秒：
 *
 *  · 高信心題目預設只需按一次空白鍵，不需要讀
 *  · 低信心題目**明確寫出扣分理由**，老師只看被指出的地方
 *  · 全部資料一次載入，切題不打 API（網路是熱點分享，往返很貴）
 *  · 變更累積在前端，定期批次送出
 *  · 右上角即時對照 20 分鐘目標
 *
 * # 數學式在這一頁是兩種東西
 *
 * 老師要在這裡確認「AI 抽出來的式子對不對」，而那需要同時看到兩樣：
 *
 *   **排出來的樣子**——拿去跟手上的題本比對。`$\ce{2H2 + O2 -> 2H2O}$`
 *     這一串沒有辦法跟紙上的反應式比，排成 2H₂ + O₂ → 2H₂O 才能比。
 *   **原始碼**——發現錯了要改的就是它。
 *
 * 所以可編輯的欄位裡放原始碼，底下多一條排好的預覽。**不可以反過來
 * 把可編輯欄位換成排好的式子**：contentEditable 存回去的是
 * `textContent`，而 KaTeX 的輸出同時含 MathML 與 HTML 兩份，
 * 那一讀會把式子讀成重複兩次的亂碼寫進資料庫——老師只要點過那一欄
 * 再點走，題目的原文就毀了，而且畫面上完全看不出來。
 */

type Change = { id: string; state?: string; patch?: Record<string, unknown>; note?: string };

const TARGET_SECONDS = 20 * 60;

export default function Review({
  jobId,
  title,
  subjectName,
  candidates: initial,
  fileNote,
}: {
  jobId: string;
  title: string;
  subjectName: string;
  candidates: CandidateView[];
  fileNote: string | null;
}) {
  const [items, setItems] = useState(initial);
  const [cur, setCur] = useState(() => {
    // 從第一個未處理的開始，而不是從第一題。重新進入時
    // 老師不必再捲一次。
    const i = initial.findIndex((c) => c.state === 'PENDING');
    return i < 0 ? 0 : i;
  });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [committing, setCommitting] = useState(false);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);

  const pending = useRef<Map<string, Change>>(new Map());
  // 入庫的動作定義在 flush 之前（它要先 flush 才能入庫），
  // 而 const 有暫時性死區，不能直接引用。用 ref 轉一手。
  const flushRef = useRef<(() => Promise<void>) | null>(null);
  const startedAt = useRef(Date.now());
  const srcRef = useRef<HTMLDivElement>(null);

  const done = items.filter((c) => c.state !== 'PENDING').length;
  const ready = items.filter((c) => c.state === 'CONFIRMED').length;
  const lowConf = items.filter((c) => c.state === 'PENDING' && c.confidence < 0.8).length;

  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  /**
   * 寫進題庫。
   *
   * 只送已校畢的題目，存疑與待校的留著——老師本來就是分批做的，
   * 而「一定要全部校完才能入庫」會讓 50 題裡的一題卡住整批。
   *
   * 入庫前一定先把未存的變更送出去。否則剛按下的那幾題
   * 還在前端的暫存區，入庫會漏掉它們。
   */
  const commit = useCallback(async () => {
    setCommitting(true);
    setCommitMsg(null);
    try {
      await flushRef.current?.();
      const res = await fetch(`/api/import/${jobId}/commit`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCommitMsg(body.error ?? `入庫失敗（${res.status}）`);
        return;
      }
      const parts = [`已寫入 ${body.committed} 題`];
      if (body.explanations) parts.push(`含詳解 ${body.explanations} 則`);
      if (body.pendingRewrite) parts.push(`${body.pendingRewrite} 則詳解待改寫`);
      if (body.errors?.length) parts.push(`${body.errors.length} 題失敗`);
      setCommitMsg(parts.join('，'));
      // 已入庫的題目不該再顯示成待入庫。重新載入是最簡單也最不會錯的做法。
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      setCommitMsg(`連線失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCommitting(false);
    }
  }, [jobId]);

  // ── 批次儲存 ────────────────────────────────────────────────
  const flush = useCallback(async () => {
    if (pending.current.size === 0 || saving) return;
    const changes = [...pending.current.values()];
    pending.current.clear();
    setSaving(true);
    try {
      const res = await fetch(`/api/import/${jobId}/candidates`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changes, reviewSeconds: Math.floor((Date.now() - startedAt.current) / 1000) }),
      });
      if (res.ok) setSavedAt(new Date());
      else changes.forEach((c) => pending.current.set(c.id, c)); // 失敗時放回佇列重試
    } catch {
      changes.forEach((c) => pending.current.set(c.id, c));
    } finally {
      setSaving(false);
    }
  }, [jobId, saving]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  useEffect(() => {
    const t = setInterval(flush, 8000);
    // 離開前一定要送出。熱點網路下 sendBeacon 比 fetch 可靠。
    const onLeave = () => {
      if (pending.current.size === 0) return;
      navigator.sendBeacon?.(
        `/api/import/${jobId}/candidates`,
        new Blob([JSON.stringify({ changes: [...pending.current.values()] })], { type: 'application/json' }),
      );
    };
    window.addEventListener('beforeunload', onLeave);
    return () => { clearInterval(t); window.removeEventListener('beforeunload', onLeave); onLeave(); };
  }, [flush, jobId]);

  // ── 操作 ────────────────────────────────────────────────────
  const mark = useCallback((state: 'CONFIRMED' | 'FLAGGED' | 'DISCARDED') => {
    setItems((prev) => {
      const next = [...prev];
      const c = next[cur];
      if (!c) return prev;
      next[cur] = { ...c, state };
      pending.current.set(c.id, { ...(pending.current.get(c.id) ?? { id: c.id }), id: c.id, state });
      return next;
    });
    setCur((i) => Math.min(items.length - 1, i + 1));
  }, [cur, items.length]);

  const patch = useCallback((p: Record<string, unknown>) => {
    setItems((prev) => {
      const next = [...prev];
      const c = next[cur];
      if (!c) return prev;
      next[cur] = { ...c, ...(p as Partial<CandidateView>) };
      const q = pending.current.get(c.id) ?? { id: c.id };
      pending.current.set(c.id, { ...q, id: c.id, patch: { ...(q.patch ?? {}), ...p } });
      return next;
    });
  }, [cur]);

  const toggleAnswer = useCallback((order: number) => {
    const c = items[cur];
    if (!c) return;
    const multi = c.type === 'MULTI_CHOICE';
    const keys = multi
      ? c.answerKeys.includes(order)
        ? c.answerKeys.filter((k) => k !== order)
        : [...c.answerKeys, order].sort((a, b) => a - b)
      : [order];
    patch({ answerKeys: keys });
  }, [cur, items, patch]);

  // ── 鍵盤 ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.isContentEditable || ['INPUT', 'TEXTAREA'].includes(t?.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.code === 'Space') { e.preventDefault(); mark('CONFIRMED'); }
      else if (e.key === '?' || e.key === '？' || e.key.toLowerCase() === 'q') { e.preventDefault(); mark('FLAGGED'); }
      else if (e.key === 'ArrowDown' || e.key.toLowerCase() === 'j') { e.preventDefault(); setCur((i) => Math.min(items.length - 1, i + 1)); }
      else if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'k') { e.preventDefault(); setCur((i) => Math.max(0, i - 1)); }
      else if (/^[1-9]$/.test(e.key)) { e.preventDefault(); toggleAnswer(Number(e.key)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mark, toggleAnswer, items.length]);

  useEffect(() => {
    srcRef.current?.querySelector<HTMLElement>('[data-current="1"]')
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [cur]);

  const c = items[cur];

  // 依實際節奏推估 50 題所需時間，對照 20 分鐘目標
  const pace = useMemo(() => {
    if (done === 0) return null;
    const per = elapsed / done;
    const est = per * items.length;
    return { per, est, ok: est <= TARGET_SECONDS };
  }, [done, elapsed, items.length]);

  return (
    <div className="yz-app">
      <header className="yz-head">
        <span className="yz-head__title">{title}</span>
        <span className="yz-head__sub">{subjectName} · 匯入校對</span>
        <span className="yz-head__right">
          <span>校畢 <span className="yz-head__num">{done}</span> / {items.length}</span>
          {lowConf > 0 && <span>待確認 <span className="yz-head__num">{lowConf}</span></span>}
          <span>用時 <span className="yz-head__num">{fmt(elapsed)}</span></span>
          {pace && (
            <span title="依目前節奏推估全部校完所需時間，目標 20 分鐘">
              推估 <span className="yz-head__num" style={{ color: pace.ok ? 'var(--confirm)' : 'var(--mark)' }}>
                {fmt(pace.est)}
              </span>
            </span>
          )}
          <span style={{ color: 'var(--ink-3)', minWidth: 52 }}>
            {saving ? '儲存中…' : savedAt ? '已儲存' : ''}
          </span>
        </span>
      </header>

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '52px 1fr 1fr', minHeight: 0 }}>
        {/* 校對記號欄 */}
        <nav className="yz-gutter" aria-label="題目清單">
          {items.map((it, i) => (
            <button
              key={it.id}
              className={[
                'yz-mark',
                i === cur ? 'yz-mark--current' : '',
                it.state === 'CONFIRMED' ? 'yz-mark--confirmed' : '',
                it.state === 'FLAGGED' ? 'yz-mark--flagged' : '',
                it.state === 'DISCARDED' ? 'yz-mark--discarded' : '',
              ].join(' ')}
              onClick={() => setCur(i)}
              aria-current={i === cur}
              style={{ width: '100%' }}
            >
              <span className="yz-mark__glyph" />
              <span>{it.questionNo ?? it.order}</span>
            </button>
          ))}
        </nav>

        {/* 原稿 */}
        <section className="yz-col yz-col--src">
          <div className="yz-colhead">
            原稿
            <span className="yz-colhead__meta">
              {c?.sourcePage ? `p. ${c.sourcePage}` : ''}{fileNote ? ` · ${fileNote}` : ''}
            </span>
          </div>
          <div className="yz-colbody" ref={srcRef}>
            <div className="yz-scan">
              {items.map((it, i) => (
                <div key={it.id} className={`yz-q ${i === cur ? 'yz-q--current' : ''}`} data-current={i === cur ? '1' : '0'}>
                  {/* 這一欄是拿來跟紙本比對的，所以一律排出來——
                      這裡沒有任何可編輯的欄位，不必擔心 contentEditable。 */}
                  {it.stimulus && i === cur && <div style={{ marginBottom: 6 }}><MathText>{it.stimulus}</MathText></div>}
                  <span style={{ fontWeight: 600 }}>{it.questionNo ?? it.order}.</span>{' '}
                  {it.subLabel && <span style={{ fontWeight: 600 }}>{it.subLabel}</span>}
                  <MathText>{it.content}</MathText>
                  {it.options.length > 0 && (
                    <div style={{ marginLeft: '1.6em' }}>
                      {it.options.map((o) => (
                        <span key={o.order} style={{ display: 'block' }}>({o.label}) <MathText>{o.content}</MathText></span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 校樣 */}
        <section className="yz-col">
          <div className="yz-colhead">
            校樣
            <span className="yz-colhead__meta yz-attrib">claude-opus-4</span>
          </div>
          <div className="yz-colbody">
            {c ? <Editor c={c} onPatch={patch} onToggle={toggleAnswer} /> : <p>沒有候選題目。</p>}

            <div style={{ display: 'flex', gap: 7, marginTop: 18, paddingTop: 12, borderTop: '1px solid var(--rule)' }}>
              <button className="yz-btn yz-btn--primary" onClick={() => mark('CONFIRMED')}>校畢</button>
              <button className="yz-btn yz-btn--quiet" onClick={() => mark('FLAGGED')}>存疑</button>
              <button className="yz-btn yz-btn--quiet" onClick={() => mark('DISCARDED')}>刪除</button>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ink-2)', alignSelf: 'center' }}>
                {c?.state === 'CONFIRMED' ? '已校畢' : c?.state === 'FLAGGED' ? '已存疑' : c?.state === 'DISCARDED' ? '已刪除' : '待處理'}
              </span>
            </div>
          </div>
        </section>
      </div>

      <footer className="yz-foot">
        <span><kbd className="yz-kbd">空白</kbd> 校畢，下一題</span>
        <span><kbd className="yz-kbd">？</kbd> 存疑</span>
        <span><kbd className="yz-kbd">1–9</kbd> 設定答案</span>
        <span><kbd className="yz-kbd">↑↓</kbd> 移動</span>

        {commitMsg && (
          <span style={{ marginLeft: 18, color: 'var(--ink)' }}>{commitMsg}</span>
        )}

        <span style={{ marginLeft: 'auto', display: 'flex', gap: 14, alignItems: 'center' }}>
          <span style={{ color: 'var(--ink-3)' }}>
            ✓ 無誤　？ 待查　× 刪除
          </span>
          <button
            type="button"
            className="yz-btn yz-btn--primary"
            disabled={ready === 0 || committing || saving}
            onClick={commit}
            title={
              ready === 0
                ? '把題目標成「校畢」之後才能寫進題庫'
                : `把 ${ready} 題已校畢的題目寫進題庫`
            }
          >
            {committing ? '寫入中…' : `寫進題庫（${ready}）`}
          </button>
        </span>
      </footer>
    </div>
  );
}

/* ── 單題編輯 ─────────────────────────────────────────────── */

function Editor({
  c, onPatch, onToggle,
}: {
  c: CandidateView;
  onPatch: (p: Record<string, unknown>) => void;
  onToggle: (order: number) => void;
}) {
  const high = c.confidence >= 0.8;
  const multi = c.type === 'MULTI_CHOICE';

  return (
    <div className="yz-proof">
      {c.stimulus && (
        <div style={{ marginBottom: 14, paddingBottom: 12, borderBottom: '1px solid var(--rule-2)' }}>
          <div className="yz-section" style={{ border: 'none', marginBottom: 4, fontSize: 12 }}>題組前導敘述</div>
          <div className="yz-edit" contentEditable suppressContentEditableWarning
               onBlur={(e) => onPatch({ stimulus: e.currentTarget.textContent })}>
            {c.stimulus}
          </div>
          <Preview source={c.stimulus} />
        </div>
      )}

      <div className="yz-item">
        <div className="yz-item__no">{c.questionNo ?? c.order}</div>
        <div>
          {c.subLabel && <div style={{ fontWeight: 600, marginBottom: 2 }}>{c.subLabel}</div>}

          <div className="yz-edit" contentEditable suppressContentEditableWarning
               onBlur={(e) => onPatch({ content: e.currentTarget.textContent })}>
            {c.content}
          </div>
          <Preview source={c.content} />

          {c.options.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {c.options.map((o) => (
                <div key={o.order}
                     className={`yz-opt ${c.answerKeys.includes(o.order) ? 'yz-opt--answer' : ''}`}
                     onClick={() => onToggle(o.order)}
                     role="checkbox" aria-checked={c.answerKeys.includes(o.order)} tabIndex={0}>
                  <span className="yz-opt__label">({o.label})</span>
                  {/* 選項不是可編輯欄位（點下去是設定答案），所以直接排出來。
                      物理的四個選項常常只差在向量箭頭，那個差別在原始碼
                      狀態下要一個字一個字比——而老師只有 24 秒。 */}
                  <span><MathText>{o.content}</MathText></span>
                </div>
              ))}
              {multi && (
                <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 3 }}>
                  多選題：可選多個。計分為 (n−2k)/n，n 為選項數、k 為答錯數。
                </div>
              )}
            </div>
          )}

          {c.answerSlots && c.answerSlots.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {c.answerSlots.map((s, i) => (
                <span key={i}>
                  {s.slot}
                  <span className="yz-slot" contentEditable suppressContentEditableWarning
                        onBlur={(e) => {
                          const next = [...c.answerSlots!];
                          next[i] = { ...s, value: e.currentTarget.textContent ?? '' };
                          onPatch({ answerSlots: next });
                        }}>
                    {s.value}
                  </span>
                </span>
              ))}
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 3 }}>
                選填題：答案填入答案卡上對應編號的格位，一格一字元。
              </div>
            </div>
          )}

          {c.answerText != null && !c.options.length && !c.answerSlots?.length && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--ink-2)' }}>參考答案</div>
              <div className="yz-edit" contentEditable suppressContentEditableWarning
                   onBlur={(e) => onPatch({ answerText: e.currentTarget.textContent })}>
                {c.answerText}
              </div>
              <Preview source={c.answerText} />
            </div>
          )}

          <div className="yz-meta">
            <span>題型 <b>{typeLabel(c.type)}</b></span>
            <span>配分 <b>{c.score ?? '—'}</b></span>
            <span>信心 <b>{c.confidence.toFixed(2)}</b></span>
            {c.selfConsistency != null && (
              <span>自答一致率 <b>{(c.selfConsistency * 100).toFixed(0)}%</b></span>
            )}
            {c.kpSuggestions.length > 0 && (
              <span>知識點 <b>{c.kpSuggestions.map((k) => `${k.name}（${k.weight.toFixed(1)}）`).join('、')}</b></span>
            )}
          </div>

          {/* AI 的疑慮寫成側註，而不是彩色警示框 */}
          {!high && c.confidenceReasons.length > 0 && (
            <div className="yz-aside">
              <div className="yz-aside__head">
                校對者請注意
                <em>信心 {c.confidence.toFixed(2)}</em>
              </div>
              <ul>
                {c.confidenceReasons.map((r, i) => <li key={i}>{r.detail}</li>)}
              </ul>
            </div>
          )}

          {/* 自答未形成共識時，把各次推導並列給老師裁決。
              強行給一個答案會讓老師誤信。 */}
          {c.selfConsistency != null && c.selfConsistency < 0.6 && Array.isArray(c.solveTrace) && (
            <details style={{ marginTop: 10, fontSize: 12 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--mark)' }}>
                各次推導（{(c.solveTrace as unknown[]).length} 次，未形成共識）
              </summary>
              <div style={{ marginTop: 6, paddingLeft: 12, borderLeft: '1px solid var(--rule)' }}>
                {(c.solveTrace as { approach: string; reasoning: string; answer_keys?: number[] }[]).map((t, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <b style={{ fontWeight: 500 }}>{t.approach}</b>
                    {t.answer_keys?.length ? ` → (${t.answer_keys.join(')(')})` : ''}
                    {/* 推導過程本身就是式子。老師是靠讀這幾段來裁決哪一次
                        算對的，讀的是算式而不是反斜線。 */}
                    <div style={{ color: 'var(--ink-2)', lineHeight: 1.7 }}>
                      <MathText>{t.reasoning}</MathText>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 可編輯欄位底下那一條「排出來的樣子」。
 *
 * **沒有數學式就不畫。** 一頁五十題，每一題的題幹、前導敘述、參考答案
 * 底下都多一條一模一樣的重複內容，老師要多捲一倍的距離才看得完一題——
 * 而 24 秒的預算裡沒有那個空間。有式子的那幾題才是需要對照的那幾題。
 */
function Preview({ source }: { source: string | null }) {
  if (!hasMath(source)) return null;
  return (
    <div className="yz-mathpreview">
      <span className="yz-mathpreview__label">排出來</span>
      <MathText>{source}</MathText>
    </div>
  );
}

function typeLabel(t: string | null) {
  return ({
    SINGLE_CHOICE: '單選', MULTI_CHOICE: '多選', FILL_SLOT: '選填',
    FILL_TEXT: '填空', SHORT_ANSWER: '簡答', ESSAY: '作文',
    TRANSLATION: '翻譯', TRUE_FALSE: '是非',
  } as Record<string, string>)[t ?? ''] ?? t ?? '—';
}

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
