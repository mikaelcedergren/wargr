import { randomUUID } from 'node:crypto';

import type { JsonValue } from '@mikaelcedergren/cx-framework/server/errors';
import {
  createDurableJobStore,
  type DurableJobStore,
  type DurableJobTransaction,
  type EnqueueDurableJob,
} from '@mikaelcedergren/cx-framework/server/jobs';
import {
  withImmediateTransaction,
  type SqliteRow,
  type SyncSqliteDatabase,
} from '@mikaelcedergren/cx-framework/server/sqlite';

import {
  ARTICLE_MAX_RECORDS,
  ARTICLE_MAX_VERSIONS,
  ARTICLE_MAX_VERSIONS_PER_ARTICLE,
  canonicalArticle,
  isArticleId,
  isArticleSlug,
  parseArticleBytes,
  sha256Hex,
  type ArticleDocument,
  type ArticleRecord,
  type ArticleState,
  type ArticleVersionSource,
  type PolishMode,
} from './article-schema.js';
import type {
  AuthenticationCapacityResult,
  LoginThrottleState as OwnerLoginThrottleState,
  PersistedOwnerSession,
  PersistentOwnerAuthRepository,
} from './auth-service.js';
import {
  MAX_POLISH_RUNS,
  MAX_PROVIDER_EFFECTS,
  MAX_PROVIDER_EFFECTS_PER_RUN,
  MAX_PROVIDER_RESPONSE_BYTES,
  MAX_PROVIDER_RESPONSE_BYTES_PER_RUN,
  MAX_PROVIDER_RESPONSE_TOTAL_BYTES,
  MAX_RETAINED_POLISH_JOBS,
  openWargrDatabase,
  type OpenWargrDatabaseOptions,
  type WargrDatabase,
} from './database.js';
import {
  ARTICLE_POLISH_JOB_TYPE,
  ARTICLE_POLISH_MAX_ATTEMPTS,
  articlePolishReceiptRecoveryIdempotencyKey,
  parseArticlePolishJob,
} from './polish-jobs.js';

export const MAX_RECOVERABLE_POLISH_RUNS = 100;
export const MAX_POLISH_RETENTION_BATCH = 100;
export const POLISH_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const MAX_OWNER_SESSIONS = 64;
const MAX_LOGIN_FAILURE_WINDOWS = 10_000;
const MAX_POLISH_WINDOWS = 1;
const GLOBAL_OWNER_POLISH_SCOPE = 'global-owner';
const MAX_ARTICLE_SEQUENCE = Number.MAX_SAFE_INTEGER;
const MAX_POLISH_RUN_SEQUENCE = Number.MAX_SAFE_INTEGER;
const OWNER_LOGIN_MAXIMUM_FAILURES = 5;
const OWNER_LOGIN_WINDOW_SECONDS = 15 * 60;
const OWNER_LOGIN_BLOCK_SECONDS = 15 * 60;
const POLISH_RUN_RETENTION_TARGET = Math.floor(MAX_POLISH_RUNS * 0.9);
const PROVIDER_EFFECT_RETENTION_TARGET = Math.floor(MAX_PROVIDER_EFFECTS * 0.9);
const PROVIDER_RESPONSE_RETENTION_TARGET = Math.floor(MAX_PROVIDER_RESPONSE_TOTAL_BYTES * 0.9);
const POLISH_JOB_RETENTION_TARGET = Math.floor(MAX_RETAINED_POLISH_JOBS * 0.9);

export interface StoredArticle {
  readonly record: ArticleRecord;
  readonly revision: number;
}

export interface ArticleSummary {
  readonly createdAt: string;
  readonly id: string;
  readonly publishedAt: string | null;
  readonly revision: number;
  readonly slug: string;
  readonly state: ArticleState;
  readonly title: string;
  readonly updatedAt: string;
}

export interface ArticleVersionSummary {
  readonly articleVersion: number;
  readonly createdAt: number;
  readonly polishRunId: string | null;
  readonly source: ArticleVersionSource;
}

export interface ArticleVersionRecord extends ArticleVersionSummary {
  readonly record: ArticleRecord;
}

export interface ReplaceArticleDocumentInput {
  readonly expectedRevision: number;
  readonly id: string;
  readonly polishRunId?: string;
  readonly record: ArticleRecord;
  readonly versionSource: ArticleVersionSource;
}

export interface ArticleRepository {
  create(record: ArticleRecord, versionSource: ArticleVersionSource): StoredArticle;
  delete(id: string, expectedRevision: number): boolean;
  get(id: string): StoredArticle | null;
  getBySlug(slug: string): StoredArticle | null;
  getVersion(id: string, articleVersion: number): ArticleVersionRecord | null;
  list(): readonly ArticleSummary[];
  listVersions(id: string, limit: number): readonly ArticleVersionSummary[];
  replaceDocument(input: ReplaceArticleDocumentInput): StoredArticle;
  setState(input: {
    readonly expectedRevision: number;
    readonly id: string;
    readonly publishedAt: string | null;
    readonly record: ArticleRecord;
  }): StoredArticle;
}

export type PolishState = 'queued' | 'running' | 'succeeded' | 'failed' | 'ambiguous';
export type ProviderEffectState =
  | 'prepared'
  | 'creating'
  | 'submitted'
  | 'polling'
  | 'succeeded'
  | 'rejected'
  | 'ambiguous';

export interface PolishRun {
  readonly articleId: string;
  readonly attempt: number;
  readonly createdAt: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly expectedArticleRevision: number;
  readonly finishedAt: number | null;
  readonly inputSha256: string;
  readonly instruction: string | null;
  readonly jobId: string;
  readonly mode: PolishMode;
  readonly ownerSessionIdHash: string;
  readonly revision: number;
  readonly runId: string;
  readonly runSequence: number;
  readonly state: PolishState;
  readonly updatedAt: number;
}

export interface ProviderEffect {
  readonly createdAt: number;
  readonly effectId: string;
  readonly effectKey: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly finishedAt: number | null;
  readonly operation: string;
  readonly providerResponseId: string | null;
  readonly requestSha256: string;
  readonly response: JsonValue | null;
  readonly responseSha256: string | null;
  readonly revision: number;
  readonly runId: string;
  readonly state: ProviderEffectState;
  readonly updatedAt: number;
}

export interface CreatePolishRunInput {
  readonly articleId: string;
  readonly expectedArticleRevision: number;
  readonly inputSha256: string;
  readonly instruction: string | null;
  readonly job: EnqueueDurableJob;
  readonly mode: PolishMode;
  readonly ownerSessionIdHash: string;
  readonly runId: string;
}

export interface PolishWindowPolicy {
  readonly maximumPolishes: number;
  readonly windowMs: number;
}

export interface PolishAllowance {
  readonly allowed: boolean;
  readonly count: number;
  readonly retryAt: number;
}

export type PolishAdmissionResult =
  | { readonly allowance: PolishAllowance; readonly status: 'rate_limited' }
  | { readonly allowance: PolishAllowance; readonly run: PolishRun; readonly status: 'accepted' };

export interface PolishAdmissionRepository {
  admit(input: {
    readonly now: number;
    readonly policy: PolishWindowPolicy;
    readonly run: CreatePolishRunInput;
  }): PolishAdmissionResult;
}

export type PolishOutcome =
  | { readonly document: ArticleDocument; readonly state: 'succeeded' }
  | {
      readonly errorCode: string;
      readonly errorMessage: string;
      readonly state: 'failed' | 'ambiguous';
    };

export interface FinalizePolishResult {
  readonly article: StoredArticle | null;
  readonly finalizedRun: PolishRun;
}

export interface PolishRepository {
  finalizeRun(input: {
    readonly expectedRunRevision: number;
    readonly outcome: PolishOutcome;
    readonly runId: string;
  }): FinalizePolishResult;
  getEffect(effectId: string): ProviderEffect | null;
  getLatestRun(articleId: string): PolishRun | null;
  getRun(runId: string): PolishRun | null;
  getRunByJobId(jobId: string): PolishRun | null;
  isReceiptRecoveryJob(input: { readonly jobId: string; readonly runId: string }): boolean;
  listLatestRecoverableRuns(input: { readonly limit: number }): readonly PolishRun[];
  markCreatingEffectsAmbiguous(now: number): number;
  prepareEffect(input: {
    readonly effectId: string;
    readonly effectKey: string;
    readonly operation: string;
    readonly requestSha256: string;
    readonly runId: string;
  }): ProviderEffect;
  transitionEffect(input: {
    readonly effectId: string;
    readonly errorCode?: string;
    readonly errorMessage?: string;
    readonly expectedRevision: number;
    readonly providerResponseId?: string;
    readonly response?: JsonValue;
    readonly state: Exclude<ProviderEffectState, 'prepared'>;
  }): ProviderEffect;
  transitionRun(input: {
    readonly errorCode?: string;
    readonly errorMessage?: string;
    readonly expectedRevision: number;
    readonly runId: string;
    readonly state: PolishState;
  }): PolishRun;
}

export interface PolishRetentionResult {
  readonly effects: number;
  readonly jobs: number;
  readonly responseBytes: number;
  readonly runs: number;
}

export interface PolishReconciliationResult {
  readonly ambiguous: number;
  readonly failed: number;
  readonly resumed: number;
}

export interface PolishMaintenanceRepository {
  maintainTerminalStorage(input: {
    readonly limit: number;
    readonly now: number;
  }): PolishRetentionResult;
  reconcileTerminalJobs(input: {
    readonly limit: number;
    readonly now: number;
  }): PolishReconciliationResult;
}

export interface DatabaseReadiness {
  isReady(): boolean;
}

