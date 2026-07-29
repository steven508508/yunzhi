/**
 * 學生自己的能力分析：我哪裡弱、接下來練什麼。
 *
 * # 為什麼不是一張雷達圖
 *
 * 因為「機率統計掌握度 0.35」對學生沒有用。他看完只知道自己爛，
 * 不知道要做什麼——而下一步才是這一份分析真正要交付的東西。
 * 有用的是這一句：
 *
 *   「機率統計你 7 題錯 5 題，而它的前置『排列組合』你也只有 0.4——
 *     先補排列組合，再回頭練這一個。」
 *
 * 所以每一個知識點都帶著它的前置（走 `KpPrerequisite`）與一句
 * 可行動的建議（`nextStep`，在 `lib/ability.mjs` 那一層，有測試）。
 *
 * # 為什麼資料不足的知識點沒有數字
 *
 * 因為兩題算出來的小數看起來與二十題的一樣精確，而學生會照著它決定
 * 不用複習。**寧可說「還不知道」，也不要給一個站不住的數字。**
 *
 * # 為什麼這一頁不在導覽列上
 *
 * 導覽列的每一項都對應 `lib/nav.ts` 的一條規則，而那個檔案是全系統
 * 唯一一份「角色 ↔ 區域」對照表，改它會動到每一頁的存取判定。
 * 這一頁的入口在檢討頁——學生看完自己錯在哪，那正是他會想知道
 * 「所以我接下來要幹嘛」的那一刻。
 *
 * # 這一頁只看得到自己的
 *
 * 沒有 `?student=` 這種參數。RLS 擋得住別家補習班，擋不住隔壁同學——
 * 而多一個參數就多一個要自己比對 `userId` 的地方。老師要看某一位
 * 學生走 `/classes/[classId]/students/[studentId]`，那邊有帶班的判定。
 */
import Link from 'next/link';

import { studentAbility, abilityReadiness, SOLID, WEAK } from '@/lib/abilityDb';
import { scopedPage } from '@/lib/page';
import { Empty, Note } from '@/components/Feedback';

export const dynamic = 'force-dynamic';

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** 掌握度的長條。純 CSS，與各題答對率同一個做法（見 globals.css 的 .yz-rate）。 */
function Bar({ value }: { value: number }) {
  const low = value < WEAK;
  return (
    <span className={`yz-rate ${low ? 'yz-rate--low' : ''}`} aria-hidden="true">
      <span className="yz-rate__num">{pct(value)}</span>
      <span className="yz-rate__bar">
        <span className="yz-rate__fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
    </span>
  );
}

