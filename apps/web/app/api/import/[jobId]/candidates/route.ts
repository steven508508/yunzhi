import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { loadJob, saveReviews } from '@/lib/candidates';
import { requireUser, canEditSubject } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * 校對這份題本的資格。
 *
 * 這支 API 是校對頁面的後端，而**頁面本身**（`app/(app)/import/[jobId]`）
 * 早就有 `canEditSubject` 的檢查——只有支撐它的 API 沒有。同一個功能
 * 的其他入口（上傳擋學生與家長、入庫與續跑要 `canEditSubject`）也都
 * 有檢查。少了這一段，只教數學的老師可以改英文科題本的答案，而題本
 * 清單頁對任何登入者列出最近 50 筆工作與 ID，連猜都不必猜。
 */
async function mayReview(jobId: string, user: { id: string; tenantId: string; systemRole?: string }) {
  const job = await prisma.importJob.findFirst({
    where: { id: jobId, tenantId: user.tenantId },
    select: { subjectId: true, subject: { select: { name: true } } },
  });
  if (!job) return { error: NextResponse.json({ error: '找不到匯入工作' }, { status: 404 }) };
  if (!(await canEditSubject(user as never, job.subjectId))) {
    return {
      error: NextResponse.json(
        { error: `你不是「${job.subject.name}」的授課老師，無法校對這份題本` },
        { status: 403 },
      ),
    };
  }
  return { job };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: '未登入' }, { status: 401 });

  const gate = await mayReview(jobId, user);
  if (gate.error) return gate.error;

  const data = await loadJob(jobId, user.tenantId);
  if (!data) return NextResponse.json({ error: '找不到匯入工作' }, { status: 404 });
  return NextResponse.json(data);
}

const PatchBody = z.object({
  changes: z.array(z.object({
    id: z.string().min(1),
    state: z.enum(['PENDING', 'CONFIRMED', 'FLAGGED', 'DISCARDED']).optional(),
    note: z.string().max(2000).optional(),
    patch: z.record(z.string(), z.unknown()).optional(),
  })).min(1).max(500),
  reviewSeconds: z.number().int().min(0).max(86400).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: '未登入' }, { status: 401 });

  const gate = await mayReview(jobId, user);
  if (gate.error) return gate.error;

  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: '請求格式錯誤', detail: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) },
      { status: 400 },
    );
  }

  try {
    const job = await saveReviews(jobId, user.tenantId, user.id, parsed.data.changes);
    return NextResponse.json({
      ok: true,
      confirmed: job.confirmedCount,
      flagged: job.flaggedCount,
      total: job.totalCandidates,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
