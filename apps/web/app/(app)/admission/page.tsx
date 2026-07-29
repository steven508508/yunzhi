/**
 * 升學規劃：學生看自己的管道資格、志願、繁星校內位置與補救清單。
 *
 * # 為什麼資格表照「時序」排而不是照重要性
 *
 * 因為前面每一步的結果都會封鎖後面。特選在學測前放榜、繁星 3 月中、
 * 個申 5 月、分發 7 月——照時序排，畫面本身就在講「你現在在哪一格、
 * 接下來哪幾條路還開著」。照重要性排（例如把個申放第一，因為名額最多）
 * 會讓學生讀不出封鎖關係，而那正是這一頁存在的理由。
 *
 * # 為什麼「不能報名」旁邊一定要有一句話
 *
 * 因為學生看到「不可報名個人申請」的第一個反應是「那我放棄繁星不就
 * 好了」。而繁星第 1-7 類對個申的封鎖看的是**錄取類別**，放棄完全
 * 沒有用——這是本模組最貴的一個誤解，也是輔導價值最高的一句話。
 * 所以每一個封鎖都帶著 `remedy`（放棄有沒有用）一起顯示。
 *
 * # 為什麼落點機率的位置擺著一段「我們不做」
 *
 * 因為學生一定會找它。坊間工具都給得出一個百分比，這裡沒有的話，
 * 他會以為是還沒算完然後一直等。與其留白，不如明說資料為什麼取不到——
 * 那段文字在 `lib/admission.mjs` 的 `NOT_OFFERED`，與規則同一個檔案，
 * 有測試釘著它不能被改成「暫不支援」。
 */
import Link from 'next/link';

import { NOT_OFFERED } from '@/lib/admission.mjs';
import {
  admissionStatus,
  admissionYearOf,
  isStarCoordinator,
  myAcademicRank,
  myStarPosition,
  studyPlan,
} from '@/lib/admissionDb';
import { scopedPage } from '@/lib/page';
import { Empty, Note } from '@/components/Feedback';

import { Emph } from './Emph';
import StatusEditor from './StatusEditor';
import WishList from './WishList';

export const dynamic = 'force-dynamic';

const REMEDY_TAG: Record<string, string> = {
  WAIVE_SPECIAL: '放棄特選可解除',
  WAIVE_STAR: '放棄繁星可解除',
  WAIVE_APPLY: '放棄個申可解除',
  NONE: '放棄也無法解除',
};

