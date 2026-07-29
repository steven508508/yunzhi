'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { SelectField, TextField } from '@/components/Field';
import { Form, submitJson, useAction } from '@/components/Form';
import { Note } from '@/components/Feedback';

type Wish = {
  id: string;
  channel: string;
  rank: number;
  institutionName: string;
  programName: string | null;
  starGroup: number | null;
  interestTag: string | null;
};

const CHANNELS: { value: string; label: string }[] = [
  { value: 'SPECIAL', label: '特殊選才' },
  { value: 'STAR', label: '繁星推薦' },
  { value: 'APPLY', label: '個人申請' },
  { value: 'PLACEMENT', label: '分發入學' },
];

const CHANNEL_LABEL: Record<string, string> = Object.fromEntries(
  CHANNELS.map((c) => [c.value, c.label]),
);

/**
 * 志願清單。
 *
 * # 入口是「你想讀什麼」，不是「你能上哪裡」
 *
 * 「興趣理由」這一欄擺在表單裡而不是收在展開區，是規格書 §7.4 的設計
 * 決定：這個模組若把一切簡化成「最大化錄取機率」的最佳化問題，學生會
 * 忘記自己原本想讀什麼。把志向放在第一順位是介面上的事，不是文案上的事。
 *
 * # 系統不替他刪、不替他排、不擋
 *
 * 填了注定衝突的組合照樣存得進去，後果由上方的「規劃的後果」說明。
 * 理由見 `app/api/admission/wishes/route.ts`。
 */
export default function WishList({ year, wishes }: { year: number; wishes: Wish[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState('STAR');
  const [rank, setRank] = useState('1');
  const [institutionName, setInstitutionName] = useState('');
  const [programName, setProgramName] = useState('');
  const [starGroup, setStarGroup] = useState('1');
  const [interestTag, setInterestTag] = useState('');
  const del = useAction();

  const byChannel = CHANNELS.map((c) => ({
    ...c,
    rows: wishes.filter((w) => w.channel === c.value),
  })).filter((c) => c.rows.length > 0);

  return (
    <>
      {byChannel.length === 0 ? (
        <p className="yz-hint">
          還沒有填任何志願。先想「你想讀什麼」再想「你能上哪裡」——
          填進來之後，系統會把各管道之間的排他後果算給你看。
        </p>
      ) : (
        byChannel.map((c) => (
          <div key={c.value} className="yz-adm__group">
            <h3 className="yz-adm__grouphead">
              {c.label}
              <span className="yz-adm__count">{c.rows.length} 個</span>
            </h3>
            <ul className="yz-adm__wishes">
              {c.rows.map((w) => (
                <li key={w.id} className="yz-adm__wish">
                  <span className="yz-adm__wrank">{w.rank}</span>
                  <span className="yz-adm__wname">
                    <b>{w.institutionName}</b>
                    {w.programName ? ` ${w.programName}` : ''}
                    {w.starGroup ? `　第 ${w.starGroup} 類學群` : ''}
                  </span>
                  {w.interestTag && <span className="yz-adm__wtag">{w.interestTag}</span>}
                  <span className="yz-rowacts">
                    <Button
                      variant="quiet"
                      busy={del.busy}
                      onClick={() =>
                        del.run(async () => {
                          await submitJson(
                            `/api/admission/wishes/${w.id}?year=${year}`,
                            { method: 'DELETE' },
                          );
                          router.refresh();
                        })
                      }
                    >
                      刪掉
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      {del.error && <Note tone="error">{del.error}</Note>}

      {!open ? (
        <div style={{ marginTop: 14 }}>
          <Button variant="primary" onClick={() => setOpen(true)}>
            加一個志願
          </Button>
        </div>
      ) : (
        <div className="yz-card" style={{ marginTop: 16 }}>
          <Form
            onSubmit={async () => {
              await submitJson('/api/admission/wishes', {
                json: {
                  year,
                  channel,
                  rank: Number(rank),
                  institutionName,
                  programName: programName || null,
                  starGroup: channel === 'STAR' ? Number(starGroup) : null,
                  interestTag: interestTag || null,
                },
              });
              setInstitutionName('');
              setProgramName('');
              setInterestTag('');
              setOpen(false);
              router.refresh();
            }}
          >
            {({ busy }) => (
              <>
                <div className="yz-row">
                  <SelectField
                    label="管道"
                    value={channel}
                    onChange={(e) => setChannel(e.currentTarget.value)}
                  >
                    {CHANNELS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </SelectField>
                  <TextField
                    label="志願序"
                    type="number"
                    min={1}
                    max={100}
                    value={rank}
                    onChange={(e) => setRank(e.currentTarget.value)}
                    hint={
                      channel === 'APPLY'
                        ? '個人申請至多 6 個。'
                        : channel === 'PLACEMENT'
                          ? '分發入學至多 100 個——這一條是「廣撒加排序」而不是精選。'
                          : undefined
                    }
                  />
                </div>
                <div className="yz-row">
                  <TextField
                    label="大學"
                    required
                    value={institutionName}
                    onChange={(e) => setInstitutionName(e.currentTarget.value)}
                    autoFocus
                  />
                  <TextField
                    label="系（可以先空著）"
                    value={programName}
                    onChange={(e) => setProgramName(e.currentTarget.value)}
                  />
                </div>
                {channel === 'STAR' && (
                  <SelectField
                    label="學群"
                    value={starGroup}
                    onChange={(e) => setStarGroup(e.currentTarget.value)}
                    hint="繁星的競爭是「大學 × 學群」，沒有學群就算不出你在校內的位置。第 8 類是醫學與牙醫。"
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((g) => (
                      <option key={g} value={g}>
                        第 {g} 類學群
                        {g === 8 ? '（醫學、牙醫）' : ''}
                      </option>
                    ))}
                  </SelectField>
                )}
                <TextField
                  label="為什麼想讀這個"
                  value={interestTag}
                  onChange={(e) => setInterestTag(e.currentTarget.value)}
                  hint="寫給自己看的。之後如果你的志願排序完全變成依機率排，這一欄會提醒你原本想讀什麼。"
                />
                <div className="yz-actions">
                  <span className="yz-actions__spacer" />
                  <Button variant="quiet" onClick={() => setOpen(false)} disabled={busy}>
                    取消
                  </Button>
                  <Button type="submit" variant="primary" busy={busy} busyLabel="加進去…">
                    加進去
                  </Button>
                </div>
              </>
            )}
          </Form>
        </div>
      )}

      <p className="yz-hint" style={{ marginTop: 16 }}>
        系統<strong>不會阻止你規劃任何組合</strong>，包括注定互斥的那些。
        它只負責把後果講清楚——那幾條寫在上面。「{CHANNEL_LABEL.STAR}」與「
        {CHANNEL_LABEL.APPLY}」之間的排他規則是本模組最常被誤解的一塊，值得讀完。
      </p>
    </>
  );
}
