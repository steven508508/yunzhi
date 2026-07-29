/**
 * 老師重設一位學生的密碼。
 *
 * # 這是上線第一天就會被按的按鈕
 *
 * 在此之前，初始密碼只在名冊匯入的那一次回傳，之後系統裡**沒有任何
 * 介面可以重設**。兩百位學生第一次登入，忘記密碼的一定不只一個，
 * 而當時唯一的解法是「把整份名冊再匯一次」——那會動到不該被動到的人。
 *
 * 刻意**不做**寄信的忘記密碼流程：這些學生多半沒有登記 email，而
 * 系統跑在補習班的封閉網段裡，對外的 SMTP 是
 * ERR_TUNNEL_CONNECTION_FAILED。做一個寄不出去的重設信，比沒有更糟。
 *
 * # 誰按得動
 *
 * 與「登錄家長同意」同一組角色。理由是同一個現實：學生是在櫃檯或
 * 教室裡跟**現場的那一位老師**講的，而要求他去找導師或管理員，
 * 等於這個功能在最需要的那一刻不存在。
 *
 * 提權的那條路擋在 `resetStudentPassword` 裡：**只有 STUDENT 帳號
 * 重設得了**。不限定對象的話，一位老師就能對著管理員的 userId 打
 * 一次這支 API 然後用管理員的身分登入。
 */
import { NextRequest, NextResponse } from 'next/server';

import { scopedRoute } from '@/lib/route';
import { resetStudentPassword } from '@/lib/roster';

export const dynamic = 'force-dynamic';

const MAY_RESET = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN', 'TEACHER', 'SUBJECT_LEAD']);

export const POST = scopedRoute<{ studentId: string }>(
  async (_req: NextRequest, { user, params }) => {
    if (!MAY_RESET.has(user.systemRole)) {
      return NextResponse.json({ error: '沒有權限重設密碼' }, { status: 403 });
    }
    try {
      const credential = await resetStudentPassword(params.studentId, user.id);
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
