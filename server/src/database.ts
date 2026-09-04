import { DatabaseSync } from 'node:sqlite';

import {
  DURABLE_JOB_SCHEMA_MIGRATIONS,
  type DurableJobStore,
} from '@mikaelcedergren/cx-framework/server/jobs';
import {
  SQLITE_MIGRATION_LEDGER_TABLE,
  applySqliteMigrations,
  createPreparedSyncSqliteAdapter,
  openOwnedSqliteDatabase,
  verifySqliteIntegrity,
  type ReadonlySyncSqliteDatabase,
  type SqliteMigration,
  type SqliteRow,
  type SyncSqliteDatabase,
} from '@mikaelcedergren/cx-framework/server/sqlite';

import {
  ARTICLE_MAX_RECORDS,
  ARTICLE_MAX_RECORD_BYTES,
  ARTICLE_MAX_VERSIONS,
  ARTICLE_MAX_VERSIONS_PER_ARTICLE,
  MAX_POLISH_INSTRUCTION_CHARACTERS,
  sha256Hex,
} from './article-schema.js';

export const MAX_POLISH_RUNS = 2_000;
export const MAX_RETAINED_POLISH_JOBS = 2_000;
export const MAX_PROVIDER_EFFECTS = 8_000;
export const MAX_PROVIDER_EFFECTS_PER_RUN = 8;
export const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_PROVIDER_RESPONSE_BYTES_PER_RUN = 4 * 1024 * 1024;
export const MAX_PROVIDER_RESPONSE_TOTAL_BYTES = 512 * 1024 * 1024;

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

const ARTICLE_TABLE_SQL = `CREATE TABLE articles (
  article_sequence INTEGER PRIMARY KEY AUTOINCREMENT
    CHECK(article_sequence BETWEEN 1 AND 9007199254740991),
  id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('draft', 'published')),
  created_at TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  published_at TEXT,
  title TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  record_sha256 TEXT NOT NULL
    CHECK(length(record_sha256) = 64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_json BLOB NOT NULL CHECK(
    typeof(record_json) = 'blob' AND length(record_json) <= ${String(ARTICLE_MAX_RECORD_BYTES)}
  ),
  CHECK(state = 'draft' OR published_at IS NOT NULL)
) STRICT`;

const ARTICLE_VERSION_TABLE_SQL = `CREATE TABLE article_versions (
  version_sequence INTEGER PRIMARY KEY AUTOINCREMENT
    CHECK(version_sequence BETWEEN 1 AND 9007199254740991),
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  article_version INTEGER NOT NULL CHECK(article_version >= 1),
  source TEXT NOT NULL CHECK(source IN ('author', 'polish', 'import')),
  polish_run_id TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  record_sha256 TEXT NOT NULL
    CHECK(length(record_sha256) = 64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_json BLOB NOT NULL CHECK(
    typeof(record_json) = 'blob' AND length(record_json) <= ${String(ARTICLE_MAX_RECORD_BYTES)}
  ),
  UNIQUE(article_id, article_version),
  CHECK(
    (source = 'polish' AND polish_run_id IS NOT NULL)
    OR
    (source IN ('author', 'import') AND polish_run_id IS NULL)
  )
) STRICT`;

const OWNER_SESSION_TABLE_SQL = `CREATE TABLE owner_sessions (
  session_id_hash TEXT PRIMARY KEY
    CHECK(length(session_id_hash) = 64 AND session_id_hash NOT GLOB '*[^0-9a-f]*'),
  subject TEXT NOT NULL,
  issued_at INTEGER NOT NULL CHECK(issued_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK(last_seen_at >= issued_at),
  expires_at INTEGER NOT NULL CHECK(expires_at >= last_seen_at),
  absolute_expires_at INTEGER NOT NULL CHECK(absolute_expires_at >= expires_at),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at >= issued_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1)
) STRICT`;

const LOGIN_FAILURE_TABLE_SQL = `CREATE TABLE login_failure_windows (
  client_key_hash TEXT PRIMARY KEY
    CHECK(length(client_key_hash) = 64 AND client_key_hash NOT GLOB '*[^0-9a-f]*'),
  window_started_at INTEGER NOT NULL CHECK(window_started_at >= 0),
  failure_count INTEGER NOT NULL CHECK(failure_count >= 1),
  blocked_until INTEGER CHECK(blocked_until IS NULL OR blocked_until >= window_started_at),
  updated_at INTEGER NOT NULL CHECK(updated_at >= window_started_at)
) STRICT`;

