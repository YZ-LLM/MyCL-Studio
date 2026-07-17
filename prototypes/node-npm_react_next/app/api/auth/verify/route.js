import { NextResponse } from 'next/server';

// Step-up verification (visitor-fingerprint mismatch -> e-mail code) is deferred to a
// later iteration — advanced auth (MFA / e-mail verification) is out of scope here.
// This scaffold stays inert: it is not wired into the login flow and rejects any code.
export async function POST(request) {
  try {
    await request.json();
  } catch {
    /* gövde okunamadı — yine de geçersiz döneriz */
  }
  return NextResponse.json(
    { ok: false, error_code: 'VERIFY_INVALID', message_tr: 'Kod hatalı veya geçersiz.' },
    { status: 400 },
  );
}
