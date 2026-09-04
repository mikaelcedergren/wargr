import { createHash } from 'node:crypto';

import type { JsonValue } from '@mikaelcedergren/cx-framework/server/errors';

import {
  ProviderResponseCapacityError,
  type PolishRepository,
  type ProviderEffect,
} from './article-repository.js';
import { DEFAULT_OPENAI_MODEL } from './constants.js';
import type { StructuredGenerationSpec, ValidationResult } from './polish-content.js';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

const MAX_PROVIDER_RESPONSE_BYTES = 4_194_304;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const PROVIDER_RESPONSE_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/u;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;
const DEFINITIVE_CREATE_REJECTION_STATUSES = new Set([400, 401, 403, 404, 422, 429]);

type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type Delay = (milliseconds: number, signal: AbortSignal) => Promise<void>;

interface ProviderFetchReceipt {
  readonly response: Response;
  readonly signal: AbortSignal;
  dispose(): void;
}

type ProviderRepository = Pick<
  PolishRepository,
  'getEffect' | 'prepareEffect' | 'transitionEffect'
>;

export interface OpenAiResponsesProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly clock?: () => number;
  readonly delay?: Delay;
  readonly fetch?: ProviderFetch;
  readonly model?: string;
  readonly pollIntervalMs?: number;
  readonly repository: ProviderRepository;
  readonly requestTimeoutMs?: number;
}

export interface GenerateStructuredInput<Result> {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly spec: (correction?: string) => StructuredGenerationSpec<Result>;
}

export interface OpenAiResponsesProvider {
  generateStructured<Result>(input: GenerateStructuredInput<Result>): Promise<Result>;
  quarantinePending(effectId: string, code: string, message: string): void;
}

export class GenerationProviderTerminalError extends Error {
  readonly code: string;
  readonly outcome: 'ambiguous' | 'failed';

  constructor(
    code: string,
    message: string,
    outcome: 'ambiguous' | 'failed',
    options: ErrorOptions = {},
  ) {
    assertSafeFailure(code, message);
    super(message, options);
    this.name = 'GenerationProviderTerminalError';
    this.code = code;
    this.outcome = outcome;
  }
}

/** Retrieval is safe to resume because the durable provider response ID is already recorded. */
export class GenerationProviderPendingError extends Error {
  readonly code: string;
  readonly effectId: string;

  constructor(effectId: string, code: string, message: string, options: ErrorOptions = {}) {
    assertSafeFailure(code, message);
    super(message, options);
    this.name = 'GenerationProviderPendingError';
    this.code = code;
    this.effectId = effectId;
  }
}

