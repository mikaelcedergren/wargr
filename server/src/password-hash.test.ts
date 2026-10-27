import assert from 'node:assert/strict';
import test from 'node:test';

import { hashAdminPassword, parseAdminPasswordHash, verifyAdminPassword } from './password-hash.js';

test('a hashed password verifies and every other password fails', () => {
  const stored = hashAdminPassword('correct horse battery staple');
  assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(verifyAdminPassword('correct horse battery staple', stored), true);
  assert.equal(verifyAdminPassword('correct horse battery stapl', stored), false);
  assert.equal(verifyAdminPassword('', stored), false);
});

test('two hashes of one password differ by salt but both verify', () => {
  const first = hashAdminPassword('dev');
  const second = hashAdminPassword('dev');
  assert.notEqual(first, second);
  assert.equal(verifyAdminPassword('dev', first), true);
  assert.equal(verifyAdminPassword('dev', second), true);
});

test('malformed stored hashes are rejected before any comparison', () => {
  for (const bad of [
    'plaintext-password',
    'scrypt$16384$8$1$short$short',
    'scrypt$3$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'bcrypt$whatever',
    '',
  ]) {
    assert.throws(() => parseAdminPasswordHash(bad));
  }
});
