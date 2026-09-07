import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseLogRecord } from '@mikaelcedergren/cx-framework/server/logging';
const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
test('compiled startup failures emit one safe fatal event for each role', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wargr-PRIVATE-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [entrypoint, role] of [
    ['index.js', 'web'],
    ['worker.js', 'jobs'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [path.resolve(sourceRoot, '..', 'dist', entrypoint!)],
      {
        cwd: root,
        env: {
          PATH: process.env['PATH'],
          NODE_ENV: 'production',
          CX_EXECUTION_SCOPE: 'test',
          CX_DATA_MODE: 'isolated',
          CX_SCHEDULE_OWNER: 'false',
        },
        encoding: 'utf8',
        timeout: 5_000,
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    const records = result.stderr.trim().split('\n').map(parseLogRecord);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.event, 'process.start_failed');
    assert.equal(records[0]?.role, role);
    assert.equal(records[0]?.level, 'fatal');
    assert.ok(records[0]?.error?.locations.length);
    assert.doesNotMatch(result.stderr, /PRIVATE|\/Users\/|\.env\.web|\.env\.worker/u);
  }
});
