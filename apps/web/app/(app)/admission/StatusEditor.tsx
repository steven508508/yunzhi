'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { CheckField, SelectField } from '@/components/Field';
import { Form, submitJson } from '@/components/Form';
import { Note } from '@/components/Feedback';

/**
 * 學生自己維護的管道狀態。
 *
 * # 為什麼繁星是一個下拉選單而不是一個勾選框
 *
 * 因為「錄取類別」與「已放棄」是兩個**正交**的欄位，而類別有三種值。
 * 把它做成「繁星上了沒有」一個勾選框，就是規格書 §5.2 警告的那個
 * 單一列舉的變形——第 3 類與第 8 類的後果完全相反（一個永久封鎖個申，
 * 一個只封鎖登記志願序），而畫面上會長得一模一樣。
 *
 * # 為什麼「已放棄」在類別旁邊而不是底下
 *
 * 因為它們要被一起讀。學生真正需要理解的是「放棄對這一條有沒有用」，
 * 而那件事只有把兩欄擺在同一行才看得出來——放棄了但類別還在。
 */
export default function StatusEditor({
  year,
  profile,
}: {
  year: number;
  profile: {
    isRepeater: boolean;
    sameSchoolAll: boolean;
    specialAdmitted: boolean;
    specialWaived: boolean;
    starCategory: string;
    starWaived: boolean;
    applyAdmitted: boolean;
    applyWaived: boolean;
  };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(profile);
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) =>
    setV((p) => ({ ...p, [k]: value }));

  if (!open) {
    return (
      <div className="yz-adm__editbar">
        <p className="yz-hint">
          下面的判定完全由這幾個狀態算出來。放榜之後回來更新它，資格表會跟著重算。
        </p>
        <Button variant="quiet" onClick={() => setOpen(true)}>
          更新我的狀態
        </Button>
      </div>
    );
  }

  return (
    <div className="yz-card" style={{ marginBottom: 20 }}>
      <Form
        onSubmit={async () => {
          await submitJson('/api/admission/profile', { json: { year, ...v } });
          setOpen(false);
          router.refresh();
        }}
      >
        {({ busy }) => (
          <>
            <h2 className="yz-card__title">我的升學狀態</h2>

            <fieldset className="yz-fieldset">
              <legend>身分（影響繁星資格）</legend>
              <CheckField
                label="我不是應屆畢業生"
                checked={v.isRepeater}
                onChange={(e) => set('isRepeater', e.currentTarget.checked)}
                hint="繁星推薦限應屆。這一項不是放棄任何管道能改變的。"
              />
              <CheckField
                label="我高中三年全程就讀同一所學校，沒有轉學"
                checked={v.sameSchoolAll}
                onChange={(e) => set('sameSchoolAll', e.currentTarget.checked)}
                hint="繁星推薦的硬性條件。轉學過就沒有繁星資格，這一項無法補救。"
              />
            </fieldset>

            <fieldset className="yz-fieldset">
              <legend>特殊選才（學測前放榜）</legend>
              <CheckField
                label="我已經錄取特殊選才"
                checked={v.specialAdmitted}
                onChange={(e) => set('specialAdmitted', e.currentTarget.checked)}
                hint="錄取且未放棄的話，後續三個管道（繁星、個人申請、分發入學）全部不能報名。"
              />
              <CheckField
                label="我已經完成放棄"
                checked={v.specialWaived}
                onChange={(e) => set('specialWaived', e.currentTarget.checked)}
                hint="放棄之後三個管道的資格都會回來。"
              />
            </fieldset>

            <fieldset className="yz-fieldset">
              <legend>繁星推薦（3 月中放榜）</legend>
              <div className="yz-row">
                <SelectField
                  label="錄取類別"
                  value={v.starCategory}
                  onChange={(e) => set('starCategory', e.currentTarget.value)}
                  hint="第 1-7 類與第 8 類的後果完全不同，所以這裡問的是類別而不是「上了沒有」。"
                >
                  <option value="NONE">沒有錄取繁星</option>
                  <option value="GROUP_1_7">第 1 至 7 類</option>
                  <option value="GROUP_8">第 8 類（醫學、牙醫）</option>
                </SelectField>
                <div>
                  <CheckField
                    label="我已經完成放棄"
                    checked={v.starWaived}
                    onChange={(e) => set('starWaived', e.currentTarget.checked)}
                    hint="放棄之後分發入學的資格會回來，但個人申請不會。"
                  />
                </div>
              </div>
              {v.starCategory !== 'NONE' && v.starWaived && (
                <Note tone="warn">
                  放棄之後<strong>類別會留著</strong>，因為個人申請的封鎖看的是錄取類別而不是
                  有沒有放棄。系統刻意不把它清空——清空了就再也分不出你原本是第 3 類還是
                  第 8 類，而那兩者的後果相反。
                </Note>
              )}
            </fieldset>

            <fieldset className="yz-fieldset">
              <legend>個人申請（5 月統一分發）</legend>
              <CheckField
                label="我已經被統一分發錄取"
                checked={v.applyAdmitted}
                onChange={(e) => set('applyAdmitted', e.currentTarget.checked)}
              />
              <CheckField
                label="我已經完成放棄"
                checked={v.applyWaived}
                onChange={(e) => set('applyWaived', e.currentTarget.checked)}
                hint="放棄之後分發入學的資格恢復。但放棄有期限（每年 6 月中的四天），錯過就不能走分發。"
              />
            </fieldset>

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
