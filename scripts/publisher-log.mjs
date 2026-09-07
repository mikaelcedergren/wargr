import { randomUUID } from 'node:crypto';
import { createRuntimeLogger } from '@mikaelcedergren/cx-framework/server/logging';
const phases = {
  unchanged: ['skipped', 'INPUTS_UNCHANGED'],
  generating: ['started', 'GENERATING'],
  committed: ['success', 'SOURCE_COMMITTED'],
  released: ['success', 'RELEASE_VERIFIED'],
  failed: ['failure', 'TRANSACTION_FAILED'],
};
const phase = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(phases, phase))
  throw new Error('Unknown publisher logging phase.');
const [outcome, code] = phases[phase];
const suppliedRun = process.env.CX_PUBLISHER_RUN_ID;
const suppliedRelease = process.env.CX_PUBLISHER_RELEASE_ID;
const logger = createRuntimeLogger({
  identity: {
    service: 'wargr',
    role: 'publisher',
    environment: 'production',
    executionScope: 'production',
    pid: process.pid,
    releaseId: /^[a-f0-9]{64}$/.test(suppliedRelease ?? '') ? suppliedRelease : 'source',
  },
});
logger.emit({
  event: 'publisher.phase',
  level: outcome === 'failure' ? 'error' : 'info',
  category: 'operation',
  outcome,
  code,
  runId: /^[a-f0-9-]{36}$/.test(suppliedRun ?? '') ? suppliedRun : randomUUID(),
});
