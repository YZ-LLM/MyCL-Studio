import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/session';

// Returns the currently authenticated user (resolved from the server-managed
// session cookie via the data-access layer) or 401 when there is no session.
export async function GET() {
  const user = getCurrentUser();
  if (!user) {
    return NextResponse.json({ user: null }, { status: 401 });
  }
  return NextResponse.json({
    user: { id: user.id, username: user.username, role: user.role, displayName: user.displayName },
  });
}
