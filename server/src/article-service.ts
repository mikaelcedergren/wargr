import { randomUUID } from 'node:crypto';

import { HttpError } from '@mikaelcedergren/cx-framework/server/errors';

import {
  ArticleActivePolishError,
  ArticleCapacityError,
  ArticlePublishedDeleteError,
  ArticleRevisionConflictError,
  ArticleSlugConflictError,
  type ArticleRepository,
  type StoredArticle,
} from './article-repository.js';
import {
  ArticleValidationError,
  MAX_SLUG_CHARACTERS,
  MAX_TITLE_CHARACTERS,
  isArticleId,
  isArticleSlug,
  publishFormatProblems,
  validateArticleDocument,
  type ArticleDocument,
  type ArticleRecord,
} from './article-schema.js';
import type {
  ArticleDto,
  ArticleMutationResult,
  ArticleService,
  ArticleSummaryDto,
  ArticleVersionDto,
  ArticleVersionSummaryDto,
  UpdateArticleInput,
} from './http-contracts.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_SLUG_ATTEMPTS = 50;
const VERSION_LISTING_LIMIT = 100;

export interface CreateArticleServiceOptions {
  readonly articles: ArticleRepository;
  readonly clock?: () => number;
  readonly createUuid?: () => string;
}

export function createArticleService({
  articles,
  clock = Date.now,
  createUuid = randomUUID,
}: CreateArticleServiceOptions): ArticleService {
  const service: ArticleService = {
    async createArticle({ title }) {
      const safeTitle = requiredTitle(title);
      const now = checkedClock(clock);
      const timestamp = canonicalTimestamp(now);
      const record: ArticleRecord = Object.freeze({
        body: '',
        createdAt: timestamp,
        id: uuid(createUuid),
        imagePrompts: Object.freeze([]),
        ingress: '',
        publishedAt: null,
        pullQuotes: Object.freeze([]),
        revision: 1,
        slug: availableSlug(articles, slugify(safeTitle)),
        socialPosts: Object.freeze([]),
        state: 'draft',
        tags: Object.freeze([]),
        title: safeTitle,
        topic: '',
        updatedAt: timestamp,
      });
      try {
        return articleDto(articles.create(record, 'author'));
      } catch (error) {
        throw articleMutationError(error);
      }
    },

    async deleteArticle({ expectedRevision, id }) {
      if (!isArticleId(id)) return notFound();
      try {
        const deleted = articles.delete(id, expectedRevision);
        return deleted ? Object.freeze({ status: 'deleted' as const }) : notFound();
      } catch (error) {
        if (error instanceof ArticleRevisionConflictError) {
          return currentRevisionResult(articles, id);
        }
        throw articleMutationError(error);
      }
    },

    async getArticle(id) {
      if (!isArticleId(id)) return null;
      const stored = articles.get(id);
      return stored ? articleDto(stored) : null;
    },

    async getVersion(id, articleVersion) {
      if (!isArticleId(id) || !Number.isSafeInteger(articleVersion) || articleVersion < 1) {
        return null;
      }
      const version = articles.getVersion(id, articleVersion);
      if (!version) return null;
      return Object.freeze({
        articleVersion: version.articleVersion,
        createdAt: canonicalTimestamp(version.createdAt),
        document: documentOf(version.record),
        polishRunId: version.polishRunId,
        source: version.source,
      });
    },

    async listArticles(): Promise<readonly ArticleSummaryDto[]> {
      return articles.list();
    },

    async listVersions(id): Promise<readonly ArticleVersionSummaryDto[]> {
      if (!isArticleId(id)) return Object.freeze([]);
      return Object.freeze(
        articles.listVersions(id, VERSION_LISTING_LIMIT).map((version) =>
          Object.freeze({
            articleVersion: version.articleVersion,
            createdAt: canonicalTimestamp(version.createdAt),
            polishRunId: version.polishRunId,
            source: version.source,
          }),
        ),
      );
    },

    async publishArticle({ expectedRevision, id }) {
      if (!isArticleId(id)) return notFound();
      const stored = articles.get(id);
      if (!stored) return notFound();
      if (stored.revision !== expectedRevision) return revisionConflict(stored.revision);
      const problems = publishFormatProblems(stored.record);
      if (problems.length > 0) {
        throw new HttpError({
          code: 'publish_format_incomplete',
          details: { problems: [...problems] },
          message: 'The essay does not meet the publish format yet.',
          status: 422,
        });
      }
      const publishedAt = stored.record.publishedAt ?? dateOnly(checkedClock(clock));
      return applyStateChange(articles, stored, expectedRevision, clock, {
        publishedAt,
        state: 'published',
      });
    },

    async unpublishArticle({ expectedRevision, id }) {
      if (!isArticleId(id)) return notFound();
      const stored = articles.get(id);
      if (!stored) return notFound();
      if (stored.revision !== expectedRevision) return revisionConflict(stored.revision);
      return applyStateChange(articles, stored, expectedRevision, clock, {
        publishedAt: stored.record.publishedAt,
        state: 'draft',
      });
    },

    async updateArticle(input) {
      if (!isArticleId(input.id)) return notFound();
      const stored = articles.get(input.id);
      if (!stored) return notFound();
      if (stored.revision !== input.expectedRevision) return revisionConflict(stored.revision);
      const document = safeDocument(input.document);
      const slug = requestedSlug(input, stored);
      const now = checkedClock(clock);
      const record: ArticleRecord = Object.freeze({
        ...stored.record,
        ...document,
        revision: stored.revision + 1,
        slug,
        updatedAt: canonicalTimestamp(now),
      });
      try {
        return articleDto(
          articles.replaceDocument({
            expectedRevision: input.expectedRevision,
            id: input.id,
            record,
            versionSource: 'author',
          }),
        );
      } catch (error) {
        if (error instanceof ArticleRevisionConflictError) {
          return currentRevisionResult(articles, input.id);
        }
        throw articleMutationError(error);
      }
    },
  };
  return Object.freeze(service);
}

