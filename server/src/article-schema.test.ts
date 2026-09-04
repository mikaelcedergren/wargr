import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ArticleValidationError,
  canonicalArticle,
  isArticleSlug,
  publishFormatProblems,
  validateArticleDocument,
  validateArticleRecord,
  type ArticleRecord,
} from './article-schema.js';

function draftRecord(overrides: Partial<ArticleRecord> = {}): ArticleRecord {
  return {
    body: 'Something honest.',
    createdAt: '2026-01-01T00:00:00.000Z',
    id: '00000000-0000-4000-8000-000000000000',
    imagePrompts: [],
    ingress: '',
    publishedAt: null,
    pullQuotes: [],
    revision: 1,
    slug: 'an-essay',
    socialPosts: [],
    state: 'draft',
    tags: [],
    title: 'An essay',
    topic: '',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

test('a raw draft validates with nothing but a title and body', () => {
  const record = validateArticleRecord(draftRecord());
  assert.equal(record.slug, 'an-essay');
  const canonical = canonicalArticle(record);
  assert.equal(canonical.sha256, canonicalArticle(record).sha256, 'hashing is deterministic');
});

test('reserved and malformed slugs are rejected', () => {
  for (const slug of ['studio', 'api', 'healthz', 'assets', 'Bad-Case', 'a--b', '-x', '']) {
    assert.equal(isArticleSlug(slug), false, slug);
  }
  assert.equal(isArticleSlug('focus-outward'), true);
});

test('publishing requires the complete editorial format', () => {
  const problems = publishFormatProblems(draftRecord());
  assert.ok(problems.some((problem) => problem.includes('ingress')));
  assert.ok(problems.some((problem) => problem.includes('tags')));
  assert.ok(problems.some((problem) => problem.includes('social posts')));
  assert.ok(problems.some((problem) => problem.includes('pull quotes')));
  assert.ok(problems.some((problem) => problem.includes('thumbnail prompts')));

  const complete = draftRecord({
    imagePrompts: ['Create a photograph.', 'Create a second one.', 'Create a third one.'],
    ingress:
      'An ingress that creates tension without revealing the conclusion of the essay at all.',
    pullQuotes: [
      { expansion: 'An expansion.', hook: 'A hook.' },
      { expansion: 'Another expansion.', hook: 'Another hook.' },
    ],
    socialPosts: ['One.', 'Two.', 'Three.'],
    tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
    topic: 'What the essay is really about.',
  });
  assert.deepEqual(publishFormatProblems(complete), []);
});

test('a published state requires its publish date of record', () => {
  assert.throws(
    () => validateArticleRecord(draftRecord({ state: 'published' })),
    ArticleValidationError,
  );
  const published = validateArticleRecord(
    draftRecord({ publishedAt: '2026-02-01', state: 'published' }),
  );
  assert.equal(published.publishedAt, '2026-02-01');
});

test('documents reject control characters, uppercase tags, and duplicate tags', () => {
  const base = {
    body: 'Body.',
    imagePrompts: [],
    ingress: '',
    pullQuotes: [],
    socialPosts: [],
    tags: [],
    title: 'Title',
    topic: '',
  };
  assert.throws(() => validateArticleDocument({ ...base, title: 'ab' }));
  assert.throws(() => validateArticleDocument({ ...base, tags: ['Fine'] }));
  assert.throws(() => validateArticleDocument({ ...base, tags: ['twice', 'twice'] }));
  assert.throws(() => validateArticleDocument({ ...base, tags: ['#tagged'] }));
  const valid = validateArticleDocument({ ...base, body: 'Line one.\nLine two.' });
  assert.equal(valid.body, 'Line one.\nLine two.');
});
