import { loadWargrEnvironmentFiles } from './environment-files.js';

loadWargrEnvironmentFiles({ role: 'web' });

const { startWargrServer } = await import('./runtime.js');
await startWargrServer({ entrypointUrl: import.meta.url });
