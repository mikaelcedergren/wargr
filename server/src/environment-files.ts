import path from 'node:path';

import { releaseValidationEnvironmentValue } from '@mikaelcedergren/cx-framework/server/configuration';
import {
  loadPrivateEnvironmentFile,
  privateEnvironmentFileStartupMode,
  UnsupportedPrivateEnvironmentKeyError,
} from '@mikaelcedergren/cx-framework/server/private-environment';

import { resolveWargrOperationalRoot } from './environment.js';

export type WargrProcessRole = 'web' | 'worker';

const ROLE_FILES = Object.freeze({
  web: Object.freeze({
    allowedKeys: new Set([
      'WARGR_STUDIO_PASSWORD_HASH',
      'WARGR_STUDIO_SESSION_SECRET',
      'WARGR_STUDIO_USERNAME',
    ]),
    foreignPrivateKeys: ['OPENAI_API_KEY'] as const,
    name: '.env.web' as const,
  }),
  worker: Object.freeze({
    allowedKeys: new Set(['OPENAI_API_KEY']),
    foreignPrivateKeys: [
      'WARGR_STUDIO_PASSWORD_HASH',
      'WARGR_STUDIO_SESSION_SECRET',
      'WARGR_STUDIO_USERNAME',
    ] as const,
    name: '.env.worker' as const,
  }),
});

export function loadWargrEnvironmentFiles({
  environment = process.env,
  role,
}: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly role: WargrProcessRole;
}): void {
  const releaseValidation = releaseValidationEnvironmentValue(environment);
  const roleFile = ROLE_FILES[role];
  for (const name of roleFile.foreignPrivateKeys) delete environment[name];
  if (releaseValidation) {
    for (const name of roleFile.allowedKeys) delete environment[name];
    resolveWargrOperationalRoot(environment);
    return;
  }
  const mode = privateEnvironmentFileStartupMode({
    bypassKey: 'WARGR_LOAD_ENV_FILE',
    environment,
  });
  if (mode === 'skip') return;
  const operationalRoot = resolveWargrOperationalRoot(environment);
  try {
    loadPrivateEnvironmentFile({
      allowedKeys: roleFile.allowedKeys,
      environment,
      file: path.join(operationalRoot, roleFile.name),
      mode,
    });
  } catch (error) {
    if (error instanceof UnsupportedPrivateEnvironmentKeyError) {
      throw new Error(
        `Wargr ${roleFile.name} contains values outside its role allowlist: ${error.key}.`,
        { cause: error },
      );
    }
    throw error;
  }
}
