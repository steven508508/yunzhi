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
 *
 * # 那份清單裡有幾條已經過時了，而這一頁的處理方式是「移走而不是刪掉」
 *
 * `NOT_OFFERED` 裡有三條記的是**當時成立、現在不成立**的判斷：
 *
 *   · 級分預測卡在「需要 IRT 能力估計」。那個判斷忽略了一件現成的事
 *     ——補習班的模擬考本來就會公布級分，而那是直接觀測值。
 *   · 落點卡在「歷年篩選標準禁止爬取」。禁止的是**機器**：學生自己去
 *     官方網頁查完輸入進來，那條路一直是通的。
 *   · 學習歷程與面試準備寫的是「這一階段還沒做」。那句話當時是對的，
 *     而它已經做完了——兩者都在導覽列上。
 *
 * 那幾段文字**留在 `admission.mjs` 裡不動**（它們是判斷的歷史，而且
 * 有測試釘著），這一頁改的只是「哪幾條要印出來」加上一段說明它們搬到
 * 哪裡去了。理由是刪掉那幾段的話，下一個人會重新推導出同樣的結論然後
 * 再關掉這些功能一次——**被推翻的判斷比沒有判斷有價值**。
 *
 * **這一份清單與 `NOW_OFFERED` 的對照要靠 key，數量要用算的。** 上一次
 * 漏掉學習歷程那一條的方式很簡單：`NOW_OFFERED` 只補了兩個 key，而
 * 標題寫死「兩件」——於是這一頁一邊在講「被推翻的判斷要說清楚錯在哪」，
 * 一邊在導覽列上有那個功能的同時說它不存在。
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
import { mayUse } from '@/lib/nav';
import { scopedPage } from '@/lib/page';
import { Denied, Empty, Note } from '@/components/Feedback';

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

/**
 * `NOT_OFFERED` 裡已經做出來的那幾條，以及**當初卡住的判斷錯在哪裡**。
 *
 * 這一份不是「功能上線公告」。它要回答的是同一個讀者的同一個疑問：
 * 他上次來的時候這裡寫著「不做，因為資料取不到」，現在有了——那到底
 * 是資料變了，還是當初判斷錯了？答案是後者，而說清楚是哪裡錯了，才
 * 不會讓人以為這個系統的「不做」是隨時會改口的。
 */
const NOW_OFFERED: Record<string, { href: string; label: string; why: string }> = {
  /**
   * 這一條與另外兩條不同：它記的**不是一個被推翻的判斷**，是一件
   * 「還沒做」的事，而它已經做完了。兩種都要從下面那份「不做的幾件事」
   * 移上來，因為讀者的疑問是同一個——他上次來看到這裡寫著沒有，
   * 現在導覽列上有一個「學習歷程」。
   *
   * 少了這一條的後果，比少了另外兩條更難看：那一頁就在導覽列上，
   * 而這一頁在同一個畫面上說它不存在。
   */
  PORTFOLIO: {
    href: '/portfolio',
    label: '學習歷程輔助',
    why:
      '當初寫的是「這一階段還沒做，它需要另一批資料表」。**那句話是對的，只是它已經過期了**' +
      '——素材、自述草稿與 AI 使用揭露記錄三張表都建好了，面試準備也上線了' +
      '（導覽列上有自己的一項，因為它是四月通過第一階段之後那兩個星期的事）。' +
      '這裡的 AI **只協助整理與回饋，絕不代寫**，而每一次使用都留下揭露記錄——' +
      '那不是限制功能，那是這個功能可以存在的條件。',
  },
  GRADE_PREDICTION: {
    href: '/admission/predict',
    label: '級分預測',
    why:
      '當初卡在「要由作答記錄推估級分需要 IRT 能力估計」。那個判斷漏掉了一件現成的事：' +
      '**補習班的模擬考本來就會公布級分**（南模、全模、校內模考），而成績單上那個數字是' +
      '**直接觀測值**，不需要任何換算。反推才需要 IRT。輸出仍然只有區間加信心水準，' +
      '不會有一個「你會考幾級分」的數字。',
  },
  APPLY_ODDS: {
    href: '/admission/placement',
    label: '個申落點（通過第一階段的機率）',
    why:
      '當初卡在「歷年篩選標準無法合法取得」。那句話只對了一半：' +
      '**禁止爬取的是機器，不是人。** 你自己打開委員會的歷年篩選標準查詢、把那幾個數字' +
      '輸入進來，這條路一直是通的。所以基準是**你查來的歷年實際門檻**，而每一個機率' +
      '旁邊都標著它用了哪幾年的資料、可靠度多少、什麼時候查的。' +
      '資料可靠度不足的校系照樣顯示「無法估計」——那一條沒有變。',
  },
};

