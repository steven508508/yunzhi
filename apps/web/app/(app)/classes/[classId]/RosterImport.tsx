/**
 * 名冊匯入的兩段式介面。
 *
 * 先試算再確認，因為**部分匯入之後沒有人知道現在是什麼狀態**。
 * 這件事發生在開學前一天、櫃檯同時在做五件事的時候，
 * 而錯了的代價是有學生登不進去。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { Button } from '@/components/Button';
import { Note } from '@/components/Feedback';

type Problem = { line: number; column?: string; message: string };
type Plan = {
  encoding: string;
  rows: { line: number; username: string; displayName: string }[];
  problems: Problem[];
  existing: string[];
  creating: string[];
};
type Credentials = { username: string; displayName: string; password: string }[];

const ENCODING_LABEL: Record<string, string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8（含 BOM，已處理）',
  big5: 'Big5（Windows 版 Excel 的預設，已處理）',
  'utf-16le': 'UTF-16',
  'utf-16be': 'UTF-16',
};

export default function RosterImport({
  classId,
  className,
}: {
  classId: string;
  className: string;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(apply: boolean) {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set('file', file);
      if (apply) fd.set('apply', '1');
      const res = await fetch(`/api/classes/${classId}/roster`, { method: 'POST', body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `伺服器回應 ${res.status}`);
      setPlan(data.plan);
      if (apply) {
        setCreds(data.result.credentials);
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // 匯入完成：把初始密碼列出來。**這是唯一一次拿得到。**
  if (creds) {
    return (
      <div className="yz-card" style={{ marginBottom: 22 }}>
        <h2 className="yz-card__title">名冊已匯入</h2>
        {creds.length === 0 ? (
          <Note>沒有新增帳號——名冊上的學生都已經有帳號了，只是把他們加進這個班。</Note>
        ) : (
          <>
            <Note tone="warn">
              下面是 {creds.length} 個新帳號的初始密碼。
              <b>離開這一頁之後就取不回來了</b>，請先列印或複製。
              學生第一次登入時會被要求更換密碼。
            </Note>
            <table className="yz-table">
              <thead>
                <tr>
                  <th scope="col">學號</th>
                  <th scope="col">姓名</th>
                  <th scope="col">初始密碼</th>
                </tr>
              </thead>
              <tbody>
                {creds.map((c) => (
                  <tr key={c.username}>
                    <td>{c.username}</td>
                    <td>{c.displayName}</td>
                    <td style={{ fontFamily: 'var(--font-doc)', letterSpacing: '.08em' }}>
                      {c.password}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div className="yz-actions">
          <span className="yz-actions__spacer" />
          <Button onClick={() => window.print()}>列印這一頁</Button>
          <Button
            variant="primary"
            onClick={() => {
              setCreds(null);
              setPlan(null);
              setFile(null);
              if (fileRef.current) fileRef.current.value = '';
            }}
          >
            完成
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="yz-card" style={{ marginBottom: 22 }}>
      <h2 className="yz-card__title">匯入名冊</h2>
      <p className="yz-field__hint" style={{ marginBottom: 12 }}>
        CSV 檔，第一列是欄位標題。至少要有「學號」與「姓名」兩欄，
        欄位名稱不必改成特定的寫法。Excel 存出來的 Big5 直接丟進來就好。
      </p>

      {error && <Note tone="error">{error}</Note>}

      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="yz-in"
        onChange={(e) => {
          setFile(e.currentTarget.files?.[0] ?? null);
          setPlan(null);
          setError(null);
        }}
      />

      {plan && (
        <div style={{ marginTop: 14 }}>
          <p className="yz-field__hint">
            編碼判定為 {ENCODING_LABEL[plan.encoding] ?? plan.encoding}。
          </p>
          {plan.problems.length > 0 ? (
            <>
              <Note tone="error">
                有 {plan.problems.length} 個問題，<b>整份都不會匯入</b>。
                修正之後再匯一次——部分匯入之後沒有人知道現在是什麼狀態。
              </Note>
              <ul style={{ marginLeft: 18, fontSize: 12.5, lineHeight: 2 }}>
                {plan.problems.slice(0, 20).map((p, i) => (
                  <li key={i}>
                    第 {p.line} 列{p.column ? `（${p.column}）` : ''}：{p.message}
                  </li>
                ))}
                {plan.problems.length > 20 && <li>…還有 {plan.problems.length - 20} 個</li>}
              </ul>
            </>
          ) : (
            <Note>
              讀到 {plan.rows.length} 位學生：新增 {plan.creating.length} 個帳號，
              {plan.existing.length} 位已經有帳號（會加進「{className}」，不會重建）。
            </Note>
          )}
        </div>
      )}

      <div className="yz-actions">
        <span className="yz-actions__spacer" />
        <Button onClick={() => send(false)} busy={busy && !plan} disabled={!file}>
          試算
        </Button>
        <Button
          variant="primary"
          onClick={() => send(true)}
          busy={busy && !!plan}
          busyLabel="匯入中…"
          disabled={!plan || plan.problems.length > 0}
        >
          確認匯入
        </Button>
      </div>
    </div>
  );
}
