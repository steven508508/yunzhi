/**
 * 分享一份自述給某位老師，或撤回。
 *
 * # 為什麼撤回與分享是同一支
 *
 * 因為它們寫的是同一個欄位（`PortfolioEssay.sharedWith`），而那個欄位
 * 就是老師端的查詢條件。**撤回是把 id 從陣列裡拿掉，下一秒那位老師
 * 就查不到了**——不需要另一張表記「已撤回」，也就沒有「查詢忘記過濾
 * 已撤回」這個破口。
 *
 * 做成 `/share` 與 `/unshare` 兩支的話，兩邊會各自演化，而演化的方向
 * 不會是撤回變得更嚴。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { deleteEssay, myEssays, portfolioFailure, shareEssay } from '@/lib/portfolioDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  teacherId: z.string().min(1),
  /** true 分享、false 撤回。**沒有預設值**：這個動作的方向要講明。 */
  share: z.boolean(),
});

export const PATCH = scopedRoute<{ essayId: string }>(async (req, { user, params }) => {
  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: '參數不正確' }, { status: 400 });
  try {
    const essay = await shareEssay(user, params.essayId, parsed.data.teacherId, parsed.data.share);
    return NextResponse.json(essay);
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});

/**
 * 刪掉一份自述，**連同它的每一個舊版本。**
 *
 * 只刪現行版本的話，舊版本會留在資料庫裡而畫面上永遠看不到
 * （`myEssays()` 只回 `isCurrent`），連同它們的分享名單——那不是刪除，
 * 那是把它藏起來。理由的完整版在 `lib/portfolioDb.ts` 的 `deleteEssay`。
 */
export const DELETE = scopedRoute<{ essayId: string }>(
  async (_req: NextRequest, { user, params }) => {
    try {
      await deleteEssay(user, params.essayId);
      return NextResponse.json(await myEssays(user));
    } catch (e) {
      const { status, body } = portfolioFailure(e);
      return NextResponse.json(body, { status });
    }
  },
);
