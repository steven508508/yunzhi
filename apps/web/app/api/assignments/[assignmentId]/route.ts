/**
 * 一個任務：改設定、換對象、刪除。
 *
 * 「哪些欄位在考試開始後還改得動」不在這裡判，在 `lib/assignment.ts`——
 * 那個規則會被學生端與催繳流程一起用到，寫在路由裡等於只有這一條
 * 路徑受保護。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { deleteAssignment, resolveRecipients, updateAssignment } from '@/lib/assignment';
import { canEditSubject, type SessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Patch = z.object({
  title: z.string().min(1).max(120).optional(),
  paperId: z.string().min(1).optional(),
  mode: z.enum(['EXAM', 'PRACTICE']).optional(),
  openAt: z.coerce.date().nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
  timeLimitMin: z.number().int().positive().max(600).nullable().optional(),
  allowLate: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(50).optional(),
  shuffleQuestions: z.boolean().optional(),
  shuffleOptions: z.boolean().optional(),
  releasePolicy: z.enum(['IMMEDIATE', 'ON_SUBMIT', 'ON_DUE', 'MANUAL', 'NEVER']).optional(),
  released: z.boolean().optional(),
  targets: z
    .object({
      classIds: z.array(z.string()).optional(),
      userIds: z.array(z.string()).optional(),
    })
    .optional(),
});

/**
 * 任務存在嗎、這個人動得了它嗎。
 *
 * 科目職權看的是**卷子的科目**：任務自己沒有科目欄位。
 */
async function openAssignment(assignmentId: string, user: SessionUser) {
  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId },
    select: { id: true, title: true, paper: { select: { subjectId: true } } },
  });
  if (!assignment) {
    return { error: NextResponse.json({ error: '找不到這個任務' }, { status: 404 }) };
  }
  if (!(await canEditSubject(user, assignment.paper.subjectId))) {
    return {
      error: NextResponse.json(
        { error: `你不是這一科的授課老師，改不了「${assignment.title}」` },
        { status: 403 },
      ),
    };
  }
  return { assignment };
}

export const PATCH = scopedRoute<{ assignmentId: string }>(
  async (req: NextRequest, { user, params }) => {
    const found = await openAssignment(params.assignmentId, user);
    if (found.error) return found.error;

    const parsed = Patch.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: '沒有可以更新的內容' }, { status: 400 });
    }

    try {
      const assignment = await updateAssignment(params.assignmentId, parsed.data, user);
      // 回傳更新後的實際人數：改了派發對象之後，老師要確認的就是這個數字。
      const recipients = await resolveRecipients(params.assignmentId);
      return NextResponse.json({ ok: true, assignment, recipients: recipients.length });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);

export const DELETE = scopedRoute<{ assignmentId: string }>(async (_req, { user, params }) => {
  const found = await openAssignment(params.assignmentId, user);
  if (found.error) return found.error;
  try {
    const assignment = await deleteAssignment(params.assignmentId, user.id);
    return NextResponse.json({ ok: true, assignment });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
});
