'use client';

import { useRouter } from 'next/navigation';

import { Button } from '@/components/Button';
import { submitJson, useAction } from '@/components/Form';
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
  describe: string;
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

export default function RefList({ year, refs }: { year: number; refs: Ref[] }) {
  const router = useRouter();
  const del = useAction();

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
          </li>
        ))}
      </ul>
      {del.error && <Note tone="error">{del.error}</Note>}
    </>
  );
}
