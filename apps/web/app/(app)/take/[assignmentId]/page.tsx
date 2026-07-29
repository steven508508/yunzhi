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
 *   · 送失敗的放回佇列重試，不清空、不打斷作答
 *   · 分頁被切掉或關掉時用 sendBeacon 送出未存的（beforeunload 在
 *     手機上不可靠，所以聽的是 pagehide 與 visibilitychange），
 *     **連正在飛的那一批一起送**——請求在飛的那幾秒佇列是空的，
 *     而分頁被系統回收時 catch 裡的 requeue 根本不會執行
 *   · 每一支 fetch 都有逾時。沒有逾時的請求在熱點網路上不會失敗，
 *     它會掛住，而「上一批還在飛」會擋掉之後所有的存檔
 *   · 重新整理不會遺失任何東西：答案在伺服器上，版面快照也在
 *
 * # 畫面說的每一句話都要是真的
 *
 * 這一頁最貴的一種 bug 不是當掉，是**安靜地說一件假話**。v0.21.0 的
 * 存檔指示器只在第一次成功時寫過一次「已存檔」，之後永遠掛著——
 * 於是斷線的學生看著「已存檔」，而佇列裡積著送不出去的答案。
 * 學生是照著那三個字決定要不要關掉分頁的。
 *
 * 所以現在：
 *
 *   · 存檔狀態是一台狀態機（lib/takeState.mjs 的 `saveIndicator`），
 *     送不出去時說得出「還有幾題沒送出去、重試了幾次、你現在該做什麼」，
 *     恢復之後自己回到「已存檔 09:12」
 *   · 伺服器每 30 秒的校時裡帶著它真正收到幾題，拿來跟本機比對
 *   · 交卷那一刻同時握著本機與伺服器兩個數字，**不一致就講重話**
 *   · 說「時間到會自動交卷」之前先確定那是真的：自動交卷會退避重試，
 *     而且校時發現逾期未交時也會補一刀。但它終究需要這個畫面開著，
 *     所以「開始之前」那一頁不再承諾學生可以提前關掉它
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
 * 剩五分鐘與剩一分鐘各主動提醒一次（震動 + 一條停留的橫幅，並列出
 * 還沒作答的題號）。倒數本身不閃爍的理由成立——慌不會讓人寫得比較快
 * ——但「不閃爍」與「不通知」是兩件事，而螢幕最上面 17px 的一個顏色
 * 變化，在低頭算題目的人眼裡等於沒發生。
 *
 * # 這是 client component，而且沒有伺服器端的資料
 *
 * 整頁靠 `/api/attempts/*` 取得資料。**正確答案不在任何一個回應裡**
 * （見 lib/attempt.ts 的 `loadAttemptForStudent`），所以開發者工具
 * 按開來也看不到答案——這比在畫面上藏起來重要得多。
 *
 * 同一個「省頻寬」的白名單有一個副作用：題組的素材只掛在第一小題上。
 * 那個決定是對的（一篇 500 字的閱讀素材不該在封包裡出現三次），
 * 但這一頁一次只畫一題，所以第 38 題要**自己往回找**同題組的素材
 * （`stimulusFor`）。檢討頁一次列出全部題目所以沒有症狀，這正是它
 * 不會在開發時被發現的原因。
 *
 * # 作答中是考試模式，不是一般頁面
 *
 * `phase === 'taking'` 時在 `<body>` 掛上 `data-yz-taking`，CSS 據此
 * 收掉全站導覽列。那一列在手機上把「登出」推成獨立的一整排、就在
 * 螢幕最頂端，而誤觸它的代價是重打一次密碼、而倒數不會停。
 * 同一個屬性也把捲動的連鎖關掉，擋掉隨時待發的下拉重新整理。
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { Empty, ErrorBox, Loading, Note } from '@/components/Feedback';
import { MathText } from '@/components/MathText';
import type { StudentTask, TakeQuestion, TakeView } from '@/lib/attempt';
import {
  answeredGap,
  FETCH_TIMEOUT_MS,
  groupRange,
  listUnanswered,
  saveIndicator,
  stimulusFor,
  submitCheck,
  submitRetryDelay,
  timeAlert,
} from '@/lib/takeState.mjs';

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

/**
 * 存檔的現況。**只在 flush 的起點與終點更新**——放進來的三個數字
 * 每一次按鍵都會變，而每一次按鍵重繪一次整份題目是划不來的。
 * 代價是重試中的題數最多晚 8 秒（保底輪詢的間隔）才更新，
 * 那個延遲不影響學生要做的事。
 */
