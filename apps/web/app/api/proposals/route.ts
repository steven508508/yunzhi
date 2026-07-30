/**
 * 請 AI 評一份（或一整題全班）的非選題。
 *
 * # 這一支寫不到分數
 *
 * 它只會寫 `AnswerGradeProposal`。要把建議變成分數，走
 * `POST /api/proposals/decide`，而那一支呼叫既有的 `setManualScore`。
 * 兩支分開不是為了 REST 的整齊，是為了讓「產生建議」與「決定分數」
 * 在程式碼上就是兩件事——合成一支的話，遲早會有一個
 * `?autoAccept=true` 參數，而那個參數就是 AI 直接給分。
 *
 * # 為什麼批次要有上限
 *
 * 一次「全班一起評」是 N 份 × 3 次呼叫，每次含題幹、規準與整篇作文。
 * 那是這個系統裡單次最貴的動作，而且它會佔住一個 HTTP 連線好幾分鐘。
 * 上限 60 份：一個班不會超過那個數字，而超過的那幾份按第二次。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { gradingFailure, proposeGrade, proposeGradesForQuestion } from '@/lib/gradingProposalDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';
/**
 * 批次評分會跑好幾分鐘（30 份 × 3 次呼叫）。預設的 15 秒在
 * Node runtime 上會把回應切掉，而切掉之後前端看到的是網路錯誤——
 * 但伺服器那邊還在跑，於是老師會再按一次。
 */
export const maxDuration = 300;

const One = z.object({
  attemptId: z.string().min(1),
  questionId: z.string().min(1),
});

const Batch = z.object({
  assignmentId: z.string().min(1),
  questionId: z.string().min(1),
  /** 已經有建議的要不要重評。預設不重評——重評會把老師的決定清掉。 */
  redo: z.boolean().optional(),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const raw = await req.json().catch(() => null);

  const batch = Batch.safeParse(raw);
  if (batch.success) {
    try {
      const out = await proposeGradesForQuestion(
        user,
        batch.data.assignmentId,
        batch.data.questionId,
        { skipExisting: batch.data.redo !== true },
      );
      return NextResponse.json({ ok: true, batch: out });
    } catch (e) {
      const f = gradingFailure(e);
      return NextResponse.json(f.body, { status: f.status });
    }
  }

  const one = One.safeParse(raw);
  if (!one.success) {
    return NextResponse.json(
      { error: '要指定一份作答（attemptId + questionId）或一整題（assignmentId + questionId）' },
      { status: 400 },
    );
  }
  try {
    const out = await proposeGrade(user, one.data.attemptId, one.data.questionId);
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    const f = gradingFailure(e);
    return NextResponse.json(f.body, { status: f.status });
  }
});
