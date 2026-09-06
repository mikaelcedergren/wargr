import path from 'node:path';
import {
  verifyOwnedSqliteSnapshot,
  openOwnedSqliteDatabase,
} from '@mikaelcedergren/cx-framework/server/sqlite';
import {
  migrateWargrDatabase,
  verifyWargrDatabase,
  verifyWargrDatabaseBeforeWrite,
} from './database.js';

// This entrypoint never loads role secrets, starts a runtime, seeds records, or claims jobs.
// The registered offline candidate operator proves every writer stopped before invoking it.
const [command, flag, root, ...extra] = process.argv.slice(2);
if (
  !['migrate', 'quiesce', 'verify'].includes(command ?? '') ||
  flag !== '--operational-root' ||
  !root ||
  !path.isAbsolute(root) ||
  root !== path.normalize(root) ||
  extra.length
) {
  throw new Error(
    'Usage: database-maintenance.js <migrate|quiesce|verify> --operational-root <absolute-path>',
  );
}
const databasePath = path.join(root, 'data', 'wargr.db');
if (command === 'verify') {
  verifyOwnedSqliteSnapshot({ databasePath, operationalRoot: root, verify: verifyWargrDatabase });
} else {
  const opened = openOwnedSqliteDatabase({
    databasePath,
    operationalRoot: root,
    requireExisting: true,
    beforeWrite: verifyWargrDatabaseBeforeWrite,
    configuration: { busyTimeoutMs: 5000, journalMode: 'wal' },
  });
  try {
    if (command === 'migrate') migrateWargrDatabase(opened.database);
    const checkpoint = opened.database.get('PRAGMA wal_checkpoint(TRUNCATE)');
    if (
      !checkpoint ||
      checkpoint['busy'] !== 0 ||
      checkpoint['log'] !== 0 ||
      checkpoint['checkpointed'] !== 0
    ) {
      throw new Error('Database has an active connection; offline checkpoint failed.');
    }
    opened.verifyStorage();
  } finally {
    opened.close();
  }
}
process.stdout.write(
  JSON.stringify({ product: 'wargr', command, database: 'data/wargr.db', verified: true }) + '\n',
);