export function createOpenAiResponsesProvider(
  options: OpenAiResponsesProviderOptions,
): OpenAiResponsesProvider {
  const apiKey = exactSecret(options.apiKey, 'OpenAI API key');
  const baseUrl = providerBaseUrl(options.baseUrl ?? DEFAULT_OPENAI_BASE_URL);
  const model = providerModel(options.model ?? DEFAULT_OPENAI_MODEL);
  const clock = options.clock ?? Date.now;
  const fetchProvider = options.fetch ?? fetch;
  const delay = options.delay ?? abortableDelay;
  const pollIntervalMs = positiveTimer(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    'Provider poll interval',
  );
  const requestTimeoutMs = positiveTimer(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    'Provider request timeout',
  );
  const repository = options.repository;

  async function generateStructured<Result>({
    runId,
    signal,
    spec: specFactory,
  }: GenerateStructuredInput<Result>): Promise<Result> {
    let correction: string | undefined;
    for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
      const spec = specFactory(correction);
      const representation = await executeEffect({ ordinal, runId, signal, spec });
      const output = parseStructuredOutput(representation);
      if (!output.ok) {
        correction = output.error;
      } else {
        const validation = spec.validate(output.value);
        if (validation.ok) return validation.value;
        correction = validation.error;
      }
      if (ordinal === 2) {
        throw new GenerationProviderTerminalError(
          'structured_output_invalid',
          'The provider returned an invalid structured essay document twice.',
          'failed',
        );
      }
    }
    throw new Error('Structured generation exhausted an unreachable attempt count.');
  }

  async function executeEffect<Result>({
    ordinal,
    runId,
    signal,
    spec,
  }: {
    readonly ordinal: number;
    readonly runId: string;
    readonly signal: AbortSignal;
    readonly spec: StructuredGenerationSpec<Result>;
  }): Promise<JsonValue> {
    const request = providerRequest(model, spec);
    const requestJson = canonicalJson(request);
    const requestSha256 = sha256(requestJson);
    const effectKey = `${spec.operation}:attempt:${String(ordinal)}`;
    const effectId = sha256(`${runId}\u0000${effectKey}`);
    let effect = repository.getEffect(effectId);
    if (!effect) {
      effect = repository.prepareEffect({
        effectId,
        effectKey,
        operation: spec.operation,
        requestSha256,
        runId,
      });
    }
    assertEffectIdentity(effect, {
      effectId,
      effectKey,
      operation: spec.operation,
      requestSha256,
      runId,
    });

    if (effect.state === 'succeeded') {
      if (
        effect.response === null ||
        !effect.providerResponseId ||
        providerResponseId(effect.response) !== effect.providerResponseId
      ) {
        throw providerReceiptCorrupt();
      }
      return effect.response;
    }
    if (effect.state === 'ambiguous') throw ambiguousEffect(effect);
    if (effect.state === 'rejected') throw rejectedEffect(effect);
    if (effect.state === 'creating') {
      effect = repository.transitionEffect({
        effectId,
        errorCode: 'create_response_id_missing',
        errorMessage:
          'Provider create may have crossed the network without returning a response id.',
        expectedRevision: effect.revision,
        state: 'ambiguous',
      });
      throw ambiguousEffect(effect);
    }

    let representation: JsonValue | undefined;
    if (effect.state === 'prepared') {
      if (signal.aborted) {
        throw new GenerationProviderPendingError(
          effectId,
          'worker_stopping',
          'The background worker stopped before starting the provider request.',
          { cause: signal.reason },
        );
      }
      effect = repository.transitionEffect({
        effectId,
        expectedRevision: effect.revision,
        state: 'creating',
      });
      let fetched: ProviderFetchReceipt;
      try {
        fetched = await fetchOnce(
          `${baseUrl}/responses`,
          {
            body: requestJson,
            headers: providerHeaders(apiKey),
            method: 'POST',
          },
          signal,
          requestTimeoutMs,
          fetchProvider,
        );
      } catch (error) {
        effect = repository.transitionEffect({
          effectId,
          errorCode: 'provider_create_ambiguous',
          errorMessage:
            'The provider create request may have crossed the network without a response id.',
          expectedRevision: effect.revision,
          state: 'ambiguous',
        });
        throw new GenerationProviderTerminalError(
          effect.errorCode ?? 'provider_create_ambiguous',
          effect.errorMessage ?? 'The provider create request has an ambiguous outcome.',
          'ambiguous',
          { cause: error },
        );
      }
      try {
        const response = fetched.response;
        if (!response.ok) {
          await discardBoundedBody(response, fetched.signal);
          if (DEFINITIVE_CREATE_REJECTION_STATUSES.has(response.status)) {
            effect = repository.transitionEffect({
              effectId,
              errorCode: 'provider_create_rejected',
              errorMessage: `The provider rejected essay polishing with HTTP ${String(response.status)}.`,
              expectedRevision: effect.revision,
              state: 'rejected',
            });
            throw rejectedEffect(effect);
          }
          effect = repository.transitionEffect({
            effectId,
            errorCode: 'provider_create_ambiguous',
            errorMessage: `The provider create request ended with ambiguous HTTP ${String(response.status)}.`,
            expectedRevision: effect.revision,
            state: 'ambiguous',
          });
          throw ambiguousEffect(effect);
        }
        try {
          representation = await readBoundedJson(response, fetched.signal);
        } catch (error) {
          effect = repository.transitionEffect({
            effectId,
            errorCode: 'create_response_id_missing',
            errorMessage:
              'The provider create response could not be durably identified after submission.',
            expectedRevision: effect.revision,
            state: 'ambiguous',
          });
          throw new GenerationProviderTerminalError(
            effect.errorCode ?? 'create_response_id_missing',
            effect.errorMessage ?? 'The provider create response has an ambiguous outcome.',
            'ambiguous',
            { cause: error },
          );
        }
      } finally {
        fetched.dispose();
      }
      const responseId = providerResponseId(representation);
      if (!responseId) {
        effect = repository.transitionEffect({
          effectId,
          errorCode: 'create_response_id_missing',
          errorMessage: 'The provider accepted generation without returning a durable response id.',
          expectedRevision: effect.revision,
          state: 'ambiguous',
        });
        throw ambiguousEffect(effect);
      }
      // This receipt is the replay fence: no retrieval or response interpretation precedes it.
      effect = repository.transitionEffect({
        effectId,
        expectedRevision: effect.revision,
        providerResponseId: responseId,
        state: 'submitted',
      });
    }

    if (!effect.providerResponseId) throw providerReceiptCorrupt();
    if (
      representation !== undefined &&
      providerResponseId(representation) !== effect.providerResponseId
    ) {
      throw providerReceiptCorrupt();
    }
    return pollResponse({
      effect,
      initialRepresentation: representation,
      pollDeadlineMs: spec.pollDeadlineMs,
      signal,
    });
  }

  async function pollResponse({
    effect: initialEffect,
    initialRepresentation,
    pollDeadlineMs,
    signal,
  }: {
    readonly effect: ProviderEffect;
    readonly initialRepresentation: JsonValue | undefined;
    readonly pollDeadlineMs: number;
    readonly signal: AbortSignal;
  }): Promise<JsonValue> {
    positiveTimer(pollDeadlineMs, 'Provider polling deadline');
    const startedAt = safeClock(clock);
    const deadline = safeAdd(startedAt, pollDeadlineMs, 'Provider polling deadline');
    let effect = initialEffect;
    let representation = initialRepresentation;

    while (true) {
      if (representation !== undefined) {
        const state = providerStatus(representation);
        if (state === 'completed') {
          try {
            effect = repository.transitionEffect({
              effectId: effect.effectId,
              expectedRevision: effect.revision,
              response: representation,
              state: 'succeeded',
            });
          } catch (error) {
            if (error instanceof ProviderResponseCapacityError) {
              throw new GenerationProviderPendingError(
                effect.effectId,
                'provider_response_storage_pending',
                'The completed provider response is waiting for bounded receipt storage capacity.',
                { cause: error },
              );
            }
            throw error;
          }
          if (effect.response === null) throw providerReceiptCorrupt();
          return effect.response;
        }
        if (state === 'failed' || state === 'cancelled' || state === 'incomplete') {
          effect = repository.transitionEffect({
            effectId: effect.effectId,
            errorCode: `provider_${state}`,
            errorMessage: `The provider ended essay polishing with status ${state}.`,
            expectedRevision: effect.revision,
            state: 'rejected',
          });
          throw rejectedEffect(effect);
        }
        if (state !== 'queued' && state !== 'in_progress') {
          // The response ID is already durable, so an incomplete or future provider
          // representation is safe to retrieve again. It is not proof the background response
          // failed or that another paid create is needed.
          representation = undefined;
          if (effect.state === 'submitted') {
            effect = repository.transitionEffect({
              effectId: effect.effectId,
              expectedRevision: effect.revision,
              state: 'polling',
            });
          }
        } else {
          effect = repository.transitionEffect({
            effectId: effect.effectId,
            expectedRevision: effect.revision,
            state: 'polling',
          });
        }
      } else if (effect.state === 'submitted') {
        effect = repository.transitionEffect({
          effectId: effect.effectId,
          expectedRevision: effect.revision,
          state: 'polling',
        });
      }

      const current = safeClock(clock);
      if (current >= deadline) throw pollingPending(effect.effectId);
      if (signal.aborted) {
        throw new GenerationProviderPendingError(
          effect.effectId,
          'worker_stopping',
          'Provider retrieval was interrupted and will resume from its durable response id.',
          { cause: signal.reason },
        );
      }
      await delay(Math.min(pollIntervalMs, deadline - current), signal).catch((error: unknown) => {
        throw new GenerationProviderPendingError(
          effect.effectId,
          'worker_stopping',
          'Provider retrieval was interrupted and will resume from its durable response id.',
          { cause: error },
        );
      });

      const retrievalStartedAt = safeClock(clock);
      if (retrievalStartedAt >= deadline) throw pollingPending(effect.effectId);

      let fetched: ProviderFetchReceipt;
      try {
        fetched = await fetchOnce(
          `${baseUrl}/responses/${encodeURIComponent(effect.providerResponseId ?? '')}`,
          { headers: providerHeaders(apiKey), method: 'GET' },
          signal,
          Math.min(requestTimeoutMs, deadline - retrievalStartedAt),
          fetchProvider,
        );
      } catch (error) {
        if (signal.aborted) {
          throw new GenerationProviderPendingError(
            effect.effectId,
            'worker_stopping',
            'Provider retrieval was interrupted and will resume from its durable response id.',
            { cause: error },
          );
        }
        representation = undefined;
        continue;
      }
      try {
        const response = fetched.response;
        if (!response.ok) {
          await discardBoundedBody(response, fetched.signal);
          representation = undefined;
          continue;
        }
        try {
          const retrieved = await readBoundedJson(response, fetched.signal);
          representation =
            providerResponseId(retrieved) === effect.providerResponseId ? retrieved : undefined;
        } catch {
          // Retrieval is keyed by a persisted response ID, so malformed/transient responses can be
          // retried safely until the bounded polling deadline without issuing another paid create.
          representation = undefined;
        }
      } finally {
        fetched.dispose();
      }
    }
  }

  function quarantinePending(effectId: string, code: string, message: string): void {
    assertSafeFailure(code, message);
    const effect = repository.getEffect(effectId);
    if (!effect) throw new Error('The pending provider effect no longer exists.');
    if (effect.state === 'ambiguous') return;
    if (effect.state === 'rejected' || effect.state === 'succeeded') {
      throw new Error('A terminal provider effect cannot be quarantined as pending.');
    }
    if (effect.state !== 'submitted' && effect.state !== 'polling') {
      throw new Error('Only a submitted or polling provider effect may be quarantined.');
    }
    repository.transitionEffect({
      effectId,
      errorCode: code,
      errorMessage: message,
      expectedRevision: effect.revision,
      state: 'ambiguous',
    });
  }

  return Object.freeze({ generateStructured, quarantinePending });
}