export interface WargrPersistence extends DatabaseReadiness {
  readonly articles: ArticleRepository;
  readonly database: WargrDatabase;
  readonly jobs: DurableJobStore;
  readonly ownerAuth: PersistentOwnerAuthRepository;
  readonly polish: PolishRepository;
  readonly polishAdmission: PolishAdmissionRepository;
  readonly polishMaintenance: PolishMaintenanceRepository;
  close(): void;
}

export class ArticleCapacityError extends Error {
  constructor() {
    super('No more articles can be stored right now.');
    this.name = 'ArticleCapacityError';
  }
}

export class ArticleRevisionConflictError extends Error {
  constructor(readonly articleId: string) {
    super('The article changed after it was opened.');
    this.name = 'ArticleRevisionConflictError';
  }
}

export class ArticleSlugConflictError extends Error {
  constructor(readonly slug: string) {
    super('Another article already uses that slug.');
    this.name = 'ArticleSlugConflictError';
  }
}

export class ArticleActivePolishError extends Error {
  constructor(readonly articleId: string) {
    super('The article has an active polish run.');
    this.name = 'ArticleActivePolishError';
  }
}

export class ArticlePublishedDeleteError extends Error {
  constructor(readonly articleId: string) {
    super('A published article must be unpublished before deletion.');
    this.name = 'ArticlePublishedDeleteError';
  }
}

export class PolishWindowCapacityError extends Error {
  constructor() {
    super('The polish admission window store is full.');
    this.name = 'PolishWindowCapacityError';
  }
}

export class PolishRunCapacityError extends Error {
  constructor() {
    super('The polish run sequence capacity has been reached.');
    this.name = 'PolishRunCapacityError';
  }
}

export class PolishAggregateCapacityError extends Error {
  constructor() {
    super('The polish run aggregate capacity has been reached.');
    this.name = 'PolishAggregateCapacityError';
  }
}

export class PolishCompletedReceiptRetryError extends Error {
  constructor() {
    super('A completed paid receipt already exists for that polish run.');
    this.name = 'PolishCompletedReceiptRetryError';
  }
}

export class ProviderEffectCapacityError extends Error {
  constructor() {
    super('The provider effect capacity has been reached.');
    this.name = 'ProviderEffectCapacityError';
  }
}

export class ProviderResponseCapacityError extends Error {
  constructor() {
    super('The provider response capacity has been reached.');
    this.name = 'ProviderResponseCapacityError';
  }
}

export class ArticleSequenceCapacityError extends Error {
  constructor() {
    super('The article sequence capacity has been reached.');
    this.name = 'ArticleSequenceCapacityError';
  }
}

export class PersistenceRevisionConflictError extends Error {
  constructor(
    subject: string,
    readonly subjectId: string,
  ) {
    super(`${subject} was modified concurrently.`);
    this.name = 'PersistenceRevisionConflictError';
  }
}

export class ProviderEffectReplayBlockedError extends Error {
  constructor(readonly effectId: string) {
    super('An ambiguous provider effect must not be replayed.');
    this.name = 'ProviderEffectReplayBlockedError';
  }
}

interface ArticleRow extends SqliteRow {
  readonly article_sequence: number | bigint;
  readonly created_at: string;
  readonly id: string;
  readonly published_at: string | null;
  readonly record_json: Uint8Array;
  readonly record_sha256: string;
  readonly revision: number | bigint;
  readonly slug: string;
  readonly state: string;
  readonly title: string;
  readonly updated_at: string;
}

interface ArticleVersionRow extends SqliteRow {
  readonly article_id: string;
  readonly article_version: number | bigint;
  readonly created_at: number | bigint;
  readonly polish_run_id: string | null;
  readonly record_json: Uint8Array;
  readonly record_sha256: string;
  readonly source: string;
  readonly version_sequence: number | bigint;
}

interface CountRow extends SqliteRow {
  readonly count: number | bigint;
}

interface SessionRow extends SqliteRow {
  readonly absolute_expires_at: number | bigint;
  readonly expires_at: number | bigint;
  readonly issued_at: number | bigint;
  readonly last_seen_at: number | bigint;
  readonly revision: number | bigint;
  readonly revoked_at: number | bigint | null;
  readonly session_id_hash: string;
  readonly subject: string;
}

interface LoginFailureRow extends SqliteRow {
  readonly blocked_until: number | bigint | null;
  readonly failure_count: number | bigint;
  readonly window_started_at: number | bigint;
}

interface StoredLoginThrottleState {
  readonly blockedUntil: number | null;
  readonly failureCount: number;
  readonly windowStartedAt: number;
}

interface PolishWindowRow extends SqliteRow {
  readonly polish_count: number | bigint;
  readonly window_duration_ms: number | bigint;
  readonly window_started_at: number | bigint;
}

interface PolishRunRow extends SqliteRow {
  readonly article_id: string;
  readonly attempt: number | bigint;
  readonly created_at: number | bigint;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly expected_article_revision: number | bigint;
  readonly finished_at: number | bigint | null;
  readonly input_sha256: string;
  readonly instruction: string | null;
  readonly job_id: string;
  readonly mode: string;
  readonly owner_session_id_hash: string;
  readonly revision: number | bigint;
  readonly run_id: string;
  readonly run_sequence: number | bigint;
  readonly state: string;
  readonly updated_at: number | bigint;
}

interface PolishRunTerminalJobRow extends PolishRunRow {
  readonly job_failure_code: string | null;
  readonly job_failure_message: string | null;
}

interface ProviderEffectRow extends SqliteRow {
  readonly created_at: number | bigint;
  readonly effect_id: string;
  readonly effect_key: string;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly finished_at: number | bigint | null;
  readonly operation: string;
  readonly provider_response_id: string | null;
  readonly request_sha256: string;
  readonly response_json: Uint8Array | null;
  readonly response_sha256: string | null;
  readonly revision: number | bigint;
  readonly run_id: string;
  readonly state: string;
  readonly updated_at: number | bigint;
}

export type CreateWargrPersistenceOptions = OpenWargrDatabaseOptions & {
  readonly clock?: () => number;
  readonly createJobId?: () => string;
  readonly createLeaseToken?: () => string;
};

export function createWargrPersistence({
  clock = Date.now,
  createJobId = () => randomUUID(),
  createLeaseToken = () => randomUUID(),
  ...databaseOptions
}: CreateWargrPersistenceOptions): WargrPersistence {
  const database = openWargrDatabase(databaseOptions);
  const jobs = createDurableJobStore({
    createJobId,
    createLeaseToken,
    database: database.sqlite,
    leaseDurationMs: 60_000,
    maxConcurrentJobs: 1,
    maxOutstandingJobs: 1_000,
    maxPayloadBytes: 64 * 1024,
    maxRetainedJobs: MAX_RETAINED_POLISH_JOBS,
    now: clock,
    recoveryBatchSize: 100,
    retryInitialDelayMs: 1_000,
    retryMaximumDelayMs: 60_000,
  });
  const articles = createArticleRepository(database.sqlite, clock);
  const ownerAuth = createPersistentOwnerAuthRepository(database.sqlite);
  const polishState = createPolishRepository(database.sqlite, jobs, articles, clock);
  let closed = false;
  return Object.freeze({
    articles,
    database,
    jobs,
    ownerAuth,
    polish: polishState,
    polishAdmission: polishState,
    polishMaintenance: polishState,
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
    isReady() {
      return !closed && database.isReady();
    },
  });
}

/**
 * The exact asynchronous persistence seam consumed by auth-service. The caller supplies only
 * HMAC client-key hashes; this repository never receives or persists a raw network address.
 */
