import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hashStudioPassword,
  parseStudioPasswordHash,
  verifyStudioPassword,
} from './password-hash.js';

test('a hashed password verifies and every other password fails', () => {
  const stored = hashStudioPassword('correct horse battery staple');
  assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(verifyStudioPassword('correct horse battery staple', stored), true);
  assert.equal(verifyStudioPassword('correct horse battery stapl', stored), false);
  assert.equal(verifyStudioPassword('', stored), false);
});

test('two hashes of one password differ by salt but both verify', () => {
  const first = hashStudioPassword('dev');
  const second = hashStudioPassword('dev');
  assert.notEqual(first, second);
  assert.equal(verifyStudioPassword('dev', first), true);
  assert.equal(verifyStudioPassword('dev', second), true);
});

test('malformed stored hashes are rejected before any comparison', () => {
  for (const bad of [
    'plaintext-password',
    'scrypt$16384$8$1$short$short',
    'scrypt$3$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'bcrypt$whatever',
    '',
  ]) {
    assert.throws(() => parseStudioPasswordHash(bad));
  }
});
