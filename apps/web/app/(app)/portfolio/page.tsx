/**
 * 學習歷程：素材整理。
 *
 * # 為什麼軸是「學年」而不是「類別」
 *
 * 因為制度的上限是逐學年算的（課程學習成果每學年至多 6 件、多元表現
 * 每學年至多 10 件），而學生要做的決定就是「高二這一年我留哪幾件」。
 * 照類別排的話，他要自己把每一類的東西心算分到三個學年裡去——而那個
 * 心算正是件數算錯的來源。
 *
 * 版面上每一個學年是一個區塊，區塊的抬頭就是那一年的兩個額度。
 *
 * # 綜整心得為什麼要在額度旁邊單獨講一次
 *
 * 因為它是**最多人搞錯的一條**：「多元表現綜整心得」（代碼 N）有 800 字
 * 加 3 張圖的明文限制，但它**不計入 10 件多元表現的額度**。
 *
 * 錯的方向很惡劣：一位已經上傳 10 件多元表現的學生，寫完綜整心得之後
 * 若被系統告知「已達上限」，他會刪掉一件真的多元表現去換位置——而
 * 綜整心得本來就是必要的一項，它不是第 11 件。所以額度旁邊會印
 * 「另有 N 件綜整心得，不計入額度」，讓他數自己的檔案數對得起來。
 * **能被驗證的數字比正確的數字重要**：對不起來的時候他會以為系統壞了。
 *
 * # 上限旁邊為什麼一直掛著一句提醒
 *
 * 因為那幾個數字**是資料不是常數**，而沒有建檔時用的是預設值。
 * 預設值錯了的症狀是系統擋住其實沒有超過的學生，而他會相信系統。
 * 所以只要 `limits.isDefault`，這一頁就一直顯示「請對照當年度的簡章」，
 * 而且說得出它為什麼重要。
 *
 * # 職員看到的是完全不同的一頁
 *
 * 老師在這裡只有兩件事：設定班級的 AI 使用層級，以及看學生**主動
 * 分享給他**的自述。他看不到沒有被分享的內容，也看不到任何人的 AI
 * 對話——後者與智慧老師那一塊相反，因為這裡的內容涉及個人生涯與家庭。
 */
import Link from 'next/link';

import {
  admissionYearOf,
  aiPolicies,
  essaysSharedWithMe,
  myPortfolio,
} from '@/lib/portfolioDb';
import {
  AI_LEVELS,
  CHAR_COUNT_NOTE,
  ITEM_CODES,
  LIMITS_UNVERIFIED_NOTE,
} from '@/lib/portfolio.mjs';
import { scopedPage } from '@/lib/page';
import { Empty, Note } from '@/components/Feedback';

import ItemEditor from './ItemEditor';
import PolicyEditor from './PolicyEditor';

export const dynamic = 'force-dynamic';

const ESSAY_KIND_LABELS: Record<string, string> = {
  DIVERSE_SUMMARY: 'N 多元表現綜整心得',
  REFLECTION: 'O 高中學習歷程反思',
  MOTIVATION: 'P 就讀動機',
  PLAN: 'Q 未來學習計畫與生涯規劃',
};

