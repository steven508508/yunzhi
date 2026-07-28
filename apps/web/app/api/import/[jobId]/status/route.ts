import { NextRequest, NextResponse } from 'next/server';
import { scopedRoute } from '@/lib/route';

import { loadProgress } from '@/lib/importStatus';

export const dynamic = 'force-dynamic';

/**
 * 進度輪詢。
 *
 * 刻意做得很輕：一次 findFirst 加兩個 join，沒有計數查詢。
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
