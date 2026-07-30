/**
 * 自述與綜整心得：寫、拿回饋、分享給老師。
 *
 * # 為什麼「一鍵套用」這顆按鈕不存在
 *
 * 這是規格書 §9.1 的三層設限裡的**介面層**。前兩層（提示層與後處理層）
 * 擋的是模型；這一層擋的是產品設計——一顆「把 AI 的建議套用到我的
 * 文章裡」的按鈕，不管後處理層多嚴，都是在邀請代寫。
 *
 * 所以回饋是一段**唯讀的文字**，放在編輯區旁邊，沒有任何一條路徑可以
 * 把它搬進 textarea。學生想照著改要自己打字，而自己打那一遍就是
 * 這個功能存在的理由。
 *
 * # 為什麼分享名單要印出「隨時可以撤回」
 *
 * 因為學生不分享的主要原因是他怕收不回來。講明白它收得回來，
 * 他才會用這個功能去徵詢意見——而徵詢意見正是這個功能最有價值的用法。
 *
 * 而且那句話是真的：撤回就是把老師的 id 從 `sharedWith` 拿掉，而那個
 * 陣列**就是**老師端的查詢條件（`lib/portfolioDb.ts` 的
 * `essaysSharedWithMe`），下一秒他就查不到了。
 */
import Link from 'next/link';

import { admissionYearOf, myEssays } from '@/lib/portfolioDb';
import { CHAR_COUNT_NOTE, SELF_STATEMENT_KINDS } from '@/lib/portfolio.mjs';
import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import { Empty, Note } from '@/components/Feedback';

import EssayEditor from './EssayEditor';

export const dynamic = 'force-dynamic';

export default async function EssaysPage() {
  return scopedPage(async (user) => {
    const year = admissionYearOf() as number;

    if (user.systemRole !== 'STUDENT') {
      return (
        <main className="yz-panel">
          <div className="yz-panel__head">
            <h1>自述與心得</h1>
          </div>
          <Empty
            title="這一頁是學生寫自己的自述"
            hint="你看得到的是學生主動分享過來的那幾份，在學習歷程首頁。"
            action={
              <Link href="/portfolio" className="yz-btn yz-btn--primary">
                回學習歷程
              </Link>
            }
          />
        </main>
      );
    }

    const data = await myEssays(user, year);

    // 可以分享的對象。**只給名字與 id**，不帶任何其他欄位——這一份
    // 清單會送到瀏覽器，而它唯一的用途是讓學生挑一個人。
    const teachers = await prisma.user.findMany({
      where: { systemRole: { in: ['TEACHER', 'SUBJECT_LEAD', 'SCHOOL_ADMIN'] }, status: 'ACTIVE' },
      select: { id: true, displayName: true },
      orderBy: { displayName: 'asc' },
      take: 200,
    });

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>自述與心得</h1>
          <p className="yz-panel__sub">
            {year} 學年度
            <Link href="/portfolio" className="yz-linkish">
              回素材整理
            </Link>
          </p>
        </div>

        <Note tone="info">
          <strong>回饋不會幫你寫。</strong>
          這裡的 AI 只做三件事：指出你哪一句沒有講到具體發生了什麼、
          指出你的動機與成果對不對得起來、以及檢查字數與必要子項。
          它不會給你一段可以貼上去的文字——那不是限制沒做好，
          那是這個功能的界線（學習歷程的意義本來就在於你自己回顧的過程）。
        </Note>

        <section>
          <h2 className="yz-card__title" style={{ marginTop: 22 }}>
            制度檢查
          </h2>
          <ul className="yz-pf__rules">
            {data.ruleChecks.map((c) => (
              <li key={c.code} className={`yz-pf__rule${c.ok ? '' : ' yz-pf__rule--bad'}`}>
                <span className="yz-pf__ruleflag">{c.ok ? '過' : '沒過'}</span>
                {c.detail}
              </li>
            ))}
          </ul>
          <p className="yz-hint">
            學習歷程自述的三個子項（{SELF_STATEMENT_KINDS.map((k) => k.code).join('、')}）
            <strong>要合併成一個 PDF</strong>，缺一項就送不出去。
            頁數與字數由各校系自訂、全國沒有統一上限，所以那三項這裡不給數字——
            給一個編出來的上限比不給更糟，你會照著砍，而砍掉的可能正是該校系想看的。
            {CHAR_COUNT_NOTE}
          </p>
        </section>

        <EssayEditor
          essays={data.essays}
          teachers={teachers.map((t) => ({ id: t.id, name: t.displayName }))}
          summaryChars={data.limits.summaryChars}
          summaryImages={data.limits.summaryImages}
        />
      </main>
    );
  });
}
