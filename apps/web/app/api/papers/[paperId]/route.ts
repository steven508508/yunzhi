/**
 * 一份試卷：更名、改說明、改狀態、刪除。
 *
 * 狀態與其他欄位分開處理，因為 `setPaperStatus` 帶著一整組前置條件
 * （要有題目、總分不能是 0、有人作答就不能退回草稿），
 * 而那些條件與「改個卷名」完全無關。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { canEditSubject, type SessionUser } from '@/lib/auth';
import { deletePaper, setPaperStatus, updatePaper } from '@/lib/paper';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Patch = z.object({
  title: z.string().min(1).max(120).optional(),
  instructions: z.string().max(2000).nullable().optional(),
  status: z.enum(['DRAFT', 'READY', 'ARCHIVED']).optional(),
});

/**
 * 這份卷子存在嗎、這個人動得了它嗎。兩個 handler 共用。
 *
 * 回傳的是「錯誤回應」或「卷子」，而不是丟例外：權限不足要回 403、
 * 找不到要回 404，兩者與業務錯誤的 400 是不同的東西，混在一起
 * 前端就分不出「你不能改」與「你改的內容不對」。
 */
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

export const PATCH = scopedRoute<{ paperId: string }>(async (req, { user, params }) => {
  const found = await openPaper(params.paperId, user);
  if (found.error) return found.error;

  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: '沒有可以更新的內容' }, { status: 400 });

  try {
    const { status, ...rest } = parsed.data;
    if (rest.title !== undefined || rest.instructions !== undefined) {
      await updatePaper(params.paperId, rest, user.id);
    }
    // 狀態放在最後：改名失敗時不該留下一份已經改了狀態的卷子。
    const paper = status
      ? await setPaperStatus(params.paperId, status, user.id)
      : await prisma.examPaper.findFirst({ where: { id: params.paperId } });
    return NextResponse.json({ ok: true, paper });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
});

export const DELETE = scopedRoute<{ paperId: string }>(async (_req, { user, params }) => {
  const found = await openPaper(params.paperId, user);
  if (found.error) return found.error;
  try {
    const paper = await deletePaper(params.paperId, user.id);
    return NextResponse.json({ ok: true, paper });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
});
