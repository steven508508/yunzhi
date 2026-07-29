'use client';

/**
 * 作答畫面。
 *
 * # 這一頁的敵人是網路與硬體，不是作弊
 *
 * 規格書文件 01 §9.2 那句話是這一整頁的設計依據。所以每一個決定都在
 * 回答同一個問題：**這個動作失敗的時候，學生的答案還在不在。**
 *
 *   · 答案改了就進待存佇列，防抖 1.2 秒送出，另有 8 秒的保底輪詢
 *   · 送失敗的放回佇列重試，不清空、不提示、不打斷作答
 *   · 分頁被切掉或關掉時用 sendBeacon 送出未存的（beforeunload 在
 *     手機上不可靠，所以聽的是 pagehide 與 visibilitychange）
 *   · 重新整理不會遺失任何東西：答案在伺服器上，版面快照也在
 *
 * # 倒數以伺服器為準
 *
 * 前端只做插值顯示。剩餘秒數來自伺服器（開始作答、每次存檔、
 * 每 30 秒校時一次），中間用 `performance.now()` 遞減——**不是**
 * `Date.now()`，因為那個會被使用者改系統時間影響，而
 * `performance.now()` 是單調的。
 *
 * 分頁切到背景時瀏覽器會節流計時器（手機鎖屏更嚴重），所以回到前景的
 * 第一件事是重新校時。純前端的倒數在學生切出去回個訊息再回來時，
 * 會顯示還剩十分鐘而其實已經結束了。
 *
 * # 這是 client component，而且沒有伺服器端的資料
 *
 * 整頁靠 `/api/attempts/*` 取得資料。**正確答案不在任何一個回應裡**
 * （見 lib/attempt.ts 的 `loadAttemptForStudent`），所以開發者工具
 * 按開來也看不到答案——這比在畫面上藏起來重要得多。
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { Empty, ErrorBox, Loading, Note } from '@/components/Feedback';
import { MathText } from '@/components/MathText';
import type { StudentTask, TakeQuestion, TakeView } from '@/lib/attempt';

type AnswerState = {
  answerKeys: number[];
  answerText: string | null;
  answerSlots: { slot: string; value: string }[] | null;
  flagged: boolean;
};

type SubmitResult = {
  status: string;
  submittedAt: string | null;
  autoSubmitted: boolean;
  late: boolean;
  answered: number;
  total: number;
  alreadySubmitted: boolean;
};

type Phase = 'loading' | 'brief' | 'taking' | 'submitted' | 'error';

/** 送出去給伺服器的一筆。與 API 的 schema 對齊。 */
type Pending = {
  questionId: string;
  answerKeys?: number[];
  answerText?: string | null;
  answerSlots?: { slot: string; value: string }[] | null;
  flagged?: boolean;
};

const DEBOUNCE_MS = 1200;
const SAFETY_FLUSH_MS = 8000;
const CLOCK_SYNC_MS = 30_000;

