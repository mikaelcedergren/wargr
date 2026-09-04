#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { preflightPublishedArticleInventory } from './article-slugs.mjs';

const JOURNAL_FILENAME = 'wargr-generated-content-transaction.json';
const TRANSACTION_PREFIX = 'wargr-generated-content.';
const TRANSACTION_KIND = 'wargr-generated-content-transaction';
const TRANSACTION_SCHEMA_VERSION = 3;
const MAX_GENERATED_FILES = 8_192;
const MAX_GENERATED_DEPTH = 16;
const MAX_GENERATED_FILE_BYTES = 512 * 1024 * 1024;
const MAX_GENERATED_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_TRANSACTION_FILES = MAX_GENERATED_FILES * 4;
const MAX_TRANSACTION_TOTAL_BYTES = MAX_GENERATED_TOTAL_BYTES * 8;
const MAX_JOURNAL_BYTES = 256 * 1024;
const MAX_RUNTIME_ENTRIES = 256;
const SOURCE_ATTESTATION_RELATIVE = '.run/generated-source.json';
const SOURCE_ALLOWLIST_RELATIVE = 'scripts/wargr-generated-source.json';
const SOURCE_GUARD_RELATIVE = 'bin/generated-source-guard.mjs';

export const GENERATED_OUTPUT_PATHS = Object.freeze([
  'public/assets/articles',
  'public/feed.xml',
  'public/robots.txt',
  'public/sitemap.xml',
  'src/app/app.routes.ts',
  'src/app/articles',
  'src/app/pages/home.component.ts',
  'src/app/pages/not-found.component.ts',
]);

const TOOL_REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function run(argv) {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== 'string')) {
    throw new TypeError('Generated-content transaction arguments must be strings.');
  }
  const command = argv[0];
  const generate = command === 'generate' && argv.length <= 2;
  const deferAttestation = generate && argv[1] === '--defer-attestation';
  const recover = command === 'recover' && argv.length === 1;
  const commit = command === 'commit';
  if ((!generate || (argv.length === 2 && !deferAttestation)) && !recover && !commit) {
    throw new Error(
      'Usage: generated-content-transaction.mjs generate [--defer-attestation] | recover | commit --revision <git-object-id> --fingerprint <sha256>',
    );
  }
  const repoRoot = requireCanonicalDirectory(
    path.resolve(process.env.WARGR_REPO_ROOT ?? TOOL_REPO),
    'Wargr repository',
  );
  if (recover) {
    recoverGeneratedContentTransaction({ repoRoot });
    return;
  }
  const toolRoot = requireCanonicalDirectory(
    path.resolve(process.env.WARGR_PUBLISHER_TOOL_ROOT ?? TOOL_REPO),
    'Wargr publisher tool root',
  );
  if (commit) {
    const { revision, fingerprint } = parseCommitArguments(argv.slice(1));
    authorizeAndCommitGeneratedContent({
      repoRoot,
      sourceGuardPath: containedPath(
        requireCanonicalDirectory(
          path.resolve(
            process.env.WARGR_SERVER_OPS_TOOL_ROOT ?? path.resolve(repoRoot, '..', 'server-ops'),
          ),
          'server-ops publisher tool root',
        ),
        SOURCE_GUARD_RELATIVE,
      ),
      allowlistPath: containedPath(toolRoot, SOURCE_ALLOWLIST_RELATIVE),
      revision,
      fingerprint,
    });
    return;
  }
  const databasePath = path.resolve(
    process.env.WARGR_DB_PATH ?? path.join(repoRoot, 'data', 'wargr.db'),
  );
  generateGeneratedContent({ repoRoot, toolRoot, databasePath, deferAttestation });
}

export function generateGeneratedContent({
  repoRoot,
  toolRoot,
  databasePath,
  spawn = spawnSync,
  faultInjector,
  deferAttestation = false,
} = {}) {
  const repo = requireCanonicalDirectory(repoRoot, 'Wargr repository');
  const tools = requireCanonicalDirectory(toolRoot, 'Wargr publisher tool root');
  const database = path.resolve(databasePath);
  recoverGeneratedContentTransaction({ repoRoot: repo });

  // This is the first operation after recovery and precedes staging creation. An empty or
  // colliding slug set therefore performs zero generated-output mutation and starts no renderer.
  const inventory = preflightPublishedArticleInventory({
    databasePath: database,
    imagesRoot: path.join(repo, 'article-images'),
  });

  const runRoot = ensurePrivateRunRoot(repo);
  const transactionRoot = fs.mkdtempSync(path.join(runRoot, TRANSACTION_PREFIX));
  fs.chmodSync(transactionRoot, 0o700);
  const stagedSnapshotRoot = path.join(transactionRoot, 'snapshot');
  fs.mkdirSync(stagedSnapshotRoot, { mode: 0o700 });
  try {
    for (const script of ['prepare-article-images.mjs', 'generate-articles.mjs']) {
      runGenerator({
        repoRoot: repo,
        toolRoot: tools,
        databasePath: database,
        stagedSnapshotRoot,
        script,
        spawn,
      });
    }
    const expectedSlugs = inventory.map((entry) => entry.slug);
    assertExactGeneratedSnapshot(stagedSnapshotRoot, { expectedSlugs });
    return applyGeneratedContentSnapshot({
      repoRoot: repo,
      stagedSnapshotRoot,
      transactionRoot,
      faultInjector,
      deferAttestation,
      expectedSlugs,
    });
  } catch (error) {
    if (!journalExists(repo) && fs.existsSync(transactionRoot)) {
      removeOwnedTransactionRoot(repo, transactionRoot);
    }
    throw error;
  }
}

