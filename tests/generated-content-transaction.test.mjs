import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyGeneratedContentSnapshot,
  authorizeAndCommitGeneratedContent,
  GENERATED_OUTPUT_PATHS,
  generateGeneratedContent,
  recoverGeneratedContentTransaction,
} from '../scripts/generated-content-transaction.mjs';

const mutationBoundaries = Object.freeze([
  'after-journal',
  ...GENERATED_OUTPUT_PATHS.flatMap((_, index) => [
    `after-original-move:${index}`,
    `after-staged-move:${index}`,
  ]),
  'before-commit',
]);
const REVISION = 'a'.repeat(40);
const FINGERPRINT = 'b'.repeat(64);

test('every generated-output mutation boundary restores the exact pre-state', (t) => {
  for (const boundary of mutationBoundaries) {
    const fixture = createTransactionFixture(t, boundary.replaceAll(':', '-'));
    const before = captureOutputRoots(fixture.repo);
    assert.throws(
      () =>
        applyGeneratedContentSnapshot({
          repoRoot: fixture.repo,
          stagedSnapshotRoot: fixture.stage,
          transactionRoot: fixture.transaction,
          faultInjector(current) {
            if (current === boundary) throw new Error(`fault:${boundary}`);
          },
        }),
      new RegExp(`fault:${boundary.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`),
    );
    assert.deepEqual(captureOutputRoots(fixture.repo), before, boundary);
    assert.equal(
      fs.existsSync(path.join(fixture.repo, '.run/ghostwriter-generated-content-transaction.json')),
      false,
    );
  }
});

test('a crash-like interruption is recovered and the next complete retry succeeds', (t) => {
  const fixture = createTransactionFixture(t, 'crash');
  const before = captureOutputRoots(fixture.repo);
  assert.throws(
    () =>
      applyGeneratedContentSnapshot({
        repoRoot: fixture.repo,
        stagedSnapshotRoot: fixture.stage,
        transactionRoot: fixture.transaction,
        recoverOnError: false,
        faultInjector(boundary) {
          if (boundary === 'after-staged-move:3') throw new Error('simulated process death');
        },
      }),
    /simulated process death/,
  );
  assert.notDeepEqual(captureOutputRoots(fixture.repo), before);
  assert.deepEqual(recoverGeneratedContentTransaction({ repoRoot: fixture.repo }), {
    state: 'restored',
  });
  assert.deepEqual(captureOutputRoots(fixture.repo), before);

  const retry = createStage(fixture.repo, 'retry');
  assert.deepEqual(
    applyGeneratedContentSnapshot({
      repoRoot: fixture.repo,
      stagedSnapshotRoot: retry.stage,
      transactionRoot: retry.transaction,
    }),
    { state: 'committed', paths: GENERATED_OUTPUT_PATHS },
  );
  for (const relativePath of GENERATED_OUTPUT_PATHS) {
    assert.match(readRepresentative(fixture.repo, relativePath), /retry/);
  }
});

test('a durable restored checkpoint survives a crash before backup cleanup', (t) => {
  const fixture = createTransactionFixture(t, 'restored-checkpoint');
  const before = captureOutputRoots(fixture.repo);
  assert.throws(
    () =>
      applyGeneratedContentSnapshot({
        repoRoot: fixture.repo,
        stagedSnapshotRoot: fixture.stage,
        transactionRoot: fixture.transaction,
        recoverOnError: false,
        faultInjector(boundary) {
          if (boundary === 'after-staged-move:3') throw new Error('initial process death');
        },
      }),
    /initial process death/,
  );
  assert.throws(
    () =>
      recoverGeneratedContentTransaction({
        repoRoot: fixture.repo,
        faultInjector(boundary) {
          if (boundary === 'after-restored-journal') {
            throw new Error('recovery process death before cleanup');
          }
        },
      }),
    /recovery process death before cleanup/,
  );
  assert.deepEqual(captureOutputRoots(fixture.repo), before);
  assert.equal(fs.existsSync(fixture.transaction), true);
  assert.equal(readTransactionJournal(fixture.repo).state, 'restored');
  assert.deepEqual(recoverGeneratedContentTransaction({ repoRoot: fixture.repo }), {
    state: 'restored',
  });
  assert.equal(fs.existsSync(fixture.transaction), false);
  assert.equal(readTransactionJournal(fixture.repo), null);

  const retry = createStage(fixture.repo, 'checkpoint-retry');
  assert.deepEqual(
    applyGeneratedContentSnapshot({
      repoRoot: fixture.repo,
      stagedSnapshotRoot: retry.stage,
      transactionRoot: retry.transaction,
    }),
    { state: 'committed', paths: GENERATED_OUTPUT_PATHS },
  );
});