export function articleDto(stored: StoredArticle): ArticleDto {
  return Object.freeze({
    body: stored.record.body,
    createdAt: stored.record.createdAt,
    id: stored.record.id,
    imagePrompts: stored.record.imagePrompts,
    ingress: stored.record.ingress,
    publishedAt: stored.record.publishedAt,
    pullQuotes: stored.record.pullQuotes,
    revision: stored.revision,
    slug: stored.record.slug,
    socialPosts: stored.record.socialPosts,
    state: stored.record.state,
    tags: stored.record.tags,
    title: stored.record.title,
    topic: stored.record.topic,
    updatedAt: stored.record.updatedAt,
  });
}

export function slugify(title: string): string {
  const normalized = title
    .toLocaleLowerCase('en-GB')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_SLUG_CHARACTERS)
    .replace(/^-+|-+$/gu, '');
  return isArticleSlug(normalized) ? normalized : 'untitled';
}

function availableSlug(articles: ArticleRepository, base: string): string {
  if (!articles.getBySlug(base)) return base;
  for (let suffix = 2; suffix <= MAX_SLUG_ATTEMPTS; suffix += 1) {
    const candidate = `${base.slice(0, MAX_SLUG_CHARACTERS - String(suffix).length - 1)}-${String(suffix)}`;
    if (isArticleSlug(candidate) && !articles.getBySlug(candidate)) return candidate;
  }
  throw new HttpError({
    code: 'slug_unavailable',
    message: 'No available slug could be derived from that title.',
    status: 409,
  });
}

