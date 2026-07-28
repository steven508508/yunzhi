/**
 * 班級。
 *
 * 只有校務管理員能建班。導師管得動自己班的名冊（見 roster 路由），
 * 但「開一個新班」是行政決定——它會影響學年度的結構、排課、
 * 以及日後的成績統計範圍。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';
import { createClass } from '@/lib/roster';

export const dynamic = 'force-dynamic';

const ADMIN = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN']);

export const GET = scopedRoute(async (_req: NextRequest, { user }) => {
  const classes = await prisma.class.findMany({
    where: ADMIN.has(user.systemRole)
      ? {}
      : // 老師只看得到自己有份的班。看得到全部再點進去被拒絕，
        // 是最沒有必要的一種挫折。
        { memberships: { some: { userId: user.id, leftAt: null } } },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    include: {
      academicYear: { select: { name: true, isCurrent: true } },
      _count: { select: { memberships: true } },
    },
  });
  return NextResponse.json({ classes });
});

const Body = z.object({
  academicYearId: z.string().min(1),
  name: z.string().min(1).max(60),
  type: z.enum(['HOMEROOM', 'GROUP']).optional(),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  if (!ADMIN.has(user.systemRole)) {
    return NextResponse.json({ error: '只有校務管理員可以開班' }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: '請填寫學年度與班級名稱' }, { status: 400 });
  }
  try {
    const created = await createClass(parsed.data, user.id);
    return NextResponse.json({ ok: true, class: created });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
});
