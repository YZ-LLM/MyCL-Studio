import 'server-only';
import { cookies } from 'next/headers';
import { COOKIE_SESSION } from '@/lib/auth-constants';
import { getDal } from '@/lib/db/dal';

// Real DB-backed authentication (replaces the Phase-5 dev login). Credentials are
// verified against salted hashes in the data-access layer and sessions are
// server-managed (a random token stored in the DB, mapped to a user).

export function verifyCredentials(username, password) {
  return getDal().verifyCredentials(String(username || '').trim(), String(password || ''));
}

export function createSession(userId) {
  return getDal().createSession(userId);
}

export function destroySession(token) {
  if (!token) return false;
  return getDal().deleteSession(token);
}

// Resolves the current user from the session cookie inside a Server Component or
// route handler (uses next/headers).
export function getCurrentUser() {
  const token = cookies().get(COOKIE_SESSION)?.value;
  if (!token) return null;
  return getDal().getSessionUser(token);
}

// Transport-agnostic variant: resolves the user from any Request's Cookie header.
// Used by route handlers so they can be exercised in tests without Next's request
// context.
export function getUserFromRequest(request) {
  const cookieHeader = request?.headers?.get?.('cookie') || '';
  const match = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_SESSION}=`));
  if (!match) return null;
  const token = decodeURIComponent(match.slice(COOKIE_SESSION.length + 1));
  return getDal().getSessionUser(token);
}
