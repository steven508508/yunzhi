/**
 * 繁星承辦人的全校檢視。
 *
 * # 承辦人要知道的不是「照現在填的會怎樣」，而是「這件事會不會亂」
 *
 * 所以這一頁的資訊層級是：**過度集中**排最前面（五個人擠在同一個位置，
 * 而校內只能推 2 名），然後是**沒用完的名額**與**完全無人推薦的學群**
 * ——後者是白白放棄一個機會，而且不會有任何人來反映，因為沒有人受害。
 *
 * 全校推薦名單的完整排序反而排在最後：它是結論，而承辦人真正需要提早
 * 處理的是上面那幾件事。名單送出前才發現全校擠在同一所大學，那時已經
 * 沒有協調的時間了。
 *
 * # 為什麼跨學群排擠要單獨列一區
 *
 * 因為它是這整套規則裡最容易被誤解的一條。「每所高中在每一所大學，
 * 第 1 至 3 類**合計錄取** 1 名」是**結果端**的約束——那幾位學生
 * **都會進第一輪**、都與全國其他高中的推薦序 1 競爭，只是最後最多一位
 * 上榜。承辦人若把它讀成參賽端（以為只能推一位），就會在名單階段
 * 自己先砍掉一個機會。
 *
 * # 這一頁看得到全校的相對名次，所以每一次進來都寫稽核
 *
 * 稽核在 `starCoordinatorReport()` 裡。規格書 §3 把這個權限列為
 * 「全校最敏感的權限之一」。
 */
import Link from 'next/link';

import { admissionYearOf, isStarCoordinator, starCoordinatorReport } from '@/lib/admissionDb';
import { scopedPage } from '@/lib/page';
import { Denied, Note } from '@/components/Feedback';

import RankImport from './RankImport';

export const dynamic = 'force-dynamic';

