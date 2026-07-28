import { NextRequest, NextResponse } from 'next/server';
import { scopedRoute } from '@/lib/route';
import { prisma } from '@/lib/prisma';
import {canEditSubject } from '@/lib/auth';
import { commitJob } from '@/lib/commit';

export const dynamic = 'force-dynamic';
// 一次入庫幾百題會跑一陣子。不做背景化，因為老師按下之後
// 就是在等這個結果——而且它不呼叫 AI，速度是資料庫層級的。
export const maxDuration = 120;

export const POST = scopedRoute<{ jobId: string }>(async (_req: NextRequest, { user, params }) => {

  const job = await prisma.importJob.findFirst({
    where: { id: params.jobId, tenantId: user.tenantId },
    include: { subject: { select: { name: true } } },
  });
  if (!job) return NextResponse.json({ error: '找不到匯入工作' }, { status: 404 });

  if (!(await canEditSubject(user, job.subjectId))) {
    return NextResponse.json(
      { error: `你不是「${job.subject.name}」的授課老師，無法把題目寫進題庫` },
      { status: 403 },
    );
  }

  if (job.status === 'COMMITTING') {
    return NextResponse.json(
      { error: '這份題本正在入庫中，請稍候再試' },
      { status: 409 },
    );
  }

  const confirmed = await prisma.importCandidate.count({
    where: { jobId: params.jobId, state: 'CONFIRMED', questionId: null },
  });
  if (confirmed === 0) {
    return NextResponse.json(
      {
        error: '沒有已確認、且尚未入庫的題目。',
        hint: '校對時把題目標成「✓ 無誤」才會入庫；標成「？ 待查」的會留著。',
      },
      { status: 400 },
    );
  }

  try {
    const result = await commitJob(params.jobId, user.tenantId, user.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // 入庫失敗要把狀態放回去，否則工作會永遠卡在 COMMITTING
    // 而那個狀態沒有任何按鈕可以離開。
    await prisma.importJob
      .update({
        where: { id: params.jobId },
        data: {
          status: 'READY_FOR_REVIEW',
          error: `入庫失敗：${e instanceof Error ? e.message : String(e)}`,
        },
      })
      .catch(() => {});
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
});
