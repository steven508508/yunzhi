import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logout, SESSION_COOKIE } from '@/lib/password';

export const dynamic = 'force-dynamic';

export async function POST() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await logout(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
