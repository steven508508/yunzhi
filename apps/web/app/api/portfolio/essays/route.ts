/**
 * 自述與綜整心得：讀自己的、存一個新版本。
 *
 * # 這一支對兩種角色回兩種完全不同的東西
 *
 * **學生**拿到自己的全部內容，含分享名單（那是他自己的設定）。
 * **老師**拿到的是 `SharedEssayView[]`——只有學生**主動分享過來**的
 * 那幾份，而且那個型別裡**沒有任何欄位裝得下 AI 對話紀錄或揭露聲明**。
 *
 * 兩種角色共用一條路徑是刻意的，因為它們讀的是同一張表，而分成兩支
 * 路由等於有兩個地方要記得「老師看不到 AI 對話」——漏掉的那一個
 * 不會有錯誤訊息。共用一支的話，那條線由回傳型別守著（見
 * `lib/portfolioDb.ts` 的 `SharedEssayView`）。
 *
 * **家長兩種都不是**，在 `assertStudent()` 拿到 403。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { essaysSharedWithMe, myEssays, portfolioFailure, saveEssay } from '@/lib/portfolioDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  kind: z.enum(['DIVERSE_SUMMARY', 'REFLECTION', 'MOTIVATION', 'PLAN']),
  body: z.string().max(20000),
  imageCount: z.number().int().min(0).max(50).optional(),
  programRef: z.string().max(40).nullish(),
});

export const GET = scopedRoute(async (_req: NextRequest, { user }) => {
  try {
    if (user.systemRole === 'STUDENT') {
      return NextResponse.json({ role: 'STUDENT', ...(await myEssays(user)) });
    }
    // 家長會在這裡被擋（`essaysSharedWithMe` 走 `assertStaff`）。
    return NextResponse.json({ role: 'STAFF', shared: await essaysSharedWithMe(user) });
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: '參數不正確' }, { status: 400 });
  try {
    const essay = await saveEssay(user, parsed.data);
    return NextResponse.json({ essay, ...(await myEssays(user)) });
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});
