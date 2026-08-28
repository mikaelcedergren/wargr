#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { preflightPublishedEssayInventory } from './article-slugs.mjs';

const MAX_INPUT_FILES = 2_048;
const MAX_INPUT_DIRECTORY_ENTRIES = 16_384;
const MAX_INPUT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_INPUT_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const STATE_SCHEMA_VERSION = 1;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const toolRepoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = path.resolve(process.env.WARGR_REPO_ROOT ?? toolRepoRoot);
const ghostwriterRoot = path.resolve(
  process.env.WARGR_GHOSTWRITER_ROOT ?? path.resolve(repoRoot, '..', 'ghostwriter'),
);
const essaysRoot = path.join(ghostwriterRoot, 'wargr');
const imagesRoot = path.join(repoRoot, 'article-images');
const statePath = path.join(repoRoot, '.run', 'ghostwriter-input.json');

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
    throw new TypeError('Ghostwriter input-state arguments must be strings.');
  }
  if (argv.length === 1 && argv[0] === 'capture') {
    process.stdout.write(
      `${captureGhostwriterInputDigest({ ghostwriterRoot, essaysRoot, imagesRoot })}\n`,
    );
    return;
  }
  if (argv.length === 2 && argv[0] === 'matches') {
    assertDigest(argv[1]);
    process.exitCode = readRecordedInputDigest({ repoRoot, statePath }) === argv[1] ? 0 : 1;
    return;
  }
  if (argv.length === 2 && argv[0] === 'record') {
    writeRecordedInputDigest({ repoRoot, statePath, digest: argv[1] });
    return;
  }
  throw new Error(
    'Usage: ghostwriter-input-state.mjs capture | matches <sha256> | record <sha256>',
  );
}

export function captureGhostwriterInputDigest({ ghostwriterRoot, essaysRoot, imagesRoot }) {
  const canonicalGhostwriter = requireCanonicalDirectory(ghostwriterRoot, 'Ghostwriter repository');
  const canonicalEssays = requireCanonicalChildDirectory(
    canonicalGhostwriter,
    essaysRoot,
    'Ghostwriter Wargr essays',
  );
  const canonicalImages = requireCanonicalDirectory(imagesRoot, 'Wargr article-image masters');
  // Fail before state comparison or any later publisher mutation when URL/image identity is empty
  // or ambiguous. Image preparation, article import, and route generation use the same authority.
  preflightPublishedEssayInventory({
    essaysRoot: canonicalEssays,
    imagesRoot: canonicalImages,
  });
  const head = captureGitHead(canonicalGhostwriter);
  const hash = createHash('sha256');
  hash.update('cx-wargr-input-v1\0');
  const budget = { files: 0, totalBytes: 0 };
  const inventories = [
    inventorySelectedFiles({
      root: canonicalEssays,
      label: 'ghostwriter/wargr',
      include: (name) => name.endsWith('.md') && name.trimStart().startsWith('☑'),
      budget,
      history: (name) => capturePublishedHistory(canonicalGhostwriter, head, name),
    }),
    inventorySelectedFiles({
      root: canonicalImages,
      label: 'article-images',
      include: (name) => name.endsWith('.png'),
      budget,
    }),
  ];
  const files = inventories
    .flatMap((inventory) =>
      inventory.files.map((file) => ({ ...file, history: inventory.history })),
    )
    .sort((left, right) => Buffer.compare(left.sortKey, right.sortKey));
  for (const file of files) {
    const digest = hashStableFile(file.absolutePath, file.snapshot, file.relativePath);
    const mtimeNs = Buffer.from(file.snapshot.mtimeNs.toString());
    const history = file.history(file.name);
    hash.update(`${file.sortKey.length}:`);
    hash.update(file.sortKey);
    hash.update(`\0${file.size}:`);
    hash.update(digest);
    hash.update(`\0${mtimeNs.length}:`);
    hash.update(mtimeNs);
    hash.update(`\0${history.length}:`);
    hash.update(history);
    hash.update('\0');
  }
  for (const file of files) {
    assertFileSnapshot(file.absolutePath, file.snapshot, file.relativePath);
  }
  for (const inventory of inventories) {
    const namesAfter = selectedNames(inventory.root, inventory.include, inventory.label);
    if (!bufferArraysEqual(inventory.names, namesAfter)) {
      throw new Error(`${inventory.label} input inventory changed while it was captured.`);
    }
  }
  if (captureGitHead(canonicalGhostwriter) !== head) {
    throw new Error('Ghostwriter Git revision changed while publication inputs were captured.');
  }
  return hash.digest('hex');
}

