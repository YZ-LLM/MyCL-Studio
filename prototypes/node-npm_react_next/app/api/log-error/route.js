import { NextResponse } from 'next/server';
import { recordError } from '@/error_folder/init-errors-db';
import { log } from '@/lib/log';

// Frontend error reporting sink (AC10). The browser fetch wrapper and the React
// error boundary POST here; the row is written to the MyCL error catalog. Stays
// public (errors can occur before login) but strictly validated / size-capped.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error_code: 'BAD_REQUEST' }, { status: 400 });
  }

  const error_code = String(body?.error_code || '').slice(0, 100);
  const location = String(body?.location || '')
    .replace(/[^a-zA-Z0-9/_:.\- ]/g, '')
    .slice(0, 200);
  const description_tr = String(body?.description_tr || '').slice(0, 500);
  const stack = body?.stack ? String(body.stack).slice(0, 4000) : null;

  if (!error_code || !description_tr) {
    return NextResponse.json({ error_code: 'BAD_REQUEST' }, { status: 400 });
  }

  try {
    const id = recordError({ error_code, location: location || 'client', description_tr, stack });
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    log.error('log-error', 'kayıt başarısız', { message: String(err) });
    return NextResponse.json({ error_code: 'SERVER_ERROR' }, { status: 500 });
  }
}
