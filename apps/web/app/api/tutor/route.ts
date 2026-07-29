import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { scopedRoute } from '@/lib/route';
import { openTutorSession, tutorFailure } from '@/lib/tutor';

export const dynamic = 'force-dynamic';

/**
 * 開一段智慧老師的對話（或把既有的那一段拿回來）。
 *
 * # 為什麼是 POST 而不是 GET
 *
 * 因為它會建立東西。而它同時是**冪等**的：同一份作答的同一題重複
 * 開，拿到的永遠是同一段對話。學生在手機上點兩下、網路重試、
 * 換一個分頁再打開，都不該產生第二段——產生了的話，老師端會看到
 * 同一個人對同一題問了五次，其中四次是空的。
 *
 * # 這一支不做權限判斷
 *
 * 判斷全部在 `lib/tutor.ts` 的 `gateForReview`：是不是你的作答、
 * 檢討開放了沒（`maySeeResult` 要 FULL）、這一題在不在這份卷子上。
 * 三道全在同一個地方，是為了讓「送訊息」那一支也走同一份判斷——
 * 分成兩份的話，其中一份遲早會少一道。
 */
const Body = z.object({
  attemptId: z.string().min(1),
  questionId: z.string().min(1),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: '請求格式錯誤' }, { status: 400 });
  }

  try {
    const session = await openTutorSession({
      attemptId: parsed.data.attemptId,
      questionId: parsed.data.questionId,
      userId: user.id,
    });
    return NextResponse.json(session);
  } catch (e) {
    const { status, body } = tutorFailure(e);
    return NextResponse.json(body, { status });
  }
});