export function applyGeneratedContentSnapshot({
  repoRoot,
  stagedSnapshotRoot,
  transactionRoot,
  faultInjector = () => {},
  recoverOnError = true,
  deferAttestation = false,
  expectedSlugs,
} = {}) {
  const repo = requireCanonicalDirectory(repoRoot, 'Wargr repository');
  const runRoot = requirePrivateRunRoot(repo);
  const transaction = requireOwnedTransactionRoot(runRoot, transactionRoot);
  const staged = requireCanonicalChildDirectory(transaction, stagedSnapshotRoot, 'generated stage');
  if (typeof faultInjector !== 'function') {
    throw new TypeError('Generated-content fault injector must be a function.');
  }
  if (typeof recoverOnError !== 'boolean') {
    throw new TypeError('Generated-content recoverOnError must be a boolean.');
  }
  if (typeof deferAttestation !== 'boolean') {
    throw new TypeError('Generated-content deferAttestation must be a boolean.');
  }
  if (journalExists(repo)) {
    throw new Error('A generated-content transaction is already open; recover it first.');
  }
  if (
    fs.lstatSync(repo, { bigint: true }).dev !== fs.lstatSync(transaction, { bigint: true }).dev
  ) {
    throw new Error('Generated-content staging must share the Wargr repository filesystem.');
  }
  assertExactGeneratedSnapshot(staged, { expectedSlugs });

  const backupRoot = path.join(transaction, 'backup');
  const discardRoot = path.join(transaction, 'discard');
  fs.mkdirSync(backupRoot, { mode: 0o700 });
  fs.mkdirSync(discardRoot, { mode: 0o700 });
  const entries = GENERATED_OUTPUT_PATHS.map((relativePath, index) => {
    const target = containedPath(repo, relativePath);
    const stagedPath = containedPath(staged, relativePath);
    assertCanonicalTargetParent(repo, target);
    return Object.freeze({
      index,
      relativePath,
      original: snapshotPath(target),
      staged: snapshotPath(stagedPath),
    });
  });
  if (entries.some((entry) => entry.staged.kind === 'absent')) {
    throw new Error('Generated stage is missing one or more exact output roots.');
  }
  const attestation = deferAttestation
    ? Object.freeze({
        relativePath: SOURCE_ATTESTATION_RELATIVE,
        original: snapshotPath(containedPath(repo, SOURCE_ATTESTATION_RELATIVE)),
      })
    : null;

  let journal = Object.freeze({
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    kind: TRANSACTION_KIND,
    id: randomUUID(),
    state: 'prepared',
    transactionRoot: transaction,
    entries: Object.freeze(entries),
    attestation,
    authorization: null,
  });
  writeJournal(repo, journal);
  try {
    faultInjector('after-journal');
    journal = withJournalState(journal, 'swapping');
    writeJournal(repo, journal);
    if (attestation && attestation.original.kind !== 'absent') {
      const target = containedPath(repo, attestation.relativePath);
      const backup = containedPath(backupRoot, attestation.relativePath);
      fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
      assertSnapshot(target, attestation.original, 'generated-source attestation');
      fs.renameSync(target, backup);
      syncDirectory(path.dirname(target));
      syncDirectory(path.dirname(backup));
    }
    if (attestation) faultInjector('after-attestation-move');
    for (const entry of entries) {
      const target = containedPath(repo, entry.relativePath);
      const backup = containedPath(backupRoot, entry.relativePath);
      const stagedPath = containedPath(staged, entry.relativePath);
      if (entry.original.kind !== 'absent') {
        fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
        assertSnapshot(target, entry.original, `generated output ${entry.relativePath}`);
        fs.renameSync(target, backup);
        syncDirectory(path.dirname(target));
        syncDirectory(path.dirname(backup));
      }
      faultInjector(`after-original-move:${entry.index}`);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
      assertSnapshot(stagedPath, entry.staged, `staged generated output ${entry.relativePath}`);
      fs.renameSync(stagedPath, target);
      syncDirectory(path.dirname(stagedPath));
      syncDirectory(path.dirname(target));
      faultInjector(`after-staged-move:${entry.index}`);
    }
    for (const entry of entries) {
      assertSnapshot(
        containedPath(repo, entry.relativePath),
        entry.staged,
        `installed generated output ${entry.relativePath}`,
      );
    }
    if (deferAttestation) {
      journal = withJournalState(journal, 'installed');
      writeJournal(repo, journal);
      faultInjector('after-install');
      return Object.freeze({ state: 'installed', paths: GENERATED_OUTPUT_PATHS });
    }
    faultInjector('before-commit');
    journal = withJournalState(journal, 'committed');
    writeJournal(repo, journal);
    finalizeCommittedTransaction(repo, journal);
    return Object.freeze({ state: 'committed', paths: GENERATED_OUTPUT_PATHS });
  } catch (error) {
    if (!recoverOnError) throw error;
    try {
      recoverGeneratedContentTransaction({ repoRoot: repo });
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        'Generated-content update failed and exact pre-state recovery needs review.',
      );
    }
    throw error;
  }
}

