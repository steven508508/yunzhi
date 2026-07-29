/**
 * 卷子上的題目：加、重排、改配分、移除。
 *
 * 重排走 PATCH 而且**一次送整份新順序**。理由見 `lib/paper.ts`：
 * 前端排序本來就是一次算出完整的順序，而整批送天然帶著樂觀鎖——
 * 題目集合對不上就代表有人同時在改同一份卷子。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { canEditSubject, type SessionUser } from '@/lib/auth';
import {
  addPaperItem,
  removePaperItem,
  reorderPaperItems,
  setPaperItemScore,
} from '@/lib/paper';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

async function openPaper(paperId: string, user: SessionUser) {
  const paper = await prisma.examPaper.findFirst({
    where: { id: paperId },
    select: { id: true, title: true, subjectId: true },
  });
  if (!paper) return { error: NextResponse.json({ error: '找不到這份試卷' }, { status: 404 }) };
  if (!(await canEditSubject(user, paper.subjectId))) {
    return {
      error: NextResponse.json(
        { error: `你不是這一科的授課老師，改不了「${paper.title}」` },
        { status: 403 },
      ),
    };
  }
  return { paper };
}

const fail = (e: unknown) =>
  NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });

// ── 加題 ─────────────────────────────────────────────────────────

const Add = z.object({
  questionId: z.string().min(1),
  score: z.number().min(0).max(1000).optional(),
});

export const POST = scopedRoute<{ paperId: string }>(async (req: NextRequest, { user, params }) => {
  const found = await openPaper(params.paperId, user);
  if (found.error) return found.error;

  const parsed = Add.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: '請指定要加哪一題' }, { status: 400 });

  try {
    const item = await addPaperItem(
      params.paperId,
      parsed.data.questionId,
      user.id,
      parsed.data.score,
    );
    return NextResponse.json({ ok: true, item });
  } catch (e) {
    return fail(e);
  }
});

// ── 重排或改配分 ─────────────────────────────────────────────────

/**
 * 兩種形狀二選一，刻意不合併成一個「什麼都能改」的物件：
 * 重排要的是整份順序、改配分要的是一題，混在一起會出現
 * 「送了順序又送了配分」這種沒有人想清楚過的請求。
 */
const Patch = z.union([
  z.object({ order: z.array(z.string().min(1)).min(1) }),
  z.object({ itemId: z.string().min(1), score: z.number().min(0).max(1000) }),
]);

export const PATCH = scopedRoute<{ paperId: string }>(async (req: NextRequest, { user, params }) => {
  const found = await openPaper(params.paperId, user);
  if (found.error) return found.error;

  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: '請送出新的題目順序，或要調整配分的題目與分數' },
      { status: 400 },
    );
  }

  try {
    if ('order' in parsed.data) {
      const result = await reorderPaperItems(params.paperId, parsed.data.order, user.id);
      return NextResponse.json({ ok: true, ...result });
    }
    // **itemId 一定要對著這份卷子驗一次。** 上面的權限是對
    // `params.paperId` 的科目判的；少了這一行，任何人拿一個別份卷子
    // （甚至別科）的 itemId 進來，那道檢查就完全沒有保護到這一步。
    const mine = await prisma.examPaperItem.findFirst({
      where: { id: parsed.data.itemId, paperId: params.paperId },
      select: { id: true },
    });
    if (!mine) return NextResponse.json({ error: '這一題不在這份卷子上' }, { status: 404 });

    const item = await setPaperItemScore(parsed.data.itemId, parsed.data.score, user.id);
    return NextResponse.json({ ok: true, item });
  } catch (e) {
    return fail(e);
  }
});

// ── 移除 ─────────────────────────────────────────────────────────

export const DELETE = scopedRoute<{ paperId: string }>(async (req: NextRequest, { user, params }) => {
  const found = await openPaper(params.paperId, user);
  if (found.error) return found.error;

  const itemId = new URL(req.url).searchParams.get('item');
  if (!itemId) return NextResponse.json({ error: '請指定要移除哪一題' }, { status: 400 });

  // **一定要帶 paperId 比對。** 少了這一行，任何人拿一個別份卷子的
  // itemId 進來，上面對「這份卷子」判過的權限就完全沒有保護到這一步。
  const item = await prisma.examPaperItem.findFirst({
    where: { id: itemId, paperId: params.paperId },
    select: { id: true },
  });
  if (!item) {
    return NextResponse.json({ error: '這一題不在這份卷子上' }, { status: 404 });
  }

  try {
    const removed = await removePaperItem(itemId, user.id);
    return NextResponse.json({ ok: true, item: removed });
  } catch (e) {
    return fail(e);
  }
});
