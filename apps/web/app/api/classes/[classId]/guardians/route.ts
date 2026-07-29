/**
 * 依名冊上的家長信箱，把整個班的家長帳號與連結建起來。
 *
 * # 為什麼它是一支獨立的路由，而不是只跟在名冊匯入後面
 *
 * 名冊匯入的確會呼叫同一支函式（見 `roster/route.ts`），但那條路徑
 * 不夠：家長信箱最常是**匯入之後**才補上的（第一份名冊上那一欄
 * 是空的，過兩天櫃檯才收齊回條）。沒有這一支的話，唯一的辦法是
 * 把整份名冊再匯一次——而那會動到不該被動到的人。
 *
 * `provisionGuardiansForClass` 是冪等的，所以這顆按鈕按幾次都一樣：
 * 已經接好的不重建、既有帳號不重設密碼。
 *
 * # 權限與名冊匯入完全相同
 *
 * 管理員或該班導師。這一支會**建立帳號並把成績的檢視權發出去**，
 * 那是名冊等級的動作，不是「重設一位學生的密碼」那種現場急件。
 */
import { NextResponse } from 'next/server';

import { isHomeroomOf } from '@/lib/auth';
import { guardianFailure, provisionGuardiansForClass } from '@/lib/guardian';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/**
 * 上限與名冊匯入那一支對齊，理由也相同：**這個數字是被 bcrypt 決定
 * 的**。每一個新家長帳號要算一次 12 輪的雜湊，實測約 310 毫秒，
 * 200 位就是 62 秒。Caddy 那一側的 `write 300s` 對得上。
 */
export const maxDuration = 300;

async function mayEdit(classId: string, user: { id: string; systemRole: string }) {
  if (user.systemRole === 'SYS_ADMIN' || user.systemRole === 'SCHOOL_ADMIN') return true;
  return isHomeroomOf(user.id, classId);
}

export const POST = scopedRoute<{ classId: string }>(async (_req, { user, params }) => {
  const klass = await prisma.class.findFirst({
    where: { id: params.classId },
    select: { id: true, name: true },
  });
  if (!klass) return NextResponse.json({ error: '找不到這個班級' }, { status: 404 });
  if (!(await mayEdit(params.classId, user))) {
    return NextResponse.json(
      { error: `你不是「${klass.name}」的導師，無法建立家長帳號` },
      { status: 403 },
    );
  }

  try {
    const result = await provisionGuardiansForClass(params.classId, user.id);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    const { status, body } = guardianFailure(e);
    return NextResponse.json(body, { status });
  }
});
