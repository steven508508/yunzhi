import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { attemptFailure, submitAttempt } from '@/lib/attempt';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/**
 * 交卷。
 *
 * `auto` 是「時間到了自動交」，由前端的倒數觸發。**它只影響記錄，
 * 不影響判定**——伺服器仍然自己拿 `expiresAt` 跟現在比，前端說
 * `auto: false` 也不會讓一份逾時的卷子變成準時交。
 *
 * 這一支是冪等的。學生連點兩下、自動交卷與手動交卷同時發生、
 * 網路重試——第二次以後回的是同一個結果，`alreadySubmitted` 為 true，
 * **不是錯誤**。回錯誤的話學生會以為沒交成功。
 */
const Body = z.object({ auto: z.boolean().optional() });

export const POST = scopedRoute<{ attemptId: string }>(
  async (req: NextRequest, { user, params }) => {
    // sendBeacon 送出的交卷可能沒有 body，那就當成手動交卷。
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    const auto = parsed.success ? (parsed.data.auto ?? false) : false;

    try {
      const result = await submitAttempt(params.attemptId, { auto, userId: user.id });
      return NextResponse.json(result);
    } catch (e) {
      const { status, body } = attemptFailure(e);
      return NextResponse.json(body, { status });
    }
  },
);
