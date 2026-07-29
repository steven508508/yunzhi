'use client';

/**
 * 上傳介面。
 *
 * 設計上的一條線：**權利聲明不是可跳過的法務欄位，是流程的一部分**。
 * 老師說過會處理好版權（訪談第 7 題），但那句承諾要留下記錄，
 * 而且要在這裡就決定這批題目日後能流通到多遠——因為它不合規時，
 * 唯一比「上傳時被擋」更糟的結果，是「校對完 50 題之後才被擋」。
 *
 * 另一條線是猜測要看得見。檔案角色（題本／答案卷／詳解本）由檔名
 * 猜，猜錯的成本是老師改一下；不猜的成本是每個檔都要點一次。
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  SOURCE_TYPE_LABELS,
  RIGHTS_BASIS_LABELS,
  allowedScopes,
  defaultScope,
  explanationPolicy,
  validateDeclaration,
  type SourceType,
  type LicenseScope,
  type RightsBasis,
} from '@/lib/rights';

type Subject = { id: string; name: string };

type FileRole = 'QUESTION_BOOK' | 'ANSWER_KEY' | 'EXPLANATION_BOOK' | 'RUBRIC';

/**
 * 標籤後面那句「（不會被讀取）」不是客套。
 *
 * 答案卷、詳解本、評分原則三種角色在整個系統裡**沒有任何消費端**：
 * 拆題只吃題本，答案卷對齊、詳解匯入、rubric 三條流程還不存在。
 * 老師通常會把出版社的「題本 + 解答本」兩份都拖進來，然後以為
 * 「答案是照解答本進來的，我只要確認題幹」——**實際上所有答案都是
 * AI 自己算的**，而他在不知情的狀況下替它們背書。
 *
 * 選項不拿掉而是講清楚：拿掉的話，手上真的有一份解答本的老師會把它
 * 標成「題本」，那份 40 頁的解答本就會被當成題目拆進題庫。
 */
const ROLE_LABELS: Record<FileRole, string> = {
  QUESTION_BOOK: '題本',
  ANSWER_KEY: '答案卷（不會被讀取）',
  EXPLANATION_BOOK: '詳解本（不會被讀取）',
  RUBRIC: '評分原則（不會被讀取）',
};

const READ_ROLES: FileRole[] = ['QUESTION_BOOK'];

const SCOPE_LABELS: Record<LicenseScope, string> = {
  PUBLIC: '公開（可自由散布）',
  TENANT_EXPORTABLE: '本補習班使用，可匯出',
  TENANT_NO_EXPORT: '僅本補習班，不可匯出',
  INTERNAL_USE_ONLY: '僅內部參考，不呈現給學生',
};

type Picked = { file: File; role: FileRole };

/**
 * 從檔名猜角色。與後端 guessRole 同一套規則。
 *
 * **題本的判斷排在最前面。** 老師自己出的段考卷檔名九成長這樣：
 * 「115上第三次段考_數學A_含詳解.docx」「數A第3章_解析版.docx」——
 * 舊版先命中「詳解」，整份匯入變成詳解本，然後在第二階段永久失敗，
 * 而兩顆重試按鈕都改不了角色。題本裡夾詳解是常態，純詳解本很少
 * 單獨存在，所以兩種都命中時猜題本。
 */
function guessRole(name: string): FileRole {
  const n = name.toLowerCase();
  if (/題本|試題|考卷|考題|段考|小考|週考|月考|模擬|講義|習題|練習|exam|paper|quiz/.test(n)) {
    return 'QUESTION_BOOK';
  }
  if (/答案|解答|answer|key|ans/.test(n)) return 'ANSWER_KEY';
  if (/詳解|解析|explanation|solution/.test(n)) return 'EXPLANATION_BOOK';
  if (/評分|原則|rubric|級分/.test(n)) return 'RUBRIC';
  return 'QUESTION_BOOK';
}

