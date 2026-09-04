import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { serializeCookie, type CookieHeader } from '@mikaelcedergren/cx-framework/server/cookies';
import { HttpError } from '@mikaelcedergren/cx-framework/server/errors';
import { createSessionTokenCodec } from '@mikaelcedergren/cx-framework/server/session';
import { sha256Hex } from '@mikaelcedergren/cx-framework/server/signing';

import {
  STUDIO_SESSION_APPLICATION_ID,
  STUDIO_SESSION_COOKIE,
  STUDIO_SESSION_MAXIMUM_TTL_SECONDS,
  STUDIO_SESSION_SIGNING_KEY_ID,
} from './constants.js';
import { parseStudioPasswordHash, verifyStudioPassword } from './password-hash.js';

export interface PersistedOwnerSession {
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastSeenAt: number;
  readonly revision: number;
  readonly sessionIdHash: string;
}

export type AuthenticationCapacityResult = 'created' | 'capacity_reached';

export type LoginThrottleState =
  | { readonly status: 'allowed' }
  | { readonly retryAfterSeconds: number; readonly status: 'rate_limited' }
  | { readonly status: 'capacity_reached' };

export interface PersistentOwnerAuthRepository {
  createSessionAndClearLoginFailures(input: {
    readonly clientKeyHash: string;
    readonly session: PersistedOwnerSession;
  }): Promise<AuthenticationCapacityResult>;
  deleteSession(sessionIdHash: string): Promise<boolean>;
  findSession(sessionIdHash: string): Promise<PersistedOwnerSession | null>;
  readLoginThrottle(clientKeyHash: string, now: number): Promise<LoginThrottleState>;
  recordLoginFailure(clientKeyHash: string, now: number): Promise<LoginThrottleState>;
  touchSession(input: {
    readonly expectedRevision: number;
    readonly lastSeenAt: number;
    readonly sessionIdHash: string;
  }): Promise<PersistedOwnerSession | null>;
}

export interface AuthenticatedOwnerSession {
  readonly expiresAt: number;
  readonly ownerSessionIdHash: string;
}

export interface OwnerLoginInput {
  readonly clientKey: string;
  readonly password: string;
  readonly username: string;
}

export interface OwnerAuthService {
  login(input: OwnerLoginInput): Promise<{ readonly setCookie: string }>;
  logout(header: CookieHeader): Promise<{ readonly setCookie: string }>;
  resolve(header: CookieHeader): Promise<AuthenticatedOwnerSession | null>;
}

export interface OwnerAuthServiceOptions {
  readonly cookieSecure: boolean;
  readonly expectedPasswordHash: string;
  readonly expectedUsername: string;
  readonly now?: () => number;
  readonly repository: PersistentOwnerAuthRepository;
  readonly sessionSecret: string;
  readonly sessionTtlSeconds: number;
}