test('rollback preserves an output root that was absent before generation', (t) => {
  const fixture = createTransactionFixture(t, 'absent-original');
  const absent = path.join(fixture.repo, 'public/feed.xml');
  fs.unlinkSync(absent);
  assert.throws(
    () =>
      applyGeneratedContentSnapshot({
        repoRoot: fixture.repo,
        stagedSnapshotRoot: fixture.stage,
        transactionRoot: fixture.transaction,
        faultInjector(boundary) {
          if (boundary === 'after-staged-move:1') throw new Error('fault:absent-original');
        },
      }),
    /fault:absent-original/,
  );
  assert.equal(fs.existsSync(absent), false);
});

test('pre-journal renderer crash residue is bounded, removed, and does not block retry', (t) => {
  const fixture = createTransactionFixture(t, 'orphan-stage');
  const before = captureOutputRoots(fixture.repo);
  const journalResidue = path.join(
    fixture.repo,
    '.run/ghostwriter-generated-content-transaction.json.00000000-0000-0000-0000-000000000000.tmp',
  );
  fs.writeFileSync(journalResidue, 'partial journal', { mode: 0o600 });
  assert.deepEqual(recoverGeneratedContentTransaction({ repoRoot: fixture.repo }), {
    state: 'cleaned-orphans',
    removed: 2,
  });
  assert.equal(fs.existsSync(fixture.transaction), false);
  assert.equal(fs.existsSync(journalResidue), false);
  assert.deepEqual(captureOutputRoots(fixture.repo), before);

  const retry = createStage(fixture.repo, 'orphan-retry');
  assert.deepEqual(
    applyGeneratedContentSnapshot({
      repoRoot: fixture.repo,
      stagedSnapshotRoot: retry.stage,
      transactionRoot: retry.transaction,
    }),
    { state: 'committed', paths: GENERATED_OUTPUT_PATHS },
  );
});

test('a deferred publisher failure restores generated outputs and the exact prior attestation', (t) => {
  for (const boundary of ['after-attestation-move', 'after-staged-move:2', 'after-install']) {
    const fixture = createTransactionFixture(t, `deferred-${boundary.replaceAll(':', '-')}`);
    writeAttestation(fixture.repo, 'c'.repeat(40), 'd'.repeat(64));
    const before = capturePublisherState(fixture.repo);
    assert.throws(
      () =>
        applyGeneratedContentSnapshot({
          repoRoot: fixture.repo,
          stagedSnapshotRoot: fixture.stage,
          transactionRoot: fixture.transaction,
          deferAttestation: true,
          faultInjector(current) {
            if (current === boundary) throw new Error(`fault:${boundary}`);
          },
        }),
      new RegExp(`fault:${boundary.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`),
    );
    assert.deepEqual(capturePublisherState(fixture.repo), before, boundary);
  }
});

test('authorization crash recovery restores the prior source and attestation, then retry commits', (t) => {
  const fixture = createTransactionFixture(t, 'authorization-crash');
  writeAttestation(fixture.repo, 'c'.repeat(40), 'd'.repeat(64));
  const before = capturePublisherState(fixture.repo);
  assert.deepEqual(
    applyGeneratedContentSnapshot({
      repoRoot: fixture.repo,
      stagedSnapshotRoot: fixture.stage,
      transactionRoot: fixture.transaction,
      deferAttestation: true,
    }),
    { state: 'installed', paths: GENERATED_OUTPUT_PATHS },
  );
  assert.throws(
    () =>
      authorizeAndCommitGeneratedContent({
        ...authorizationOptions(fixture),
        recoverOnError: false,
        faultInjector(boundary) {
          if (boundary === 'after-attestation-write')
            throw new Error('simulated authorization death');
        },
      }),
    /simulated authorization death/,
  );
  assert.throws(
    () =>
      recoverGeneratedContentTransaction({
        repoRoot: fixture.repo,
        faultInjector(boundary) {
          if (boundary === 'after-restored-transaction-removal') {
            throw new Error('recovery process death after cleanup');
          }
        },
      }),
    /recovery process death after cleanup/,
  );
  assert.deepEqual(capturePublisherState(fixture.repo), before);
  assert.equal(fs.existsSync(fixture.transaction), false);
  assert.equal(readTransactionJournal(fixture.repo).state, 'restored');
  assert.deepEqual(recoverGeneratedContentTransaction({ repoRoot: fixture.repo }), {
    state: 'restored',
  });
  assert.equal(readTransactionJournal(fixture.repo), null);

  const retry = createStage(fixture.repo, 'authorized-retry');
  applyGeneratedContentSnapshot({
    repoRoot: fixture.repo,
    stagedSnapshotRoot: retry.stage,
    transactionRoot: retry.transaction,
    deferAttestation: true,
  });
  assert.deepEqual(authorizeAndCommitGeneratedContent(authorizationOptions(fixture)), {
    state: 'committed',
    revision: REVISION,
    fingerprint: FINGERPRINT,
  });
  assert.match(readRepresentative(fixture.repo, 'src/app/articles'), /authorized-retry/);
  assert.deepEqual(readAttestation(fixture.repo), {
    schemaVersion: 1,
    revision: REVISION,
    fingerprint: FINGERPRINT,
  });
});