const POLISH_WINDOW_TABLE_SQL = `CREATE TABLE polish_windows (
  owner_scope TEXT PRIMARY KEY CHECK(owner_scope = 'global-owner'),
  window_started_at INTEGER NOT NULL CHECK(window_started_at >= 0),
  window_duration_ms INTEGER NOT NULL CHECK(window_duration_ms >= 1),
  polish_count INTEGER NOT NULL CHECK(polish_count >= 1),
  updated_at INTEGER NOT NULL CHECK(updated_at >= window_started_at)
) STRICT`;

const POLISH_RUN_TABLE_SQL = `CREATE TABLE polish_runs (
  run_sequence INTEGER PRIMARY KEY AUTOINCREMENT
    CHECK(run_sequence BETWEEN 1 AND 9007199254740991),
  run_id TEXT NOT NULL UNIQUE,
  article_id TEXT NOT NULL,
  owner_session_id_hash TEXT NOT NULL
    CHECK(length(owner_session_id_hash) = 64
      AND owner_session_id_hash NOT GLOB '*[^0-9a-f]*'),
  mode TEXT NOT NULL CHECK(mode IN ('rough', 'reference', 'developed', 'polish')),
  instruction TEXT CHECK(
    instruction IS NULL
    OR length(instruction) BETWEEN 1 AND ${String(MAX_POLISH_INSTRUCTION_CHARACTERS)}
  ),
  input_sha256 TEXT NOT NULL
    CHECK(length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed', 'ambiguous')),
  expected_article_revision INTEGER NOT NULL CHECK(expected_article_revision >= 1),
  job_id TEXT NOT NULL UNIQUE,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  finished_at INTEGER CHECK(finished_at IS NULL OR finished_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  CHECK(
    (state IN ('queued', 'running') AND finished_at IS NULL)
    OR
    (state IN ('succeeded', 'failed', 'ambiguous') AND finished_at IS NOT NULL)
  ),
  CHECK(
    (state IN ('failed', 'ambiguous') AND error_code IS NOT NULL AND error_message IS NOT NULL)
    OR
    (state IN ('queued', 'running', 'succeeded') AND error_code IS NULL AND error_message IS NULL)
  )
) STRICT`;

const POLISH_RECEIPT_RECOVERY_TABLE_SQL = `CREATE TABLE polish_receipt_recoveries (
  run_id TEXT PRIMARY KEY REFERENCES polish_runs(run_id) ON DELETE CASCADE,
  original_job_id TEXT NOT NULL UNIQUE,
  recovery_job_id TEXT NOT NULL UNIQUE,
  recovered_at INTEGER NOT NULL CHECK(recovered_at >= 0),
  CHECK(original_job_id <> recovery_job_id)
) STRICT`;

const PROVIDER_EFFECT_TABLE_SQL = `CREATE TABLE provider_effects (
  effect_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES polish_runs(run_id) ON DELETE CASCADE,
  effect_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_sha256 TEXT NOT NULL
    CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL
    CHECK(state IN ('prepared', 'creating', 'submitted', 'polling', 'succeeded', 'rejected', 'ambiguous')),
  provider_response_id TEXT,
  response_sha256 TEXT
    CHECK(response_sha256 IS NULL
      OR (length(response_sha256) = 64 AND response_sha256 NOT GLOB '*[^0-9a-f]*')),
  response_json BLOB CHECK(
    response_json IS NULL
    OR (typeof(response_json) = 'blob' AND length(response_json) <= ${String(MAX_PROVIDER_RESPONSE_BYTES)})
  ),
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  finished_at INTEGER CHECK(finished_at IS NULL OR finished_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  UNIQUE(run_id, effect_key),
  CHECK(
    (state IN ('submitted', 'polling', 'succeeded') AND provider_response_id IS NOT NULL)
    OR
    (state IN ('prepared', 'creating', 'rejected', 'ambiguous'))
  ),
  CHECK(
    (state = 'succeeded' AND response_sha256 IS NOT NULL AND response_json IS NOT NULL)
    OR
    (state <> 'succeeded' AND response_sha256 IS NULL AND response_json IS NULL)
  ),
  CHECK(
    (state IN ('rejected', 'ambiguous') AND error_code IS NOT NULL AND error_message IS NOT NULL)
    OR
    (state NOT IN ('rejected', 'ambiguous') AND error_code IS NULL AND error_message IS NULL)
  ),
  CHECK(
    (state IN ('succeeded', 'rejected', 'ambiguous') AND finished_at IS NOT NULL)
    OR
    (state IN ('prepared', 'creating', 'submitted', 'polling') AND finished_at IS NULL)
  )
) STRICT`;

