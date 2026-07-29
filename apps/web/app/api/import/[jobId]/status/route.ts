import { NextRequest, NextResponse } from 'next/server';
import { scopedRoute } from '@/lib/route';

import { loadProgress } from '@/lib/importStatus';

export const dynamic = 'force-dynamic';

/**
 * 進度輪詢。
 *
 * 刻意做得很輕：一次 findFirst 加兩個 join，再加兩個吃索引的
 * `count`（佇列裡排在前面幾份、現在有沒有別的工作在跑）。
 * 那兩個 count 換掉的是一塊會把正常排隊誣告成「工作者壞了」的警告，
 * 而那塊警告會讓老師去按一顆把自己排到隊尾的按鈕——值得。
 *
 * 一份題本解析五分鐘就是六十次輪詢，而同時可能有好幾位老師
 * 在看自己的進度頁——這個端點的成本要壓到接近零。
 */
export const GET = scopedRoute<{ jobId: string }>(async (_req: NextRequest, { user, params }) => {

  const data = await loadProgress(params.jobId, user.tenantId);
  if (!data) return NextResponse.json({ error: '找不到匯入工作' }, { status: 404 });

  return NextResponse.json(data, {
    headers: { 'Cache-Control': 'no-store' },
  });
});