test('failed first authorization restores the originally absent attestation', (t) => {
  const fixture = createTransactionFixture(t, 'first-authorization');
  const before = capturePublisherState(fixture.repo);
  applyGeneratedContentSnapshot({
    repoRoot: fixture.repo,
    stagedSnapshotRoot: fixture.stage,
    transactionRoot: fixture.transaction,
    deferAttestation: true,
  });
  assert.throws(
    () =>
      authorizeAndCommitGeneratedContent({
        ...authorizationOptions(fixture),
        faultInjector(boundary) {
          if (boundary === 'after-attestation-write') throw new Error('first attestation failure');
        },
      }),
    /first attestation failure/,
  );
  assert.deepEqual(capturePublisherState(fixture.repo), before);
});

test('a fault after the durable commit keeps the authorized retry state', (t) => {
  const fixture = createTransactionFixture(t, 'durable-commit');
  writeAttestation(fixture.repo, 'c'.repeat(40), 'd'.repeat(64));
  applyGeneratedContentSnapshot({
    repoRoot: fixture.repo,
    stagedSnapshotRoot: fixture.stage,
    transactionRoot: fixture.transaction,
    deferAttestation: true,
  });
  assert.throws(
    () =>
      authorizeAndCommitGeneratedContent({
        ...authorizationOptions(fixture),
        faultInjector(boundary) {
          if (boundary === 'after-commit-journal') throw new Error('post-commit fault');
        },
      }),
    /post-commit fault/,
  );
  assert.match(readRepresentative(fixture.repo, 'src/app/articles'), /generated/);
  assert.deepEqual(readAttestation(fixture.repo), {
    schemaVersion: 1,
    revision: REVISION,
    fingerprint: FINGERPRINT,
  });
  assert.deepEqual(recoverGeneratedContentTransaction({ repoRoot: fixture.repo }), {
    state: 'none',
  });
});

test('invalid slug inventories perform zero mutation and start no generator', (t) => {
  for (const kind of ['empty', 'empty-slug', 'collision', 'reserved']) {
    const fixture = createGenerationFixture(t, kind);
    const before = captureOutputRoots(fixture.repo);
    let spawnCalls = 0;
    assert.throws(
      () =>
        generateGeneratedContent({
          repoRoot: fixture.repo,
          toolRoot: path.resolve(new URL('..', import.meta.url).pathname),
          ghostwriterRoot: fixture.ghostwriter,
          spawn() {
            spawnCalls += 1;
            throw new Error('renderer must not start');
          },
        }),
      kind === 'empty'
        ? /at least one ☑ essay/
        : kind === 'empty-slug'
          ? /empty or unsafe slug/
          : kind === 'collision'
            ? /slug collision/
            : /reserved platform slug/,
    );
    assert.equal(spawnCalls, 0);
    assert.deepEqual(captureOutputRoots(fixture.repo), before);
    assert.deepEqual(
      fs
        .readdirSync(path.join(fixture.repo, '.run'))
        .filter((name) => name.startsWith('ghostwriter-generated-content.')),
      [],
    );
  }
});

test('a renderer failure leaves the complete generated snapshot untouched and retryable', (t) => {
  const fixture = createGenerationFixture(t, 'valid');
  const before = captureOutputRoots(fixture.repo);
  let spawnCalls = 0;
  assert.throws(
    () =>
      generateGeneratedContent({
        repoRoot: fixture.repo,
        toolRoot: path.resolve(new URL('..', import.meta.url).pathname),
        ghostwriterRoot: fixture.ghostwriter,
        spawn() {
          spawnCalls += 1;
          return { status: 1, signal: null, error: null, stdout: '', stderr: 'synthetic failure' };
        },
      }),
    /failed before generated-output mutation: synthetic failure/,
  );
  assert.equal(spawnCalls, 1);
  assert.deepEqual(captureOutputRoots(fixture.repo), before);
  assert.deepEqual(
    fs
      .readdirSync(path.join(fixture.repo, '.run'))
      .filter((name) => name.startsWith('ghostwriter-generated-content.')),
    [],
  );
});

