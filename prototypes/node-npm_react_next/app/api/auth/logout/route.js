import { NextResponse } from 'next/server';
import { destroySession } from '@/lib/session';
import { COOKIE_SESSION } from '@/lib/auth-constants';

// Invalidates the server-managed session (deletes the token row) and clears the
// cookie, then returns to the login page.
export async function POST(request) {
  const token = request.cookies.get(COOKIE_SESSION)?.value;
  if (token) destroySession(token);
  const res = NextResponse.redirect(new URL('/login', request.url), { status: 303 });
  res.cookies.set(COOKIE_SESSION, '', { path: '/', maxAge: 0 });
  return res;
}
