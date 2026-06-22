'use client';

// Doğrulama formu — 8 haneli kod + 3 dakika geri sayım + yeniden gönder + durum mesajı.
// Step-up backend logic (code generation/expiry/known-fingerprints) is deferred to a
// later iteration (advanced auth is out of scope here); this form stays inert for now.
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n-context';

const TOTAL = 180; // 3 dakika (saniye)

export function VerificationForm() {
  const t = useT();
  const [code, setCode] = useState('');
  const [remaining, setRemaining] = useState(TOTAL);
  const [status, setStatus] = useState(''); // '', invalid, expired, resent, error
  const [pending, setPending] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    timer.current = setInterval(() => {
      setRemaining((r) => (r <= 1 ? 0 : r - 1));
    }, 1000);
    return () => clearInterval(timer.current);
  }, []);

  useEffect(() => {
    if (remaining === 0) setStatus('expired');
  }, [remaining]);

  function mmss(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (remaining === 0) {
      setStatus('expired');
      return;
    }
    if (!/^\d{8}$/.test(code)) {
      setStatus('invalid');
      return;
    }
    setStatus('');
    setPending(true);
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) setStatus('invalid');
    } catch {
      setStatus('error');
    } finally {
      setPending(false);
    }
  }

  function resend() {
    setRemaining(TOTAL);
    setCode('');
    setStatus('resent');
  }

  const message =
    status === 'invalid'
      ? t('verify.invalid')
      : status === 'expired'
        ? t('verify.expired')
        : status === 'resent'
          ? t('verify.resent')
          : status === 'error'
            ? t('common.serverError')
            : '';

  return (
    <form onSubmit={onSubmit} noValidate className="stack">
      <div className="field">
        <label htmlFor="vcode">{t('verify.codeLabel')}</label>
        <input
          id="vcode"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={8}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          aria-invalid={status === 'invalid' ? 'true' : undefined}
          aria-describedby={message ? 'verify-msg' : undefined}
          disabled={pending}
        />
      </div>
      <p className="muted">
        {t('verify.expiresIn')}: <span className="countdown">{mmss(remaining)}</span>
      </p>
      {message ? (
        <p id="verify-msg" className="inline-error" role="alert">
          {message}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || remaining === 0}>
          {t('verify.submit')}
        </button>
        <button type="button" className="btn" onClick={resend}>
          {t('verify.resend')}
        </button>
      </div>
    </form>
  );
}