const PRODUCT_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'articles_and_bounded_versions',
    statements: Object.freeze([
      ARTICLE_TABLE_SQL,
      `CREATE INDEX articles_updated_idx ON articles(updated_at_ms DESC, article_sequence DESC)`,
      `CREATE INDEX articles_state_idx ON articles(state, updated_at_ms DESC)`,
      ARTICLE_VERSION_TABLE_SQL,
      `CREATE INDEX article_versions_article_idx
       ON article_versions(article_id, article_version DESC)`,
      `CREATE TABLE article_retention_guard (
         guard_key INTEGER PRIMARY KEY CHECK(guard_key = 1)
       ) STRICT`,
      `CREATE TRIGGER articles_capacity_guard
       BEFORE INSERT ON articles
       WHEN (SELECT COUNT(*) FROM articles) >= ${String(ARTICLE_MAX_RECORDS)}
       BEGIN
         SELECT RAISE(ABORT, 'article capacity reached');
       END`,
      `CREATE TRIGGER article_versions_capacity_guard
       BEFORE INSERT ON article_versions
       WHEN (SELECT COUNT(*) FROM article_versions) >= ${String(ARTICLE_MAX_VERSIONS)}
         OR (SELECT COUNT(*) FROM article_versions WHERE article_id = NEW.article_id)
            >= ${String(ARTICLE_MAX_VERSIONS_PER_ARTICLE)}
       BEGIN
         SELECT RAISE(ABORT, 'article version capacity reached');
       END`,
      `CREATE TRIGGER article_versions_delete_guard
       BEFORE DELETE ON article_versions
       WHEN NOT EXISTS (SELECT 1 FROM article_retention_guard WHERE guard_key = 1)
         AND EXISTS (SELECT 1 FROM articles WHERE id = OLD.article_id)
       BEGIN
         SELECT RAISE(ABORT, 'article versions may only be deleted by retention maintenance');
       END`,
    ] as const),
  }),
  Object.freeze({
    version: 2,
    name: 'persistent_owner_auth_and_polish_windows',
    statements: Object.freeze([
      OWNER_SESSION_TABLE_SQL,
      `CREATE INDEX owner_sessions_expiry_idx ON owner_sessions(expires_at, session_id_hash)`,
      LOGIN_FAILURE_TABLE_SQL,
      `CREATE INDEX login_failure_windows_updated_idx
       ON login_failure_windows(updated_at, client_key_hash)`,
      POLISH_WINDOW_TABLE_SQL,
      `CREATE INDEX polish_windows_updated_idx
       ON polish_windows(updated_at, owner_scope)`,
      `CREATE TRIGGER owner_sessions_capacity_guard
       BEFORE INSERT ON owner_sessions
       WHEN (SELECT COUNT(*) FROM owner_sessions WHERE revoked_at IS NULL) >= 64
       BEGIN
         SELECT RAISE(ABORT, 'owner session capacity reached');
       END`,
      `CREATE TRIGGER login_failure_windows_capacity_guard
       BEFORE INSERT ON login_failure_windows
       WHEN (SELECT COUNT(*) FROM login_failure_windows) >= 10000
       BEGIN
         SELECT RAISE(ABORT, 'login failure window capacity reached');
       END`,
      `CREATE TRIGGER polish_windows_capacity_guard
       BEFORE INSERT ON polish_windows
       WHEN (SELECT COUNT(*) FROM polish_windows) >= 1000
       BEGIN
         SELECT RAISE(ABORT, 'polish window capacity reached');
       END`,
    ] as const),
  }),
  Object.freeze({
    version: 3,
    name: 'polish_runs_and_provider_effect_receipts',
    statements: Object.freeze([
      POLISH_RUN_TABLE_SQL,
      `CREATE INDEX polish_runs_article_idx
       ON polish_runs(article_id, run_sequence DESC)`,
      `CREATE UNIQUE INDEX polish_runs_one_active_article
       ON polish_runs(article_id)
       WHERE state IN ('queued', 'running')`,
      POLISH_RECEIPT_RECOVERY_TABLE_SQL,
      PROVIDER_EFFECT_TABLE_SQL,
      `CREATE TABLE polish_retention_guard (
         guard_key INTEGER PRIMARY KEY CHECK(guard_key = 1)
       ) STRICT`,
      `CREATE INDEX provider_effects_run_idx
       ON provider_effects(run_id, created_at, effect_id)`,
      `CREATE TRIGGER polish_runs_capacity_guard
       BEFORE INSERT ON polish_runs
       WHEN (SELECT COUNT(*) FROM polish_runs) >= ${String(MAX_POLISH_RUNS)}
       BEGIN
         SELECT RAISE(ABORT, 'polish run aggregate capacity reached');
       END`,
      `CREATE TRIGGER provider_effects_capacity_guard
       BEFORE INSERT ON provider_effects
       WHEN (SELECT COUNT(*) FROM provider_effects) >= ${String(MAX_PROVIDER_EFFECTS)}
         OR (SELECT COUNT(*) FROM provider_effects WHERE run_id = NEW.run_id)
            >= ${String(MAX_PROVIDER_EFFECTS_PER_RUN)}
       BEGIN
         SELECT RAISE(ABORT, 'provider effect aggregate capacity reached');
       END`,
      `CREATE TRIGGER provider_effects_response_capacity_guard
       BEFORE UPDATE OF response_json ON provider_effects
       WHEN NEW.response_json IS NOT NULL
         AND OLD.response_json IS NULL
         AND (
           (SELECT COALESCE(SUM(length(response_json)), 0)
            FROM provider_effects WHERE run_id = NEW.run_id)
             + length(NEW.response_json) > ${String(MAX_PROVIDER_RESPONSE_BYTES_PER_RUN)}
           OR
           (SELECT COALESCE(SUM(length(response_json)), 0) FROM provider_effects)
             + length(NEW.response_json) > ${String(MAX_PROVIDER_RESPONSE_TOTAL_BYTES)}
         )
       BEGIN
         SELECT RAISE(ABORT, 'provider response aggregate capacity reached');
       END`,
    ] as const),
  }),
  Object.freeze({
    version: 4,
    name: 'optimistic_revision_and_effect_transition_guards',
    statements: Object.freeze([
      `CREATE TRIGGER articles_revision_guard
       BEFORE UPDATE ON articles
       WHEN NEW.revision <> OLD.revision + 1
         OR NEW.article_sequence IS NOT OLD.article_sequence
         OR NEW.id IS NOT OLD.id
         OR NEW.created_at IS NOT OLD.created_at
         OR NEW.created_at_ms IS NOT OLD.created_at_ms
         OR (OLD.state = 'published' AND NEW.state = 'published' AND NEW.slug IS NOT OLD.slug)
       BEGIN
         SELECT RAISE(ABORT, 'article update violates immutable identity or revision');
       END`,
      `CREATE TRIGGER articles_active_polish_delete_guard
       BEFORE DELETE ON articles
       WHEN EXISTS (
         SELECT 1 FROM polish_runs
         WHERE article_id = OLD.id AND state IN ('queued', 'running')
       )
       BEGIN
         SELECT RAISE(ABORT, 'article has an active polish run');
       END`,
      `CREATE TRIGGER articles_published_delete_guard
       BEFORE DELETE ON articles
       WHEN OLD.state = 'published'
       BEGIN
         SELECT RAISE(ABORT, 'a published article must be unpublished before deletion');
       END`,
      `CREATE TRIGGER owner_sessions_revision_guard
       BEFORE UPDATE ON owner_sessions
       WHEN NEW.revision <> OLD.revision + 1
         OR NEW.session_id_hash IS NOT OLD.session_id_hash
         OR NEW.subject IS NOT OLD.subject
         OR NEW.issued_at IS NOT OLD.issued_at
         OR NEW.expires_at IS NOT OLD.expires_at
         OR NEW.absolute_expires_at IS NOT OLD.absolute_expires_at
         OR NEW.last_seen_at < OLD.last_seen_at
       BEGIN
         SELECT RAISE(ABORT, 'owner session update violates immutable identity or revision');
       END`,
      `CREATE TRIGGER polish_runs_revision_guard
       BEFORE UPDATE ON polish_runs
       WHEN NEW.revision <> OLD.revision + 1
         OR NEW.run_id IS NOT OLD.run_id
         OR NEW.run_sequence IS NOT OLD.run_sequence
         OR NEW.article_id IS NOT OLD.article_id
         OR NEW.owner_session_id_hash IS NOT OLD.owner_session_id_hash
         OR NEW.mode IS NOT OLD.mode
         OR NEW.instruction IS NOT OLD.instruction
         OR NEW.input_sha256 IS NOT OLD.input_sha256
         OR NEW.expected_article_revision IS NOT OLD.expected_article_revision
         OR (
           NEW.job_id IS NOT OLD.job_id
           AND NOT EXISTS (
             SELECT 1 FROM polish_receipt_recoveries AS recovery
             WHERE recovery.run_id = OLD.run_id
               AND recovery.original_job_id = OLD.job_id
               AND recovery.recovery_job_id = NEW.job_id
           )
         )
         OR NEW.attempt IS NOT OLD.attempt
         OR NEW.created_at IS NOT OLD.created_at
         OR NOT (
           (
             NEW.job_id IS OLD.job_id
             AND (
               (OLD.state = 'queued' AND NEW.state = 'running')
               OR (OLD.state = 'queued' AND NEW.state IN ('failed', 'ambiguous'))
               OR (OLD.state = 'running' AND NEW.state IN ('succeeded', 'failed', 'ambiguous'))
             )
           )
           OR (
             OLD.state = 'running' AND NEW.state = 'running'
             AND NEW.job_id IS NOT OLD.job_id
             AND EXISTS (
               SELECT 1 FROM polish_receipt_recoveries AS recovery
               WHERE recovery.run_id = OLD.run_id
                 AND recovery.original_job_id = OLD.job_id
                 AND recovery.recovery_job_id = NEW.job_id
             )
           )
         )
       BEGIN
         SELECT RAISE(ABORT, 'polish run update violates identity, revision, or state');
       END`,
      `CREATE TRIGGER provider_effects_transition_guard
       BEFORE UPDATE ON provider_effects
       WHEN NEW.revision <> OLD.revision + 1
         OR NEW.effect_id IS NOT OLD.effect_id
         OR NEW.run_id IS NOT OLD.run_id
         OR NEW.effect_key IS NOT OLD.effect_key
         OR NEW.operation IS NOT OLD.operation
         OR NEW.request_sha256 IS NOT OLD.request_sha256
         OR NEW.created_at IS NOT OLD.created_at
         OR NOT (
           (OLD.state = 'prepared' AND NEW.state = 'creating')
           OR (OLD.state = 'creating' AND NEW.state IN ('submitted', 'rejected', 'ambiguous'))
           OR (OLD.state = 'submitted' AND NEW.state IN ('polling', 'succeeded', 'rejected', 'ambiguous'))
           OR (OLD.state = 'polling' AND NEW.state IN ('polling', 'succeeded', 'rejected', 'ambiguous'))
         )
       BEGIN
         SELECT RAISE(ABORT, 'provider effect transition is not replay-safe');
       END`,
      `CREATE TRIGGER polish_runs_delete_guard
       BEFORE DELETE ON polish_runs
       WHEN NOT EXISTS (SELECT 1 FROM polish_retention_guard WHERE guard_key = 1)
       BEGIN
         SELECT RAISE(ABORT, 'polish aggregates may only be deleted by retention maintenance');
       END`,
      `CREATE TRIGGER provider_effects_delete_guard
       BEFORE DELETE ON provider_effects
       WHEN NOT EXISTS (SELECT 1 FROM polish_retention_guard WHERE guard_key = 1)
       BEGIN
         SELECT RAISE(ABORT, 'provider effect receipts may only be deleted with their run aggregate');
       END`,
    ] as const),
  }),
] as const satisfies readonly SqliteMigration[]);

