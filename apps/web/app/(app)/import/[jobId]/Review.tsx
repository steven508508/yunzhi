'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MathText } from '@/components/MathText';
import type { CandidateView, PageView } from '@/lib/candidates';
import { hasMath } from '@/lib/math.mjs';
import { partitionAssets } from '@/lib/questionShape.mjs';
import {
  addOption,
  answerKeysForType,
  commitBlocked,
  moveOption,
  optionIssues,
  paceEstimate,
  removeOption,
  reviewSecondsDelta,
  reviewSummary,
  saveBatchSize,
  saveIndicator,
  saveRetryDelay,
  setOptionContent,
  toggleAnswerKey,
} from '@/lib/reviewState.mjs';
import CustomTypes from './CustomTypes';
import { DeleteJob } from './DeleteJob';

/**
 * 題本匯入校對。
 *
 * 驗收標準是老師給的具體數字：**50 題 20 分鐘**，等於每題 24 秒。
 * 介面的每一個決定都是為了那 24 秒：
 *
 *  · 左欄是**真正的原稿頁面影像**，並且框出這一題在頁面上的位置。
 *    在這之前它畫的是右欄的同一份 AI 輸出，於是老師唯一的比對對象
 *    是手上那疊紙——每題 2–8 秒的翻頁稅，全份 100–400 秒。
 *  · **答案是誰給的要一眼看得出來。** 題本印的掃一眼就好（2 秒），
 *    AI 推導的要自己驗算（30–120 秒）。分不出來的話老師只有兩種
 *    行為：全部相信（危險）或全部驗算（做不完）。
 *  · 高信心題目預設只需按一次空白鍵，不需要讀
 *  · 低信心題目**明確寫出扣分理由**，老師只看被指出的地方
 *  · 全部資料一次載入，切題不打 API（網路是熱點分享，往返很貴）
 *  · 變更累積在前端，定期批次送出——而且**送失敗一定要看得見**
 *
 * # 抽錯的東西必須改得掉
 *
 * 後端的白名單開了 14 個欄位，而畫面原本只送 5 個：選項少一個、
 * 配分抽錯、題型判錯全部唯讀。改不掉的題目只能標「存疑」，而存疑
 * 進不了題庫、也沒有第二條路——一份 50 題的題本只入庫 35 題，
 * 等於驗收標準的分母被偷偷換掉了。
 *
 * # 數學式在這一頁是兩種東西
 *
 * 老師要在這裡確認「AI 抽出來的式子對不對」，而那需要同時看到兩樣：
 *
 *   **排出來的樣子**——拿去跟原稿比對。`$\ce{2H2 + O2 -> 2H2O}$`
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

type CommitError = { candidateId: string; label: string; message: string };
type CommitResult = {
  committed: number;
  skipped: number;
  explanations: number;
  pendingRewrite: number;
  errors: CommitError[];
} | null;

const TARGET_SECONDS = 20 * 60;

const TYPE_LABELS: Record<string, string> = {
  SINGLE_CHOICE: '單選',
  MULTI_CHOICE: '多選',
  FILL_SLOT: '選填',
  FILL_TEXT: '填空',
  SHORT_ANSWER: '簡答',
  ESSAY: '作文',
  TRANSLATION: '翻譯',
  TRUE_FALSE: '是非',
};

/** 需要一段文字答案的題型。選擇題的答案在 answerKeys，不在這裡。 */
const TEXT_ANSWER_TYPES = new Set(['FILL_TEXT', 'SHORT_ANSWER', 'ESSAY', 'TRANSLATION']);

