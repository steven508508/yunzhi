/**
 * 升學資料查詢：去哪裡查 → 把查到的記下來 → AI 老師給建議。
 *
 * # 為什麼這一頁的第一區是「去哪裡查」而不是一張表單
 *
 * 因為業主提的切法是這個：**禁止爬取的是機器，不是人。** 學生自己打開
 * 官方網頁查一個校系的錄取標準完全沒有問題，而且那本來就是輔導老師會
 * 叫他做的事。校內百分比更是只有教務處有。所以系統的角色從「幫你查」
 * 變成三件它真的做得到的事，而**第一件是最重要的**——一位不知道去哪裡
 * 查的學生，給他一張空表單只會讓他關掉這一頁。
 *
 * # 為什麼清單照繁星的時序排
 *
 * 因為學生是照時序遇到這些問題的：11 月簡章公告他才知道有哪些校系、
 * 2 月底成績出來才知道有沒有過檢定、3 月初校內推薦作業才真的要決定推
 * 哪一個。照系統結構排（校系資料／成績資料／校內資料）讀起來很整齊，
 * 但它回答不了「我現在該做什麼」——而那是學生打開這一頁的唯一理由。
 * 順序在 `lib/admissionSources.mjs`，有測試釘著。
 *
 * # 兩種網址在畫面上長得不一樣，這是刻意的
 *
 * **推得出來的**（`star{民國年}`）給連結，但旁邊一定有一句「這個網址是
 * 依學年度推出來的，打不開就從委員會首頁進去」，而且首頁的連結就在
 * 旁邊。**推不出來的**（篩選標準一覽表）只給入口加導覽步驟，不給深連結
 * ——那一頁的路徑每年重新產生一串亂碼，寫死的話它明年變成 404，而畫面
 * 上仍然有一個看起來完全正常的連結。
 *
 * # 為什麼兩層競爭要放在同一個區塊
 *
 * 規格書 §7.1：坊間工具只處理得了第二層（全國門檻），而學生真正卡住的
 * 往往是第一層（校內誰被推薦）。分開放的話，學生看到「我的百分比比門檻
 * 好」就以為會上，完全沒有意識到校內還有兩個人排在他前面。
 */
import Link from 'next/link';

import { admissionYearOf, isStarCoordinator, myAcademicRank, myStarPosition } from '@/lib/admissionDb';
import { referenceBasis, aiDisclosure } from '@/lib/admissionRefDb';
import { sourceChecklist } from '@/lib/admissionSources.mjs';
import { withNationalThresholds } from '@/lib/star.mjs';
import { mayUse } from '@/lib/nav';
import { scopedPage } from '@/lib/page';
import { Denied, Empty, Note } from '@/components/Feedback';

import { Emph } from '../Emph';
import AdvicePanel from './AdvicePanel';
import RefForm from './RefForm';
import RefList from './RefList';
import SourceGuide from './SourceGuide';

export const dynamic = 'force-dynamic';

