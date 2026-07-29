/**
 * 重設一位教職員的密碼。
 *
 * # 為什麼不能沿用學生那一支
 *
 * `/api/students/[studentId]/password` 底下的 `resetStudentPassword`
 * **只重設得了 STUDENT 帳號**，而那一道限制正是它的安全性所在：
 * 不限定對象的話，一位老師就能對著管理員的 userId 打一次那支 API
 * 然後用管理員的身分登入。
 *
 * 所以教職員的重設走這一支，而且入口收窄到管理員——老師的密碼
 * 不像學生的密碼那樣是「站在櫃檯的急件」，它可以等到找得到管理員。
 * 兩邊各自守住自己的那一半，中間沒有縫。
 */
import { NextRequest, NextResponse } from 'next/server';

import { mayUse } from '@/lib/nav';
import { scopedRoute } from '@/lib/route';
import { resetStaffPassword } from '@/lib/staff';

export const dynamic = 'force-dynamic';

const AREA = '/settings/staff';

export const POST = scopedRoute<{ userId: string }>(
  async (_req: NextRequest, { user, params }) => {
    if (!mayUse(user.systemRole, AREA)) {
      return NextResponse.json({ error: '只有管理員可以重設教職員的密碼' }, { status: 403 });
    }
    try {
      const credential = await resetStaffPassword(params.userId, user);
      // 明文密碼只出現在這一個回應裡。**不寫 log、不寫稽核、不存起來**
      // ——雜湊之後那串字就沒有第二個副本了，而畫面上也只顯示一次。
      return NextResponse.json({ ok: true, credential });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);