type SaveInfo = {
  inFlight: boolean;
  pendingCount: number;
  failures: number;
  savedAt: Date | null;
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
  const [save, setSave] = useState<SaveInfo>({
    inFlight: false,
    pendingCount: 0,
    failures: 0,
    savedAt: null,
  });
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);

  // 待存佇列。用 ref 而不是 state：它每一次按鍵都會變，
  // 而它的內容不影響畫面——放進 state 只會多一堆重繪。
  const pending = useRef<Map<string, Pending>>(new Map());
  // 正在飛的那一批。**佇列在送出之前就被清空了**（失敗才放回去），
  // 所以請求在網路上的那幾秒 `pending` 是空的，beacon 涵蓋不到它。
  // 分頁在那個窗口被系統回收，那一批就沒了——而在熱點網路上，
  // 那個窗口不是 1.2 秒，是一個請求的完整往返。
  const inFlightBatch = useRef<Pending[]>([]);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 正在飛的那一次 flush。等它而不是早退，見 `flush`。 */
  const inFlight = useRef<Promise<void> | null>(null);
  const submitLock = useRef(false);
  const attemptId = view?.attemptId ?? null;
  const attemptRef = useRef<string | null>(null);
  attemptRef.current = attemptId;
  const answersRef = useRef<Record<string, AnswerState>>({});
  answersRef.current = answers;

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
      const res = await fetchT(`/api/attempts?assignmentId=${encodeURIComponent(assignmentId)}`, {
        timeoutMs: FETCH_TIMEOUT_MS.load,
      });
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
        const r2 = await fetchT(`/api/attempts/${t.openAttemptId}?full=1`, {
          timeoutMs: FETCH_TIMEOUT_MS.load,
        });
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
      setFatal(`連不上伺服器：${netMessage(e)}`);
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
      const res = await fetchT('/api/attempts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assignmentId }),
        timeoutMs: FETCH_TIMEOUT_MS.load,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFatal(body.error ?? `無法開始作答（${res.status}）`);
        return;
      }
      enterView(body as TakeView);
    } catch (e) {
      setFatal(`連不上伺服器：${netMessage(e)}`);
    } finally {
      setStarting(false);
    }
  }, [assignmentId, enterView, starting]);

  // ── 存檔 ────────────────────────────────────────────────────

  /** 伺服器說這份已經不能再寫了（時間到、已交卷、不是你的）。 */
  const handleClosed = useCallback(
    async (message: string) => {
      pending.current.clear();
      inFlightBatch.current = [];
      setNotice(message);
      const id = attemptRef.current;
      if (!id) {
        setPhase('submitted');
        return;
      }
      const res = await fetchT(`/api/attempts/${id}?full=1`, {
        timeoutMs: FETCH_TIMEOUT_MS.load,
      }).catch(() => null);
      const body = await res?.json().catch(() => null);
      if (res?.ok && body) enterView(body as TakeView);
      else setPhase('submitted');
    },
    [enterView],
  );

  /** 真正送出一批。`inFlight` 由 `flush` 管，這裡不碰。 */
  const flushOnce = useCallback(async () => {
    const id = attemptRef.current;
    if (!id) return;

    const batch = [...pending.current.values()];
    pending.current.clear();
    inFlightBatch.current = batch;
    setSave((s) => ({ ...s, inFlight: true, pendingCount: batch.length }));
    try {
      const res = await fetchT(`/api/attempts/${id}/answers`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers: batch }),
        timeoutMs: FETCH_TIMEOUT_MS.save,
      });
      const body = await res.json().catch(() => ({}));

      if (res.ok) {
        inFlightBatch.current = [];
        // 失敗次數歸零：畫面要能從「送不出去」回到「已存檔 09:12」，
        // 否則學生會在網路恢復之後繼續看著紅字。
        setSave({
          inFlight: false,
          pendingCount: pending.current.size,
          failures: 0,
          savedAt: new Date(),
        });
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
        inFlightBatch.current = [];
        setSave((s) => ({ ...s, inFlight: false, pendingCount: 0, failures: 0 }));
        await handleClosed(body.error ?? '這份作答已經結束了');
        return;
      }
      // 其他失敗（多半是網路或伺服器暫時性的）：放回佇列，下一輪再試。
      // **不跳對話框打斷他作答**，但狀態列與題目區上方要看得出來——
      // 什麼都不說的代價是學生自己去按重新整理。
      requeue(pending.current, batch);
      inFlightBatch.current = [];
      setSave((s) => ({
        inFlight: false,
        pendingCount: pending.current.size,
        failures: s.failures + 1,
        savedAt: s.savedAt,
      }));
    } catch {
      requeue(pending.current, batch);
      inFlightBatch.current = [];
      setSave((s) => ({
        inFlight: false,
        pendingCount: pending.current.size,
        failures: s.failures + 1,
        savedAt: s.savedAt,
      }));
    }
  }, [handleClosed, syncClock]);

  const flushOnceRef = useRef(flushOnce);
  flushOnceRef.current = flushOnce;

  /**
   * 送出待存佇列。
   *
   * **上一批還在飛時要等它，不可以早退。** 早退的那個版本有一個會靜靜
   * 掉答案的洞：交卷前的 `await flush()` 剛好碰上一批在飛時什麼都不做，
   * 然後 POST /submit 出去與那一批在網路上賽跑——而伺服器對交卷之後
   * 才到的 PATCH 一律 409。最後幾題就這樣掉了，沒有任何一方會知道。
   */
  const flush = useCallback(async () => {
    // 最多繞三圈：等上一批 → 送這一批 → 再確認一次佇列真的空了。
    // 等待期間別人（防抖或保底輪詢）可能已經接手下一批，那就再等一次；
    // 但不能為了追永遠有新東西的佇列而不回來——呼叫端在等著交卷。
    for (let round = 0; round < 3; round++) {
      const prev = inFlight.current;
      if (prev) {
        await prev.catch(() => {});
        continue;
      }
      if (pending.current.size === 0) return;
      const p = flushOnceRef.current();
      inFlight.current = p;
      try {
        await p;
      } finally {
        if (inFlight.current === p) inFlight.current = null;
      }
    }
  }, []);

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
   * （伺服器端是 upsert）。丟掉才是不可回復的。同一個理由，
   * 正在飛的那一批也一起送——它有沒有到伺服器，這裡不知道。
   */
  const beacon = useCallback(() => {
    const id = attemptRef.current;
    if (!id) return;
    const merged = new Map<string, Pending>();
    for (const item of inFlightBatch.current) merged.set(item.questionId, item);
    // 佇列裡的比較新（同一題重寫過），所以放在後面覆蓋。
    for (const [k, v] of pending.current) merged.set(k, v);
    if (merged.size === 0) return;
    const payload = JSON.stringify({ answers: [...merged.values()] });
    navigator.sendBeacon?.(
      `/api/attempts/${id}/answers`,
      new Blob([payload], { type: 'application/json' }),
    );
  }, []);

  // ── 校時 ────────────────────────────────────────────────────

  /** 自動交卷（含退避重試）。定義在下面，這裡先留一個把手給校時用。 */
  const autoSubmitRef = useRef<() => void>(() => {});

  const refreshStatus = useCallback(async () => {
    const id = attemptRef.current;
    if (!id) return;
    try {
      const res = await fetchT(`/api/attempts/${id}`, { timeoutMs: FETCH_TIMEOUT_MS.status });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return;
      syncClock(body.remainingSeconds);
      if (body.status && body.status !== 'IN_PROGRESS') {
        await handleClosed(
          body.autoSubmitted ? '時間到，系統已經幫你交卷。' : '這份作答已經交出去了。',
        );
        return;
      }
      // 時間到了而伺服器上還是 IN_PROGRESS：主動交卷。
      // 這條路不依賴倒數那個 effect 的相依比對（`left` 歸零後恆為 0，
      // React 用 Object.is 比對 → effect 不會重跑），所以網路一恢復
      // 就會自己收掉。舊版要靠「待存佇列裡剛好有東西」才收得掉，
      // 兩個一樣斷線的學生會得到不一樣的結果。
      if (body.remainingSeconds === 0) {
        autoSubmitRef.current();
        return;
      }
      // 伺服器每 30 秒就送來它真正收到幾題，舊版收到之後直接丟掉。
      // 一場 60 分鐘的考試有 120 次機會說出「你以為寫了 13 題，
      // 伺服器上只有 9 題」，而它一次都沒用。
      const gap = answeredGap({
        local: countAnswered(answersRef.current),
        server: body.answered,
        pendingCount: pending.current.size,
      });
      if (gap.kind === 'lost' && gap.detail) setNotice(gap.detail);
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
    async (auto: boolean): Promise<boolean> => {
      const id = attemptRef.current;
      if (!id || submitLock.current) return false;
      submitLock.current = true;
      setSubmitting(true);
      setConfirming(false);
      try {
        // 先把未存的送出去。少了這一步，最後幾題（防抖還沒到期的那些）
        // 會在交卷之後才送到，而那時伺服器已經不收了。
        await flushRef.current();
        // flush 之後還留在佇列裡的，就是真的沒送出去的。
        // 舊版無條件寫死「你的答案已經存在伺服器上」，而那句話出現的
        // 唯一情境正是它最可能為假的情境。
        const stuck = pending.current.size;
        const res = await fetchT(`/api/attempts/${id}/submit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ auto }),
          timeoutMs: FETCH_TIMEOUT_MS.submit,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 409) {
            await handleClosed(body.error ?? '這份作答已經結束了');
            return true;
          }
          setNotice(submitFailNote(body.error ?? `交卷失敗（${res.status}）`, stuck, auto));
          return false;
        }
        setResult(body as SubmitResult);
        setNotice(auto ? '時間到，系統已經幫你交卷。' : null);
        setPhase('submitted');
        return true;
      } catch (e) {
        setNotice(submitFailNote(netMessage(e), pending.current.size, auto));
        return false;
      } finally {
        submitLock.current = false;
        setSubmitting(false);
      }
    },
    [handleClosed],
  );

  /**
   * 時間到的自動交卷。
   *
   * 舊版只試一次：那個 effect 的相依是 `left`，而 `Math.max(0, …)`
   * 之後恆為 0，React 用 `Object.is` 比對 → effect 不重跑。於是倒數
   * 走到 00:00 那一刻剛好在收訊死角的學生，卷子就永遠停在 IN_PROGRESS
   * ——他的成績單上什麼都沒有，而老師端找不到是哪一份。
   *
   * `submitAttempt` 是冪等的（compare-and-set），所以重試完全安全。
   * 退避 5s / 15s / 30s / 60s，**不設上限**：放棄的代價是一整份成績。
   */
  const autoRetry = useRef<{ timer: ReturnType<typeof setTimeout> | null; failures: number }>({
    timer: null,
    failures: 0,
  });

  const autoSubmit = useCallback(() => {
    void (async () => {
      const st = autoRetry.current;
      const ok = await doSubmit(true);
      if (ok) {
        if (st.timer) clearTimeout(st.timer);
        st.timer = null;
        return;
      }
      st.failures += 1;
      const delay = submitRetryDelay(st.failures);
      if (delay == null) return;
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(() => {
        st.timer = null;
        autoSubmitRef.current();
      }, delay);
    })();
  }, [doSubmit]);
  autoSubmitRef.current = autoSubmit;

  useEffect(() => {
    if (phase !== 'taking' || left == null || left > 0) return;
    autoSubmitRef.current();
  }, [phase, left]);

  useEffect(
    () => () => {
      if (autoRetry.current.timer) clearTimeout(autoRetry.current.timer);
    },
    [],
  );

  // ── 作答動作 ────────────────────────────────────────────────

  const questions = useMemo(() => view?.questions ?? [], [view]);
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

  /**
   * 換題。**捲動位置一定要回到頂端**——不重設的話，按「下一題」會落在
   * 下一題的選項中間（每一題的高度不同，落點也不同），而學生分不出
   * 「這一題沒有題幹」與「題幹在上面看不到的地方」。25 題就是 25 次。
   */
  const goto = useCallback((i: number) => {
    setCur(i);
    document.querySelector('.yz-shell__main')?.scrollTo({ top: 0 });
  }, []);

  const navRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // 題號欄在手機上是一排橫捲的方格（25 格 × 44px 排不進 390px）。
    // 換題時把目前這一格捲進視野，否則第 18 題之後那一排看起來
    // 停在第 7 題不動。
    navRef.current?.querySelector('.yz-take__num--cur')?.scrollIntoView({
      block: 'nearest',
      inline: 'center',
    });
  }, [cur]);

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
        goto(Math.min(questions.length - 1, cur + 1));
      } else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'k') {
        e.preventDefault();
        goto(Math.max(0, cur - 1));
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        update(question.questionId, {
          flagged: !(answers[question.questionId]?.flagged ?? false),
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, questions, cur, pick, update, answers, goto]);

  // ── 考試模式 ────────────────────────────────────────────────

  /**
   * 作答中把全站導覽列收起來（CSS 在 globals.css 最末尾）。
   *
   * 那一列在手機上把「登出」推成獨立的一整排、就在螢幕最頂端，
   * 而學生伸手去拉狀態列或滑掉通知時按到的就是它。誤觸的代價是
   * 重打一次 10 碼的密碼、重新進來，而倒數不會停——2 到 4 分鐘。
   * 考試畫面本來就該是一個沒有出口的畫面。
   */
  useEffect(() => {
    if (phase !== 'taking') return;
    document.body.setAttribute('data-yz-taking', '1');
    return () => document.body.removeAttribute('data-yz-taking');
  }, [phase]);

  // ── 剩餘時間的提醒 ──────────────────────────────────────────

  const lastLeft = useRef<number | null>(null);
  const alerted = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (phase !== 'taking') return;
    const prev = lastLeft.current;
    lastLeft.current = left;
    const hit = timeAlert(prev, left);
    if (!hit || alerted.current.has(hit.threshold)) return;
    alerted.current.add(hit.threshold);

    const rest = listUnanswered(
      questions.map((x) => ({ order: x.order, answered: isAnswered(answersRef.current[x.questionId]) })),
    );
    // 訊息用真正的秒數而不是門檻。續考的人一進來可能就只剩 3 分 20 秒，
    // 那時說「剩下 5 分鐘」是假話。
    setNotice(
      `剩下不到 ${hit.minutes} 分鐘（${mmss(left ?? 0)}）。` +
        (rest.count > 0
          ? `還有 ${rest.count} 題沒有作答：${rest.text}。`
          : '所有題目都作答了，可以回頭看標記待複查的那幾題。'),
    );
    // 一次性的震動。持續閃爍會讓人慌，而慌不會讓人寫得比較快。
    navigator.vibrate?.(200);
  }, [phase, left, questions]);

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
          {/*
            這幾句話學生會照著做，所以每一句都必須是真的。
            v0.21.0 之前這裡用粗體保證「時間到會自動交卷」與
            「中途關掉瀏覽器或斷線都不會遺失」，而伺服器沒有排程收卷、
            關掉的分頁也送不出佇列裡的答案。學生讀到那兩句之後在
            剩五分鐘、手機剩 3% 電的時候關掉螢幕，卷子停在進行中，
            成績單上什麼都沒有。
          */}
          <ul className="yz-take__brief">
            {task?.timeLimitMin ? (
              <>
                <li>
                  <b>按下開始就開始計時。</b>
                  時間由伺服器計算，換一台裝置繼續寫也不會重新算。
                </li>
                <li>
                  <b>時間到了系統會在這個畫面上自動交卷，所以請不要提前關掉它。</b>
                  交完會出現「已交卷」三個字，看到才算數；沒看到就舉手告訴監考老師。
                </li>
              </>
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
              答案邊寫邊自動存檔，存好的那些換一台裝置也回得來。狀態列右上角會顯示
              存檔狀況——出現硃砂色的「未送出 N 題」就表示還有幾題沒送到伺服器，
              那時候不要關掉或重新整理畫面。
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
    const localAnswered = countAnswered(answers);
    const total = result?.total ?? questions.length;
    const answered = result?.answered ?? localAnswered;
    // 交卷那一刻系統同時握著兩個數字：學生以為寫了幾題、伺服器真的
    // 收到幾題。舊版把兩者並列在畫面上而不比較，於是「我的成績不見了」
    // 要到隔天檢討頁才會被發現，那時已經無法舉證。
    const check = submitCheck({ local: localAnswered, server: result?.answered ?? null, total });
    const blanks = listUnanswered(
      questions.map((x) => ({ order: x.order, answered: isAnswered(answers[x.questionId]) })),
    );
    // 「交出去了」與「還沒」必須分得出來。handleClosed 在讀不回作答時
    // 也會走到這個 phase，那時我們其實不知道伺服器收了沒。
    const confirmed = result != null || (view != null && view.status !== 'IN_PROGRESS');

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>{confirmed ? '已交卷' : '作答已結束'}</h1>
          <p className="yz-panel__sub">
            {view?.assignmentTitle}
            {view?.submittedAt || result?.submittedAt
              ? `　·　${fmtTime(result?.submittedAt ?? view?.submittedAt ?? null)}`
              : ''}
          </p>
        </div>

        {check.kind === 'mismatch' && (
          <Note tone="error">
            你在這台裝置上作答了 <b>{check.local}</b> 題，但伺服器只收到{' '}
            <b>{check.server}</b> 題，差了 {check.missing} 題。
            請立刻舉手告訴監考老師，先不要關掉這一頁。
          </Note>
        )}

        {!confirmed && (
          <Note tone="error">
            系統還沒有確認這份卷子交出去了沒有。請不要關掉這一頁，
            並舉手告訴監考老師。
          </Note>
        )}

        {notice && <Note>{notice}</Note>}
        {(result?.late ?? view?.late) && <Note tone="warn">這一份是逾期交卷，老師看得到。</Note>}

        {confirmed && (
          <div className="yz-card yz-take__done">
            <p className="yz-take__donemark">已送出</p>
            <p className="yz-take__donesub">
              這份考卷已經交到伺服器上，老師那邊看得到了。可以離開這個畫面。
            </p>
          </div>
        )}

        <div className="yz-card">
          <h2 className={`yz-card__title${answered < total ? ' yz-take__short' : ''}`}>
            伺服器收到 {answered} / {total} 題
          </h2>
          {blanks.count > 0 && (
            <p className="yz-panel__sub">沒有作答的題號：{blanks.text}。</p>
          )}
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
  const indicator = saveIndicator({
    inFlight: save.inFlight,
    pendingCount: save.pendingCount,
    failures: save.failures,
    savedAtLabel: save.savedAt ? hhmm(save.savedAt) : null,
  });
  // 題組的素材只掛在第一小題上（省頻寬，見 lib/attempt.ts），
  // 所以第 2、3 小題要自己往回找，否則畫面上只剩「則最大利潤為多少？」。
  const stim = q ? stimulusFor(questions, cur) : null;
  const range = q ? groupRange(questions, cur) : null;
  // 附圖的網址前綴。綁在**這一份作答**上而不是題目上：伺服器端據此
  // 判斷「這是不是你自己那一份，而且現在該讓你看」（app/api/assets）。
  // 少了 attempt 這一段，學生會走到老師那條路然後一律 403——症狀是
  // 每一張圖都變成「你不是這一科的授課老師」，在考試中。
  const figureBase = `/api/assets?attempt=${encodeURIComponent(view?.attemptId ?? '')}&key=`;

  return (
    <div className="yz-take">
      {/*
        狀態列、警示、題號欄合成一塊黏著的區域。分開黏的話，題號欄會
        捲走（學生標了第 4、9 題待複查，寫完第 25 題想回去看，就得先
        捲到最上面），而警示會在學生做出任何反應之前就被正常的閱讀
        動作捲掉——那是這一頁唯一會講重話的地方。
      */}
      <div className="yz-take__top">
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
          {/* 存檔狀態不用 aria-live：它每幾秒就在「存檔中…」與
              「已存檔 09:12」之間切換一次，讀出來只是噪音。
              真正要讀的是下面那條 role="alert" 的警示。 */}
          <span
            className={`yz-take__save${indicator.urgent ? ' yz-take__save--bad' : ''}`}
            aria-live="off"
          >
            {indicator.label}
          </span>
        </header>

        {/* 警示黏在狀態列下面，但再多也不可以吃掉半個螢幕——超過就
            自己捲（CSS 在 globals.css 最末尾）。學生要看的是題目。 */}
        <div className="yz-take__alerts">
          {indicator.detail && (
            <div className="yz-take__notice">
              <Note tone="error">{indicator.detail}</Note>
            </div>
          )}

          {notice && (
            <div className="yz-take__notice">
              <Note>{notice}</Note>
              <button
                type="button"
                className="yz-take__noticex"
                onClick={() => setNotice(null)}
              >
                我知道了
              </button>
            </div>
          )}
        </div>

        <nav className="yz-take__nav" aria-label="題目導覽" ref={navRef}>
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
                onClick={() => goto(i)}
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
      </div>

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
            {stim && (
              <div className="yz-take__stimulus">
                <div className="yz-take__stimlabel">
                  {stim.label ?? '題組題幹'}
                  {range && `　·　第 ${range.from}–${range.to} 題共用`}
                </div>
                {/* 題組共用的附圖**這裡拿不到**：`lib/attempt.ts` 的白名單
                    只帶 `group.stimulus`，沒有 `group.stimulusAssets`
                    （那個 select 是「不可以洩題」那條規則的所在地，
                    加欄位要由那一支自己決定）。實驗裝置圖掛在題組上的
                    卷子會在這裡缺圖，缺口記在這裡而不是靜靜地漏掉。 */}
                <MathText>{stim.stimulus}</MathText>
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
              {/* 附圖走 `/api/assets?attempt=…`：那一支問的是「這是不是你
                  自己那一份，而且現在該讓你看」。學生沒有科目授課權，
                  走不到老師那條路。 */}
              <MathText assets={q.contentAssets} assetBase={figureBase} label={`第 ${q.order} 題`}>
                {q.content}
              </MathText>
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
                      <span className="yz-take__optbody">
                        <MathText
                          assets={o.assets}
                          assetBase={figureBase}
                          label={`第 ${q.order} 題選項 ${o.label ?? i + 1}`}
                        >
                          {o.content}
                        </MathText>
                      </span>
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
        <Button variant="quiet" onClick={() => goto(Math.max(0, cur - 1))} disabled={cur === 0}>
          上一題
        </Button>
        <Button
          variant="quiet"
          onClick={() => goto(Math.min(questions.length - 1, cur + 1))}
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
                還有 <b>{questions.length - answeredCount}</b> 題沒有作答（
                {
                  listUnanswered(
                    questions.map((x) => ({
                      order: x.order,
                      answered: isAnswered(answers[x.questionId]),
                    })),
                  ).text
                }
                ）
                {flaggedCount > 0 && <>，另外有 {flaggedCount} 題標記了待複查</>}。
              </>
            ) : (
              <>全部 {questions.length} 題都作答了。</>
            )}
            <br />
            {/* 佇列的真實長度讀 ref：`save` 只在 flush 的起訖更新，
                而學生按下交卷的那一刻往往剛改完最後一題。 */}
            {pending.current.size > 0 && (
              <>
                <b>還有 {pending.current.size} 題沒有送到伺服器，交卷前會再送一次。</b>
                <br />
              </>
            )}
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

/**
 * 帶逾時的 fetch。
 *
 * 沒有逾時的請求在訊號飄的熱點上**不會失敗，它會掛住**（TCP 一路重傳，
 * 可以掛 60 秒）。而掛住的那段時間裡，保底輪詢每次都因為「上一批還在飛」
 * 而早退——什麼都不會進到伺服器，畫面上卻與正常存檔的 0.3 秒長得一樣。
 *
 * 用 AbortController 而不是 `AbortSignal.timeout`：後者在較舊的
 * Android WebView 上沒有，而補習班的自備裝置什麼版本都有。
 */
async function fetchT(
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const ctl = new AbortController();
  const timer = setTimeout(
    () => ctl.abort(new DOMException('連線逾時', 'TimeoutError')),
    timeoutMs,
  );
  try {
    return await fetch(url, { ...rest, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function netMessage(e: unknown): string {
  if (e instanceof DOMException && e.name === 'TimeoutError') return '連線逾時';
  return e instanceof Error ? e.message : String(e);
}

/**
 * 交卷失敗時該說哪一句話。
 *
 * 舊版無條件寫死「你的答案已經存在伺服器上」——而這句話出現的唯一
 * 情境（網路斷了）正是它最可能為假的情境：`flush` 自己 catch、
 * 自己 requeue，於是答案還在佇列裡，畫面卻說它在伺服器上。
 *
 * 所以先看佇列，再決定要講哪一句；而自動交卷失敗要先講「時間到了」，
 * 因為學生此刻正準備站起來走人。
 */
function submitFailNote(reason: string, stuck: number, auto: boolean): string {
  const head = auto
    ? '時間已經到了，這份卷子寫不進去了。系統會持續嘗試交卷，請不要關掉這個畫面。'
    : `交卷沒有成功：${reason}。`;
  const body =
    stuck > 0
      ? `還有 ${stuck} 題沒有存到伺服器。請不要關掉這一頁——網路恢復後系統會自動補送，` +
        '然後再按一次交卷。現在請舉手告訴監考老師。'
      : '你寫的都已經存到伺服器了，只差交卷這個動作。網路恢復後再按一次交卷。';
  return `${head}${body}`;
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

/** 存檔時刻。只寫「已存檔」的話，四十分鐘前存的與三秒前存的長得一樣。 */
function hhmm(d: Date): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
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
