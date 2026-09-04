import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Owner password verification for Studio. The web role stores only the complete `scrypt$…` string
 * produced by `pnpm studio:password-hash`; the plaintext never rests in configuration. The format
 * pins every cost parameter into the stored value so a hash remains verifiable after defaults move.
 */

const SCRYPT_PREFIX = 'scrypt';
const DEFAULT_COST = 16_384;
const DEFAULT_BLOCK_SIZE = 8;
const DEFAULT_PARALLELIZATION = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MAX_PASSWORD_CHARACTERS = 256;
const MAX_COST = 1_048_576;
const MAX_BLOCK_SIZE = 32;
const MAX_PARALLELIZATION = 4;

export interface ParsedPasswordHash {
  readonly blockSize: number;
  readonly cost: number;
  readonly hash: Buffer;
  readonly parallelization: number;
  readonly salt: Buffer;
}

export function hashStudioPassword(password: string): string {
  assertBoundedPassword(password);
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEY_BYTES, {
    N: DEFAULT_COST,
    r: DEFAULT_BLOCK_SIZE,
    p: DEFAULT_PARALLELIZATION,
    maxmem: scryptMemoryBudget(DEFAULT_COST, DEFAULT_BLOCK_SIZE),
  });
  return [
    SCRYPT_PREFIX,
    String(DEFAULT_COST),
    String(DEFAULT_BLOCK_SIZE),
    String(DEFAULT_PARALLELIZATION),
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

export function parseStudioPasswordHash(stored: string): ParsedPasswordHash {
  if (typeof stored !== 'string' || stored.length > 1_024) {
    throw new Error('The stored Studio password hash must be a bounded string.');
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) {
    throw new Error(
      'The stored Studio password hash must use the exact scrypt$N$r$p$salt$hash form.',
    );
  }
  const cost = boundedPositiveInteger(parts[1], 'cost', MAX_COST);
  const blockSize = boundedPositiveInteger(parts[2], 'block size', MAX_BLOCK_SIZE);
  const parallelization = boundedPositiveInteger(parts[3], 'parallelization', MAX_PARALLELIZATION);
  if ((cost & (cost - 1)) !== 0 || cost < 2) {
    throw new Error('The Studio password hash cost must be a power of two of at least 2.');
  }
  const salt = exactBase64Url(parts[4], 'salt', SALT_BYTES);
  const hash = exactBase64Url(parts[5], 'hash', KEY_BYTES);
  return Object.freeze({ blockSize, cost, hash, parallelization, salt });
}

export function verifyStudioPassword(password: string, stored: string): boolean {
  if (!isBoundedPassword(password)) return false;
  const parsed = parseStudioPasswordHash(stored);
  const candidate = scryptSync(password, parsed.salt, parsed.hash.length, {
    N: parsed.cost,
    r: parsed.blockSize,
    p: parsed.parallelization,
    maxmem: scryptMemoryBudget(parsed.cost, parsed.blockSize),
  });
  return timingSafeEqual(candidate, parsed.hash);
}

function scryptMemoryBudget(cost: number, blockSize: number): number {
  return 128 * cost * blockSize * 2;
}

function assertBoundedPassword(password: string): void {
  if (!isBoundedPassword(password)) {
    throw new Error(
      `Studio passwords must contain between 1 and ${String(MAX_PASSWORD_CHARACTERS)} safe characters.`,
    );
  }
}

function isBoundedPassword(password: unknown): password is string {
  return (
    typeof password === 'string' &&
    password.length >= 1 &&
    password.length <= MAX_PASSWORD_CHARACTERS &&
    !/[\u0000-\u001f\u007f]/u.test(password)
  );
}

function boundedPositiveInteger(value: string | undefined, label: string, maximum: number): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,6}$/.test(value)) {
    throw new Error(`The Studio password hash ${label} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`The Studio password hash ${label} must be at most ${String(maximum)}.`);
  }
  return parsed;
}

function exactBase64Url(value: string | undefined, label: string, expectedBytes: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`The Studio password hash ${label} must be base64url encoded.`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== value) {
    throw new Error(
      `The Studio password hash ${label} must decode to exactly ${String(expectedBytes)} bytes.`,
    );
  }
  return decoded;
}