const JOB_MIGRATIONS = DURABLE_JOB_SCHEMA_MIGRATIONS.map((migration) =>
  Object.freeze({
    version: PRODUCT_MIGRATIONS.length + migration.version,
    name: `shared_${migration.name}`,
    statements: migration.statements,
  }),
);

export const WARGR_MIGRATIONS = Object.freeze([
  ...PRODUCT_MIGRATIONS,
  ...JOB_MIGRATIONS,
] as const satisfies readonly SqliteMigration[]);

const REQUIRED_TABLES = Object.freeze([
  SQLITE_MIGRATION_LEDGER_TABLE,
  'articles',
  'article_versions',
  'article_retention_guard',
  'owner_sessions',
  'login_failure_windows',
  'polish_windows',
  'polish_runs',
  'polish_receipt_recoveries',
  'provider_effects',
  'polish_retention_guard',
  'cx_jobs',
]);

interface MigrationIdentityRow extends SqliteRow {
  readonly name: string;
  readonly version: number | bigint;
}

interface MigrationLedgerRow extends MigrationIdentityRow {
  readonly applied_at: string;
  readonly fingerprint: string;
}

interface FullSchemaRow extends SqliteRow {
  readonly name: string;
  readonly sql: string | null;
  readonly tbl_name: string;
  readonly type: string;
}

