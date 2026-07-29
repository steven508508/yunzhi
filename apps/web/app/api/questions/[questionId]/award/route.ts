/**
 * 全班送分（與取消）。
 *
 * # 為什麼是掛在題目底下、卻要帶一份任務的 id
 *
 * 送分改的是**題目**（`scoringRule.awardAll`，計分時每次重讀），
 * 但老師是在**某一份任務的成績頁**上按下它的，而且他要的是那一份
 * 立刻變成正確的分數。所以這一支做兩件事：立旗標、重算那一份任務。
 *
 * 帶 `assignmentId` 還有第二個作用：**驗證這一題真的在那份卷子上**。
 * 不驗的話，把網址上的題目 id 換掉就能替別份卷子上的題目送分，
 * 而那件事沒有任何人會看到。
 *
 * 權限與擋阻在 `lib/question.ts` 的 `setAward`——它與「全班重新計分」
 * 是同一條規則，因為送分的效力就是全班的分數。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { QuestionError, setAward } from '@/lib/question';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  assignmentId: z.string().min(1),
  /** false 代表取消送分。 */
  award: z.boolean(),
  reason: z.string().max(500).default(''),
});

export const POST = scopedRoute<{ questionId: string }>(async (req, { user, params }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: '要送分的是哪一份任務的哪一題？' }, { status: 400 });
  }

  try {
    const r = await setAward(params.questionId, {
      assignmentId: parsed.data.assignmentId,
      award: parsed.data.award,
      reason: parsed.data.reason,
      user,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof QuestionError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
});
