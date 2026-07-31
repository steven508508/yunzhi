'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { SelectField, TextField } from '@/components/Field';
import { Form, submitJson, useAction } from '@/components/Form';
import { Note } from '@/components/Feedback';

type Source = { value: string; label: string; hint: string };
type Subject = { code: string; label: string };
type Record_ = {
  id: string;
  subjectCode: string;
  subjectLabel: string;
  examName: string;
  examDate: string;
  grade: number;
  source: string;
  sourceLabel: string;
};

/**
 * 級分記錄的輸入與清單。
 *
 * # 為什麼「這是哪一種考試」不能是可選的
 *
 * 因為它決定區間的寬度。校內模考的級距本身就不可靠（前 1% 只有一兩個
 * 人，文件 A.2），而外部模考（南模、全模）的到考人數是全國幾萬人。
 * 兩者混在一起算而不分辨的話，一位只考過校內模考的學生會看到一個
 * 與全模同學一樣窄的區間——那個區間的精確度是假的。
 *
 * 所以來源是必選的，而且選項旁邊要說出它會造成什麼差別。
 *
 * # 為什麼考試名稱是「身分」而不是備註
 *
 * schema 的唯一鍵是 `[userId, subjectCode, examName]`：同一場考試同一科
 * 只能有一筆。這不是潔癖——同一場考試有兩個級分的話，趨勢與波動都會
 * 算錯，而畫面上只是多了一列。
 *
 * # 為什麼「真正的學測」那一個選項要特別說明
 *
 * 因為輸入它會觸發回填：同一科的歷次預測全部補上實際成績，而那是校準
 * 曲線唯一的資料來源。學生不知道自己剛剛做了一件對整個機構有用的事，
 * 所以要講。
 */
