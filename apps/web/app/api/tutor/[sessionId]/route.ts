import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { scopedRoute } from '@/lib/route';
import { closeTutorSession, loadTutorSession, tutorFailure } from '@/lib/tutor';

export const dynamic = 'force-dynamic';

/**
 * 讀回一段對話。
 *
 * 學生把分頁關掉再打開、或在手機上切走再切回來時要用它把畫面補回來。
 * **回傳裡沒有 CONTEXT 訊息也沒有被擋下來的草稿**（見 lib/tutor.ts 的
 * `visibleMessages`）——那兩種裡面裝的正是不該讓學生看到的東西。
 */
export const GET = scopedRoute<{ sessionId: string }>(async (_req, { user, params }) => {
  try {
    return NextResponse.json(await loadTutorSession(params.sessionId, user.id));
  } catch (e) {
    const { status, body } = tutorFailure(e);
    return NextResponse.json(body, { status });
  }
});

/**
 * 結束對話。
 *
 * `resolved` 為 true 時寫 `resolvedAt`——那是學生按「我懂了」。
 * **只是關掉視窗不寫**：schema 的欄位註解說「沒有按不代表沒懂，
 * 所以不拿它當成效指標的分母」，而把關閉當成理解會讓那個數字說謊，
 * 往好的方向說謊。
 */
const Body = z.object({ resolved: z.boolean().optional() });

export const PATCH = scopedRoute<{ sessionId: string }>(
  async (req: NextRequest, { user, params }) => {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    const resolved = parsed.success ? (parsed.data.resolved ?? false) : false;

    try {
      const session = await closeTutorSession({
        sessionId: params.sessionId,
        userId: user.id,
        resolved,
      });
      return NextResponse.json(session);
    } catch (e) {
      const { status, body } = tutorFailure(e);
      return NextResponse.json(body, { status });
    }
  },
);