export default function TakeAssignmentPage() {
  const { assignmentId } = useParams<{ assignmentId: string }>();

  const [phase, setPhase] = useState<Phase>('loading');
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [task, setTask] = useState<StudentTask | null>(null);
  const [view, setView] = useState<TakeView | null>(null);
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
  const [cur, setCur] = useState(0);

  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);

  // 待存佇列。用 ref 而不是 state：它每一次按鍵都會變，
  // 而它的內容不影響畫面——放進 state 只會多一堆重繪。
  const pending = useRef<Map<string, Pending>>(new Map());
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const submitLock = useRef(false);
  const attemptId = view?.attemptId ?? null;
  const attemptRef = useRef<string | null>(null);
  attemptRef.current = attemptId;

  /**
   * 校時後的時鐘。`base` 是伺服器說的剩餘秒數，`at` 是收到它的那一刻
   * （單調時鐘）。畫面上的秒數 = base − (現在 − at)。
   */
  const clock = useRef<{ base: number; at: number } | null>(null);
  // 每半秒加一，只為了讓倒數重新計算一次。時鐘本身在 ref 裡，
  // 放進 state 會讓每一次校時都重繪整份題目。
  const [beat, setBeat] = useState(0);

  const syncClock = useCallback((remaining: number | null | undefined) => {
    if (remaining == null) {
      clock.current = null;
      return;
    }
    clock.current = { base: remaining, at: now() };
    setBeat((x) => x + 1);
  }, []);

  const left = useMemo(() => {
    void beat; // 這一個相依只是為了跟著計時器重算
    const c = clock.current;
    if (!c) return null;
    return Math.max(0, Math.round(c.base - (now() - c.at) / 1000));
  }, [beat]);

  // ── 載入 ────────────────────────────────────────────────────

  const enterView = useCallback(
    (v: TakeView) => {
      setView(v);
      const next: Record<string, AnswerState> = {};
      for (const q of v.questions) {
        next[q.questionId] = {
          answerKeys: q.answerKeys ?? [],
          answerText: q.answerText ?? null,
          answerSlots: q.answerSlots ?? null,
          flagged: q.flagged ?? false,
        };
      }
      setAnswers(next);
      syncClock(v.remainingSeconds);
      if (v.status === 'IN_PROGRESS') {
        setPhase('taking');
        // 從第一題未作答的開始。中斷之後重新進來時，學生不必自己
        // 一題一題按過去找到寫到哪裡。
        const i = v.questions.findIndex((q) => !isAnswered(next[q.questionId]));
        setCur(i < 0 ? 0 : i);
      } else {
        setPhase('submitted');
      }
    },
    [syncClock],
  );

  const boot = useCallback(async () => {
    setPhase('loading');
    setFatal(null);
    try {
      const res = await fetch(`/api/attempts?assignmentId=${encodeURIComponent(assignmentId)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFatal(body.error ?? `讀取失敗（${res.status}）`);
        setPhase('error');
        return;
      }
      const t = body.task as StudentTask;
      setTask(t);

      if (t.openAttemptId) {
        // 寫到一半的：直接接續，**不呼叫開始作答**（那一支有副作用）。
        const r2 = await fetch(`/api/attempts/${t.openAttemptId}?full=1`);
        const v = await r2.json().catch(() => ({}));
        if (!r2.ok) {
          setFatal(v.error ?? `讀取失敗（${r2.status}）`);
          setPhase('error');
          return;
        }
        enterView(v as TakeView);
        setNotice('已回到你上次中斷的地方。');
        return;
      }
      setPhase('brief');
    } catch (e) {
      setFatal(`連不上伺服器：${e instanceof Error ? e.message : String(e)}`);
      setPhase('error');
    }
  }, [assignmentId, enterView]);

  useEffect(() => {
    void boot();
  }, [boot]);

  const start = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    setFatal(null);
    try {
      const res = await fetch('/api/attempts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assignmentId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFatal(body.error ?? `無法開始作答（${res.status}）`);
        return;
      }
      enterView(body as TakeView);
    } catch (e) {
      setFatal(`連不上伺服器：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setStarting(false);
    }
  }, [assignmentId, enterView, starting]);

  // ── 存檔 ────────────────────────────────────────────────────

  /** 伺服器說這份已經不能再寫了（時間到、已交卷、不是你的）。 */
  const handleClosed = useCallback(
    async (message: string) => {
      pending.current.clear();
      setNotice(message);
      const id = attemptRef.current;
      if (!id) {
        setPhase('submitted');
        return;
      }
      const res = await fetch(`/api/attempts/${id}?full=1`).catch(() => null);
      const body = await res?.json().catch(() => null);
      if (res?.ok && body) enterView(body as TakeView);
      else setPhase('submitted');
    },
    [enterView],
  );

  const flush = useCallback(async () => {
    const id = attemptRef.current;
    if (!id || pending.current.size === 0 || inFlight.current) return;

    const batch = [...pending.current.values()];
    pending.current.clear();
    inFlight.current = true;
    setSaving(true);
    try {
      const res = await fetch(`/api/attempts/${id}/answers`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers: batch }),
      });
      const body = await res.json().catch(() => ({}));

      if (res.ok) {
        setSavedAt(new Date());
        if (body.remainingSeconds != null) syncClock(body.remainingSeconds);
        // 伺服器收下了大部分、但有幾題不收（例如送來的選項編號不對）。
        // **這一種一定要說**：學生以為寫好的那一題其實沒有存進去，
        // 而他不會再回去看那一題。
        if (Array.isArray(body.failed) && body.failed.length > 0) {
          setNotice(
            `有 ${body.failed.length} 題沒有存成功（${body.failed[0].error}）。` +
              `請舉手告訴監考老師。`,
          );
        }
        return;
      }
      if (res.status === 409 || res.status === 403 || res.status === 404) {
        await handleClosed(body.error ?? '這份作答已經結束了');
        return;
      }
      // 其他失敗（多半是網路或伺服器暫時性的）：放回佇列，下一輪再試。
      // **不要提示學生**——他什麼都不能做，而中斷他作答的成本更高。
      requeue(pending.current, batch);
    } catch {
      requeue(pending.current, batch);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, [handleClosed, syncClock]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  const queue = useCallback((questionId: string, state: AnswerState) => {
    pending.current.set(questionId, {
      questionId,
      answerKeys: state.answerKeys,
      answerText: state.answerText,
      answerSlots: state.answerSlots,
      flagged: state.flagged,
    });
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void flushRef.current(), DEBOUNCE_MS);
  }, []);

  /** 保底：連續打字會一直把防抖往後推，這一條確保最多 8 秒就送一次。 */
  useEffect(() => {
    if (phase !== 'taking') return;
    const t = setInterval(() => void flushRef.current(), SAFETY_FLUSH_MS);
    return () => clearInterval(t);
  }, [phase]);

  /**
   * 離開頁面時把未存的送出去。
   *
   * 手機上 `beforeunload` 常常不會觸發（切 App、鎖屏、系統回收分頁），
   * 所以聽的是 `pagehide` 與 `visibilitychange`。sendBeacon 是 POST，
   * 所以 API 那邊有一支 `POST = PATCH`。
   *
   * **送出去之後不清空佇列**：beacon 不保證送達，而重複送是安全的
   * （伺服器端是 upsert）。丟掉才是不可回復的。
   */
  const beacon = useCallback(() => {
    const id = attemptRef.current;
    if (!id || pending.current.size === 0) return;
    const payload = JSON.stringify({ answers: [...pending.current.values()] });
    navigator.sendBeacon?.(
      `/api/attempts/${id}/answers`,
      new Blob([payload], { type: 'application/json' }),
    );
  }, []);

  // ── 校時 ────────────────────────────────────────────────────

  const refreshStatus = useCallback(async () => {
    const id = attemptRef.current;
    if (!id) return;
    try {
      const res = await fetch(`/api/attempts/${id}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return;
      syncClock(body.remainingSeconds);
      if (body.status && body.status !== 'IN_PROGRESS') {
        await handleClosed(
          body.autoSubmitted ? '時間到，系統已經幫你交卷。' : '這份作答已經交出去了。',
        );
      }
    } catch {
      // 校時失敗就沿用本地插值。斷線時倒數繼續走是正確的行為——
      // 時間不會因為斷線而停止。
    }
  }, [handleClosed, syncClock]);

  useEffect(() => {
    if (phase !== 'taking') return;
    const t = setInterval(() => setBeat((x) => x + 1), 500);
    const sync = setInterval(() => void refreshStatus(), CLOCK_SYNC_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') void refreshStatus();
      else beacon();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', beacon);
    return () => {
      clearInterval(t);
      clearInterval(sync);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', beacon);
      beacon();
    };
  }, [phase, refreshStatus, beacon]);

  // ── 交卷 ────────────────────────────────────────────────────

  const doSubmit = useCallback(
    async (auto: boolean) => {
      const id = attemptRef.current;
      if (!id || submitLock.current) return;
      submitLock.current = true;
      setSubmitting(true);
      setConfirming(false);
      try {
        // 先把未存的送出去。少了這一步，最後幾題（防抖還沒到期的那些）
        // 會在交卷之後才送到，而那時伺服器已經不收了。
        await flushRef.current();
        const res = await fetch(`/api/attempts/${id}/submit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ auto }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setNotice(body.error ?? `交卷失敗（${res.status}）`);
          if (res.status === 409) await handleClosed(body.error ?? '這份作答已經結束了');
          return;
        }
        setResult(body as SubmitResult);
        setPhase('submitted');
        if (auto) setNotice('時間到，系統已經幫你交卷。');
      } catch (e) {
        setNotice(
          `交卷沒有成功：${e instanceof Error ? e.message : String(e)}。` +
            `你的答案已經存在伺服器上，網路恢復後再按一次交卷。`,
        );
      } finally {
        submitLock.current = false;
        setSubmitting(false);
      }
    },
    [handleClosed],
  );

  /** 時間到自動交卷。判定仍在伺服器端，這裡只是不必讓學生自己按。 */
  useEffect(() => {
    if (phase !== 'taking' || left == null || left > 0) return;
    void doSubmit(true);
  }, [phase, left, doSubmit]);

  // ── 作答動作 ────────────────────────────────────────────────

  const questions = view?.questions ?? [];
  const q: TakeQuestion | undefined = questions[cur];

  const update = useCallback(
    (questionId: string, patch: Partial<AnswerState>) => {
      setAnswers((prev) => {
        const before = prev[questionId] ?? blank();
        const after = { ...before, ...patch };
        queue(questionId, after);
        return { ...prev, [questionId]: after };
      });
    },
    [queue],
  );

  const pick = useCallback(
    (question: TakeQuestion, key: number) => {
      if (phase !== 'taking') return;
      const cur0 = answers[question.questionId]?.answerKeys ?? [];
      const multi = question.type === 'MULTI_CHOICE';
      const next = multi
        ? cur0.includes(key)
          ? cur0.filter((k) => k !== key)
          : [...cur0, key].sort((a, b) => a - b)
        : cur0.length === 1 && cur0[0] === key
          ? [] // 再點一次取消。學生常常想把選了的清掉。
          : [key];
      update(question.questionId, { answerKeys: next });
    },
    [answers, phase, update],
  );

  // ── 鍵盤 ────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'taking') return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.isContentEditable || ['INPUT', 'TEXTAREA'].includes(t?.tagName ?? '')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const question = questions[cur];
      if (!question) return;

      if (/^[1-9]$/.test(e.key)) {
        const opt = question.options[Number(e.key) - 1];
        if (opt) {
          e.preventDefault();
          pick(question, opt.key);
        }
      } else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setCur((i) => Math.min(questions.length - 1, i + 1));
      } else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCur((i) => Math.max(0, i - 1));
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        update(question.questionId, {
          flagged: !(answers[question.questionId]?.flagged ?? false),
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, questions, cur, pick, update, answers]);

  // ── 畫面 ────────────────────────────────────────────────────

  if (phase === 'loading') {
    return (
      <main className="yz-panel">
        <Loading what="讀取任務" />
      </main>
    );
  }

  if (phase === 'error') {
    return (
      <main className="yz-panel">
        <ErrorBox
          title="開不了這份任務"
          detail={fatal}
          action={
            <>
              <Button onClick={() => void boot()}>再試一次</Button>
              <Link href="/take" className="yz-btn">
                回到任務清單
              </Link>
            </>
          }
        />
      </main>
    );
  }

  if (phase === 'brief') {
    // 直接貼網址進來的情況：這一份可能已經交完、還沒開放、或已經逾期。
    // 那時不該給一個按下去只會出現錯誤訊息的「開始作答」。
    const blocked =
      task && task.state !== 'OPEN'
        ? task.state === 'UPCOMING'
          ? `這份任務要到 ${fmtTime(task.openAt)} 才開放。`
          : task.state === 'MISSED'
            ? `這份任務已經在 ${fmtTime(task.dueAt)} 截止，而且沒有作答記錄。要補做請告訴老師。`
            : `這份任務你已經作答過了（${task.attemptsUsed} / ${task.maxAttempts} 次）。`
        : null;

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>{task?.title ?? '作答'}</h1>
          <p className="yz-panel__sub">
            {task?.subjectName}　·　{task?.questionCount} 題
            {task?.timeLimitMin ? `　·　限時 ${task.timeLimitMin} 分鐘` : ''}
          </p>
        </div>

        {fatal && <Note tone="error">{fatal}</Note>}

        {blocked ? (
          <Empty
            title="現在不能作答"
            hint={blocked}
            action={
              <Link href="/take" className="yz-btn yz-btn--primary">
                回到任務清單
              </Link>
            }
          />
        ) : (
        <div className="yz-card">
          <h2 className="yz-card__title">開始之前</h2>
          <ul className="yz-take__brief">
            {task?.timeLimitMin ? (
              <li>
                <b>按下開始就開始計時，時間到會自動交卷。</b>
                時間由伺服器計算，關掉頁面或換一台裝置都不會停止。
              </li>
            ) : (
              <li>這一份沒有時限，寫完再交。</li>
            )}
            {task?.dueAt && (
              <li>
                {fmtTime(task.dueAt)} 截止
                {task.allowLate ? '，之後仍可作答但會標記為遲交。' : '，之後就不能作答了。'}
              </li>
            )}
            <li>
              答案會自動存檔。中途關掉瀏覽器或斷線都不會遺失，回來時從中斷的地方繼續。
            </li>
            {task && task.maxAttempts > 1 && (
              <li>
                這一份可以作答 {task.maxAttempts} 次，你已經用掉 {task.attemptsUsed} 次。
              </li>
            )}
          </ul>

          <div className="yz-actions">
            <Button
              variant="primary"
              onClick={() => void start()}
              busy={starting}
              busyLabel="準備中…"
            >
              開始作答
            </Button>
            <Link href="/take" className="yz-btn yz-btn--quiet">
              先回清單
            </Link>
          </div>
        </div>
        )}
      </main>
    );
  }

  if (phase === 'submitted') {
    const answered = result?.answered ?? countAnswered(answers);
    const total = result?.total ?? questions.length;
    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>已交卷</h1>
          <p className="yz-panel__sub">
            {view?.assignmentTitle}
            {view?.submittedAt || result?.submittedAt
              ? `　·　${fmtTime(result?.submittedAt ?? view?.submittedAt ?? null)}`
              : ''}
          </p>
        </div>

        {notice && <Note>{notice}</Note>}
        {(result?.late ?? view?.late) && <Note tone="warn">這一份是逾期交卷，老師看得到。</Note>}

        <div className="yz-card">
          <h2 className="yz-card__title">
            作答 {answered} / {total} 題
          </h2>
          <p className="yz-panel__sub">
            成績與解析會依老師的設定開放，可能不是立刻。點下面那顆按鈕會告訴你
            現在看得到多少、還沒開放的話什麼時候開。
          </p>
          <div className="yz-actions">
            {/*
              一律給連結，不在這裡判斷開放了沒。這一頁的 `task` 是**交卷之前**
              抓的，它的放行狀態已經過期了——照著它決定要不要畫按鈕，
              交卷後立刻開放的那幾種設定會看不到入口。
              判斷留給檢討頁自己做，那邊的資料是當下的。
            */}
            <Link href={`/take/${assignmentId}/result`} className="yz-btn yz-btn--primary">
              看成績與檢討
            </Link>
            <Link href="/take" className="yz-btn">
              回到任務清單
            </Link>
          </div>
        </div>
      </main>
    );
  }

  // ── 作答中 ──────────────────────────────────────────────────

  const answeredCount = countAnswered(answers);
  const flaggedCount = Object.values(answers).filter((a) => a.flagged).length;
  const mine = q ? (answers[q.questionId] ?? blank()) : blank();

  return (
    <div className="yz-take">
      <header className="yz-take__bar">
        <span className="yz-take__title">{view?.assignmentTitle}</span>
        <span className="yz-take__count">
          已答 <b>{answeredCount}</b> / {questions.length}
          {flaggedCount > 0 && <span className="yz-take__flagn">待複查 {flaggedCount}</span>}
        </span>
        {left != null && (
          <span
            className={`yz-take__clock${left <= 300 ? ' yz-take__clock--soon' : ''}`}
            role="timer"
            aria-live="off"
            title="剩餘時間由伺服器計算"
          >
            {mmss(left)}
          </span>
        )}
        <span className="yz-take__save">
          {saving ? '存檔中…' : savedAt ? '已存檔' : ''}
        </span>
      </header>

      {notice && (
        <div className="yz-take__notice">
          <Note>{notice}</Note>
        </div>
      )}

      <nav className="yz-take__nav" aria-label="題目導覽">
        {questions.map((item, i) => {
          const a = answers[item.questionId] ?? blank();
          return (
            <button
              key={item.questionId}
              type="button"
              className={[
                'yz-take__num',
                i === cur ? 'yz-take__num--cur' : '',
                isAnswered(a) ? 'yz-take__num--done' : '',
                a.flagged ? 'yz-take__num--flag' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => setCur(i)}
              aria-current={i === cur ? 'true' : undefined}
              aria-label={`第 ${item.order} 題${isAnswered(a) ? '，已作答' : '，未作答'}${
                a.flagged ? '，已標記待複查' : ''
              }`}
            >
              {item.order}
            </button>
          );
        })}
      </nav>

      <main className="yz-take__body">
        {!q ? (
          <Empty title="這份卷子沒有題目" hint="請告訴老師。" />
        ) : (
          <article className="yz-take__q">
            {/*
              這一頁的內容是打開之後才從 API 拿的，伺服器端沒有東西可以先排，
              所以 KaTeX 在這裡跟著進 client bundle（components/Math.tsx 有
              為什麼划得來的說明）。作答中的學生看到的必須是排好的式子——
              考卷上印的是 H₂SO₄，畫面上是 `$\ce{H2SO4}$` 的話，
              光是對上題目就要花掉他的時間。
            */}
            {q.stimulus && (
              <div className="yz-take__stimulus">
                {q.stimulusLabel && <div className="yz-take__stimlabel">{q.stimulusLabel}</div>}
                <MathText>{q.stimulus}</MathText>
              </div>
            )}

            <div className="yz-take__head">
              <span className="yz-take__no">{q.order}</span>
              <span className="yz-take__score">{q.score} 分</span>
              <button
                type="button"
                className={`yz-take__flag${mine.flagged ? ' yz-take__flag--on' : ''}`}
                onClick={() => update(q.questionId, { flagged: !mine.flagged })}
                aria-pressed={mine.flagged}
              >
                {mine.flagged ? '已標記待複查' : '標記待複查'}
              </button>
            </div>

            <div className="yz-take__stem">
              {q.subLabel && <b>{q.subLabel}</b>}
              <MathText>{q.content}</MathText>
            </div>

            {q.options.length > 0 && (
              <div
                className="yz-take__opts"
                role={q.type === 'MULTI_CHOICE' ? 'group' : 'radiogroup'}
                aria-label="選項"
              >
                {q.options.map((o, i) => {
                  const picked = mine.answerKeys.includes(o.key);
                  return (
                    <div
                      key={o.key}
                      className={`yz-take__opt${picked ? ' yz-take__opt--picked' : ''}`}
                      role={q.type === 'MULTI_CHOICE' ? 'checkbox' : 'radio'}
                      aria-checked={picked}
                      tabIndex={0}
                      onClick={() => pick(q, o.key)}
                      onKeyDown={(e) => {
                        if (e.key === ' ' || e.key === 'Enter') {
                          e.preventDefault();
                          pick(q, o.key);
                        }
                      }}
                    >
                      <span className="yz-take__optkey">({o.label ?? i + 1})</span>
                      {/* 選項一定要排出來。物理的四個選項常常只差在向量箭頭
                          （$\vec{v}_1 + \vec{v}_2$ 對 $v_1 + v_2$），
                          原始碼狀態下那個差別要一個字一個字比。 */}
                      <span><MathText>{o.content}</MathText></span>
                    </div>
                  );
                })}
                {q.type === 'MULTI_CHOICE' && (
                  <p className="yz-take__hint">多選題，可以選多個。</p>
                )}
              </div>
            )}

            {q.slots && q.slots.length > 0 && (
              <div className="yz-take__slots">
                {q.slots.map((s, i) => (
                  <label key={i} className="yz-take__slot">
                    <span>{s.slot}</span>
                    <input
                      className="yz-in"
                      inputMode="text"
                      value={slotValue(mine.answerSlots, i)}
                      onChange={(e) =>
                        update(q.questionId, {
                          answerSlots: withSlot(mine.answerSlots, q.slots!, i, e.target.value),
                        })
                      }
                    />
                  </label>
                ))}
                <p className="yz-take__hint">選填題：一格填一個字元或數字。</p>
              </div>
            )}

            {needsText(q.type) && (
              <textarea
                className="yz-in yz-take__text"
                rows={q.type === 'ESSAY' ? 14 : 5}
                value={mine.answerText ?? ''}
                placeholder="在這裡作答"
                onChange={(e) => update(q.questionId, { answerText: e.target.value })}
              />
            )}

            {q.type === 'UNAVAILABLE' && (
              <Note tone="error">這一題讀不出來，請舉手告訴監考老師，不要在這裡浪費時間。</Note>
            )}
          </article>
        )}
      </main>

      <footer className="yz-take__foot">
        <Button
          variant="quiet"
          onClick={() => setCur((i) => Math.max(0, i - 1))}
          disabled={cur === 0}
        >
          上一題
        </Button>
        <Button
          variant="quiet"
          onClick={() => setCur((i) => Math.min(questions.length - 1, i + 1))}
          disabled={cur >= questions.length - 1}
        >
          下一題
        </Button>
        <span className="yz-take__spacer" />
        <Button variant="primary" onClick={() => setConfirming(true)} busy={submitting}>
          交卷
        </Button>
      </footer>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void doSubmit(false)}
        title="要交卷了嗎"
        confirmLabel="確定交卷"
        busy={submitting}
        consequence={
          <>
            {questions.length - answeredCount > 0 ? (
              <>
                還有 <b>{questions.length - answeredCount}</b> 題沒有作答
                {flaggedCount > 0 && <>，另外有 {flaggedCount} 題標記了待複查</>}。
              </>
            ) : (
              <>全部 {questions.length} 題都作答了。</>
            )}
            <br />
            交卷之後不能再修改答案。
          </>
        }
      />
    </div>
  );
}

