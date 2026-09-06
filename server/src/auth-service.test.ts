import assert from 'node:assert/strict';
import test from 'node:test';

import { createOwnerAuthService, type PersistentOwnerAuthRepository } from './auth-service.js';
import { hashStudioPassword } from './password-hash.js';

const password = 'Synthetic password-()!';
const passwordHash = hashStudioPassword(password);

function fixture(expectedUsername = 'synthetic-owner') {
  const calls = { reads: 0, failures: 0, sessions: 0 };
  const repository: PersistentOwnerAuthRepository = {
    async createSessionAndClearLoginFailures() {
      calls.sessions += 1;
      return 'created';
    },
    async deleteSession() {
      return false;
    },
    async findSession() {
      return null;
    },
    async readLoginThrottle() {
      calls.reads += 1;
      return { status: 'allowed' };
    },
    async recordLoginFailure() {
      calls.failures += 1;
      return { status: 'allowed' };
    },
    async touchSession() {
      return null;
    },
  };
  const service = createOwnerAuthService({
    cookieSecure: false,
    expectedPasswordHash: passwordHash,
    expectedUsername,
    repository,
    sessionSecret: 'wargr-synthetic-authentication-test-secret',
    sessionTtlSeconds: 300,
  });
  return { calls, service };
}

test('owner authentication accepts hyphenated usernames and safe password punctuation', async () => {
  const { calls, service } = fixture();
  const response = await service.login({
    username: 'synthetic-owner',
    password,
    clientKey: 'validation-client',
  });
  assert.match(response.setCookie, /^wg_studio_session=/);
  assert.deepEqual(calls, { reads: 1, failures: 0, sessions: 1 });
});

test('owner authentication rejects control characters while preserving its credential bounds', async () => {
  for (const control of ['\u0000', '\n', '\u001f', '\u007f']) {
    assert.throws(() => fixture('owner' + control), /safe characters/);
    const { calls, service } = fixture();
    await assert.rejects(
      service.login({ username: 'synthetic-owner', password, clientKey: 'client' + control }),
      /safe characters/,
    );
    assert.equal(calls.reads, 0);
    await assert.rejects(
      service.login({
        username: 'synthetic-owner',
        password: password + control,
        clientKey: 'client',
      }),
      { code: 'invalid_credentials' },
    );
    assert.equal(calls.sessions, 0);
    assert.equal(calls.failures, 1);
  }
  assert.doesNotThrow(() => fixture('a'.repeat(256)));
  assert.throws(() => fixture('a'.repeat(257)), /safe characters/);
  assert.throws(() => fixture(''), /safe characters/);
});