export default async function PortfolioPage() {
  return scopedPage(async (user) => {
    const year = admissionYearOf() as number;

    // ── 家長 ──────────────────────────────────────────────────
    //
    // 這一段不是「權限檢查」——真正的擋在 `lib/portfolioDb.ts` 的
    // `assertStudent()`，家長直接打 API 拿到的是 403。這裡只是把那句話
    // 說得體面一點，並且告訴他該去哪一頁。
    if (user.systemRole === 'GUARDIAN') {
      return (
        <main className="yz-panel">
          <div className="yz-panel__head">
            <h1>學習歷程</h1>
          </div>
          <Empty
            title="學習歷程的內容不對家長開放"
            hint={
              <>
                這不是設定問題。學習歷程檔案裡有大量的個人陳述與生涯敘事，
                <strong>孩子可能在裡面寫下不希望你看到的事</strong>
                ——而那正是這份文件的本質。一個家長看得到的版本，
                他會停止寫真話，然後這個功能對他就沒有用了。
                任務、成績與時程在「孩子的狀況」那一頁。
              </>
            }
            action={
              <Link href="/guardian" className="yz-btn yz-btn--primary">
                去孩子的狀況
              </Link>
            }
          />
        </main>
      );
    }

    // ── 職員 ──────────────────────────────────────────────────
    if (user.systemRole !== 'STUDENT') {
      const [classes, shared] = await Promise.all([
        aiPolicies(user),
        essaysSharedWithMe(user),
      ]);
      return (
        <main className="yz-panel">
          <div className="yz-panel__head">
            <h1>學習歷程</h1>
            <p className="yz-panel__sub">{year} 學年度</p>
          </div>

          <Note tone="info">
            <strong>老師在這一區看得到的只有兩件事</strong>：班級的 AI 使用層級設定，以及<strong>學生主動分享給你的</strong>自述。
            沒有被分享的內容你看不到，而任何人的 AI 對話紀錄你也看不到——
            這一條與智慧老師那一塊相反（那裡你看得到班上的對話），
            因為這裡的內容涉及個人生涯與家庭。學生隨時可以撤回分享。
          </Note>

          <PolicyEditor classes={classes} levels={AI_LEVELS} />

          <section>
            <h2 className="yz-card__title" style={{ marginTop: 26 }}>
              學生分享過來的自述（{shared.length}）
            </h2>
            {shared.length === 0 ? (
              <Empty
                title="還沒有學生分享自述給你"
                hint="學生在自己的學習歷程頁面上選擇要分享給哪一位老師。他選了你，這裡才會出現。"
              />
            ) : (
              <ul className="yz-pf__shared">
                {shared.map((s) => (
                  <li key={s.id} className="yz-pf__sharedone">
                    <div className="yz-pf__sharedhead">
                      <strong>{s.authorName}</strong>
                      <span className="yz-pf__kind">
                        {ESSAY_KIND_LABELS[s.kind] ?? s.kind}
                      </span>
                      <span className="yz-pf__meta">
                        {s.charCount} 字　{s.updatedAt.slice(0, 10)}
                      </span>
                    </div>
                    <p className="yz-pf__sharedbody">{s.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>
      );
    }

    // ── 學生 ──────────────────────────────────────────────────
    const data = await myPortfolio(user, year);

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>學習歷程</h1>
          <p className="yz-panel__sub">
            {year} 學年度
            <Link href="/portfolio/essays" className="yz-linkish">
              自述與心得
            </Link>

            <Link href="/portfolio/checklist" className="yz-linkish">
              送出前的確認清單
            </Link>

            <Link href="/portfolio/disclosure" className="yz-linkish">
              AI 使用記錄
            </Link>
          </p>
        </div>

        <Note tone="info">
          <strong>這一區只有你自己看得到。</strong>內容預設只有你本人可見。你可以選擇性地分享自述給特定老師徵詢意見，
          <strong>而且隨時可以撤回</strong>。
          <strong>家長在任何路徑下都讀不到</strong>，你的 AI 對話紀錄老師也看不到。
          這些不是設定，是程式裡真的擋著的。
        </Note>

        {data.limits.isDefault ? (
          <Note tone="warn">
            <strong>這一年度的件數上限還沒有人建檔。</strong>
            {LIMITS_UNVERIFIED_NOTE}
          </Note>
        ) : (
          <Note tone="info">
            <strong>上限的來源：{data.limits.sourceRef}</strong>。這幾個數字由管理員照簡章建檔。與你手上那一份對不起來的話，告訴老師——
            擋錯的方向是系統說你超過了而你其實沒有，而你會相信系統然後刪掉一件該留的。
          </Note>
        )}

        {/* ── 逐學年的額度 ─────────────────────────────────── */}
        <section>
          <h2 className="yz-card__title" style={{ marginTop: 26 }}>
            件數
          </h2>
          {data.central.byYear.length === 0 ? (
            <Empty
              title="還沒有整理任何素材"
              hint="從下面加第一件。三年累積的東西是散的，把它收攏本身就是準備的一部分。"
            />
          ) : (
            <ul className="yz-pf__years">
              {data.central.byYear.map((y) => (
                <li key={y.year} className="yz-pf__year">
                  <span className="yz-pf__yearname">{y.label}</span>
                  <span className={`yz-pf__quota${y.outcome.over ? ' yz-pf__quota--over' : ''}`}>
                    課程學習成果 {y.outcome.used}/{y.outcome.max}
                  </span>
                  <span className={`yz-pf__quota${y.diverse.over ? ' yz-pf__quota--over' : ''}`}>
                    多元表現 {y.diverse.used}/{y.diverse.max}
                  </span>
                  {y.diverse.summaryExcluded > 0 && (
                    /*
                      這一行是這一頁最重要的一行。見檔頭：綜整心得不計入
                      額度，而不印出來的話，他數自己的檔案是 11 件、系統
                      說 10 件，他會以為系統壞了然後去刪東西。
                    */
                    <span className="yz-pf__excluded">
                      另有 {y.diverse.summaryExcluded} 件綜整心得，<strong>不計入額度</strong>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="yz-hint">
            個人申請階段勾選時另有一套上限（課程學習成果至多 {data.limits.outcomeSelected} 件、
            多元表現至多 {data.limits.diverseSelected} 件），而且是
            <strong>逐校系</strong>算的。那一套在下面每一件的「為哪些校系勾選」上。
          </p>
          {data.selected.byProgram.length > 0 && (
            <ul className="yz-pf__progs">
              {data.selected.byProgram.map((p) => (
                <li key={p.programRef} className="yz-pf__prog">
                  <span className="yz-pf__progname">{p.programRef}</span>
                  <span className={p.outcome.over ? 'yz-pf__quota--over' : ''}>
                    課程 {p.outcome.used}/{p.outcome.max}
                  </span>
                  <span className={p.diverse.over ? 'yz-pf__quota--over' : ''}>
                    多元 {p.diverse.used}/{p.diverse.max}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <ItemEditor
          items={data.items}
          codes={ITEM_CODES}
          docMB={Math.round(data.limits.docBytes / 1024 / 1024)}
          mediaMB={Math.round(data.limits.mediaBytes / 1024 / 1024)}
          programRefs={data.programRefs}
        />

        <p className="yz-hint">{CHAR_COUNT_NOTE}</p>
      </main>
    );
  });
}
