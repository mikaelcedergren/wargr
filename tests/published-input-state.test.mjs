import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  capturePublishedInputDigest,
  readRecordedInputDigest,
  writeRecordedInputDigest,
} from '../scripts/published-input-state.mjs';

test('the publication digest binds the published closure and image bytes but ignores drafts', (t) => {
  const fixture = createFixture(t);
  const first = capturePublishedInputDigest(fixture);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(capturePublishedInputDigest(fixture), first, 'capture must be deterministic');

  // Draft activity — new rows outside the published state — must not change the digest.
  insertRow(fixture.databasePath, draftRow('a-new-draft'));
  assert.equal(capturePublishedInputDigest(fixture), first);

  // A same-size in-place image mutation must change the digest through its content hash.
  const master = path.join(fixture.imagesRoot, 'essay.png');
  const bytes = fs.readFileSync(master);
  const mutated = Buffer.from(bytes);
  mutated[mutated.length - 1] ^= 0xff;
  fs.writeFileSync(master, mutated);
  const afterImage = capturePublishedInputDigest(fixture);
  assert.notEqual(afterImage, first);

  // A changed published record — a new content hash for the same slug — must change the digest.
  replaceRow(fixture.databasePath, publishedRow('essay', { body: 'A revised published body.' }));
  const afterRecord = capturePublishedInputDigest(fixture);
  assert.notEqual(afterRecord, afterImage);

  // Publishing another essay changes the closure and therefore the digest.
  insertRow(fixture.databasePath, publishedRow('another'));
  fs.writeFileSync(path.join(fixture.imagesRoot, 'another.png'), 'png-two');
  assert.notEqual(capturePublishedInputDigest(fixture), afterRecord);
});

test('an empty published closure refuses to produce a digest', (t) => {
  const fixture = createFixture(t, { rows: [] });
  assert.throws(() => capturePublishedInputDigest(fixture), /at least one published essay/);
});

test('a published essay without its canonical image master fails closed', (t) => {
  const fixture = createFixture(t);
  fs.unlinkSync(path.join(fixture.imagesRoot, 'essay.png'));
  assert.throws(
    () => capturePublishedInputDigest(fixture),
    /article-images\/essay\.png is missing/,
  );
});

test('the recorded input state round-trips atomically at its one canonical path', (t) => {
  const fixture = createFixture(t);
  const statePath = path.join(fixture.repoRoot, '.run', 'published-input.json');
  assert.equal(readRecordedInputDigest({ repoRoot: fixture.repoRoot, statePath }), null);
  const digest = capturePublishedInputDigest(fixture);
  writeRecordedInputDigest({ repoRoot: fixture.repoRoot, statePath, digest });
  assert.equal(readRecordedInputDigest({ repoRoot: fixture.repoRoot, statePath }), digest);
  assert.throws(
    () =>
      writeRecordedInputDigest({
        repoRoot: fixture.repoRoot,
        statePath: path.join(fixture.repoRoot, '.run', 'elsewhere.json'),
        digest,
      }),
    /must be/,
  );
});

function createFixture(t, { rows } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wargr-input-state-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'wargr');
  const imagesRoot = path.join(repoRoot, 'article-images');
  const dataRoot = path.join(repoRoot, 'data');
  fs.mkdirSync(path.join(repoRoot, '.run'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(imagesRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const databasePath = path.join(dataRoot, 'wargr.db');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(
      `CREATE TABLE articles (
         slug TEXT NOT NULL,
         state TEXT NOT NULL,
         published_at TEXT,
         updated_at TEXT NOT NULL,
         record_sha256 TEXT NOT NULL,
         record_json BLOB NOT NULL
       )`,
    );
  } finally {
    database.close();
  }
  for (const row of rows ?? [publishedRow('essay')]) insertRow(databasePath, row);
  if ((rows ?? [publishedRow('essay')]).length > 0) {
    fs.writeFileSync(path.join(imagesRoot, 'essay.png'), 'png-bytes');
  }
  return { databasePath, imagesRoot, repoRoot };
}

function publishedRow(slug, overrides = {}) {
  const record = {
    body: 'A body honest enough to publish.',
    createdAt: '2026-01-01T00:00:00.000Z',
    id: '00000000-0000-4000-8000-000000000000',
    imagePrompts: ['Create a photograph.', 'Create a second photograph.', 'Create a third one.'],
    ingress: 'An ingress that creates tension without revealing the conclusion of anything at all.',
    publishedAt: '2026-01-02',
    pullQuotes: [{ expansion: 'An expansion.', hook: 'A hook.' }],
    revision: 1,
    slug,
    socialPosts: ['One.', 'Two.', 'Three.'],
    state: 'published',
    tags: ['one', 'two'],
    title: 'Essay',
    topic: 'What the essay is really about.',
    updatedAt: '2026-01-03T00:00:00.000Z',
    ...overrides,
  };
  const bytes = Buffer.from(JSON.stringify(record), 'utf8');
  return {
    published_at: record.publishedAt,
    record_json: bytes,
    record_sha256: createHash('sha256').update(bytes).digest('hex'),
    slug,
    state: record.state,
    updated_at: record.updatedAt,
  };
}

function draftRow(slug) {
  const row = publishedRow(slug, { publishedAt: null, state: 'draft' });
  return { ...row, published_at: null, state: 'draft' };
}

function insertRow(databasePath, row) {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO articles (slug, state, published_at, updated_at, record_sha256, record_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.slug,
        row.state,
        row.published_at,
        row.updated_at,
        row.record_sha256,
        row.record_json,
      );
  } finally {
    database.close();
  }
}

function replaceRow(databasePath, row) {
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare(`DELETE FROM articles WHERE slug = ?`).run(row.slug);
  } finally {
    database.close();
  }
  insertRow(databasePath, row);
}