const canonicalSchemaByMigrationCount = new Map<number, readonly FullSchemaRow[]>();

interface OpenWargrDatabaseBaseOptions {
  readonly databasePath: string;
  readonly migrate?: boolean;
  readonly now?: () => string;
  readonly operationalRoot: string;
}

export type OpenWargrDatabaseOptions = OpenWargrDatabaseBaseOptions &
  (
    | {
        readonly requireExisting?: false;
        readonly verifyBeforeWrite?: never;
      }
    | {
        /**
         * Open an already-sealed authority without creating any missing path component. The
         * verifier runs on the exact connection that remains the writable persistence owner,
         * before journal configuration, migrations, or any other write-capable statement.
         */
        readonly requireExisting: true;
        readonly verifyBeforeWrite: (database: ReadonlySyncSqliteDatabase) => void;
      }
  );

export interface WargrDatabase {
  readonly databasePath: string;
  readonly sqlite: SyncSqliteDatabase;
  close(): void;
  isReady(): boolean;
}

export interface WargrPersistenceDatabase extends WargrDatabase {
  readonly jobs?: DurableJobStore;
}

export function openWargrDatabase(options: OpenWargrDatabaseOptions): WargrDatabase {
  const {
    databasePath,
    migrate = true,
    now = () => new Date().toISOString(),
    operationalRoot,
  } = options;
  const owned = openOwnedSqliteDatabase({
    configuration: {
      busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
      journalMode: 'wal',
    },
    databasePath,
    operationalRoot,
    ...(options.requireExisting
      ? {
          requireExisting: true as const,
          beforeWrite: options.verifyBeforeWrite,
        }
      : {}),
  });
  const sqlite = owned.database;
  let closed = false;
  try {
    if (migrate) migrateWargrDatabase(sqlite, now);
    else verifyWargrDatabase(sqlite);
    owned.verifyStorage();
  } catch (error) {
    try {
      owned.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'Wargr database opening failed and SQLite could not be closed.',
      );
    }
    throw error;
  }
  return Object.freeze({
    databasePath: owned.databasePath,
    sqlite,
    close() {
      if (closed) return;
      closed = true;
      owned.close();
    },
    isReady() {
      if (closed) return false;
      try {
        owned.verifyStorage();
        verifyWargrDatabaseReadiness(sqlite);
        return true;
      } catch {
        return false;
      }
    },
  });
}

