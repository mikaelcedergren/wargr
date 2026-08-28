import fs from 'node:fs';
import path from 'node:path';

const MAX_ESSAY_DIRECTORY_ENTRIES = 16_384;
const MAX_PUBLISHED_ESSAYS = 2_048;
const RESERVED_ARTICLE_SLUGS = new Set(['api', 'assets', 'healthz']);

export function isPublishedEssayFilename(filename) {
  return (
    typeof filename === 'string' && filename.endsWith('.md') && filename.trimStart().startsWith('☑')
  );
}

export function normalizeArticleSlug(filename) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0')) {
    throw new Error('Published essay filename must be a non-empty string.');
  }
  const slug = filename
    .normalize('NFKD')
    .replace(/[☀-➿️]/gu, '')
    .toLowerCase()
    .replace(/\.md$/u, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
    throw new Error(`Published essay filename normalizes to an empty or unsafe slug: ${filename}`);
  }
  if (RESERVED_ARTICLE_SLUGS.has(slug)) {
    throw new Error(`Published essay filename normalizes to a reserved platform slug: ${slug}`);
  }
  return slug;
}

export function preflightPublishedEssayInventory({ essaysRoot, imagesRoot }) {
  const essays = requireCanonicalDirectory(essaysRoot, 'Ghostwriter Wargr essays');
  const images = requireCanonicalDirectory(imagesRoot, 'Wargr article-image masters');
  const entries = readBoundedDirectoryEntries(essays, {
    maxEntries: MAX_ESSAY_DIRECTORY_ENTRIES,
    label: 'Ghostwriter Wargr essays',
  });

  const published = entries
    .filter((entry) => isPublishedEssayFilename(entry.name))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Published essay must be one regular file: ${entry.name}`);
      }
      const slug = normalizeArticleSlug(entry.name);
      const essayPath = path.join(essays, entry.name);
      const masterPath = path.join(images, `${slug}.png`);
      assertRegularUnaliasedFile(essayPath, `Published essay ${entry.name}`);
      assertRegularUnaliasedFile(masterPath, `Canonical image master article-images/${slug}.png`);
      return Object.freeze({
        filename: entry.name,
        slug,
        essayPath,
        masterPath,
      });
    })
    .sort((left, right) => byteCompare(left.filename, right.filename));

  if (published.length === 0) {
    throw new Error('Ghostwriter Wargr publication inventory must contain at least one ☑ essay.');
  }
  if (published.length > MAX_PUBLISHED_ESSAYS) {
    throw new Error(`Ghostwriter Wargr publication exceeds ${MAX_PUBLISHED_ESSAYS} essays.`);
  }

  const bySlug = new Map();
  for (const entry of published) {
    const previous = bySlug.get(entry.slug);
    if (previous) {
      throw new Error(
        `Published essay slug collision for "${entry.slug}": ${previous.filename} and ${entry.filename}.`,
      );
    }
    bySlug.set(entry.slug, entry);
  }

  return Object.freeze(published);
}

function assertRegularUnaliasedFile(candidate, label) {
  let entry;
  try {
    entry = fs.lstatSync(candidate, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${label} is missing.`);
    }
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n) {
    throw new Error(`${label} must be one regular, unaliased file.`);
  }
  if (fs.realpathSync(candidate) !== candidate) {
    throw new Error(`${label} must not traverse symbolic links.`);
  }
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

function readBoundedDirectoryEntries(directory, { maxEntries, label }) {
  const before = fs.lstatSync(directory, { bigint: true });
  const entries = [];
  const handle = fs.opendirSync(directory);
  try {
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      entries.push(entry);
      if (entries.length > maxEntries) {
        throw new Error(`${label} exceed ${maxEntries} directory entries.`);
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
  if (!sameDirectorySnapshot(before, after)) {
    throw new Error(`${label} changed during bounded inventory preflight.`);
  }
  return entries;
}

function sameDirectorySnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.isDirectory() &&
    right.isDirectory() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink()
  );
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