export function readRecordedInputDigest({ repoRoot, statePath }) {
  const resolved = resolveStatePath(repoRoot, statePath);
  const entry = lstatIfPresent(resolved);
  if (entry === null) return null;
  if (fs.realpathSync(resolved) !== resolved) {
    throw new Error(`Ghostwriter input state must not traverse symbolic links: ${resolved}.`);
  }
  const value = JSON.parse(readStableFile(resolved, 4_096, 'Ghostwriter input state'));
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), ['digest', 'schemaVersion']) ||
    value.schemaVersion !== STATE_SCHEMA_VERSION
  ) {
    throw new Error('Ghostwriter input state must contain exactly schemaVersion 1 and digest.');
  }
  assertDigest(value.digest);
  return value.digest;
}

export function writeRecordedInputDigest({ repoRoot, statePath, digest }) {
  assertDigest(digest);
  const resolved = resolveStatePath(repoRoot, statePath);
  const existing = lstatIfPresent(resolved);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
    throw new Error(`Ghostwriter input state must be one regular, unaliased file: ${resolved}.`);
  }
  const parent = path.dirname(resolved);
  const temporary = path.join(parent, `.ghostwriter-input-${randomUUID()}.tmp`);
  const bytes = Buffer.from(
    `${JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, digest }, null, 2)}\n`,
  );
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
    fs.renameSync(temporary, resolved);
    syncDirectory(parent);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    removeFileIfPresent(temporary);
    throw error;
  }
  if (readRecordedInputDigest({ repoRoot, statePath }) !== digest) {
    throw new Error('Ghostwriter input state changed while it was recorded.');
  }
}

function inventorySelectedFiles({ root, label, include, budget, history = () => Buffer.alloc(0) }) {
  const names = selectedNames(root, include, label);
  budget.files += names.length;
  if (!Number.isSafeInteger(budget.files) || budget.files > MAX_INPUT_FILES) {
    throw new Error(`Ghostwriter publication input exceeds ${MAX_INPUT_FILES} files.`);
  }
  const files = names.map((nameBytes) => {
    const name = decodeUtf8(nameBytes, `${label} filename`);
    const absolutePath = path.join(root, name);
    const relativePath = `${label}/${name}`;
    const snapshot = requireStableInputFile(absolutePath, relativePath);
    const size = Number(snapshot.size);
    budget.totalBytes += size;
    if (!Number.isSafeInteger(budget.totalBytes) || budget.totalBytes > MAX_INPUT_TOTAL_BYTES) {
      throw new Error(
        `Ghostwriter publication input exceeds ${MAX_INPUT_TOTAL_BYTES} total bytes.`,
      );
    }
    return Object.freeze({
      absolutePath,
      name,
      relativePath,
      snapshot,
      size,
      sortKey: Buffer.from(relativePath),
    });
  });
  return Object.freeze({ files, history, include, label, names, root });
}

function selectedNames(root, include, label) {
  const directory = fs.opendirSync(root, { encoding: 'buffer', bufferSize: 32 });
  const names = [];
  let entries = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      entries += 1;
      if (entries > MAX_INPUT_DIRECTORY_ENTRIES) {
        throw new Error(`${label} input directory exceeds ${MAX_INPUT_DIRECTORY_ENTRIES} entries.`);
      }
      const nameBytes = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
      if (include(decodeUtf8(nameBytes, 'publication input filename'))) names.push(nameBytes);
      if (names.length > MAX_INPUT_FILES) {
        throw new Error(`Ghostwriter publication input exceeds ${MAX_INPUT_FILES} files.`);
      }
    }
  } finally {
    directory.closeSync();
  }
  return names.sort(Buffer.compare);
}