function requestedSlug(input: UpdateArticleInput, stored: StoredArticle): string {
  if (input.slug === undefined) return stored.record.slug;
  if (!isArticleSlug(input.slug)) {
    throw new HttpError({
      code: 'invalid_slug',
      message:
        'The slug must be lowercase words separated by single hyphens, outside the reserved platform routes.',
      status: 400,
    });
  }
  if (stored.record.state === 'published' && input.slug !== stored.record.slug) {
    throw new HttpError({
      code: 'published_slug_frozen',
      message: 'A published essay keeps its slug. Unpublish it first to change the address.',
      status: 409,
    });
  }
  return input.slug;
}

function applyStateChange(
  articles: ArticleRepository,
  stored: StoredArticle,
  expectedRevision: number,
  clock: () => number,
  change: { readonly publishedAt: string | null; readonly state: 'draft' | 'published' },
): ArticleMutationResult<ArticleDto> {
  const record: ArticleRecord = Object.freeze({
    ...stored.record,
    publishedAt: change.publishedAt,
    revision: stored.revision + 1,
    state: change.state,
    updatedAt: canonicalTimestamp(checkedClock(clock)),
  });
  try {
    return articleDto(
      articles.setState({
        expectedRevision,
        id: stored.record.id,
        publishedAt: change.publishedAt,
        record,
      }),
    );
  } catch (error) {
    if (error instanceof ArticleRevisionConflictError) {
      return currentRevisionResult(articles, stored.record.id);
    }
    throw articleMutationError(error);
  }
}

function safeDocument(value: unknown): ArticleDocument {
  try {
    return validateArticleDocument(value);
  } catch (error) {
    if (error instanceof ArticleValidationError) {
      throw new HttpError({
        code: 'invalid_article_document',
        message: error.message,
        status: 400,
      });
    }
    throw error;
  }
}

function articleMutationError(error: unknown): unknown {
  if (error instanceof ArticleSlugConflictError) {
    return new HttpError({
      code: 'slug_conflict',
      message: 'Another essay already uses that slug.',
      status: 409,
    });
  }
  if (error instanceof ArticleCapacityError) {
    return new HttpError({
      code: 'article_capacity_reached',
      message: 'Article storage is full. Delete an essay before creating another.',
      status: 503,
    });
  }
  if (error instanceof ArticleActivePolishError) {
    return new HttpError({
      code: 'article_polish_active',
      message: 'A polish is still running for this essay. Wait for it to finish.',
      status: 409,
    });
  }
  if (error instanceof ArticlePublishedDeleteError) {
    return new HttpError({
      code: 'article_published',
      message: 'Unpublish the essay before deleting it.',
      status: 409,
    });
  }
  return error;
}

function documentOf(record: ArticleRecord): ArticleDocument {
  return Object.freeze({
    body: record.body,
    imagePrompts: record.imagePrompts,
    ingress: record.ingress,
    pullQuotes: record.pullQuotes,
    socialPosts: record.socialPosts,
    tags: record.tags,
    title: record.title,
    topic: record.topic,
  });
}

function requiredTitle(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (
    trimmed.length < 1 ||
    trimmed.length > MAX_TITLE_CHARACTERS ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw new HttpError({
      code: 'invalid_title',
      message: `The title must contain between 1 and ${String(MAX_TITLE_CHARACTERS)} safe characters.`,
      status: 400,
    });
  }
  return trimmed;
}

function currentRevisionResult(
  articles: ArticleRepository,
  id: string,
): ArticleMutationResult<never> {
  const stored = articles.get(id);
  return stored ? revisionConflict(stored.revision) : notFound();
}

function revisionConflict(currentRevision: number) {
  return Object.freeze({ currentRevision, status: 'revision_conflict' as const });
}

function notFound() {
  return Object.freeze({ status: 'not_found' as const });
}

function uuid(createUuid: () => string): string {
  const value = createUuid();
  if (!UUID_PATTERN.test(value)) throw new Error('Article id factory returned an invalid UUID.');
  return value;
}

function dateOnly(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function canonicalTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function checkedClock(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Article service clock must return non-negative epoch milliseconds.');
  }
  return value;
}
