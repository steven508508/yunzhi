/**
 * 複製一份卷子。
 *
 * # 為什麼是獨立的一支路由而不是 `POST /api/papers` 多一個參數
 *
 * 因為權限判斷的對象不一樣。建一份新卷子問的是「你教不教這一科」；
 * 複製問的是「你動不動得了**這一份**卷子」——來源的科目、以及它存不存在。
 * 兩者混在同一支裡，就會出現「科目參數與來源卷子的科目不一致」這種
 * 沒有人想清楚過的請求。
 *
 * 卷名可以帶。不帶的話 lib 會加上「（複本）」——複製最常見的起點是
 * 「上次段考那份改幾題」，而老師當下還沒想好新的卷名。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { canEditSubject } from '@/lib/auth';
import { duplicatePaper } from '@/lib/paper';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({ title: z.string().max(120).optional() });

export const POST = scopedRoute<{ paperId: string }>(async (req: NextRequest, { user, params }) => {
  const paper = await prisma.examPaper.findFirst({
    where: { id: params.paperId },
    select: { id: true, title: true, subjectId: true },
  });
  if (!paper) return NextResponse.json({ error: '找不到這份試卷' }, { status: 404 });

  if (!(await canEditSubject(user, paper.subjectId))) {
    return NextResponse.json(
      { error: `你不是這一科的授課老師，複製不了「${paper.title}」` },
      { status: 403 },
    );
  }

  // 沒有 body 也要成立：這顆按鈕在畫面上就是「複製這份卷子」，
  // 沒有欄位可以填。
  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: '卷名太長' }, { status: 400 });

  try {
    const copy = await duplicatePaper(params.paperId, user.id, parsed.data.title);
    return NextResponse.json({ ok: true, paper: copy });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
});
