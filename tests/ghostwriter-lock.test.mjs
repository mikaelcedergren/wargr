import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GENERATED_OUTPUT_PATHS } from '../scripts/generated-content-transaction.mjs';

const TRANSACTION_MODULE = new URL('../scripts/generated-content-transaction.mjs', import.meta.url)
  .href;

test('macOS scheduled command lock spans the Node transaction, rejects concurrency, and releases for recovery after crash', async (t) => {
  const fixture = createFixture();
  let holder;
  t.after(() => {
    if (holder) killProcessGroupIfPresent(holder.pid);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const before = captureOutputRoots(fixture.repo);
  const ready = path.join(fixture.root, 'holder-ready');
  const forbiddenMutation = path.join(fixture.root, 'concurrent-mutation');
  const recoveryResult = path.join(fixture.root, 'recovery-result.json');
  const lockPath = path.join(fixture.repo, '.run/ghostwriter-sync.lock');
  const journalPath = path.join(
    fixture.repo,
    '.run/ghostwriter-generated-content-transaction.json',
  );
  holder = spawn(
    '/usr/bin/lockf',
    [
      '-s',
      '-t',
      '0',
      '-k',
      lockPath,
      '/bin/zsh',
      '-c',
      `exec 3>&-
exec "$1" "$2" crash "$3" "$4" "$5" "$6"`,
      '--',
      process.execPath,
      fixture.worker,
      fixture.repo,
      fixture.stage,
      fixture.transaction,
      ready,
    ],
    { detached: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  await waitForPath(ready, holder);
  assert.equal(holder.exitCode, null);
  assert.equal(holder.signalCode, null);
  const partial = captureOutputRoots(fixture.repo);
  assert.notDeepEqual(partial, before);
  assert.equal(fs.existsSync(journalPath), true);
  const journalBefore = fs.readFileSync(journalPath);
  const lockBefore = fs.lstatSync(lockPath, { bigint: true });

  const concurrent = spawnSync(
    '/bin/zsh',
    [
      '-c',
      `set -eu
umask 077
exec 9>"$1"
if ! /usr/bin/lockf -s -t 0 9; then exit 75; fi
"$2" -e 'require("node:fs").writeFileSync(process.argv[1], "mutated")' "$3"`,
      '--',
      lockPath,
      process.execPath,
      forbiddenMutation,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(concurrent.status, 75, concurrent.stderr);
  assert.equal(fs.existsSync(forbiddenMutation), false);
  assert.deepEqual(captureOutputRoots(fixture.repo), partial);
  assert.deepEqual(fs.readFileSync(journalPath), journalBefore);
  assert.equal(fs.lstatSync(lockPath, { bigint: true }).ino, lockBefore.ino);

  process.kill(-holder.pid, 'SIGKILL');
  await waitForExit(holder);
  await waitForLockAvailability(lockPath);
  assert.equal(fs.lstatSync(lockPath, { bigint: true }).ino, lockBefore.ino);

  const recovery = spawnSync(
    '/usr/bin/lockf',
    [
      '-s',
      '-t',
      '0',
      '-k',
      lockPath,
      process.execPath,
      fixture.worker,
      'recover',
      fixture.repo,
      recoveryResult,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(recoveryResult, 'utf8')), { state: 'restored' });
  assert.deepEqual(captureOutputRoots(fixture.repo), before);
  assert.equal(fs.existsSync(journalPath), false);
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(fs.lstatSync(lockPath, { bigint: true }).ino, lockBefore.ino);
});

test('macOS fd lock transfers through the manual shell exec into Node', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wargr-lock-exec-')));
  let holder;
  t.after(() => {
    if (holder) killProcessGroupIfPresent(holder.pid);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const lockPath = path.join(root, 'ghostwriter-sync.lock');
  const ready = path.join(root, 'exec-ready');
  const forbiddenMutation = path.join(root, 'concurrent-mutation');
  holder = spawn(
    '/bin/zsh',
    [
      '-c',
      `set -eu
umask 077
exec 9>"$1"
/usr/bin/lockf -s -t 0 9
exec "$2" -e 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], "ready"); setInterval(() => {}, 60000)' "$3"`,
      '--',
      lockPath,
      process.execPath,
      ready,
    ],
    { detached: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await waitForPath(ready, holder);
  const lockBefore = fs.lstatSync(lockPath, { bigint: true });

  const concurrent = spawnSync(
    '/usr/bin/lockf',
    [
      '-s',
      '-t',
      '0',
      '-k',
      lockPath,
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync(process.argv[1], "mutated")',
      forbiddenMutation,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(concurrent.status, 75, concurrent.stderr);
  assert.equal(fs.existsSync(forbiddenMutation), false);
  assert.equal(fs.lstatSync(lockPath, { bigint: true }).ino, lockBefore.ino);

  process.kill(-holder.pid, 'SIGKILL');
  await waitForExit(holder);
  await waitForLockAvailability(lockPath);
  assert.equal(fs.lstatSync(lockPath, { bigint: true }).ino, lockBefore.ino);
});

function createFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wargr-lock-transaction-')));
  const repo = path.join(root, 'wargr');
  fs.mkdirSync(path.join(repo, '.run'), { recursive: true, mode: 0o700 });
  writeSnapshot(repo, 'original');
  const transaction = fs.mkdtempSync(path.join(repo, '.run', 'ghostwriter-generated-content.'));
  fs.chmodSync(transaction, 0o700);
  const stage = path.join(transaction, 'snapshot');
  fs.mkdirSync(stage, { mode: 0o700 });
  writeSnapshot(stage, 'generated');
  const worker = path.join(root, 'transaction-worker.mjs');
  fs.writeFileSync(
    worker,
    `import fs from 'node:fs';
const transaction = await import(${JSON.stringify(TRANSACTION_MODULE)});
const [, , mode, repo, first, second, third] = process.argv;
if (mode === 'crash') {
  try {
    transaction.applyGeneratedContentSnapshot({
      repoRoot: repo,
      stagedSnapshotRoot: first,
      transactionRoot: second,
      recoverOnError: false,
      faultInjector(boundary) {
        if (boundary === 'after-staged-move:3') throw new Error('synthetic process death');
      },
    });
    throw new Error('synthetic mutation unexpectedly committed');
  } catch (error) {
    if (!String(error?.message).includes('synthetic process death')) throw error;
  }
  // The scheduled shell, rather than an inherited child descriptor, must retain exclusion.
  // Closing the child's copy makes that ownership observable to the concurrent contender.
  try {
    fs.closeSync(9);
  } catch (error) {
    if (error?.code !== 'EBADF') throw error;
  }
  fs.writeFileSync(third, 'ready');
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
} else if (mode === 'recover') {
  const result = transaction.recoverGeneratedContentTransaction({ repoRoot: repo });
  fs.writeFileSync(first, JSON.stringify(result));
} else {
  throw new Error('unknown synthetic transaction worker mode');
}
`,
    { mode: 0o600 },
  );
  return { root, repo, transaction, stage, worker };
}

function writeSnapshot(root, marker) {
  const values = new Map([
    ['public/feed.xml', `feed-${marker}`],
    ['public/robots.txt', `robots-${marker}`],
    ['public/sitemap.xml', `sitemap-${marker}`],
    ['src/app/app.routes.ts', `routes-${marker}`],
    ['src/app/pages/home.component.ts', `home-${marker}`],
    ['src/app/pages/not-found.component.ts', `not-found-${marker}`],
    ['src/app/articles/essay.component.ts', `article-${marker}`],
    ['public/assets/articles/essay.jpg', `hero-${marker}`],
    ['public/assets/articles/essay-og.jpg', `social-${marker}`],
  ]);
  for (const [relativePath, value] of values) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  }
}

function captureOutputRoots(repo) {
  return GENERATED_OUTPUT_PATHS.map((relativePath) => {
    const target = path.join(repo, relativePath);
    const entry = fs.lstatSync(target, { bigint: true });
    return {
      relativePath,
      dev: entry.dev.toString(),
      ino: entry.ino.toString(),
      representative: readRepresentative(repo, relativePath),
    };
  });
}

function readRepresentative(repo, relativePath) {
  const target = path.join(repo, relativePath);
  if (relativePath === 'src/app/articles') {
    return fs.readFileSync(path.join(target, 'essay.component.ts'), 'utf8');
  }
  if (relativePath === 'public/assets/articles') {
    return fs.readFileSync(path.join(target, 'essay.jpg'), 'utf8');
  }
  return fs.readFileSync(target, 'utf8');
}

async function waitForPath(candidate, child, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(candidate)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Synthetic lock holder exited early: ${await readChildOutput(child)}`);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${candidate}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForLockAvailability(lockPath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = spawnSync('/usr/bin/lockf', ['-s', '-t', '0', '-k', lockPath, '/usr/bin/true']);
    if (result.status === 0) return;
    if (Date.now() >= deadline)
      throw new Error('Kernel lock remained held after process-group death.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

function killProcessGroupIfPresent(pid) {
  if (!Number.isInteger(pid)) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function readChildOutput(child) {
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    for await (const chunk of stream) chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}
