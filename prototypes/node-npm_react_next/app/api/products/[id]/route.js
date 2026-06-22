import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/session';
import { handleProductRequest } from '@/lib/products-service';

// Single-product endpoint. GET reads (any authenticated role); PUT/DELETE mutate
// (admin only — RBAC enforced server-side, AC4).
export async function GET(request, { params }) {
  const user = getUserFromRequest(request);
  const { status, body } = handleProductRequest({ method: 'GET', user, id: Number(params.id) });
  return NextResponse.json(body, { status });
}

export async function PUT(request, { params }) {
  const user = getUserFromRequest(request);
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* empty/invalid body falls through to validation -> 400 */
  }
  const result = handleProductRequest({ method: 'PUT', user, id: Number(params.id), body });
  return NextResponse.json(result.body, { status: result.status });
}

export async function DELETE(request, { params }) {
  const user = getUserFromRequest(request);
  const { status, body } = handleProductRequest({ method: 'DELETE', user, id: Number(params.id) });
  return NextResponse.json(body, { status });
}