export function authorizeAndCommitGeneratedContent({
  repoRoot,
  sourceGuardPath,
  allowlistPath,
  revision,
  fingerprint,
  spawn = spawnSync,
  faultInjector = () => {},
  recoverOnError = true,
} = {}) {
  const repo = requireCanonicalDirectory(repoRoot, 'Wargr repository');
  assertGitRevision(revision);
  assertFingerprint(fingerprint);
  const sourceGuard = requireCanonicalFile(sourceGuardPath, 'generated-source guard');
  const allowlist = requireCanonicalFile(allowlistPath, 'generated-source allowlist');
  if (typeof spawn !== 'function' || typeof faultInjector !== 'function') {
    throw new TypeError('Generated-content authorization adapters must be functions.');
  }
  if (typeof recoverOnError !== 'boolean') {
    throw new TypeError('Generated-content authorization recoverOnError must be a boolean.');
  }
  let journal = readJournal(repo, { required: true });
  if (
    journal.state !== 'installed' ||
    journal.attestation === null ||
    journal.authorization !== null
  ) {
    throw new Error(
      'Generated-content authorization requires one installed, unattested transaction.',
    );
  }
  requireOwnedTransactionRoot(requirePrivateRunRoot(repo), journal.transactionRoot);
  const attestationPath = containedPath(repo, journal.attestation.relativePath);
  if (snapshotPath(attestationPath).kind !== 'absent') {
    throw new Error('Generated-source attestation appeared before transaction authorization.');
  }
  for (const entry of journal.entries) {
    assertSnapshot(
      containedPath(repo, entry.relativePath),
      entry.staged,
      `installed generated output ${entry.relativePath}`,
    );
  }

  try {
    const captured = runSourceGuard(
      sourceGuard,
      ['--repo', repo, '--capture', allowlist, '--expected-revision', revision],
      spawn,
      { expectState: true },
    );
    if (captured.revision !== revision || captured.fingerprint !== fingerprint) {
      throw new Error('Generated source changed after its post-generation proof.');
    }
    journal = withJournalState(journal, 'authorizing', { revision, fingerprint });
    writeJournal(repo, journal);
    faultInjector('after-authorization-journal');
    runSourceGuard(
      sourceGuard,
      [
        '--repo',
        repo,
        '--record-attestation',
        attestationPath,
        '--revision',
        revision,
        '--fingerprint',
        fingerprint,
      ],
      spawn,
    );
    assertSourceAttestation(attestationPath, { revision, fingerprint });
    faultInjector('after-attestation-write');
    journal = withJournalState(journal, 'committed', journal.authorization);
    writeJournal(repo, journal);
    faultInjector('after-commit-journal');
    finalizeCommittedTransaction(repo, journal);
    return Object.freeze({ state: 'committed', revision, fingerprint });
  } catch (error) {
    if (!recoverOnError) throw error;
    try {
      recoverGeneratedContentTransaction({ repoRoot: repo });
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        'Generated-content authorization failed and exact pre-state recovery needs review.',
      );
    }
    throw error;
  }
}

export function recoverGeneratedContentTransaction({ repoRoot, faultInjector = () => {} } = {}) {
  const repo = requireCanonicalDirectory(repoRoot, 'Wargr repository');
  if (typeof faultInjector !== 'function') {
    throw new TypeError('Generated-content recovery fault injector must be a function.');
  }
  const runRoot = privateRunRootIfPresent(repo);
  if (runRoot === null) return Object.freeze({ state: 'none' });
  let journal = readJournal(repo, { required: false });
  if (journal === null) return recoverOrphanTransactionRuntime(repo, runRoot);
  if (journal.state === 'restored') {
    assertRestoredTransaction(repo, journal);
    finalizeRestoredTransaction(repo, journal, faultInjector);
    return Object.freeze({ state: 'restored' });
  }
  if (journal.state === 'committed') {
    for (const entry of journal.entries) {
      assertSnapshot(
        containedPath(repo, entry.relativePath),
        entry.staged,
        `committed generated output ${entry.relativePath}`,
      );
    }
    if (journal.attestation !== null) {
      assertSourceAttestation(
        containedPath(repo, journal.attestation.relativePath),
        journal.authorization,
      );
    }
    finalizeCommittedTransaction(repo, journal);
    return Object.freeze({ state: 'finalized' });
  }

  const transactionRoot = requireOwnedTransactionRoot(
    requirePrivateRunRoot(repo),
    journal.transactionRoot,
  );
  const backupRoot = path.join(transactionRoot, 'backup');
  const discardRoot = path.join(transactionRoot, 'discard');
  fs.mkdirSync(discardRoot, { recursive: true, mode: 0o700 });
  for (const entry of [...journal.entries].reverse()) {
    const target = containedPath(repo, entry.relativePath);
    const backup = containedPath(backupRoot, entry.relativePath);
    const current = snapshotPath(target);
    const saved = snapshotPath(backup);

    if (snapshotEqual(current, entry.staged)) {
      const discarded = containedPath(discardRoot, entry.relativePath);
      fs.mkdirSync(path.dirname(discarded), { recursive: true, mode: 0o700 });
      fs.renameSync(target, discarded);
      syncDirectory(path.dirname(target));
      syncDirectory(path.dirname(discarded));
    } else if (!snapshotEqual(current, entry.original) && current.kind !== 'absent') {
      throw new Error(`Generated output changed during recovery: ${entry.relativePath}.`);
    }

    if (entry.original.kind === 'absent') {
      if (saved.kind !== 'absent') {
        throw new Error(`Unexpected generated backup exists for ${entry.relativePath}.`);
      }
      continue;
    }
    const now = snapshotPath(target);
    if (snapshotEqual(now, entry.original)) {
      if (saved.kind !== 'absent') {
        throw new Error(
          `Duplicate generated original exists during recovery: ${entry.relativePath}.`,
        );
      }
      continue;
    }
    assertSnapshot(backup, entry.original, `saved generated output ${entry.relativePath}`);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
    fs.renameSync(backup, target);
    syncDirectory(path.dirname(backup));
    syncDirectory(path.dirname(target));
  }
  for (const entry of journal.entries) {
    assertSnapshot(
      containedPath(repo, entry.relativePath),
      entry.original,
      `restored generated output ${entry.relativePath}`,
    );
  }
  restoreSourceAttestation({ repoRoot: repo, transactionRoot, journal });
  journal = withJournalState(journal, 'restored');
  writeJournal(repo, journal);
  faultInjector('after-restored-journal');
  finalizeRestoredTransaction(repo, journal, faultInjector);
  return Object.freeze({ state: 'restored' });
}