export function createPersistentOwnerAuthRepository(
  database: SyncSqliteDatabase,
): PersistentOwnerAuthRepository {
  const repository: PersistentOwnerAuthRepository = {
    async createSessionAndClearLoginFailures({
      clientKeyHash,
      session,
    }): Promise<AuthenticationCapacityResult> {
      assertHash(clientKeyHash, 'Client key hash');
      validatePersistedOwnerSession(session);
      if (session.revision !== 1) {
        throw new Error('A newly issued owner session must begin at revision 1.');
      }
      return withImmediateTransaction(database, () => {
        database.run(
          `DELETE FROM owner_sessions
           WHERE revoked_at IS NOT NULL OR expires_at <= ? OR absolute_expires_at <= ?`,
          [session.createdAt, session.createdAt],
        );
        const count = database.get<CountRow>('SELECT COUNT(*) AS count FROM owner_sessions');
        if (!count || integer(count.count, 'owner session count') >= MAX_OWNER_SESSIONS) {
          return 'capacity_reached';
        }
        database.run(
          `INSERT INTO owner_sessions (
             session_id_hash, subject, issued_at, last_seen_at, expires_at,
             absolute_expires_at, revoked_at, revision
           ) VALUES (?, 'owner', ?, ?, ?, ?, NULL, 1)`,
          [
            session.sessionIdHash,
            session.createdAt,
            session.lastSeenAt,
            session.expiresAt,
            session.expiresAt,
          ],
        );
        database.run('DELETE FROM login_failure_windows WHERE client_key_hash = ?', [
          clientKeyHash,
        ]);
        return 'created';
      });
    },
    async deleteSession(sessionIdHash): Promise<boolean> {
      assertHash(sessionIdHash, 'Session id hash');
      return (
        database.run('DELETE FROM owner_sessions WHERE session_id_hash = ?', [sessionIdHash])
          .changes === 1
      );
    },
    async findSession(sessionIdHash): Promise<PersistedOwnerSession | null> {
      assertHash(sessionIdHash, 'Session id hash');
      const row = database.get<SessionRow>(
        `SELECT * FROM owner_sessions WHERE session_id_hash = ? AND revoked_at IS NULL`,
        [sessionIdHash],
      );
      return row ? persistedOwnerSession(row) : null;
    },
    async readLoginThrottle(clientKeyHash, now): Promise<OwnerLoginThrottleState> {
      assertHash(clientKeyHash, 'Client key hash');
      assertEpoch(now, 'Login throttle read time');
      const row = database.get<LoginFailureRow>(
        `SELECT window_started_at, failure_count, blocked_until
         FROM login_failure_windows WHERE client_key_hash = ?`,
        [clientKeyHash],
      );
      return ownerLoginThrottleState(row, now);
    },
    async recordLoginFailure(clientKeyHash, now): Promise<OwnerLoginThrottleState> {
      assertHash(clientKeyHash, 'Client key hash');
      assertEpoch(now, 'Login failure time');
      return withImmediateTransaction(database, () => {
        database.run(
          `DELETE FROM login_failure_windows
           WHERE window_started_at + ? <= ?
             AND (blocked_until IS NULL OR blocked_until <= ?)`,
          [OWNER_LOGIN_WINDOW_SECONDS, now, now],
        );
        const row = database.get<LoginFailureRow>(
          `SELECT window_started_at, failure_count, blocked_until
           FROM login_failure_windows WHERE client_key_hash = ?`,
          [clientKeyHash],
        );
        const currentState = ownerLoginThrottleState(row, now);
        if (currentState.status === 'rate_limited') return currentState;

        const existing = row ? parseLoginFailure(row) : null;
        const reset =
          existing === null || now - existing.windowStartedAt >= OWNER_LOGIN_WINDOW_SECONDS;
        if (!existing) {
          const count = database.get<CountRow>(
            'SELECT COUNT(*) AS count FROM login_failure_windows',
          );
          if (
            !count ||
            integer(count.count, 'login failure window count') >= MAX_LOGIN_FAILURE_WINDOWS
          ) {
            return Object.freeze({ status: 'capacity_reached' as const });
          }
        }
        const windowStartedAt = reset ? now : existing.windowStartedAt;
        const failureCount = reset ? 1 : existing.failureCount + 1;
        const blockedUntil =
          failureCount >= OWNER_LOGIN_MAXIMUM_FAILURES
            ? safeAdd(now, OWNER_LOGIN_BLOCK_SECONDS, 'Login block time')
            : null;
        database.run(
          `INSERT INTO login_failure_windows (
             client_key_hash, window_started_at, failure_count, blocked_until, updated_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(client_key_hash) DO UPDATE SET
             window_started_at = excluded.window_started_at,
             failure_count = excluded.failure_count,
             blocked_until = excluded.blocked_until,
             updated_at = excluded.updated_at`,
          [clientKeyHash, windowStartedAt, failureCount, blockedUntil, now],
        );
        return blockedUntil === null
          ? Object.freeze({ status: 'allowed' as const })
          : Object.freeze({
              retryAfterSeconds: OWNER_LOGIN_BLOCK_SECONDS,
              status: 'rate_limited' as const,
            });
      });
    },
    async touchSession({
      expectedRevision,
      lastSeenAt,
      sessionIdHash,
    }): Promise<PersistedOwnerSession | null> {
      assertHash(sessionIdHash, 'Session id hash');
      assertPositiveInteger(expectedRevision, 'Expected session revision');
      assertEpoch(lastSeenAt, 'Session last-seen time');
      const row = database.get<SessionRow>(
        `UPDATE owner_sessions
         SET last_seen_at = MAX(last_seen_at, ?), revision = revision + 1
         WHERE session_id_hash = ? AND revision = ? AND revoked_at IS NULL
           AND ? < expires_at
         RETURNING *`,
        [lastSeenAt, sessionIdHash, expectedRevision, lastSeenAt],
      );
      return row ? persistedOwnerSession(row) : null;
    },
  };
  return Object.freeze(repository);
}

export function createArticleRepository(
  database: SyncSqliteDatabase,
  clock: () => number = Date.now,
): ArticleRepository {
  const insertVersion = createArticleVersionInserter(database);

  const repository: ArticleRepository = {
    create(record, versionSource) {
      const canonical = canonicalArticle(record);
      if (canonical.record.revision !== 1) {
        throw new Error('A new article must begin at revision 1.');
      }
      try {
        return withImmediateTransaction(database, () => {
          assertArticleCapacity(database);
          assertArticleSequenceCapacity(database);
          if (
            database.get('SELECT 1 AS present FROM articles WHERE slug = ?', [
              canonical.record.slug,
            ])
          ) {
            throw new ArticleSlugConflictError(canonical.record.slug);
          }
          const row = database.get<ArticleRow>(
            `INSERT INTO articles (
               id, slug, state, created_at, created_at_ms, updated_at, updated_at_ms,
               published_at, title, revision, record_sha256, record_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
             RETURNING ${articleColumns()}`,
            [
              canonical.record.id,
              canonical.record.slug,
              canonical.record.state,
              canonical.record.createdAt,
              Date.parse(canonical.record.createdAt),
              canonical.record.updatedAt,
              Date.parse(canonical.record.updatedAt),
              canonical.record.publishedAt,
              canonical.record.title,
              canonical.sha256,
              canonical.bytes,
            ],
          );
          if (!row) throw new Error('Article insert returned no row.');
          insertVersion(
            canonical.record.id,
            canonical.record,
            versionSource,
            null,
            checkedClock(clock),
          );
          return parseArticleRow(row);
        });
      } catch (error) {
        if (sqliteMessage(error).includes('article capacity reached')) {
          throw new ArticleCapacityError();
        }
        throw error;
      }
    },
    delete(id, expectedRevision) {
      assertArticleIdentity(id, expectedRevision);
      try {
        return withImmediateTransaction(database, () => {
          const article = database.get<{
            readonly revision: number | bigint;
            readonly state: string;
          }>('SELECT revision, state FROM articles WHERE id = ?', [id]);
          if (!article) return false;
          if (positiveInteger(article.revision, 'article revision') !== expectedRevision) {
            throw new ArticleRevisionConflictError(id);
          }
          if (article.state === 'published') throw new ArticlePublishedDeleteError(id);
          const active = database.get(
            `SELECT 1 AS present
             FROM polish_runs AS run
             LEFT JOIN cx_jobs AS job ON job.id = run.job_id
             WHERE run.article_id = ?
               AND (
                 run.state IN ('queued', 'running')
                 OR job.status IN ('blocked', 'queued', 'running')
               )
             LIMIT 1`,
            [id],
          );
          if (active) throw new ArticleActivePolishError(id);
          beginPolishRetention(database);
          database.run(
            `DELETE FROM cx_jobs
             WHERE id IN (SELECT job_id FROM polish_runs WHERE article_id = ?)
               AND status IN ('succeeded', 'failed')`,
            [id],
          );
          database.run('DELETE FROM polish_runs WHERE article_id = ?', [id]);
          endPolishRetention(database);
          const result = database.run(`DELETE FROM articles WHERE id = ? AND revision = ?`, [
            id,
            expectedRevision,
          ]);
          if (result.changes !== 1) throw new ArticleRevisionConflictError(id);
          return true;
        });
      } catch (error) {
        const message = sqliteMessage(error);
        if (message.includes('article has an active polish run')) {
          throw new ArticleActivePolishError(id);
        }
        if (message.includes('must be unpublished before deletion')) {
          throw new ArticlePublishedDeleteError(id);
        }
        throw error;
      }
    },
    get(id) {
      if (!isArticleId(id)) return null;
      const row = database.get<ArticleRow>(
        `SELECT ${articleColumns()} FROM articles WHERE id = ?`,
        [id],
      );
      return row ? parseArticleRow(row) : null;
    },
    getBySlug(slug) {
      if (!isArticleSlug(slug)) return null;
      const row = database.get<ArticleRow>(
        `SELECT ${articleColumns()} FROM articles WHERE slug = ?`,
        [slug],
      );
      return row ? parseArticleRow(row) : null;
    },
    getVersion(id, articleVersion) {
      if (!isArticleId(id)) return null;
      assertPositiveInteger(articleVersion, 'Article version');
      const row = database.get<ArticleVersionRow>(
        `SELECT * FROM article_versions WHERE article_id = ? AND article_version = ?`,
        [id, articleVersion],
      );
      return row ? parseArticleVersionRow(row, true) : null;
    },
    list() {
      return database
        .all<ArticleRow>(
          `SELECT ${articleColumns()} FROM articles
           ORDER BY updated_at_ms DESC, article_sequence DESC`,
        )
        .map((row) => {
          const article = parseArticleRow(row);
          return Object.freeze({
            createdAt: article.record.createdAt,
            id: article.record.id,
            publishedAt: article.record.publishedAt,
            revision: article.revision,
            slug: article.record.slug,
            state: article.record.state,
            title: article.record.title,
            updatedAt: article.record.updatedAt,
          });
        });
    },
    listVersions(id, limit) {
      if (!isArticleId(id)) return Object.freeze([]);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > ARTICLE_MAX_VERSIONS_PER_ARTICLE) {
        throw new Error(
          `Article version listing limit must be between 1 and ${String(ARTICLE_MAX_VERSIONS_PER_ARTICLE)}.`,
        );
      }
      return Object.freeze(
        database
          .all<ArticleVersionRow>(
            `SELECT * FROM article_versions
             WHERE article_id = ?
             ORDER BY article_version DESC
             LIMIT ?`,
            [id, limit],
          )
          .map((row) => parseArticleVersionRow(row, false)),
      );
    },
    replaceDocument(input) {
      assertArticleIdentity(input.id, input.expectedRevision);
      if (input.record.id !== input.id) {
        throw new Error('Article document replacement id does not match its record.');
      }
      if (input.record.revision !== input.expectedRevision + 1) {
        throw new Error('Article document replacement must advance the revision by one.');
      }
      if (
        (input.versionSource === 'polish') !==
        (input.polishRunId !== undefined && input.polishRunId !== null)
      ) {
        throw new Error('Only polish versions may carry a polish run id.');
      }
      return withImmediateTransaction(database, () =>
        replaceArticle(
          database,
          clock,
          input.record,
          input.expectedRevision,
          input.versionSource,
          input.polishRunId ?? null,
          insertVersion,
        ),
      );
    },
    setState(input) {
      assertArticleIdentity(input.id, input.expectedRevision);
      if (input.record.id !== input.id) {
        throw new Error('Article state change id does not match its record.');
      }
      if (input.record.revision !== input.expectedRevision + 1) {
        throw new Error('Article state change must advance the revision by one.');
      }
      if (input.record.publishedAt !== input.publishedAt) {
        throw new Error('Article state change publish dates do not match.');
      }
      return withImmediateTransaction(database, () => {
        const canonical = canonicalArticle(monotonicArticleMutation(database, input.record));
        const row = database.get<ArticleRow>(
          `UPDATE articles
           SET updated_at = ?, updated_at_ms = ?, slug = ?, state = ?, published_at = ?,
               title = ?, record_sha256 = ?, record_json = ?, revision = revision + 1
           WHERE id = ? AND revision = ?
           RETURNING ${articleColumns()}`,
          [
            canonical.record.updatedAt,
            Date.parse(canonical.record.updatedAt),
            canonical.record.slug,
            canonical.record.state,
            canonical.record.publishedAt,
            canonical.record.title,
            canonical.sha256,
            canonical.bytes,
            canonical.record.id,
            input.expectedRevision,
          ],
        );
        if (!row) throw new ArticleRevisionConflictError(canonical.record.id);
        return parseArticleRow(row);
      });
    },
  };
  return Object.freeze(repository);
}

