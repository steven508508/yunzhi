/**
 * 任務。
 *
 * 派任務要有那一科的授課權（訪談第 14 題：「派：科目或班級老師」）。
 * 判定的依據是**卷子的科目**，因為任務本身沒有科目——它是一份卷子
 * 加上派發設定。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { createAssignment } from '@/lib/assignment';
import { canEditSubject } from '@/lib/auth';
import { mayComposeArea } from '@/lib/paper';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/** 一次最多回幾份。回應要帶 `truncated`，見下面。 */
const PAGE = 200;

export const GET = scopedRoute(async (req: NextRequest, { user }) => {
  if (!mayComposeArea(user.systemRole, '/assignments')) {
    return NextResponse.json({ error: '沒有權限' }, { status: 403 });
  }
  const sp = new URL(req.url).searchParams;

  const found = await prisma.assignment.findMany({
    where: {
      ...(sp.get('paper') ? { paperId: sp.get('paper')! } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: PAGE + 1,
    include: {
      paper: { select: { id: true, title: true, totalScore: true, subject: { select: { name: true } } } },
      targets: { select: { classId: true, userId: true, class: { select: { name: true } } } },
      _count: { select: { attempts: true } },
    },
  });
  // 安靜地截斷是最難查的一種錯：呼叫端拿到一個看起來完整的陣列。
  return NextResponse.json({
    assignments: found.slice(0, PAGE),
    truncated: found.length > PAGE,
  });
});

/**
 * 時間欄位用 `z.coerce.date()` 吃前端送來的 ISO 字串。
 *
 * 前端的 `datetime-local` 沒填時是空字串，那會被 coerce 成
 * Invalid Date 而不是 null——所以前端要送 `null`，這裡也明確允許 null。
 */
const Body = z.object({
  paperId: z.string().min(1),
  title: z.string().min(1).max(120),
  mode: z.enum(['EXAM', 'PRACTICE']).optional(),
  openAt: z.coerce.date().nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
  timeLimitMin: z.number().int().positive().max(600).nullable().optional(),
  allowLate: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(50).optional(),
  shuffleQuestions: z.boolean().optional(),
  shuffleOptions: z.boolean().optional(),
  releasePolicy: z.enum(['IMMEDIATE', 'ON_SUBMIT', 'ON_DUE', 'MANUAL', 'NEVER']).optional(),
  targets: z.object({
    classIds: z.array(z.string()).optional(),
    userIds: z.array(z.string()).optional(),
  }),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: '請選擇試卷、填寫任務名稱、並指定派給誰' },
      { status: 400 },
    );
  }

  const paper = await prisma.examPaper.findFirst({
    where: { id: parsed.data.paperId },
    select: { id: true, title: true, subjectId: true },
  });
  if (!paper) return NextResponse.json({ error: '找不到這份試卷' }, { status: 404 });
  if (!(await canEditSubject(user, paper.subjectId))) {
    return NextResponse.json(
      { error: `你不是這一科的授課老師，不能派「${paper.title}」` },
      { status: 403 },
    );
  }

  try {
    // 帶的是整個 user 而不是 user.id：可以派給哪幾個班要看角色與
    // 授課／導師關係，而那個判斷在 lib/assignment.ts 裡（見
    // `assignableClassIds`）——只傳 id 過去就判不了，於是又會有人
    // 在路由這一層補一份，然後兩份規則開始分岐。
    const created = await createAssignment(parsed.data, user);
    return NextResponse.json({ ok: true, ...created });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
});
