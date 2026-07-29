/**
 * 重新計分一份作答。
 *
 * 什麼時候會用到：老師發現某一題的標準答案打錯了、或決定某一題送分，
 * 改完題目之後要讓已經交卷的人重新算一次。也用在「這一份的分數
 * 看起來不對」的個案處理。
 *
 * **只有老師。** 學生連自己的都不能按——那等於「一直按到分數變高
 * 為止」，而每一次都會寫稽核、動班級統計。權限判斷在
 * `lib/scoring.ts` 的 `mayGrade()`，與「誰能改這一科的題目」同一套規則。
 *
 * 重跑是安全的：計分只寫 `isCorrect`、`earnedScore`、`scoreNote` 三欄，
 * 學生原本選了什麼（`answerKeys`）不會被動到。
 */
import { NextRequest, NextResponse } from 'next/server';

import { scopedRoute } from '@/lib/route';
import { attemptTarget, gradeAttemptById, mayGrade } from '@/lib/scoring';

export const dynamic = 'force-dynamic';

export const POST = scopedRoute<{ attemptId: string }>(async (req: NextRequest, { user, params }) => {
  const target = await attemptTarget(params.attemptId);
  // 查不到有兩種可能：不存在，或不是這個租戶的（RLS 直接讓它消失）。
  // 兩種都回 404——回 403 等於告訴對方「這個 id 存在」。
  if (!target) return NextResponse.json({ error: '找不到這一份作答' }, { status: 404 });

  if (!(await mayGrade(user, target.subjectId))) {
    return NextResponse.json(
      { error: '只有這一科的授課老師與管理員可以重新計分' },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => null)) as { reason?: string } | null;
  const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 200) : undefined;

  try {
    const result = await gradeAttemptById(params.attemptId, { actorId: user.id, reason });
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    // 「還在作答中」「已作廢」「這份卷子沒有題目」都是這裡回來的，
    // 而它們都是說得出原因的狀況，直接把訊息交給畫面。
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
});
