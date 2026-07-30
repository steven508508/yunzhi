/**
 * 面試準備（N5）。
 *
 * # 這一頁上沒有任何一句「這個答案好不好」
 *
 * 規格書 §10：回饋只評**結構**（有沒有回答到問題、有沒有具體例子、
 * 有沒有前後矛盾），不評內容。理由有兩層：
 *
 * **一、系統的判斷會是錯的。** 各校系的甄選項目與比重差異極大，而系統
 * 手上沒有任何一份評分表可以對。給出來的「這題答得不錯」是憑空的。
 *
 * **二、學生會照著改。** 這比第一件嚴重得多——他會把回答改成他以為的
 * 「正確答案」，然後在面試現場講一段不是自己的話。**面試最常見的
 * 失分本來就是講稿感**，而系統會親手製造它。
 *
 * 所以整個回饋是確定性的（`lib/interview.mjs`，純函式有測試），
 * 而不是「叫模型只評結構」——模型被要求只評結構時，第三輪就會寫出
 * 「你的例子很具體，展現了良好的團隊合作能力」，而後半句是內容評價，
 * 混在結構觀察裡送出去。
 *
 * # 一致性檢查是這一頁最有價值的一項
 *
 * 面試最貴的一種失分是「檔案裡寫的跟口頭講的對不起來」，而它在現場是
 * 致命的：委員手上就拿著那份檔案，而學生自己通常不記得三個月前寫了
 * 什麼。這一項只查一個方向（你講了檔案裡沒有的東西），而且輸出是
 * 提醒不是錯誤——講檔案裡沒寫的經歷完全可以，檔案有篇幅限制。
 */
import Link from 'next/link';

import { interviewQuestions, myPractices } from '@/lib/portfolioDb';
import { FIELD_TAGS } from '@/lib/interview.mjs';
import { scopedPage } from '@/lib/page';
import { Empty, Note } from '@/components/Feedback';

import Practice from './Practice';

export const dynamic = 'force-dynamic';

export default async function InterviewPage({
  searchParams,
}: {
  searchParams: Promise<{ fieldTag?: string }>;
}) {
  return scopedPage(async (user) => {
    if (user.systemRole !== 'STUDENT') {
      return (
        <main className="yz-panel">
          <div className="yz-panel__head">
            <h1>面試準備</h1>
          </div>
          <Empty
            title="面試練習是學生自己的東西"
            hint={
              <>
                練習的回答裡會有他還沒想清楚的話、講砸的版本、以及對自己志向的猶豫。
                那與學習歷程的內容是同一類的東西，所以走同一條線——
                <strong>沒有任何一支查詢讓老師看別人的練習</strong>。
                題庫本身你改得動，那在後續批次的題庫管理裡。
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

    const sp = await searchParams;
    const fieldTag = sp?.fieldTag ?? 'ALL';
    const [questions, practices] = await Promise.all([
      interviewQuestions(user, fieldTag),
      myPractices(user, 20),
    ]);

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>面試準備</h1>
          <p className="yz-panel__sub">
            第二階段
            <Link href="/portfolio/essays" className="yz-linkish">
              自述與心得
            </Link>
          </p>
        </div>

        <Note tone="info">
          <strong>這裡的回饋只看結構，不評內容。</strong>
          有沒有回答到問題、有沒有具體例子、有沒有前後矛盾——這三件事看得出來。
          「這個答案好不好」是招生委員的判斷，系統給了只會誤導，
          而且你會照著改成你以為的「正確答案」，然後在現場講一段不是自己的話。
          <strong>面試最常見的失分本來就是講稿感。</strong>
        </Note>

        <p className="yz-pf__kindpick">
          <Link
            href="/interview"
            className={`yz-chip${fieldTag === 'ALL' ? ' yz-chip--on' : ''}`}
          >
            全部
          </Link>
          {(FIELD_TAGS as { tag: string; label: string }[]).map((f) => (
            <Link
              key={f.tag}
              href={`/interview?fieldTag=${f.tag}`}
              className={`yz-chip${fieldTag === f.tag ? ' yz-chip--on' : ''}`}
            >
              {f.label}
            </Link>
          ))}
        </p>

        <Practice questions={questions} practices={practices} />
      </main>
    );
  });
}
