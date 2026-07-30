/**
 * 刪一筆級分記錄。
 *
 * 「不是他的」與「不存在」回一模一樣的 404，理由與
 * `refs/[refId]` 相同：分開回的話這一支就變成一個查詢別人考了幾次的
 * 工具——拿一串 cuid 試過去，403 與 404 的差別就是答案。
 * `deleteGradeRecord()` 用 `[id, userId]` 一起查，所以它連「存在但不是
 * 你的」都分不出來。
 *
 * # 刪掉一筆級分不會動到已經落地的預測
 *
 * 這是刻意的。`GradePrediction` 是**當時那個預測的快照**，而校準曲線問
 * 的是「那時候我們說 70%，事後看準不準」。回頭把快照改掉或刪掉，等於
 * 讓這套預測可以事後修正自己的成績單——那時校準曲線就只是在量「我們
 * 記得修哪幾筆」。
 */
import { NextRequest, NextResponse } from 'next/server';

import { admissionYearOf, deleteGradeRecord, predictionsFor } from '@/lib/predictDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

export const DELETE = scopedRoute<{ recordId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (user.systemRole !== 'STUDENT') {
      return NextResponse.json({ error: '級分記錄由學生本人維護' }, { status: 403 });
    }
    const ok = await deleteGradeRecord(user.id, params.recordId);
    if (!ok) return NextResponse.json({ error: '找不到這一筆級分記錄' }, { status: 404 });

    const year = Number(new URL(req.url).searchParams.get('year')) || admissionYearOf();
    return NextResponse.json(await predictionsFor(user.id, year));
  },
);