export function createOwnerAuthService({
  cookieSecure,
  expectedPasswordHash,
  expectedUsername,
  now = Date.now,
  repository,
  sessionSecret,
  sessionTtlSeconds,
}: OwnerAuthServiceOptions): OwnerAuthService {
  validateCredential(expectedUsername, 'Expected owner username');
  // The stored credential is the complete scrypt hash produced by `pnpm studio:password-hash`; the
  // plaintext never reaches configuration or this service's construction.
  parseStudioPasswordHash(expectedPasswordHash);
  if (typeof cookieSecure !== 'boolean') {
    throw new Error('Owner session cookieSecure must be a boolean.');
  }
  if (
    !Number.isSafeInteger(sessionTtlSeconds) ||
    sessionTtlSeconds < 1 ||
    sessionTtlSeconds > STUDIO_SESSION_MAXIMUM_TTL_SECONDS
  ) {
    throw new Error(
      `Owner session ttlSeconds must be between 1 and ${String(STUDIO_SESSION_MAXIMUM_TTL_SECONDS)}.`,
    );
  }
  if (!repository || typeof repository !== 'object') {
    throw new Error('Owner authentication requires a persistent repository.');
  }

  const codec = createSessionTokenCodec({
    activeKeyId: STUDIO_SESSION_SIGNING_KEY_ID,
    applicationId: STUDIO_SESSION_APPLICATION_ID,
    keys: [{ id: STUDIO_SESSION_SIGNING_KEY_ID, secret: sessionSecret }],
    maximumTtlSeconds: sessionTtlSeconds,
    now,
  });

  async function login({ clientKey, password, username }: OwnerLoginInput) {
    const safeClientKey = validateClientKey(clientKey);
    const clientKeyHash = hashClientKey(safeClientKey, sessionSecret);
    const currentTime = currentEpochSeconds(now);
    throwForThrottle(await repository.readLoginThrottle(clientKeyHash, currentTime));

    const credentialsMatch =
      boundedCredential(username) &&
      boundedCredential(password) &&
      safeEqual(username, expectedUsername) &&
      verifyStudioPassword(password, expectedPasswordHash);
    if (!credentialsMatch) {
      const recorded = await repository.recordLoginFailure(clientKeyHash, currentTime);
      throwForThrottle(recorded);
      throw new HttpError({
        code: 'invalid_credentials',
        message: 'Invalid credentials.',
        status: 401,
      });
    }

    const issued = codec.issue({ ttlSeconds: sessionTtlSeconds });
    const sessionIdHash = hashSessionId(issued.sessionId);
    const created = await repository.createSessionAndClearLoginFailures({
      clientKeyHash,
      session: {
        createdAt: issued.issuedAt,
        expiresAt: issued.expiresAt,
        lastSeenAt: issued.issuedAt,
        revision: 1,
        sessionIdHash,
      },
    });
    if (created !== 'created') throwSessionCapacityError();

    return Object.freeze({
      setCookie: serializeCookie(STUDIO_SESSION_COOKIE, issued.token, {
        httpOnly: true,
        maxAgeSeconds: sessionTtlSeconds,
        path: '/',
        sameSite: 'strict',
        secure: cookieSecure,
      }),
    });
  }

  async function resolve(header: CookieHeader): Promise<AuthenticatedOwnerSession | null> {
    const claims = codec.readCookie(header, STUDIO_SESSION_COOKIE);
    if (!claims) return null;
    const sessionIdHash = hashSessionId(claims.sessionId);
    const stored = await repository.findSession(sessionIdHash);
    if (!validStoredSession(stored, sessionIdHash, claims.issuedAt, claims.expiresAt)) {
      return null;
    }
    const lastSeenAt = currentEpochSeconds(now);
    if (lastSeenAt >= stored.expiresAt) {
      await repository.deleteSession(sessionIdHash);
      return null;
    }
    if (lastSeenAt <= stored.lastSeenAt) return authenticatedSession(stored);

    const touched = await repository.touchSession({
      expectedRevision: stored.revision,
      lastSeenAt,
      sessionIdHash,
    });
    if (validStoredSession(touched, sessionIdHash, claims.issuedAt, claims.expiresAt)) {
      return authenticatedSession(touched);
    }

    // A parallel request may have won the optimistic touch. Re-read once, retry only when its
    // monotonic activity timestamp still trails this request, then make one final validation read
    // if that retry also raced. Session deletion or expiry wins every check.
    const refreshed = await repository.findSession(sessionIdHash);
    if (!validStoredSession(refreshed, sessionIdHash, claims.issuedAt, claims.expiresAt)) {
      return null;
    }
    if (lastSeenAt >= refreshed.expiresAt) {
      await repository.deleteSession(sessionIdHash);
      return null;
    }
    if (lastSeenAt <= refreshed.lastSeenAt) return authenticatedSession(refreshed);

    const retried = await repository.touchSession({
      expectedRevision: refreshed.revision,
      lastSeenAt,
      sessionIdHash,
    });
    if (validStoredSession(retried, sessionIdHash, claims.issuedAt, claims.expiresAt)) {
      return authenticatedSession(retried);
    }
    const final = await repository.findSession(sessionIdHash);
    if (
      !validStoredSession(final, sessionIdHash, claims.issuedAt, claims.expiresAt) ||
      lastSeenAt >= final.expiresAt
    ) {
      return null;
    }
    return authenticatedSession(final);
  }

  async function logout(header: CookieHeader): Promise<{ readonly setCookie: string }> {
    const claims = codec.readCookie(header, STUDIO_SESSION_COOKIE);
    if (claims) await repository.deleteSession(hashSessionId(claims.sessionId));
    return Object.freeze({
      setCookie: serializeCookie(STUDIO_SESSION_COOKIE, '', {
        expires: new Date(0),
        httpOnly: true,
        maxAgeSeconds: 0,
        path: '/',
        sameSite: 'strict',
        secure: cookieSecure,
      }),
    });
  }

  return Object.freeze({ login, logout, resolve });
}

