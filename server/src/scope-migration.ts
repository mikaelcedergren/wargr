import { assignLegacyDurableJobScopes } from '@mikaelcedergren/cx-framework/server/jobs';
import type { SyncSqliteDatabase } from '@mikaelcedergren/cx-framework/server/sqlite';

/** Offline only: classify reviewed jobs and their domain owners in one transaction. */
export function assignWargrLegacyJobScopes(
  database: SyncSqliteDatabase,
  assignments: Parameters<typeof assignLegacyDurableJobScopes>[0]['assignments'],
): number {
  return assignLegacyDurableJobScopes({
    database,
    assignments,
    afterAssign() {
      for (const { id, executionScope } of assignments) {
        database.run(
          "UPDATE polish_runs SET execution_scope = ? WHERE job_id = ? AND execution_scope = 'legacy'",
          [executionScope, id],
        );
        if (
          database.get('SELECT 1 FROM polish_runs WHERE job_id = ? AND execution_scope <> ?', [
            id,
            executionScope,
          ])
        ) {
          throw new Error('Legacy job and domain execution ownership disagree.');
        }
      }
    },
  });
}
