/**
 * 學年度。
 *
 * 只有管理員能動。學年度決定了班級的歸屬與成績統計的範圍，
 * 改一次會影響全校的資料切分——這是行政決定，不是老師的日常操作。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { createAcademicYear } from '@/lib/academicYear';
import { mayUse } from '@/lib/nav';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const AREA = '/settings/years';

export const GET = scopedRoute(async (_req: NextRequest, { user }) => {
  if (!mayUse(user.systemRole, AREA)) {
    return NextResponse.json({ error: '只有管理員可以管理學年度' }, { status: 403 });
  }
  const years = await prisma.academicYear.findMany({
    orderBy: { startDate: 'desc' },
    include: { _count: { select: { classes: true } } },
  });
  return NextResponse.json({ years });
});

// 日期用 YYYY-MM-DD 字串收，與 <input type="date"> 送出來的一致。
// 收 ISO 時間戳的話，同一天會因為時區被存成前一天，
// 而那個錯誤要等到跨年度統計對不上才會被發現。
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期要像 2026-08-01');

const Body = z.object({
  name: z.string().min(1).max(40),
  startDate: Day,
  endDate: Day,
  isCurrent: z.boolean().optional(),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  if (!mayUse(user.systemRole, AREA)) {
    return NextResponse.json({ error: '只有管理員可以建立學年度' }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: '請填寫學年度名稱與起訖日期', detail: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }
  try {
    const year = await createAcademicYear(parsed.data, user.id);
    return NextResponse.json({ ok: true, year });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
});
