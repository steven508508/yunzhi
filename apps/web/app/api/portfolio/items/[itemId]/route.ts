/**
 * 改一件素材，或刪掉它。
 *
 * `selectedFor`（為哪些校系勾選）走 PATCH 而不是一支獨立的路由，因為
 * 勾選與件數上限是同一件事：勾第四件課程學習成果給同一個校系時，
 * 系統要在**同一個回應**裡把逐校系的件數重算回去。分成兩支的話，
 * 畫面會先顯示「已勾選」再顯示「超過上限」，而學生會以為前一句是真的。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { deleteItem, myPortfolio, portfolioFailure, updateItem } from '@/lib/portfolioDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Patch = z.object({
  title: z.string().min(1).max(200).optional(),
  semester: z.string().max(20).nullish(),
  abilityTags: z.array(z.string().max(40)).max(12).optional(),
  selectedFor: z.array(z.string().max(40)).max(12).optional(),
  note: z.string().max(2000).nullish(),
  courseRef: z.string().max(200).nullish(),
});

export const PATCH = scopedRoute<{ itemId: string }>(async (req, { user, params }) => {
  const parsed = Patch.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: '參數不正確' }, { status: 400 });
  try {
    const item = await updateItem(user, params.itemId, parsed.data);
    return NextResponse.json({ item, ...(await myPortfolio(user)) });
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});

export const DELETE = scopedRoute<{ itemId: string }>(async (_req: NextRequest, { user, params }) => {
  try {
    await deleteItem(user, params.itemId);
    return NextResponse.json(await myPortfolio(user));
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});
