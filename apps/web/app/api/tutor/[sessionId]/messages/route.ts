import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { scopedRoute } from '@/lib/route';
import { sendTutorMessage, tutorFailure, TUTOR_MODES } from '@/lib/tutor';
import type { TutorMode } from '@/lib/tutor';

export const dynamic = 'force-dynamic';

/**
 * 送一則訊息，拿回智慧老師的回覆。
 *
 * # 為什麼不是串流
 *
 * 因為輸出閘門要**看完整段**才判得出有沒有洩漏答案。邊生成邊顯示，
 * 等於把可能洩漏的內容先放到學生螢幕上、判定完再收回來——而他
 * 已經看到了，截圖也已經按了。這不是「晚一點再顯示」可以折衷的：
 * 一段話要到最後一句才知道它有沒有把答案講完（「先算 120÷2，」
 * 是完全正常的，接上「＝60」就不是了）。
 *
 * 所以這一支等一次完整生成再回。實測 mock 是毫秒級、真模型 2–5 秒，
 * 而介面那一側用樂觀顯示與「老師正在想」的指示把這段等待撐住。
 *
 * # 逾時
 *
 * 沒有另外設。`lib/tutor.ts` 對 AI 服務的呼叫已經有 60 秒的上限，
 * 而重新生成最多三次——最壞情況下這一支要跑四分鐘。那是極端值
 * （閘門連續三次命中），正常是一次呼叫。
 */
const Body = z.object({
  // 2000 字：學生貼一整段題目進來是常見的（他想問另一題）。
  // 上限存在是為了擋住把整本講義貼進來的那一次，不是為了刁難。
  text: z.string().min(1).max(2000),
  /**
   * 學生自己按的模式。
   *
   * 按了就以他為準（見 `lib/tutorGuard.mjs` 的 `pickMode`）——
   * 他比系統更知道自己現在要什麼，而「按了沒反應」比「選錯了」
   * 傷害大得多。沒帶就由系統依卡點與前置掌握度判斷。
   */
  mode: z.enum(['AUTO', ...TUTOR_MODES] as [string, ...string[]]).optional(),
});

export const POST = scopedRoute<{ sessionId: string }>(
  async (req: NextRequest, { user, params }) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: '訊息格式不對（空的，或超過 2000 字）' },
        { status: 400 },
      );
    }

    try {
      const result = await sendTutorMessage({
        sessionId: params.sessionId,
        userId: user.id,
        text: parsed.data.text,
        mode: parsed.data.mode as TutorMode | undefined,
      });
      return NextResponse.json(result);
    } catch (e) {
      const { status, body } = tutorFailure(e);
      return NextResponse.json(body, { status });
    }
  },
);
