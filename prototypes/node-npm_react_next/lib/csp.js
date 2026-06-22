// Katı Content-Security-Policy üreticisi (edge-safe, saf fonksiyon).
// Hiçbir 'unsafe-inline' / 'unsafe-eval' / '*' YOK. script-src nonce + strict-dynamic;
// 'self' bilerek script-src DIŞINDA tutulur (CSP Evaluator 'self'i script-src'de zayıf bulur).
export function buildCsp(nonce) {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
