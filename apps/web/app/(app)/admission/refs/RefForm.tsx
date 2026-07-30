'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { REF_KINDS, SOURCE_KINDS } from '@/lib/admissionRef.mjs';
import { whereToLookFor } from '@/lib/admissionSources.mjs';
import { Button } from '@/components/Button';
import { SelectField, TextField } from '@/components/Field';
import { Form, submitJson } from '@/components/Form';
import { Note } from '@/components/Feedback';

/**
 * 輸入一筆自己查到的資料。
 *
 * # 三個欄位刻意是必填的，而它們不是資料庫要求的
 *
 * `sourceKind`（來源類型）、`sourceRef`（從哪裡查到的）、`lookedUpAt`
 * （查到的日期）。schema 上它們是 NOT NULL，但真正的理由是輔導上的：
 * **一個沒有來源的數字，三個月後與一個有來源的長得一模一樣**，而學生會
 * 照著它決定要不要填志願。
 *
 * # 來源選單裡一定要有「聽同學說的」，而且它的文案要好選
 *
 * 不給那個選項的話，學生會選「官方文件」——他手上就是有一個數字，而選單
 * 裡沒有一個選項描述得出它的來歷。那筆資料從此帶著一個假的可信度，
 * 而且再也分不出來。**誠實要比較好選，才會有人選。** 所以選了 HEARSAY
 * 之後畫面上出現的不是警告，是一句「這樣填是對的」。
 *
 * # 為什麼日期預設是今天而不是空的
 *
 * 因為絕大多數人是查完立刻輸入。預設空的話，這一欄會變成一個障礙，
 * 而障礙的結局是有人隨便填一個。預設今天、可以改。
 *
 * # 為什麼「這一筆屬於哪一個學年度」與「今年」是兩個不同的東西
 *
 * 因為他查的是**歷年**門檻。把它預設成今年的話，三筆 112、113、114 的
 * 資料會全部被記成 115 學年度，於是「只有一年的資料」的偵測失效，
 * 而畫面上看起來他查了三年。
 */

type Kind = (typeof REF_KINDS)[number];

const kindOf = (v: string): Kind | undefined => REF_KINDS.find((k) => k.value === v);

const today = () => new Date().toISOString().slice(0, 10);

