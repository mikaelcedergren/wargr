import { loadWargrEnvironmentFiles } from './environment-files.js';

loadWargrEnvironmentFiles({ role: 'worker' });

const { startWargrWorker } = await import('./worker-runtime.js');
await startWargrWorker({ entrypointUrl: import.meta.url });