function providerRequest<Result>(model: string, spec: StructuredGenerationSpec<Result>): JsonValue {
  return {
    background: true,
    input: spec.input,
    instructions: spec.instructions,
    max_output_tokens: spec.maxOutputTokens,
    model,
    store: true,
    text: {
      format: spec.format as unknown as JsonValue,
      verbosity: 'medium',
    },
  };
}

function providerHeaders(apiKey: string): Readonly<Record<string, string>> {
  return Object.freeze({
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  });
}

function assertEffectIdentity(
  effect: ProviderEffect,
  expected: Readonly<{
    effectId: string;
    effectKey: string;
    operation: string;
    requestSha256: string;
    runId: string;
  }>,
): void {
  if (
    effect.effectId !== expected.effectId ||
    effect.effectKey !== expected.effectKey ||
    effect.operation !== expected.operation ||
    effect.requestSha256 !== expected.requestSha256 ||
    effect.runId !== expected.runId
  ) {
    throw new GenerationProviderTerminalError(
      'provider_effect_conflict',
      'The durable provider receipt does not match the requested essay polish.',
      'ambiguous',
    );
  }
}

function parseStructuredOutput(representation: JsonValue): ValidationResult<unknown> {
  const root = jsonObject(representation);
  if (!root) {
    return Object.freeze({ error: 'the provider response was not an object', ok: false });
  }
  const output = root['output'];
  if (!Array.isArray(output)) {
    return Object.freeze({ error: 'the provider response had no output array', ok: false });
  }
  const segments: string[] = [];
  for (const rawItem of output) {
    const item = jsonObject(rawItem);
    if (!item) continue;
    const content = item['content'];
    if (!Array.isArray(content)) continue;
    for (const rawContent of content) {
      const contentItem = jsonObject(rawContent);
      if (contentItem?.['type'] === 'output_text' && typeof contentItem['text'] === 'string') {
        segments.push(contentItem['text']);
      }
    }
  }
  if (segments.length === 0) {
    return Object.freeze({ error: 'the provider response had no output_text content', ok: false });
  }
  try {
    const parsed = JSON.parse(segments.join('')) as unknown;
    if (!isJsonValue(parsed)) {
      return Object.freeze({
        error: 'the provider output was outside the JSON contract',
        ok: false,
      });
    }
    return Object.freeze({ ok: true, value: parsed });
  } catch {
    return Object.freeze({ error: 'the provider output was not valid JSON', ok: false });
  }
}