export default function RefForm({ year }: { year: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('STAR_ROUND1');
  const [refYear, setRefYear] = useState(String(year - 1));
  const [institutionName, setInstitutionName] = useState('');
  const [programName, setProgramName] = useState('');
  const [starGroup, setStarGroup] = useState('');
  const [percentile, setPercentile] = useState('');
  const [count, setCount] = useState('');
  const [subjects, setSubjects] = useState('');
  const [grades, setGrades] = useState('');
  const [rules, setRules] = useState('');
  const [text, setText] = useState('');
  const [sourceKind, setSourceKind] = useState('OFFICIAL_DOC');
  const [sourceRef, setSourceRef] = useState('');
  const [lookedUpAt, setLookedUpAt] = useState(today());
  const [note, setNote] = useState('');

  const meta = kindOf(kind);
  const guide = whereToLookFor(kind, year);
  const isMine = kind === 'MY_PERCENTILE';

  if (!open) {
    return (
      <div style={{ marginTop: 14 }}>
        <Button variant="primary" onClick={() => setOpen(true)}>
          加一筆我查到的資料
        </Button>
      </div>
    );
  }

  const raw: Record<string, unknown> =
    meta?.shape === 'percentile'
      ? { percentile }
      : meta?.shape === 'count'
        ? { count }
        : meta?.shape === 'sieve'
          ? { subjects, grades }
          : meta?.shape === 'rules'
            ? { rules }
            : { text };

  return (
    <div className="yz-card" style={{ marginTop: 16 }}>
      <Form
        onSubmit={async () => {
          await submitJson('/api/admission/refs', {
            json: {
              // **這一筆屬於哪一個學年度**，不是今年。他查的是歷年門檻。
              year: Number(refYear),
              channel: kind.startsWith('STAR') ? 'STAR' : kind === 'SIEVE_THRESHOLD' ? 'APPLY' : 'STAR',
              kind,
              institutionName: isMine ? '本校' : institutionName,
              programName: programName || null,
              starGroup: starGroup ? Number(starGroup) : null,
              raw,
              sourceKind,
              sourceRef,
              lookedUpAt,
              note: note || null,
            },
          });
          setInstitutionName('');
          setProgramName('');
          setPercentile('');
          setCount('');
          setSubjects('');
          setGrades('');
          setRules('');
          setText('');
          setSourceRef('');
          setNote('');
          setOpen(false);
          router.refresh();
        }}
      >
        {({ busy }) => (
          <>
            <h3 className="yz-card__title">我查到了什麼</h3>

            <SelectField
              label="資料種類"
              value={kind}
              onChange={(e) => setKind(e.currentTarget.value)}
              hint={meta?.hint}
            >
              {REF_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </SelectField>

            {guide && (
              <Note tone="info">
                這一項的查法在上面清單的「{guide.title}」（{guide.when}）。
                {guide.where[0]?.url ? (
                  <>
                    {'　'}
                    <a href={guide.where[0].url} target="_blank" rel="noreferrer noopener">
                      直接開那一頁 ↗
                    </a>
                  </>
                ) : (
                  '　這一項網路上查不到，要問教務處。'
                )}
              </Note>
            )}

            <div className="yz-row">
              <TextField
                label="這一筆是哪一個學年度的（民國）"
                type="number"
                min={100}
                max={200}
                required
                value={refYear}
                onChange={(e) => setRefYear(e.currentTarget.value)}
                hint={
                  `不是今年（${year}），是這個數字本身所屬的學年度。` +
                  '歷年門檻要一年填一筆，全部記成今年的話就看不出趨勢了。'
                }
              />
              {!isMine && (
                <TextField
                  label="大學"
                  required
                  value={institutionName}
                  onChange={(e) => setInstitutionName(e.currentTarget.value)}
                  hint="與你志願上填的寫法一致最好。「臺」與「台」系統認得是同一所，「台大」不會。"
                  autoFocus
                />
              )}
            </div>

            {!isMine && (
              <div className="yz-row">
                <TextField
                  label="系（可以空著）"
                  value={programName}
                  onChange={(e) => setProgramName(e.currentTarget.value)}
                />
                <SelectField
                  label="學群（繁星，可以空著）"
                  value={starGroup}
                  onChange={(e) => setStarGroup(e.currentTarget.value)}
                  hint="簡章上沒有分學群的話就空著——空著照樣掛得上你的志願，只是會標「這一筆沒有學群」。"
                >
                  <option value="">不指定</option>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((g) => (
                    <option key={g} value={g}>
                      第 {g} 類學群{g === 8 ? '（醫學、牙醫）' : ''}
                    </option>
                  ))}
                </SelectField>
              </div>
            )}

            {/* ── 值：形狀依 kind 而不同 ────────────────────── */}
            {meta?.shape === 'percentile' && (
              <TextField
                label={isMine ? '我的在校成績全校排名百分比' : '最後一名錄取者的在校百分比'}
                required
                value={percentile}
                onChange={(e) => setPercentile(e.currentTarget.value)}
                hint="0 至 100，越小越好。填 15.2 或 15.2% 都可以。這一欄不是 PR 值。"
                autoFocus={isMine}
              />
            )}
            {meta?.shape === 'count' && (
              <TextField
                label="缺額（名）"
                type="number"
                min={0}
                required
                value={count}
                onChange={(e) => setCount(e.currentTarget.value)}
                hint="第一輪之後的缺額。有缺額才有第二輪。"
              />
            )}
            {meta?.shape === 'sieve' && (
              <div className="yz-row">
                <TextField
                  label="篩選科目（依序，用、分隔）"
                  required
                  value={subjects}
                  onChange={(e) => setSubjects(e.currentTarget.value)}
                  hint="例如「國文、英文、數學A」。順序照簡章寫的順序。"
                />
                <TextField
                  label="對應的級分"
                  required
                  value={grades}
                  onChange={(e) => setGrades(e.currentTarget.value)}
                  hint="例如「13、12、11」。數量要與科目一樣多。"
                />
              </div>
            )}
            {meta?.shape === 'rules' && (
              <TextField
                label="門檻或檢定標準"
                required
                value={rules}
                onChange={(e) => setRules(e.currentTarget.value)}
                hint="照簡章寫的抄。例如「在校成績前 20%、數A均標、英文前標」。"
              />
            )}
            {meta?.shape === 'text' && (
              <TextField
                label="要記的內容"
                required
                value={text}
                onChange={(e) => setText(e.currentTarget.value)}
                hint="例如校內推薦辦法的重點、承辦老師交代的事。"
              />
            )}

            {isMine && (
              <Note tone="info">
                你自己輸入的在校百分比<strong>只用於你自己的建議</strong>。它
                <strong>不會進入校內賽局模擬</strong>，也
                <strong>不會影響任何其他同學看到的序位</strong>——因為如果會，你少打一個
                小數點就會讓別人看到錯的位置，而他完全不會知道。模擬用的是
                <strong>教務處匯入的那一份</strong>。
              </Note>
            )}

            {/* ── 來源：這三欄是這張表存在的理由 ─────────────── */}
            <fieldset className="yz-fieldset">
              <legend>這筆資料是怎麼來的（必填）</legend>

              <SelectField
                label="來源類型"
                required
                value={sourceKind}
                onChange={(e) => setSourceKind(e.currentTarget.value)}
                hint={SOURCE_KINDS.find((s) => s.value === sourceKind)?.hint}
              >
                {SOURCE_KINDS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </SelectField>

              {sourceKind === 'HEARSAY' && (
                <Note tone="info">
                  <strong>這樣填是對的。</strong>
                  聽同學說的就選這一個——它不會被扣分，只會讓這筆資料標成「只能當線索」，
                  而那才是它真正的份量。選「官方文件」的話，三個月後你自己也分不出來這個
                  數字是查到的還是聽到的。
                </Note>
              )}

              <TextField
                label="從哪裡查到的"
                required
                value={sourceRef}
                onChange={(e) => setSourceRef(e.currentTarget.value)}
                hint={
                  sourceKind === 'OFFICIAL_DOC'
                    ? '貼網址，或寫文件名稱（例如「115 學年度繁星推薦招生簡章 p.42」）。'
                    : sourceKind === 'SCHOOL_OFFICE'
                      ? '寫是誰給的（例如「教務處 陳老師」或「校內繁星實施計畫」）。'
                      : sourceKind === 'HEARSAY'
                        ? '寫聽誰說的、在哪裡看到的。'
                        : '寫得出來的都好——三個月後的你會需要它。'
                }
              />

              <TextField
                label="查到的日期"
                type="date"
                required
                value={lookedUpAt}
                onChange={(e) => setLookedUpAt(e.currentTarget.value)}
                hint="招生資料一年全部重來一次，所以「什麼時候查的」與「查到什麼」一樣重要。"
              />
            </fieldset>

            <TextField
              label="備註（可以空著）"
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
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
  );
}