export default async function AdmissionPage() {
  return scopedPage(async (user) => {
    const year = admissionYearOf();

    // ── 老師與管理員：這一頁對他們永遠是空的 ────────────────────
    //
    // 與其給一片空白，不如直接說他要找的東西在哪一頁。
    // （做法與 `/ability` 那一頁相同。）
    if (user.systemRole !== 'STUDENT') {
      return (
        <main className="yz-panel">
          <div className="yz-panel__head">
            <h1>升學輔導</h1>
            <p className="yz-panel__sub">{year} 學年度</p>
          </div>
          <Empty
            title="這一頁是學生看自己的升學規劃"
            hint={
              isStarCoordinator(user)
                ? '你是繁星承辦（校務管理員）。全校的繁星校內競爭分布與在校成績百分比的匯入在下一頁。'
                : '老師要看的是所帶班級的升學狀況，那在班級頁的升學總覽裡。'
            }
            action={
              isStarCoordinator(user) ? (
                <Link href="/admission/star" className="yz-btn yz-btn--primary">
                  去繁星全校檢視
                </Link>
              ) : (
                <Link href="/classes">去班級</Link>
              )
            }
          />
        </main>
      );
    }

    const [status, star, rank, plan] = await Promise.all([
      admissionStatus(user.id, year),
      myStarPosition(user.id, year),
      myAcademicRank(user.id, year),
      studyPlan(user.id),
    ]);

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>我的升學規劃</h1>
          <p className="yz-panel__sub">
            {year} 學年度 · 依時序排列：特選 → 繁星 → 個人申請 → 分發入學。
            前面每一步的結果都會影響後面能不能走。
          </p>
        </div>

        <StatusEditor year={year} profile={status.profile} />

        {/* ── 管道資格 ─────────────────────────────────────── */}
        <h2 className="yz-card__title">我現在能報什麼</h2>
        <ul className="yz-adm__rules">
          {status.eligibility.map((e) => (
            <li key={e.key} className={`yz-adm__rule ${e.ok ? '' : 'yz-adm__rule--no'}`}>
              <div className="yz-adm__rulehead">
                <span className="yz-adm__mark" aria-hidden="true">
                  {e.ok ? '可' : '否'}
                </span>
                <span className="yz-adm__rulename">{e.label}</span>
                <span className="yz-adm__when">{e.when}</span>
              </div>
              {e.blockers.map((b) => (
                <p key={b.code} className="yz-adm__why">
                  <span
                    className={`yz-adm__remedy ${
                      b.remedy === 'NONE' ? 'yz-adm__remedy--none' : ''
                    }`}
                  >
                    {REMEDY_TAG[b.remedy]}
                  </span>
                  <Emph text={b.text} />
                </p>
              ))}
            </li>
          ))}
        </ul>
        <p className="yz-hint">
          這一份只判<strong>管道層級</strong>的資格。各校系自己的門檻（繁星的五學期百分比
          達標、學測檢定標準）本系統<strong>判定不了</strong>——那需要逐校系的簡章資料，
          而歷年篩選與檢定資料無法合法取得（見下方）。不要把「可以報名」讀成「符合這個
          校系的門檻」。
        </p>

        {/* ── 規劃的後果 ───────────────────────────────────── */}
        {status.conflicts.length > 0 && (
          <>
            <h2 className="yz-card__title" style={{ marginTop: 26 }}>
              規劃的後果
            </h2>
            <ul className="yz-adm__conflicts">
              {status.conflicts.map((c) => (
                <li
                  key={c.code}
                  className={`yz-adm__conflict yz-adm__conflict--${c.severity.toLowerCase()}`}
                >
                  <span className="yz-adm__sev">
                    {c.severity === 'BLOCK' ? '現在就不成立' : '將來會互斥'}
                  </span>
                  <Emph text={c.text} />
                </li>
              ))}
            </ul>
            <p className="yz-hint">
              系統<strong>不會擋下任何一種規劃</strong>。上面這幾條不是錯誤訊息，是後果——
              你仍然可以照你想的方式填，只要知道會發生什麼。
            </p>
          </>
        )}

        {/* ── 志願 ─────────────────────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 26 }}>
          我的志願
        </h2>
        <WishList year={year} wishes={status.wishes} />

        {/* ── 繁星校內位置 ─────────────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 30 }}>
          繁星：我在校內的位置
        </h2>
        {star.noGroup && (
          <Note tone="warn">
            你有繁星志願沒有選學群，所以排不出位置。繁星的競爭是「大學 × 學群」——
            回到上面把學群補上就會出現。
          </Note>
        )}
        {star.unranked ? (
          <Note tone="info">
            教務處還沒有匯入你的五學期在校成績百分比，所以還算不出你的校內位置。
            這是教務處那一側的作業，可以問導師。
          </Note>
        ) : star.positions.length === 0 ? (
          <p className="yz-hint">
            填了繁星志願（含學群）之後，這裡會告訴你<strong>校內</strong>有多少同學想推同一個
            位置、你排第幾。這一份資料只有學校自己有——坊間工具查得到全國競爭，
            查不到「你想推的那個位置校內已經有三位百分比比你好的同學想推」。
          </p>
        ) : (
          <ul className="yz-adm__positions">
            {star.positions.map((p) => (
              <li key={`${p.institutionName}-${p.starGroup}`} className="yz-adm__pos">
                <div className="yz-adm__poshead">
                  <span className="yz-adm__posname">
                    {p.institutionName}　第 {p.starGroup} 類學群
                  </span>
                  {p.hidden ? (
                    <span className="yz-adm__order yz-adm__order--hidden">
                      {p.isFirst ? '校內第 1 位' : '不是校內第 1 位'}
                    </span>
                  ) : (
                    <span className="yz-adm__order">
                      校內第 <b>{p.order}</b> 位
                    </span>
                  )}
                  <span className={`yz-adm__tag ${p.nominated ? '' : 'yz-warn'}`}>
                    {p.nominated ? `在校內推薦名單內（每個位置 ${p.quota} 名）` : '目前在推薦名單之外'}
                  </span>
                </div>

                {p.hidden && (
                  <p className="yz-adm__why">
                    這個位置想推的人很少，所以<strong>刻意不顯示具體名次</strong>——
                    人數少的時候，一個名次就足以讓你推知另一位同學是誰。
                  </p>
                )}

                {p.tied && (
                  <p className="yz-adm__why">
                    有同學與你的在校百分比<strong>完全相同</strong>。真的同分時是由學校的
                    推薦辦法決定順序，不是系統決定——上面那個名次在這種情況下不算定案。
                  </p>
                )}

                {p.firstRound ? (
                  <p className="yz-adm__step">
                    你是這個位置的推薦序 1，取得<strong>第一輪</strong>資格。
                  </p>
                ) : (
                  <p className="yz-adm__step">
                    第一輪只有推薦序 1 參加，所以你這一輪不參賽。
                  </p>
                )}

                {p.crossGroupNote && (
                  <p className="yz-adm__why">
                    <Emph text={p.crossGroupNote} />
                  </p>
                )}

                {p.sensitivity && (
                  <p className="yz-adm__sens">
                    {p.sensitivity.ifOneAheadLeaves && (
                      <>{p.sensitivity.ifOneAheadLeaves.text}</>
                    )}
                    {p.sensitivity.ifOneBetterJoins.text}
                    <span className="yz-adm__senshint">
                      名次會隨同學改志願而變動，所以這裡同時給兩個方向——
                      一個精確但脆弱的數字，不如一個說得出它有多脆弱的。
                    </span>
                  </p>
                )}

                <p className="yz-adm__why">
                  <Emph text={p.secondRoundNote} />
                </p>
              </li>
            ))}
          </ul>
        )}
        {rank && (
          <p className="yz-hint">
            你的五學期在校成績全校百分比是 <b>{rank.percentile}%</b>（越小越好，
            採計 {rank.semesters} 學期）。
            <strong>畫面上不會出現任何其他同學的百分比或人數</strong>——校內排序在伺服器端
            算完，只把你自己的序位傳過來。
          </p>
        )}

        {/* ── 讀書計畫 ─────────────────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 30 }}>
          接下來補哪幾塊最值得
        </h2>
        {plan.items.length === 0 ? (
          <p className="yz-hint">
            {plan.attempts === 0
              ? '交出第一份作答之後，這裡會依「弱點程度 × 學測權重」排出最值得補的幾個章節。'
              : `你已經交過 ${plan.attempts} 份，但還沒有任何章節累積到足以下結論的題數。多做幾題之後這份清單就會出現。`}
          </p>
        ) : (
          <>
            <ol className="yz-adm__plan">
              {plan.items.map((it) => (
                <li key={it.id} className="yz-adm__planitem">
                  <span className="yz-adm__subject">{it.subjectName}</span>
                  <span className="yz-adm__action">{it.action}</span>
                  <Link href="/ability" className="yz-adm__go">
                    看這一科的完整分析
                  </Link>
                </li>
              ))}
            </ol>
            <p className="yz-hint">
              排序是「還沒學會的部分 × 學測權重」，不是單純由弱到強——
              一個掌握度 0.9 但權重 2.0 的章節，補起來只值 0.2；一個 0.3 但權重 1.0 的值 0.7。
              直覺會挑前者。共 {plan.total} 個章節有足夠資料，這裡列最值得的幾個。
              {plan.thin.length > 0 && `另有 ${plan.thin.length} 個章節題數還太少，先不列。`}
            </p>
          </>
        )}

        {/* ── 明確不做的事 ─────────────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 30 }}>
          本系統不做的幾件事
        </h2>
        <p className="yz-hint">
          這一段刻意寫出來。坊間工具給得出這些數字，而這裡沒有——
          <strong>不是還沒算完，是資料不存在或無法合法取得</strong>。
          給一個沒有根據的百分比比不給更糟，因為你會照著它做決定。
        </p>
        <dl className="yz-adm__nope">
          {NOT_OFFERED.map((n) => (
            <div key={n.key}>
              <dt>{n.title}</dt>
              <dd>{n.body}</dd>
            </div>
          ))}
        </dl>
      </main>
    );
  });
}