function providerResponseId(representation: JsonValue): string | null {
  const value = jsonObject(representation)?.['id'];
  return typeof value === 'string' && PROVIDER_RESPONSE_ID_PATTERN.test(value) ? value : null;
}

function providerStatus(representation: JsonValue): string | null {
  const value = jsonObject(representation)?.['status'];
  return typeof value === 'string' ? value : null;
}

function ambiguousEffect(effect: ProviderEffect): GenerationProviderTerminalError {
  return new GenerationProviderTerminalError(
    effect.errorCode ?? 'provider_create_ambiguous',
    effect.errorMessage ?? 'The provider create request has an ambiguous outcome.',
    'ambiguous',
  );
}

function rejectedEffect(effect: ProviderEffect): GenerationProviderTerminalError {
  return new GenerationProviderTerminalError(
    effect.errorCode ?? 'provider_generation_failed',
    effect.errorMessage ?? 'The provider could not complete the essay polish.',
    'failed',
  );
}

function providerReceiptCorrupt(): GenerationProviderTerminalError {
  return new GenerationProviderTerminalError(
    'provider_receipt_corrupt',
    'The durable provider receipt is incomplete or corrupt.',
    'ambiguous',
  );
}

function pollingPending(effectId: string): GenerationProviderPendingError {
  return new GenerationProviderPendingError(
    effectId,
    'provider_poll_pending',
    'The provider response is still pending and will be retrieved again.',
  );
}

