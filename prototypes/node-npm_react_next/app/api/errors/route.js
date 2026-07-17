import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/session';
import { listErrors } from '@/error_folder/init-errors-db';

// Reads the MyCL error catalog for the Hata Kodları page (AC11). Admin-only
// (least privilege) — a diagnostic tool.
export async function GET(request) {
  const user = getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error_code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  if (user.role !== 'admin') {
    return NextResponse.json(
      { error_code: 'FORBIDDEN', message_tr: 'Bu işlem için yetkiniz yok' },
      { status: 403 },
    );
  }
  return NextResponse.json({ errors: listErrors() });
}