type InsertVersionFn = (
  articleId: string,
  record: ArticleRecord,
  source: ArticleVersionSource,
  polishRunId: string | null,
  now: number,
) => void;

function replaceArticle(
  database: SyncSqliteDatabase,
  clock: () => number,
  record: ArticleRecord,
  expectedRevision: number,
  versionSource: ArticleVersionSource,
  polishRunId: string | null,
  insertVersion: InsertVersionFn,
): StoredArticle {
  const canonical = canonicalArticle(monotonicArticleMutation(database, record));
  const slugOwner = database.get<{ readonly id: string }>(
    'SELECT id FROM articles WHERE slug = ?',
    [canonical.record.slug],
  );
  if (slugOwner && slugOwner.id !== canonical.record.id) {
    throw new ArticleSlugConflictError(canonical.record.slug);
  }
  const row = database.get<ArticleRow>(
    `UPDATE articles
     SET updated_at = ?, updated_at_ms = ?, slug = ?, state = ?, published_at = ?, title = ?,
         record_sha256 = ?, record_json = ?, revision = revision + 1
     WHERE id = ? AND revision = ?
     RETURNING ${articleColumns()}`,
    [
      canonical.record.updatedAt,
      Date.parse(canonical.record.updatedAt),
      canonical.record.slug,
      canonical.record.state,
      canonical.record.publishedAt,
      canonical.record.title,
      canonical.sha256,
      canonical.bytes,
      canonical.record.id,
      expectedRevision,
    ],
  );
  if (!row) throw new ArticleRevisionConflictError(canonical.record.id);
  insertVersion(
    canonical.record.id,
    canonical.record,
    versionSource,
    polishRunId,
    checkedClock(clock),
  );
  return parseArticleRow(row);
}

function consumePolishAllowance(
  database: SyncSqliteDatabase,
  now: number,
  policy: PolishWindowPolicy,
): PolishAllowance {
  database.run(
    `DELETE FROM polish_windows
     WHERE window_started_at + window_duration_ms <= ?`,
    [now],
  );
  const row = database.get<PolishWindowRow>(
    `SELECT window_started_at, window_duration_ms, polish_count FROM polish_windows
     WHERE owner_scope = ?`,
    [GLOBAL_OWNER_POLISH_SCOPE],
  );
  if (!row) {
    assertRowCapacity(
      database,
      'polish_windows',
      MAX_POLISH_WINDOWS,
      () => new PolishWindowCapacityError(),
    );
    const retryAt = safeAdd(now, policy.windowMs, 'Polish retry time');
    database.run(
      `INSERT INTO polish_windows (
         owner_scope, window_started_at, window_duration_ms,
         polish_count, updated_at
       ) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(owner_scope) DO UPDATE SET
         window_started_at = excluded.window_started_at,
         window_duration_ms = excluded.window_duration_ms,
         polish_count = 1,
         updated_at = excluded.updated_at`,
      [GLOBAL_OWNER_POLISH_SCOPE, now, policy.windowMs, now],
    );
    return Object.freeze({ allowed: true, count: 1, retryAt });
  }
  const start = integer(row.window_started_at, 'polish window start');
  const duration = positiveInteger(row.window_duration_ms, 'polish window duration');
  if (duration !== policy.windowMs) {
    throw new Error('Polish window policy changed while a persisted window is active.');
  }
  if (now < start) {
    throw new Error('Polish admission time precedes its persisted active window.');
  }
  const count = integer(row.polish_count, 'polish count');
  const retryAt = safeAdd(start, policy.windowMs, 'Polish retry time');
  if (count >= policy.maximumPolishes) {
    return Object.freeze({ allowed: false, count, retryAt });
  }
  database.run(
    `UPDATE polish_windows
     SET polish_count = polish_count + 1, updated_at = ?
     WHERE owner_scope = ?`,
    [now, GLOBAL_OWNER_POLISH_SCOPE],
  );
  return Object.freeze({ allowed: true, count: count + 1, retryAt });
}

