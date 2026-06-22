// Salted one-way password hashing (AC3) using Node's builtin scrypt — zero extra
// dependency. The stored value embeds the algorithm, parameters and a per-password
// random salt, so two identical passwords hash to different strings and the
// plaintext is never recoverable.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;
const SALT_BYTES = 16;

// Returns "scrypt$<saltHex>$<hashHex>" — a salted one-way hash, never the plaintext.
export function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('password must be a non-empty string');
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Constant-time verification of a plaintext against a stored hash.
export function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = scryptSync(plain, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
