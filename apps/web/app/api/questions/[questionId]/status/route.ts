/**
 * 發布與下架。
 *
 * 與改內容分開一支，理由與 `api/papers/[paperId]` 把狀態分開處理一樣：
 * 下架帶著一整組前置條件（還在哪幾份沒截止的卷子上），而那些條件與
 * 「改一個錯字」完全無關。混在同一支的話，一次普通的編輯會因為
 * 「這一題還在某份卷子上」而失敗。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { QuestionError, requireEditable, setQuestionStatus } from '@/lib/question';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/**
 * 改得到的三個狀態。`DRAFT` 不在裡面：那是「匯入了但還沒有人校對」，
 * 由入庫流程決定，不是老師在題庫裡按得回去的狀態。
 */
const SETTABLE = ['PENDING_REVIEW', 'PUBLISHED', 'RETIRED'] as const;

const Body = z.object({
  status: z.enum(SETTABLE),
  reason: z.string().max(500).optional(),
});

export const POST = scopedRoute<{ questionId: string }>(async (req, { user, params }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `狀態只能是 ${SETTABLE.join('、')} 其中之一` },
      { status: 400 },
    );
  }

  try {
    await requireEditable(params.questionId, user);
    const r = await setQuestionStatus(
      params.questionId,
      parsed.data.status,
      user,
      parsed.data.reason,
    );
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