export default function GradeForm({
  subjects,
  sources,
  records,
}: {
  subjects: Subject[];
  sources: Source[];
  records: Record_[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  /**
   * 剛剛回填的結果。**這個要說出來**：輸入正式級分是校準曲線唯一的
   * 資料來源，而學生不知道自己做了一件對整個機構有用的事。
   * `afterExam` 也要說——考完之後才存的那幾份刻意不對答案，不講的話
   * 學生會以為系統漏了幾份。
   */
  const [filled, setFilled] = useState<{ backfilled: number; afterExam: number } | null>(null);
  const [subjectCode, setSubjectCode] = useState(subjects[0]?.code ?? 'MATH_A');
  const [examName, setExamName] = useState('');
  const [examDate, setExamDate] = useState(new Date().toISOString().slice(0, 10));
  const [grade, setGrade] = useState('');
  const [percentile, setPercentile] = useState('');
  const [source, setSource] = useState('EXTERNAL_MOCK');
  const del = useAction();

  const meta = sources.find((s) => s.value === source);

  return (
    <>
      {records.length === 0 ? (
        <p className="yz-hint">
          還沒有任何級分記錄。把手上的模考成績單一張一張輸入進來——
          <strong>成績單上印的級分就是直接觀測值</strong>，不需要任何換算。
        </p>
      ) : (
        <ul className="yz-gr__list">
          {records.map((r) => (
            <li key={r.id} className="yz-gr__row">
              <span className="yz-gr__subject">{r.subjectLabel}</span>
              <span className="yz-gr__grade">{r.grade}</span>
              <span className="yz-gr__unit">級分</span>
              <span className="yz-gr__exam">{r.examName}</span>
              <span className="yz-gr__when">{r.examDate.slice(0, 10)}</span>
              <span className={`yz-gr__src${r.source === 'INTERNAL_MOCK' ? ' yz-warn' : ''}`}>
                {r.sourceLabel}
              </span>
              <Button
                variant="quiet"
                busy={del.busy}
                onClick={() =>
                  del.run(async () => {
                    await submitJson(`/api/admission/grades/${r.id}`, { method: 'DELETE' });
                    router.refresh();
                  })
                }
              >
                刪掉
              </Button>
            </li>
          ))}
        </ul>
      )}
      {del.error && <Note tone="warn">{del.error}</Note>}

      {filled && (
        <Note tone="info">
          {filled.backfilled > 0 ? (
            <>
              這一筆把 <b>{filled.backfilled}</b> 份<strong>考試之前</strong>做的預測補上了
              實際級分。<strong>校準曲線就是靠這一步</strong>——沒有它，沒有人知道這套預測
              到底準不準。
            </>
          ) : (
            <>
              目前沒有可以對答案的預測（你在這一科的學測之前沒有存過預測，或是已經對過了）。
              這一筆仍然會被算進之後的預測裡。
            </>
          )}
          {filled.afterExam > 0 && (
            <>
              　另有 <b>{filled.afterExam}</b> 份是<strong>考完之後</strong>才存的，
              <strong>刻意不對答案</strong>：那時候正式級分已經是它的輸入，它必然命中，
              放進校準曲線等於自己給自己打分數。
            </>
          )}
        </Note>
      )}

      {!open ? (
        <div style={{ marginTop: 12 }}>
          <Button variant="primary" onClick={() => setOpen(true)}>
            加一筆級分
          </Button>
        </div>
      ) : (
        <div className="yz-card" style={{ marginTop: 14 }}>
          <Form
            onSubmit={async () => {
              const res = await submitJson<{ backfilled?: number; afterExam?: number }>(
                '/api/admission/grades',
                {
                  json: {
                    subjectCode,
                    examName,
                    examDate,
                    grade: Number(grade),
                    percentile: percentile === '' ? null : Number(percentile),
                    source,
                  },
                },
              );
              setFilled(
                source === 'OFFICIAL_GSAT'
                  ? { backfilled: res.backfilled ?? 0, afterExam: res.afterExam ?? 0 }
                  : null,
              );
              setExamName('');
              setGrade('');
              setPercentile('');
              setOpen(false);
              router.refresh();
            }}
          >
            {({ busy }) => (
              <>
                <h3 className="yz-card__title">加一筆級分</h3>

                <div className="yz-row">
                  <SelectField
                    label="科目"
                    required
                    value={subjectCode}
                    onChange={(e) => setSubjectCode(e.currentTarget.value)}
                  >
                    {subjects.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.label}
                      </option>
                    ))}
                  </SelectField>
                  <TextField
                    label="級分"
                    type="number"
                    min={0}
                    max={15}
                    required
                    value={grade}
                    onChange={(e) => setGrade(e.currentTarget.value)}
                    hint="0 到 15。這一欄是級分不是分數——填成 78 的話整條趨勢都沒有意義。"
                    autoFocus
                  />
                </div>

                <div className="yz-row">
                  <TextField
                    label="考試名稱"
                    required
                    value={examName}
                    onChange={(e) => setExamName(e.currentTarget.value)}
                    hint="例如「115 全模一」「校內第二次模考」。同一科同一個名稱只能有一筆。"
                  />
                  <TextField
                    label="考試日期"
                    type="date"
                    required
                    value={examDate}
                    onChange={(e) => setExamDate(e.currentTarget.value)}
                    hint="趨勢與剩餘時間都靠它。差幾天沒關係，差一年會讓區間寬度差一倍。"
                  />
                </div>

                <SelectField
                  label="這是哪一種考試"
                  required
                  value={source}
                  onChange={(e) => setSource(e.currentTarget.value)}
                  hint={meta?.hint}
                >
                  {sources.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </SelectField>

                {source === 'OFFICIAL_GSAT' && (
                  <Note tone="info">
                    <strong>這一筆會做一件額外的事。</strong>
                    輸入真正的學測級分之後，系統會把同一科的歷次預測全部補上實際成績——
                    <strong>校準曲線靠它</strong>。一個不追蹤自己準確度的預測系統只是在製造
                    好看的數字，而你這一筆就是那個追蹤的來源。
                  </Note>
                )}
                {source === 'INTERNAL_MOCK' && (
                  <Note tone="info">
                    校內模考照樣要輸入，它是真的資料。只是它會讓區間<strong>比較寬</strong>：
                    級距是「前 1% 考生的平均原始分除以 15」，而校內幾十人的模考前 1% 只有
                    一個人——那一個人那天的狀況決定全班的級分。有南模或全模的成績就一起補進來。
                  </Note>
                )}

                <TextField
                  label="全國或全校百分位（成績單上有給就填）"
                  value={percentile}
                  onChange={(e) => setPercentile(e.currentTarget.value)}
                  hint="0 到 100。沒有就空著——它目前只是記錄，不進入預測的計算。"
                />

                <div className="yz-actions">
                  <span className="yz-actions__spacer" />
                  <Button variant="quiet" onClick={() => setOpen(false)} disabled={busy}>
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
      )}
    </>
  );
}
