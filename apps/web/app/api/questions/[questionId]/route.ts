/**
 * 改一題：題幹、選項、標準答案、配分、題型、知識點、詳解。
 *
 * 規則與擋阻全部在 `lib/question.ts` 與 `lib/questionEdit.mjs`——這一層
 * 只做三件事：檢查形狀、擋不是這一科的人、把錯誤翻成狀態碼。
 * 業務判斷寫在路由裡的話，日後多一個入口（批次改、匯入時就地修正）
 * 就會有第二份規則，而**第二份規則永遠比第一份寬**。
 *
 * 回傳帶著 `usage`：這一題現在被哪幾份任務用著、各有幾份已經計過分。
 * 畫面要靠它告訴老師「改完之後那幾份要按重新計分」——改標準答案
 * **不會**自動改成績，那是刻意的（見 lib/scoring.ts）。少了這一段，
 * 老師會以為改完就結束了。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  QuestionError,
  deleteQuestion,
  loadQuestionDetail,
  requireEditable,
  updateQuestion,
} from '@/lib/question';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Patch = z.object({
  content: z.string().max(8000).optional(),
  type: z.string().max(40).optional(),
  score: z.number().finite().min(0).max(1000).optional(),
  options: z
    .array(
      z.object({
        // 這一列原本是第幾個選項。新增的列送 null。
        // **這一欄是選項結構鎖的依據**（見 checkOptionStructure）：
        // 沒有它就分不出「改了第 2 個選項的文字」與「刪掉第 2 個選項」。
        origin: z.number().int().positive().nullable().optional(),
        label: z.string().max(20).nullable().optional(),
        content: z.string().max(2000),
        correct: z.boolean().optional(),
      }),
    )
    .max(20)
    .optional(),
  answerText: z.string().max(4000).nullable().optional(),
  answerSlots: z.array(z.string().max(80)).max(40).nullable().optional(),
  knowledgePointIds: z.array(z.string().min(1)).max(30).optional(),
  explanation: z
    .object({
      conclusion: z.string().max(4000).optional(),
      steps: z.string().max(40000).optional(),
    })
    .nullable()
    .optional(),
});

export const GET = scopedRoute<{ questionId: string }>(async (_req, { user, params }) => {
  try {
    await requireEditable(params.questionId, user);
  } catch (e) {
    return fail(e);
  }
  const detail = await loadQuestionDetail(params.questionId);
  if (!detail) return NextResponse.json({ error: '找不到這一題' }, { status: 404 });
  return NextResponse.json(detail);
});

export const PATCH = scopedRoute<{ questionId: string }>(async (req, { user, params }) => {
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: '送上來的內容格式不對', detail: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }

  try {
    // 權限先擋。`updateQuestion` 自己不判權限是刻意的——它是一個
    // 「照著做」的函式，唯一的守門在這裡與畫面上，兩處都走同一支
    // `requireEditable`。
    await requireEditable(params.questionId, user);
    const result = await updateQuestion(params.questionId, parsed.data, user);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return fail(e);
  }
});

function fail(e: unknown) {
  if (e instanceof QuestionError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  return NextResponse.json(
    { error: e instanceof Error ? e.message : String(e) },
    { status: 400 },
  );
}

/**
 * 刪掉一題。
 *
 * 規則在 `lib/question.ts` 的 `deleteQuestion`——這一層只把
 * QuestionError 翻成狀態碼。已在卷子上或已有人作答的會拿到 409
 * 與「請改用下架」的說明。
 */
export const DELETE = scopedRoute<{ questionId: string }>(async (_req, { user, params }) => {
  try {
    const result = await deleteQuestion(params.questionId, user);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof QuestionError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
});
