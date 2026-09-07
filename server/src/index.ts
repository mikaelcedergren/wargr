import { loadWargrEnvironmentFiles } from './environment-files.js';
import { configureWargrLogging, log } from './logging.js';

configureWargrLogging('web');
try {
  loadWargrEnvironmentFiles({ role: 'web' });
  const { startWargrServer } = await import('./runtime.js');
  await startWargrServer({ entrypointUrl: import.meta.url });
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
