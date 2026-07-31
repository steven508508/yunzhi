'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { REF_KINDS, SOURCE_KINDS } from '@/lib/admissionRef.mjs';
import { Button } from '@/components/Button';
import { SelectField, TextField } from '@/components/Field';
import { Form, submitJson, useAction } from '@/components/Form';
import { Note } from '@/components/Feedback';

/**
 * 已經輸入的資料，附信任度。
 *
 * # 為什麼信任度是一個標籤而不是一個分數
 *
 * 因為「可信度 0.72」本身就是一種假精確度——它看起來像算出來的，而它是
 * 一張查表。三級（可以照著做決定／可以參考／只能當線索）說得出同樣的
 * 事情，而且沒有人會拿它去乘任何東西。
 *
 * # 為什麼來源與日期跟數字擺在同一列
 *
 * 因為它們要被一起讀。收在展開區裡的話，學生看到的就只是一串數字——
 * 而那正是這張表要防的事：一個沒有來源的數字，三個月後與一個有來源的
 * 長得一模一樣。
 *
 * # 為什麼刪掉是一顆安靜的按鈕而不是要二次確認
 *
 * 因為這是他自己查來的參考資料，刪錯了再查一次就有（而且清單上就寫著
 * 去哪裡查）。二次確認要留給真的不可逆的動作——把每一個刪除都做成
 * 對話框，使用者就會學會不看內容直接按確定。
 *
 * # 為什麼「改」與「刪」是兩顆按鈕
 *
 * 因為它們回答的是兩個不同的問題。最常見的錯誤是**小數點**：門檻 1.8%
 * 打成 18%——那是一位頂標學生與一位前 20% 學生的差別，而 AI 老師會拿
 * 它去跟他自己的百分比比較。只有「刪掉」的話，修一個小數點要重打校名、
 * 學年度、來源與日期五個欄位，而其中四個原本就是對的；中途放棄的人
 * 就留著那個 18% 繼續用。
 *
 * 改得動的只有**數字、來源、查到的日期與備註**。校名、學年度與資料
 * 種類不在裡面：它們決定這一筆資料**是關於什麼的**，改掉等於把它搬到
 * 另一個校系或另一個年度的趨勢裡，而畫面上看起來只是改了一個欄位。
 * 那一種要刪掉重加，而那次刪除是有意義的。
 */

type Trust = {
  level: string;
  label: string;
  sourceLabel: string;
  stale: boolean;
  staleBy: number;
  ageDays: number | null;
  old: boolean;
  notes: string[];
};

type Ref = {
  id: string;
  year: number;
  kind: string;
  kindLabel: string;
  institutionName: string;
  programName: string | null;
  starGroup: number | null;
  /** 原始值。改的時候要把現在的數字填回表單裡——空白的表單等於重打。 */
  value?: Record<string, unknown>;
  describe: string;
  sourceKind?: string;
  sourceRef: string;
  lookedUpAt: string;
  note: string | null;
  forSelfOnly: boolean;
  trust: Trust;
};

const LEVEL_CLASS: Record<string, string> = {
  SOLID: 'yz-ref__trust--solid',
  WORKABLE: 'yz-ref__trust--workable',
  WEAK: 'yz-ref__trust--weak',
};

/**
 * 一筆資料的修改表單。**只開它改得動的那幾欄。**
 *
 * 每一欄都用現有的值當預設值——空白表單等於「刪掉再加一次」，
 * 而那正是這個表單存在要取代的東西。
 */