function assertRestoredTransaction(repoRoot, journal) {
  for (const entry of journal.entries) {
    assertSnapshot(
      containedPath(repoRoot, entry.relativePath),
      entry.original,
      `restored generated output ${entry.relativePath}`,
    );
  }
  if (journal.attestation !== null) {
    assertSnapshot(
      containedPath(repoRoot, journal.attestation.relativePath),
      journal.attestation.original,
      'restored generated-source attestation',
    );
  }
}

function finalizeRestoredTransaction(repoRoot, journal, faultInjector) {
  let transactionRoot;
  try {
    transactionRoot = requireOwnedTransactionRoot(
      requirePrivateRunRoot(repoRoot),
      journal.transactionRoot,
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (transactionRoot !== undefined) removeOwnedTransactionRoot(repoRoot, transactionRoot);
  faultInjector('after-restored-transaction-removal');
  removeJournal(repoRoot);
}

export function assertExactGeneratedSnapshot(stagedSnapshotRoot, { expectedSlugs } = {}) {
  const staged = requireCanonicalDirectory(stagedSnapshotRoot, 'generated snapshot');
  const expectedRoots = new Set(GENERATED_OUTPUT_PATHS);
  const directoryRoots = new Set(['public/assets/articles', 'src/app/articles']);
  const expectedKinds = new Map([...directoryRoots].map((root) => [root, 'directory']));
  let requiredSlugs;
  if (expectedSlugs !== undefined) {
    if (
      !Array.isArray(expectedSlugs) ||
      expectedSlugs.length === 0 ||
      expectedSlugs.some(
        (slug) => typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug),
      ) ||
      new Set(expectedSlugs).size !== expectedSlugs.length
    ) {
      throw new Error('Generated snapshot expected slugs are invalid.');
    }
    requiredSlugs = new Set(expectedSlugs);
  }
  for (const relativePath of GENERATED_OUTPUT_PATHS) {
    const snapshot = snapshotPath(containedPath(staged, relativePath));
    const expectedKind = expectedKinds.get(relativePath) ?? 'file';
    if (snapshot.kind !== expectedKind) {
      throw new Error(`Generated snapshot ${relativePath} must be a ${expectedKind}.`);
    }
  }

  const allowedDirectories = new Set([
    'public',
    'public/assets',
    'public/assets/articles',
    'src',
    'src/app',
    'src/app/articles',
    'src/app/pages',
  ]);
  const articleComponents = new Set();
  const heroImages = new Set();
  const socialImages = new Set();
  let files = 0;
  let totalBytes = 0;
  const pending = [{ directory: staged, relative: '', depth: 0 }];
  while (pending.length > 0) {
    const { directory, relative, depth } = pending.pop();
    if (depth > MAX_GENERATED_DEPTH) {
      throw new Error(`Generated snapshot exceeds depth ${MAX_GENERATED_DEPTH}.`);
    }
    const entries = readBoundedDirectoryEntries(directory, {
      maxEntries: MAX_GENERATED_FILES,
      label: 'Generated snapshot directory',
    });
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Generated snapshot contains a link: ${childRelative}.`);
      if (entry.isDirectory()) {
        if (!allowedDirectories.has(childRelative)) {
          throw new Error(`Generated snapshot contains an unknown directory: ${childRelative}.`);
        }
        pending.push({ directory: child, relative: childRelative, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile())
        throw new Error(`Generated snapshot contains a special file: ${childRelative}.`);
      let allowed = expectedRoots.has(childRelative) && !directoryRoots.has(childRelative);
      let match = /^src\/app\/articles\/([a-z0-9]+(?:-[a-z0-9]+)*)\.component\.ts$/u.exec(
        childRelative,
      );
      if (match) {
        articleComponents.add(match[1]);
        allowed = true;
      }
      match = /^public\/assets\/articles\/([a-z0-9]+(?:-[a-z0-9]+)*)-og\.jpg$/u.exec(childRelative);
      if (match) {
        socialImages.add(match[1]);
        allowed = true;
      } else {
        match = /^public\/assets\/articles\/([a-z0-9]+(?:-[a-z0-9]+)*)\.jpg$/u.exec(childRelative);
        if (match) {
          heroImages.add(match[1]);
          allowed = true;
        }
      }
      if (!allowed)
        throw new Error(`Generated snapshot contains an unknown file: ${childRelative}.`);
      const stat = fs.lstatSync(child, { bigint: true });
      if (stat.nlink !== 1n || stat.size > BigInt(MAX_GENERATED_FILE_BYTES)) {
        throw new Error(`Generated snapshot file is unsafe or too large: ${childRelative}.`);
      }
      files += 1;
      totalBytes += Number(stat.size);
      if (files > MAX_GENERATED_FILES || totalBytes > MAX_GENERATED_TOTAL_BYTES) {
        throw new Error('Generated snapshot exceeds its bounded file or byte inventory.');
      }
    }
  }
  const slugs = requiredSlugs ?? articleComponents;
  if (
    slugs.size === 0 ||
    !setEqual(articleComponents, slugs) ||
    !setEqual(heroImages, slugs) ||
    !setEqual(socialImages, slugs)
  ) {
    throw new Error(
      'Generated snapshot must contain exactly one article component and both image variants for every preflighted slug.',
    );
  }
  return Object.freeze({ files, totalBytes });
}

function runGenerator({ repoRoot, toolRoot, databasePath, stagedSnapshotRoot, script, spawn }) {
  if (typeof spawn !== 'function')
    throw new TypeError('Generated-content spawn adapter is invalid.');
  const entrypoint = containedPath(path.join(toolRoot, 'scripts'), script);
  const result = spawn(process.execPath, [entrypoint], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WARGR_REPO_ROOT: repoRoot,
      WARGR_DB_PATH: databasePath,
      WARGR_GENERATED_OUTPUT_ROOT: stagedSnapshotRoot,
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.signal || result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter((value) => typeof value === 'string' && value.trim())
      .join('\n')
      .trim();
    throw new Error(
      `${script} failed before generated-output mutation${detail ? `: ${detail}` : '.'}`,
      result.error instanceof Error ? { cause: result.error } : undefined,
    );
  }
  if (result.stdout) process.stdout.write(result.stdout);
}

function parseCommitArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) {
    throw new Error(
      'Usage: generated-content-transaction.mjs commit --revision <git-object-id> --fingerprint <sha256>',
    );
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--revision', '--fingerprint'].includes(flag) || values.has(flag) || !value) {
      throw new Error(
        'Usage: generated-content-transaction.mjs commit --revision <git-object-id> --fingerprint <sha256>',
      );
    }
    values.set(flag, value);
  }
  const revision = values.get('--revision');
  const fingerprint = values.get('--fingerprint');
  assertGitRevision(revision);
  assertFingerprint(fingerprint);
  return Object.freeze({ revision, fingerprint });
}

function runSourceGuard(sourceGuardPath, args, spawn, { expectState = false } = {}) {
  const result = spawn(process.execPath, [sourceGuardPath, ...args], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 2 * 60_000,
  });
  if (result.error || result.signal || result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter((value) => typeof value === 'string' && value.trim())
      .join('\n')
      .trim();
    throw new Error(
      `Generated-source authorization command failed${detail ? `: ${detail}` : '.'}`,
      result.error instanceof Error ? { cause: result.error } : undefined,
    );
  }
  if (!expectState) {
    if (result.stdout?.trim()) {
      throw new Error('Generated-source attestation command returned unexpected output.');
    }
    return null;
  }
  const match = /^([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{64})\n$/u.exec(result.stdout ?? '');
  if (!match) throw new Error('Generated-source capture returned an invalid state.');
  return Object.freeze({ revision: match[1], fingerprint: match[2] });
}

function restoreSourceAttestation({ repoRoot, transactionRoot, journal }) {
  const attestation = journal.attestation;
  if (attestation === null) return;
  const target = containedPath(repoRoot, attestation.relativePath);
  const backup = containedPath(path.join(transactionRoot, 'backup'), attestation.relativePath);
  const discard = containedPath(path.join(transactionRoot, 'discard'), attestation.relativePath);
  let current = snapshotPath(target);
  const saved = snapshotPath(backup);

  if (!snapshotEqual(current, attestation.original) && current.kind !== 'absent') {
    if (journal.authorization === null) {
      throw new Error('Generated-source attestation changed during transaction recovery.');
    }
    assertSourceAttestation(target, journal.authorization);
    fs.mkdirSync(path.dirname(discard), { recursive: true, mode: 0o700 });
    fs.renameSync(target, discard);
    syncDirectory(path.dirname(target));
    syncDirectory(path.dirname(discard));
    current = Object.freeze({ kind: 'absent' });
  }

  if (attestation.original.kind === 'absent') {
    if (saved.kind !== 'absent') {
      throw new Error('Unexpected generated-source attestation backup exists.');
    }
  } else if (snapshotEqual(current, attestation.original)) {
    if (saved.kind !== 'absent') {
      throw new Error('Duplicate generated-source attestation original exists during recovery.');
    }
  } else {
    assertSnapshot(backup, attestation.original, 'saved generated-source attestation');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.renameSync(backup, target);
    syncDirectory(path.dirname(backup));
    syncDirectory(path.dirname(target));
  }
  assertSnapshot(target, attestation.original, 'restored generated-source attestation');
}

function recoverOrphanTransactionRuntime(repoRoot, runRoot) {
  const entries = readBoundedDirectoryEntries(runRoot, {
    maxEntries: MAX_RUNTIME_ENTRIES,
    label: 'Wargr generated-content runtime',
  });
  const transactionRoots = [];
  const temporaryJournals = [];
  for (const entry of entries) {
    if (entry.name.startsWith(TRANSACTION_PREFIX)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Generated-content orphan stage is unsafe: ${entry.name}.`);
      }
      transactionRoots.push(path.join(runRoot, entry.name));
      continue;
    }
    if (entry.name.startsWith(`${JOURNAL_FILENAME}.`)) {
      if (
        !new RegExp(`^${escapeRegExp(JOURNAL_FILENAME)}\\.[a-f0-9-]{36}\\.tmp$`, 'u').test(
          entry.name,
        )
      ) {
        throw new Error(`Generated-content journal residue has an unsafe name: ${entry.name}.`);
      }
      temporaryJournals.push(path.join(runRoot, entry.name));
    }
  }
  for (const transactionRoot of transactionRoots) {
    assertPreJournalOrphanStage(transactionRoot);
    removeOwnedTransactionRoot(repoRoot, transactionRoot);
  }
  for (const temporary of temporaryJournals) {
    const entry = fs.lstatSync(temporary, { bigint: true });
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.nlink !== 1n ||
      entry.size > BigInt(MAX_JOURNAL_BYTES) ||
      fs.realpathSync(temporary) !== temporary
    ) {
      throw new Error(`Generated-content journal residue is unsafe: ${temporary}.`);
    }
    fs.unlinkSync(temporary);
  }
  if (temporaryJournals.length > 0) syncDirectory(runRoot);
  const removed = transactionRoots.length + temporaryJournals.length;
  return removed === 0
    ? Object.freeze({ state: 'none' })
    : Object.freeze({ state: 'cleaned-orphans', removed });
}

