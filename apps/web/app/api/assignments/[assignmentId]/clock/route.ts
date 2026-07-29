/**
 * 考試當天的兩個時鐘動作：延長作答時間，與立刻結束這場考試。
 *
 * # 為什麼這兩件事之前完全做不到
 *
 * 全班斷網十分鐘，老師要補回來。他會去改任務的「作答時限」——
 * 那一欄在有人開始作答之後就凍結了，而且**就算解凍也沒有作用**：
 * `expiresAt` 是每個人開始作答的那一刻算好寫死的，任務設定改了不會
 * 回頭重算已經開始的那幾份。全 repo 對 `expiresAt` 只有一次寫入。
 *
 * 反方向也一樣壞：任務設定裡那句「要立刻結束這場考試，把截止時間
 * 改成現在」停不掉正在寫的 32 個人——`attemptWritable` 只看
 * `expiresAt`，不看 `assignment.dueAt`。它只擋得住還沒開始的人。
 *
 * 所以這一支直接改 `attempts.expiresAt`。**學生端不必做任何事就會
 * 跟上**：作答頁每 30 秒打一次 `GET /api/attempts/:id` 校時，那一支
 * 回的 `remainingSeconds` 是拿資料庫裡的 `expiresAt` 現算的。
 *
 * # 為什麼兩個動作在同一支路由
 *
 * 因為它們是同一個東西的兩個方向（把到期時刻往後推 / 拉到現在），
 * 權限與稽核分類完全相同。分成兩支的話，遲早有一支的權限判斷被改
 * 而另一支沒跟上——而不一致的方向若是「結束比延長寬鬆」，那就是
 * 別科的老師停得掉一場正在進行的考試。
 *
 * # 為什麼權限用 mayGrade 而不是 canEditSubject
 *
 * 與「代為結算」「作廢」「重新計分」同一條。延長時間直接改變了
 * 一場考試每個人拿到的時間，那與改分數是同一個層級的事。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { endAttemptsNow, extendAttempts } from '@/lib/assignment';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';
import { mayGrade } from '@/lib/scoring';

export const dynamic = 'force-dynamic';

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('extend'),
    minutes: z.number().int().positive().max(600),
    /** 只延長某一位（遲到、特殊需求）。不給就是整份任務的進行中作答。 */
    attemptId: z.string().min(1).nullish(),
    reason: z.string().max(500).nullish(),
  }),
  z.object({
    action: z.literal('end'),
    reason: z.string().max(500).nullish(),
  }),
]);

export const POST = scopedRoute<{ assignmentId: string }>(
  async (req: NextRequest, { user, params }) => {
    const assignment = await prisma.assignment.findFirst({
      where: { id: params.assignmentId },
      select: { id: true, title: true, paper: { select: { subjectId: true } } },
    });
    // 查不到有兩種可能：不存在，或不是這個租戶的（RLS 直接讓它消失）。
    // 兩種都回 404——回 403 等於告訴對方「這個 id 存在」。
    if (!assignment) {
      return NextResponse.json({ error: '找不到這個任務' }, { status: 404 });
    }
    if (!(await mayGrade(user, assignment.paper.subjectId))) {
      return NextResponse.json(
        { error: '只有這一科的授課老師與管理員可以改動進行中的作答時間' },
        { status: 403 },
      );
    }

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: '請指定要延長幾分鐘，或要立刻結束這場考試' },
        { status: 400 },
      );
    }

    try {
      const result =
        parsed.data.action === 'extend'
          ? await extendAttempts(params.assignmentId, {
              minutes: parsed.data.minutes,
              attemptId: parsed.data.attemptId ?? null,
              actorId: user.id,
              reason: parsed.data.reason ?? undefined,
            })
          : await endAttemptsNow(params.assignmentId, {
              actorId: user.id,
              reason: parsed.data.reason ?? undefined,
            });
      return NextResponse.json({ ok: true, result });
    } catch (e) {
      // 「現在沒有進行中的作答」「這一份已經交卷了」都是說得出原因的
      // 狀況，而那些訊息本身就是要顯示給老師看的東西。
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 409 },
      );
    }
  },
);