export function migrateWargrDatabase(
  database: SyncSqliteDatabase,
  now: () => string = () => new Date().toISOString(),
): void {
  const result = applySqliteMigrations(database, WARGR_MIGRATIONS, {
    fingerprint: sha256Hex,
    now,
  });
  const expected = WARGR_MIGRATIONS.at(-1)?.version ?? 0;
  if (result.currentVersion !== expected) {
    throw new Error('Wargr database did not reach the canonical migration version.');
  }
  verifyWargrDatabase(database);
}

export function verifyWargrDatabase(database: ReadonlySyncSqliteDatabase): void {
  verifySqliteIntegrity(database);
  verifyWargrCurrentMigrationLedger(database);
  verifyWargrCurrentSchema(database);
  verifyWargrDatabaseReadiness(database);
}

/**
 * Prove the complete existing authority before a production database may migrate. The ledger
 * may be an older exact prefix of the current definitions; its canonical application times and the
 * entire schema produced by precisely that compiled prefix must match before any pending statement.
 */
export function verifyWargrDatabaseBeforeWrite(database: ReadonlySyncSqliteDatabase): void {
  verifySqliteIntegrity(database);
  const ledger = database.all<MigrationLedgerRow>(
    `SELECT version, name, fingerprint, applied_at
     FROM ${SQLITE_MIGRATION_LEDGER_TABLE}
     ORDER BY version
     LIMIT ?`,
    [WARGR_MIGRATIONS.length + 1],
  );
  if (ledger.length < 1 || ledger.length > WARGR_MIGRATIONS.length) {
    throw new Error('Wargr migration foundation is not a known non-empty prefix.');
  }
  for (const [index, row] of ledger.entries()) {
    const migration = WARGR_MIGRATIONS[index];
    if (
      !migration ||
      sqliteInteger(row.version, 'migration foundation version') !== migration.version ||
      row.name !== migration.name ||
      row.fingerprint !== migrationFingerprint(migration) ||
      !isCanonicalMigrationTimestamp(row.applied_at)
    ) {
      throw new Error('Wargr migration foundation is not the canonical contiguous prefix.');
    }
  }
  verifyWargrSchema(database, ledger.length, 'migration foundation');
}