export default function Review({
  jobId,
  title,
  subjectName,
  candidates: initial,
  fileNote,
  pages,
  knowledgePoints,
  reviewSeconds: initialReviewSeconds,
  committedCount,
}: {
  jobId: string;
  title: string;
  subjectName: string;
  candidates: CandidateView[];
  fileNote: string | null;
  /** 原稿頁面。空陣列代表這份題本沒有頁面影像（舊資料或第一階段沒跑完）。 */
  pages: PageView[];
  /** 這一科的知識點，供逐題調整。空的代表這個租戶還沒建知識點圖譜。 */
  knowledgePoints: { id: string; name: string }[];
  /** 之前累計的校對用時（秒）。 */
  reviewSeconds: number;
  /** 這份題本已入庫的題目數，供刪除對話框說明連帶影響。 */
  committedCount: number;
}) {
  const [items, setItems] = useState(initial);
  const [cur, setCur] = useState(() => {
    // 從第一個未處理的開始，而不是從第一題。重新進入時
    // 老師不必再捲一次。
    const i = initial.findIndex((c) => c.state === 'PENDING' && !c.questionId);
    return i < 0 ? 0 : i;
  });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [failures, setFailures] = useState(0);
  const [lastStatus, setLastStatus] = useState<number | null>(null);
  const [queued, setQueued] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [totalSeconds, setTotalSeconds] = useState(initialReviewSeconds);
  const [committing, setCommitting] = useState(false);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult>(null);

  const pending = useRef<Map<string, Change>>(new Map());
  // 入庫的動作定義在 flush 之前（它要先 flush 才能入庫），
  // 而 const 有暫時性死區，不能直接引用。用 ref 轉一手。
  const flushRef = useRef<(() => Promise<void>) | null>(null);
  const startedAt = useRef(Date.now());
  const gutterRef = useRef<HTMLElement>(null);
  // 已經回報給伺服器的校對秒數。回報的是增量，所以要記住上次到哪。
  const reported = useRef(0);
  const lastAttempt = useRef(0);
  const failureRef = useRef(0);
  // 本次開頁時已經校完幾題。推估的分母只能算本次工作階段——
  // 分子從開頁算起，分母卻帶著昨天的成果，推估就被稀釋成幾乎 0。
  const doneAtMount = useRef(
    initial.filter((c) => c.state !== 'PENDING').length,
  );

  const done = items.filter((c) => c.state !== 'PENDING').length;
  const committed = items.filter((c) => c.questionId).length;
  // **只算「已校畢且尚未入庫」的。** 不看 questionId 的話，一份已經
  // 全部入庫的題本按鈕上還是寫著「寫進題庫（50）」，按下去得到
  // 「沒有已確認、且尚未入庫的題目」。
  const ready = items.filter((c) => c.state === 'CONFIRMED' && !c.questionId).length;
  const lowConf = items.filter(
    (c) => c.state === 'PENDING' && !c.questionId && c.confidence < 0.8,
  ).length;
  const pendingTypes = useMemo(
    () => [...new Set(items.filter((c) => c.customTypeName).map((c) => c.customTypeName!))],
    [items],
  );

  const bump = useCallback(() => setQueued(pending.current.size), []);

  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // ── 批次儲存 ────────────────────────────────────────────────
  //
  // 舊版的失敗路徑**沒有任何 UI 狀態**：變更被放回佇列重試，而
  // `savedAt` 保持上一次成功的值，所以標頭繼續寫「已儲存」。
  // 持續失敗（後端 500、session 過期、一筆壞資料讓整個交易回滾）
  // 會讓老師在一個完全靜默的環境裡繼續工作二十分鐘。
  const flush = useCallback(async () => {
    if (pending.current.size === 0 || saving) return;
    lastAttempt.current = Date.now();

    // 連續失敗時把批次切小。`saveReviews` 是單一交易，一筆壞資料
    // 會讓整批回滾——切小之後壞的那一筆自己被隔離，其餘存得進去。
    const all = [...pending.current.values()];
    const changes = all.slice(0, saveBatchSize(failureRef.current));
    for (const c of changes) pending.current.delete(c.id);
    bump();

    const sessionSec = Math.floor((Date.now() - startedAt.current) / 1000);
    const delta = reviewSecondsDelta(reported.current, sessionSec);

    setSaving(true);
    try {
      const res = await fetch(`/api/import/${jobId}/candidates`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changes, reviewSeconds: delta }),
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        reported.current = sessionSec;
        if (typeof body.reviewSeconds === 'number') setTotalSeconds(body.reviewSeconds);
        setSavedAt(new Date());
        setFailures(0);
        failureRef.current = 0;
        setLastStatus(null);
      } else {
        // 放回佇列重試。**放回去之後畫面一定要說出來**——
        // 這裡是「20 分鐘的成果靜默消失」的唯一入口。
        changes.forEach((c) => pending.current.set(c.id, c));
        failureRef.current += 1;
        setFailures(failureRef.current);
        setLastStatus(res.status);
        bump();
      }
    } catch {
      changes.forEach((c) => pending.current.set(c.id, c));
      failureRef.current += 1;
      setFailures(failureRef.current);
      setLastStatus(null);
      bump();
    } finally {
      setSaving(false);
    }
  }, [jobId, saving, bump]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  useEffect(() => {
    // 固定每秒看一次，但要不要送由 `saveRetryDelay` 決定：
    // 連續失敗時往後退，不要每 8 秒撞一次已經壞掉的伺服器。
    const t = setInterval(() => {
      if (pending.current.size === 0) return;
      if (Date.now() - lastAttempt.current < saveRetryDelay(failureRef.current)) return;
      void flush();
    }, 1000);

    // 離開前一定要送出。熱點網路下 sendBeacon 比 fetch 可靠。
    //
    // **不可以只聽 `beforeunload`。** 老師是在 iPad 上校對的，而 iOS
    // Safari 在切 App、鎖屏、系統回收分頁時不會觸發它——作答頁早就
    // 因為同一件事改聽 `pagehide` 與 `visibilitychange` 了
    // （take/[assignmentId]/page.tsx 的 `beacon`），這一頁沒跟上。
    // 定期存檔最短間隔是 8 秒，所以漏掉的是「最後 8 秒的修改」：
    // 剛改完第 37 題的答案、按下 Home 鍵，那一筆就沒了，而畫面上
    // 一直寫著「已儲存」。
    //
    // 送出去之後**不清空佇列**：beacon 不保證送達，而重複送是安全的
    // （伺服器端是照 id 更新的）。切回來時佇列還在，下一輪定期存檔
    // 會再送一次。丟掉才是不可回復的。
    const onLeave = () => {
      if (pending.current.size === 0) return;
      const sessionSec = Math.floor((Date.now() - startedAt.current) / 1000);
      navigator.sendBeacon?.(
        `/api/import/${jobId}/candidates`,
        new Blob(
          [
            JSON.stringify({
              changes: [...pending.current.values()],
              reviewSeconds: reviewSecondsDelta(reported.current, sessionSec),
            }),
          ],
          { type: 'application/json' },
        ),
      );
    };
    // `visibilitychange` 只在真的隱藏時送。切到別的 App 又切回來
    // （查一下課本、回一則訊息）在 iPad 上很常見，而多送一次是安全的。
    const onHide = () => {
      if (document.visibilityState === 'hidden') onLeave();
    };
    window.addEventListener('beforeunload', onLeave);
    window.addEventListener('pagehide', onLeave);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      clearInterval(t);
      window.removeEventListener('beforeunload', onLeave);
      window.removeEventListener('pagehide', onLeave);
      document.removeEventListener('visibilitychange', onHide);
      onLeave();
    };
  }, [flush, jobId]);

  /**
   * 還有沒存的東西時，關分頁要先問一句。
   *
   * sendBeacon 送得出去的機率很高但不是保證，而這裡要保護的是
   * 老師二十分鐘的工作。已經連續失敗時更要問——那時 beacon 幾乎
   * 一定也送不出去。
   */
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (pending.current.size === 0 || failureRef.current === 0) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // ── 操作 ────────────────────────────────────────────────────
  //
  // `silent` 是給打字用的：每一個字都 setState 會讓整棵樹重畫，
  // 而原稿欄的降級路徑要為五十題各排一次 KaTeX——打字會開始頓，
  // 而頓住的介面直接吃掉每題 24 秒的預算。佇列數量晚一點更新沒關係，
  // 下一次按鍵盤或存檔就會對上。
  const queue = useCallback((id: string, part: Partial<Change>, silent = false) => {
    const q = pending.current.get(id) ?? { id };
    pending.current.set(id, {
      ...q,
      id,
      ...(part.state ? { state: part.state } : {}),
      ...(part.patch ? { patch: { ...(q.patch ?? {}), ...part.patch } } : {}),
    });
    if (!silent) setQueued(pending.current.size);
  }, []);

  const mark = useCallback((state: 'CONFIRMED' | 'FLAGGED' | 'DISCARDED') => {
    setItems((prev) => {
      const next = [...prev];
      const c = next[cur];
      if (!c || c.questionId) return prev; // 已入庫的改了沒有用，不要假裝有用
      next[cur] = { ...c, state };
      queue(c.id, { state });
      return next;
    });
    setCur((i) => Math.min(items.length - 1, i + 1));
  }, [cur, items.length, queue]);

  const patch = useCallback((p: Record<string, unknown>) => {
    setItems((prev) => {
      const next = [...prev];
      const c = next[cur];
      if (!c || c.questionId) return prev;
      next[cur] = { ...c, ...(p as Partial<CandidateView>) };
      queue(c.id, { patch: p });
      return next;
    });
  }, [cur, queue]);

  /**
   * 打字當下就進佇列，不等 blur。
   *
   * 舊版唯一進佇列的時機是 `onBlur`，而關分頁時焦點是被「分頁關閉」
   * 帶走的，不會觸發 blur——於是 `beforeunload` 送出的那一批裡
   * 根本沒有那一筆。症狀特別難察覺：**狀態存住了，內容沒存住**，
   * 那一題明明打了 ✓，內容卻是舊的。
   *
   * 這裡只寫佇列不動 `items`，因為改 state 會重新渲染
   * contentEditable，游標會跳。排出來的預覽仍然等 blur 才更新。
   */
  const patchLive = useCallback((p: Record<string, unknown>) => {
    const c = items[cur];
    if (!c || c.questionId) return;
    queue(c.id, { patch: p }, true);
  }, [cur, items, queue]);

  const onToggle = useCallback((order: number) => {
    const c = items[cur];
    if (!c) return;
    // 作文題按到數字鍵不該產生一個答案鍵。那一題根本沒有選項，
    // 而 answerKeys 會一路跟著入庫。
    if (!isChoice(c.type) && !c.options.length) return;
    patch({ answerKeys: toggleAnswerKey(c.type, c.answerKeys, order) });
  }, [cur, items, patch]);

  // ── 鍵盤 ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.code === 'Space') { e.preventDefault(); mark('CONFIRMED'); }
      else if (e.key === '?' || e.key === '？' || e.key.toLowerCase() === 'q') { e.preventDefault(); mark('FLAGGED'); }
      else if (e.key === 'ArrowDown' || e.key.toLowerCase() === 'j') { e.preventDefault(); setCur((i) => Math.min(items.length - 1, i + 1)); }
      else if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'k') { e.preventDefault(); setCur((i) => Math.max(0, i - 1)); }
      else if (/^[1-9]$/.test(e.key)) { e.preventDefault(); onToggle(Number(e.key)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mark, onToggle, items.length]);

  // 記號欄跟著捲。50 題 × 30px = 1500px，筆電上看得到 20–25 列，
  // 過了第 25 題老師就不知道自己在哪、也看不到剛打的 ✓。
  useEffect(() => {
    gutterRef.current?.querySelector<HTMLElement>('[aria-current="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cur]);

  const c = items[cur];

  // 依本次工作階段的節奏推估，對照 20 分鐘目標
  const pace = paceEstimate({
    doneNow: done,
    doneAtMount: doneAtMount.current,
    elapsedSec: elapsed,
    total: items.length,
    targetSec: TARGET_SECONDS,
  });

  const indicator = saveIndicator({
    inFlight: saving,
    pendingCount: queued,
    failures,
    savedAtLabel: savedAt ? savedAt.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : null,
    lastStatus,
  });

  const gate = commitBlocked({ failures, pendingCount: queued, ready });

  // 全部入庫完的時候，畫面要說得出「做完了」與「花了多久」——
  // 那個數字就是業主驗收要看的那一個。
  const finished = committed > 0 && ready === 0 && items.every((i) => i.state !== 'PENDING');
  const summary = finished ? reviewSummary({ total: items.length, seconds: totalSeconds }) : null;

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
    setCommitResult(null);
    try {
      await flushRef.current?.();
      if (pending.current.size > 0) {
        setCommitMsg('還有修改沒有存到伺服器，先等它存好再入庫（避免用舊的內容入庫）。');
        return;
      }
      const res = await fetch(`/api/import/${jobId}/commit`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // hint 是後端特地寫給老師看的下一步，舊版只讀 error 就把它丟了。
        setCommitMsg([body.error, body.hint].filter(Boolean).join(' ') || `入庫失敗（${res.status}）`);
        return;
      }
      const parts = [`已寫入 ${body.committed} 題`];
      if (body.explanations) parts.push(`含詳解 ${body.explanations} 則`);
      if (body.pendingRewrite) parts.push(`${body.pendingRewrite} 則詳解待改寫`);
      if (body.errors?.length) parts.push(`${body.errors.length} 題沒有進去`);
      setCommitMsg(parts.join('，'));
      setCommitResult({
        committed: body.committed ?? 0,
        skipped: body.skipped ?? 0,
        explanations: body.explanations ?? 0,
        pendingRewrite: body.pendingRewrite ?? 0,
        errors: Array.isArray(body.errors) ? body.errors : [],
      });

      // 重新載入候選題，而不是 `window.location.reload()`。
      // 舊版是 1.5 秒後整頁重載，於是「2 題失敗」那一行字連讀完
      // 都來不及，而那是這個系統唯一一次告訴老師入庫結果的機會。
      const fresh = await fetch(`/api/import/${jobId}/candidates`, { cache: 'no-store' });
      if (fresh.ok) {
        const data = await fresh.json();
        if (Array.isArray(data.candidates)) setItems(data.candidates);
      }
    } catch (e) {
      setCommitMsg(`連線失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCommitting(false);
    }
  }, [jobId]);

  return (
    <div className="yz-app">
      <header className="yz-head">
        <span className="yz-head__title">{title}</span>
        <span className="yz-head__sub">{subjectName} · 匯入校對</span>
        <span className="yz-head__right">
          <span>校畢 <span className="yz-head__num">{done}</span> / {items.length}</span>
          {committed > 0 && <span>已入庫 <span className="yz-head__num">{committed}</span></span>}
          {lowConf > 0 && <span>待確認 <span className="yz-head__num">{lowConf}</span></span>}
          <span>用時 <span className="yz-head__num">{fmt(elapsed)}</span></span>
          {pace && (
            <span title="依本次的節奏推估全部校完所需時間，目標 20 分鐘">
              推估 <span className="yz-head__num" style={{ color: pace.ok ? 'var(--confirm)' : 'var(--mark)' }}>
                {fmt(pace.est)}
              </span>
            </span>
          )}
          <span
            className={`yz-save yz-save--${indicator.kind}`}
            title={indicator.detail ?? undefined}
          >
            {indicator.label}
          </span>
          <DeleteJob jobId={jobId} title={title} committedCount={committedCount} />
          {indicator.urgent && (
            <button type="button" className="yz-btn yz-btn--quiet" onClick={() => void flush()}>
              立刻重試
            </button>
          )}
        </span>
      </header>

      {/* 存檔失敗要占畫面，不是一小塊灰字。老師會照著標頭上那句
          「已儲存」決定要不要關掉分頁。 */}
      {indicator.detail && (
        <div className="yz-savebar" role="alert">{indicator.detail}</div>
      )}

      {pendingTypes.length > 0 && (
        <CustomTypes jobId={jobId} names={pendingTypes} onApplied={(name) => {
          setItems((prev) => prev.map((i) => (i.customTypeName === name ? { ...i, customTypeName: null } : i)));
        }} />
      )}

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '52px 1fr 1fr', minHeight: 0 }}>
        {/* 校對記號欄 */}
        <nav className="yz-gutter" aria-label="題目清單" ref={gutterRef}>
          {items.map((it, i) => (
            <button
              key={it.id}
              className={[
                'yz-mark',
                i === cur ? 'yz-mark--current' : '',
                it.state === 'CONFIRMED' ? 'yz-mark--confirmed' : '',
                it.state === 'FLAGGED' ? 'yz-mark--flagged' : '',
                it.state === 'DISCARDED' ? 'yz-mark--discarded' : '',
                it.questionId ? 'yz-mark--committed' : '',
                // 答案是 AI 自己算的那幾題要先被看見——它們是老師唯一
                // 需要花時間驗算的一批。
                it.answerOrigin === 'AI_SOLVED' && !it.questionId ? 'yz-mark--solved' : '',
              ].join(' ')}
              onClick={() => setCur(i)}
              aria-current={i === cur}
              title={it.questionId ? '已入庫' : it.answerOrigin === 'AI_SOLVED' ? '答案由 AI 推導，需驗算' : undefined}
              style={{ width: '100%' }}
            >
              <span className="yz-mark__glyph" />
              <span>{it.questionNo ?? it.order}</span>
            </button>
          ))}
        </nav>

        <Source jobId={jobId} pages={pages} items={items} cur={cur} fileNote={fileNote} onPick={setCur} />

        {/* 校樣 */}
        <section className="yz-col">
          <div className="yz-colhead">
            校樣
            <span className="yz-colhead__meta yz-attrib">claude-opus-4</span>
          </div>
          <div className="yz-colbody">
            {c ? (
              <Editor
                key={c.id}
                c={c}
                jobId={jobId}
                knowledgePoints={knowledgePoints}
                onPatch={patch}
                onLive={patchLive}
                onToggle={onToggle}
              />
            ) : (
              <p>沒有候選題目。</p>
            )}

            <div style={{ display: 'flex', gap: 7, marginTop: 18, paddingTop: 12, borderTop: '1px solid var(--rule)' }}>
              <button className="yz-btn yz-btn--primary" disabled={!!c?.questionId} onClick={() => mark('CONFIRMED')}>校畢</button>
              <button className="yz-btn yz-btn--quiet" disabled={!!c?.questionId} onClick={() => mark('FLAGGED')}>存疑</button>
              <button className="yz-btn yz-btn--quiet" disabled={!!c?.questionId} onClick={() => mark('DISCARDED')}>刪除</button>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ink-2)', alignSelf: 'center' }}>
                {c?.questionId ? '已入庫' : c?.state === 'CONFIRMED' ? '已校畢' : c?.state === 'FLAGGED' ? '已存疑' : c?.state === 'DISCARDED' ? '已刪除' : '待處理'}
              </span>
            </div>

            {commitResult && (
              <CommitReport
                result={commitResult}
                items={items}
                onGo={(id) => {
                  const i = items.findIndex((x) => x.id === id);
                  if (i >= 0) setCur(i);
                }}
              />
            )}
          </div>
        </section>
      </div>

      <footer className="yz-foot">
        <span><kbd className="yz-kbd">空白</kbd> 校畢，下一題</span>
        <span><kbd className="yz-kbd">？</kbd> 存疑</span>
        <span><kbd className="yz-kbd">1–9</kbd> 設定答案</span>
        <span><kbd className="yz-kbd">↑↓</kbd> 移動</span>
        <span style={{ color: 'var(--ink-3)' }}><kbd className="yz-kbd">Esc</kbd> 離開編輯欄</span>

        {commitMsg && (
          <span style={{ marginLeft: 18, color: 'var(--ink)' }}>{commitMsg}</span>
        )}

        <span style={{ marginLeft: 'auto', display: 'flex', gap: 14, alignItems: 'center' }}>
          {summary ? (
            <>
              <span style={{ color: 'var(--ink-2)' }}>{summary.text}</span>
              <Link className="yz-btn" href="/bank">看題庫</Link>
              <Link className="yz-btn" href="/import/new">再匯一份</Link>
            </>
          ) : (
            <>
              <span style={{ color: 'var(--ink-3)' }}>
                ✓ 無誤　？ 待查　× 刪除
              </span>
              <button
                type="button"
                className="yz-btn yz-btn--primary"
                disabled={gate.blocked || committing}
                onClick={commit}
                title={gate.reason ?? `把 ${ready} 題已校畢的題目寫進題庫`}
              >
                {committing ? '寫入中…' : `寫進題庫（${ready}）`}
              </button>
            </>
          )}
        </span>
      </footer>
    </div>
  );
}

/* ── 原稿 ─────────────────────────────────────────────────── */

/**
 * 左欄：**真正的原稿**。
 *
 * 「原稿／校樣」是印刷校對的語彙，任何做過校對的人都懂：左邊是原件，
 * 右邊是打好的樣，工作是逐字比對兩邊。而在這之前左欄畫的是右欄的
 * 同一份資料再畫一次——老師以為自己在對照原稿，其實是在對照
 * AI 自己說的話，唯一真正的比對對象是手上那疊紙。
 *
 * 沒有頁面影像時（舊資料、或第一階段沒跑完）退回文字，但**要說清楚
 * 那不是原稿**。不說的話，這一欄看起來跟以前一模一樣。
 */
function Source({
  jobId, pages, items, cur, fileNote, onPick,
}: {
  jobId: string;
  pages: PageView[];
  items: CandidateView[];
  cur: number;
  fileNote: string | null;
  onPick: (i: number) => void;
}) {
  const c = items[cur];
  const [zoom, setZoom] = useState(1);
  const [manual, setManual] = useState<number | null>(null);
  const [broken, setBroken] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const srcRef = useRef<HTMLDivElement>(null);

  // 題目換了就跟著回到它所在的那一頁。老師手動翻頁之後，
  // 下一次換題再接管回來。
  useEffect(() => { setManual(null); }, [cur]);

  const wanted = manual ?? c?.sourcePage ?? null;
  // 影像載不出來（物件被清掉、儲存連不上）時退回文字，並說出原因。
  // 一個破圖圖示會讓老師以為是自己的網路，然後一直重新整理。
  const page = broken ? null : (pages.find((p) => p.index === wanted) ?? null);
  const idx = page ? pages.indexOf(page) : -1;

  useEffect(() => { setBroken(false); }, [wanted]);

  // 捲到這一題在頁面上的位置。影像是非同步載入的，所以載完也要再捲一次。
  const scrollToBox = useCallback(() => {
    boxRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);
  useEffect(() => { scrollToBox(); }, [cur, scrollToBox]);

  useEffect(() => {
    if (page) return;
    srcRef.current?.querySelector<HTMLElement>('[data-current="1"]')
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [cur, page]);

  const bbox = c?.sourceBbox;
  const lowQuality = page && page.quality < 0.75;

  return (
    <section className="yz-col yz-col--src">
      <div className="yz-colhead">
        原稿
        {pages.length > 0 && (
          <span className="yz-srcnav">
            <button
              type="button"
              className="yz-btn yz-btn--quiet"
              disabled={idx <= 0}
              onClick={() => setManual(pages[idx - 1]?.index ?? null)}
              aria-label="上一頁"
            >‹</button>
            <span>{page ? `p. ${page.index}` : '—'}</span>
            <button
              type="button"
              className="yz-btn yz-btn--quiet"
              // idx 是 -1（這一題沒有記錄頁碼）時，「下一頁」要能把老師
              // 帶到第一頁——不然他就困在一個沒有原稿的畫面上。
              disabled={idx >= pages.length - 1}
              onClick={() => setManual(pages[idx + 1]?.index ?? pages[0]?.index ?? null)}
              aria-label="下一頁"
            >›</button>
            <button
              type="button"
              className="yz-btn yz-btn--quiet"
              onClick={() => setZoom((z) => Math.max(1, Math.round((z - 0.25) * 100) / 100))}
              aria-label="縮小"
            >−</button>
            <button
              type="button"
              className="yz-btn yz-btn--quiet"
              onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.25) * 100) / 100))}
              aria-label="放大"
            >＋</button>
          </span>
        )}
        <span className="yz-colhead__meta">
          {!pages.length && c?.sourcePage ? `p. ${c.sourcePage}` : ''}
          {page?.fileName ?? fileNote ?? ''}
        </span>
      </div>

      <div className="yz-colbody" ref={srcRef}>
        {page ? (
          <>
            {lowQuality && (
              // 逐頁的品質分數本來就存著（ImportPage.quality），只是
              // 從來沒有出現在老師需要它的那一題旁邊。
              <p className="yz-hint" style={{ marginBottom: 8 }}>
                這一頁的拍攝或掃描品質偏低（{page.quality.toFixed(2)}），請仔細確認。
                {page.qualityNotes.slice(0, 2).join('　')}
              </p>
            )}
            <div className="yz-page" style={{ width: `${zoom * 100}%` }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/import/${jobId}/image?page=${page.index}&file=${encodeURIComponent(page.fileId)}`}
                alt={`原稿第 ${page.index} 頁`}
                width={page.width}
                height={page.height}
                onLoad={scrollToBox}
                onError={() => setBroken(true)}
              />
              {bbox && (manual == null || manual === c?.sourcePage) && (
                // 座標是頁寬高的比例（0–1），所以用百分比定位——
                // 影像縮放時框會自己跟著走，不必重算。
                <div
                  ref={boxRef}
                  className="yz-page__box"
                  style={{
                    left: `${bbox.x0 * 100}%`,
                    top: `${bbox.y0 * 100}%`,
                    width: `${(bbox.x1 - bbox.x0) * 100}%`,
                    height: `${(bbox.y1 - bbox.y0) * 100}%`,
                  }}
                />
              )}
            </div>
            {!bbox && (
              <p className="yz-hint" style={{ marginTop: 8 }}>
                這一題沒有記錄在頁面上的位置，只能定位到整頁。
              </p>
            )}
          </>
        ) : (
          <>
            <p className="yz-hint" style={{ marginBottom: 10 }}>
              {broken ? (
                <>
                  原稿影像載不出來（可能已被清理，或物件儲存連不上）。
                  下面是 AI 讀出來的文字——<strong>不是原稿</strong>。
                </>
              ) : pages.length ? (
                '這一題沒有記錄原稿頁碼，下面是 AI 讀出來的文字。可以用上面的翻頁鍵找。'
              ) : (
                <>
                  這份題本沒有頁面影像，下面是 AI 讀出來的文字——
                  <strong>不是原稿</strong>，請對照手上的題本確認。
                </>
              )}
            </p>
            <div className="yz-scan">
              {items.map((it, i) => (
                <div
                  key={it.id}
                  className={`yz-q ${i === cur ? 'yz-q--current' : ''}`}
                  data-current={i === cur ? '1' : '0'}
                  onClick={() => onPick(i)}
                >
                  {it.stimulus && i === cur && <div style={{ marginBottom: 6 }}><MathText>{it.stimulus}</MathText></div>}
                  <span style={{ fontWeight: 600 }}>{it.questionNo ?? it.order}.</span>{' '}
                  {it.subLabel && <span style={{ fontWeight: 600 }}>{it.subLabel}</span>}
                  <MathText>{it.content}</MathText>
                  {it.sourcePage != null && (
                    <span className="yz-muted" style={{ marginLeft: 6, fontSize: 11 }}>p. {it.sourcePage}</span>
                  )}
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
          </>
        )}
      </div>
    </section>
  );
}

/* ── 單題編輯 ─────────────────────────────────────────────── */

function Editor({
  c, jobId, knowledgePoints, onPatch, onLive, onToggle,
}: {
  c: CandidateView;
  jobId: string;
  knowledgePoints: { id: string; name: string }[];
  onPatch: (p: Record<string, unknown>) => void;
  onLive: (p: Record<string, unknown>) => void;
  onToggle: (order: number) => void;
}) {
  const locked = Boolean(c.questionId);
  const multi = c.type === 'MULTI_CHOICE';
  const issues = optionIssues(c.options, c.answerKeys, c.type);
  /**
   * 每一段文字自己的附圖。
   *
   * **與 `lib/commit.ts` 是同一支函式**（`partitionAssets`），這一頁的
   * 驗收標準才成立：20 分鐘校完 50 題靠的是「校對畫面等於學生畫面」，
   * 而在這之前這一頁把整包 `c.assets` 一起餵給題幹、選項一張都不給。
   * 症狀是物理題四張力圖全堆在題幹後面、四個選項空著——**而那正是
   * 入庫之後學生會看到的樣子，老師卻在這裡看不出來**。
   */
  const media = partitionAssets({
    assets: c.assets,
    stimulus: c.stimulus,
    content: c.content,
    options: c.options,
  });
  // severity 是 error 的理由**一律顯示**。舊版整塊側註被
  // `confidence >= 0.8` 擋掉，而「AI 自答失敗，這題沒有答案」
  // 正好發生在信心 0.90 的題目上——警告被信心分數吃掉了。
  const reasons = c.confidenceReasons.filter(
    (r) => r.severity === 'error' || c.confidence < 0.8,
  );

  return (
    <div className="yz-proof">
      {locked && (
        <p className="yz-note yz-note--info" style={{ marginBottom: 12 }}>
          這一題<strong>已經寫進題庫</strong>了，在這裡改沒有用——學生考的是題庫裡的那一份。
          　<Link href={`/bank/${c.questionId}`}>到題庫改這一題</Link>
        </p>
      )}

      {c.stimulus && (
        <div style={{ marginBottom: 14, paddingBottom: 12, borderBottom: '1px solid var(--rule-2)' }}>
          <div className="yz-section" style={{ border: 'none', marginBottom: 4, fontSize: 12 }}>題組前導敘述</div>
          <Editable
            value={c.stimulus}
            locked={locked}
            label="題組前導敘述"
            onLive={(v) => onLive({ stimulus: v })}
            onCommit={(v) => onPatch({ stimulus: v })}
          />
          {/* 題組共用的圖（圖表題的表、實驗題的裝置圖）掛在素材上，
              不在任何一個子題的題幹裡。不傳 assets 的話這裡只會印
              一個「〔附圖〕」的小記號，而老師無從確認那張表對不對。 */}
          <Preview source={c.stimulus} assets={media.stimulusAssets} label="題組素材" jobId={jobId} />
        </div>
      )}

      <div className="yz-item">
        <div className="yz-item__no">{c.questionNo ?? c.order}</div>
        <div>
          {c.subLabel && <div style={{ fontWeight: 600, marginBottom: 2 }}>{c.subLabel}</div>}

          <Editable
            value={c.content}
            locked={locked}
            label="題幹"
            onLive={(v) => onLive({ content: v })}
            onCommit={(v) => onPatch({ content: v })}
          />
          {/* 圖排在題幹裡的**它該在的位置**（`![[a:…]]` 指到哪就畫在哪），
              而不是全部堆在題幹後面。這一頁存在的理由就是讓老師確認
              AI 有沒有把圖對到正確的題目、有沒有把兩題的圖對調、
              有沒有裁歪——堆在後面的話，「如右圖」到底指哪一張看不出來。 */}
          <Preview
            source={c.content}
            assets={media.contentAssets}
            label={`第 ${c.questionNo ?? c.order} 題`}
            jobId={jobId}
          />

          {/* 標記指向一張不存在的圖。
              **這一段之前寫的是「請不要刪掉」**——照著做的結果是這一題
              帶著一個永遠對不到東西的標記入庫，學生看到一行紅字。
              現在說的是真話：這一題入庫會被退回（lib/commit.ts 用同一支
              `partitionAssets` 判斷），而且說得出老師可以怎麼辦。 */}
          {media.missing.length > 0 && (
            <p className="yz-note yz-note--error" style={{ marginTop: 8 }}>
              {[...new Set(media.missing.map((m) => m.where))].join('、')}裡的{' '}
              <code>![[a:{media.missing.map((m) => m.id).join('、')}]]</code>{' '}
              指向這份題本<strong>沒有裁出來的圖</strong>。維持原樣入庫的話會被退回，
              學生也會在那個位置看到一句「這裡有一張附圖，但系統找不到它」。
              <br />
              原稿上那是<strong>表格</strong>的話，可以直接用{' '}
              <code>| 甲 | 乙 |</code> 一行一列打進去，再把標記刪掉；
              是<strong>圖</strong>的話請重跑這一頁的判讀。
            </p>
          )}

          {/* ── 選項 ─────────────────────────────────────────
              舊版選項只有 map 出來，點下去是設定答案：少抓一個選項、
              多抓一個、順序錯了全部改不掉，那些題目只能標「存疑」，
              而存疑進不了題庫也沒有第二條路。 */}
          {(c.options.length > 0 || isChoice(c.type)) && (
            <div style={{ marginTop: 8 }}>
              {c.options.map((o, i) => (
                <div key={o.order} className={`yz-opt ${c.answerKeys.includes(o.order) ? 'yz-opt--answer' : ''}`}>
                  <button
                    type="button"
                    className="yz-opt__pick"
                    disabled={locked}
                    onClick={() => onToggle(o.order)}
                    role="checkbox"
                    aria-checked={c.answerKeys.includes(o.order)}
                    title={multi ? '點一下加入／移出答案' : '點一下設成答案'}
                  >
                    ({o.label})
                  </button>
                  {/* 可編輯欄位裡放原始碼，底下再排一次。物理的四個選項
                      常常只差一個向量箭頭，那個差別要排出來才看得到。 */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Editable
                      value={o.content}
                      locked={locked}
                      label={`選項 ${o.label}`}
                      onLive={(v) => onLive(dropDropped(setOptionContent(c.options, c.answerKeys, o.order, v)))}
                      onCommit={(v) => onPatch(dropDropped(setOptionContent(c.options, c.answerKeys, o.order, v)))}
                    />
                    {/* 選項自己的附圖。物理的「下列何者為合力」四個選項
                        就是四張力圖，不傳的話這裡印的是「〔附圖〕」小記號
                        ——老師看不出四張圖有沒有對到正確的選項，而那正是
                        這一頁存在的理由。 */}
                    <Preview
                      source={o.content}
                      assets={media.optionAssets[i]?.assets ?? []}
                      label={`選項 (${o.label})`}
                      jobId={jobId}
                    />
                  </div>
                  {!locked && (
                    <span className="yz-opt__tools">
                      <button type="button" title="往上移" aria-label={`把選項 ${o.label} 往上移`}
                              disabled={i === 0}
                              onClick={() => onPatch(dropDropped(moveOption(c.options, c.answerKeys, o.order, -1)))}>↑</button>
                      <button type="button" title="往下移" aria-label={`把選項 ${o.label} 往下移`}
                              disabled={i === c.options.length - 1}
                              onClick={() => onPatch(dropDropped(moveOption(c.options, c.answerKeys, o.order, 1)))}>↓</button>
                      <button type="button" title="刪掉這個選項" aria-label={`刪掉選項 ${o.label}`}
                              onClick={() => onPatch(dropDropped(removeOption(c.options, c.answerKeys, o.order)))}>×</button>
                    </span>
                  )}
                </div>
              ))}

              {!locked && (
                <button
                  type="button"
                  className="yz-btn yz-btn--quiet"
                  style={{ marginTop: 4 }}
                  onClick={() => onPatch(dropDropped(addOption(c.options, c.answerKeys)))}
                >
                  ＋ 新增選項
                </button>
              )}

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
                  <span className="yz-slot" contentEditable={!locked} suppressContentEditableWarning
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

          {/* 參考答案欄的顯示條件是「這個題型需要文字答案」，不是
              「answerText 不是 null」。自答失敗時 answerText 保持 null，
              於是老師被告知「請手動填入」而畫面上沒有可以填的地方。 */}
          {needsTextAnswer(c) && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--ink-2)' }}>參考答案</div>
              <Editable
                value={c.answerText}
                locked={locked}
                label="參考答案"
                placeholder="尚無答案，請填入"
                onLive={(v) => onLive({ answerText: v })}
                onCommit={(v) => onPatch({ answerText: v })}
              />
              <Preview source={c.answerText} />
            </div>
          )}

          {/* ── 中繼資料。題型與配分改得掉。 ───────────────── */}
          <div className="yz-meta">
            <label>
              題型{' '}
              <select
                className="yz-in yz-in--inline"
                value={c.type ?? ''}
                disabled={locked}
                onChange={(e) => {
                  const type = e.target.value;
                  onPatch({ type, answerKeys: answerKeysForType(type, c.answerKeys) });
                }}
              >
                {c.type == null && <option value="">—</option>}
                {Object.entries(TYPE_LABELS).map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </select>
            </label>
            <label>
              配分{' '}
              <input
                className="yz-in yz-in--inline"
                type="number"
                min={0}
                max={100}
                step={0.5}
                style={{ width: 62 }}
                disabled={locked}
                value={c.score ?? ''}
                placeholder="—"
                onChange={(e) => {
                  const v = e.target.value;
                  onPatch({ score: v === '' ? null : Number(v) });
                }}
              />
            </label>
            <AnswerOrigin c={c} />
            <span>信心 <b>{c.confidence.toFixed(2)}</b></span>
            {c.selfConsistency != null && (
              <span>自答一致率 <b>{(c.selfConsistency * 100).toFixed(0)}%</b></span>
            )}
          </div>

          {/* 配分抽不到時以 0 分入庫（commit.ts），而題目本身永遠是 0 分
              ——組卷時逐題改只改那一張卷子。所以這裡要吵。 */}
          {c.score == null && !locked && (
            <p className="yz-hint">沒有抓到配分。就這樣入庫的話這一題是 <b>0 分</b>，請填一個數字。</p>
          )}

          <KnowledgePoints c={c} all={knowledgePoints} locked={locked} onPatch={onPatch} />

          {issues.length > 0 && !locked && (
            <div className="yz-aside">
              <div className="yz-aside__head">入庫前要處理</div>
              <ul>{issues.map((i) => <li key={i.code + i.detail}>{i.detail}</li>)}</ul>
            </div>
          )}

          {/* 入庫時被退回的原因。寫得很好，而在這之前沒有任何畫面讀得到
              ——老師看到的只是那一題突然從 ✓ 變成 ？，沒有原因。 */}
          {c.reviewNote && (
            <div className="yz-aside">
              <div className="yz-aside__head">上次入庫沒有進去</div>
              <ul><li>{c.reviewNote}</li></ul>
            </div>
          )}

          {/* AI 的疑慮寫成側註，而不是彩色警示框 */}
          {reasons.length > 0 && (
            <div className="yz-aside">
              <div className="yz-aside__head">
                校對者請注意
                <em>信心 {c.confidence.toFixed(2)}</em>
              </div>
              <ul>
                {reasons.map((r, i) => <li key={i}>{r.detail}</li>)}
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
 * 答案是誰給的。
 *
 * **這是整個校對流程裡最需要知道的一件事**，因為它決定老師該花多少
 * 時間：題本印的只要確認位置沒抄錯（2 秒），AI 推導的必須自己驗算
 * （一題數學 30–120 秒）。`answerOrigin` 一直都載進瀏覽器了，
 * 只是從來沒有被畫出來，於是老師在不知情的狀況下把「校對」做成了
 * 「照單全收」。
 */
function AnswerOrigin({ c }: { c: CandidateView }) {
  if (c.answerOrigin === 'SOURCE_PRINTED') {
    return <span>答案來源 <b>題本印的</b></span>;
  }
  if (c.answerOrigin === 'AI_SOLVED') {
    return (
      <span className="yz-origin yz-origin--ai">
        答案來源 <b>AI 推導，請自行驗算</b>
      </span>
    );
  }
  if (!c.answerKeys.length && !c.answerText && !c.answerSlots?.length) {
    return <span className="yz-origin yz-origin--ai">答案 <b>還沒有</b>，請填入</span>;
  }
  return <span>答案來源 <b>未標記</b></span>;
}

/**
 * 知識點。
 *
 * 標註階段挑的知識點會跟著題目入庫，能力分析整個建立在它上面——
 * 標錯的話那一題以後永遠算在錯的章節底下。所以它必須改得掉。
 */
function KnowledgePoints({
  c, all, locked, onPatch,
}: {
  c: CandidateView;
  all: { id: string; name: string }[];
  locked: boolean;
  onPatch: (p: Record<string, unknown>) => void;
}) {
  const picked = c.kpSuggestions.filter((k) => k?.id);
  const rest = all.filter((k) => !picked.some((p) => p.id === k.id));

  if (!picked.length && !all.length) return null;

  return (
    <div className="yz-kp">
      <span className="yz-kp__label">知識點</span>
      {picked.map((k) => (
        <span key={k.id} className="yz-kp__chip">
          {k.name}
          <em>{k.weight.toFixed(1)}</em>
          {!locked && (
            <button
              type="button"
              aria-label={`移除知識點 ${k.name}`}
              onClick={() => onPatch({ kpSuggestions: picked.filter((x) => x.id !== k.id) })}
            >×</button>
          )}
        </span>
      ))}
      {!picked.length && <span className="yz-muted">沒有標註</span>}
      {!locked && rest.length > 0 && (
        <select
          className="yz-in yz-in--inline"
          value=""
          onChange={(e) => {
            const hit = all.find((k) => k.id === e.target.value);
            if (hit) onPatch({ kpSuggestions: [...picked, { id: hit.id, name: hit.name, weight: 1 }] });
          }}
        >
          <option value="">＋ 加一個</option>
          {rest.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
      )}
    </div>
  );
}

/**
 * 入庫結果。
 *
 * 舊版是一行字加 1.5 秒後整頁重載——而那一行是這個系統唯一一次告訴
 * 老師「哪幾題沒有進去」的機會。失敗的原因寫得非常好
 * （`commit.ts` 的那兩段），只是沒有人看得到。
 */
function CommitReport({
  result, items, onGo,
}: {
  result: NonNullable<CommitResult>;
  items: CandidateView[];
  onGo: (id: string) => void;
}) {
  return (
    <section className="yz-fieldset" style={{ marginTop: 16 }}>
      <h2 className="yz-legend">入庫結果</h2>
      <p style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 6 }}>
        寫入 {result.committed} 題
        {result.explanations ? `，含詳解 ${result.explanations} 則` : ''}
        {result.pendingRewrite ? `，${result.pendingRewrite} 則詳解待改寫` : ''}
        {result.errors.length ? `，${result.errors.length} 題沒有進去` : ''}
      </p>
      {result.errors.length > 0 && (
        <ul style={{ marginTop: 8, paddingLeft: 0, listStyle: 'none' }}>
          {result.errors.map((e) => {
            const hit = items.find((i) => i.id === e.candidateId);
            return (
              <li key={e.candidateId + e.message} style={{ padding: '5px 0', fontSize: 12.5, lineHeight: 1.7 }}>
                <button
                  type="button"
                  className="yz-linkish"
                  onClick={() => onGo(e.candidateId)}
                  disabled={!hit}
                >
                  {e.label || hit?.questionNo || '這一題'}
                </button>
                　{e.message}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ── 小元件 ───────────────────────────────────────────────── */

/**
 * 可編輯欄位。
 *
 * 兩件事非做不可：
 *
 * **鍵盤要出得去。** 改完題幹按空白鍵（畫面最底下就寫著「空白 校畢」）
 * 時，游標還在這一欄裡，於是空白鍵沒有被攔截——它照瀏覽器的預設行為
 * 在題幹裡打了一個空白字元，而題目沒有被標成校畢。按三下就多三個空白，
 * 然後在 blur 時寫進資料庫。
 *
 * **打字當下就要進佇列。** 只在 blur 時進佇列的話，關分頁時焦點是被
 * 「分頁關閉」帶走的，那一筆從來沒進過佇列。
 */
function Editable({
  value, locked, label, placeholder, onLive, onCommit,
}: {
  value: string | null;
  locked: boolean;
  label: string;
  placeholder?: string;
  onLive: (v: string) => void;
  onCommit: (v: string) => void;
}) {
  return (
    <div
      className={`yz-edit${locked ? ' yz-edit--locked' : ''}`}
      contentEditable={!locked}
      suppressContentEditableWarning
      role="textbox"
      aria-label={label}
      aria-readonly={locked}
      data-placeholder={placeholder}
      onInput={(e) => onLive(e.currentTarget.textContent ?? '')}
      onBlur={(e) => onCommit(e.currentTarget.textContent ?? '')}
      onKeyDown={(e) => {
        // Enter 直接離開：題幹是單行的東西，換行只會在資料庫裡留下
        // 一個看不見的 \n。Esc 與 Ctrl/Cmd+Enter 同樣離開。
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    >
      {value}
    </div>
  );
}

/**
 * 可編輯欄位底下那一條「排出來的樣子」。
 *
 * **沒有數學式也沒有圖就不畫。** 一頁五十題，每一題的題幹、前導敘述、
 * 參考答案底下都多一條一模一樣的重複內容，老師要多捲一倍的距離才看得完
 * 一題——而 24 秒的預算裡沒有那個空間。有式子或有圖的那幾題才是需要
 * 對照的那幾題。
 *
 * 附圖算「排出來」的一部分：老師在上面那一格看到的是原始碼（含
 * `![[a:fig1]]` 的標記），這一格要給他**題目最後長什麼樣**。少了圖的話，
 * 一道幾何題在這一頁上永遠是一段沒有圖的敘述，而他要判斷的正是
 * 那張圖對不對、有沒有跟隔壁題對調。
 *
 * 網址走 `/api/import/[jobId]/image`：那一支問的是「你教不教這份
 * 題本的科目」，正是校對這件事的權限。候選題還沒入庫，`/api/assets`
 * 那條路（綁題目與作答）在這裡問不到東西。
 */
function Preview({
  source,
  assets,
  label,
  jobId,
}: {
  source: string | null;
  assets?: unknown[];
  label?: string;
  jobId?: string;
}) {
  const hasFigure = Array.isArray(assets) && assets.length > 0;
  if (!hasMath(source) && !hasFigure) return null;
  return (
    <div className="yz-mathpreview">
      <span className="yz-mathpreview__label">排出來</span>
      <MathText
        assets={assets}
        label={label}
        assetBase={jobId ? `/api/import/${jobId}/image?key=` : undefined}
      >
        {source}
      </MathText>
    </div>
  );
}

function isChoice(t: string | null) {
  return t === 'SINGLE_CHOICE' || t === 'MULTI_CHOICE' || t === 'TRUE_FALSE';
}

function needsTextAnswer(c: CandidateView) {
  if (c.options.length || c.answerSlots?.length) return false;
  return TEXT_ANSWER_TYPES.has(c.type ?? '') || c.answerText != null;
}

/** `dropped` 是給畫面看的，不是要送進 patch 的欄位。 */
function dropDropped(r: { options: unknown; answerKeys: number[] }) {
  return { options: r.options, answerKeys: r.answerKeys };
}

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
