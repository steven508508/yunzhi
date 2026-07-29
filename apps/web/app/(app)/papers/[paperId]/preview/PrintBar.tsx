'use client';

import { Button } from '@/components/Button';

/**
 * 列印那一顆按鈕，以及學生版／教師版的切換。
 *
 * # 為什麼切換是連結而不是勾選框
 *
 * 因為兩個版本的差別不是顯示與隱藏，是**伺服器端有沒有把答案查出來**。
 * 勾選框會讓人以為兩份資料都已經在這一頁上了，而那正是這一頁不做的事
 * （見 Sheet.tsx 的檔頭）。連結會重新載入，答案是那一次載入才進來的。
 *
 * # 為什麼不用 `window.print()` 以外的東西
 *
 * 不引入 PDF 產生器。瀏覽器自己的列印對話框讓老師選得到印表機、
 * 紙張、單雙面與份數——那些正是印一疊考卷時真的要調的東西，
 * 而一個伺服器產生的 PDF 只會多一個下載步驟。
 */
export default function PrintBar({
  paperId,
  withAnswers,
}: {
  paperId: string;
  withAnswers: boolean;
}) {
  return (
    <div className="yz-paper__bar">
      <a className="yz-btn" href={`/papers/${paperId}`}>
        回到挑題
      </a>
      <span className="yz-actions__spacer" />
      {withAnswers ? (
        <a className="yz-btn" href={`/papers/${paperId}/preview`}>
          切到學生版（不含答案）
        </a>
      ) : (
        <a className="yz-btn" href={`/papers/${paperId}/preview?ans=1`}>
          切到教師版（含答案）
        </a>
      )}
      <Button variant="primary" onClick={() => window.print()}>
        {withAnswers ? '列印教師版' : '列印學生版'}
      </Button>
    </div>
  );
}
