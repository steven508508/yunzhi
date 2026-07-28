/**
 * 前置關係的增減。
 *
 * 環路在加邊的當下就擋下來——環不是有人故意加的，是三位老師各自
 * 加了一條邊之後湊出來的，而第三位看不到前兩條的組合效果。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { canEditSubject } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';
import { addPrerequisite, removePrerequisite } from '@/lib/knowledge';

export const dynamic = 'force-dynamic';

const Body = z.object({
  prereqKpId: z.string().min(1),
  strength: z.number().min(0).max(1).optional(),
});

async function gate(kpId: string, user: { id: string; systemRole: string }) {
  const kp = await prisma.knowledgePoint.findFirst({
    where: { id: kpId },
    select: { subjectId: true },
  });
  if (!kp) return { error: NextResponse.json({ error: '找不到知識點' }, { status: 404 }) };
  if (!(await canEditSubject(user as never, kp.subjectId))) {
    return { error: NextResponse.json({ error: '你不是這一科的授課老師' }, { status: 403 }) };
  }
  return {};
}

export const POST = scopedRoute<{ kpId: string }>(async (req: NextRequest, { user, params }) => {
  const g = await gate(params.kpId, user);
  if (g.error) return g.error;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: '請指定前置知識點' }, { status: 400 });
  try {
    const link = await addPrerequisite(
      params.kpId,
      parsed.data.prereqKpId,
      user.id,
      parsed.data.strength,
    );
    return NextResponse.json({ ok: true, link });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
});

export const DELETE = scopedRoute<{ kpId: string }>(
  async (req: NextRequest, { user, params }) => {
    const g = await gate(params.kpId, user);
    if (g.error) return g.error;
    const prereqKpId = new URL(req.url).searchParams.get('prereq');
    if (!prereqKpId) return NextResponse.json({ error: '請指定前置知識點' }, { status: 400 });
    try {
      await removePrerequisite(params.kpId, prereqKpId, user.id);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);
