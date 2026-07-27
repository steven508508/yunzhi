import { NextRequest, NextResponse } from 'next/server';

/**
 * 路由保護。
 *
 * 這裡刻意只檢查 cookie 是否存在，**不查資料庫**——middleware 跑在
 * 每一個請求上，加一次資料庫往返會讓所有頁面變慢。真正的驗證在
 * requireUser()，由頁面與 API 各自執行。
 *
 * 也就是說 middleware 只負責「沒有 cookie 就導去登入」這件便宜的事，
 * 「cookie 有效嗎」是後面的事。
 */
const PUBLIC = ['/login', '/api/auth/login', '/api/healthz', '/api/readyz'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  if (pathname.startsWith('/_next') || pathname === '/favicon.ico') {
    return NextResponse.next();
  }

  if (!req.cookies.get('yz_session')) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: '未登入' }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
