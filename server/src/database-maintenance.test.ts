import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applySqliteMigrations,
  createPreparedSyncSqliteAdapter,
} from '@mikaelcedergren/cx-framework/server/sqlite';
import { WARGR_MIGRATIONS } from './database.js';

const entry = fileURLToPath(new URL('../dist/database-maintenance.js', import.meta.url));
test('compiled offline migration holds legacy work and immutable verification never changes the store', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wargr-maintenance-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  const filename = path.join(data, 'wargr.db');
  const seed = new DatabaseSync(filename);
  applySqliteMigrations(createPreparedSyncSqliteAdapter(seed), WARGR_MIGRATIONS.slice(0, -2), {
    fingerprint: (source) => createHash('sha256').update(source).digest('hex'),
    now: () => '2026-01-01T00:00:00.000Z',
  });
  seed.exec(`INSERT INTO cx_jobs (id, type, payload_json, idempotency_key, status, attempts, max_attempts,
    scheduled_at, available_at, created_at, updated_at)
    VALUES ('held-synthetic-job', 'synthetic.maintenance', '{}', 'held-synthetic-key', 'queued', 0, 3, 1, 1, 1, 1)`);
  seed.close();
  fs.chmodSync(filename, 0o600);
  const run = (command: string) =>
    spawnSync(process.execPath, [entry, command, '--operational-root', root], {
      cwd: root,
      env: { PATH: process.env['PATH'] ?? '' },
      encoding: 'utf8',
    });
  assert.notEqual(run('verify').status, 0);
  for (const command of ['quiesce', 'migrate', 'verify', 'migrate']) {
    const result = run(command);
    assert.equal(result.status, 0, command + ': ' + result.stderr + result.stdout);
    assert.equal(JSON.parse(result.stdout).verified, true);
  }
  assert.deepEqual(fs.readdirSync(data), ['wargr.db']);
  const before = fs.statSync(filename);
  const bytes = fs.readFileSync(filename);
  assert.equal(run('verify').status, 0);
  assert.deepEqual(fs.readFileSync(filename), bytes);
  assert.equal(fs.statSync(filename).mtimeMs, before.mtimeMs);
  const uri = pathToFileURL(filename);
  uri.searchParams.set('immutable', '1');
  const current = new DatabaseSync(uri, { readOnly: true });
  try {
    assert.deepEqual(
      { ...current.prepare('SELECT id, execution_scope, attempts, status FROM cx_jobs').get() },
      {
        id: 'held-synthetic-job',
        execution_scope: 'legacy',
        attempts: 0,
        status: 'queued',
      },
    );
    assert.equal(
      current.prepare('SELECT COUNT(*) AS n FROM cx_schema_migrations').get()?.['n'],
      WARGR_MIGRATIONS.length,
    );
  } finally {
    current.close();
  }
});
