/**
 * 老師為班級設定 AI 使用層級（教育部函文要求教師事前明定）。
 *
 * # 學生在多個班級時取最嚴的一級
 *
 * 判定在 `lib/portfolio.mjs` 的 `effectiveAiLevel()`。取最寬的話，
 * 學生只要另外加入一個第 4 級的班，那位設第 1 級的老師的決定就整組
 * 失效——**而他不會知道**。取最嚴會誤傷（他在別的班本來可以用），
 * 但誤傷的症狀是他來問，放行的症狀是沒有人知道。
 *
 * # 「沒有設定」不等於「設定為第 1 級」
 *
 * 前者是老師還沒做這個動作，後者是他決定了。折成同一個值的話，
 * 畫面上就說不出「請老師去設定」這句話，而學生會以為老師選了最嚴的
 * 一級然後去問他為什麼。所以未設定是 `null`，而 `null` 一律停用
 * （除了制度檢查與揭露聲明兩個在每一級都開的例外）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { AI_LEVELS, aiPolicies, portfolioFailure, setAiPolicy } from '@/lib/portfolioDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  classId: z.string().min(1),
  level: z.number().int().min(1).max(4),
  note: z.string().max(500).nullish(),
});

export const GET = scopedRoute(async (_req: NextRequest, { user }) => {
  try {
    return NextResponse.json({ levels: AI_LEVELS, classes: await aiPolicies(user) });
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: '參數不正確' }, { status: 400 });
  try {
    await setAiPolicy(user, parsed.data.classId, parsed.data.level, parsed.data.note);
    return NextResponse.json({ levels: AI_LEVELS, classes: await aiPolicies(user) });
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});
