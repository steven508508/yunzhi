/**
 * 教職員帳號。
 *
 * # 為什麼建立帳號要回傳一串明文密碼
 *
 * 因為系統對外沒有信箱。這些帳號跑在補習班的封閉網段裡，對外的 SMTP
 * 是 ERR_TUNNEL_CONNECTION_FAILED——做一個寄不出去的「設定密碼」信，
 * 比當面把密碼唸出來更糟。與學生的初始密碼同一個處理方式
 * （見 `lib/roster.ts`）：只回傳這一次，畫面上只顯示這一次。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { mayUse } from '@/lib/nav';
import { scopedRoute } from '@/lib/route';
import { createStaff, listStaff } from '@/lib/staff';

export const dynamic = 'force-dynamic';

const AREA = '/settings/staff';

export const GET = scopedRoute(async (_req: NextRequest, { user }) => {
  if (!mayUse(user.systemRole, AREA)) {
    return NextResponse.json({ error: '只有管理員可以管理教職員帳號' }, { status: 403 });
  }
  return NextResponse.json({ staff: await listStaff() });
});

const Body = z.object({
  displayName: z.string().min(1).max(40),
  username: z.string().min(1).max(40),
  // 角色的合法性交給 lib/staffRules.mjs 判斷，不在這裡列第二份清單。
  // 兩份清單就是兩個會分岐的地方，而分岐的方向若是這裡比較寬，
  // 擋不住的那一個角色會直接被寫進資料庫。
  systemRole: z.string().min(1).max(30),
  email: z.string().email('信箱格式不對').max(120).nullish(),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  if (!mayUse(user.systemRole, AREA)) {
    return NextResponse.json({ error: '只有管理員可以建立教職員帳號' }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: '請填寫姓名、登入帳號與角色', detail: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }
  try {
    const credential = await createStaff(parsed.data, user);
    // 明文密碼只出現在這一個回應裡。**不寫 log、不寫稽核、不存起來**
    // ——雜湊之後那串字就沒有第二個副本了。
    return NextResponse.json({ ok: true, credential });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
});