/* ── 小工具 ─────────────────────────────────────────────────── */

function blank(): AnswerState {
  return { answerKeys: [], answerText: null, answerSlots: null, flagged: false };
}

/**
 * 有沒有作答。**標記待複查不算作答**——那只是一個提醒自己回來看的
 * 記號，把它算成已作答會讓學生以為自己寫完了。
 */
function isAnswered(a: AnswerState | undefined): boolean {
  if (!a) return false;
  if (a.answerKeys.length > 0) return true;
  if (a.answerText && a.answerText.trim() !== '') return true;
  if (a.answerSlots?.some((s) => s.value.trim() !== '')) return true;
  return false;
}

function countAnswered(all: Record<string, AnswerState>): number {
  return Object.values(all).filter(isAnswered).length;
}

function needsText(type: string): boolean {
  return ['FILL_TEXT', 'SHORT_ANSWER', 'ESSAY', 'TRANSLATION'].includes(type);
}

function slotValue(saved: { slot: string; value: string }[] | null, i: number): string {
  return saved?.[i]?.value ?? '';
}

function withSlot(
  saved: { slot: string; value: string }[] | null,
  slots: { slot: string }[],
  i: number,
  value: string,
): { slot: string; value: string }[] {
  const base = slots.map((s, j) => ({ slot: s.slot, value: saved?.[j]?.value ?? '' }));
  base[i] = { slot: slots[i].slot, value };
  return base;
}

function requeue(map: Map<string, Pending>, batch: Pending[]) {
  for (const item of batch) {
    // 已經有更新的版本就不要蓋回去。學生在送出失敗的那幾秒裡
    // 可能又改了同一題。
    if (!map.has(item.questionId)) map.set(item.questionId, item);
  }
}

/** 單調時鐘。`Date.now()` 會被使用者改系統時間影響，這一個不會。 */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}
