'use client';

/**
 * 匯入進度。
 *
 * 這一頁的存在理由不是「好看」，而是回答老師唯一在意的兩個問題：
 * **還要多久**，以及**出事了我能怎麼辦**。
 *
 * 所以：
 *   · 每一階段顯示實際花掉的時間，而不是假的百分比進度條
 *   · 失敗時直接說明是什麼問題、能不能續跑、以及從哪裡續
 *   · 不可重試的錯誤不給「重試」按鈕，給的是「怎麼修」
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export type StageInfo = {
  key: string;
  label: string;
  state: 'done' | 'running' | 'pending' | 'failed';
  elapsedMs?: number;
  note?: string;
};

export type ProgressData = {
  jobId: string;
  title: string;
  subjectName: string;
  status: string;
  /** 建立時刻（ISO）。用來判斷「排隊排太久了」，見下面的 `stuckInQueue`。 */
  createdAt: string;
  /** 目前這一階段的開始時刻（ISO）。進行中的那一列靠它算「已經幾分幾秒」。 */
  stageStartedAt: string | null;
  /** 佇列裡排在前面的份數，以及現在有沒有別的工作在跑。 */
  queuedAhead: number;
  othersRunning: number;
  error: string | null;
  permanent: boolean;
  lastCompletedStage: string | null;
  stages: StageInfo[];
  totalPages: number | null;
  totalCandidates: number;
  aiCostTwd: number;
  attemptCount: number;
  files: { fileName: string; role: string; qualityNote: string | null }[];
};

