import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { login, SESSION_COOKIE } from '@/lib/password';
import { resolveRequestTenant } from '@/lib/auth';
import { withTenant } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

const Body = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: '請輸入帳號與密碼' }, { status: 400 });
  }

  // 登入是唯一「還不知道租戶」的路由，所以租戶要另外解析出來。
  // 目前單一機構自架固定一筆；白牌多租戶時改 resolveRequestTenant 一支就好。
  const tenantId = await resolveRequestTenant();
  if (!tenantId) return NextResponse.json({ error: '系統尚未初始化' }, { status: 503 });

  // nginx 設定裡的 X-Forwarded-For 在這裡被讀取。少了它，
  // 稽核記錄的來源 IP 全部會是 127.0.0.1。
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    undefined;

  const result = await withTenant(tenantId, () =>
    login(tenantId, parsed.data.username, parsed.data.password, {
      ip,
      userAgent: req.headers.get('user-agent') ?? undefined,
    }),
  );

  if (!result.ok) {
    const msg =
      result.reason === 'locked'
        ? `連續登入失敗過多，請於 ${result.retryAfterMinutes} 分鐘後再試`
        : result.reason === 'inactive'
          ? '此帳號目前無法登入，請洽管理員'
          : '帳號或密碼不正確';
    return NextResponse.json({ error: msg }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, mustChangePassword: result.mustChangePassword });
  res.cookies.set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: result.expires,
  });
  return res;
}
