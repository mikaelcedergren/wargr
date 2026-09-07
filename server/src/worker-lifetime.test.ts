import { parseLogRecord } from '@mikaelcedergren/cx-framework/server/logging';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Exercise process lifetime: an in-process test runner would hide an idle worker exiting.
test('a disabled worker remains alive without a provider until graceful shutdown', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wargr-idle-worker-'));
  const moduleUrl = new URL('./worker-runtime.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      `
    globalThis.fetch = () => { throw new Error('Disabled worker attempted a provider call'); };
    const { startWargrWorker } = await import(${JSON.stringify(moduleUrl)});
    const runtime = await startWargrWorker({ entrypointUrl: ${JSON.stringify(moduleUrl)} });
    if (runtime.kind !== 'worker' || runtime.claimsEnabled || !runtime.persistence.isReady()) {
      throw new Error('Disabled worker did not initialize correctly');
    }
    process.stdout.write('idle-worker-ready\\n');
  `,
    ],
    {
      cwd: root,
      env: {
        NODE_ENV: 'test',
        CX_EXECUTION_SCOPE: 'test',
        CX_DATA_MODE: 'isolated',
        CX_SCHEDULE_OWNER: 'false',
        ARTICLE_POLISH_ENABLED: '0',
        APP_BASE_URL: 'http://127.0.0.1:51111',
        HOST: '127.0.0.1',
        PORT: '51111',
        DATA_DIR: 'data',
        DB_PATH: 'data/wargr.db',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    fs.rmSync(root, { recursive: true, force: true });
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Worker readiness timed out: ${stderr}`)),
      10_000,
    );
    child.stdout.on('data', () => {
      if (stdout.includes('idle-worker-ready\n')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('close', () => {
      clearTimeout(timeout);
      reject(new Error(`Worker exited before readiness: ${stderr}`));
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(child.exitCode, null, stderr);
  assert.equal(child.signalCode, null);
  assert.equal(child.kill('SIGTERM'), true);
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  const result = await closed;
  clearTimeout(timer);
  assert.deepEqual(result, [0, null], stderr);
  const records = stderr.trim().split('\n').map(parseLogRecord);
  assert.deepEqual(
    records.map((record) => record.event),
    ['process.ready', 'process.stopped'],
  );
  assert.equal(records[0]?.code, 'CLAIMS_DISABLED');
  assert.ok(records.every((record) => record.role === 'jobs' && record.outcome === 'success'));
});