/**
 * Constant-size health probe. Full integrity and foreign-key verification belongs at startup,
 * import, backup, and restore boundaries; a request-time `/healthz` probe must stay fast.
 */
export function verifyWargrDatabaseReadiness(database: ReadonlySyncSqliteDatabase): void {
  const objects = new Set(
    database
      .all<{ readonly name: string; readonly type: string }>(
        `SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view')`,
      )
      .filter((row) => row.type === 'table')
      .map((row) => row.name),
  );
  for (const table of REQUIRED_TABLES) {
    if (!objects.has(table)) throw new Error(`Wargr database is missing table ${table}.`);
  }
  const rows = database.all<MigrationIdentityRow>(
    `SELECT version, name FROM ${SQLITE_MIGRATION_LEDGER_TABLE} ORDER BY version`,
  );
  if (rows.length !== WARGR_MIGRATIONS.length) {
    throw new Error('Wargr migration ledger length is not canonical.');
  }
  for (const [index, migration] of WARGR_MIGRATIONS.entries()) {
    const row = rows[index];
    if (
      !row ||
      sqliteInteger(row.version, 'migration version') !== migration.version ||
      row.name !== migration.name
    ) {
      throw new Error('Wargr migration ledger is not the canonical contiguous history.');
    }
  }
  for (const guardTable of ['article_retention_guard', 'polish_retention_guard'] as const) {
    const guard = database.get<{ readonly count: number | bigint }>(
      `SELECT COUNT(*) AS count FROM ${guardTable}`,
    );
    if (!guard || sqliteInteger(guard.count, 'retention guard count') !== 0) {
      throw new Error(`Wargr ${guardTable} is not quiescent.`);
    }
  }
}

/**
 * Prove every row of the exact current compiled migration ledger. Historical application times are
 * data rather than compiled constants, but they must retain the one canonical UTC representation
 * emitted by the product migration clock.
 */
function verifyWargrCurrentMigrationLedger(database: ReadonlySyncSqliteDatabase): void {
  const ledger = database.all<MigrationLedgerRow>(
    `SELECT version, name, fingerprint, applied_at
     FROM ${SQLITE_MIGRATION_LEDGER_TABLE}
     ORDER BY version
     LIMIT ?`,
    [WARGR_MIGRATIONS.length + 1],
  );
  if (ledger.length !== WARGR_MIGRATIONS.length) {
    throw new Error('Wargr current migration ledger length is not canonical.');
  }
  for (const [index, migration] of WARGR_MIGRATIONS.entries()) {
    const row = ledger[index];
    if (
      !row ||
      sqliteInteger(row.version, 'current migration version') !== migration.version ||
      row.name !== migration.name ||
      row.fingerprint !== migrationFingerprint(migration) ||
      !isCanonicalMigrationTimestamp(row.applied_at)
    ) {
      throw new Error(
        `Wargr current migration ledger row ${String(migration.version)} does not match its compiled definition.`,
      );
    }
  }
}

