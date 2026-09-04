import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ArticleActivePolishError,
  ArticlePublishedDeleteError,
  ArticleRevisionConflictError,
  ArticleSlugConflictError,
  createWargrPersistence,
  polishInputSha256,
  type WargrPersistence,
} from './article-repository.js';
import { ARTICLE_MAX_VERSIONS_PER_ARTICLE, type ArticleRecord } from './article-schema.js';
import { buildArticlePolishJob } from './polish-jobs.js';

function openFixturePersistence(t: { after(fn: () => void): void }): WargrPersistence {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wargr-persistence-')));
  const dataDirectory = path.join(root, 'data');
  mkdirSync(dataDirectory, { mode: 0o700 });
  const persistence = createWargrPersistence({
    databasePath: path.join(dataDirectory, 'wargr.db'),
    operationalRoot: root,
  });
  // After-hooks run in registration order: the store closes before its directory disappears.
  t.after(() => persistence.close());
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return persistence;
}

let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

function record(slug: string, overrides: Partial<ArticleRecord> = {}): ArticleRecord {
  return {
    body: 'Something honest, however raw.',
    createdAt: '2026-01-01T00:00:00.000Z',
    id: nextUuid(),
    imagePrompts: [],
    ingress: '',
    publishedAt: null,
    pullQuotes: [],
    revision: 1,
    slug,
    socialPosts: [],
    state: 'draft',
    tags: [],
    title: 'An essay',
    topic: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('articles round-trip with revisions, slugs, and bounded version history', (t) => {
  const persistence = openFixturePersistence(t);
  const { articles } = persistence;

  const created = articles.create(record('first-essay'), 'author');
  assert.equal(created.revision, 1);
  assert.equal(articles.getBySlug('first-essay')?.record.id, created.record.id);
  assert.throws(() => articles.create(record('first-essay'), 'author'), ArticleSlugConflictError);

  const updated = articles.replaceDocument({
    expectedRevision: 1,
    id: created.record.id,
    record: { ...created.record, body: 'A second thought.', revision: 2 },
    versionSource: 'author',
  });
  assert.equal(updated.revision, 2);
  assert.throws(
    () =>
      articles.replaceDocument({
        expectedRevision: 1,
        id: created.record.id,
        record: { ...created.record, body: 'A stale write.', revision: 2 },
        versionSource: 'author',
      }),
    ArticleRevisionConflictError,
  );

  const versions = articles.listVersions(created.record.id, 10);
  assert.equal(versions.length, 2);
  assert.equal(versions[0]?.articleVersion, 2);
  const oldest = articles.getVersion(created.record.id, 1);
  assert.equal(oldest?.record.body, 'Something honest, however raw.');

  // The per-article history is a bounded ring: the oldest versions leave, the newest stay.
  let current = updated;
  for (let round = 0; round < ARTICLE_MAX_VERSIONS_PER_ARTICLE + 5; round += 1) {
    current = articles.replaceDocument({
      expectedRevision: current.revision,
      id: created.record.id,
      record: {
        ...current.record,
        body: `Round ${String(round)}.`,
        revision: current.revision + 1,
      },
      versionSource: 'author',
    });
  }
  const bounded = articles.listVersions(created.record.id, ARTICLE_MAX_VERSIONS_PER_ARTICLE);
  assert.equal(bounded.length, ARTICLE_MAX_VERSIONS_PER_ARTICLE);
});

test('publish and unpublish move state with the date of record, and deletion is guarded', (t) => {
  const persistence = openFixturePersistence(t);
  const { articles } = persistence;
  const created = articles.create(record('to-publish'), 'author');

  const published = articles.setState({
    expectedRevision: 1,
    id: created.record.id,
    publishedAt: '2026-02-01',
    record: {
      ...created.record,
      publishedAt: '2026-02-01',
      revision: 2,
      state: 'published',
    },
  });
  assert.equal(published.record.state, 'published');
  assert.throws(
    () => articles.delete(created.record.id, published.revision),
    ArticlePublishedDeleteError,
  );

  const unpublished = articles.setState({
    expectedRevision: 2,
    id: created.record.id,
    publishedAt: '2026-02-01',
    record: { ...published.record, revision: 3, state: 'draft' },
  });
  assert.equal(unpublished.record.state, 'draft');
  assert.equal(unpublished.record.publishedAt, '2026-02-01');
  assert.equal(articles.delete(created.record.id, unpublished.revision), true);
  assert.equal(articles.get(created.record.id), null);
});

test('a polish run is admitted once, finalises atomically, and survives author conflicts', async (t) => {
  const persistence = openFixturePersistence(t);
  const { articles, polish, polishAdmission } = persistence;
  const created = articles.create(record('to-polish'), 'author');

  const admit = (runId: string, expectedArticleRevision: number, inputSha256: string) =>
    polishAdmission.admit({
      now: Date.now(),
      policy: { maximumPolishes: 30, windowMs: 600_000 },
      run: {
        articleId: created.record.id,
        expectedArticleRevision,
        inputSha256,
        instruction: null,
        job: buildArticlePolishJob({
          articleId: created.record.id,
          expectedArticleRevision,
          inputSha256,
          mode: 'rough',
          runId,
        }),
        mode: 'rough',
        ownerSessionIdHash: 'a'.repeat(64),
        runId,
      },
    });

  const inputSha256 = polishInputSha256(created.record);
  const accepted = admit(nextUuid(), 1, inputSha256);
  assert.equal(accepted.status, 'accepted');
  if (accepted.status !== 'accepted') return;
  const run = accepted.run;
  assert.equal(run.state, 'queued');

  // A second concurrent run for the same essay is refused while the first is active.
  assert.throws(() => admit(nextUuid(), 1, inputSha256));

  const running = polish.transitionRun({
    expectedRevision: run.revision,
    runId: run.runId,
    state: 'running',
  });
  const result = polish.finalizeRun({
    expectedRunRevision: running.revision,
    outcome: {
      document: {
        body: 'The ghostwritten body.',
        imagePrompts: ['Create a photograph.', 'Create a second one.', 'Create a third one.'],
        ingress:
          'An ingress that creates tension without revealing the conclusion of the essay at all.',
        pullQuotes: [
          { expansion: 'An expansion.', hook: 'A hook.' },
          { expansion: 'Another expansion.', hook: 'Another hook.' },
        ],
        socialPosts: ['One.', 'Two.', 'Three.'],
        tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
        title: 'A ghostwritten title',
        topic: 'What the essay is really about.',
      },
      state: 'succeeded',
    },
    runId: run.runId,
  });
  assert.equal(result.finalizedRun.state, 'succeeded');
  assert.equal(result.article?.revision, 2);
  assert.equal(result.article?.record.body, 'The ghostwritten body.');
  const versions = articles.listVersions(created.record.id, 10);
  assert.equal(versions[0]?.source, 'polish');
  assert.equal(versions[0]?.polishRunId, run.runId);

  // A polish landing after the author kept editing fails cleanly instead of clobbering the edit.
  const stale = admit(nextUuid(), 2, polishInputSha256(result.article!.record));
  assert.equal(stale.status, 'accepted');
  if (stale.status !== 'accepted') return;
  const staleRunning = polish.transitionRun({
    expectedRevision: stale.run.revision,
    runId: stale.run.runId,
    state: 'running',
  });
  articles.replaceDocument({
    expectedRevision: 2,
    id: created.record.id,
    record: { ...result.article!.record, body: 'The author kept going.', revision: 3 },
    versionSource: 'author',
  });
  const conflicted = polish.finalizeRun({
    expectedRunRevision: staleRunning.revision,
    outcome: {
      document: { ...result.article!.record, body: 'A late polish result.' },
      state: 'succeeded',
    },
    runId: stale.run.runId,
  });
  assert.equal(conflicted.article, null);
  assert.equal(conflicted.finalizedRun.state, 'failed');
  assert.equal(conflicted.finalizedRun.errorCode, 'article_revision_conflict');
  assert.equal(articles.get(created.record.id)?.record.body, 'The author kept going.');

  // A terminal run history never blocks deleting a draft; an active one would.
  const again = admit(nextUuid(), 3, polishInputSha256(articles.get(created.record.id)!.record));
  assert.equal(again.status, 'accepted');
  assert.throws(() => articles.delete(created.record.id, 3), ArticleActivePolishError);
});

test('provider effects are replay-fenced receipts', (t) => {
  const persistence = openFixturePersistence(t);
  const { articles, polish, polishAdmission } = persistence;
  const created = articles.create(record('with-effects'), 'author');
  const inputSha256 = polishInputSha256(created.record);
  const runId = nextUuid();
  const accepted = polishAdmission.admit({
    now: Date.now(),
    policy: { maximumPolishes: 30, windowMs: 600_000 },
    run: {
      articleId: created.record.id,
      expectedArticleRevision: 1,
      inputSha256,
      instruction: null,
      job: buildArticlePolishJob({
        articleId: created.record.id,
        expectedArticleRevision: 1,
        inputSha256,
        mode: 'polish',
        runId,
      }),
      mode: 'polish',
      ownerSessionIdHash: 'b'.repeat(64),
      runId,
    },
  });
  assert.equal(accepted.status, 'accepted');

  const effect = polish.prepareEffect({
    effectId: 'c'.repeat(64),
    effectKey: 'article-polish:polish:attempt:1',
    operation: 'article-polish:polish',
    requestSha256: 'd'.repeat(64),
    runId,
  });
  assert.equal(effect.state, 'prepared');
  // Preparing the same effect again returns the identical receipt instead of a duplicate.
  const replayed = polish.prepareEffect({
    effectId: 'c'.repeat(64),
    effectKey: 'article-polish:polish:attempt:1',
    operation: 'article-polish:polish',
    requestSha256: 'd'.repeat(64),
    runId,
  });
  assert.equal(replayed.revision, effect.revision);

  const creating = polish.transitionEffect({
    effectId: effect.effectId,
    expectedRevision: effect.revision,
    state: 'creating',
  });
  const submitted = polish.transitionEffect({
    effectId: effect.effectId,
    expectedRevision: creating.revision,
    providerResponseId: 'resp_0123456789',
    state: 'submitted',
  });
  const succeeded = polish.transitionEffect({
    effectId: effect.effectId,
    expectedRevision: submitted.revision,
    response: { id: 'resp_0123456789', status: 'completed' },
    state: 'succeeded',
  });
  assert.equal(succeeded.state, 'succeeded');
  assert.deepEqual(succeeded.response, { id: 'resp_0123456789', status: 'completed' });
  // A terminal receipt refuses to move backwards.
  assert.throws(() =>
    polish.transitionEffect({
      effectId: effect.effectId,
      expectedRevision: succeeded.revision,
      state: 'creating',
    }),
  );
});

test('owner sessions persist, touch monotonically, and clear login failures', async (t) => {
  const persistence = openFixturePersistence(t);
  const { ownerAuth } = persistence;
  const clientKeyHash = 'e'.repeat(64);
  const sessionIdHash = 'f'.repeat(64);

  assert.deepEqual(await ownerAuth.readLoginThrottle(clientKeyHash, 1_000), {
    status: 'allowed',
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await ownerAuth.recordLoginFailure(clientKeyHash, 1_000 + attempt);
  }
  const blocked = await ownerAuth.readLoginThrottle(clientKeyHash, 1_010);
  assert.equal(blocked.status, 'rate_limited');

  const created = await ownerAuth.createSessionAndClearLoginFailures({
    clientKeyHash,
    session: {
      createdAt: 2_000,
      expiresAt: 30_000,
      lastSeenAt: 2_000,
      revision: 1,
      sessionIdHash,
    },
  });
  assert.equal(created, 'created');
  assert.deepEqual(await ownerAuth.readLoginThrottle(clientKeyHash, 2_001), {
    status: 'allowed',
  });

  const touched = await ownerAuth.touchSession({
    expectedRevision: 1,
    lastSeenAt: 2_500,
    sessionIdHash,
  });
  assert.equal(touched?.lastSeenAt, 2_500);
  assert.equal(await ownerAuth.deleteSession(sessionIdHash), true);
  assert.equal(await ownerAuth.findSession(sessionIdHash), null);
});