export function createPolishRepository(
  database: SyncSqliteDatabase,
  jobs: DurableJobStore,
  articles: ArticleRepository,
  clock: () => number = Date.now,
): PolishRepository & PolishAdmissionRepository & PolishMaintenanceRepository {
  function insertRun(
    transaction: DurableJobTransaction,
    input: CreatePolishRunInput,
    now: number,
  ): PolishRun {
    validatePolishRunInput(input);
    assertPolishRunSequenceCapacity(database);
    assertRowCapacity(
      database,
      'polish_runs',
      MAX_POLISH_RUNS,
      () => new PolishAggregateCapacityError(),
    );
    if (
      database.get(
        `SELECT 1 AS present FROM polish_runs
         WHERE article_id = ? AND state IN ('queued', 'running') LIMIT 1`,
        [input.articleId],
      )
    ) {
      throw new PersistenceRevisionConflictError('Active polish', input.articleId);
    }
    const job = transaction.enqueue(input.job).job;
    const row = database.get<PolishRunRow>(
      `INSERT INTO polish_runs (
         run_id, article_id, owner_session_id_hash, mode, instruction, input_sha256, state,
         expected_article_revision, job_id, attempt, created_at, updated_at,
         finished_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, 1, ?, ?, NULL, 1)
       RETURNING *`,
      [
        input.runId,
        input.articleId,
        input.ownerSessionIdHash,
        input.mode,
        input.instruction,
        input.inputSha256,
        input.expectedArticleRevision,
        job.id,
        now,
        now,
      ],
    );
    if (!row) throw new Error('Polish run insert returned no row.');
    return parsePolishRun(row);
  }

  function assertAdmissionState(run: CreatePolishRunInput): void {
    const article = articles.get(run.articleId);
    if (!article || article.revision !== run.expectedArticleRevision) {
      throw new ArticleRevisionConflictError(run.articleId);
    }
    const inputSha256 = sha256Hex(
      Buffer.from(
        JSON.stringify({
          body: article.record.body,
          imagePrompts: article.record.imagePrompts,
          ingress: article.record.ingress,
          pullQuotes: article.record.pullQuotes,
          socialPosts: article.record.socialPosts,
          tags: article.record.tags,
          title: article.record.title,
          topic: article.record.topic,
        }),
        'utf8',
      ),
    );
    if (inputSha256 !== run.inputSha256) {
      throw new ArticleRevisionConflictError(run.articleId);
    }
  }

  const repository: PolishRepository & PolishAdmissionRepository & PolishMaintenanceRepository = {
    admit(input) {
      validatePolishRunInput(input.run);
      assertEpoch(input.now, 'Polish admission time');
      assertWindowPolicy(input.policy.maximumPolishes, input.policy.windowMs, 'Polish');
      return jobs.withTransaction((transaction) => {
        // Admission state is checked before charging the bounded window. Every later mutation is
        // in this same immediate transaction, so job/run capacity or insert failure rolls it back.
        assertAdmissionState(input.run);
        const allowance = consumePolishAllowance(database, input.now, input.policy);
        if (!allowance.allowed) {
          return Object.freeze({ allowance, status: 'rate_limited' as const });
        }
        return Object.freeze({
          allowance,
          run: insertRun(transaction, input.run, input.now),
          status: 'accepted' as const,
        });
      });
    },
    finalizeRun(input) {
      assertIdentifier(input.runId, 'Polish run id');
      assertPositiveInteger(input.expectedRunRevision, 'Expected polish revision');
      const now = checkedClock(clock);
      return jobs.withTransaction(() => {
        const row = database.get<PolishRunRow>('SELECT * FROM polish_runs WHERE run_id = ?', [
          input.runId,
        ]);
        if (!row) throw new PersistenceRevisionConflictError('Polish run', input.runId);
        const current = parsePolishRun(row);
        if (current.revision !== input.expectedRunRevision || current.state !== 'running') {
          throw new PersistenceRevisionConflictError('Polish run', input.runId);
        }

        function finalize(
          state: 'ambiguous' | 'failed' | 'succeeded',
          errorCode: string | null,
          errorMessage: string | null,
        ): PolishRun {
          const updated = database.get<PolishRunRow>(
            `UPDATE polish_runs
             SET state = ?, error_code = ?, error_message = ?, finished_at = ?,
                 updated_at = ?, revision = revision + 1
             WHERE run_id = ? AND revision = ? AND state = 'running'
             RETURNING *`,
            [state, errorCode, errorMessage, now, now, current.runId, input.expectedRunRevision],
          );
          if (!updated) throw new PersistenceRevisionConflictError('Polish run', current.runId);
          return parsePolishRun(updated);
        }

        if (input.outcome.state !== 'succeeded') {
          return Object.freeze({
            article: null,
            finalizedRun: finalize(
              input.outcome.state,
              requiredFailure(input.outcome.errorCode, 'Polish error code'),
              requiredFailure(input.outcome.errorMessage, 'Polish error message'),
            ),
          });
        }

        const article = articles.get(current.articleId);
        if (!article || article.revision !== current.expectedArticleRevision) {
          // The author kept editing while the polish ran. The paid result may not silently
          // overwrite those edits, so the run fails with an exact, user-recoverable reason.
          return Object.freeze({
            article: null,
            finalizedRun: finalize(
              'failed',
              'article_revision_conflict',
              'The essay changed while the polish ran. Run the polish again from the current text.',
            ),
          });
        }
        const updatedRecord: ArticleRecord = Object.freeze({
          ...article.record,
          ...input.outcome.document,
          revision: article.revision + 1,
          updatedAt: canonicalTimestamp(now),
        });
        const stored = replaceArticle(
          database,
          clock,
          updatedRecord,
          current.expectedArticleRevision,
          'polish',
          current.runId,
          createArticleVersionInserter(database),
        );
        return Object.freeze({
          article: stored,
          finalizedRun: finalize('succeeded', null, null),
        });
      });
    },
    getEffect(effectId) {
      const row = database.get<ProviderEffectRow>(
        'SELECT * FROM provider_effects WHERE effect_id = ?',
        [effectId],
      );
      return row ? parseProviderEffect(row) : null;
    },
    getLatestRun(articleId) {
      if (!isArticleId(articleId)) return null;
      const row = database.get<PolishRunRow>(
        `SELECT * FROM polish_runs
         WHERE article_id = ? ORDER BY run_sequence DESC LIMIT 1`,
        [articleId],
      );
      return row ? parsePolishRun(row) : null;
    },
    getRun(runId) {
      const row = database.get<PolishRunRow>('SELECT * FROM polish_runs WHERE run_id = ?', [runId]);
      return row ? parsePolishRun(row) : null;
    },
    getRunByJobId(jobId) {
      assertIdentifier(jobId, 'Durable job id');
      const row = database.get<PolishRunRow>('SELECT * FROM polish_runs WHERE job_id = ?', [jobId]);
      return row ? parsePolishRun(row) : null;
    },
    isReceiptRecoveryJob({ jobId, runId }) {
      assertIdentifier(jobId, 'Durable recovery job id');
      assertIdentifier(runId, 'Polish recovery run id');
      return (
        database.get(
          `SELECT 1 AS present
           FROM polish_receipt_recoveries
           WHERE run_id = ? AND recovery_job_id = ?`,
          [runId, jobId],
        ) !== undefined
      );
    },
    listLatestRecoverableRuns({ limit }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECOVERABLE_POLISH_RUNS) {
        throw new Error(
          `Recoverable polish limit must be between 1 and ${String(MAX_RECOVERABLE_POLISH_RUNS)}.`,
        );
      }
      return database
        .all<PolishRunRow>(
          `SELECT latest_run.*
           FROM polish_runs AS latest_run
           WHERE latest_run.run_sequence IN (
             SELECT MAX(candidate.run_sequence)
             FROM polish_runs AS candidate
             GROUP BY candidate.article_id
           )
             AND latest_run.state IN ('queued', 'running', 'failed', 'ambiguous')
           ORDER BY latest_run.run_sequence DESC
           LIMIT ?`,
          [limit],
        )
        .map(parsePolishRun);
    },
    markCreatingEffectsAmbiguous(now) {
      assertEpoch(now, 'Provider recovery time');
      return database.run(
        `UPDATE provider_effects
         SET state = 'ambiguous',
             error_code = 'create_response_id_missing',
             error_message = 'Provider create may have crossed the network without returning a response id.',
             finished_at = ?, updated_at = ?, revision = revision + 1
         WHERE state = 'creating' AND provider_response_id IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM polish_runs AS run
             JOIN cx_jobs AS job ON job.id = run.job_id
             WHERE run.run_id = provider_effects.run_id
               AND job.status = 'running'
               AND job.lease_expires_at > ?
           )`,
        [now, now, now],
      ).changes;
    },
    prepareEffect(input) {
      assertIdentifier(input.effectId, 'Effect id');
      assertIdentifier(input.runId, 'Polish run id');
      assertIdentifier(input.effectKey, 'Effect key');
      assertSafeText(input.operation, 128, 'Provider operation');
      assertHash(input.requestSha256, 'Provider request hash');
      const existingRow = database.get<ProviderEffectRow>(
        `SELECT * FROM provider_effects
         WHERE effect_id = ? OR (run_id = ? AND effect_key = ?)
         ORDER BY effect_id = ? DESC LIMIT 1`,
        [input.effectId, input.runId, input.effectKey, input.effectId],
      );
      if (existingRow) {
        const existing = parseProviderEffect(existingRow);
        if (
          existing.effectId === input.effectId &&
          existing.runId === input.runId &&
          existing.effectKey === input.effectKey &&
          existing.operation === input.operation &&
          existing.requestSha256 === input.requestSha256
        ) {
          return existing;
        }
        throw new PersistenceRevisionConflictError('Provider effect', input.effectId);
      }
      assertRowCapacity(
        database,
        'provider_effects',
        MAX_PROVIDER_EFFECTS,
        () => new ProviderEffectCapacityError(),
      );
      const perRunCount = database.get<CountRow>(
        'SELECT COUNT(*) AS count FROM provider_effects WHERE run_id = ?',
        [input.runId],
      );
      if (
        !perRunCount ||
        integer(perRunCount.count, 'provider effects per run') >= MAX_PROVIDER_EFFECTS_PER_RUN
      ) {
        throw new ProviderEffectCapacityError();
      }
      const now = checkedClock(clock);
      const row = database.get<ProviderEffectRow>(
        `INSERT INTO provider_effects (
           effect_id, run_id, effect_key, operation, request_sha256, state,
           created_at, updated_at, revision
         ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, 1)
         RETURNING *`,
        [
          input.effectId,
          input.runId,
          input.effectKey,
          input.operation,
          input.requestSha256,
          now,
          now,
        ],
      );
      if (!row) throw new Error('Provider effect insert returned no row.');
      return parseProviderEffect(row);
    },
    transitionEffect(input) {
      assertIdentifier(input.effectId, 'Effect id');
      assertPositiveInteger(input.expectedRevision, 'Expected effect revision');
      const existing = database.get<ProviderEffectRow>(
        'SELECT * FROM provider_effects WHERE effect_id = ?',
        [input.effectId],
      );
      if (!existing) throw new PersistenceRevisionConflictError('Provider effect', input.effectId);
      const current = parseProviderEffect(existing);
      const terminal = ['succeeded', 'rejected', 'ambiguous'].includes(input.state);
      let responseBytes: Buffer | null = null;
      let responseSha256: string | null = null;
      if (input.state === 'succeeded') {
        if (input.response === undefined) {
          throw new Error('Succeeded provider effect needs a response.');
        }
        responseBytes = Buffer.from(canonicalJsonValue(input.response), 'utf8');
        if (responseBytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
          throw new ProviderResponseCapacityError();
        }
        responseSha256 = sha256Hex(responseBytes);
      } else if (input.response !== undefined) {
        throw new Error('Only a succeeded provider effect may persist a response.');
      }
      const errorRequired = input.state === 'rejected' || input.state === 'ambiguous';
      const errorCode = errorRequired
        ? requiredFailure(input.errorCode, 'Provider error code')
        : null;
      const errorMessage = errorRequired
        ? requiredFailure(input.errorMessage, 'Provider error message')
        : null;
      const providerResponseId =
        input.providerResponseId === undefined
          ? current.providerResponseId
          : requiredFailure(input.providerResponseId, 'Provider response id');
      if (current.revision !== input.expectedRevision) {
        if (
          current.revision === input.expectedRevision + 1 &&
          sameProviderEffectResult(
            current,
            input.state,
            providerResponseId,
            responseSha256,
            errorCode,
            errorMessage,
          )
        ) {
          return current;
        }
        throw new PersistenceRevisionConflictError('Provider effect', input.effectId);
      }
      if (current.state === 'ambiguous') throw new ProviderEffectReplayBlockedError(input.effectId);
      if (responseBytes !== null && current.response === null) {
        const total = database.get<{
          readonly bytes: number | bigint;
          readonly run_bytes: number | bigint;
        }>(
          `SELECT
             (SELECT COALESCE(SUM(length(response_json)), 0) FROM provider_effects) AS bytes,
             (SELECT COALESCE(SUM(length(response_json)), 0) FROM provider_effects
              WHERE run_id = ?) AS run_bytes`,
          [current.runId],
        );
        if (
          !total ||
          safeAdd(
            integer(total.run_bytes, 'provider response run bytes'),
            responseBytes.byteLength,
            'Provider response run bytes',
          ) > MAX_PROVIDER_RESPONSE_BYTES_PER_RUN ||
          safeAdd(
            integer(total.bytes, 'provider response aggregate bytes'),
            responseBytes.byteLength,
            'Provider response aggregate bytes',
          ) > MAX_PROVIDER_RESPONSE_TOTAL_BYTES
        ) {
          throw new ProviderResponseCapacityError();
        }
      }
      const now = checkedClock(clock);
      const row = database.get<ProviderEffectRow>(
        `UPDATE provider_effects
         SET state = ?, provider_response_id = ?, response_sha256 = ?, response_json = ?,
             error_code = ?, error_message = ?, finished_at = ?, updated_at = ?,
             revision = revision + 1
         WHERE effect_id = ? AND revision = ?
         RETURNING *`,
        [
          input.state,
          providerResponseId,
          responseSha256,
          responseBytes,
          errorCode,
          errorMessage,
          terminal ? now : null,
          now,
          input.effectId,
          input.expectedRevision,
        ],
      );
      if (!row) throw new PersistenceRevisionConflictError('Provider effect', input.effectId);
      return parseProviderEffect(row);
    },
    transitionRun(input) {
      assertIdentifier(input.runId, 'Polish run id');
      assertPositiveInteger(input.expectedRevision, 'Expected polish revision');
      const now = checkedClock(clock);
      const terminal = ['succeeded', 'failed', 'ambiguous'].includes(input.state);
      const errorRequired = input.state === 'failed' || input.state === 'ambiguous';
      const row = database.get<PolishRunRow>(
        `UPDATE polish_runs
         SET state = ?, error_code = ?, error_message = ?, finished_at = ?,
             updated_at = ?, revision = revision + 1
         WHERE run_id = ? AND revision = ?
         RETURNING *`,
        [
          input.state,
          errorRequired ? requiredFailure(input.errorCode, 'Polish error code') : null,
          errorRequired ? requiredFailure(input.errorMessage, 'Polish error message') : null,
          terminal ? now : null,
          now,
          input.runId,
          input.expectedRevision,
        ],
      );
      if (row) return parsePolishRun(row);
      throw new PersistenceRevisionConflictError('Polish run', input.runId);
    },
    reconcileTerminalJobs({ now, limit }) {
      assertEpoch(now, 'Polish reconciliation time');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_POLISH_RETENTION_BATCH) {
        throw new Error(
          `Polish reconciliation limit must be between 1 and ${String(MAX_POLISH_RETENTION_BATCH)}.`,
        );
      }
      return jobs.withTransaction((transaction) => {
        const rows = database.all<PolishRunTerminalJobRow>(
          `SELECT run.*,
                  job.failure_code AS job_failure_code,
                  job.failure_message AS job_failure_message
           FROM polish_runs AS run
           JOIN cx_jobs AS job ON job.id = run.job_id
           WHERE run.state IN ('queued', 'running') AND job.status = 'failed'
           ORDER BY run.run_sequence
           LIMIT ?`,
          [limit],
        );
        let ambiguous = 0;
        let failed = 0;
        let resumed = 0;
        for (const row of rows) {
          const succeededReceipt =
            database.get(
              `SELECT 1 AS present FROM provider_effects
               WHERE run_id = ? AND state = 'succeeded' LIMIT 1`,
              [row.run_id],
            ) !== undefined;
          if (succeededReceipt) {
            const unsafeUnresolvedEffect =
              database.get(
                `SELECT 1 AS present FROM provider_effects
                 WHERE run_id = ?
                   AND state IN ('creating', 'submitted', 'polling', 'ambiguous')
                 LIMIT 1`,
                [row.run_id],
              ) !== undefined;
            const recoveryUsed =
              database.get(
                `SELECT 1 AS present FROM polish_receipt_recoveries
                 WHERE run_id = ? LIMIT 1`,
                [row.run_id],
              ) !== undefined;
            if (row.state === 'running' && !unsafeUnresolvedEffect && !recoveryUsed) {
              const failedJob = jobs.get(row.job_id);
              if (!failedJob || failedJob.status !== 'failed') {
                throw new Error('Completed provider receipt recovery lost its failed durable job.');
              }
              const parsedJob = parseArticlePolishJob(failedJob.payload);
              if (
                failedJob.type !== ARTICLE_POLISH_JOB_TYPE ||
                parsedJob.runId !== row.run_id ||
                parsedJob.articleId !== row.article_id ||
                parsedJob.mode !== row.mode
              ) {
                throw new Error('Completed provider receipt recovery found mismatched job input.');
              }
              const replacement = transaction.enqueue({
                availableAt: now,
                executionClass: failedJob.executionClass,
                idempotencyKey: articlePolishReceiptRecoveryIdempotencyKey(row.run_id),
                maxAttempts: failedJob.maxAttempts,
                payload: failedJob.payload,
                type: failedJob.type,
              }).job;
              const marked = database.run(
                `INSERT INTO polish_receipt_recoveries (
                   run_id, original_job_id, recovery_job_id, recovered_at
                 ) VALUES (?, ?, ?, ?)`,
                [row.run_id, row.job_id, replacement.id, now],
              );
              if (marked.changes !== 1) {
                throw new Error('Completed provider receipt recovery could not be sealed.');
              }
              const relinked = database.run(
                `UPDATE polish_runs
                 SET job_id = ?, updated_at = MAX(updated_at, ?), revision = revision + 1
                 WHERE run_id = ? AND job_id = ? AND revision = ? AND state = 'running'`,
                [replacement.id, now, row.run_id, row.job_id, row.revision],
              );
              if (relinked.changes !== 1) {
                throw new Error(
                  'Completed provider receipt run could not be relinked exactly once.',
                );
              }
              resumed += 1;
              continue;
            }
          }
          const uncertain =
            database.get(
              `SELECT 1 AS present FROM provider_effects
               WHERE run_id = ?
                 AND state IN ('creating', 'submitted', 'polling', 'ambiguous')
               LIMIT 1`,
              [row.run_id],
            ) !== undefined;
          if (uncertain) {
            database.run(
              `UPDATE provider_effects
               SET state = 'ambiguous',
                   error_code = 'provider_effect_incomplete_at_job_failure',
                   error_message = 'Provider work remained incomplete when its durable job failed.',
                   finished_at = ?, updated_at = ?, revision = revision + 1
               WHERE run_id = ? AND state IN ('creating', 'submitted', 'polling')`,
              [now, now, row.run_id],
            );
          }
          const state = uncertain ? 'ambiguous' : 'failed';
          const errorCode = uncertain
            ? 'provider_effect_ambiguous'
            : safePersistedFailure(row.job_failure_code, 'durable_job_failed');
          const errorMessage = uncertain
            ? 'Provider work may have crossed the network before its durable job failed.'
            : safePersistedFailure(
                row.job_failure_message,
                'The durable polish job failed without a safe persisted description.',
              );
          const result = database.run(
            `UPDATE polish_runs
             SET state = ?, error_code = ?, error_message = ?, finished_at = ?,
                 updated_at = ?, revision = revision + 1
             WHERE run_id = ? AND revision = ? AND state IN ('queued', 'running')`,
            [state, errorCode, errorMessage, now, now, row.run_id, row.revision],
          );
          if (result.changes !== 1) {
            throw new Error('Polish reconciliation lost its pinned run revision.');
          }
          if (uncertain) ambiguous += 1;
          else failed += 1;
        }
        return Object.freeze({ ambiguous, failed, resumed });
      });
    },
    maintainTerminalStorage({ now, limit }) {
      assertEpoch(now, 'Polish retention time');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_POLISH_RETENTION_BATCH) {
        throw new Error(
          `Polish retention limit must be between 1 and ${String(MAX_POLISH_RETENTION_BATCH)}.`,
        );
      }
      return withImmediateTransaction(database, () => {
        const before = Math.max(0, now - POLISH_TERMINAL_RETENTION_MS);
        const totals = database.get<{
          readonly effects: number | bigint;
          readonly jobs: number | bigint;
          readonly response_bytes: number | bigint;
          readonly runs: number | bigint;
        }>(
          `SELECT
             (SELECT COUNT(*) FROM polish_runs) AS runs,
             (SELECT COUNT(*) FROM provider_effects) AS effects,
             (SELECT COUNT(*) FROM cx_jobs) AS jobs,
             (SELECT COALESCE(SUM(length(response_json)), 0) FROM provider_effects)
               AS response_bytes`,
        );
        if (!totals) throw new Error('Polish retention totals are unavailable.');
        const storagePressure =
          integer(totals.runs, 'polish retention run count') >= POLISH_RUN_RETENTION_TARGET ||
          integer(totals.effects, 'polish retention effect count') >=
            PROVIDER_EFFECT_RETENTION_TARGET ||
          integer(totals.response_bytes, 'polish retention response bytes') >=
            PROVIDER_RESPONSE_RETENTION_TARGET;
        const jobStoragePressure =
          integer(totals.jobs, 'polish retention job count') >= POLISH_JOB_RETENTION_TARGET;
        const candidates = database.all<{
          readonly effect_count: number | bigint;
          readonly job_id: string;
          readonly response_bytes: number | bigint;
          readonly run_id: string;
        }>(
          `SELECT run.run_id, run.job_id,
                  COUNT(effect.effect_id) AS effect_count,
                  COALESCE(SUM(length(effect.response_json)), 0) AS response_bytes
           FROM polish_runs AS run
           LEFT JOIN provider_effects AS effect ON effect.run_id = run.run_id
           WHERE run.state IN ('succeeded', 'failed', 'ambiguous')
             AND (run.finished_at <= ? OR ? = 1)
             AND NOT (
               run.state IN ('failed', 'ambiguous')
               AND run.run_sequence = (
                 SELECT MAX(latest.run_sequence)
                 FROM polish_runs AS latest
                 WHERE latest.article_id = run.article_id
               )
               AND EXISTS (SELECT 1 FROM articles WHERE id = run.article_id)
             )
             AND NOT EXISTS (
               SELECT 1 FROM cx_jobs AS active_job
               WHERE active_job.id = run.job_id
                 AND active_job.status IN ('blocked', 'queued', 'running')
             )
           GROUP BY run.run_id, run.job_id, run.finished_at, run.run_sequence
           ORDER BY run.finished_at, run.run_sequence
           LIMIT ?`,
          [before, storagePressure ? 1 : 0, limit],
        );
        let coordinatedJobs = 0;
        if (candidates.length > 0) {
          beginPolishRetention(database);
          for (const candidate of candidates) {
            const result = database.run(
              `DELETE FROM polish_runs
               WHERE run_id = ? AND state IN ('succeeded', 'failed', 'ambiguous')`,
              [candidate.run_id],
            );
            if (result.changes !== 1) {
              throw new Error('Polish retention candidate changed during its transaction.');
            }
          }
          endPolishRetention(database);
          for (const candidate of candidates) {
            coordinatedJobs += database.run(
              `DELETE FROM cx_jobs WHERE id = ? AND status IN ('succeeded', 'failed')`,
              [candidate.job_id],
            ).changes;
          }
        }
        const remainingJobLimit = Math.max(0, limit - coordinatedJobs);
        const otherJobs = database.run(
          `DELETE FROM cx_jobs
           WHERE id IN (
             SELECT id FROM cx_jobs
             WHERE status IN ('succeeded', 'failed')
               AND (finished_at < ? OR ? = 1)
               AND NOT EXISTS (
                 SELECT 1 FROM polish_runs AS active_run
                 WHERE active_run.job_id = cx_jobs.id
                   AND active_run.state IN ('queued', 'running')
               )
             ORDER BY finished_at, id
             LIMIT ?
           )`,
          [before, jobStoragePressure ? 1 : 0, remainingJobLimit],
        ).changes;
        return Object.freeze({
          effects: candidates.reduce(
            (total, candidate) =>
              safeAdd(
                total,
                integer(candidate.effect_count, 'retained effect count'),
                'Retained effect count',
              ),
            0,
          ),
          jobs: safeAdd(coordinatedJobs, otherJobs, 'Retained job count'),
          responseBytes: candidates.reduce(
            (total, candidate) =>
              safeAdd(
                total,
                integer(candidate.response_bytes, 'retained response bytes'),
                'Retained response bytes',
              ),
            0,
          ),
          runs: candidates.length,
        });
      });
    },
  };
  return Object.freeze(repository);
}

