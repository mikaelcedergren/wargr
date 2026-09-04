import type {
  DurableJobDisposition,
  DurableJobExecutionContext,
  DurableJobHandler,
} from '@mikaelcedergren/cx-framework/server/jobs';
import {
  DurableJobCapacityError,
  DurableJobRetentionCapacityError,
} from '@mikaelcedergren/cx-framework/server/jobs';

import {
  ArticleRevisionConflictError,
  PersistenceRevisionConflictError,
  PolishAggregateCapacityError,
  PolishRunCapacityError,
  ProviderEffectCapacityError,
  polishInputSha256,
  type ArticleRepository,
  type PolishOutcome,
  type PolishRepository,
  type PolishRun,
} from './article-repository.js';
import { articlePolishSpec } from './polish-content.js';
import {
  ARTICLE_POLISH_JOB_TYPE,
  ArticlePolishJobInputError,
  articlePolishReceiptRecoveryIdempotencyKey,
  parseArticlePolishJob,
  type ArticlePolishJobPayload,
} from './polish-jobs.js';
import {
  GenerationProviderPendingError,
  GenerationProviderTerminalError,
  type OpenAiResponsesProvider,
} from './openai-provider.js';

const WORKER_STOP_RECHECK_MS = 1_000;

type TerminalPolishOutcome = Exclude<PolishOutcome, { readonly state: 'succeeded' }>;

export interface CreateArticlePolishHandlersOptions {
  readonly articles: ArticleRepository;
  readonly polish: PolishRepository;
  readonly provider: OpenAiResponsesProvider;
}

