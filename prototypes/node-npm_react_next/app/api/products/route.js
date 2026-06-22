import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/session';
import { handleProductRequest } from '@/lib/products-service';

// Product catalog collection endpoint. GET lists (any authenticated role);
// POST creates (admin only — RBAC enforced server-side, AC4). Calling this API
// directly cannot bypass the role check.
export async function GET(request) {
  const user = getUserFromRequest(request);
  const { status, body } = handleProductRequest({ method: 'GET', user });
  return NextResponse.json(body, { status });
}

export async function POST(request) {
  const user = getUserFromRequest(request);
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* empty/invalid body falls through to validation -> 400 */
  }
  const result = handleProductRequest({ method: 'POST', user, body });
  return NextResponse.json(result.body, { status: result.status });
}