export default async function AdmissionPage() {
  return scopedPage(async (user) => {
    // ── 誰進得來：走 `lib/nav.ts` 那一份唯一的對照表 ──────────────
    //
    // 這一區以前六頁各自手寫 `user.systemRole !== 'STUDENT'`，於是家長
    // 打開這一頁會看到一段寫給老師的文字與一個對她是 Denied 的按鈕。
    // 沒有資料外洩（每一頁另有自己的角色判定），但「看得到連結」與
    // 「進得去」必須是同一份規則，而那份規則只有一個地方。
    if (!mayUse(user.systemRole, '/admission')) {
      return (
        <main className="yz-panel">
          <Denied
            what="升學輔導"
            why={
              <>
                這一區是學生規劃自己的升學、老師看所帶班級的狀況。
                孩子的成績與作業狀況在<Link href="/guardian">孩子的狀況</Link>那一頁——
                志願與升學時程之後會做在那裡，<strong>不會是這一頁加一個唯讀旗標</strong>
                （欄位只減不加的投影與這一頁共用一條路徑的話，遲早有人在錯的那邊加一欄）。
              </>
            }
          />
        </main>
      );
    }

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
              <>
                {isStarCoordinator(user)
                  ? '你是繁星承辦（校務管理員或系統管理員）。全校的繁星校內競爭分布與在校成績百分比的匯入在下一頁，而每一次進入都會寫一筆稽核。'
                  : // 「在班級頁」不夠具體：升學總覽是**一個班一頁**，
                    // 入口在班級名稱點進去之後的那一頁上，不在班級列表。
                    // 少了這半句，老師會在班級列表上找一個不存在的連結。
                    '老師要看的是所帶班級的升學狀況：先進「班級」點一個班，那一頁的標題列上有「升學總覽」。'}
                {/*
                  校準報告在這裡出現一次，因為老師找不到它的話它就等於不存在
                  ——而它是級分預測唯一的品質訊號。學生的預測頁對老師是空的，
                  所以那一頁上的連結他看不到。
                */}
                <br />
                級分預測準不準（校準曲線）是<strong>機構自己的品質報告</strong>，
                在下面那個連結。它要等學測成績公布、學生的實際級分回填之後才算得出來。
              </>
            }
            action={
              <>
                {isStarCoordinator(user) && (
                  <Link href="/admission/star" className="yz-btn yz-btn--primary">
                    去繁星全校檢視
                  </Link>
                )}
                {'　'}
                <Link href="/admission/calibration">級分預測的校準</Link>
                {'　'}
                <Link href="/classes">去班級</Link>
              </>
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

    // 兩份清單由**同一份資料**切出來，而且下面的標題數量也從這裡算。
    // 分別寫死「兩件」與手打 filter 的後果就是上一次那一次：清單移了
    // 一條過來，標題還停在舊的數字。
    const nowOffered = NOT_OFFERED.filter((n) => NOW_OFFERED[n.key]);
    const stillNotOffered = NOT_OFFERED.filter((n) => !NOW_OFFERED[n.key]);

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

        {/* ── 去哪裡查 ─────────────────────────────────────── */}
        {/*
          擺在最前面，而不是收在頁尾的「本系統不做的幾件事」旁邊。
          理由是這一頁下面每一個「本系統判定不了」都有同一個出口：
          **你自己去官方網頁查，然後把它記下來。** 出口放在讀者遇到
          第一個限制之前，他才不會讀完整頁之後以為這裡什麼都做不到。
        */}
        <Note tone="info">
          這一頁判的是<strong>管道層級</strong>的資格。各校系自己的門檻（繁星的在校百分比、
          學測檢定標準、歷年錄取標準）本系統<strong>查不到也不會去抓</strong>——
          招聯會全站禁止爬取。但<strong>禁止的是機器，不是人</strong>：
          <Link href="/admission/refs">升學資料查詢</Link>
          那一頁照繁星的時序列出了要查什麼、去哪裡查，你查到之後輸入進去，
          AI 老師就會在你自己的資料上給建議。
          <br />
          另外兩頁吃的是你自己手上的東西：
          <Link href="/admission/predict">級分預測</Link>
          收模考成績單上的級分（那是直接觀測值），
          <Link href="/admission/placement">個申落點</Link>
          用那些級分加上你查來的歷年篩選門檻算通過第一階段的機率。
          <strong>那是這個系統裡唯一會給你機率的地方</strong>，而它必須帶著資料基礎一起看。
        </Note>

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
          達標、學測檢定標準）這裡<strong>判定不了</strong>——那需要逐校系的簡章資料，
          而系統不會去抓。不要把「可以報名」讀成「符合這個校系的門檻」。
          個人申請那一邊有一個例外：你把檢定標準抄進
          <Link href="/admission/refs">升學資料查詢</Link>
          （含五標對應的級分）之後，
          <Link href="/admission/placement">落點模擬</Link>
          會逐次抽樣去檢查它——<strong>抄進來的才會被檢查</strong>，沒抄的那幾條會被明確標成
          「無法判定」而不是靜靜當成通過。
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
        <p className="yz-hint">
          這是<strong>第一層</strong>的競爭（校內誰被推薦），而這一層的資料只有學校自己有。
          <strong>第二層</strong>是全國比序，也就是該校系去年最後一名錄取者的在校百分比——
          那一份要你自己去官方網頁查。兩層擺在同一個畫面上比較看得懂，
          在<Link href="/admission/refs">升學資料查詢</Link>那一頁。
        </p>
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

        {/* ── 原本不做、現在做得到的那幾件 ─────────────────── */}
        {/*
          數量寫成 `nowOffered.length` 而不是「兩件」。寫死一個數字的
          後果就是上一次的那一次：清單多了一條，標題還停在「兩件」，
          而這一段本身講的就是「被推翻的判斷要說清楚」。
        */}
        <h2 className="yz-card__title" style={{ marginTop: 30 }}>
          原本記著「不做」，而那個判斷已經過時的 {nowOffered.length} 件
        </h2>
        <p className="yz-hint">
          這 {nowOffered.length} 件曾經寫在下面那份「不做的幾件事」裡。
          兩種過期方式都在：有的是<strong>當時的理由本身就錯了</strong>（資料其實取得到），
          有的是<strong>當時還沒做，而現在做完了</strong>。錯在哪裡值得寫清楚——
          不然下一次有人會重新推導出同樣的結論，然後再把它關掉一次。
        </p>
        <dl className="yz-adm__nope">
          {nowOffered.map((n) => {
            const now = NOW_OFFERED[n.key];
            return (
              <div key={n.key}>
                <dt>
                  {n.title}
                  {'　'}
                  <Link href={now.href}>去{now.label} →</Link>
                </dt>
                <dd>
                  <Emph text={now.why} />
                </dd>
              </div>
            );
          })}
        </dl>

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
          {stillNotOffered.map((n) => (
            <div key={n.key}>
              <dt>{n.title}</dt>
              <dd>{n.body}</dd>
            </div>
          ))}
        </dl>
        {/*
          這一句必須跟在上面那份「不做」清單後面。上面每一條的理由都是
          「系統取不到那份資料」，而讀者會把它讀成「這件事沒有辦法做」。
          那是兩件不同的事：**系統不能自動抓，但你可以自己查。**
          少了這一句，這一段就是一份道歉；有了它，它是一份分工說明。
        */}
        <p className="yz-hint">
          上面每一條的理由都是<strong>系統取不到那份資料</strong>，不是那份資料不存在。
          你自己去官方網頁查是完全沒問題的——
          <Link href="/admission/refs">升學資料查詢</Link>
          那一頁告訴你去哪裡查、把你查到的記下來（含來源與查詢日期），
          然後 AI 老師在<strong>你自己的資料</strong>上給建議。它同樣不會給你機率，
          但它會告訴你你手上的資料能說到什麼程度、還缺哪一年。
        </p>
      </main>
    );
  });
}
