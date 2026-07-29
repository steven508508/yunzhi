'use client';

import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '@/components/Dialog';

/**
 * 出版社專屬題型的確認入口。
 *
 * 出版社常有自己設計的題型（翰林的「觀念速記」、南一的「圖表解碼」）。
 * 模型遇到不認得的就標成 OTHER、提議一個名稱，等老師確認一次，
 * 之後每一次匯入都直接認得——那第二次以後的省時才是這件事划算的地方。
 *
 * 後端（`lib/customTypes.ts`、`/api/import/[jobId]/custom-types`）與
 * 端到端測試都齊全，**只有畫面上完全沒有入口**：模型提議了，老師永遠
 * 不知道有人在問他，於是那些題目一路以 OTHER 入庫，而下一次匯入同一
 * 家出版社的講義還是不認得。
 *
 * 放在校對介面的頂端而不是另開一頁：老師只有在校對時才會看到那幾題
 * 長什麼樣，而「這是什麼題型」這個問題離開了那幾題就答不出來。
 */

type Pending = {
  name: string;
  count: number;
  samplePage: number | null;
  sampleAssetKey: string | null;
  sampleStem: string;
};

type Meta = {
  pending: Pending[];
  answerModes: string[];
  rights: string[];
};

const MODE_LABELS: Record<string, string> = {
  SINGLE_CHOICE: '單選',
  MULTI_CHOICE: '多選',
  TRUE_FALSE: '是非',
  FILL_SLOT: '選填（答案卡格位）',
  FILL_TEXT: '填空',
  SHORT_ANSWER: '簡答',
  ESSAY: '長文寫作',
  TRANSLATION: '翻譯',
};

const RIGHTS_LABELS: Record<string, string> = {
  OWNED: '本補習班或本校老師自有',
  LICENSED: '已取得著作權人書面同意',
  OFFICIAL_PUBLIC: '官方公開資料，不受著作權保護',
  UNVERIFIED: '尚未確認（僅供內部參考）',
};

export default function CustomTypes({
  jobId, names, onApplied,
}: {
  jobId: string;
  /** 這份工作裡還沒確認的題型名稱。由校對介面算出來。 */
  names: string[];
  onApplied: (name: string) => void;
}) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [publisher, setPublisher] = useState('');
  const [description, setDescription] = useState('');
  const [answerMode, setAnswerMode] = useState('SHORT_ANSWER');
  const [rightsBasis, setRightsBasis] = useState('LICENSED');
  const [rightsNote, setRightsNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const current = meta?.pending.find((p) => names.includes(p.name)) ?? null;

  const load = useCallback(async () => {
    const res = await fetch(`/api/import/${jobId}/custom-types`, { cache: 'no-store' });
    if (!res.ok) return;
    const body = await res.json();
    setMeta(body);
  }, [jobId]);

  useEffect(() => { void load(); }, [load]);

  // 對話框打開時把模型提議的名稱當預設值。老師多半只是改個字，
  // 從空白開始等於要他重打一次。
  useEffect(() => {
    if (open && current) {
      setName(current.name);
      setDescription('');
      setConfirmed(false);
      setError(null);
    }
  }, [open, current]);

  if (!names.length || !current) return null;

  async function submit() {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/import/${jobId}/custom-types`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          proposedName: current.name,
          name: name.trim(),
          description: description.trim(),
          answerMode,
          publisherName: publisher.trim() || undefined,
          rightsBasis,
          rightsNote: rightsNote.trim() || undefined,
          rightsConfirmed: true,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError([body.error, ...(body.detail ?? [])].filter(Boolean).join('　'));
        return;
      }
      setDone(body.hint ?? '已確認');
      onApplied(current.name);
      setOpen(false);
      await load();
    } catch (e) {
      setError(`連線失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="yz-typebar">
      <span>
        這份題本裡有 <b>{current.count}</b> 題是系統不認得的題型，模型提議叫「{current.name}」。
        確認一次，之後匯入同一種題型就會直接認得。
      </span>
      {done && <span style={{ color: 'var(--ink-2)' }}>{done}</span>}
      <button type="button" className="yz-btn" onClick={() => setOpen(true)}>
        確認題型{names.length > 1 ? `（還有 ${names.length - 1} 種）` : ''}
      </button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`這是什麼題型？（${current.count} 題）`}
        footer={
          <>
            <button type="button" className="yz-btn" onClick={() => setOpen(false)}>先不要</button>
            <button
              type="button"
              className="yz-btn yz-btn--primary"
              disabled={busy || !name.trim() || !description.trim() || !confirmed}
              onClick={submit}
            >
              {busy ? '儲存中…' : '確認'}
            </button>
          </>
        }
      >
        <p className="yz-hint" style={{ marginBottom: 10 }}>
          系統不需要懂這個題型的教學設計，只需要知道<strong>學生怎麼作答、怎麼給分</strong>。
          {current.samplePage != null && `　（例：第 ${current.samplePage} 頁）`}
        </p>

        {current.sampleAssetKey && (
          // 只給文字的話老師認不出那是哪一種題型——那些題型的辨識特徵
          // 本來就是版面而不是文字。
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="yz-typebar__sample"
            src={`/api/import/${jobId}/image?key=${encodeURIComponent(current.sampleAssetKey)}`}
            alt="這個題型的原稿樣子"
          />
        )}
        {current.sampleStem && (
          <p className="yz-muted" style={{ fontSize: 12.5, lineHeight: 1.7 }}>{current.sampleStem}</p>
        )}

        <label className="yz-field">
          <span>題型名稱</span>
          <input className="yz-in" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </label>

        <label className="yz-field">
          <span>出版社（選填）</span>
          <input className="yz-in" value={publisher} onChange={(e) => setPublisher(e.target.value)}
                 placeholder="例：翰林" maxLength={100} />
        </label>

        <label className="yz-field">
          <span>這個題型長什麼樣、要學生做什麼</span>
          <textarea className="yz-in" rows={2} value={description} maxLength={2000}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="例：黃色圓角色塊，標題左側有燈泡圖示，把關鍵字挖空讓學生回想" />
          <span className="yz-hint">這一段會進下一次辨識的提示詞，寫得具體一點，之後就認得出來。</span>
        </label>

        <label className="yz-field">
          <span>學生怎麼作答</span>
          <select className="yz-in" value={answerMode} onChange={(e) => setAnswerMode(e.target.value)}>
            {(meta?.answerModes ?? Object.keys(MODE_LABELS)).map((m) => (
              <option key={m} value={m}>{MODE_LABELS[m] ?? m}</option>
            ))}
          </select>
          <span className="yz-hint">
            不論版面多特別，作答與評分都要落到既有的機制上，否則存得下它卻不能拿它考學生。
          </span>
        </label>

        <label className="yz-field">
          <span>授權基礎</span>
          <select className="yz-in" value={rightsBasis} onChange={(e) => setRightsBasis(e.target.value)}>
            {(meta?.rights ?? Object.keys(RIGHTS_LABELS)).map((r) => (
              <option key={r} value={r}>{RIGHTS_LABELS[r] ?? r}</option>
            ))}
          </select>
        </label>

        <label className="yz-field">
          <span>備註（選填）</span>
          <input className="yz-in" value={rightsNote} maxLength={2000}
                 onChange={(e) => setRightsNote(e.target.value)} />
        </label>

        <label className="yz-check">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>我確認本班有權利使用這個題型，並了解這個確認會以我的名義記錄下來。</span>
        </label>

        {error && <p className="yz-field__err" role="alert">{error}</p>}
      </Dialog>
    </div>
  );
}
