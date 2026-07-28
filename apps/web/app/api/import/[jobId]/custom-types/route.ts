/**
 * 出版社專屬題型的確認。
 *
 * GET  列出這份工作裡「模型提議但還沒確認」的題型
 * POST 老師確認一個，並把同名的候選題全部接上
 *
 * 這是「向老師確認即可」實際發生的地方。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser, canEditSubject } from '@/lib/auth';
import {
  ANSWER_MODES,
  RIGHTS,
  applyType,
  confirmType,
  pendingTypes,
} from '@/lib/customTypes';

export const dynamic = 'force-dynamic';

/**
 * 只有這一科的授課老師能確認。
 *
 * 確認一個題型是**跨匯入、跨學期**的決定——它會影響之後每一次
 * 匯入的辨識結果，而且它記錄了「我們有沒有取得授權」。那不是
 * 任何一個登入者都該按的按鈕。
 */
async function gate(jobId: string, user: { id: string; tenantId: string }) {
  const job = await prisma.importJob.findFirst({
    where: { id: jobId, tenantId: user.tenantId },
    select: { subjectId: true, subject: { select: { name: true } } },
  });
  if (!job) {
    return { error: NextResponse.json({ error: '找不到匯入工作' }, { status: 404 }) };
  }
  if (!(await canEditSubject(user as never, job.subjectId))) {
    return {
      error: NextResponse.json(
        { error: `你不是「${job.subject.name}」的授課老師，無法確認題型` },
        { status: 403 },
      ),
    };
  }
  return { job };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: '未登入' }, { status: 401 });

  const g = await gate(jobId, user);
  if (g.error) return g.error;

  const [pending, known] = await Promise.all([
    pendingTypes(jobId, user.tenantId),
    prisma.customQuestionType.findMany({
      where: { tenantId: user.tenantId, active: true },
      orderBy: { usageCount: 'desc' },
      select: {
        id: true, name: true, publisherName: true, answerMode: true,
        description: true, rightsBasis: true, usageCount: true,
        confirmedName: true, confirmedAt: true,
      },
    }),
  ]);

  return NextResponse.json({
    pending,
    known,
    answerModes: ANSWER_MODES,
    rights: RIGHTS,
  });
}

const Body = z.object({
  // 模型提議的名稱。確認之後要用它把同名的候選題接上。
  proposedName: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(2000),
  answerMode: z.enum(ANSWER_MODES),
  publisherName: z.string().max(100).optional(),
  recognitionHint: z.string().max(1000).optional(),
  exampleAssetKey: z.string().max(500).optional(),
  rightsBasis: z.enum(RIGHTS),
  rightsNote: z.string().max(2000).optional(),
  // 老師勾選的確認框。沒有勾就不收——責任歸屬要明確，
  // 而這一項記的是「我們有權利用這個出版社的題型」。
  rightsConfirmed: z.literal(true, {
    errorMap: () => ({ message: '請先確認這個題型的使用權利' }),
  }),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: '未登入' }, { status: 401 });

  const g = await gate(jobId, user);
  if (g.error) return g.error;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: '表單填寫不完整',
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}：${i.message}`),
      },
      { status: 400 },
    );
  }
  const b = parsed.data;

  try {
    const saved = await confirmType(user.tenantId, user, b);
    const applied = await applyType(jobId, user.tenantId, b.proposedName, saved.id);
    return NextResponse.json({
      ok: true,
      typeId: saved.id,
      name: saved.name,
      applied,
      hint:
        applied > 0
          ? `已套用到這份題本的 ${applied} 題，之後匯入同一種題型會直接認得。`
          : '已建立題型定義，之後匯入同一種題型會直接認得。',
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