/**
 * Compare the complete main-schema catalogue with a disposable in-memory database produced by the
 * same compiled migration set and SQLite engine. This includes every product table, index,
 * trigger, and the migration ledger while rejecting missing, altered, or extra product objects.
 * SQLite's engine-owned `sqlite_*` implementation objects are deliberately outside this contract.
 */
function verifyWargrCurrentSchema(database: ReadonlySyncSqliteDatabase): void {
  verifyWargrSchema(database, WARGR_MIGRATIONS.length, 'current');
}

function verifyWargrSchema(
  database: ReadonlySyncSqliteDatabase,
  migrationCount: number,
  scope: 'current' | 'migration foundation',
): void {
  const expected = getCanonicalSchema(migrationCount);
  const actual = readCurrentSchema(database, expected.length + 1);
  if (actual.length !== expected.length) {
    throw new Error(`Wargr ${scope} sqlite_schema object set is not canonical.`);
  }
  for (const [index, expectedRow] of expected.entries()) {
    const actualRow = actual[index];
    if (
      !actualRow ||
      actualRow.type !== expectedRow.type ||
      actualRow.name !== expectedRow.name ||
      actualRow.tbl_name !== expectedRow.tbl_name ||
      actualRow.sql !== expectedRow.sql
    ) {
      throw new Error(
        `Wargr ${scope} sqlite_schema differs from its compiled definition at ${expectedRow.type} ${expectedRow.name}.`,
      );
    }
  }
}

function getCanonicalSchema(migrationCount: number): readonly FullSchemaRow[] {
  const existing = canonicalSchemaByMigrationCount.get(migrationCount);
  if (existing) return existing;
  if (migrationCount < 1 || migrationCount > WARGR_MIGRATIONS.length) {
    throw new Error('Wargr schema proof requires one known compiled migration prefix.');
  }
  const native = new DatabaseSync(':memory:');
  try {
    const database = createPreparedSyncSqliteAdapter(native);
    applySqliteMigrations(database, WARGR_MIGRATIONS.slice(0, migrationCount), {
      fingerprint: sha256Hex,
      now: () => '2000-01-01T00:00:00.000Z',
    });
    const schema = readCurrentSchema(database);
    canonicalSchemaByMigrationCount.set(migrationCount, schema);
    return schema;
  } finally {
    native.close();
  }
}

function readCurrentSchema(
  database: ReadonlySyncSqliteDatabase,
  limit?: number,
): readonly FullSchemaRow[] {
  const rows = database.all<FullSchemaRow>(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_schema
     WHERE name NOT GLOB 'sqlite_*'
     ORDER BY type, name, tbl_name
     ${limit === undefined ? '' : 'LIMIT ?'}`,
    limit === undefined ? [] : [limit],
  );
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        ...row,
        sql: row.sql === null ? null : normalizeSchemaSql(row.sql),
      }),
    ),
  );
}

function normalizeSchemaSql(value: string): string {
  let result = '';
  let quotedBy: "'" | '"' | '`' | '[' | undefined;
  let whitespace = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (!character) continue;
    if (quotedBy) {
      result += character;
      const closing = quotedBy === '[' ? ']' : quotedBy;
      if (character === closing) {
        if (value[index + 1] === closing) {
          result += closing;
          index += 1;
        } else {
          quotedBy = undefined;
        }
      }
      continue;
    }
    if (/\s/u.test(character)) {
      whitespace = result.length > 0;
      continue;
    }
    if (whitespace) result += ' ';
    whitespace = false;
    result += character;
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      quotedBy = character;
    }
  }
  return result;
}

function migrationFingerprint(migration: SqliteMigration): string {
  return sha256Hex(
    JSON.stringify({
      name: migration.name,
      statements: migration.statements,
      version: migration.version,
    }),
  );
}

function isCanonicalMigrationTimestamp(value: string): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function sqliteInteger(value: number | bigint, label: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`SQLite ${label} is not a non-negative safe integer.`);
  }
  return number;
}
