/**
 * 第二階段上傳前的確認清單（§9.4）。
 *
 * # 這個功能技術含量低但實用價值高
 *
 * 規格書的原話。實務上因為**技術性疏失**吃虧的案例意外地多——少傳
 * 一項、超過大小、搞錯擇一規則——而那不是能力問題，是那個窄口本身
 * 設計得很兇：起始日全國統一 4/30、截止日各校自訂、每一校系只能擇一
 * 使用「勾選中央資料庫」或「自行上傳 PDF」且不得混搭、系統每日只開
 * 09:00 到 21:00、**送出確認後不得修改**。
 *
 * 每一條都不可逆，而且每一條都是一份清單就可以避免的。
 *
 * # 為什麼三種嚴重度而不是兩種
 *
 * 全部做成「必須修正」的話，學生會學會忽略整份清單——而那時真正的
 * 阻斷項也一起被忽略了。所以分成三種：`BLOCK`（這樣送出去一定出事）、
 * `WARN`（可能出事，你自己確認）、`INFO`（沒事，但你要知道）。
 *
 * # 為什麼校系的資料要學生自己填
 *
 * 因為系統沒有。截止日各校自訂而且逐年公告，「擇一」是他自己在甄選會
 * 系統上的選擇。讓系統去猜的話，清單會漏掉最會出事的那兩項——
 * 而一份漏掉重點的清單比沒有清單糟，因為他會以為自己核對過了。
 */
import Link from 'next/link';

import { admissionYearOf } from '@/lib/portfolioDb';
import { UPLOAD_MODES } from '@/lib/portfolio.mjs';
import { scopedPage } from '@/lib/page';
import { Empty, Note } from '@/components/Feedback';

import ChecklistRunner from './ChecklistRunner';

export const dynamic = 'force-dynamic';

export default async function ChecklistPage() {
  return scopedPage(async (user) => {
    const year = admissionYearOf() as number;

    if (user.systemRole !== 'STUDENT') {
      return (
        <main className="yz-panel">
          <div className="yz-panel__head">
            <h1>送出前的確認清單</h1>
          </div>
          <Empty
            title="這一頁是學生在按下送出之前逐項核對"
            hint="它核對的是他自己的素材與各校系的規定，老師這裡沒有對應的檢視。"
            action={
              <Link href="/portfolio" className="yz-btn yz-btn--primary">
                回學習歷程
              </Link>
            }
          />
        </main>
      );
    }

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>送出前的確認清單</h1>
          <p className="yz-panel__sub">
            {year} 學年度
            <Link href="/portfolio" className="yz-linkish">
              回素材整理
            </Link>
          </p>
        </div>

        <Note tone="warn">
          <strong>甄選會的第二階段上傳系統，送出確認後不得修改。</strong>
          起始日全國統一 4/30，但<strong>截止日是各大學各自規定的</strong>；
          系統每天只開 09:00 到 21:00（截止日當天 21:00 一到就關，不是 23:59）；
          每一校系只能擇一使用「勾選中央資料庫」或「自行上傳 PDF」，
          <strong>不得混搭</strong>。
        </Note>

        <ChecklistRunner modes={UPLOAD_MODES} />
      </main>
    );
  });
}