function assertPreJournalOrphanStage(transactionRoot) {
  const entries = readBoundedDirectoryEntries(transactionRoot, {
    maxEntries: 3,
    label: 'Generated-content orphan stage root',
  });
  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has('snapshot')) {
    throw new Error('Generated-content orphan is missing its exact pre-journal snapshot.');
  }
  for (const entry of entries) {
    if (!['snapshot', 'backup', 'discard'].includes(entry.name) || !entry.isDirectory()) {
      throw new Error(`Generated-content orphan contains an unsafe entry: ${entry.name}.`);
    }
    if (entry.name !== 'snapshot') {
      readBoundedDirectoryEntries(path.join(transactionRoot, entry.name), {
        maxEntries: 0,
        label: `Generated-content orphan ${entry.name}`,
      });
    }
  }
}

function readBoundedDirectoryEntries(directory, { maxEntries, label }) {
  const before = fs.lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`${label} is not a canonical directory.`);
  }
  const entries = [];
  const handle = fs.opendirSync(directory);
  try {
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      entries.push(entry);
      if (entries.length > maxEntries) {
        throw new Error(`${label} exceeds ${maxEntries} entries.`);
      }
    }
  } finally {
    try {
      handle.closeSync();
    } catch (error) {
      if (error?.code !== 'ERR_DIR_CLOSED') throw error;
    }
  }
  const after = fs.lstatSync(directory, { bigint: true });
  if (!sameFileSnapshot(before, after)) {
    throw new Error(`${label} changed during bounded inspection.`);
  }
  return entries.sort((left, right) => byteCompare(left.name, right.name));
}

