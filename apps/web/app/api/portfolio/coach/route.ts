/**
 * 撰寫回饋、素材提示、選件討論——**三個功能一支路由**。
 *
 * # 為什麼不拆成三支
 *
 * 因為它們的差別只在餵什麼脈絡與用哪一段提示詞，而**閘門、AI 層級的
 * 判定、以及互動記錄必須完全一樣**。拆成三支的話，日後有人在其中一支
 * 加一個「這個功能比較安全，重試一次就好」的捷徑，而那一支就沒有防
 * 代寫了——症狀是某一個入口的輸出比較「好用」，而沒有人會回報那件事。
 *
 * 這與 `lib/tutorGuard.mjs` 檔頭講的「只能有一份」是同一個理由。
 *
 * # 超出層級是停用，不是「可以用但要標註」
 *
 * 教育部 113 年 12 月 13 日函文要求教師**事前明定**四種使用層級之一。
 * 「事前明定」的意思就是有些事不准做，所以這裡回 403 而不是回一段
 * 加了警語的內容。訊息要說得出是誰決定的、去問誰——學生看到
 * 「這個功能停用」的第一個反應是以為系統壞了。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { coachFeedback, portfolioFailure } from '@/lib/portfolioDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  feature: z.enum(['WRITING_FEEDBACK', 'MATERIAL_HINT', 'SELECTION_DISCUSS']),
  essayId: z.string().nullish(),
  question: z.string().max(500).optional(),
  programRef: z.string().max(40).nullish(),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: '參數不正確' }, { status: 400 });
  try {
    return NextResponse.json(await coachFeedback(user, parsed.data));
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});
