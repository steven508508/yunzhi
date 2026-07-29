/**
 * 整班重設密碼。
 *
 * # 為什麼權限比單一位嚴格
 *
 * 單一位重設是**急件**：學生站在櫃檯說登不進去，現場的任何一位老師
 * 都要處理得了，否則這個功能在最需要的那一刻不存在。
 *
 * 整班重設不是急件，它是開學或期初的行政作業，而它的後果是**全班
 * 現有的密碼同時失效**——包含那些已經改過、自己記得的人。所以這裡
 * 收窄到管理員與該班導師，與「匯入名冊」同一條規則（見 roster 路由）：
 * 那兩件事影響的範圍一樣大。
 *
 * # 為什麼要再打一次班級名稱
 *
 * 因為這顆按鈕要**比單一位難按一點**。單一位按錯的代價是一位學生
 * 要重抄一次密碼；整班按錯的代價是三十個人明天早上都登不進去，
 * 而其中沒有一個人知道為什麼。確認視窗上打出班級名稱是最便宜的
 * 一道「你確定你按的是這一班嗎」——它同時擋掉誤觸與**按到隔壁那
 * 一班**，而後者光靠「確定嗎」是擋不住的。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { isHomeroomOf } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';
import { resetClassPasswords } from '@/lib/roster';

export const dynamic = 'force-dynamic';

const Body = z.object({
  /** 使用者打進去的班級名稱。要與資料庫裡的完全相同才執行。 */
  confirmName: z.string().min(1).max(60),
});

export const POST = scopedRoute<{ classId: string }>(
  async (req: NextRequest, { user, params }) => {
    const klass = await prisma.class.findFirst({
      where: { id: params.classId },
      select: { id: true, name: true },
    });
    if (!klass) return NextResponse.json({ error: '找不到這個班級' }, { status: 404 });

    const isAdmin = user.systemRole === 'SYS_ADMIN' || user.systemRole === 'SCHOOL_ADMIN';
    if (!isAdmin && !(await isHomeroomOf(user.id, params.classId))) {
      return NextResponse.json(
        { error: `你不是「${klass.name}」的導師，無法重設全班的密碼。單獨一位請用名冊上那一列的按鈕。` },
        { status: 403 },
      );
    }

    const parsed = Body.safeParse(await req.json().catch(() => null));
    // 名稱比對在伺服器端再做一次。前端當然也擋，但前端擋的是誤觸，
    // 不是規則——而這一條規則要防的正是「按到隔壁那一班」。
    if (!parsed.success || parsed.data.confirmName.trim() !== klass.name) {
      return NextResponse.json(
        { error: `請完整打出班級名稱「${klass.name}」再確認。` },
        { status: 400 },
      );
    }

    try {
      const result = await resetClassPasswords(params.classId, user.id);
      // 明文密碼只出現在這一個回應裡，而且只顯示一次。
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);