function duration(ms?: number) {
  if (!ms) return '';
  if (ms < 1000) return `${ms} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

const GLYPH: Record<StageInfo['state'], string> = {
  done: '✓',
  running: '·',
  pending: '',
  failed: '×',
};

/**
 * 這種規模大概要跑多久。
 *
 * 沒有任何一句「還要多久」的畫面，等待就沒有盡頭：36 頁的題本在
 * 版面切分那一階段會**包成一個請求**送出去，那一列可能單獨停十分鐘
 * 不動，而它正好是沒有時間可以顯示的那一列。
 *
 * 一個粗估好過沒有。數字取自管線的實際批次大小（`import-pipeline.mjs`：
 * 版面切分整份一次、自答每 20 題一次、標註每 25 題一次）。
 */
function eta(pages: number | null, candidates: number) {
  if (!pages && !candidates) return null;
  const p = pages ?? 0;
  const q = candidates || Math.round(p * 1.4);
  const lo = Math.max(3, Math.round(p * 0.15 + q * 0.06));
  const hi = Math.max(lo + 4, Math.round(p * 0.4 + q * 0.2));
  return `這種規模的題本通常要 ${lo}–${hi} 分鐘`;
}

export default function Progress({ initial }: { initial: ProgressData }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [acting, setActing] = useState(false);
  const [actError, setActError] = useState<string | null>(null);
  // 每秒跳一次，讓進行中的那一列的計時器會動。**會動本身就是訊息**
  // ——一個不動的畫面看起來就是當掉了。
  const [now, setNow] = useState(() => Date.now());

  const finished = ['READY_FOR_REVIEW', 'COMMITTED', 'FAILED'].includes(data.status);

  useEffect(() => {
    if (finished) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [finished]);

  const runningMs = data.stageStartedAt
    ? Math.max(0, now - new Date(data.stageStartedAt).getTime())
    : 0;

  /**
   * 排隊排太久了。
   *
   * QUEUED 的意思是「已經丟進佇列，等工作者來拿」。工作者沒起來、
   * 或 Redis 連不上的時候，這個狀態會維持到永遠：**沒有錯誤、
   * 沒有失敗、進度條上六個階段全部是灰的**，而畫面下方寫著
   * 「解析在背景進行，離開這一頁也不會中斷」。老師會等一個下午。
   *
   * 卡住偵測（worker 的 detect-stuck-imports）救不了這一種，因為
   * 它自己就跑在同一個工作者裡——工作者沒起來，偵測也沒跑。
   * 所以出口必須在畫面上。
   *
   * 兩分鐘是刻意的：正常情況下工作者幾秒內就會把狀態推到
   * NORMALIZING，兩分鐘還在排隊已經不正常了。而重新排隊這個動作
   * 不花任何 AI 費用（一個階段都還沒跑），所以門檻不必訂得很高。
   */
  //
  // **前面有人在排隊或在跑就不算卡住。** 舊版只看「QUEUED 超過兩分鐘」，
  // 完全沒看佇列裡前面有沒有人——而 `IMPORT_CONCURRENCY` 預設是 1，
  // 第二份題本本來就要等第一份跑完整條管線。第六次匯入時最痛：
  // 前面五份排著，第六份從第一分鐘起就被告知系統壞了。
  const waiting = data.queuedAhead > 0 || data.othersRunning > 0;
  const stuckInQueue =
    data.status === 'QUEUED' &&
    !waiting &&
    Date.now() - new Date(data.createdAt).getTime() > 120_000;

  // 輪詢而非 SSE。
  //
  // 這一頁的更新頻率是「幾十秒一次」，而學生的網路是熱點分享
  // （訪談第 17 題）——為了這種更新頻率維持一條長連線並不划算，
  // 而且長連線在網路切換時的重連邏輯是額外的一整類 bug。
  useEffect(() => {
    if (finished) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/import/${data.jobId}/status`, { cache: 'no-store' });
        if (!res.ok) return;
        const next: ProgressData = await res.json();
        setData(next);
        // 解析完就自己跳到校對介面，不必老師再點一次。
        if (next.status === 'READY_FOR_REVIEW') router.refresh();
      } catch {
        // 網路瞬斷不必顯示錯誤，下一次輪詢會補上。
      }
    }, 5000);
    return () => clearInterval(t);
  }, [data.jobId, finished, router]);

  async function act(resume: boolean) {
    setActing(true);
    setActError(null);
    try {
      const res = await fetch(`/api/import/${data.jobId}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resume }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      // **失敗一定要說出來。** 原本這裡只有 `if (res.ok) refresh()`，
      // 於是「正在處理中，不給重跑」「佇列連不上」這幾種回應在畫面上
      // 完全沒有痕跡——老師按了按鈕，什麼都沒發生，然後再按一次。
      const body = await res.json().catch(() => null);
      setActError(body?.error ?? `重跑失敗（${res.status}）`);
    } catch (e) {
      setActError(`連不上伺服器：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="yz-panel" style={{ maxWidth: 680, margin: '0 auto' }}>
      <div className="yz-panel__head">
        <h1 style={{ fontFamily: 'var(--font-doc)', fontSize: 17, fontWeight: 600 }}>
          {data.title}
        </h1>
        <p style={{ color: 'var(--ink-2)', marginTop: 4, fontSize: 12.5 }}>
          {data.subjectName}
          {data.totalPages ? `　共 ${data.totalPages} 頁` : ''}
          {data.totalCandidates ? `　已抽出 ${data.totalCandidates} 題` : ''}
          {data.attemptCount > 1 ? `　第 ${data.attemptCount} 次嘗試` : ''}
        </p>
      </div>

      <section className="yz-fieldset">
        <ol className="yz-steps">
          {data.stages.map((s) => (
            <li key={s.key} className={`yz-step yz-step--${s.state}`}>
              <span className="yz-step__glyph" aria-hidden>
                {GLYPH[s.state]}
              </span>
              <span>
                {s.label}
                {s.state === 'running' && (
                  <span style={{ color: 'var(--ink-3)', marginLeft: 8, fontSize: 12 }}>
                    進行中…
                  </span>
                )}
                {s.note && <div className="yz-step__note">{s.note}</div>}
              </span>
              {/* 進行中的那一列顯示「已經跑了多久」。舊版這一格永遠是空的
                  ——elapsedMs 只有階段做完之後才寫進去，而老師盯的正是
                  還沒做完的那一列。 */}
              <span className={`yz-step__time${s.state === 'running' ? ' yz-step__time--live' : ''}`}>
                {s.state === 'running' && runningMs
                  ? `已經 ${duration(runningMs)}`
                  : duration(s.elapsedMs)}
              </span>
            </li>
          ))}
        </ol>

        {!finished && (
          <p style={{ marginTop: 12, fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.75 }}>
            {data.status === 'QUEUED' && waiting
              ? `前面還有 ${data.queuedAhead + data.othersRunning} 份題本在處理，` +
                '這一份會排在它們後面。一次只跑一份，是為了不讓 AI 費用與記憶體同時爆掉。'
              : eta(data.totalPages, data.totalCandidates)}
          </p>
        )}

        {data.aiCostTwd > 0 && (
          <p style={{ marginTop: 12, fontSize: 12, color: 'var(--ink-3)' }}>
            這份題本目前的 AI 成本約 NT${data.aiCostTwd.toFixed(2)}（估算值，非帳單）
          </p>
        )}
      </section>

      {data.error && (
        <section className="yz-fieldset yz-fieldset--warn">
          <p style={{ color: 'var(--mark)', fontSize: 13, lineHeight: 1.7 }}>{data.error}</p>

          {/* **不可重試的錯誤不給重試按鈕。** `permanent` 一直都算好也
              傳過來了，只是沒有人讀它——於是老師照著兩顆比文字大聲的
              按鈕點下去，失敗，再點另一顆，再失敗。 */}
          {data.permanent ? (
            <p className="yz-hint" style={{ marginTop: 10, lineHeight: 1.8 }}>
              這一類問題重跑沒有幫助，要先把上面說的東西改掉。
              最常見的是<strong>檔案角色猜錯</strong>：檔名裡有「詳解」「答案」的檔案會被
              猜成詳解本或答案卷，而拆題只吃「題本」。
              請回<a href="/import/new">匯入題本</a>重傳一次，並在檔案表格的
              「這是什麼」欄手動改成<strong>題本</strong>。
            </p>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                {data.lastCompletedStage && (
                  <button
                    type="button"
                    className="yz-btn yz-btn--primary"
                    disabled={acting}
                    onClick={() => act(true)}
                  >
                    從「{data.stages.find((s) => s.key === data.lastCompletedStage)?.label}」之後繼續
                  </button>
                )}
                <button
                  type="button"
                  className="yz-btn"
                  disabled={acting}
                  onClick={() => act(false)}
                >
                  從頭重跑
                </button>
              </div>

              {data.lastCompletedStage && (
                <p className="yz-hint" style={{ marginTop: 9 }}>
                  「繼續」只會重跑失敗的那一階段，不會重複付前面幾階段的 AI 費用。
                  除非你懷疑前面的階段也有問題，否則選它。
                </p>
              )}
            </>
          )}

          {actError && (
            <p className="yz-field__err" style={{ marginTop: 9 }}>
              {actError}
            </p>
          )}
        </section>
      )}

      {/* 排隊排太久。這一塊只在 QUEUED 卡住時出現，而且用的是與失敗
          那一塊不同的說法——它不是「失敗了」，是「還沒有人來拿」，
          而那兩件事要做的處置不同（後者多半要去看工作者活著沒）。 */}
      {stuckInQueue && !data.error && (
        <section className="yz-fieldset yz-fieldset--warn">
          <p style={{ fontSize: 13, lineHeight: 1.7 }}>
            這份題本已經排隊超過兩分鐘還沒有開始處理。多半是背景工作者沒有在跑，
            或它連不上佇列。檔案已經安全存好了，重新排隊不會重複收費——
            一個階段都還沒跑過。
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {/* 送 resume=true。這份工作多半一個階段都還沒跑過，兩者
                結果相同；但它也可能是「續跑之後又卡在排隊」，那時
                resume=false 會清掉續跑點，把已經付過錢的階段再跑一次。
                永遠選不會多花錢的那一邊。 */}
            <button
              type="button"
              className="yz-btn yz-btn--primary"
              disabled={acting}
              onClick={() => act(true)}
            >
              重新排隊
            </button>
          </div>
          {actError && (
            <p className="yz-field__err" style={{ marginTop: 9 }}>
              {actError}
            </p>
          )}
          <p className="yz-hint" style={{ marginTop: 9 }}>
            按了還是沒有動靜的話，請管理員確認背景工作者（worker）與 Redis 是否正常。
            這不是這份題本的問題，其他匯入也會卡在同一個地方。
          </p>
        </section>
      )}

      {data.files.some((f) => f.qualityNote) && (
        <section className="yz-fieldset">
          <h2 className="yz-legend">檔案品質</h2>
          <ul style={{ margin: '8px 0 0', paddingLeft: 0, listStyle: 'none' }}>
            {data.files.map((f) => (
              <li key={f.fileName} style={{ padding: '6px 0', fontSize: 12.5 }}>
                <span style={{ fontFamily: 'var(--font-doc)' }}>{f.fileName}</span>
                {f.qualityNote && <div className="yz-step__note">{f.qualityNote}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!finished && (
        <div className="yz-foot">
          <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>
            解析在背景進行，離開這一頁也不會中斷。完成後會出現在匯入紀錄裡。
          </span>
        </div>
      )}
    </div>
  );
}
