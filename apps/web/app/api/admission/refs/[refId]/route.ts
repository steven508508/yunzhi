/**
 * 刪一筆自己查來的資料。
 *
 * 「不是他的」與「不存在」回一模一樣的 404。分開回的話，這一支就變成
 * 一個查詢別人有沒有輸入某筆資料的工具——攻擊者拿一串 cuid 試過去，
 * 403 與 404 的差別就是答案。`deleteReference()` 用 `[id, userId]` 一起查，
 * 所以它連「存在但不是你的」都分不出來。
 *
 * 與 `wishes/[wishId]` 完全相同的處理。這一支存在的理由是它的資料更敏感
 * ——那張表裡有 `MY_PERCENTILE`，也就是這位學生的在校成績百分比。
 */
import { NextRequest, NextResponse } from 'next/server';

import { admissionYearOf, deleteReference, referenceBasis } from '@/lib/admissionRefDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

export const DELETE = scopedRoute<{ refId: string }>(async (req: NextRequest, { user, params }) => {
  if (user.systemRole !== 'STUDENT') {
    return NextResponse.json({ error: '這些資料由學生本人維護' }, { status: 403 });
  }
  const ok = await deleteReference(user.id, params.refId);
  if (!ok) return NextResponse.json({ error: '找不到這一筆資料' }, { status: 404 });

  const year = Number(new URL(req.url).searchParams.get('year')) || admissionYearOf();
  return NextResponse.json(await referenceBasis(user.id, year));
});
