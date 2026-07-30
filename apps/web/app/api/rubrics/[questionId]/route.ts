/**
 * 一題的評分規準：讀、存、刪。
 *
 * # 為什麼 GET 也要在這裡而不是只在頁面上查
 *
 * 因為規準編輯器要「套用範本」之後即時顯示，而範本套用之後老師還會
 * 改——那一段是 client component。它需要一支拿得到現況的端點。
 *
 * # 這一支的權限判斷在 lib/rubric.ts 裡面，不在這裡
 *
 * 刻意的：`loadRubricForGrading` / `saveRubric` / `deleteRubric` 自己
 * 問 `mayGrade`。API 這一層再判一次的話，兩個地方會慢慢分岐，而分岐
 * 的方向是「某一條路沒有判」——而規準的描述文字受著作權保護，
 * 授權範圍是機構內部閱卷，漏出去是授權問題不只是權限問題。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { scopedRoute } from '@/lib/route';
import {
  RubricError,
  deleteRubric,
  loadRubricForGrading,
  saveRubric,
  type RubricDraft,
} from '@/lib/rubric';

export const dynamic = 'force-dynamic';

const Dimension = z.object({
  name: z.string().min(1).max(60),
  nameEn: z.string().max(60).nullish(),
  maxScore: z.number(),
  descriptor: z.string().max(2000).nullish(),
  order: z.number().int().nonnegative().optional(),
});

const Band = z.object({
  grade: z.string().min(1).max(10),
  scoreMin: z.number(),
  scoreMax: z.number(),
  descriptor: z.string().max(2000),
  dimensionName: z.string().max(60).nullish(),
  order: z.number().int().nonnegative().optional(),
});

const Body = z.object({
  name: z.string().min(1).max(120),
  totalScore: z.number(),
  mode: z.string().min(1).max(20),
  sourceRef: z.string().max(300).nullish(),
  /**
   * 不傳就是 true（`lib/rubric.ts` 的 `saveRubric` 只認明確的 false）。
   * 這裡刻意不給 `.default(true)`：預設值寫在資料層，兩個地方各寫一次
   * 的話，改了一邊就有一條路會用另一個預設。
   */
  internalOnly: z.boolean().optional(),
  dimensions: z.array(Dimension).max(12),
  bands: z.array(Band).max(20),
});

function fail(e: unknown) {
  if (e instanceof RubricError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  console.error('[rubric] 未預期的錯誤', e);
  return NextResponse.json({ error: '規準沒有存起來，請再試一次' }, { status: 500 });
}

export const GET = scopedRoute<{ questionId: string }>(async (_req, { user, params }) => {
  try {
    const rubric = await loadRubricForGrading(user, params.questionId);
    return NextResponse.json({ rubric });
  } catch (e) {
    return fail(e);
  }
});

export const PUT = scopedRoute<{ questionId: string }>(
  async (req: NextRequest, { user, params }) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: `規準的格式不對：${parsed.error.issues[0]?.message ?? '請檢查每一格'}` },
        { status: 400 },
      );
    }
    try {
      const rubric = await saveRubric(user, params.questionId, parsed.data as RubricDraft);
      return NextResponse.json({ ok: true, rubric });
    } catch (e) {
      return fail(e);
    }
  },
);

export const DELETE = scopedRoute<{ questionId: string }>(async (_req, { user, params }) => {
  try {
    await deleteRubric(user, params.questionId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
});
