/**
 * AI 使用記錄與揭露聲明。
 *
 * # 這是及格線，不是加分項
 *
 * 教育部 113 年 12 月 13 日函文明文要求學生在學習歷程檔案中標註 AI 的
 * 使用與來源。一個 AI 輔助升學的系統若不內建揭露機制，就是在幫學生
 * 違規——所以這一頁不是「進階功能」，它是這整個模組能不能上線的條件。
 *
 * # 為什麼記錄要整份印出來給學生看
 *
 * 因為聲明是**他要具名負責的文件**，而他要負責的前提是他知道系統記了
 * 什麼。只給他一段生成好的聲明，等於要他為一份他沒看過依據的文件簽名。
 *
 * 而且記錄是不可竄改的：他可以編輯聲明（那是他的文件），但改不了記錄
 * （那是事實）。這一點也要講出來，否則他會以為刪掉幾行就好。
 *
 * # 聲明走的是防代寫閘門的另一條路，而這件事值得寫在畫面上
 *
 * 聲明本身就是一段五十幾字的連續第一人稱敘述——正好是防代寫閘門要擋
 * 的形狀。它走另一組規則：檢查**聲明內容與記錄相不相符**。一份宣稱
 * 「未使用 AI 生成內容」而完全沒提到十次撰寫回饋的聲明會被擋下來重寫。
 *
 * 學生看得到這件事有兩個用處：他知道系統不會幫他掩飾，
 * 而他也知道系統不會冤枉他說了他沒說的話。
 */
import Link from 'next/link';

import { admissionYearOf, myDisclosure } from '@/lib/portfolioDb';
import { AI_LEVELS } from '@/lib/portfolio.mjs';
import { scopedPage } from '@/lib/page';
import { Empty, Note } from '@/components/Feedback';

import StatementMaker from './StatementMaker';

export const dynamic = 'force-dynamic';

export default async function DisclosurePage() {
  return scopedPage(async (user) => {
    const year = admissionYearOf() as number;

    if (user.systemRole !== 'STUDENT') {
      return (
        <main className="yz-panel">
          <div className="yz-panel__head">
            <h1>AI 使用記錄</h1>
          </div>
          <Empty
            title="AI 對話紀錄只有學生本人看得到"
            hint={
              <>
                這一條與智慧老師那一塊<strong>相反</strong>
                （那裡你看得到班上的對話），因為這裡的內容涉及個人生涯與家庭——
                他為什麼想讀那個系、家裡是什麼狀況。你連摘要都看不到，
                而那不是設定，是程式裡真的沒有那條查詢。
              </>
            }
            action={
              <Link href="/portfolio" className="yz-btn yz-btn--primary">
                回學習歷程
              </Link>
            }
          />
        </main>
      );
    }

    const data = await myDisclosure(user);
    const levelRow = AI_LEVELS.find((l) => l.level === data.level);

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>AI 使用記錄與揭露聲明</h1>
          <p className="yz-panel__sub">
            {year} 學年度
            <Link href="/portfolio" className="yz-linkish">
              回素材整理
            </Link>
          </p>
        </div>

        <Note tone="info">
          教育部 113 年 12 月 13 日函文要求在學習歷程檔案中<strong>標註 AI 的使用與來源</strong>。
          系統把你的每一次互動都記了下來，並依實際記錄產生一份可以貼進檔案的聲明。
          <strong>記錄不可竄改</strong>——你可以編輯聲明（那是你要負責的文件），
          但改不了記錄（那是事實）。<strong>這些記錄只有你自己看得到</strong>，老師連摘要都看不到。
        </Note>

        <section>
          <h2 className="yz-card__title" style={{ marginTop: 22 }}>
            你的班級適用的層級
          </h2>
          {data.level === null ? (
            <Note tone="warn">
              你的班級<strong>還沒有設定 AI 使用層級</strong>。教育部要求老師事前明定，
              所以在老師設定之前，除了制度檢查與這一頁的揭露聲明（兩者都不呼叫模型）
              以外的 AI 功能都停用。跟老師說一聲就會開。
            </Note>
          ) : (
            <>
              <p className="yz-pf__levelnow">
                <strong>{levelRow?.label}</strong>
                {levelRow?.summary}
              </p>
              <p className="yz-hint">
                {levelRow?.why} 超出這一級的功能對你停用——那是老師事前明定的範圍，
                不是系統的限制。
                {data.classes.length > 1 && (
                  <>
                    　你在 {data.classes.length} 個班級裡，系統<strong>取最嚴的一級</strong>：
                    {data.classes
                      .map((c) => `${c.className}（${c.level === null ? '未設定' : `第 ${c.level} 級`}）`)
                      .join('、')}
                    。
                  </>
                )}
              </p>
            </>
          )}
        </section>

        <section>
          <h2 className="yz-card__title" style={{ marginTop: 26 }}>
            使用記錄（{data.total}）
          </h2>
          {data.logs.length === 0 ? (
            <Empty
              title="還沒有任何 AI 互動"
              hint="這種情況下的聲明會寫「未使用 AI 輔助工具」——而那是真的，所以它由系統直接組出來，連模型都不呼叫。"
            />
          ) : (
            <ul className="yz-pf__logs">
              {data.logs.slice(0, 60).map((l) => (
                <li key={l.id} className="yz-pf__log">
                  <span className="yz-pf__logwhen">{l.occurredAt.slice(0, 16).replace('T', ' ')}</span>
                  <span className="yz-pf__logwhat">{l.featureLabel}</span>
                  <span className="yz-pf__lognote">{l.natureNote}</span>
                  {l.aiLevel !== null && <span className="yz-pf__meta">第 {l.aiLevel} 級</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <StatementMaker statements={data.statements} counts={data.counts} total={data.total} />
      </main>
    );
  });
}