export default async function StarSchoolPage() {
  return scopedPage(async (user) => {
    if (!isStarCoordinator(user)) {
      return (
        <main className="yz-panel">
          <Denied
            what="繁星全校檢視"
            why={
              <>
                這一頁一次就露出全校每一位學生的相對名次，所以只有校務管理員（繁星承辦）
                進得來。<strong>系統管理員刻意也不在名單裡</strong>——那個角色的用途是維運
                而不是業務，而規格書把在校成績百分比列為全校最敏感的資料。
                {user.systemRole === 'STUDENT' && (
                  <>
                    　你自己在繁星的校內位置在<Link href="/admission">升學規劃</Link>那一頁。
                  </>
                )}
              </>
            }
          />
        </main>
      );
    }

    const year = admissionYearOf();
    const { report, nameOf } = await starCoordinatorReport(year, user);
    const who = (id: string) => {
      const u = nameOf[id];
      return u ? `${u.displayName}（${u.username}）` : id;
    };
    const group = (g: number) => `第 ${g} 類`;

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>繁星推薦：全校校內競爭</h1>
          <p className="yz-panel__sub">
            {year} 學年度 · {report.totals.students} 位學生 · {report.totals.positions} 個
            「大學 × 學群」位置 · 校內推薦 {report.totals.nominated} 名 · 第一輪參賽{' '}
            {report.totals.firstRound} 名
          </p>
        </div>

        <Note tone="info">
          這份結果算於 {new Date(report.computedAt).toLocaleString('zh-TW')}，
          依<strong>當下的志願意向</strong>。任何一位學生改志願，全校的排序就變了——
          這個功能的存在本身會改變它的輸入（學生看到「改推成大你是第 1 位」就會去改）。
          所以送名單前請重新整理一次，不要用昨天列印的版本。
        </Note>

        {/* ── 一、過度集中 ─────────────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 24 }}>
          競爭過度集中的位置
        </h2>
        {report.crowded.length === 0 ? (
          <p className="yz-hint">沒有任何位置的人數超過校內推薦名額。</p>
        ) : (
          <ul className="yz-adm__crowd">
            {report.crowded.map((c) => (
              <li key={`${c.institutionName}-${c.starGroup}`}>
                <span className="yz-adm__posname">
                  {c.institutionName}　{group(c.starGroup)}
                </span>
                <span className="yz-adm__num">
                  {c.cohort} 人想推 / 名額 {c.quota}
                </span>
                <span className="yz-adm__tag yz-warn">{c.squeezedOut} 人擠不進去</span>
              </li>
            ))}
          </ul>
        )}

        {/* ── 二、白白放棄的機會 ───────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 26 }}>
          沒用完的推薦名額
        </h2>
        <p className="yz-hint">
          校內沒人推薦等於<strong>白白放棄一個機會</strong>，而且不會有任何人來反映——
          沒有人受害，所以沒有人知道。
        </p>
        {report.unused.length === 0 ? (
          <p className="yz-hint">每一個有人關注的位置都推滿了。</p>
        ) : (
          <ul className="yz-adm__crowd">
            {report.unused.map((c) => (
              <li key={`${c.institutionName}-${c.starGroup}`}>
                <span className="yz-adm__posname">
                  {c.institutionName}　{group(c.starGroup)}
                </span>
                <span className="yz-adm__num">
                  {c.cohort} 人想推，還空 {c.unusedSlots} 個名額
                </span>
              </li>
            ))}
          </ul>
        )}

        {report.empty.length > 0 && (
          <>
            <h3 className="yz-adm__grouphead" style={{ marginTop: 18 }}>
              完全無人推薦的學群
            </h3>
            <p className="yz-hint">
              只列出<strong>校內已經有人關注的大學</strong>。全國所有大學列不出來——
              本系統沒有校系資料庫（見升學規劃頁的「本系統不做的幾件事」）。
            </p>
            <ul className="yz-adm__crowd">
              {report.empty.map((e) => (
                <li key={e.institutionName}>
                  <span className="yz-adm__posname">{e.institutionName}</span>
                  <span className="yz-adm__num">
                    {e.starGroup.map(group).join('、')} 校內沒有人推薦
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* ── 三、結果端排擠 ───────────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 26 }}>
          同一大學的跨學群排擠（結果端）
        </h2>
        <p className="yz-hint">
          「每所高中在每一所大學，第 1 至 3 類合計錄取 1 名」是<strong>結果端</strong>的約束，
          <strong>不是參賽端</strong>。下面這幾位<strong>都會進第一輪</strong>、都與全國其他
          高中的推薦序 1 競爭，只是最後該校在那所大學最多一位上榜。
          不要在名單階段自己先砍掉一位——被砍掉的那一位完全可能就是會上榜的那個。
        </p>
        {report.squeeze.length === 0 ? (
          <p className="yz-hint">目前沒有任何一所大學出現跨學群的排擠。</p>
        ) : (
          <ul className="yz-adm__crowd">
            {report.squeeze.map((s) => (
              <li key={`${s.institutionName}-${s.set}`}>
                <span className="yz-adm__posname">
                  {s.institutionName}　{s.set}
                </span>
                <span className="yz-adm__num">
                  {s.members.length} 位推薦序 1，合計錄取上限 {s.admitLimit}
                </span>
                <span className="yz-adm__members">
                  {s.members.map((m) => `${who(m.userId)}／${group(m.starGroup)}`).join('、')}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* ── 四、要處理的資料問題 ─────────────────────────── */}
        {(report.unranked.length > 0 || report.noGroup.length > 0 || report.dropped.length > 0) && (
          <>
            <h2 className="yz-card__title" style={{ marginTop: 26 }}>
              要先處理的幾件事
            </h2>
            <ul className="yz-adm__crowd">
              {report.unranked.length > 0 && (
                <li>
                  <span className="yz-adm__posname">沒有在校成績百分比</span>
                  <span className="yz-adm__num">{report.unranked.length} 位</span>
                  <span className="yz-adm__members">
                    {report.unranked.map((u) => who(u.userId)).join('、')}
                  </span>
                </li>
              )}
              {report.noGroup.length > 0 && (
                <li>
                  <span className="yz-adm__posname">繁星志願沒有選學群</span>
                  <span className="yz-adm__num">{report.noGroup.length} 位</span>
                  <span className="yz-adm__members">
                    {report.noGroup.map((u) => who(u.userId)).join('、')}
                  </span>
                </li>
              )}
              {report.dropped.length > 0 && (
                <li>
                  <span className="yz-adm__posname">填了超過一個「大學 × 學群」</span>
                  <span className="yz-adm__num">{report.dropped.length} 個志願不會成立</span>
                  <span className="yz-adm__members">
                    {report.dropped
                      .map((d) => `${who(d.userId)}／${d.institutionName} ${group(d.starGroup)}`)
                      .join('、')}
                  </span>
                </li>
              )}
            </ul>
            <p className="yz-hint">
              每生限被推薦至<strong>一所大學的一個學群</strong>，所以多填的那幾個不是備選，
              是不存在。要通知學生本人——他多半以為填了兩個就是多一次機會。
            </p>
          </>
        )}

        {/* ── 五、推薦名單草案 ─────────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 26 }}>
          校內推薦名單草案
        </h2>
        <p className="yz-hint">
          依在校百分比排序。<strong>本系統不估任何錄取機率</strong>——全國比序需要各校系
          歷年的第一輪錄取標準，而官方公布的只有最後一名錄取者的百分比，
          第一輪名額常常只有 1 至 3 名，每年只有一個極值資料點。位置是數出來的，
          機率是編出來的。
        </p>
        {report.positions.length === 0 ? (
          <p className="yz-hint">還沒有學生填繁星志願（或還沒有匯入在校成績百分比）。</p>
        ) : (
          <div className="yz-adm__draft">
            {report.positions.map((p) => (
              <div key={p.key} className="yz-adm__draftpos">
                <h3 className="yz-adm__grouphead">
                  {p.institutionName}　{group(p.starGroup)}
                  <span className="yz-adm__count">
                    {p.cohort} 人 / 名額 {p.quota}
                  </span>
                </h3>
                <ol className="yz-adm__draftlist">
                  {p.entries.map((e) => (
                    <li
                      key={e.userId}
                      className={e.nominated ? 'yz-adm__nominated' : 'yz-adm__out'}
                    >
                      <span className="yz-adm__wrank">{e.order}</span>
                      <span className="yz-adm__wname">{who(e.userId)}</span>
                      <span className="yz-adm__num">{e.percentile}%</span>
                      {e.firstRound && <span className="yz-adm__tag">第一輪</span>}
                      {e.nominated && !e.firstRound && (
                        <span className="yz-adm__tag">推薦序 {e.order}，第二輪</span>
                      )}
                      {!e.nominated && <span className="yz-adm__tag yz-warn">未獲推薦</span>}
                      {e.tied && <span className="yz-adm__tag yz-warn">與人同分</span>}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}

        {/* ── 六、匯入 ─────────────────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 30 }}>
          在校成績百分比（教務處匯入）
        </h2>
        <p className="yz-hint">
          這是上面每一份排序的唯一輸入，也是全校最敏感的一份資料。
          它<strong>不進入任何學生可查詢的介面</strong>——學生端只拿得到自己的序位一個整數，
          排序在伺服器端算完。你每一次開這一頁都會寫一列稽核記錄。
        </p>
        <RankImport year={year} />
      </main>
    );
  });
}
