/**
 * 試卷。
 *
 * 列表對所有職員開放（與題庫一樣，出卷是共用的工作區），
 * 但**建卷要有那一科的授課權**——一份數學卷不該由英文老師建出來，
 * 而且 `canEditSubject` 是全系統唯一一份科目職權的判定。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { canEditSubject } from '@/lib/auth';
import { createPaper, mayComposeArea } from '@/lib/paper';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/** 一次最多回幾份。回應要帶 `truncated`，見下面。 */
const PAGE = 200;
const STATUSES = new Set(['DRAFT', 'READY', 'ARCHIVED']);

export const GET = scopedRoute(async (req: NextRequest, { user }) => {
  if (!mayComposeArea(user.systemRole, '/papers')) {
    return NextResponse.json({ error: '沒有權限' }, { status: 403 });
  }
  const sp = new URL(req.url).searchParams;
  const status = sp.get('status');
  // 認不得的狀態要當場擋下來。直接 `as never` 交給 Prisma 的話，
  // 打錯一個字換來的是一個 500 與一段英文堆疊，而呼叫端看不出
  // 是自己的參數錯了。
  if (status && !STATUSES.has(status)) {
    return NextResponse.json(
      { error: `status 只能是 ${[...STATUSES].join('、')}` },
      { status: 400 },
    );
  }

  const found = await prisma.examPaper.findMany({
    where: {
      ...(sp.get('subject') ? { subjectId: sp.get('subject')! } : {}),
      ...(status ? { status: status as never } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: PAGE + 1,
    include: {
      subject: { select: { id: true, name: true } },
      _count: { select: { items: true, assignments: true } },
    },
  });
  // 安靜地截斷是最難查的一種錯：呼叫端拿到一個看起來完整的陣列。
  return NextResponse.json({ papers: found.slice(0, PAGE), truncated: found.length > PAGE });
});

const Body = z.object({
  subjectId: z.string().min(1),
  title: z.string().min(1).max(120),
  instructions: z.string().max(2000).nullable().optional(),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: '請填寫科目與卷名' }, { status: 400 });
  if (!(await canEditSubject(user, parsed.data.subjectId))) {
    return NextResponse.json({ error: '你不是這一科的授課老師' }, { status: 403 });
  }
  try {
    const paper = await createPaper(parsed.data, user.id);
    return NextResponse.json({ ok: true, paper });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
});
