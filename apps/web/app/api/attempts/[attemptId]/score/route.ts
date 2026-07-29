/**
 * 老師手動給一題的分數。
 *
 * # 這一支補的是一個資料層早就準備好、卻沒有入口的功能
 *
 * `lib/scoring.ts` 一直保留著「有人手動給過分就不覆蓋」的路徑，而
 * **沒有任何 API 或畫面寫得進那個值**。後果有兩個：
 *
 *   · 一份含作文的卷子永遠停在「待評分」，成績頁那一欄的數字
 *     一直掛著，而沒有人做得了那件事
 *   · 客觀題的個案（申訴成立、某位學生的答案有爭議）只能整題送分
 *     ——那會連同另外 31 個人一起給分
 *
 * # 為什麼與「送分」是兩支不同的東西
 *
 * 送分是記在**題目**上的決定（這一題不算，每個人都得分，包含空白卷），
 * 這一支是記在**某一位學生的某一題**上的決定。把後者做成送分的話，
 * 一位學生的申訴會改掉全班的分數。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { scopedRoute } from '@/lib/route';
import { attemptTarget, mayGrade, setManualScore } from '@/lib/scoring';

export const dynamic = 'force-dynamic';

const Body = z.object({
  questionId: z.string().min(1),
  /** `null` = 收回人工分數，讓這一題回到自動計分。 */
  score: z.number().nullable(),
  /** 為什麼給這個分數。家長問起時這是唯一說得出來的東西。 */
  note: z.string().max(500).nullish(),
});

export const POST = scopedRoute<{ attemptId: string }>(
  async (req: NextRequest, { user, params }) => {
    const target = await attemptTarget(params.attemptId);
    // 查不到有兩種可能：不存在，或不是這個租戶的（RLS 直接讓它消失）。
    // 兩種都回 404——回 403 等於告訴對方「這個 id 存在」。
    if (!target) return NextResponse.json({ error: '找不到這一份作答' }, { status: 404 });

    // 與重新計分同一條權限規則。這一支改的就是分數本身。
    if (!(await mayGrade(user, target.subjectId))) {
      return NextResponse.json(
        { error: '只有這一科的授課老師與管理員可以給分' },
        { status: 403 },
      );
    }

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: '請填一個分數' }, { status: 400 });
    }

    try {
      const result = await setManualScore(params.attemptId, parsed.data.questionId, {
        score: parsed.data.score,
        note: parsed.data.note ?? null,
        actorId: user.id,
      });
      return NextResponse.json({ ok: true, result });
    } catch (e) {
      // 「超過配分」「這一題沒有作答記錄」都是說得出原因的狀況，
      // 訊息本身就是要顯示給老師看的東西。
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 409 },
      );
    }
  },
);
