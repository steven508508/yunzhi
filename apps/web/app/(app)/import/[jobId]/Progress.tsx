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

export default function Progress({ initial }: { initial: ProgressData }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [acting, setActing] = useState(false);

  const finished = ['READY_FOR_REVIEW', 'COMMITTED', 'FAILED'].includes(data.status);

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
    try {
      const res = await fetch(`/api/import/${data.jobId}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resume }),
      });
      if (res.ok) router.refresh();
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
              <span className="yz-step__time">{duration(s.elapsedMs)}</span>
            </li>
          ))}
        </ol>

        {data.aiCostTwd > 0 && (
          <p style={{ marginTop: 12, fontSize: 12, color: 'var(--ink-3)' }}>
            這份題本目前的 AI 成本約 NT${data.aiCostTwd.toFixed(2)}（估算值，非帳單）
          </p>
        )}
      </section>

      {data.error && (
        <section className="yz-fieldset yz-fieldset--warn">
          <p style={{ color: 'var(--mark)', fontSize: 13, lineHeight: 1.7 }}>{data.error}</p>

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
