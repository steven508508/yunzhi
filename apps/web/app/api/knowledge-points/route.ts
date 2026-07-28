/**
 * 知識點。
 *
 * 只有這一科的授課老師與管理員能改——知識點是能力分析的座標系，
 * 改動會影響整科所有學生的分析結果。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { canEditSubject } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';
import { createKnowledgePoint, inspectGraph } from '@/lib/knowledge';

export const dynamic = 'force-dynamic';

export const GET = scopedRoute(async (req: NextRequest) => {
  const subjectId = new URL(req.url).searchParams.get('subject');
  if (!subjectId) return NextResponse.json({ error: '請指定科目' }, { status: 400 });

  const [points, health] = await Promise.all([
    prisma.knowledgePoint.findMany({
      where: { subjectId },
      orderBy: { name: 'asc' },
      include: {
        prerequisites: { select: { prereqKpId: true, strength: true } },
        _count: { select: { questions: true } },
      },
    }),
    inspectGraph(subjectId),
  ]);
  return NextResponse.json({ points, health });
});

const Body = z.object({
  subjectId: z.string().min(1),
  name: z.string().min(1).max(80),
  description: z.string().max(1000).optional(),
  decayRate: z.number().min(0).max(1).optional(),
  gsatWeight: z.number().min(0).max(10).optional(),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: '請填寫科目與名稱' }, { status: 400 });
  if (!(await canEditSubject(user, parsed.data.subjectId))) {
    return NextResponse.json({ error: '你不是這一科的授課老師' }, { status: 403 });
  }
  try {
    const kp = await createKnowledgePoint(parsed.data, user.id);
    return NextResponse.json({ ok: true, kp });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
});
