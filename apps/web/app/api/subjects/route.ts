/**
 * 科目。
 *
 * 只有管理員能動，與學年度同一條規則：科目決定題庫、卷子與成績的
 * 分類方式，加一科或停一科會影響全機構每一個下拉選單。這是行政決定，
 * 不是老師的日常操作。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { mayUse } from '@/lib/nav';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';
import { createSubject } from '@/lib/subject';

export const dynamic = 'force-dynamic';

const AREA = '/settings/subjects';

export const GET = scopedRoute(async (_req: NextRequest, { user }) => {
  if (!mayUse(user.systemRole, AREA)) {
    return NextResponse.json({ error: '只有管理員可以管理科目' }, { status: 403 });
  }
  const subjects = await prisma.subject.findMany({
    orderBy: { order: 'asc' },
    include: { _count: { select: { questions: true, examPapers: true } } },
  });
  return NextResponse.json({ subjects });
});

const Body = z.object({
  // 代碼在伺服器端會轉大寫（見 createSubject），這裡不擋大小寫，
  // 否則打成小寫的人會收到一句他改不動的錯誤訊息。
  code: z.string().min(1).max(31),
  name: z.string().min(1).max(30),
  parentCode: z.string().max(31).nullish(),
  gsatFullScore: z.number().int().positive().nullish(),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  if (!mayUse(user.systemRole, AREA)) {
    return NextResponse.json({ error: '只有管理員可以建立科目' }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: '請填寫科目代碼與名稱', detail: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }
  try {
    const subject = await createSubject(parsed.data, user.id);
    return NextResponse.json({ ok: true, subject });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
});
