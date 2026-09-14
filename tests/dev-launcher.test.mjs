import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDevelopmentEnvironments, prepareDevelopmentDataDirectory } from '../scripts/dev.mjs';

test('the browser and server keep separate development ports', () => {
  const environments = createDevelopmentEnvironments({ SOURCE: 'test' });
  assert.equal(environments.server.PORT, '4261');
  assert.equal(environments.server.APP_BASE_URL, 'http://127.0.0.1:4260');
  assert.equal(environments.server.CX_EXECUTION_SCOPE, 'development');
  assert.equal(environments.server.CX_DATA_MODE, 'shared');
  assert.equal(environments.server.CX_SCHEDULE_OWNER, 'false');
  assert.equal(environments.server.DATA_DIR, 'data');
  assert.equal(environments.browser.PORT, undefined);
  assert.equal(environments.browser.SOURCE, 'test');
});

test('owner development is isolated from shared data and private configuration', () => {
  const environments = createDevelopmentEnvironments(
    {
      OPENAI_API_KEY: 'must-not-cross',
      SOURCE: 'test',
      WARGR_STUDIO_PASSWORD_HASH: 'must-not-cross',
      WARGR_STUDIO_SESSION_SECRET: 'must-not-cross',
      WARGR_STUDIO_USERNAME: 'must-not-cross',
    },
    process.cwd(),
    { owner: true },
  );
  assert.equal(environments.server.CX_DATA_MODE, 'isolated');
  assert.equal(environments.server.DATA_DIR, 'data/owner-development');
  assert.equal(environments.server.DB_PATH, 'data/owner-development/wargr.db');
  assert.equal(environments.server.WARGR_LOAD_ENV_FILE, 'false');
  assert.equal(environments.server.ARTICLE_POLISH_ENABLED, '0');
  for (const key of [
    'OPENAI_API_KEY',
    'WARGR_STUDIO_PASSWORD_HASH',
    'WARGR_STUDIO_SESSION_SECRET',
    'WARGR_STUDIO_USERNAME',
  ]) {
    assert.equal(environments.server[key], undefined);
  }
});

test('owner development creates only its isolated local directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wargr-owner-dev-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const expected = path.join(realpathSync(root), 'data', 'owner-development');
  assert.equal(prepareDevelopmentDataDirectory(realpathSync(root), { owner: true }), expected);
  assert.equal(existsSync(path.join(root, 'data', 'wargr.db')), false);
});

test('shared development requires the existing authority and never seeds it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wargr-dev-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const canonicalRoot = realpathSync(root);
  assert.throws(() => prepareDevelopmentDataDirectory(canonicalRoot), /ENOENT/);
  assert.equal(existsSync(path.join(root, 'data')), false);
  mkdirSync(path.join(root, 'data'), { mode: 0o700 });
  assert.throws(() => prepareDevelopmentDataDirectory(canonicalRoot), /ENOENT/);
  writeFileSync(path.join(root, 'data', 'wargr.db'), 'synthetic fixture', { mode: 0o600 });
  assert.equal(prepareDevelopmentDataDirectory(canonicalRoot), path.join(canonicalRoot, 'data'));
});

test('the development launcher refuses a symbolic-link authority', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wargr-dev-link-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'wargr-dev-outside-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  t.after(() => rm(outside, { force: true, recursive: true }));
  symlinkSync(outside, path.join(root, 'data'));
  assert.throws(
    () => prepareDevelopmentDataDirectory(realpathSync(root)),
    /Unsafe Wargr shared development store/,
  );
});

test('owner development rejects linked ancestry before creating a directory outside the repo', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-link-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'owner-outside-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  t.after(() => rm(outside, { force: true, recursive: true }));
  symlinkSync(outside, path.join(root, 'data'));
  assert.throws(
    () => prepareDevelopmentDataDirectory(realpathSync(root), { owner: true }),
    /Unsafe Wargr owner development store/,
  );
  assert.equal(existsSync(path.join(outside, 'owner-development')), false);
});

test('the launcher owns bounded teardown instead of leaving a failed supervisor alive', async () => {
  const source = await readFile(new URL('../scripts/dev.mjs', import.meta.url), 'utf8');
  assert.match(source, /remaining -= 1/);
  assert.match(source, /child\.on\('close'/);
  assert.match(source, /child\.kill\('SIGKILL'\)/);
  assert.match(source, /process\.off\('SIGINT', onInterrupt\)/);
  assert.match(source, /process\.off\('SIGTERM', onTerminate\)/);
});