function createArticleVersionInserter(database: SyncSqliteDatabase): InsertVersionFn {
  return (articleId, record, source, polishRunId, now) => {
    const canonical = canonicalArticle(record);
    // The per-article history is a designed bounded ring: the newest versions win, and the oldest
    // beyond the compiled cap leave through the guarded retention path inside this transaction.
    const count = database.get<CountRow>(
      'SELECT COUNT(*) AS count FROM article_versions WHERE article_id = ?',
      [articleId],
    );
    const current = count ? integer(count.count, 'article version count') : 0;
    const excess = current - (ARTICLE_MAX_VERSIONS_PER_ARTICLE - 1);
    if (excess > 0) {
      beginArticleRetention(database);
      const pruned = database.run(
        `DELETE FROM article_versions
         WHERE version_sequence IN (
           SELECT version_sequence FROM article_versions
           WHERE article_id = ?
           ORDER BY article_version
           LIMIT ?
         )`,
        [articleId, excess],
      );
      endArticleRetention(database);
      if (pruned.changes !== excess) {
        throw new Error('Article version retention did not prune the exact excess.');
      }
    }
    assertRowCapacity(
      database,
      'article_versions',
      ARTICLE_MAX_VERSIONS,
      () => new ArticleCapacityError(),
    );
    const next = database.get<{ readonly next: number | bigint | null }>(
      'SELECT MAX(article_version) AS next FROM article_versions WHERE article_id = ?',
      [articleId],
    );
    const articleVersion = next && next.next !== null ? integer(next.next, 'version') + 1 : 1;
    const result = database.run(
      `INSERT INTO article_versions (
         article_id, article_version, source, polish_run_id, created_at,
         record_sha256, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [articleId, articleVersion, source, polishRunId, now, canonical.sha256, canonical.bytes],
    );
    if (result.changes !== 1) throw new Error('Article version insert changed no row.');
  };
}

function articleColumns(): string {
  return [
    'article_sequence',
    'id',
    'slug',
    'state',
    'created_at',
    'published_at',
    'title',
    'updated_at',
    'revision',
    'record_sha256',
    'record_json',
  ].join(', ');
}

function parseArticleRow(row: ArticleRow): StoredArticle {
  const bytes = Buffer.from(row.record_json);
  if (sha256Hex(bytes) !== row.record_sha256) {
    throw new Error('Stored article record hash does not match its BLOB.');
  }
  const record = parseArticleBytes(bytes);
  const revision = positiveInteger(row.revision, 'article revision');
  if (
    record.id !== row.id ||
    record.slug !== row.slug ||
    record.state !== row.state ||
    record.title !== row.title ||
    record.createdAt !== row.created_at ||
    record.updatedAt !== row.updated_at ||
    record.publishedAt !== row.published_at ||
    record.revision !== revision
  ) {
    throw new Error('Stored article row does not mirror its canonical record.');
  }
  return Object.freeze({ record, revision });
}

function parseArticleVersionRow(row: ArticleVersionRow, withRecord: true): ArticleVersionRecord;
function parseArticleVersionRow(row: ArticleVersionRow, withRecord: false): ArticleVersionSummary;
function parseArticleVersionRow(
  row: ArticleVersionRow,
  withRecord: boolean,
): ArticleVersionRecord | ArticleVersionSummary {
  if (!['author', 'polish', 'import'].includes(row.source)) {
    throw new Error('Article version source is invalid.');
  }
  const summary = {
    articleVersion: positiveInteger(row.article_version, 'article version'),
    createdAt: integer(row.created_at, 'article version created time'),
    polishRunId: row.polish_run_id,
    source: row.source as ArticleVersionSource,
  };
  if (!withRecord) return Object.freeze(summary);
  const bytes = Buffer.from(row.record_json);
  if (sha256Hex(bytes) !== row.record_sha256) {
    throw new Error('Stored article version hash does not match its BLOB.');
  }
  return Object.freeze({ ...summary, record: parseArticleBytes(bytes) });
}

function parsePolishRun(row: PolishRunRow): PolishRun {
  if (!['rough', 'reference', 'developed', 'polish'].includes(row.mode)) {
    throw new Error('Polish mode is invalid.');
  }
  if (!['queued', 'running', 'succeeded', 'failed', 'ambiguous'].includes(row.state)) {
    throw new Error('Polish state is invalid.');
  }
  return Object.freeze({
    articleId: row.article_id,
    attempt: positiveInteger(row.attempt, 'polish attempt'),
    createdAt: integer(row.created_at, 'polish created time'),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    expectedArticleRevision: positiveInteger(
      row.expected_article_revision,
      'expected article revision',
    ),
    finishedAt: row.finished_at === null ? null : integer(row.finished_at, 'polish finished time'),
    inputSha256: requiredHash(row.input_sha256, 'Polish input hash'),
    instruction: row.instruction,
    jobId: row.job_id,
    mode: row.mode as PolishMode,
    ownerSessionIdHash: requiredHash(row.owner_session_id_hash, 'Polish owner hash'),
    revision: positiveInteger(row.revision, 'polish revision'),
    runId: row.run_id,
    runSequence: positiveInteger(row.run_sequence, 'polish run sequence'),
    state: row.state as PolishState,
    updatedAt: integer(row.updated_at, 'polish updated time'),
  });
}

function parseProviderEffect(row: ProviderEffectRow): ProviderEffect {
  if (
    ![
      'prepared',
      'creating',
      'submitted',
      'polling',
      'succeeded',
      'rejected',
      'ambiguous',
    ].includes(row.state)
  ) {
    throw new Error('Provider effect state is invalid.');
  }
  let response: JsonValue | null = null;
  if (row.response_json !== null) {
    const bytes = Buffer.from(row.response_json);
    if (sha256Hex(bytes) !== row.response_sha256) {
      throw new Error('Provider response receipt hash does not match its BLOB.');
    }
    response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as JsonValue;
    if (Buffer.from(canonicalJsonValue(response), 'utf8').compare(bytes) !== 0) {
      throw new Error('Provider response receipt is not canonical JSON.');
    }
  }
  return Object.freeze({
    createdAt: integer(row.created_at, 'effect created time'),
    effectId: row.effect_id,
    effectKey: row.effect_key,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    finishedAt: row.finished_at === null ? null : integer(row.finished_at, 'effect finished time'),
    operation: row.operation,
    providerResponseId: row.provider_response_id,
    requestSha256: requiredHash(row.request_sha256, 'Provider request hash'),
    response,
    responseSha256:
      row.response_sha256 === null
        ? null
        : requiredHash(row.response_sha256, 'Provider response hash'),
    revision: positiveInteger(row.revision, 'effect revision'),
    runId: row.run_id,
    state: row.state as ProviderEffectState,
    updatedAt: integer(row.updated_at, 'effect updated time'),
  });
}

function persistedOwnerSession(row: SessionRow): PersistedOwnerSession {
  const session = Object.freeze({
    createdAt: integer(row.issued_at, 'session creation time'),
    expiresAt: integer(row.expires_at, 'session expiry'),
    lastSeenAt: integer(row.last_seen_at, 'session last-seen time'),
    revision: positiveInteger(row.revision, 'session revision'),
    sessionIdHash: requiredHash(row.session_id_hash, 'Session id hash'),
  });
  validatePersistedOwnerSession(session);
  return session;
}

function validatePersistedOwnerSession(session: PersistedOwnerSession): void {
  assertHash(session.sessionIdHash, 'Session id hash');
  assertEpoch(session.createdAt, 'Session creation time');
  assertEpoch(session.expiresAt, 'Session expiry time');
  assertEpoch(session.lastSeenAt, 'Session last-seen time');
  assertPositiveInteger(session.revision, 'Session revision');
  if (
    session.lastSeenAt < session.createdAt ||
    session.lastSeenAt >= session.expiresAt ||
    session.createdAt >= session.expiresAt
  ) {
    throw new Error('Persisted owner session timestamps are inconsistent.');
  }
}

function ownerLoginThrottleState(
  row: LoginFailureRow | undefined,
  now: number,
): OwnerLoginThrottleState {
  if (!row) return Object.freeze({ status: 'allowed' });
  const state = parseLoginFailure(row);
  if (state.blockedUntil !== null && state.blockedUntil > now) {
    return Object.freeze({
      retryAfterSeconds: state.blockedUntil - now,
      status: 'rate_limited',
    });
  }
  return Object.freeze({ status: 'allowed' });
}

function parseLoginFailure(row: LoginFailureRow): StoredLoginThrottleState {
  return Object.freeze({
    blockedUntil:
      row.blocked_until === null ? null : integer(row.blocked_until, 'login blocked-until time'),
    failureCount: positiveInteger(row.failure_count, 'login failure count'),
    windowStartedAt: integer(row.window_started_at, 'login window start'),
  });
}

function sameProviderEffectResult(
  current: ProviderEffect,
  state: Exclude<ProviderEffectState, 'prepared'>,
  providerResponseId: string | null,
  responseSha256: string | null,
  errorCode: string | null,
  errorMessage: string | null,
): boolean {
  return (
    current.state === state &&
    current.providerResponseId === providerResponseId &&
    current.responseSha256 === responseSha256 &&
    current.errorCode === errorCode &&
    current.errorMessage === errorMessage
  );
}

function validatePolishRunInput(input: CreatePolishRunInput): void {
  assertIdentifier(input.runId, 'Polish run id');
  if (!isArticleId(input.articleId)) throw new Error('Polish article id is invalid.');
  assertHash(input.ownerSessionIdHash, 'Polish owner hash');
  assertHash(input.inputSha256, 'Polish input hash');
  if (!['rough', 'reference', 'developed', 'polish'].includes(input.mode)) {
    throw new Error('Polish mode is invalid.');
  }
  assertPositiveInteger(input.expectedArticleRevision, 'Expected article revision');
  if (input.instruction !== null) assertSafeInstruction(input.instruction);
  const jobKeys = Object.keys(input.job).toSorted();
  if (
    jobKeys.join('\0') !== ['idempotencyKey', 'maxAttempts', 'payload', 'type'].join('\0') ||
    input.job.type !== ARTICLE_POLISH_JOB_TYPE ||
    input.job.idempotencyKey !== `article-polish:${input.runId}` ||
    input.job.maxAttempts !== ARTICLE_POLISH_MAX_ATTEMPTS
  ) {
    throw new Error('Polish run job envelope is not canonical.');
  }
  const payload = parseArticlePolishJob(input.job.payload);
  if (
    payload.articleId !== input.articleId ||
    payload.expectedArticleRevision !== input.expectedArticleRevision ||
    payload.inputSha256 !== input.inputSha256 ||
    payload.runId !== input.runId ||
    payload.mode !== input.mode ||
    (payload.instruction ?? null) !== input.instruction
  ) {
    throw new Error('Polish run and durable job payload do not have identical lineage.');
  }
}

function assertSafeInstruction(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2_000 ||
    value !== value.trim() ||
    /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value)
  ) {
    throw new Error('A polish instruction must contain bounded safe text.');
  }
}

function assertArticleCapacity(database: SyncSqliteDatabase): void {
  const count = database.get<CountRow>('SELECT COUNT(*) AS count FROM articles');
  if (!count || integer(count.count, 'article count') >= ARTICLE_MAX_RECORDS) {
    throw new ArticleCapacityError();
  }
}

function assertArticleIdentity(id: string, expectedRevision: number): void {
  if (!isArticleId(id)) throw new Error('Article id is invalid.');
  assertPositiveInteger(expectedRevision, 'Expected article revision');
}

function assertArticleSequenceCapacity(database: SyncSqliteDatabase): void {
  const row = database.get<{ readonly sequence: number | bigint }>(
    `SELECT seq AS sequence FROM sqlite_sequence WHERE name = 'articles'`,
  );
  if (row && integer(row.sequence, 'article sequence') >= MAX_ARTICLE_SEQUENCE) {
    throw new ArticleSequenceCapacityError();
  }
}

function assertPolishRunSequenceCapacity(database: SyncSqliteDatabase): void {
  const row = database.get<{ readonly sequence: number | bigint }>(
    `SELECT seq AS sequence FROM sqlite_sequence WHERE name = 'polish_runs'`,
  );
  if (row && integer(row.sequence, 'polish run sequence') >= MAX_POLISH_RUN_SEQUENCE) {
    throw new PolishRunCapacityError();
  }
}

function assertRowCapacity(
  database: SyncSqliteDatabase,
  table: string,
  maximum: number,
  error: () => Error,
): void {
  const row = database.get<CountRow>(`SELECT COUNT(*) AS count FROM ${table}`);
  if (!row || integer(row.count, `${table} count`) >= maximum) throw error();
}

function beginArticleRetention(database: SyncSqliteDatabase): void {
  const result = database.run('INSERT INTO article_retention_guard(guard_key) VALUES (1)');
  if (result.changes !== 1) throw new Error('Article retention ownership was not acquired.');
}

function endArticleRetention(database: SyncSqliteDatabase): void {
  const result = database.run('DELETE FROM article_retention_guard WHERE guard_key = 1');
  if (result.changes !== 1) throw new Error('Article retention ownership was not released.');
}

function beginPolishRetention(database: SyncSqliteDatabase): void {
  const result = database.run('INSERT INTO polish_retention_guard(guard_key) VALUES (1)');
  if (result.changes !== 1) throw new Error('Polish retention ownership was not acquired.');
}

function endPolishRetention(database: SyncSqliteDatabase): void {
  const result = database.run('DELETE FROM polish_retention_guard WHERE guard_key = 1');
  if (result.changes !== 1) throw new Error('Polish retention ownership was not released.');
}

function assertWindowPolicy(maximum: number, windowMs: number, label: string): void {
  assertPositiveInteger(maximum, `${label} maximum`);
  assertPositiveInteger(windowMs, `${label} window`);
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function requiredHash(value: unknown, label: string): string {
  assertHash(value, label);
  return value;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) {
    throw new Error(`${label} must contain 8-128 safe identifier characters.`);
  }
}

function requiredFailure(value: unknown, label: string): string {
  assertSafeText(value, 1_000, label);
  return value;
}

function safePersistedFailure(value: unknown, fallback: string): string {
  if (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 1_000 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return value;
  }
  return fallback;
}

function assertSafeText(value: unknown, maximum: number, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} must contain bounded safe text.`);
  }
}

