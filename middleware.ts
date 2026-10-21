import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, verifyToken } from './lib/jwt';

/** 无需登录的页面与接口（前缀按「精确 + 斜杠子路径」匹配，不用裸 startsWith，避免 /api/healthX 被放行） */
const PUBLIC_PAGES = ['/login'];
const PUBLIC_API_PREFIX = ['/api/auth', '/api/health'];

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // 静态资源（图标/图片/字体等）不拦，避免被重定向到登录页。
  // 但 /api/ 下的路径一律不跳过：动态段能匹配到带后缀的路径（例如 /api/requirements/1.json），
  // 跳过中间件就等于少了一层防线。
  if (
    !pathname.startsWith('/api/') &&
    (pathname.startsWith('/_next') ||
      pathname.startsWith('/favicon') ||
      /\.(?:svg|png|jpe?g|gif|webp|ico|css|js|mjs|txt|xml|json|woff2?|ttf)$/i.test(pathname))
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifyToken<{ sub?: string; scope?: string }>(token) : null;
  const loggedIn = Boolean(session && session.sub && session.scope === 'session');

  if (pathname === '/login') {
    if (loggedIn) return NextResponse.redirect(new URL('/', req.url));
    return NextResponse.next();
  }

  const isPublicApi = PUBLIC_API_PREFIX.some((p) => pathname === p || pathname.startsWith(p + '/'));
  if (loggedIn || isPublicApi || PUBLIC_PAGES.includes(pathname)) return NextResponse.next();

  // 未登录：接口 401，页面跳登录页并记住来源
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ ok: false, error: '未登录或登录已过期', code: 'UNAUTHORIZED' }, { status: 401 });
  }
  const loginUrl = new URL('/login', req.url);
  loginUrl.searchParams.set('next', pathname + (search || ''));
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