export default async function AbilityPage() {
  return scopedPage(async (user) => {
    if (user.systemRole !== 'STUDENT') {
      // 老師沒有作答記錄，這一頁對他永遠是空的。與其給一片空白，
      // 不如直接說他要找的東西在哪一頁。
      return (
        <main className="yz-panel">
          <Empty
            title="這一頁是學生看自己的分析"
            hint="老師要看的是某一位學生或某一個班的弱點，那在班級頁裡。"
            action={<Link href="/classes">去班級</Link>}
          />
        </main>
      );
    }

    const [data, readiness] = await Promise.all([studentAbility(user.id), abilityReadiness()]);

    // 空的時候要說得出卡在哪一關——而學生看到的版本不該是一段
    // 「請老師去建知識點」的系統說明，那對他沒有意義也不是他的事。
    if (data.points.length === 0 && data.thin.length === 0) {
      return (
        <main className="yz-panel">
          <div className="yz-panel__head">
            <h1>我的能力分析</h1>
          </div>
          <Empty
            title={data.attempts === 0 ? '還沒有交過任何一份' : '還沒有算出你的章節分析'}
            hint={
              data.attempts === 0
                ? '交出第一份之後，這裡會依章節列出你的強弱，並告訴你接下來該練什麼。'
                : readiness.points === 0 || readiness.taggedQuestions === 0
                  ? `你已經交過 ${data.attempts} 份，但你考過的題目還沒有被歸到章節上，所以這裡還算不出來。老師把題目的單元標好之後就會出現，可以直接問老師。`
                  : `你已經交過 ${data.attempts} 份，但這幾份的題目還沒有掛到章節上。可以問老師這幾個單元的標註。`
            }
            action={
              <Link href="/take" className="yz-btn yz-btn--primary">
                回到我的任務
              </Link>
            }
          />
        </main>
      );
    }

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>我的能力分析</h1>
          <p className="yz-panel__sub">
            依章節（知識點）看你現在的狀況，弱的排在前面。
            {data.subjects.length > 0 && (
              <>
                　·
                {data.subjects
                  .map((s) => `${s.name} ${s.weak > 0 ? `${s.weak} 個要補` : '沒有要補的'}`)
                  .join('　·　')}
              </>
            )}
          </p>
        </div>

        {data.points.length === 0 ? (
          <Note tone="info">
            你的作答還不夠多，每一個章節都還下不了結論。下面列出你碰過的章節與題數——
            <strong>刻意不給掌握度</strong>，因為兩三題算出來的數字看起來很精確，
            但它站不住，而你會照著它決定不用複習。
          </Note>
        ) : (
          <ul className="yz-ability__list">
            {data.points.map((p) => (
              <li key={p.id} className="yz-ability__item">
                <div className="yz-ability__head">
                  <span className="yz-ability__name">{p.name}</span>
                  <span className="yz-ability__subject">{p.subjectName}</span>
                  <Bar value={p.mastery} />
                  <span className="yz-ability__count">
                    {/* 掌握度是算出來的，這一行是數出來的。看得懂的人才信得過。 */}
                    {p.total} 題答對 {p.correct} 題
                  </span>
                  {p.mastery >= SOLID && <span className="yz-ability__tag">穩</span>}
                  {p.mastery < WEAK && <span className="yz-ability__tag yz-warn">要補</span>}
                </div>

                {/* 下一步。這是這一頁真正要交付的東西，所以它不是
                    收在展開區裡的補充說明，而是每一列的主體。 */}
                <p className={`yz-ability__step yz-ability__step--${p.step.kind.toLowerCase()}`}>
                  {p.step.text}
                </p>

                {p.prereqs.length > 0 && (
                  <p className="yz-ability__prereq">
                    前置：
                    {p.prereqs.map((q, i) => (
                      <span key={q.id}>
                        {i > 0 && '、'}
                        {q.name}
                        {q.reliable ? `（${pct(q.mastery)}）` : `（只有 ${q.total} 題，還看不出來）`}
                      </span>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {data.thin.length > 0 && (
          <>
            <h2 className="yz-card__title" style={{ marginTop: 26, marginBottom: 6 }}>
              還看不出來的章節
            </h2>
            <p className="yz-hint">
              這幾個你做過的題數還太少，給不出可靠的結論。<strong>不是</strong>代表你不會，
              也不代表你會——多做幾題（或等下一次考試）之後它們就會移到上面。
            </p>
            <ul className="yz-ability__thin">
              {data.thin.map((p) => (
                <li key={p.id}>
                  <span className="yz-ability__name">{p.name}</span>
                  <span className="yz-ability__subject">{p.subjectName}</span>
                  <span className="yz-ability__count">
                    {p.total} 題答對 {p.correct} 題
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="yz-hint" style={{ marginTop: 20 }}>
          掌握度<strong>不是答對率</strong>。愈久以前的作答算得愈輕——
          所以一個學期沒碰的章節會慢慢往下掉，那不是系統算錯，
          是它在提醒你該回去複習了。難一點的題目答對算得比較重，
          送分題答錯扣得比較多。低於 {pct(WEAK)} 算要補、{pct(SOLID)} 以上算穩。
        </p>
      </main>
    );
  });
}
