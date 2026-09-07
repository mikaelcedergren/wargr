import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  parseLogRecord,
  runWithLogContext,
  type LogRecord,
} from '@mikaelcedergren/cx-framework/server/logging';
import { createWargrPersistence } from './article-repository.js';
import type { ArticleDocument, ArticleRecord } from './article-schema.js';
import { configureWargrLogging } from './logging.js';
import { createOpenAiResponsesProvider } from './openai-provider.js';
import { articlePolishSpec } from './polish-content.js';
import { createPolishService } from './polish-service.js';
import { createArticlePolishWorker } from './polish-worker.js';

test('polish traces admission, recovered provider polling and durable completion without essay content', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wargr-PRIVATE-polish-')));
  const records: LogRecord[] = [];
  const logger = configureWargrLogging('jobs', { NODE_ENV: 'test' }, 'fixture', {
    write(line) {
      records.push(parseLogRecord(line));
      return true;
    },
    status() {
      return { accepted: records.length, dropped: 0, failed: 0, pendingBytes: 0, available: true };
    },
  });
  const persistence = createWargrPersistence({
    executionScope: 'test',
    databasePath: path.join(root, 'database.sqlite'),
    operationalRoot: root,
  });
  t.after(() => {
    persistence.close();
    configureWargrLogging('operator', { NODE_ENV: 'test' });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const initial: ArticleRecord = {
    id: randomUUID(),
    title: 'PRIVATE working title',
    body: 'PRIVATE essay draft.',
    ingress: '',
    topic: '',
    imagePrompts: [],
    pullQuotes: [],
    socialPosts: [],
    tags: [],
    slug: 'synthetic-essay',
    state: 'draft',
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    publishedAt: null,
  };
  persistence.articles.create(initial, 'author');
  const document: ArticleDocument = {
    body: 'PRIVATE finished essay.',
    title: 'PRIVATE finished title',
    topic: 'PRIVATE topic',
    ingress:
      'An ingress that creates tension without revealing the conclusion of the synthetic essay at all.',
    tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
    socialPosts: ['One.', 'Two.', 'Three.'],
    pullQuotes: [
      { hook: 'A hook.', expansion: 'An expansion.' },
      { hook: 'Another hook.', expansion: 'Another expansion.' },
    ],
    imagePrompts: [
      'Create a photograph.',
      'Create a second photograph.',
      'Create a third photograph.',
    ],
  };
  const responses = [
    Response.json({ id: 'resp_PRIVATE_0001', status: 'queued' }),
    new Response('PRIVATE transient body', { status: 503 }),
    Response.json({
      id: 'resp_PRIVATE_0001',
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(document) }] },
      ],
    }),
  ];
  let calls = 0;
  const provider = createOpenAiResponsesProvider({
    apiKey: 'PRIVATE synthetic key',
    baseUrl: 'http://127.0.0.1:4545/v1',
    repository: persistence.polish,
    delay: async () => {},
    fetch: async () => {
      calls += 1;
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
  });
  const service = createPolishService({
    articles: persistence.articles,
    polish: persistence.polish,
    polishAdmission: persistence.polishAdmission,
    providerConfigured: true,
  });
  const accepted = await runWithLogContext({ requestId: 'synthetic-admission-0001' }, () =>
    service.startPolish({
      articleId: initial.id,
      expectedRevision: 1,
      instruction: null,
      mode: 'rough',
      ownerSessionIdHash: 'a'.repeat(64),
    }),
  );
  assert.ok('jobId' in accepted);
  const worker = createArticlePolishWorker({
    articles: persistence.articles,
    polish: persistence.polish,
    maintenance: persistence.polishMaintenance,
    provider,
    store: persistence.jobs,
  });
  assert.equal(
    await runWithLogContext({ requestId: 'unrelated-request-0002' }, () => worker.runUntilIdle()),
    1,
  );
  assert.equal(persistence.jobs.get(accepted.jobId)?.status, 'succeeded');
  assert.equal(persistence.articles.get(initial.id)?.record.body, document.body);
  const run = persistence.polish.getRunByJobId(accepted.jobId);
  assert.ok(run);
  assert.deepEqual(
    await runWithLogContext({ jobId: accepted.jobId, runId: 'synthetic-replay-attempt' }, () =>
      provider.generateStructured({
        runId: run.runId,
        signal: new AbortController().signal,
        spec: () => articlePolishSpec('rough', initial, null),
      }),
    ),
    document,
  );
  assert.equal(calls, 3);
  const admitted = records.find((record) => record.event === 'polish.admitted');
  const started = records.find((record) => record.event === 'job.started');
  const finished = records.filter((record) => record.event === 'provider.finished');
  assert.equal(admitted?.requestId, 'synthetic-admission-0001');
  assert.equal(admitted?.jobId, accepted.jobId);
  assert.equal(started?.jobId, accepted.jobId);
  assert.equal(started?.requestId, undefined);
  assert.ok(started?.runId);
  assert.equal(finished[0]?.runId, started?.runId);
  assert.equal(finished[0]?.jobId, accepted.jobId);
  assert.equal(finished[0]?.attempt, 3);
  assert.equal(finished[0]?.count, 1);
  assert.equal(finished[0]?.statusCode, 200);
  assert.equal(finished[1]?.code, 'DURABLE_REPLAY');
  assert.equal(finished[1]?.attempt, 0);
  assert.equal(finished[0]?.effectId, finished[1]?.effectId);
  assert.equal(records.filter((record) => record.event === 'polish.completed').length, 1);
  assert.equal(records.filter((record) => record.event === 'job.completed').length, 1);
  assert.equal(logger.status().invalid, 0);
  assert.doesNotMatch(
    JSON.stringify(records),
    /PRIVATE|resp_|127\.0\.0\.1|ownerSession|unrelated-request/u,
  );

  const admissionCount = records.filter((record) => record.event === 'polish.admitted').length;
  persistence.database.sqlite.execute(
    "CREATE TRIGGER synthetic_reject_polish BEFORE INSERT ON polish_runs BEGIN SELECT RAISE(ABORT, 'PRIVATE insert failure'); END",
  );
  try {
    await assert.rejects(
      service.startPolish({
        articleId: initial.id,
        expectedRevision: 2,
        instruction: null,
        mode: 'rough',
        ownerSessionIdHash: 'a'.repeat(64),
      }),
    );
    assert.equal(
      records.filter((record) => record.event === 'polish.admitted').length,
      admissionCount,
    );
  } finally {
    persistence.database.sqlite.execute('DROP TRIGGER synthetic_reject_polish');
  }
});