function assertSourceAttestation(candidate, expected) {
  validateAuthorization(expected);
  const before = fs.lstatSync(candidate, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(MAX_JOURNAL_BYTES) ||
    fs.realpathSync(candidate) !== candidate
  ) {
    throw new Error('Generated-source attestation is not one bounded canonical file.');
  }
  const bytes = fs.readFileSync(candidate);
  const after = fs.lstatSync(candidate, { bigint: true });
  if (!sameFileSnapshot(before, after) || after.size !== BigInt(bytes.length)) {
    throw new Error('Generated-source attestation changed while it was read.');
  }
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), ['fingerprint', 'revision', 'schemaVersion']) ||
    value.schemaVersion !== 1 ||
    value.revision !== expected.revision ||
    value.fingerprint !== expected.fingerprint
  ) {
    throw new Error('Generated-source attestation does not match transaction authorization.');
  }
}

function validateAuthorization(authorization) {
  if (
    !authorization ||
    typeof authorization !== 'object' ||
    Array.isArray(authorization) ||
    !isDeepStrictEqual(Object.keys(authorization).sort(), ['fingerprint', 'revision'])
  ) {
    throw new Error('Generated-content authorization is invalid.');
  }
  assertGitRevision(authorization.revision);
  assertFingerprint(authorization.fingerprint);
}

function assertGitRevision(revision) {
  if (typeof revision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision)) {
    throw new Error('Generated-content revision must be a full lowercase Git object id.');
  }
}

function assertFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new Error('Generated-content fingerprint must be a lowercase SHA-256 digest.');
  }
}

function snapshotPath(
  candidate,
  { maxFiles = MAX_GENERATED_FILES, maxTotalBytes = MAX_GENERATED_TOTAL_BYTES } = {},
) {
  let root;
  try {
    root = fs.lstatSync(candidate, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ kind: 'absent' });
    throw error;
  }
  if (root.isSymbolicLink() || (!root.isFile() && !root.isDirectory())) {
    throw new Error(`Generated transaction path is not a regular file or directory: ${candidate}.`);
  }
  if (root.isFile() && root.nlink !== 1n) {
    throw new Error(`Generated transaction file is aliased: ${candidate}.`);
  }
  if (fs.realpathSync(candidate) !== candidate) {
    throw new Error(`Generated transaction path traverses a symbolic link: ${candidate}.`);
  }
  const hash = createHash('sha256');
  const kind = root.isDirectory() ? 'directory' : 'file';
  hash.update(`root\0${kind}\0${Number(root.mode & 0o7777n).toString(8)}\0`);
  if (root.isFile()) hashStableFile(candidate, root, hash, '');
  else hashDirectoryTree(candidate, hash, { maxFiles, maxTotalBytes });
  return Object.freeze({
    kind,
    dev: root.dev.toString(),
    ino: root.ino.toString(),
    digest: hash.digest('hex'),
  });
}

function hashDirectoryTree(root, hash, { maxFiles, maxTotalBytes }) {
  let files = 0;
  let entriesSeen = 0;
  let totalBytes = 0;
  const pending = [{ directory: root, relative: '', depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > MAX_GENERATED_DEPTH) {
      throw new Error(`Generated transaction tree exceeds depth ${MAX_GENERATED_DEPTH}.`);
    }
    const entries = readBoundedDirectoryEntries(current.directory, {
      maxEntries: maxFiles,
      label: 'Generated transaction directory',
    });
    entriesSeen += entries.length;
    if (entriesSeen > maxFiles) {
      throw new Error('Generated transaction tree exceeds its bounded entry inventory.');
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const candidate = path.join(current.directory, entry.name);
      const stat = fs.lstatSync(candidate, { bigint: true });
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error(`Generated transaction tree contains an unsafe entry: ${relative}.`);
      }
      if (entry.isFile() && stat.nlink !== 1n) {
        throw new Error(`Generated transaction tree contains an aliased file: ${relative}.`);
      }
      hash.update(
        `${relative}\0${entry.isDirectory() ? 'd' : 'f'}\0${Number(stat.mode & 0o7777n).toString(8)}\0`,
      );
      if (entry.isDirectory()) {
        pending.push({ directory: candidate, relative, depth: current.depth + 1 });
      } else {
        files += 1;
        totalBytes += Number(stat.size);
        if (
          stat.size > BigInt(MAX_GENERATED_FILE_BYTES) ||
          files > maxFiles ||
          totalBytes > maxTotalBytes
        ) {
          throw new Error('Generated transaction tree exceeds its bounded inventory.');
        }
        hashStableFile(candidate, stat, hash, relative);
      }
    }
  }
}

