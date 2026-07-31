/**
 * 填校系、跑清單。
 *
 * # 為什麼「混搭」是一個可以選的選項
 *
 * 因為學生會混搭——那正是這個清單要抓的錯之一。做成只有兩個選項的話，
 * 他在這裡選了「勾選中央資料庫」，然後在甄選會的系統上又自行上傳了
 * 一份 PDF，而這份清單完全看不出來。
 *
 * 給他一個「兩種我都用了」的選項，他勾下去就會看到一句話說明那在
 * 甄選會的系統上做不到——而那句話出現在他還來得及改的時候。
 */
'use client';

import { useState } from 'react';

import { Button } from '@/components/Button';
import { Note } from '@/components/Feedback';
import { SelectField, TextField } from '@/components/Field';
import { submitJson, useAction } from '@/components/Form';

type Mode = { value: string; label: string };
type Row = { programRef: string; name: string; mode: string; deadline: string };
type Check = {
  code: string;
  label: string;
  ok: boolean;
  severity: 'BLOCK' | 'WARN' | 'INFO';
  detail: string;
};

const SEVERITY_LABELS: Record<string, string> = {
  BLOCK: '一定出事',
  WARN: '自己確認',
  INFO: '要知道',
};

const blank = (): Row => ({ programRef: '', name: '', mode: '', deadline: '' });

export default function ChecklistRunner({ modes }: { modes: Mode[] }) {
  const { busy, error, run } = useAction();
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [result, setResult] = useState<{ items: Check[]; blocking: number; warning: number } | null>(
    null,
  );

  const patch = (i: number, k: keyof Row, v: string) =>
    setRows((rs) => rs.map((r, j) => (i === j ? { ...r, [k]: v } : r)));

  const go = () =>
    run(async () => {
      const out = await submitJson<{ items: Check[]; blocking: number; warning: number }>(
        '/api/portfolio/checklist',
        {
          json: {
            programs: rows
              .filter((r) => r.programRef.trim())
              .map((r) => ({
                programRef: r.programRef.trim(),
                name: r.name.trim() || undefined,
                mode: r.mode || null,
                deadline: r.deadline || null,
              })),
          },
        },
      );
      setResult(out);
    });

  return (
    <>
      <section>
        <h2 className="yz-card__title" style={{ marginTop: 22 }}>
          你申請的校系（最多 6 個）
        </h2>
        <p className="yz-hint">
          截止日與擇一方式系統沒有，要你自己從各校的簡章或甄選會的系統上抄過來。
          讓系統去猜的話，這份清單會漏掉最會出事的那兩項——而漏掉重點的清單比
          沒有清單糟，因為你會以為自己核對過了。
          <strong>一個校系都不填的話，那幾項會標成「沒有核對到」而不是綠的</strong>
          ——那不是刁難，是因為它們真的沒有被核對。
        </p>

        {rows.map((r, i) => (
          <div key={i} className="yz-pf__progrow">
            <TextField
              label={`第 ${i + 1} 個校系的代碼或簡稱`}
              value={r.programRef}
              onChange={(e) => patch(i, 'programRef', e.target.value)}
            />
            <TextField
              label="名稱（選填）"
              value={r.name}
              onChange={(e) => patch(i, 'name', e.target.value)}
            />
            <SelectField
              label="用哪一種上傳"
              value={r.mode}
              onChange={(e) => patch(i, 'mode', e.target.value)}
            >
              <option value="">還沒決定</option>
              {modes.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
              <option value="MIXED">兩種我都用了</option>
            </SelectField>
            <TextField
              label="截止日"
              hint="各大學自訂。把最早的那一個當成自己的期限比較安全。"
              type="date"
              value={r.deadline}
              onChange={(e) => patch(i, 'deadline', e.target.value)}
            />
          </div>
        ))}

        <div className="yz-actions">
          {rows.length < 6 && (
            <Button onClick={() => setRows((rs) => [...rs, blank()])}>再加一個校系</Button>
          )}
          <Button variant="primary" busy={busy} onClick={go}>
            核對一次
          </Button>
        </div>
      </section>

      {error && <Note tone="error">{error}</Note>}

      {result && (
        <section>
          <h2 className="yz-card__title" style={{ marginTop: 26 }}>
            核對結果
          </h2>
          {result.blocking > 0 ? (
            <Note tone="error">
              有 <strong>{result.blocking}</strong> 項這樣送出去一定出事。
              甄選會的系統送出確認後不得修改，所以先把這幾項處理完。
            </Note>
          ) : (
            <Note tone="info">
              沒有阻斷項
              {result.warning > 0 ? `，但有 ${result.warning} 項要你自己再確認一次。` : '。'}
              最後一次提醒：<strong>送出確認後不得修改</strong>。
            </Note>
          )}

          <ul className="yz-pf__checks">
            {result.items.map((c) => (
              <li
                key={c.code}
                className={`yz-pf__check yz-pf__check--${c.ok ? 'ok' : c.severity.toLowerCase()}`}
              >
                <span className="yz-pf__checkflag">
                  {c.ok ? '過' : SEVERITY_LABELS[c.severity]}
                </span>
                <span className="yz-pf__checkbody">
                  <strong>{c.label}</strong>
                  <span className="yz-pf__checkdetail">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
