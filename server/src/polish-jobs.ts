import type { JsonValue } from '@mikaelcedergren/cx-framework/server/errors';
import type { EnqueueDurableJob } from '@mikaelcedergren/cx-framework/server/jobs';

import {
  MAX_POLISH_INSTRUCTION_CHARACTERS,
  POLISH_MODES,
  isArticleId,
  type PolishMode,
} from './article-schema.js';

export const ARTICLE_POLISH_JOB_TYPE = 'wargr.article_polish';
export const ARTICLE_POLISH_JOB_VERSION = 1;
export const ARTICLE_POLISH_MAX_ATTEMPTS = 8;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type ArticlePolishJobPayload = Readonly<{
  articleId: string;
  expectedArticleRevision: number;
  inputSha256: string;
  instruction?: string;
  mode: PolishMode;
  runId: string;
  version: 1;
}>;

export interface BuildArticlePolishJobInput {
  readonly articleId: string;
  readonly expectedArticleRevision: number;
  readonly inputSha256: string;
  readonly instruction?: string;
  readonly mode: PolishMode;
  readonly runId: string;
}

export function articlePolishReceiptRecoveryIdempotencyKey(runId: string): string {
  if (!UUID_PATTERN.test(runId)) {
    throw new ArticlePolishJobInputError('Article polish receipt recovery run ID is invalid.');
  }
  return `article-polish-receipt-recovery:${runId}`;
}

/**
 * Build the immutable input shared by the HTTP enqueue path and the worker parser. The payload
 * pins the exact article revision and content hash the author asked to polish; the worker reloads
 * the trusted record from persistence and refuses to run against different content.
 */
export function buildArticlePolishJob(input: BuildArticlePolishJobInput): EnqueueDurableJob {
  const payload = articlePolishJobPayload({
    ...input,
    version: ARTICLE_POLISH_JOB_VERSION,
  });
  return Object.freeze({
    idempotencyKey: `article-polish:${payload.runId}`,
    maxAttempts: ARTICLE_POLISH_MAX_ATTEMPTS,
    payload: payload as JsonValue,
    type: ARTICLE_POLISH_JOB_TYPE,
  });
}

export function parseArticlePolishJob(payload: JsonValue): ArticlePolishJobPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ArticlePolishJobInputError('Article polish payload must be an object.');
  }
  return articlePolishJobPayload(payload as Record<string, JsonValue>);
}

export class ArticlePolishJobInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArticlePolishJobInputError';
  }
}

function articlePolishJobPayload(
  input: Readonly<Record<string, unknown>>,
): ArticlePolishJobPayload {
  const mode = input['mode'];
  if (typeof mode !== 'string' || !POLISH_MODES.includes(mode as PolishMode)) {
    throw new ArticlePolishJobInputError(
      `Article polish mode must be one of: ${POLISH_MODES.join(', ')}.`,
    );
  }
  const instructionPresent = input['instruction'] !== undefined;
  const expectedKeys = [
    'articleId',
    'expectedArticleRevision',
    'inputSha256',
    ...(instructionPresent ? ['instruction'] : []),
    'mode',
    'runId',
    'version',
  ].sort();
  const actualKeys = Object.keys(input).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ArticlePolishJobInputError(
      `Article polish payload must contain exactly: ${expectedKeys.join(', ')}.`,
    );
  }
  if (input['version'] !== ARTICLE_POLISH_JOB_VERSION) {
    throw new ArticlePolishJobInputError('Article polish payload version is invalid.');
  }
  const articleId = input['articleId'];
  if (!isArticleId(articleId)) {
    throw new ArticlePolishJobInputError('Article polish article ID is invalid.');
  }
  const runId = input['runId'];
  if (typeof runId !== 'string' || !UUID_PATTERN.test(runId)) {
    throw new ArticlePolishJobInputError('Article polish run ID is invalid.');
  }
  const inputSha256 = input['inputSha256'];
  if (typeof inputSha256 !== 'string' || !SHA256_PATTERN.test(inputSha256)) {
    throw new ArticlePolishJobInputError('Article polish input hash is invalid.');
  }
  const expectedArticleRevision = input['expectedArticleRevision'];
  if (!Number.isSafeInteger(expectedArticleRevision) || (expectedArticleRevision as number) < 1) {
    throw new ArticlePolishJobInputError('Article polish expected revision is invalid.');
  }

  let instruction: string | undefined;
  if (instructionPresent) {
    const candidate = input['instruction'];
    if (
      typeof candidate !== 'string' ||
      candidate.length < 1 ||
      candidate.length > MAX_POLISH_INSTRUCTION_CHARACTERS ||
      candidate !== candidate.trim() ||
      /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(candidate)
    ) {
      throw new ArticlePolishJobInputError('Article polish instruction is invalid.');
    }
    instruction = candidate;
  }

  return Object.freeze({
    articleId,
    expectedArticleRevision: expectedArticleRevision as number,
    inputSha256,
    ...(instruction === undefined ? {} : { instruction }),
    mode: mode as PolishMode,
    runId,
    version: ARTICLE_POLISH_JOB_VERSION,
  });
}
