import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/**
 * Password hashing.
 *
 * The product design specifies Argon2id. This skeleton has no network access to
 * install a native Argon2 module, so it uses scrypt with explicit parameters
 * and a self-describing format; swapping in Argon2id later only replaces
 * `hashPassword`/`verifyPassword` (old hashes stay verifiable).
 */
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;

/** @returns { hash: string, params: string } */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new Error('password must be 8-200 characters');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, PARAMS.keylen, { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p });
  const params = `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}`;
  return {
    hash: `${params}$${salt.toString('base64')}$${derived.toString('base64')}`,
    params,
  };
}

/** @returns whether the password matches the stored value. */
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scrypt(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
