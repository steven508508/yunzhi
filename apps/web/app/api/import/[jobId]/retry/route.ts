import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser, canEditSubject } from '@/lib/auth';
import { requeueImport, IMPORT_STAGES, type ImportStage } from '@/lib/queue';

export const dynamic = 'force-dynamic';

const Body = z.object({
  /**
   * true  → 從 lastCompletedStage 的下一階段續跑
   * false → 從頭重跑
   *
   * 這個選擇有真實的成本差異，所以由老師明確決定而不是系統猜。
   */
  resume: z.boolean().default(true),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: '未登入' }, { status: 401 });

  const job = await prisma.importJob.findFirst({
    where: { id: jobId, tenantId: user.tenantId },
    include: { subject: { select: { name: true } } },
  });
  if (!job) return NextResponse.json({ error: '找不到匯入工作' }, { status: 404 });

  if (!(await canEditSubject(user, job.subjectId))) {
    return NextResponse.json(
      { error: `你不是「${job.subject.name}」的授課老師` },
      { status: 403 },
    );
  }

  if (job.status === 'COMMITTED') {
    return NextResponse.json({ error: '這份題本已經入庫，不能重跑' }, { status: 409 });
  }

  // 正在跑的不給重跑。同一份題本被解析兩次就是付兩次錢，
  // 而使用者連點兩下按鈕是很正常的行為。
  const running = (IMPORT_STAGES as readonly string[]).includes(job.status);
  if (running) {
    return NextResponse.json(
      { error: '這份題本正在處理中。若你認為它卡住了，請等到系統判定逾時後再試。' },
      { status: 409 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  const resume = parsed.success ? parsed.data.resume : true;

  let fromStage: ImportStage | undefined;
  if (resume && job.lastCompletedStage) {
    const next = IMPORT_STAGES[IMPORT_STAGES.indexOf(job.lastCompletedStage as ImportStage) + 1];
    if (!next) {
      // 全部階段都完成過了，直接標成待校對即可，不必再跑一次。
      await prisma.importJob.update({
        where: { id: jobId },
        data: { status: 'READY_FOR_REVIEW', error: null },
      });
      return NextResponse.json({ ok: true, action: 'marked_ready' });
    }
    fromStage = next;
  }

  await prisma.importJob.update({
    where: { id: jobId },
    data: {
      status: 'QUEUED',
      error: null,
      stageStartedAt: null,
      // 從頭重跑就清掉續跑點，否則 worker 會以為還能接續。
      ...(resume ? {} : { lastCompletedStage: null, stageDetail: { stages: {} } }),
    },
  });

  await prisma.auditLog.create({
    data: {
      tenantId: user.tenantId,
      category: 'QUESTION',
      action: resume ? 'import.resume' : 'import.restart',
      actorId: user.id,
      targetType: 'ImportJob',
      targetId: jobId,
      metadata: { fromStage: fromStage ?? null, previousError: job.error },
    },
  });

  try {
    await requeueImport({ jobId, tenantId: user.tenantId, fromStage });
  } catch (e) {
    return NextResponse.json(
      { error: `無法排入佇列：${e instanceof Error ? e.message : String(e)}` },
      { status: 503 },
    );
  }

  return NextResponse.json({ ok: true, fromStage: fromStage ?? 'NORMALIZING' });
}