function canonicalTimestamp(epochMs: number): string {
  assertEpoch(epochMs, 'Article update time');
  return new Date(epochMs).toISOString();
}

function monotonicArticleMutation(
  database: SyncSqliteDatabase,
  record: ArticleRecord,
): ArticleRecord {
  const proposedEpochMs = Date.parse(record.updatedAt);
  if (!Number.isSafeInteger(proposedEpochMs) || proposedEpochMs < 0) {
    throw new Error('Proposed article update time is invalid.');
  }
  const row = database.get<{ readonly maximum: number | bigint | null }>(
    'SELECT MAX(updated_at_ms) AS maximum FROM articles',
  );
  if (!row) throw new Error('SQLite did not return the latest article update time.');
  const globalMaximum = row.maximum === null ? -1 : integer(row.maximum, 'article update time');
  const next = proposedEpochMs > globalMaximum ? proposedEpochMs : globalMaximum + 1;
  if (!Number.isSafeInteger(next) || next > 8_640_000_000_000_000) {
    throw new Error('Article update timestamp capacity has been reached.');
  }
  return Object.freeze({ ...record, updatedAt: canonicalTimestamp(next) });
}

function checkedClock(clock: () => number): number {
  const now = clock();
  assertEpoch(now, 'Persistence clock');
  return now;
}

function assertEpoch(value: number, label: string): void {
  assertNonNegativeInteger(value, label);
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function integer(value: number | bigint | null, label: string): number {
  if (value === null) throw new Error(`${label} is unexpectedly null.`);
  const normalized = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} is not a non-negative safe integer.`);
  }
  return normalized;
}

function positiveInteger(value: number | bigint, label: string): number {
  const normalized = integer(value, label);
  if (normalized < 1) throw new Error(`${label} is not positive.`);
  return normalized;
}

function safeAdd(value: number, amount: number, label: string): number {
  const result = value + amount;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} overflowed.`);
  return result;
}

function sqliteMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalJsonValue(value: JsonValue): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Provider response contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(',')}]`;
  const object = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(object[key] as JsonValue)}`)
    .join(',')}}`;
}

export function polishInputSha256(document: ArticleDocument): string {
  return sha256Hex(
    Buffer.from(
      JSON.stringify({
        body: document.body,
        imagePrompts: document.imagePrompts,
        ingress: document.ingress,
        pullQuotes: document.pullQuotes,
        socialPosts: document.socialPosts,
        tags: document.tags,
        title: document.title,
        topic: document.topic,
      }),
      'utf8',
    ),
  );
}
