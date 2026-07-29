'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { Button } from '@/components/Button';
import { Note } from '@/components/Feedback';
import { TextField } from '@/components/Field';
import { Form } from '@/components/Form';

type Result = {
  imported: number;
  updated: number;
  encoding: string;
  skipped: { line: number; message: string }[];
};

/**
 * 在校成績百分比的匯入（教務處）。
 *
 * # 為什麼跳過的列要全部列出來
 *
 * 因為靜靜跳過的代價落在學生身上而不是承辦人身上。教務處匯了 300 列、
 * 系統收了 287 列、畫面寫著「匯入成功」——那 13 位學生在自己的頁面上
 * 看到「還沒有你的在校成績」，去問導師，導師去問教務處，教務處說
 * 「我匯過了」。這一段是那個迴圈的出口。
 *
 * # 為什麼結果裡沒有任何一位學生的百分比
 *
 * 因為那是全校最敏感的一份資料，而一支匯入 API 把剛寫進去的東西再回吐
 * 一次，等於在瀏覽器記錄裡留一份全校名單。要核對數字就看手上那份 CSV。
 */
export default function RankImport({ year }: { year: number }) {
  const router = useRouter();
  const [y, setY] = useState(String(year));
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<Result | null>(null);

  return (
    <div className="yz-card">
      <Form
        onSubmit={async () => {
          const file = fileRef.current?.files?.[0];
          if (!file) throw new Error('請選擇一個 CSV 檔');
          const body = new FormData();
          body.set('file', file);
          body.set('year', y);
          const res = await fetch('/api/admission/ranks', { method: 'POST', body });
          const data = (await res.json().catch(() => null)) as
            | (Result & { error?: string })
            | null;
          if (!res.ok) throw new Error(data?.error ?? `伺服器回應 ${res.status}`);
          setResult(data as Result);
          router.refresh();
        }}
      >
        {({ busy }) => (
          <>
            <h2 className="yz-card__title">匯入五學期在校成績百分比</h2>
            <p className="yz-hint">
              第一列要是欄位標題。認得「學號」與「百分比」這兩欄（也認得
              「在校成績百分比」「全校百分比」「PR」等寫法），可以直接用 Excel 另存的 CSV——
              Big5 也讀得懂。百分比<strong>越小越好</strong>，範圍 0 到 100。
            </p>
            <div className="yz-row">
              <TextField
                label="學年度（民國）"
                type="number"
                min={100}
                max={200}
                value={y}
                onChange={(e) => setY(e.currentTarget.value)}
                hint="繁星招生簡章是以學年度公告的，所以這裡用學年度而不是班級的學年。"
              />
              <div className="yz-field">
                <label className="yz-label" htmlFor="rank-csv">
                  CSV 檔
                </label>
                <input
                  id="rank-csv"
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  className="yz-in"
                />
              </div>
            </div>
            <div className="yz-actions">
              <span className="yz-actions__spacer" />
              <Button type="submit" variant="primary" busy={busy} busyLabel="匯入中…">
                匯入
              </Button>
            </div>
          </>
        )}
      </Form>

      {result && (
        <div className="yz-adm__result">
          <Note tone={result.skipped.length > 0 ? 'warn' : 'info'}>
            新增 {result.imported} 筆、更新 {result.updated} 筆
            {result.skipped.length > 0 ? `，跳過 ${result.skipped.length} 列` : ''}。
            檔案編碼判定為 {result.encoding}。
          </Note>
          {result.skipped.length > 0 && (
            <>
              <p className="yz-hint">
                下面這幾列<strong>沒有進去</strong>。這幾位學生的繁星模擬會顯示「還沒有你的
                在校成績」，所以要處理完再重匯一次（重匯會蓋掉，不會重複）。
              </p>
              <ul className="yz-adm__skipped">
                {result.skipped.map((s) => (
                  <li key={`${s.line}-${s.message}`}>
                    第 {s.line} 列：{s.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
