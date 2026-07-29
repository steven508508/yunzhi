/**
 * 作廢一份作答，以及撤銷作廢。
 *
 * # 什麼時候會用到
 *
 * 兩種事，而它們在稽核上長得不一樣，靠 `reason` 分辨：
 *
 *   · **誠信事件。** 監考記錄上寫著這位學生作答中使用手機。
 *   · **系統故障。** 教室跳電，那一份只剩前四題，而學生根本沒有
 *     機會寫完後面的。
 *
 * 在此之前，`AttemptStatus.VOIDED` 全 repo 零個寫入者——計分那一側
 * 判它、學生端的訊息也寫好了，就是沒有任何一條路徑能把一份作答
 * 標成 VOIDED。老師手上只有「留著那個分數」或「刪掉整份任務」兩個
 * 選擇，而後者會連同其他三十個人的作答一起消失。
 *
 * # 為什麼作廢與撤銷是同一支路由
 *
 * 因為它們是同一個決定的兩個方向，而且**權限、理由的要求、稽核的
 * 分類完全相同**。分成兩支的話，遲早有一支的權限判斷被改動而另一支
 * 沒有跟上——而不一致的方向若是「撤銷比作廢寬鬆」，那就是一個
 * 別科的老師可以把作弊記錄救回來的漏洞。
 *
 * # 為什麼作廢一定要填理由
 *
 * 作廢一個學生的成績是會被家長質疑的動作，而三個月後唯一還在的
 * 東西就是稽核裡的那一句。規則本身在 `lib/attemptVoid.mjs`
 * （純函式，有測試），這裡只負責把身分與訊息接起來。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { scopedRoute } from '@/lib/route';
import { MAX_REASON } from '@/lib/attemptVoid.mjs';
import { attemptTarget, mayGrade, unvoidAttempt, voidAttempt } from '@/lib/scoring';

export const dynamic = 'force-dynamic';

const Body = z.object({
  /** true = 作廢，false = 撤銷作廢。**明著送**，不用路徑或方法暗示。 */
  voided: z.boolean(),
  // 長度上限擋在這裡，但「太短」不在這裡判——那句錯誤訊息要說得出
  // 「一句好的理由長什麼樣」，而 zod 的訊息說不出來。見 checkReason。
  reason: z.string().max(MAX_REASON),
});

export const POST = scopedRoute<{ attemptId: string }>(
  async (req: NextRequest, { user, params }) => {
    const target = await attemptTarget(params.attemptId);
    // 查不到有兩種可能：不存在，或不是這個租戶的（RLS 直接讓它消失）。
    // 兩種都回 404——回 403 等於告訴對方「這個 id 存在」。
    if (!target) return NextResponse.json({ error: '找不到這一份作答' }, { status: 404 });

    // 與重新計分、代為結算同一條權限規則。作廢的後果是「這位學生的
    // 成績從班上消失」，那比改分數更重，不該比它寬。
    if (!(await mayGrade(user, target.subjectId))) {
      return NextResponse.json(
        { error: '只有這一科的授課老師與管理員可以作廢作答' },
        { status: 403 },
      );
    }

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: '請說明作廢或撤銷的原因' }, { status: 400 });
    }

    try {
      const result = parsed.data.voided
        ? await voidAttempt(params.attemptId, { actorId: user.id, reason: parsed.data.reason })
        : await unvoidAttempt(params.attemptId, { actorId: user.id, reason: parsed.data.reason });
      return NextResponse.json({ ok: true, result });
    } catch (e) {
      // 「已經作廢了」「理由太短」「狀態看不懂」都是說得出原因的狀況，
      // 而那些訊息本身就是要顯示給老師看的東西。
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 409 },
      );
    }
  },
);
