import { loadWargrEnvironmentFiles } from './environment-files.js';
import { configureWargrLogging, log } from './logging.js';

configureWargrLogging('jobs');
try {
  loadWargrEnvironmentFiles({ role: 'worker' });
  const { startWargrWorker } = await import('./worker-runtime.js');
  await startWargrWorker({ entrypointUrl: import.meta.url });
} catch (error) {
  log.emit({
    event: 'process.start_failed',
    level: 'fatal',
    category: 'diagnostic',
    outcome: 'failure',
    error,
  });
  process.exitCode = 1;
}