function validStoredSession(
  stored: PersistedOwnerSession | null,
  sessionIdHash: string,
  issuedAt: number,
  expiresAt: number,
): stored is PersistedOwnerSession {
  return Boolean(
    stored &&
    stored.sessionIdHash === sessionIdHash &&
    stored.createdAt === issuedAt &&
    stored.expiresAt === expiresAt &&
    Number.isSafeInteger(stored.lastSeenAt) &&
    stored.lastSeenAt >= stored.createdAt &&
    stored.lastSeenAt < stored.expiresAt &&
    Number.isSafeInteger(stored.revision) &&
    stored.revision >= 1,
  );
}

function authenticatedSession(stored: PersistedOwnerSession): AuthenticatedOwnerSession {
  return Object.freeze({
    expiresAt: stored.expiresAt,
    ownerSessionIdHash: stored.sessionIdHash,
  });
}

function throwForThrottle(state: LoginThrottleState): void {
  if (state.status === 'allowed') return;
  if (state.status === 'capacity_reached') throwAuthenticationCapacityError();
  if (!Number.isSafeInteger(state.retryAfterSeconds) || state.retryAfterSeconds < 1) {
    throw new Error('The authentication repository returned an invalid retry interval.');
  }
  throw new HttpError({
    code: 'authentication_rate_limited',
    details: { retryAfterSeconds: state.retryAfterSeconds },
    message: 'Too many sign-in attempts. Try again later.',
    status: 429,
  });
}

function throwAuthenticationCapacityError(): never {
  throw new HttpError({
    code: 'authentication_capacity_reached',
    message: 'Sign-in is temporarily unavailable. Try again later.',
    status: 503,
  });
}

function throwSessionCapacityError(): never {
  throw new HttpError({
    code: 'session_capacity_reached',
    message: 'No more owner sessions can be created right now.',
    status: 503,
  });
}

function validateCredential(value: string, label: string): void {
  if (!boundedCredential(value)) {
    throw new Error(`${label} must contain between 1 and 256 safe characters.`);
  }
}

function boundedCredential(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length >= 1 && value.length <= 256 && !/[ -]/u.test(value)
  );
}

function validateClientKey(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[ -]/u.test(value)) {
    throw new Error('Owner login client keys must contain between 1 and 512 safe characters.');
  }
  return value;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function hashSessionId(sessionId: string): string {
  return sha256Hex(sessionId, { maxInputBytes: 64 });
}

function hashClientKey(clientKey: string, secret: string): string {
  return createHmac('sha256', secret)
    .update('wargr.login-throttle.v1\0', 'utf8')
    .update(clientKey, 'utf8')
    .digest('hex');
}

function currentEpochSeconds(now: () => number): number {
  const milliseconds = now();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error('Owner session clocks must return non-negative integer epoch milliseconds.');
  }
  return Math.floor(milliseconds / 1_000);
}
