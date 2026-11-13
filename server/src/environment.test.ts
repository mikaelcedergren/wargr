import assert from 'node:assert/strict';
import test from 'node:test';

import { loadWargrEnvironmentFiles } from './environment-files.js';
import { loadWargrEnvironment } from './environment.js';
import { verifyAdminPassword } from './password-hash.js';

const environment = {
  NODE_ENV: 'test',
  CX_EXECUTION_SCOPE: 'test',
  CX_DATA_MODE: 'isolated',
  CX_SCHEDULE_OWNER: 'false',
  WARGR_LOAD_ENV_FILE: 'false',
  WARGR_STUDIO_USERNAME: 'admin',
  WARGR_STUDIO_PASSWORD: 'Synthetic-password-!$#=',
};

test('the configured plain password becomes an in-memory hash', () => {
  const loaded = loadWargrEnvironment(environment);
  assert.equal(loaded.adminUsername, 'admin');
  assert.notEqual(loaded.adminPasswordHash, environment.WARGR_STUDIO_PASSWORD);
  assert.equal(
    verifyAdminPassword(environment.WARGR_STUDIO_PASSWORD, loaded.adminPasswordHash),
    true,
  );
  assert.equal(verifyAdminPassword('wrong-password', loaded.adminPasswordHash), false);
  assert.equal(JSON.stringify(loaded).includes(environment.WARGR_STUDIO_PASSWORD), false);
});

test('invalid configured passwords fail at startup without exposing their value', () => {
  for (const password of ['', ' leading', 'trailing ', 'control\nvalue', 'a'.repeat(257)]) {
    assert.throws(() => loadWargrEnvironment({ ...environment, WARGR_STUDIO_PASSWORD: password }));
  }
});

test('the worker drops web credentials from its environment', () => {
  const worker: NodeJS.ProcessEnv = {
    ...environment,
    WARGR_STUDIO_SESSION_SECRET: 'synthetic-secret',
  };
  loadWargrEnvironmentFiles({ environment: worker, role: 'worker' });
  assert.equal(worker['WARGR_STUDIO_PASSWORD'], undefined);
  assert.equal(worker['WARGR_STUDIO_USERNAME'], undefined);
  assert.equal(worker['WARGR_STUDIO_SESSION_SECRET'], undefined);
});