async function fetchOnce(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs: number,
  fetchProvider: ProviderFetch,
): Promise<ProviderFetchReceipt> {
  if (init.redirect !== undefined && init.redirect !== 'error') {
    throw new Error('Provider requests forbid redirect-following request configuration.');
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('Provider request timed out.')),
    timeoutMs,
  );
  const dispose = (): void => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  };
  try {
    const response = await fetchProvider(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    });
    return Object.freeze({ dispose, response, signal: controller.signal });
  } catch (error) {
    dispose();
    throw error;
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<JsonValue> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_PROVIDER_RESPONSE_BYTES) {
      try {
        await response.body?.cancel();
      } catch {
        // The byte declaration is already enough to reject this representation safely.
      }
      throw new Error('Provider response exceeds its byte limit.');
    }
  }
  if (!response.body) throw new Error('Provider response body is missing.');
  const reader = response.body.getReader();
  const abort = (): void => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Provider response exceeds its byte limit.');
      }
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
  if (signal.aborted) throw signal.reason ?? new Error('Provider response reading was aborted.');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = JSON.parse(text) as unknown;
  if (!isJsonValue(parsed)) throw new Error('Provider response is outside the JSON contract.');
  return parsed;
}

async function discardBoundedBody(response: Response, signal: AbortSignal): Promise<void> {
  try {
    await readBoundedJson(response, signal);
  } catch {
    try {
      await response.body?.cancel();
    } catch {
      // The status code is the public receipt; error-body cleanup is strictly best effort.
    }
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  const stack: readonly [unknown, number][] = [[value, 0]];
  const pending: [unknown, number][] = [...stack];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const [candidate, depth] = current;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      continue;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) return false;
      continue;
    }
    if (!candidate || typeof candidate !== 'object') return false;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) pending.push([entry, depth + 1]);
      continue;
    }
    if (Object.getPrototypeOf(candidate) !== Object.prototype) return false;
    for (const entry of Object.values(candidate)) pending.push([entry, depth + 1]);
  }
  return true;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Provider request contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`)
    .join(',')}}`;
}

function jsonObject(value: JsonValue): Readonly<Record<string, JsonValue>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactSecret(value: string, label: string): string {
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a non-empty exact value without control characters.`);
  }
  return value;
}

function providerModel(value: string): string {
  const model = exactSecret(value, 'OpenAI model');
  if (model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(model)) {
    throw new Error('OpenAI model must be a safe model identifier of at most 128 characters.');
  }
  return model;
}

function providerBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('OpenAI base URL must be a valid URL.', { cause: error });
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/$/u, '') !== '/v1'
  ) {
    throw new Error('OpenAI base URL must end at the exact /v1 API root.');
  }
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Plain-HTTP OpenAI base URLs are restricted to loopback tests.');
  }
  return url.toString().replace(/\/$/u, '');
}

function safeClock(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Provider clock must return non-negative epoch milliseconds.');
  }
  return value;
}

function safeAdd(value: number, increment: number, label: string): number {
  if (
    !Number.isSafeInteger(increment) ||
    increment < 1 ||
    value > Number.MAX_SAFE_INTEGER - increment
  ) {
    throw new Error(`${label} is outside the safe timer range.`);
  }
  return value + increment;
}

function positiveTimer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`${label} must be a positive timer-safe integer.`);
  }
  return value;
}

function assertSafeFailure(code: string, message: string): void {
  if (!SAFE_CODE_PATTERN.test(code)) throw new Error('Provider failure code is invalid.');
  if (
    !message ||
    message !== message.trim() ||
    message.length > 2_048 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message)
  ) {
    throw new Error('Provider failure message is invalid.');
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  positiveTimer(milliseconds, 'Provider polling delay');
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
    }
    signal.addEventListener('abort', aborted, { once: true });
  });
}
