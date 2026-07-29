import { NextRequest, NextResponse } from 'next/server';
import { scopedRoute } from '@/lib/route';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { loadJob, saveReviews } from '@/lib/candidates';
import {canEditSubject } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * 校對這份題本的資格。
 *
 * 這支 API 是校對頁面的後端，而**頁面本身**（`app/(app)/import/[params.jobId]`）
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

export const GET = scopedRoute<{ jobId: string }>(async (_req: NextRequest, { user, params }) => {

  const gate = await mayReview(params.jobId, user);
  if (gate.error) return gate.error;

  const data = await loadJob(params.jobId, user.tenantId);
  if (!data) return NextResponse.json({ error: '找不到匯入工作' }, { status: 404 });
  return NextResponse.json(data);
});

const PatchBody = z.object({
  changes: z.array(z.object({
    id: z.string().min(1),
    state: z.enum(['PENDING', 'CONFIRMED', 'FLAGGED', 'DISCARDED']).optional(),
    note: z.string().max(2000).optional(),
    patch: z.record(z.string(), z.unknown()).optional(),
  })).min(1).max(500),
  /**
   * 這一批涵蓋的校對秒數（增量）。
   *
   * **語意是增量而不是累計。** 前端每次成功存檔之後才把回報點往前推，
   * 所以重送同一批只會多算一次 8 秒以內的量；而累計值在「分兩天校完
   * 一份題本」時會把前一天的用時整個蓋掉。
   */
  reviewSeconds: z.number().int().min(0).max(86400).optional(),
});

export const PATCH = scopedRoute<{ jobId: string }>(async (req: NextRequest, { user, params }) => {

  const gate = await mayReview(params.jobId, user);
  if (gate.error) return gate.error;

  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: '請求格式錯誤', detail: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) },
      { status: 400 },
    );
  }

  try {
    const job = await saveReviews(
      params.jobId,
      user.tenantId,
      user.id,
      parsed.data.changes,
      parsed.data.reviewSeconds ?? 0,
    );
    return NextResponse.json({
      ok: true,
      confirmed: job.confirmedCount,
      flagged: job.flaggedCount,
      total: job.totalCandidates,
      // 回報累計用時，讓校對介面在完成時說得出「這份題本 N 題，
      // 花了 M 分鐘」——那正是業主驗收要看的那個數字。
      reviewSeconds: job.reviewSeconds,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
});

/**
 * 與 PATCH 同一件事，只是給 `navigator.sendBeacon` 用。
 *
 * **sendBeacon 一定是 POST，沒有選項可以改。** 校對介面在
 * `beforeunload` 時用它把還沒存的變更送出去（見 Review.tsx），
 * 而這個路由原本只有 GET 與 PATCH——於是每一次都是 405，
 * 最多八秒的校對成果加上關閉分頁當下所有未存的變更全部靜靜丟掉。
 *
 * 那正是那段程式的註解說它要防止的事。
 *
 * 瀏覽器不保證 beacon 送得出去，所以這裡的行為必須與 PATCH 完全
 * 一致而且可以重複送——同一批變更送兩次的結果要跟送一次一樣。
 * `saveCandidates` 是依 id 更新，本來就滿足。
 */
export const POST = PATCH;
