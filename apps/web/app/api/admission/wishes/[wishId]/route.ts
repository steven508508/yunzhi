/**
 * 刪一個志願。
 *
 * 「不是他的」與「不存在」回一模一樣的 404。分開回的話，這一支就變成
 * 一個查詢別人有沒有填某個志願的工具——攻擊者拿一串 cuid 試過去，
 * 403 與 404 的差別就是答案。`deleteWish()` 用 `[id, userId]` 一起查，
 * 所以它連「存在但不是你的」都分不出來。
 */
import { NextRequest, NextResponse } from 'next/server';

import { admissionStatus, admissionYearOf, deleteWish } from '@/lib/admissionDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

export const DELETE = scopedRoute<{ wishId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (user.systemRole !== 'STUDENT') {
      return NextResponse.json({ error: '志願由學生本人維護' }, { status: 403 });
    }
    const ok = await deleteWish(user.id, params.wishId);
    if (!ok) return NextResponse.json({ error: '找不到這個志願' }, { status: 404 });

    const y = Number(new URL(req.url).searchParams.get('year')) || admissionYearOf();
    return NextResponse.json(await admissionStatus(user.id, y));
  },
);