function createTransactionFixture(t, suffix) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `wargr-generated-${suffix}-`)),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.run'), { mode: 0o700 });
  writeSnapshot(root, 'original');
  const { transaction, stage } = createStage(root, 'generated');
  const sourceGuard = path.join(root, 'tools/generated-source-guard.mjs');
  const allowlist = path.join(root, 'tools/ghostwriter-generated-source.json');
  fs.mkdirSync(path.dirname(sourceGuard), { recursive: true });
  fs.writeFileSync(sourceGuard, '// synthetic source guard\n');
  fs.writeFileSync(allowlist, '{}\n');
  return { repo: root, transaction, stage, sourceGuard, allowlist };
}

function createStage(repo, marker) {
  const transaction = fs.mkdtempSync(path.join(repo, '.run', 'ghostwriter-generated-content.'));
  fs.chmodSync(transaction, 0o700);
  const stage = path.join(transaction, 'snapshot');
  fs.mkdirSync(stage, { mode: 0o700 });
  writeSnapshot(stage, marker);
  return { transaction, stage };
}

function createGenerationFixture(t, kind) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wargr-generation-${kind}-`)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'wargr');
  const ghostwriter = path.join(root, 'ghostwriter');
  fs.mkdirSync(path.join(repo, '.run'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(repo, 'article-images'), { recursive: true });
  fs.mkdirSync(path.join(ghostwriter, 'wargr'), { recursive: true });
  writeSnapshot(repo, 'original');
  if (kind === 'valid') {
    fs.writeFileSync(path.join(ghostwriter, 'wargr/☑ essay.md'), '# Essay\n');
    fs.writeFileSync(path.join(repo, 'article-images/essay.png'), 'png');
  } else if (kind === 'empty-slug') {
    fs.writeFileSync(path.join(ghostwriter, 'wargr/☑ !!!.md'), '# Empty slug\n');
  } else if (kind === 'collision') {
    fs.writeFileSync(path.join(ghostwriter, 'wargr/☑ Same.md'), '# One\n');
    fs.writeFileSync(path.join(ghostwriter, 'wargr/☑ same!.md'), '# Two\n');
    fs.writeFileSync(path.join(repo, 'article-images/same.png'), 'png');
  } else if (kind === 'reserved') {
    fs.writeFileSync(path.join(ghostwriter, 'wargr/☑ healthz.md'), '# Reserved\n');
    fs.writeFileSync(path.join(repo, 'article-images/healthz.png'), 'png');
  }
  return { repo, ghostwriter };
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

function capturePublisherState(repo) {
  const attestationPath = path.join(repo, '.run/ghostwriter-source.json');
  const attestation = fs.existsSync(attestationPath)
    ? {
        ino: fs.lstatSync(attestationPath, { bigint: true }).ino.toString(),
        content: fs.readFileSync(attestationPath, 'utf8'),
      }
    : null;
  return { outputs: captureOutputRoots(repo), attestation };
}

function authorizationOptions(fixture) {
  return {
    repoRoot: fixture.repo,
    sourceGuardPath: fixture.sourceGuard,
    allowlistPath: fixture.allowlist,
    revision: REVISION,
    fingerprint: FINGERPRINT,
    spawn(_command, args) {
      if (args.includes('--capture')) {
        return {
          status: 0,
          signal: null,
          error: null,
          stdout: `${REVISION} ${FINGERPRINT}\n`,
          stderr: '',
        };
      }
      const attestationPath = args[args.indexOf('--record-attestation') + 1];
      writeAttestation(fixture.repo, REVISION, FINGERPRINT, attestationPath);
      return { status: 0, signal: null, error: null, stdout: '', stderr: '' };
    },
  };
}

function writeAttestation(
  repo,
  revision,
  fingerprint,
  target = path.join(repo, '.run/ghostwriter-source.json'),
) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    target,
    `${JSON.stringify({ schemaVersion: 1, revision, fingerprint }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

function readAttestation(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, '.run/ghostwriter-source.json'), 'utf8'));
}

function readTransactionJournal(repo) {
  const journalPath = path.join(repo, '.run/ghostwriter-generated-content-transaction.json');
  return fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, 'utf8')) : null;
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