function hashStableFile(candidate, expected, hash, relative) {
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(expected, before) || before.size > BigInt(MAX_GENERATED_FILE_BYTES)) {
      throw new Error(`Generated transaction file changed before read: ${relative || candidate}.`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(before, after) || after.size !== BigInt(bytes.length)) {
      throw new Error(`Generated transaction file changed during read: ${relative || candidate}.`);
    }
    hash.update(`${bytes.length}\0`);
    hash.update(bytes);
    hash.update('\0');
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertSnapshot(candidate, expected, label) {
  const actual = snapshotPath(candidate);
  if (!snapshotEqual(actual, expected)) {
    throw new Error(`${label} no longer matches its transaction identity.`);
  }
}

function snapshotEqual(left, right) {
  return isDeepStrictEqual(left, right);
}

function withJournalState(journal, state, authorization = journal.authorization) {
  if (!['swapping', 'installed', 'authorizing', 'committed', 'restored'].includes(state)) {
    throw new Error(`Generated-content journal state is invalid: ${state}.`);
  }
  return Object.freeze({ ...journal, state, authorization });
}

function writeJournal(repoRoot, journal) {
  validateJournal(journal);
  const journalPath = path.join(requirePrivateRunRoot(repoRoot), JOURNAL_FILENAME);
  const temporary = `${journalPath}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(journal)}\n`);
  if (bytes.length > MAX_JOURNAL_BYTES) throw new Error('Generated-content journal is too large.');
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, journalPath);
    syncDirectory(path.dirname(journalPath));
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') throw cleanupError;
    }
    throw error;
  }
}

function readJournal(repoRoot, { required }) {
  const journalPath = path.join(requirePrivateRunRoot(repoRoot), JOURNAL_FILENAME);
  let entry;
  try {
    entry = fs.lstatSync(journalPath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return null;
    throw error;
  }
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1n ||
    entry.size > MAX_JOURNAL_BYTES
  ) {
    throw new Error('Generated-content journal metadata is unsafe.');
  }
  const bytes = fs.readFileSync(journalPath);
  const after = fs.lstatSync(journalPath, { bigint: true });
  if (!sameFileSnapshot(entry, after) || after.size !== BigInt(bytes.length)) {
    throw new Error('Generated-content journal changed while it was read.');
  }
  const journal = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  validateJournal(journal);
  return journal;
}

function validateJournal(journal) {
  if (
    !journal ||
    typeof journal !== 'object' ||
    Array.isArray(journal) ||
    !isDeepStrictEqual(Object.keys(journal).sort(), [
      'attestation',
      'authorization',
      'entries',
      'id',
      'kind',
      'schemaVersion',
      'state',
      'transactionRoot',
    ]) ||
    journal.schemaVersion !== TRANSACTION_SCHEMA_VERSION ||
    journal.kind !== TRANSACTION_KIND ||
    !/^[a-f0-9-]{36}$/iu.test(journal.id) ||
    !['prepared', 'swapping', 'installed', 'authorizing', 'committed', 'restored'].includes(
      journal.state,
    ) ||
    !Array.isArray(journal.entries) ||
    journal.entries.length !== GENERATED_OUTPUT_PATHS.length
  ) {
    throw new Error('Generated-content journal contract is invalid.');
  }
  if (journal.attestation === null) {
    if (journal.authorization !== null || ['installed', 'authorizing'].includes(journal.state)) {
      throw new Error('Generated-content standalone journal has an invalid attestation state.');
    }
  } else {
    if (
      !journal.attestation ||
      typeof journal.attestation !== 'object' ||
      Array.isArray(journal.attestation) ||
      !isDeepStrictEqual(Object.keys(journal.attestation).sort(), ['original', 'relativePath']) ||
      journal.attestation.relativePath !== SOURCE_ATTESTATION_RELATIVE
    ) {
      throw new Error('Generated-content journal attestation is invalid.');
    }
    validateSnapshot(journal.attestation.original);
    if (['prepared', 'swapping', 'installed'].includes(journal.state)) {
      if (journal.authorization !== null) {
        throw new Error('Generated-content journal authorized too early.');
      }
    } else if (journal.state === 'restored') {
      if (journal.authorization !== null) validateAuthorization(journal.authorization);
    } else {
      validateAuthorization(journal.authorization);
    }
  }
  for (let index = 0; index < journal.entries.length; index += 1) {
    const entry = journal.entries[index];
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !isDeepStrictEqual(Object.keys(entry).sort(), [
        'index',
        'original',
        'relativePath',
        'staged',
      ]) ||
      entry.index !== index ||
      entry.relativePath !== GENERATED_OUTPUT_PATHS[index]
    ) {
      throw new Error('Generated-content journal entry is invalid.');
    }
    validateSnapshot(entry.original);
    validateSnapshot(entry.staged);
    if (entry.staged.kind === 'absent')
      throw new Error('Generated-content staged identity is absent.');
  }
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Generated-content snapshot identity is invalid.');
  }
  if (snapshot.kind === 'absent') {
    if (!isDeepStrictEqual(Object.keys(snapshot), ['kind'])) {
      throw new Error('Generated-content absent identity fields are invalid.');
    }
    return;
  }
  if (
    !['file', 'directory'].includes(snapshot.kind) ||
    !isDeepStrictEqual(Object.keys(snapshot).sort(), ['dev', 'digest', 'ino', 'kind']) ||
    !/^\d+$/u.test(snapshot.dev) ||
    !/^\d+$/u.test(snapshot.ino) ||
    !/^[a-f0-9]{64}$/u.test(snapshot.digest)
  ) {
    throw new Error('Generated-content snapshot identity fields are invalid.');
  }
}