function requireStableInputFile(filePath, label) {
  const snapshot = fs.lstatSync(filePath, { bigint: true });
  if (!snapshot.isFile() || snapshot.isSymbolicLink() || snapshot.nlink !== 1n) {
    throw new Error(`Publication input must be one regular, unaliased file: ${label}.`);
  }
  if (snapshot.size > BigInt(MAX_INPUT_FILE_BYTES)) {
    throw new Error(`Publication input exceeds ${MAX_INPUT_FILE_BYTES} bytes: ${label}.`);
  }
  if (fs.realpathSync(filePath) !== filePath) {
    throw new Error(`Publication input must not traverse symbolic links: ${label}.`);
  }
  return snapshot;
}

function hashStableFile(filePath, snapshot, label) {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  const hash = createHash('sha256');
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(snapshot, before)) {
      throw new Error(`Publication input changed before it was read: ${label}.`);
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < Number(before.size)) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - position),
        position,
      );
      if (bytesRead <= 0) throw new Error(`Publication input ended while it was read: ${label}.`);
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(before, after)) {
      throw new Error(`Publication input changed while it was read: ${label}.`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest();
}

function assertFileSnapshot(filePath, expected, label) {
  const current = fs.lstatSync(filePath, { bigint: true });
  if (!sameFileSnapshot(expected, current)) {
    throw new Error(`Publication input changed before capture completed: ${label}.`);
  }
}

function capturePublishedHistory(repository, head, filename) {
  const result = spawnSync(
    'git',
    ['--no-pager', 'log', '--follow', '--format=%H%x00%cI', head, '--', `wargr/${filename}`],
    {
      cwd: repository,
      encoding: 'buffer',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    },
  );
  if (result.error)
    throw new Error(`Could not capture Ghostwriter history: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      decodeUtf8(result.stderr, 'Ghostwriter Git history error').trim() ||
        `Ghostwriter history failed with status ${result.status}.`,
    );
  }
  return Buffer.from(result.stdout);
}

function captureGitHead(repository) {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 1_024 * 1_024,
  });
  if (result.error)
    throw new Error(`Could not capture Ghostwriter revision: ${result.error.message}`);
  const revision = result.stdout.trim();
  if (result.status !== 0 || !/^[a-f0-9]{40,64}$/.test(revision)) {
    throw new Error(
      result.stderr.trim() || 'Ghostwriter repository has no canonical HEAD revision.',
    );
  }
  return revision;
}

function readStableFile(filePath, maxBytes, label) {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) {
      throw new Error(`${label} must be one bounded regular, unaliased file: ${filePath}.`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      bytes.length > maxBytes ||
      after.size !== BigInt(bytes.length) ||
      !sameFileSnapshot(before, after)
    ) {
      throw new Error(`${label} changed while it was read: ${filePath}.`);
    }
    return decodeUtf8(bytes, label);
  } finally {
    fs.closeSync(descriptor);
  }
}

function resolveStatePath(candidateRepo, candidateState) {
  const canonicalRepo = requireCanonicalDirectory(candidateRepo, 'Wargr repository');
  const runtime = requireCanonicalChildDirectory(
    canonicalRepo,
    path.join(canonicalRepo, '.run'),
    'Wargr runtime',
  );
  const resolved = path.resolve(candidateState);
  if (resolved !== path.join(runtime, 'ghostwriter-input.json')) {
    throw new Error(
      `Ghostwriter input state must be ${path.join(runtime, 'ghostwriter-input.json')}.`,
    );
  }
  return resolved;
}

function requireCanonicalChildDirectory(parent, candidate, label) {
  const resolved = requireCanonicalDirectory(candidate, label);
  const relative = path.relative(parent, resolved);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must stay inside ${parent}.`);
  }
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

function assertDigest(value) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error('Ghostwriter input digest must be a lowercase SHA-256 digest.');
  }
}

function decodeUtf8(value, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value ?? Buffer.alloc(0));
  } catch (error) {
    throw new Error(
      `${label} is not valid UTF-8.`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function bufferArraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value.equals(right[index]));
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

function lstatIfPresent(candidate) {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeFileIfPresent(candidate) {
  try {
    fs.unlinkSync(candidate);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
