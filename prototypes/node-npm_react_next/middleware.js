import { NextResponse } from 'next/server';
import { buildCsp } from '@/lib/csp';
import {
  COOKIE_SESSION,
  COOKIE_LANG,
  COOKIE_THEME,
  SUPPORTED_LANGS,
  DEFAULT_LANG,
} from '@/lib/auth-constants';

const PUBLIC_PATHS = ['/login', '/dogrulama'];
const ONE_YEAR = 60 * 60 * 24 * 365;

function isPublicPath(pathname) {
  if (pathname.startsWith('/api/')) return true;
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function resolveLang(param, cookie, acceptLanguage) {
  if (SUPPORTED_LANGS.includes(param)) return param;
  if (SUPPORTED_LANGS.includes(cookie)) return cookie;
  if (typeof acceptLanguage === 'string' && /(^|,|\s)en\b/i.test(acceptLanguage)) return 'en';
  return DEFAULT_LANG;
}

export function middleware(request) {
  const { nextUrl } = request;
  const pathname = nextUrl.pathname;

  // --- CSP nonce (fresh per request) ---
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);

  // --- Language / theme resolution (?param > cookie > Accept-Language > default) ---
  const langParam = nextUrl.searchParams.get('lang');
  const themeParam = nextUrl.searchParams.get('theme');
  const langCookie = request.cookies.get(COOKIE_LANG)?.value;
  const themeCookie = request.cookies.get(COOKIE_THEME)?.value;
  const effLang = resolveLang(langParam, langCookie, request.headers.get('accept-language'));
  const effTheme =
    themeParam === 'dark' || themeParam === 'light'
      ? themeParam
      : themeCookie === 'dark' || themeCookie === 'light'
        ? themeCookie
        : '';

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);
  requestHeaders.set('x-lang', effLang);
  requestHeaders.set('x-theme', effTheme);

  // --- Auth UX guard (NOT enforcement; the real gate is the protected layout +
  // route handlers, which validate the session token against the database) ---
  const hasSession = Boolean(request.cookies.get(COOKIE_SESSION)?.value);
  let response;
  if (!hasSession && !isPublicPath(pathname)) {
    const url = nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    response = NextResponse.redirect(url);
  } else if (hasSession && pathname === '/login') {
    const url = nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    response = NextResponse.redirect(url);
  } else {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

  // --- Response headers + cookie persistence ---
  response.headers.set('content-security-policy', csp);
  if (SUPPORTED_LANGS.includes(langParam)) {
    response.cookies.set(COOKIE_LANG, langParam, { path: '/', maxAge: ONE_YEAR, sameSite: 'lax' });
  }
  if (themeParam === 'dark' || themeParam === 'light') {
    response.cookies.set(COOKIE_THEME, themeParam, { path: '/', maxAge: ONE_YEAR, sameSite: 'lax' });
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|docs/).*)'],
};