function EditRef({
  year,
  row,
  onDone,
}: {
  year: number;
  row: Ref;
  onDone: () => void;
}) {
  const router = useRouter();
  const shape = REF_KINDS.find((k: { value: string }) => k.value === row.kind)?.shape ?? 'text';
  const v = (row.value ?? {}) as Record<string, unknown>;

  const [percentile, setPercentile] = useState(v.percentile === undefined ? '' : String(v.percentile));
  const [count, setCount] = useState(v.count === undefined ? '' : String(v.count));
  const [subjects, setSubjects] = useState(
    Array.isArray(v.subjects) ? (v.subjects as string[]).join('、') : '',
  );
  const [grades, setGrades] = useState(
    Array.isArray(v.grades) ? (v.grades as number[]).join('、') : '',
  );
  const [rules, setRules] = useState(String(v.rules ?? ''));
  const [text, setText] = useState(String(v.text ?? ''));
  const [sourceKind, setSourceKind] = useState(row.sourceKind ?? 'OFFICIAL_DOC');
  const [sourceRef, setSourceRef] = useState(row.sourceRef);
  const [lookedUpAt, setLookedUpAt] = useState(row.lookedUpAt.slice(0, 10));
  const [note, setNote] = useState(row.note ?? '');

  const raw: Record<string, unknown> =
    shape === 'percentile'
      ? { percentile }
      : shape === 'count'
        ? { count }
        : shape === 'sieve'
          ? { subjects, grades }
          : shape === 'rules'
            ? { rules }
            : { text };

  return (
    <div className="yz-card" style={{ marginTop: 10 }}>
      <Form
        onSubmit={async () => {
          await submitJson(`/api/admission/refs/${row.id}?year=${year}`, {
            method: 'PATCH',
            json: { raw, sourceKind, sourceRef, lookedUpAt, note: note || null },
          });
          onDone();
          router.refresh();
        }}
      >
        {({ busy }) => (
          <>
            <h3 className="yz-card__title">
              改這一筆：{row.institutionName}
              {row.programName ? ` ${row.programName}` : ''}　{row.year} 學年度　{row.kindLabel}
            </h3>
            <p className="yz-hint">
              校名、學年度與資料種類<strong>不能在這裡改</strong>——它們決定這一筆是關於
              什麼的，改掉等於把它搬到另一個校系或另一個年度的趨勢裡去。
              那一種請刪掉重加。
            </p>

            {shape === 'percentile' && (
              <TextField
                label="百分比"
                required
                value={percentile}
                onChange={(e) => setPercentile(e.currentTarget.value)}
                hint="越小越好。小數點要看清楚：1.8% 與 18% 是完全不同的兩件事。"
                autoFocus
              />
            )}
            {shape === 'count' && (
              <TextField
                label="缺額（名）"
                type="number"
                min={0}
                required
                value={count}
                onChange={(e) => setCount(e.currentTarget.value)}
                autoFocus
              />
            )}
            {shape === 'sieve' && (
              <div className="yz-row">
                <TextField
                  label="篩選科目"
                  required
                  value={subjects}
                  onChange={(e) => setSubjects(e.currentTarget.value)}
                  hint="用頓號分開，例如「國文、英文」。"
                  autoFocus
                />
                <TextField
                  label="對應的級分"
                  required
                  value={grades}
                  onChange={(e) => setGrades(e.currentTarget.value)}
                  hint="順序要與科目一致，數量也要一樣。"
                />
              </div>
            )}
            {shape === 'rules' && (
              <TextField
                label="門檻與檢定標準"
                required
                value={rules}
                onChange={(e) => setRules(e.currentTarget.value)}
                autoFocus
              />
            )}
            {shape === 'text' && (
              <TextField
                label="內容"
                required
                value={text}
                onChange={(e) => setText(e.currentTarget.value)}
                autoFocus
              />
            )}

            <div className="yz-row">
              <SelectField
                label="來源"
                value={sourceKind}
                onChange={(e) => setSourceKind(e.currentTarget.value)}
                hint="查錯地方也可以改。「聽同學說的」是一個可以誠實選的選項。"
              >
                {SOURCE_KINDS.map((s: { value: string; label: string }) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </SelectField>
              <TextField
                label="從哪裡查到的"
                required
                value={sourceRef}
                onChange={(e) => setSourceRef(e.currentTarget.value)}
              />
            </div>

            <div className="yz-row">
              <TextField
                label="查到的日期"
                type="date"
                required
                value={lookedUpAt}
                onChange={(e) => setLookedUpAt(e.currentTarget.value)}
                hint="重新確認過就把日期改成今天——過一年沒確認的資料會被降一級。"
              />
              <TextField
                label="備註（可以空著）"
                value={note}
                onChange={(e) => setNote(e.currentTarget.value)}
              />
            </div>

            <div className="yz-actions">
              <span className="yz-actions__spacer" />
              <Button variant="quiet" onClick={onDone} disabled={busy}>
                取消
              </Button>
              <Button type="submit" variant="primary" busy={busy} busyLabel="存起來…">
                存起來
              </Button>
            </div>
          </>
        )}
      </Form>
    </div>
  );
}

export default function RefList({ year, refs }: { year: number; refs: Ref[] }) {
  const router = useRouter();
  const del = useAction();
  const [editing, setEditing] = useState<string | null>(null);

  if (refs.length === 0) {
    return (
      <p className="yz-hint">
        還沒有輸入任何資料。照上面的清單查一項，回來填一筆——
        <strong>先填一年的錄取標準就有用了</strong>，但三年才看得出趨勢。
      </p>
    );
  }

  return (
    <>
      <ul className="yz-ref__list">
        {refs.map((r) => (
          <li key={r.id} className="yz-ref__item">
            <div className="yz-ref__itemhead">
              <span className="yz-ref__kind">{r.kindLabel}</span>
              <span className="yz-ref__target">
                <b>{r.institutionName}</b>
                {r.programName ? ` ${r.programName}` : ''}
                {r.starGroup ? `　第 ${r.starGroup} 類學群` : ''}
              </span>
              <span className="yz-ref__year">{r.year} 學年度</span>
              <span className="yz-adm__num">{r.describe}</span>
              <span className={`yz-ref__trust ${LEVEL_CLASS[r.trust.level] ?? ''}`}>
                {r.trust.label}
              </span>
              <span className="yz-rowacts">
                {/* 「改」排在「刪」前面：打錯一個小數點是最常發生的事，
                    而刪掉重打是它以前唯一的出路。 */}
                <Button
                  variant="quiet"
                  onClick={() => setEditing(editing === r.id ? null : r.id)}
                >
                  {editing === r.id ? '不改了' : '改'}
                </Button>
                <Button
                  variant="quiet"
                  busy={del.busy}
                  onClick={() =>
                    del.run(async () => {
                      await submitJson(`/api/admission/refs/${r.id}?year=${year}`, {
                        method: 'DELETE',
                      });
                      router.refresh();
                    })
                  }
                >
                  刪掉
                </Button>
              </span>
            </div>

            {/* 來源與日期。**與數字同一列，不收進展開區。** */}
            <p className="yz-ref__source">
              <span className="yz-ref__sourcekind">{r.trust.sourceLabel}</span>
              <span className="yz-ref__sourceref">{r.sourceRef}</span>
              <span className="yz-ref__date">{r.lookedUpAt.slice(0, 10)} 查</span>
              {r.trust.ageDays !== null && r.trust.ageDays > 0 && (
                <span className="yz-ref__age">（{r.trust.ageDays} 天前）</span>
              )}
            </p>

            {r.trust.notes.length > 0 && (
              <ul className="yz-ref__notes">
                {r.trust.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}

            {r.kind === 'MY_PERCENTILE' && (
              <p className="yz-ref__selfonly">
                這是<strong>你自己輸入的在校百分比</strong>：只用於你自己的建議，
                <strong>不進入校內賽局模擬</strong>，也
                <strong>不會影響任何其他同學看到的序位</strong>。
                模擬用的是教務處匯入的那一份。
              </p>
            )}

            {r.note && <p className="yz-ref__memo">{r.note}</p>}

            {editing === r.id && (
              <EditRef year={year} row={r} onDone={() => setEditing(null)} />
            )}
          </li>
        ))}
      </ul>
      {del.error && <Note tone="error">{del.error}</Note>}
    </>
  );
}
