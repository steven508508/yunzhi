import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { scopedRoute } from '@/lib/route';
import {
  closeTutorSession,
  loadTutorSession,
  reopenTutorSession,
  tutorFailure,
} from '@/lib/tutor';

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
 * 改一段對話的狀態：結束、或重新打開。
 *
 * # 三個動作，而不是一個布林
 *
 * 原本這一支只收 `{resolved: boolean}`，於是「按了我懂了」與
 * 「把視窗收起來」共用同一個請求——而介面上那顆寫著「收起」的按鈕
 * 打的就是 `resolved: false`，學生以為在摺疊，實際上把這一題的
 * 智慧老師永久關掉了，而且當時沒有任何一條路重開。
 *
 * 現在分成三個具名的動作，**「收起」不在裡面**：收起是純瀏覽器端的
 * 摺疊，不打任何 API。一個只在畫面上發生的動作不該產生一個資料庫
 * 狀態變更，這是那個缺陷的根。
 *
 *   · `resolve` 學生按「我懂了」→ CLOSED ＋ 寫 `resolvedAt`
 *   · `close`   學生按「結束這一段」→ CLOSED，**不寫** `resolvedAt`
 *                （schema 註解：沒有按不代表沒懂，不拿它當分母）
 *   · `reopen`  學生按「我還想再問」→ 回到 OPEN，接續同一段
 *
 * 舊的 `{resolved}` 仍然收，因為它是同一個部署裡可能還在跑的舊分頁
 * 會送出來的形狀；對不上任何動作時一律當成 `close`，那是三者裡最
 * 保守的一個（不會憑空寫出一個「他說他懂了」）。
 */
const Body = z.object({
  action: z.enum(['resolve', 'close', 'reopen']).optional(),
  resolved: z.boolean().optional(),
});

export const PATCH = scopedRoute<{ sessionId: string }>(
  async (req: NextRequest, { user, params }) => {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    const data = parsed.success ? parsed.data : {};
    const action = data.action ?? (data.resolved ? 'resolve' : 'close');

    try {
      const session =
        action === 'reopen'
          ? await reopenTutorSession({ sessionId: params.sessionId, userId: user.id })
          : await closeTutorSession({
              sessionId: params.sessionId,
              userId: user.id,
              resolved: action === 'resolve',
            });
      return NextResponse.json(session);
    } catch (e) {
      const { status, body } = tutorFailure(e);
      return NextResponse.json(body, { status });
    }
  },
);
