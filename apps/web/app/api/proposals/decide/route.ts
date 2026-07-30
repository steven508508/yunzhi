/**
 * 老師對一筆 AI 建議的決定：採用、改分、或不採用。
 *
 * # 為什麼分數是必填而且沒有「就照它給」這種簡寫
 *
 * 因為「照它給」在前端是一顆按鈕，但在這一支必須是一個**明確的數字**。
 * 讓 API 收 `{ accept: true }` 而由伺服器去讀建議的分數，等於這條路上
 * 有一段「分數從 AI 的欄位直接流到 `AttemptAnswer`」——即使中間有人
 * 按過按鈕，那一段程式碼看起來就是 AI 在給分，而下一個人會照著它寫
 * 一個批次版本。
 *
 * 所以協定是：**前端把它要送的那個數字寫出來。** 伺服器再判斷那個數字
 * 與建議一不一樣（`decideState`），一樣就記 ACCEPTED，不一樣就記
 * ADJUSTED 並要求理由。
 *
 * # 為什麼改分與不採用一定要理由
 *
 * 資料庫的 CHECK 也擋著（`answer_grade_proposals_change_has_note`），
 * 但錯誤訊息會是一串英文的約束名稱。這裡先擋一次，讓老師看到的是
 * 「改了 AI 的分數要寫一句為什麼」。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { decideProposal, gradingFailure } from '@/lib/gradingProposalDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  attemptId: z.string().min(1),
  questionId: z.string().min(1),
  /** 老師要給的分數。**前端一定要寫出這個數字**，理由見檔頭。 */
  finalScore: z.number(),
  /** 按了「這個建議沒有參考價值」。 */
  dismissed: z.boolean().optional(),
  note: z.string().max(500).nullish(),
  /** 老師標的「哪幾個面向評不準」。採用率之外唯一改得動提示詞的資料。 */
  weakDimensions: z.array(z.string().max(60)).max(12).optional(),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: '要填一個分數' }, { status: 400 });
  }
  try {
    const out = await decideProposal(user, {
      attemptId: parsed.data.attemptId,
      questionId: parsed.data.questionId,
      finalScore: parsed.data.finalScore,
      dismissed: parsed.data.dismissed === true,
      note: parsed.data.note ?? null,
      weakDimensions: parsed.data.weakDimensions ?? [],
    });
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    // `setManualScore` 的錯誤（超過配分、這一題沒有作答記錄、作答還在
    // 進行中）訊息本身就是要顯示給老師看的東西，所以不吞掉。
    if (e instanceof Error && e.name === 'Error') {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    const f = gradingFailure(e);
    return NextResponse.json(f.body, { status: f.status });
  }
});