export default async function AdmissionRefsPage() {
  return scopedPage(async (user) => {
    // 角色判定走 `lib/nav.ts` 那一份唯一的對照表（見那個檔案的檔頭）。
    if (!mayUse(user.systemRole, '/admission')) {
      return (
        <main className="yz-panel">
          <Denied
            what="升學資料查詢"
            why={
              <>
                這一區是學生與老師的。孩子的成績與作業狀況在
                <Link href="/guardian">孩子的狀況</Link>那一頁。
              </>
            }
          />
        </main>
      );
    }

    const year = admissionYearOf();

    if (user.systemRole !== 'STUDENT') {
      return (
        <main className="yz-panel">
          <div className="yz-panel__head">
            <h1>升學資料查詢</h1>
            <p className="yz-panel__sub">{year} 學年度</p>
          </div>
          <Empty
            title="這一頁是學生自己查資料、記資料的地方"
            hint={
              isStarCoordinator(user)
                ? '學生輸入的資料只用於他自己的建議，不會進入你那邊的全校模擬——模擬只吃教務處匯入的在校百分比。'
                : '學生查到的錄取標準與來源記在這裡。老師要看班上的狀況：進「班級」點一個班，那一頁上有「升學總覽」。'
            }
            action={<Link href="/admission">回升學規劃</Link>}
          />
        </main>
      );
    }

    const [basis, star, rank, disclosure] = await Promise.all([
      referenceBasis(user.id, year),
      myStarPosition(user.id, year),
      myAcademicRank(user.id, year),
      aiDisclosure(user.id),
    ]);

    // 第二層（學生查來的全國門檻）掛到第一層（系統算的校內序位）上。
    const twoLayer = withNationalThresholds(star, basis.thresholds) as ReturnType<
      typeof withNationalThresholds
    >;

    const steps = sourceChecklist(year);

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>升學資料：自己查，記下來</h1>
          <p className="yz-panel__sub">
            {year} 學年度 · 系統做三件事：<strong>告訴你去哪裡查</strong>、
            <strong>把你查到的記下來（含來源與日期）</strong>、
            <strong>在上面給建議</strong>。
          </p>
        </div>

        <Note tone="info">
          本系統<strong>不會自己去抓這些資料</strong>——招聯會全站的 robots.txt
          禁止自動化爬取，而那是一條不會為了方便而繞過的線。但
          <strong>禁止的是機器，不是人</strong>：你自己打開官方網頁查一個校系的錄取標準
          完全沒有問題，而且那本來就是該做的功課。所以下面是一份可執行的清單。
        </Note>

        {/* ── 一、去哪裡查 ─────────────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 24 }}>
          去哪裡查（依繁星的時序）
        </h2>
        <p className="yz-hint">
          照時序排，不是照資料種類排。每一項都寫了<strong>什麼時候該查</strong>、
          <strong>去哪裡</strong>、以及<strong>查到之後填在下面哪一格</strong>——
          查完不填回來的話，這一頁就只是一份書籤，AI 老師也沒有東西可以看。
        </p>
        <SourceGuide steps={steps} year={year} />

        {/* ── 二、我查到的 ─────────────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 30 }}>
          我查到的（{basis.references.length} 筆）
        </h2>
        <p className="yz-hint">
          <strong>來源類型與查詢日期是必填的。</strong>
          一個沒有來源的數字，三個月後與一個有來源的長得一模一樣——而你會照著它決定
          要不要填志願。「聽同學說的」是一個<strong>可以誠實選</strong>的選項；
          選它不會被扣分，只會讓那筆資料標成「只能當線索」，那才是它真正的份量。
        </p>
        <RefList year={year} refs={basis.references} />
        <RefForm year={year} />

        {/* 學生自己輸入的百分比：隔離要在畫面上明說。 */}
        {(basis.selfPercentile !== null || basis.officialPercentile !== null) && (
          <div className="yz-ref__own">
            <h3 className="yz-adm__grouphead">在校成績百分比：兩個數字，兩種用途</h3>
            <ul className="yz-ref__ownlist">
              <li>
                <span className="yz-ref__ownwho">教務處匯入的</span>
                <span className="yz-adm__num">
                  {basis.officialPercentile !== null ? `${basis.officialPercentile}%` : '還沒有'}
                </span>
                <span className="yz-ref__ownuse">
                  <strong>校內賽局模擬只用這一份。</strong>
                  它是全校序位的唯一輸入，所以它必須由教務處來。
                </span>
              </li>
              <li>
                <span className="yz-ref__ownwho">你自己輸入的</span>
                <span className="yz-adm__num">
                  {basis.selfPercentile !== null ? `${basis.selfPercentile}%` : '還沒有'}
                </span>
                <span className="yz-ref__ownuse">
                  <strong>只用於你自己的建議。</strong>
                  它<strong>不會進入校內模擬</strong>，也
                  <strong>不會影響任何其他同學看到的序位</strong>——因為如果會，你少打一個
                  小數點就會讓別人看到錯的位置，而他完全不會知道。
                </span>
              </li>
            </ul>
            {rank && basis.selfPercentile !== null && basis.selfPercentile !== rank.percentile && (
              <Note tone="warn">
                你自己填的（{basis.selfPercentile}%）與教務處匯入的（{rank.percentile}%）
                不一樣。校內序位用的是教務處那一份。若你確定教務處那個數字有問題，
                去問導師——這裡改不了它，而且刻意改不了。
              </Note>
            )}
          </div>
        )}

        {/* ── 三、兩層競爭 ─────────────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 30 }}>
          繁星：兩層競爭放在一起看
        </h2>
        {twoLayer.positions.length === 0 ? (
          <p className="yz-hint">
            你還沒有繁星志願（或還沒選學群），所以算不出校內位置。
            填了之後這裡會把<strong>校內排第幾</strong>（系統算得出來）與
            <strong>該校系去年的門檻</strong>（你查來的）擺在同一列。
            <Link href="/admission" style={{ marginLeft: 6 }}>
              去填志願
            </Link>
          </p>
        ) : (
          <ul className="yz-adm__positions">
            {twoLayer.positions.map((p) => (
              <li key={`${p.institutionName}-${p.starGroup}`} className="yz-adm__pos">
                <div className="yz-adm__poshead">
                  <span className="yz-adm__posname">
                    {p.institutionName}　第 {p.starGroup} 類學群
                  </span>
                  <span className="yz-adm__order">
                    {p.hidden ? (
                      p.isFirst ? (
                        '校內第 1 位'
                      ) : (
                        '不是校內第 1 位'
                      )
                    ) : (
                      <>
                        校內第 <b>{p.order}</b> 位
                      </>
                    )}
                  </span>
                  <span className={`yz-adm__tag ${p.nominated ? '' : 'yz-warn'}`}>
                    {p.nominated ? '在校內推薦名單內' : '目前在推薦名單之外'}
                  </span>
                </div>

                <div className="yz-ref__layers">
                  <div className="yz-ref__layer">
                    <span className="yz-ref__layerhead">第一層　校內（系統算的）</span>
                    <span className="yz-ref__layerbody">
                      {p.hidden
                        ? '這個位置想推的人很少，所以只說「是不是第 1 位」——人數少的時候，一個名次就足以讓你推知另一位同學是誰。'
                        : `校內第 ${p.order} 位，每個位置至多推薦 ${p.quota} 名，第一輪只有推薦序 1 參加。`}
                    </span>
                  </div>
                  <div className="yz-ref__layer">
                    <span className="yz-ref__layerhead">第二層　全國（你查來的）</span>
                    {p.nationalThresholds.length === 0 ? (
                      <span className="yz-ref__layerbody yz-warn">
                        你還沒有查這個校系的錄取標準。上面清單的第 4 項就是這一件——
                        至少查三年，一年看不出趨勢。
                      </span>
                    ) : (
                      <ul className="yz-ref__thresholds">
                        {p.nationalThresholds.map((t) => (
                          <li key={`${t.year}-${t.kind}`}>
                            <span className="yz-ref__thyear">{t.year} 學年度</span>
                            <span className="yz-adm__num">{t.describe || `${t.percentile}%`}</span>
                            {t.starGroup === null && (
                              <span className="yz-adm__tag yz-warn">這一筆沒有填學群</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                <p className="yz-adm__why">
                  <Emph text={p.twoLayerNote} />
                </p>
                {p.thresholdBasisNote && (
                  <p className="yz-adm__why">
                    <Emph text={p.thresholdBasisNote} />
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {twoLayer.unmatchedThresholds.length > 0 && (
          <Note tone="info">
            另外 {twoLayer.unmatchedThresholds.length} 筆錄取標準對不上你目前的繁星志願（
            {twoLayer.unmatchedThresholds
              .map((t) => `${t.institutionName}${t.starGroup ? ` 第 ${t.starGroup} 類` : ''}`)
              .join('、')}
            ）。這通常代表你在比較還沒填成志願的校系——那是好事。也可能是校名打錯了。
          </Note>
        )}

        {/* ── 四、AI 老師 ──────────────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 30 }}>
          AI 老師看一次
        </h2>
        <AdvicePanel year={year} gaps={basis.gaps} disclosure={disclosure} />
      </main>
    );
  });
}