export class ArticlePolishExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean, options: ErrorOptions = {}) {
    assertSafeFailure(code, message);
    super(message, options);
    this.name = 'ArticlePolishExecutionError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function createArticlePolishHandlers({
  articles,
  polish,
  provider,
}: CreateArticlePolishHandlersOptions): Readonly<Record<string, DurableJobHandler>> {
  const handler: DurableJobHandler = async (rawPayload, context) => {
    let payload: ArticlePolishJobPayload;
    try {
      payload = parseArticlePolishJob(rawPayload);
    } catch (error) {
      failAssociatedRun(
        context.jobId,
        'invalid_job_payload',
        'The article polish job payload is invalid.',
      );
      throw new ArticlePolishExecutionError(
        'invalid_job_payload',
        'The article polish job payload is invalid.',
        false,
        { cause: error },
      );
    }
    let run = polish.getRunByJobId(context.jobId);
    if (!run || !runMatchesJob(run, payload, context, polish)) {
      failAssociatedRun(
        context.jobId,
        'polish_run_conflict',
        'The durable polish run does not match its immutable job.',
      );
      throw new ArticlePolishExecutionError(
        'polish_run_conflict',
        'The durable polish run does not match its immutable job.',
        false,
      );
    }
    if (run.state === 'succeeded') return;
    if (run.state === 'failed' || run.state === 'ambiguous') {
      throw new ArticlePolishExecutionError(
        run.errorCode ?? 'polish_failed',
        run.errorMessage ?? 'The article polish did not complete.',
        false,
      );
    }
    if (run.state === 'queued') {
      run = polish.transitionRun({
        expectedRevision: run.revision,
        runId: run.runId,
        state: 'running',
      });
    }

    try {
      await executePolish(run, context);
    } catch (error) {
      if (error instanceof ArticlePolishExecutionError) throw error;
      if (
        error instanceof DurableJobCapacityError ||
        error instanceof DurableJobRetentionCapacityError ||
        error instanceof PolishAggregateCapacityError ||
        error instanceof PolishRunCapacityError ||
        error instanceof ProviderEffectCapacityError
      ) {
        if (context.attempt >= context.maxAttempts) {
          const current = polish.getRun(run.runId);
          if (current?.state === 'running') {
            terminalizeRun(current, {
              errorCode: 'polish_queue_capacity',
              errorMessage:
                'The article polish could not hand off before its durable retry budget ended.',
              state: 'failed',
            });
          }
          throw new ArticlePolishExecutionError(
            'polish_queue_capacity',
            'The article polish could not hand off before its durable retry budget ended.',
            false,
            { cause: error },
          );
        }
        throw new ArticlePolishExecutionError(
          'polish_queue_capacity',
          'The article polish is waiting for durable queue capacity.',
          true,
          { cause: error },
        );
      }
      if (
        error instanceof ArticleRevisionConflictError ||
        error instanceof PersistenceRevisionConflictError
      ) {
        const current = polish.getRun(run.runId);
        if (current?.state === 'succeeded') return;
        if (current?.state === 'failed' || current?.state === 'ambiguous') {
          throw new ArticlePolishExecutionError(
            current.errorCode ?? 'polish_failed',
            current.errorMessage ?? 'The article polish did not complete.',
            false,
            { cause: error },
          );
        }
        if (context.attempt < context.maxAttempts) {
          throw new ArticlePolishExecutionError(
            'polish_revision_conflict',
            'The article polish changed concurrently and will be checked again.',
            true,
            { cause: error },
          );
        }
      }
      if (context.attempt < context.maxAttempts) {
        throw new ArticlePolishExecutionError(
          'polish_unexpected',
          'The article polish stopped unexpectedly and will retry from its durable state.',
          true,
          { cause: error },
        );
      }
      const current = polish.getRun(run.runId);
      if (current?.state === 'running') {
        terminalizeRun(current, {
          errorCode: 'polish_unexpected',
          errorMessage: 'The article polish stopped at an unexpected durable boundary.',
          state: 'ambiguous',
        });
      }
      throw new ArticlePolishExecutionError(
        'polish_unexpected',
        'The article polish stopped at an unexpected durable boundary.',
        false,
        { cause: error },
      );
    }
  };

  async function executePolish(run: PolishRun, context: DurableJobExecutionContext): Promise<void> {
    const stored = articles.get(run.articleId);
    if (!stored) {
      terminalizeRun(run, {
        errorCode: 'article_not_found',
        errorMessage: 'The essay no longer exists for this polish run.',
        state: 'failed',
      });
    }
    if (
      stored.revision !== run.expectedArticleRevision ||
      polishInputSha256(stored.record) !== run.inputSha256
    ) {
      terminalizeRun(run, {
        errorCode: 'article_revision_conflict',
        errorMessage: 'The essay changed before this polish could run. Start a new polish round.',
        state: 'failed',
      });
    }
    let document;
    try {
      document = await provider.generateStructured({
        runId: run.runId,
        signal: context.signal,
        spec: (correction) =>
          articlePolishSpec(run.mode, stored.record, run.instruction, correction),
      });
    } catch (error) {
      terminalizeProviderFailure(run, error, context);
    }
    polish.finalizeRun({
      expectedRunRevision: run.revision,
      outcome: { document, state: 'succeeded' },
      runId: run.runId,
    });
  }

  function failAssociatedRun(jobId: string, errorCode: string, errorMessage: string): void {
    let associated = polish.getRunByJobId(jobId);
    if (!associated || ['succeeded', 'failed', 'ambiguous'].includes(associated.state)) return;
    if (associated.state === 'queued') {
      associated = polish.transitionRun({
        expectedRevision: associated.revision,
        runId: associated.runId,
        state: 'running',
      });
    }
    polish.finalizeRun({
      expectedRunRevision: associated.revision,
      outcome: { errorCode, errorMessage, state: 'failed' },
      runId: associated.runId,
    });
  }

  function terminalizeProviderFailure(
    run: PolishRun,
    error: unknown,
    context: DurableJobExecutionContext,
  ): never {
    const terminal = providerFailure(error, context);
    terminalizeRun(run, {
      errorCode: terminal.code,
      errorMessage: terminal.message,
      state: terminal.outcome,
    });
  }

  function providerFailure(
    error: unknown,
    context: DurableJobExecutionContext,
  ): GenerationProviderTerminalError {
    if (error instanceof GenerationProviderTerminalError) return error;
    if (error instanceof ProviderEffectCapacityError) {
      if (context.attempt < context.maxAttempts) {
        throw new ArticlePolishExecutionError(
          'polish_queue_capacity',
          'Provider receipt storage is waiting for bounded maintenance.',
          true,
          { cause: error },
        );
      }
      return new GenerationProviderTerminalError(
        'polish_queue_capacity',
        'Provider receipt storage remained full through the durable retry budget.',
        'failed',
        { cause: error },
      );
    }
    if (error instanceof GenerationProviderPendingError) {
      if (error.code === 'worker_stopping') {
        throw new ArticlePolishExecutionError(error.code, error.message, true, { cause: error });
      }
      if (context.attempt < context.maxAttempts) {
        throw new ArticlePolishExecutionError(error.code, error.message, true, { cause: error });
      }
      provider.quarantinePending(
        error.effectId,
        'provider_poll_ambiguous',
        'The provider response did not finish within the automatic polling budget. Check the existing provider response before choosing a retry.',
      );
      return new GenerationProviderTerminalError(
        'provider_poll_ambiguous',
        'The provider response did not finish within the automatic polling budget. Check the existing provider response before choosing a retry.',
        'ambiguous',
        { cause: error },
      );
    }
    if (error instanceof ArticlePolishJobInputError) {
      return new GenerationProviderTerminalError(
        'polish_input_invalid',
        'The polish input was invalid.',
        'failed',
        { cause: error },
      );
    }
    if (context.attempt < context.maxAttempts) {
      throw new ArticlePolishExecutionError(
        'polish_unexpected',
        'The article polish stopped unexpectedly and will retry from its durable receipts.',
        true,
        { cause: error },
      );
    }
    return new GenerationProviderTerminalError(
      'polish_unexpected',
      'The article polish stopped at an ambiguous provider boundary.',
      'ambiguous',
      { cause: error },
    );
  }

  function terminalizeRun(run: PolishRun, outcome: TerminalPolishOutcome): never {
    polish.finalizeRun({
      expectedRunRevision: run.revision,
      outcome,
      runId: run.runId,
    });
    throw new ArticlePolishExecutionError(outcome.errorCode, outcome.errorMessage, false);
  }

  return Object.freeze({ [ARTICLE_POLISH_JOB_TYPE]: handler });
}

