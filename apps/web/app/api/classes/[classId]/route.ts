/**
 * 改一個班級：改名、停用、重新啟用。
 *
 * # 這一支在補什麼
 *
 * `renameClass` 與 `deactivateClass`（`lib/roster.ts`）在此之前**沒有
 * 任何呼叫端**——兩支都寫好了、有重複檢查、有稽核，只是沒有路由。
 * 於是：
 *
 *   · 班名打錯了就是一輩子。而第一天正是最容易打錯、也最容易發現
 *     命名規則要改的那一天（7 個班要一次想好）。
 *   · 舊學年度的班永遠留在 `/classes` 上。第二年開學時列表上是
 *     14 個班，其中 7 個已經沒有人了，而看的人分不出哪 7 個。
 *
 * # 為什麼只有校務管理員動得了
 *
 * 與「開一個新班」同一條規則（見 `POST /api/classes`）：班級的結構是
 * 行政決定，它影響學年度的歸屬、派卷的對象與成績統計的範圍。
 * 導師管得動自己班的**名冊**，但班級本身不是他的。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';
import { activateClass, deactivateClass, renameClass } from '@/lib/roster';

export const dynamic = 'force-dynamic';

const ADMIN = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN']);

const Body = z.object({
  name: z.string().min(1).max(60).optional(),
  /** true = 啟用，false = 停用。**不是刪除**——名冊與成績都留著。 */
  active: z.boolean().optional(),
});

export const PATCH = scopedRoute<{ classId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (!ADMIN.has(user.systemRole)) {
      return NextResponse.json({ error: '只有校務管理員可以修改班級' }, { status: 403 });
    }
    const klass = await prisma.class.findFirst({
      where: { id: params.classId },
      select: { id: true, name: true },
    });
    if (!klass) return NextResponse.json({ error: '找不到這個班級' }, { status: 404 });

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: '這次修改的內容看不懂', detail: parsed.error.issues.map((i) => i.message) },
        { status: 400 },
      );
    }
    const { name, active } = parsed.data;
    if (name === undefined && active === undefined) {
      return NextResponse.json({ error: '沒有任何要修改的內容' }, { status: 400 });
    }

    try {
      // 順序：先改名再改狀態。反過來的話，改名撞到重複時班級已經停用了
      // ——而使用者看到的是一則錯誤訊息，他會以為兩件事都沒發生。
      // 與 `PATCH /api/staff/[userId]` 同一個理由。
      if (name !== undefined) await renameClass(params.classId, name, user.id);
      if (active !== undefined) {
        if (active) await activateClass(params.classId, user.id);
        else await deactivateClass(params.classId, user.id);
      }
      const after = await prisma.class.findFirst({
        where: { id: params.classId },
        select: { id: true, name: true, active: true },
      });
      return NextResponse.json({ ok: true, class: after });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);
