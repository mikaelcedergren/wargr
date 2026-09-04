import { randomUUID } from 'node:crypto';

import { HttpError } from '@mikaelcedergren/cx-framework/server/errors';
import {
  DurableJobCapacityError,
  DurableJobRetentionCapacityError,
} from '@mikaelcedergren/cx-framework/server/jobs';

import {
  ArticleRevisionConflictError,
  MAX_RECOVERABLE_POLISH_RUNS,
  PersistenceRevisionConflictError,
  PolishAggregateCapacityError,
  PolishRunCapacityError,
  PolishWindowCapacityError,
  polishInputSha256,
  type ArticleRepository,
  type PolishAdmissionRepository,
  type PolishRepository,
  type PolishRun,
} from './article-repository.js';
import { isArticleId, normalizePolishInstruction } from './article-schema.js';
import { buildArticlePolishJob } from './polish-jobs.js';
import type {
  ArticleMutationResult,
  PolishAcceptance,
  PolishService,
  PolishStatus,
} from './http-contracts.js';

export const POLISH_WINDOW_MS = 10 * 60 * 1_000;
export const MAX_POLISHES_PER_WINDOW = 30;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface CreatePolishServiceOptions {
  readonly articles: ArticleRepository;
  readonly clock?: () => number;
  readonly createUuid?: () => string;
  readonly polish: PolishRepository;
  readonly polishAdmission: PolishAdmissionRepository;
  readonly providerConfigured: boolean;
}

export function createPolishService({
  articles,
  clock = Date.now,
  createUuid = randomUUID,
  polish,
  polishAdmission,
  providerConfigured,
}: CreatePolishServiceOptions): PolishService {
  const service: PolishService = {
    async getStatus(articleId) {
      if (!isArticleId(articleId)) return null;
      const run = polish.getLatestRun(articleId);
      if (!run) return null;
      return polishStatus(run, articles.get(articleId)?.revision ?? 0);
    },

    async listRecoverableStatuses() {
      return Object.freeze(
        polish
          .listLatestRecoverableRuns({ limit: MAX_RECOVERABLE_POLISH_RUNS })
          .map((run) => polishStatus(run, articles.get(run.articleId)?.revision ?? 0)),
      );
    },

    async startPolish({ articleId, expectedRevision, instruction, mode, ownerSessionIdHash }) {
      requireProvider(providerConfigured);
      if (!isArticleId(articleId)) return notFound();
      const stored = articles.get(articleId);
      if (!stored) return notFound();
      if (stored.revision !== expectedRevision) return revisionConflict(stored.revision);
      if (stored.record.body.trim().length < 1) {
        throw new HttpError({
          code: 'polish_source_empty',
          message: 'Write something first. The polish needs raw material to work from.',
          status: 400,
        });
      }
      const safeInstruction = instruction === null ? null : safePolishInstruction(instruction);
      const runId = uuid(createUuid, 'Polish run');
      const inputSha256 = polishInputSha256(stored.record);
      try {
        const result = polishAdmission.admit({
          now: checkedClock(clock),
          policy: Object.freeze({
            maximumPolishes: MAX_POLISHES_PER_WINDOW,
            windowMs: POLISH_WINDOW_MS,
          }),
          run: {
            articleId,
            expectedArticleRevision: expectedRevision,
            inputSha256,
            instruction: safeInstruction,
            job: buildArticlePolishJob({
              articleId,
              expectedArticleRevision: expectedRevision,
              inputSha256,
              ...(safeInstruction === null ? {} : { instruction: safeInstruction }),
              mode,
              runId,
            }),
            mode,
            ownerSessionIdHash,
            runId,
          },
        });
        if (result.status === 'rate_limited') {
          throw new HttpError({
            code: 'polish_limit_reached',
            details: { retryAt: result.allowance.retryAt },
            message: 'The polish limit has been reached. Try again in a few minutes.',
            status: 429,
          });
        }
        return Object.freeze({
          articleId,
          articleRevision: expectedRevision,
          jobId: result.run.jobId,
          runId: result.run.runId,
          state: 'queued' as const,
        }) satisfies PolishAcceptance;
      } catch (error) {
        if (
          error instanceof ArticleRevisionConflictError ||
          error instanceof PersistenceRevisionConflictError
        ) {
          return currentRevisionResult(articles, articleId);
        }
        throw polishAdmissionError(error);
      }
    },
  };
  return Object.freeze(service);
}

function polishStatus(run: PolishRun, articleRevision: number): PolishStatus {
  return Object.freeze({
    articleId: run.articleId,
    articleRevision,
    ...(run.errorCode && run.errorMessage
      ? { error: Object.freeze({ code: run.errorCode, message: run.errorMessage }) }
      : {}),
    instruction: run.instruction,
    jobId: run.jobId,
    mode: run.mode,
    runId: run.runId,
    state: run.state,
    updatedAt: new Date(run.updatedAt).toISOString(),
  });
}

function requireProvider(configured: boolean): void {
  if (!configured) {
    throw new HttpError({
      code: 'polish_provider_unavailable',
      message: 'Article polishing is not configured on this server.',
      status: 503,
    });
  }
}

function safePolishInstruction(value: string): string | null {
  const normalized = normalizePolishInstruction(value);
  return normalized.length === 0 ? null : normalized;
}

function polishAdmissionError(error: unknown): unknown {
  if (error instanceof PolishWindowCapacityError) {
    return new HttpError({
      code: 'polish_capacity_reached',
      message: 'Too many polish sessions are active. Try again shortly.',
      status: 429,
    });
  }
  if (
    error instanceof DurableJobCapacityError ||
    error instanceof DurableJobRetentionCapacityError ||
    error instanceof PolishAggregateCapacityError ||
    error instanceof PolishRunCapacityError
  ) {
    return new HttpError({
      code: 'polish_queue_unavailable',
      message: 'The polish queue is full. Try again after current work finishes.',
      status: 503,
    });
  }
  return error;
}

function currentRevisionResult(
  articles: ArticleRepository,
  articleId: string,
): ArticleMutationResult<never> {
  const stored = articles.get(articleId);
  return stored ? revisionConflict(stored.revision) : notFound();
}

function revisionConflict(currentRevision: number) {
  return Object.freeze({ currentRevision, status: 'revision_conflict' as const });
}

function notFound() {
  return Object.freeze({ status: 'not_found' as const });
}

function uuid(createUuid: () => string, label: string): string {
  const value = createUuid();
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} factory returned an invalid UUID.`);
  return value;
}

function checkedClock(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Polish clock must return non-negative epoch milliseconds.');
  }
  return value;
}
