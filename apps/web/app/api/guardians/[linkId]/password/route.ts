/**
 * 重設一位家長的密碼。
 *
 * # 為什麼參數是 linkId
 *
 * 因為那讓這一支只作用得了「真的接在某位學生身上的家長」。收 userId
 * 的話，它就是一支「給我任何 userId 就產生一組可用密碼」的 API，
 * 而權限發到老師手上——一位老師對著管理員的 id 打一次就拿到了
 * 管理員的密碼，整套角色權限在那一刻歸零。
 *
 * 學生那一支（`/api/students/[studentId]/password`）用
 * `systemRole: 'STUDENT'` 擋同一條提權路徑；家長沒有「屬於哪個班」
 * 可以判定，所以改用連結擋，`resetGuardianPassword` 底下再確認一次
 * 對象真的是 GUARDIAN 帳號。
 *
 * 刻意**不做**寄信的忘記密碼流程，與學生那一支同一個現實：系統跑在
 * 補習班的封閉網段，對外的 SMTP 是 ERR_TUNNEL_CONNECTION_FAILED。
 * 做一個寄不出去的重設信，比沒有更糟——家長會等一封永遠不會到的信。
 */
import { NextResponse } from 'next/server';

import { guardianFailure, isStaff, resetGuardianPassword } from '@/lib/guardian';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

export const POST = scopedRoute<{ linkId: string }>(async (_req, { user, params }) => {
  if (!isStaff(user.systemRole)) {
    return NextResponse.json({ error: '沒有權限重設密碼' }, { status: 403 });
  }
  try {
    const credential = await resetGuardianPassword(params.linkId, user.id);
    // 明文密碼只出現在這一個回應裡。**不寫 log、不寫稽核、不存起來**
    // ——雜湊之後那串字就沒有第二個副本了，而畫面上也只顯示一次。
    return NextResponse.json({ ok: true, credential });
  } catch (e) {
    const { status, body } = guardianFailure(e);
    return NextResponse.json(body, { status });
  }
});
