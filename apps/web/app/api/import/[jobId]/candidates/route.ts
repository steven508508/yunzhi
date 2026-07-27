import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { loadJob, saveReviews } from '@/lib/candidates';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: '未登入' }, { status: 401 });

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
