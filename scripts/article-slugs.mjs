import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_PUBLISHED_ARTICLES = 2_048;
const MAX_RECORD_BYTES = 1024 * 1024;
const RESERVED_ARTICLE_SLUGS = new Set(['api', 'assets', 'healthz', 'studio']);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PUBLISHED_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/u;

export function isValidArticleSlug(slug) {
  return (
    typeof slug === 'string' &&
    slug.length >= 1 &&
    slug.length <= 80 &&
    SLUG_PATTERN.test(slug) &&
    !RESERVED_ARTICLE_SLUGS.has(slug)
  );
}

/**
 * The one slug and inventory authority for site generation. It reads the published closure from
 * the article database — the authoring source that replaced the retired ghostwriter repository —
 * verifies each stored record against its content hash, and requires the canonical PNG master for
 * every published essay. Image preparation, article generation, route generation, and the
 * publication input digest all consume this same exact identity set.
 */
export function preflightPublishedArticleInventory({ databasePath, imagesRoot }) {
  const images = requireCanonicalDirectory(imagesRoot, 'Wargr article-image masters');
  const rows = readPublishedRows(databasePath);
  if (rows.length === 0) {
    throw new Error('Wargr publication inventory must contain at least one published essay.');
  }
  if (rows.length > MAX_PUBLISHED_ARTICLES) {
    throw new Error(`Wargr publication exceeds ${MAX_PUBLISHED_ARTICLES} published essays.`);
  }

  const bySlug = new Map();
  const inventory = rows.map((row) => {
    const record = parsePublishedRecord(row);
    if (bySlug.has(record.slug)) {
      throw new Error(`Published essay slug collision for "${record.slug}".`);
    }
    bySlug.set(record.slug, record);
    const masterPath = path.join(images, `${record.slug}.png`);
    assertRegularUnaliasedFile(
      masterPath,
      `Canonical image master article-images/${record.slug}.png`,
    );
    return Object.freeze({ ...record, masterPath });
  });

  return Object.freeze(inventory.sort((left, right) => byteCompare(left.slug, right.slug)));
}

export function readPublishedRows(databasePath) {
  const resolved = requireCanonicalFile(databasePath, 'Wargr article database');
  const database = new DatabaseSync(resolved, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT slug, state, published_at, updated_at, record_sha256, record_json
         FROM articles
         WHERE state = 'published'
         ORDER BY slug
         LIMIT ${String(MAX_PUBLISHED_ARTICLES + 1)}`,
      )
      .all();
  } finally {
    database.close();
  }
}

function parsePublishedRecord(row) {
  if (!isValidArticleSlug(row.slug)) {
    throw new Error(`Published essay slug is invalid or reserved: ${String(row.slug)}`);
  }
  if (typeof row.record_sha256 !== 'string' || !SHA256_PATTERN.test(row.record_sha256)) {
    throw new Error(`Published essay ${row.slug} has an invalid stored record hash.`);
  }
  const bytes = Buffer.from(row.record_json);
  if (bytes.length < 2 || bytes.length > MAX_RECORD_BYTES) {
    throw new Error(`Published essay ${row.slug} has an out-of-bounds stored record.`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== row.record_sha256) {
    throw new Error(`Published essay ${row.slug} record hash does not match its stored bytes.`);
  }
  let record;
  try {
    record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`Published essay ${row.slug} record is not valid JSON.`, { cause: error });
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Published essay ${row.slug} record must be a JSON object.`);
  }
  if (record.slug !== row.slug || record.state !== 'published') {
    throw new Error(`Published essay ${row.slug} record does not mirror its row identity.`);
  }
  requireText(record.title, `Published essay ${row.slug} title`, 1);
  requireText(record.ingress, `Published essay ${row.slug} ingress`, 1);
  requireText(record.body, `Published essay ${row.slug} body`, 1);
  if (
    typeof record.publishedAt !== 'string' ||
    !PUBLISHED_AT_PATTERN.test(record.publishedAt) ||
    record.publishedAt !== row.published_at
  ) {
    throw new Error(`Published essay ${row.slug} has an invalid publish date of record.`);
  }
  if (typeof record.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt))) {
    throw new Error(`Published essay ${row.slug} has an invalid modified date.`);
  }
  if (
    !Array.isArray(record.tags) ||
    record.tags.length < 1 ||
    record.tags.some((tag) => typeof tag !== 'string' || !tag)
  ) {
    throw new Error(`Published essay ${row.slug} must carry its tags.`);
  }
  if (
    !Array.isArray(record.pullQuotes) ||
    record.pullQuotes.some(
      (quote) =>
        !quote ||
        typeof quote !== 'object' ||
        typeof quote.hook !== 'string' ||
        typeof quote.expansion !== 'string',
    )
  ) {
    throw new Error(`Published essay ${row.slug} pull quotes are invalid.`);
  }
  return Object.freeze({
    slug: row.slug,
    recordSha256: row.record_sha256,
    record: Object.freeze(record),
  });
}

function requireText(value, label, minimum) {
  if (typeof value !== 'string' || value.trim().length < minimum) {
    throw new Error(`${label} is missing.`);
  }
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

function requireCanonicalFile(candidate, label) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new TypeError(`${label} path must be absolute.`);
  }
  const resolved = path.resolve(candidate);
  const entry = fs.lstatSync(resolved);
  if (!entry.isFile() || entry.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error(`${label} must be one canonical database file: ${resolved}.`);
  }
  return resolved;
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
