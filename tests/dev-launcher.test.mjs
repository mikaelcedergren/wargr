import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDevelopmentEnvironments, prepareDevelopmentDataDirectory } from '../scripts/dev.mjs';

test('the browser and server keep separate development ports', () => {
  const environments = createDevelopmentEnvironments({ SOURCE: 'test' });
  assert.equal(environments.server.PORT, '4261');
  assert.equal(environments.server.APP_BASE_URL, 'http://127.0.0.1:4260');
  assert.equal(environments.browser.PORT, undefined);
  assert.equal(environments.browser.SOURCE, 'test');
});

test('the development launcher creates a private real database ancestry', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wargr-dev-'));
  t.after(() => rm(root, { force: true, recursive: true }));

  const canonicalRoot = realpathSync(root);
  const data = prepareDevelopmentDataDirectory(canonicalRoot);
  assert.equal(data, path.join(canonicalRoot, '.run', 'dev', 'data'));
  for (const candidate of [
    path.join(canonicalRoot, '.run'),
    path.join(canonicalRoot, '.run', 'dev'),
    data,
  ]) {
    const metadata = lstatSync(candidate);
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.mode & 0o777, 0o700);
  }

  chmodSync(data, 0o755);
  prepareDevelopmentDataDirectory(canonicalRoot);
  assert.equal(lstatSync(data).mode & 0o777, 0o700);
});

test('the development launcher refuses a symbolic-link database ancestry', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wargr-dev-link-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'wargr-dev-outside-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  t.after(() => rm(outside, { force: true, recursive: true }));
  mkdirSync(path.join(root, '.run'), { mode: 0o700 });
  symlinkSync(outside, path.join(root, '.run', 'dev'));

  assert.throws(
    () => prepareDevelopmentDataDirectory(realpathSync(root)),
    /Unsafe Wargr development directory/,
  );
});

test('the launcher owns bounded teardown instead of leaving a failed supervisor alive', async () => {
  const source = await readFile(new URL('../scripts/dev.mjs', import.meta.url), 'utf8');
  assert.match(source, /remaining -= 1/);
  assert.match(source, /child\.on\('close'/);
  assert.match(source, /child\.kill\('SIGKILL'\)/);
  assert.match(source, /process\.off\('SIGINT', onInterrupt\)/);
  assert.match(source, /process\.off\('SIGTERM', onTerminate\)/);
});