function runMatchesJob(
  run: PolishRun,
  payload: ArticlePolishJobPayload,
  context: DurableJobExecutionContext,
  polish: PolishRepository,
): boolean {
  const expectedStandardKey = `article-polish:${payload.runId}`;
  const expectedRecoveryKey = articlePolishReceiptRecoveryIdempotencyKey(payload.runId);
  const idempotencyMatches =
    context.idempotencyKey === expectedStandardKey ||
    (context.idempotencyKey === expectedRecoveryKey &&
      polish.isReceiptRecoveryJob({ jobId: context.jobId, runId: payload.runId }));
  return (
    run.articleId === payload.articleId &&
    run.expectedArticleRevision === payload.expectedArticleRevision &&
    run.inputSha256 === payload.inputSha256 &&
    run.jobId === context.jobId &&
    run.runId === payload.runId &&
    run.mode === payload.mode &&
    run.instruction === (payload.instruction ?? null) &&
    idempotencyMatches
  );
}

export function classifyArticlePolishFailure(
  error: unknown,
  now: number = Date.now(),
): DurableJobDisposition {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - WORKER_STOP_RECHECK_MS
  ) {
    throw new Error('Polish failure clock must return safe epoch milliseconds.');
  }
  if (error instanceof ArticlePolishExecutionError) {
    if (error.code === 'worker_stopping') {
      return Object.freeze({
        availableAt: now + WORKER_STOP_RECHECK_MS,
        code: error.code,
        message: error.message,
        type: 'delay' as const,
      });
    }
    return Object.freeze({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    });
  }
  return Object.freeze({
    code: 'polish_job_failed',
    message: 'The article polish job stopped unexpectedly.',
    retryable: true,
  });
}

function assertSafeFailure(code: string, message: string): void {
  if (!/^[a-z][a-z0-9_]{0,127}$/u.test(code)) {
    throw new Error('Article polish failure code is invalid.');
  }
  if (
    !message ||
    message !== message.trim() ||
    message.length > 2_048 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message)
  ) {
    throw new Error('Article polish failure message is invalid.');
  }
}
