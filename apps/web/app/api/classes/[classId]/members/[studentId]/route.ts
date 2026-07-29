/**
 * 把一位學生移出班級，或把移出的人放回來。
 *
 * # 這一支在補什麼
 *
 * `ClassMembership.leftAt` 到處都在被讀（`resolveRecipients` 決定誰
 * 收得到任務、`countRecipients` 算應交人數、`listStudentTasks` 決定
 * 學生看得到哪幾份），**但全 repo 沒有任何一行寫過它**。
 *
 * 於是轉班或退補的學生仍然收得到考卷、仍然算進應交人數、仍然出現在
 * 催繳名單上，而老師只能看著一個已經不在的人永遠不交。
 *
 * # 為什麼移出與復原是同一支
 *
 * 它們是同一列上的同一個欄位的兩個值，權限也完全相同。分成兩支的
 * 話，遲早有一支的權限被改而另一支沒跟上——而不一致的方向若是
 * 「復原比移出寬鬆」，就變成別班的老師可以把人塞回這個班的名冊。
 *
 * # 為什麼權限與名冊匯入同一條
 *
 * 移出一位學生與匯入一份名冊改動的是同一份東西（誰在這個班上），
 * 而匯入那一支已經定了規則：管理員或該班導師。兩邊分開判的話，
 * 會出現「他改不了名冊，卻移得掉人」這種說不出道理的組合。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { isHomeroomOf } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';
import { leaveClass, rejoinClass } from '@/lib/roster';

export const dynamic = 'force-dynamic';

const Body = z.object({
  /** true = 移出名冊（寫 leftAt），false = 復原（leftAt 設回 null）。 */
  left: z.boolean(),
});

export const POST = scopedRoute<{ classId: string; studentId: string }>(
  async (req: NextRequest, { user, params }) => {
    const klass = await prisma.class.findFirst({
      where: { id: params.classId },
      select: { id: true, name: true },
    });
    if (!klass) return NextResponse.json({ error: '找不到這個班級' }, { status: 404 });

    const isAdmin = user.systemRole === 'SYS_ADMIN' || user.systemRole === 'SCHOOL_ADMIN';
    if (!isAdmin && !(await isHomeroomOf(user.id, params.classId))) {
      return NextResponse.json(
        { error: `你不是「${klass.name}」的導師，無法調整名冊` },
        { status: 403 },
      );
    }

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: '請求格式錯誤' }, { status: 400 });
    }

    try {
      const result = parsed.data.left
        ? await leaveClass(params.classId, params.studentId, user.id)
        : await rejoinClass(params.classId, params.studentId, user.id);
      return NextResponse.json({ ok: true, student: result.user.displayName });
    } catch (e) {
      // 「他正在作答」「已經移出了」都是說得出原因的狀況，而那些訊息
      // 本身就是要顯示給老師看的東西——尤其考試中那一句，它擋掉的是
      // 一場考試中的災難。
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 409 },
      );
    }
  },
);
