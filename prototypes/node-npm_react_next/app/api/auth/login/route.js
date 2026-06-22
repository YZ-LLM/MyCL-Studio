import { NextResponse } from 'next/server';
import { verifyCredentials, createSession } from '@/lib/session';
import { COOKIE_SESSION } from '@/lib/auth-constants';
import { log } from '@/lib/log';

// Real DB-backed login. Verifies the password against the stored salted hash and,
// on success, establishes a server-managed session (random token cookie).
// Works for both fetch (JSON, inline error) and no-JS form POST (redirect).
export async function POST(request) {
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');
  const ctype = request.headers.get('content-type') || '';
  let username = '';
  let password = '';
  try {
    if (ctype.includes('application/json')) {
      const body = await request.json();
      username = String(body?.username || '');
      password = String(body?.password || '');
    } else {
      const form = await request.formData();
      username = String(form.get('username') || '');
      password = String(form.get('password') || '');
    }
  } catch {
    /* unreadable body — treated as invalid credentials below */
  }

  const user = verifyCredentials(username.trim(), password);
  if (!user) {
    log.warn('auth', 'login rejected', { username: username.trim() });
    if (wantsJson) {
      return NextResponse.json(
        { error_code: 'AUTH_INVALID', message_tr: 'Kullanıcı adı veya şifre hatalı' },
        { status: 401 },
      );
    }
    return NextResponse.redirect(new URL('/login?error=1', request.url), { status: 303 });
  }

  const token = createSession(user.id);
  const safeUser = { id: user.id, username: user.username, role: user.role, displayName: user.displayName };
  const res = wantsJson
    ? NextResponse.json({ user: safeUser }, { status: 200 })
    : NextResponse.redirect(new URL('/', request.url), { status: 303 });

  res.cookies.set(COOKIE_SESSION, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24,
  });
  return res;
}
