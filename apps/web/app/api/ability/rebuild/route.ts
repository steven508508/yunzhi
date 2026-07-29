/**
 * 從既有作答重建能力快照。
 *
 * # 為什麼要有這一支，明明計分完就會自動更新
 *
 * 因為**第一次上線時快照是空的**。作答記錄可能已經累積了一整個學期，
 * 而能力分析是後來才接上去的；不重建的話，班級的弱點分析要等到
 * 下一次考試才開始有東西，而在那之前每一頁都寫著「還沒有資料」——
 * 看的人會以為功能壞了。
 *
 * 第二個用途是**復原**。快照是衍生資料，任何時候懷疑它不準，
 * 重建一次就會回到與作答記錄一致。它與逐次更新走同一支
 * `refreshAbility`（見 lib/ability.mjs），所以兩者不可能算出不同答案。
 *
 * # 為什麼是 POST 而不是一支 GET
 *
 * 它會寫入。放成 GET 的話，任何一次預載、爬蟲或瀏覽器的預先連線
 * 都會重建整個補習班的快照。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { isHomeroomOf } from '@/lib/auth';
import { rebuildAbilityFor } from '@/lib/abilityDb';
import { mayUse } from '@/lib/nav';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';
import { teachesClass } from '@/lib/teaching';

export const dynamic = 'force-dynamic';

const ADMIN = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN']);

const Body = z.object({
  /** 只重建這個班。不給就是整個補習班——那一種只有管理員做得了。 */
  classId: z.string().min(1).optional(),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  // 能力分析屬於老師的工作區。學生看自己的分析走 `/ability`，
  // 那一頁不需要、也不該有重建的入口。
  if (!mayUse(user.systemRole, '/classes')) {
    return NextResponse.json({ error: '只有老師與管理員可以重建能力快照' }, { status: 403 });
  }

  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: '參數不正確' }, { status: 400 });
  }
  const { classId } = parsed.data;
  const isAdmin = ADMIN.has(user.systemRole);

  if (!classId && !isAdmin) {
    // 整個補習班的重建會掃過每一位學生的每一份作答。它不會改成績，
    // 但它是一件全校範圍的事，而科任老師的職權是他的班與他的科。
    return NextResponse.json(
      { error: '整個補習班的重建請由管理員執行。你可以重建自己帶的班。' },
      { status: 403 },
    );
  }

  if (classId) {
    const klass = await prisma.class.findFirst({
      where: { id: classId },
      select: { id: true, name: true },
    });
    if (!klass) return NextResponse.json({ error: '找不到這個班' }, { status: 404 });
    // 與班級頁完全相同的存取判定：管理員、這個班的導師，或授課老師。
    if (!isAdmin && !(await isHomeroomOf(user.id, classId)) && !(await teachesClass(user.id, classId))) {
      return NextResponse.json({ error: '你沒有帶這個班' }, { status: 403 });
    }
  }

  const result = await rebuildAbilityFor(classId ?? null);

  // 重建會改變老師與家長看到的每一個掌握度。它不改成績，但它改的是
  // 「這孩子哪裡弱」——約談時拿出來的東西。誰在什麼時候重建過，
  // 事後要說得出來。
  await prisma.auditLog.create({
    data: {
      tenantId: user.tenantId,
      category: 'SYSTEM',
      action: 'ability.rebuild',
      actorId: user.id,
      targetType: classId ? 'Class' : 'Tenant',
      targetId: classId ?? user.tenantId,
      after: {
        users: result.users,
        points: result.points,
        removed: result.removed,
        failures: result.failures.length,
      },
      metadata: { failures: result.failures.slice(0, 20) },
    },
  });

  return NextResponse.json({ ok: true, ...result });
});
