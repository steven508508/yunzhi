import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logout, SESSION_COOKIE } from '@/lib/password';
import { withoutTenantScope } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * 登出。
 *
 * **這一支必須跨租戶執行，而且理由要講清楚。** 手上只有 cookie 裡的
 * token，沒有辦法知道它屬於哪個租戶——與 `requireUser` 是同一種
 * 雞生蛋問題。sessionToken 是密碼學亂數，猜不到別人的，所以
 * 「跨租戶刪一個給定的 token」不會影響任何其他人。
 *
 * 少了這一層，RLS 會讓 deleteMany 比對不到任何一列：**cookie 清掉了，
 * 伺服器端的 session 卻還活著**。畫面上看起來完全正常，而那個
 * session 到期之前都還能用——考試場景裡「立刻登出某個帳號」的能力
 * 就是這樣消失的。
 */
export async function POST() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await withoutTenantScope('登出：手上只有 token，還不知道它屬於哪個租戶', () =>
      logout(token),
    );
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