function mb(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type Duplicate = {
  fileName: string;
  priorJobId: string;
  priorTitle: string;
  priorBy: string;
  priorAt: string;
};

export default function Upload({ subjects }: { subjects: Subject[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<Picked[]>([]);
  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState('');
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? '');
  const [sourceType, setSourceType] = useState<SourceType>('PUBLISHER_SCAN');
  const [licenseScope, setLicenseScope] = useState<LicenseScope>('TENANT_NO_EXPORT');
  const [rightsBasis, setRightsBasis] = useState<RightsBasis>('LICENSED');
  const [rightsNote, setRightsNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string[]>([]);
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);

  const scopes = useMemo(() => allowedScopes(sourceType), [sourceType]);

  /** 來源換了，流通範圍要跟著收斂到允許的範圍內。 */
  const onSourceChange = (s: SourceType) => {
    setSourceType(s);
    if (!allowedScopes(s).includes(licenseScope)) setLicenseScope(defaultScope(s));
    if (s === 'OFFICIAL_PAST') setRightsBasis('OFFICIAL_PUBLIC');
  };

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const picked = Array.from(incoming).map((file) => ({ file, role: guessRole(file.name) }));
    setFiles((prev) => {
      const names = new Set(prev.map((p) => p.file.name));
      return [...prev, ...picked.filter((p) => !names.has(p.file.name))].slice(0, 10);
    });
    setDuplicates(null);
    setError(null);
  }, []);

  const declarationError = validateDeclaration({
    sourceType,
    licenseScope,
    rightsBasis,
    rightsNote,
  });

  const totalBytes = files.reduce((n, f) => n + f.file.size, 0);

  /**
   * 一份題本都沒有 → 在上傳前就擋下來。
   *
   * 這是三秒就能做完的檢查，而不做的代價是：檔案上傳、排隊、第一階段
   * 把 36 頁全部渲染完（錢付了），然後在拆題階段丟出「沒有可切分的
   * 頁面」——老師等了五分鐘才知道，而重試按鈕改不了角色。
   */
  const noQuestionBook = files.length > 0 && !files.some((f) => READ_ROLES.includes(f.role));
  const ignoredCount = files.filter((f) => !READ_ROLES.includes(f.role)).length;

  const canSubmit =
    files.length > 0 && title.trim() && subjectId && confirmed && !declarationError
    && !noQuestionBook && !busy;

  async function submit(allowDuplicate = false) {
    setBusy(true);
    setError(null);
    setDetail([]);
    setDuplicates(null);

    const fd = new FormData();
    fd.append(
      'meta',
      JSON.stringify({
        subjectId,
        title: title.trim(),
        sourceType,
        licenseScope,
        rightsBasis,
        rightsNote: rightsNote.trim() || undefined,
        roles: files.map((f) => f.role),
        rightsConfirmed: true,
        allowDuplicate,
      }),
    );
    for (const f of files) fd.append('files', f.file, f.file.name);

    try {
      const res = await fetch('/api/import', { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({}));

      if (res.status === 409 && body.duplicates) {
        setDuplicates(body.duplicates);
        setError(body.error);
        return;
      }
      if (!res.ok) {
        setError(body.error ?? `上傳失敗（${res.status}）`);
        setDetail(Array.isArray(body.detail) ? body.detail : []);
        return;
      }
      router.push(body.next ?? `/import/${body.jobId}`);
    } catch (e) {
      setError(
        `連線中斷：${e instanceof Error ? e.message : String(e)}。` +
          '若是用手機熱點，請靠近訊號較好的位置後重試。',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="yz-panel" style={{ maxWidth: 760, margin: '0 auto' }}>
      <div className="yz-panel__head">
        <h1 style={{ fontFamily: 'var(--font-doc)', fontSize: 17, fontWeight: 600 }}>
          匯入題本
        </h1>
        <p style={{ color: 'var(--ink-2)', marginTop: 5, fontSize: 12.5, lineHeight: 1.7 }}>
          支援 PDF、Word（.docx）、以及掃描件與手機照片。
          原生 PDF 與 Word 的辨識最準；照片會逐頁評估品質並提示是否需要細看。
        </p>
      </div>

      {/* ── 檔案 ─────────────────────────────────────────── */}

      <section className="yz-fieldset">
        <div
          className={`yz-drop${dragging ? ' yz-drop--over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            addFiles(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
          }}
        >
          <div className="yz-drop__main">把檔案拖進來，或點一下選擇</div>
          <div className="yz-drop__sub">一次最多 10 個檔案、單檔 200 MB</div>
        </div>

        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          accept=".pdf,.docx,.odt,.jpg,.jpeg,.png,.webp,.heic,application/pdf,image/*"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />

        {files.length > 0 && (
          <table className="yz-table" style={{ marginTop: 14 }}>
            <thead>
              <tr>
                <th>檔案</th>
                <th style={{ width: 130 }}>這是什麼</th>
                <th className="yz-table__num" style={{ width: 80 }}>
                  大小
                </th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {files.map((f, i) => (
                <tr key={f.file.name}>
                  <td style={{ wordBreak: 'break-all' }}>
                    {f.file.name}
                    {!READ_ROLES.includes(f.role) && (
                      <div className="yz-field__err" style={{ marginTop: 2 }}>
                        這一份不會被拆成題目，也不會計費。如果它裡面有題目，請改成「題本」。
                      </div>
                    )}
                  </td>
                  <td>
                    <select
                      className="yz-in"
                      value={f.role}
                      onChange={(e) =>
                        setFiles((prev) =>
                          prev.map((p, j) =>
                            j === i ? { ...p, role: e.target.value as FileRole } : p,
                          ),
                        )
                      }
                    >
                      {Object.entries(ROLE_LABELS).map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="yz-table__num">{mb(f.file.size)}</td>
                  <td>
                    <button
                      type="button"
                      className="yz-btn yz-btn--quiet"
                      onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                      aria-label={`移除 ${f.file.name}`}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
              <tr>
                <td colSpan={2} style={{ color: 'var(--ink-3)' }}>
                  共 {files.length} 個檔案
                  {ignoredCount > 0 && `（其中 ${ignoredCount} 份不會被讀取）`}
                </td>
                <td className="yz-table__num" style={{ color: 'var(--ink-3)' }}>
                  {mb(totalBytes)}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        )}

        {noQuestionBook && (
          <p className="yz-field__err" role="alert" style={{ marginTop: 10, lineHeight: 1.75 }}>
            這批檔案裡沒有一份標成「題本」，所以拆不出任何題目。
            請把有題目的那一份改成「題本」再送出。
          </p>
        )}

        {ignoredCount > 0 && !noQuestionBook && (
          <p className="yz-hint" style={{ marginTop: 10, lineHeight: 1.75 }}>
            <strong>這一版只讀題本。</strong>
            答案卷、詳解本、評分原則上傳之後不會被解析（也不會產生費用）——
            答案卷對齊還沒有做，所以<strong>答案會由 AI 自己推導</strong>，校對時要逐題驗算。
            如果你的解答本與題本是同一份檔案（教用版），那就沒問題：
            題目旁邊印的答案讀得到，校對介面會標成「題本印的」。
          </p>
        )}
      </section>

      {/* ── 基本資料 ─────────────────────────────────────── */}

      <section className="yz-fieldset">
        <h2 className="yz-legend">基本資料</h2>
        <div>
          <label className="yz-field">
            <span>這批題目叫什麼</span>
            <input
              className="yz-in"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例：115 學測數學A、翰林講義第 3 章"
              maxLength={200}
            />
          </label>

          <label className="yz-field">
            <span>科目</span>
            <select className="yz-in" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* ── 權利聲明 ─────────────────────────────────────── */}

      <section className="yz-fieldset">
        <h2 className="yz-legend">來源與權利</h2>
        <p className="yz-hint" style={{ marginBottom: 13 }}>
          這一段決定題目日後能用在哪裡，也是日後查核的依據。
          填錯不會馬上出事，但等到要把考卷給別班用、或要匯出時才發現不能用，
          會很麻煩。
        </p>

        <div>
          <label className="yz-field">
            <span>來源</span>
            <select
              className="yz-in"
              value={sourceType}
              onChange={(e) => onSourceChange(e.target.value as SourceType)}
            >
              {Object.entries(SOURCE_TYPE_LABELS).map(([v, { label }]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            <span className="yz-hint">
              {SOURCE_TYPE_LABELS[sourceType].hint}
            </span>
          </label>

          <label className="yz-field">
            <span>權利基礎</span>
            <select
              className="yz-in"
              value={rightsBasis}
              onChange={(e) => setRightsBasis(e.target.value as RightsBasis)}
            >
              {Object.entries(RIGHTS_BASIS_LABELS).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            <span className="yz-hint">
              {explanationPolicy(rightsBasis)}
            </span>
          </label>

          <label className="yz-field">
            <span>流通範圍</span>
            <select
              className="yz-in"
              value={licenseScope}
              onChange={(e) => setLicenseScope(e.target.value as LicenseScope)}
            >
              {scopes.map((s) => (
                <option key={s} value={s}>
                  {SCOPE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>

          <label className="yz-field">
            <span>
              備註{rightsBasis === 'LICENSED' ? '（必填：同意的來源與日期）' : '（選填）'}
            </span>
            <textarea
              className="yz-in"
              value={rightsNote}
              onChange={(e) => setRightsNote(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder={
                rightsBasis === 'LICENSED'
                  ? '例：2026/03 與翰林業務黃先生確認，授權本班內部教學使用'
                  : ''
              }
            />
          </label>

          {declarationError && (
            <p style={{ color: 'var(--mark)', fontSize: 12.5, lineHeight: 1.65 }}>
              {declarationError}
            </p>
          )}

          <label className="yz-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              我確認已取得這批題目的使用權利，並了解這份聲明會以我的名義記錄下來。
            </span>
          </label>
        </div>
      </section>

      {/* ── 錯誤與重複 ───────────────────────────────────── */}

      {error && (
        <section className="yz-fieldset yz-fieldset--warn">
          <p style={{ color: 'var(--mark)', fontSize: 13 }}>{error}</p>
          {detail.length > 0 && (
            <ul style={{ marginTop: 6, paddingLeft: 18, color: 'var(--ink-2)', fontSize: 12.5 }}>
              {detail.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}

          {duplicates && (
            <>
              <table className="yz-table" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>檔案</th>
                    <th>先前的匯入</th>
                    <th>由誰</th>
                    <th>時間</th>
                  </tr>
                </thead>
                <tbody>
                  {duplicates.map((d) => (
                    <tr key={d.priorJobId + d.fileName}>
                      <td>{d.fileName}</td>
                      <td>
                        <a href={`/import/${d.priorJobId}`}>{d.priorTitle}</a>
                      </td>
                      <td>{d.priorBy}</td>
                      <td style={{ color: 'var(--ink-3)' }}>
                        {new Date(d.priorAt).toLocaleDateString('zh-TW')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                type="button"
                className="yz-btn"
                style={{ marginTop: 10 }}
                disabled={busy}
                onClick={() => submit(true)}
              >
                我知道，仍要再匯一次
              </button>
            </>
          )}
        </section>
      )}

      {/* ── 送出 ─────────────────────────────────────────── */}

      <div className="yz-foot">
        <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>
          上傳完成後會在背景解析，你可以先去做別的事。
        </span>
        <button
          type="button"
          className="yz-btn yz-btn--primary"
          disabled={!canSubmit}
          onClick={() => submit(false)}
        >
          {busy ? '上傳中…' : '開始匯入'}
        </button>
      </div>
    </div>
  );
}