function finalizeCommittedTransaction(repoRoot, journal) {
  let transactionRoot;
  try {
    transactionRoot = requireOwnedTransactionRoot(
      requirePrivateRunRoot(repoRoot),
      journal.transactionRoot,
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (transactionRoot !== undefined) removeOwnedTransactionRoot(repoRoot, transactionRoot);
  removeJournal(repoRoot);
}

function removeJournal(repoRoot) {
  const journalPath = path.join(requirePrivateRunRoot(repoRoot), JOURNAL_FILENAME);
  try {
    fs.unlinkSync(journalPath);
    syncDirectory(path.dirname(journalPath));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function journalExists(repoRoot) {
  const runRoot = privateRunRootIfPresent(repoRoot);
  return runRoot !== null && fs.existsSync(path.join(runRoot, JOURNAL_FILENAME));
}

function removeOwnedTransactionRoot(repoRoot, transactionRoot) {
  const runRoot = requirePrivateRunRoot(repoRoot);
  const owned = requireOwnedTransactionRoot(runRoot, transactionRoot);
  snapshotPath(owned, {
    maxFiles: MAX_TRANSACTION_FILES,
    maxTotalBytes: MAX_TRANSACTION_TOTAL_BYTES,
  });
  fs.rmSync(owned, { recursive: true, force: false, maxRetries: 0 });
  syncDirectory(runRoot);
}

function requireOwnedTransactionRoot(runRoot, candidate) {
  const resolved = requireCanonicalChildDirectory(runRoot, candidate, 'generated transaction root');
  if (!path.basename(resolved).startsWith(TRANSACTION_PREFIX)) {
    throw new Error(`Generated transaction root has an unsafe name: ${resolved}.`);
  }
  const entry = fs.lstatSync(resolved);
  if ((entry.mode & 0o077) !== 0) {
    throw new Error(`Generated transaction root must be owner-only: ${resolved}.`);
  }
  return resolved;
}

function requirePrivateRunRoot(repoRoot) {
  const runRoot = path.join(repoRoot, '.run');
  const entry = fs.lstatSync(runRoot);
  if (!entry.isDirectory() || entry.isSymbolicLink() || fs.realpathSync(runRoot) !== runRoot) {
    throw new Error(`Wargr runtime must be a canonical directory: ${runRoot}.`);
  }
  if ((entry.mode & 0o022) !== 0) {
    throw new Error(`Wargr runtime must not be group- or world-writable: ${runRoot}.`);
  }
  return runRoot;
}

function privateRunRootIfPresent(repoRoot) {
  const runRoot = path.join(repoRoot, '.run');
  try {
    return requirePrivateRunRoot(repoRoot);
  } catch (error) {
    if (error?.code === 'ENOENT' && !fs.existsSync(runRoot)) return null;
    throw error;
  }
}

function ensurePrivateRunRoot(repoRoot) {
  const existing = privateRunRootIfPresent(repoRoot);
  if (existing !== null) return existing;
  const runRoot = path.join(repoRoot, '.run');
  fs.mkdirSync(runRoot, { mode: 0o700 });
  syncDirectory(repoRoot);
  return requirePrivateRunRoot(repoRoot);
}

function assertCanonicalTargetParent(repoRoot, candidate) {
  const parent = path.dirname(candidate);
  const existing = nearestExistingAncestor(parent);
  if (
    fs.realpathSync(existing) !== existing ||
    !isContained(repoRoot, existing, { allowEqual: true })
  ) {
    throw new Error(`Generated output parent is outside canonical Wargr source: ${parent}.`);
  }
}

function nearestExistingAncestor(candidate) {
  let current = candidate;
  for (;;) {
    try {
      const entry = fs.lstatSync(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Generated output ancestor is not a directory: ${current}.`);
      }
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function requireCanonicalChildDirectory(parent, candidate, label) {
  const root = requireCanonicalDirectory(parent, `${label} parent`);
  const resolved = requireCanonicalDirectory(candidate, label);
  if (!isContained(root, resolved)) throw new Error(`${label} must stay beneath ${root}.`);
  return resolved;
}

function requireCanonicalDirectory(candidate, label) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new TypeError(`${label} path must be absolute.`);
  }
  const resolved = path.resolve(candidate);
  const entry = fs.lstatSync(resolved);
  if (!entry.isDirectory() || entry.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error(`${label} must be a canonical directory: ${resolved}.`);
  }
  return resolved;
}

function requireCanonicalFile(candidate, label) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new TypeError(`${label} path must be absolute.`);
  }
  const resolved = path.resolve(candidate);
  const entry = fs.lstatSync(resolved, { bigint: true });
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1n ||
    fs.realpathSync(resolved) !== resolved
  ) {
    throw new Error(`${label} must be one canonical, unaliased file: ${resolved}.`);
  }
  return resolved;
}

function containedPath(parent, relative) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    path.posix.normalize(relative) !== relative ||
    relative.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error(`Generated output path is unsafe: ${String(relative)}.`);
  }
  const candidate = path.resolve(parent, relative);
  if (!isContained(parent, candidate)) throw new Error(`Generated output escapes ${parent}.`);
  return candidate;
}

function isContained(parent, candidate, { allowEqual = false } = {}) {
  const relative = path.relative(parent, candidate);
  return (
    (allowEqual && relative === '') ||
    (relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function setEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
