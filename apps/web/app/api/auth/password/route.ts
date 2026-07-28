import { NextRequest, NextResponse } from 'next/server';
import { scopedRoute } from '@/lib/route';
import { z } from 'zod';

import { changePassword } from '@/lib/password';

export const dynamic = 'force-dynamic';

const Body = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

export const POST = scopedRoute(async (req: NextRequest, { user, params }) => {

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: '請求格式錯誤' }, { status: 400 });

  const r = await changePassword(user.id, parsed.data.currentPassword, parsed.data.newPassword);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });

  // 改密碼會作廢所有 session，包含目前這一個 —— 前端要導回登入
  const res = NextResponse.json({ ok: true, reloginRequired: true });
  res.cookies.set('yz_session', '', { path: '/', maxAge: 0 });
  return res;
});
