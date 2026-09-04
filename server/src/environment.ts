import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  integerEnvironmentValue,
  localBindHost,
  nodeEnvironmentValue,
  portEnvironmentValue,
  releaseValidationEnvironmentValue,
  type Environment,
} from '@mikaelcedergren/cx-framework/server/configuration';
import { normalizeHttpOrigin } from '@mikaelcedergren/cx-framework/server/origin';
import { randomBase64UrlIdentifier } from '@mikaelcedergren/cx-framework/server/signing';

import {
  DEFAULT_OPENAI_MODEL,
  STUDIO_SESSION_DEFAULT_TTL_SECONDS,
  STUDIO_SESSION_MAXIMUM_TTL_SECONDS,
  WARGR_PUBLIC_ORIGIN,
  WARGR_WWW_ORIGIN,
} from './constants.js';
import { hashStudioPassword, parseStudioPasswordHash } from './password-hash.js';

export const WARGR_MANIFEST_FILE = fileURLToPath(new URL('../../cx-product.json', import.meta.url));
export const WARGR_ARTIFACT_ROOT = path.dirname(WARGR_MANIFEST_FILE);

interface WargrBaseEnvironment {
  readonly appOrigin: string;
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly isProduction: boolean;
  readonly nodeEnvironment: 'development' | 'production' | 'test';
  readonly operationalRoot: string;
  readonly polishEnabled: boolean;
  readonly releaseValidation: boolean;
}

export interface WargrEnvironment extends WargrBaseEnvironment {
  readonly browserDirectory: string;
  readonly browserDirectoryOverride: string | undefined;
  readonly cookieSecure: boolean;
  readonly host: string;
  readonly mutationOrigins: readonly string[];
  readonly port: number;
  readonly sessionSecret: string;
  readonly sessionTtlSeconds: number;
  readonly studioPasswordHash: string;
  readonly studioUsername: string;
}

export interface WargrWorkerEnvironment extends WargrBaseEnvironment {
  readonly providerApiKey: string | undefined;
  readonly providerBaseUrl: string | undefined;
  readonly providerModel: typeof DEFAULT_OPENAI_MODEL;
  readonly providerSafetyIdentifier: string | undefined;
}

export type WargrEnvironmentRole = 'web' | 'worker';

const DEVELOPMENT_STUDIO_USERNAME = 'dev';
const DEVELOPMENT_STUDIO_PASSWORD = 'dev';
const DEVELOPMENT_SESSION_SECRET = 'wargr-local-development-session-secret';

let developmentPasswordHash: string | undefined;

export function resolveWargrOperationalRoot(environment: Environment): string {
  const validation = releaseValidationEnvironmentValue(environment);
  const override = environment['CX_RUNTIME_ROOT'];
  if (override !== undefined && !validation) {
    throw new Error('CX_RUNTIME_ROOT is reserved for CX_RELEASE_VALIDATION=1.');
  }
  if (validation && override === undefined) {
    throw new Error('CX_RELEASE_VALIDATION=1 requires an absolute CX_RUNTIME_ROOT.');
  }
  if (override !== undefined && (!override || !path.isAbsolute(override))) {
    throw new Error('CX_RUNTIME_ROOT must be absolute during release validation.');
  }
  return realpathSync.native(path.resolve(override ?? process.cwd()));
}

export function loadWargrEnvironment(environment?: Environment, role?: 'web'): WargrEnvironment;
export function loadWargrEnvironment(
  environment: Environment | undefined,
  role: 'worker',
): WargrWorkerEnvironment;
export function loadWargrEnvironment(
  environment: Environment = process.env,
  role: WargrEnvironmentRole = 'web',
): WargrEnvironment | WargrWorkerEnvironment {
  const nodeEnvironment = nodeEnvironmentValue(environment);
  const releaseValidation = releaseValidationEnvironmentValue(environment);
  const isProduction = nodeEnvironment === 'production';

  const operationalRoot = resolveWargrOperationalRoot(environment);
  const port = role === 'web' ? portEnvironmentValue(environment, 'PORT', 3060) : undefined;
  const expectedProductionOrigin = releaseValidation ? 'http://127.0.0.1' : WARGR_PUBLIC_ORIGIN;
  const configuredOrigin = environment['APP_BASE_URL'];
  if (isProduction && configuredOrigin !== expectedProductionOrigin) {
    throw new Error(`APP_BASE_URL must be exactly ${expectedProductionOrigin} in production.`);
  }
  const appOrigin = normalizeHttpOrigin(
    configuredOrigin ?? `http://127.0.0.1:${String(port ?? 3060)}`,
  );
  const defaultDataDirectory = isProduction || releaseValidation ? 'data' : '.run/dev/data';
  const dataDirectory = resolveContainedPath(
    operationalRoot,
    environment['DATA_DIR'] ?? defaultDataDirectory,
    'DATA_DIR',
  );
  const databasePath = resolveContainedPath(
    operationalRoot,
    environment['DB_PATH'] ?? path.join(dataDirectory, 'wargr.db'),
    'DB_PATH',
  );
  if (isProduction) {
    const expectedDataDirectory = path.join(operationalRoot, 'data');
    const expectedDatabasePath = path.join(expectedDataDirectory, 'wargr.db');
    if (dataDirectory !== expectedDataDirectory) {
      throw new Error('DATA_DIR must resolve to the operational data directory in production.');
    }
    if (databasePath !== expectedDatabasePath) {
      throw new Error('DB_PATH must resolve to data/wargr.db in production.');
    }
  }
  const polishEnabled = binaryEnvironmentSwitch(
    environment,
    'ARTICLE_POLISH_ENABLED',
    isProduction ? undefined : environment['OPENAI_API_KEY'] !== undefined,
  );

  const base = {
    appOrigin,
    dataDirectory,
    databasePath,
    isProduction,
    nodeEnvironment,
    operationalRoot,
    polishEnabled,
    releaseValidation,
  } satisfies WargrBaseEnvironment;

  if (role === 'worker') {
    const providerBaseUrl = parseTestProviderBaseUrl(
      nodeEnvironment,
      optionalExactValue(environment, 'OPENAI_BASE_URL'),
    );
    const providerApiKey = optionalExactValue(environment, 'OPENAI_API_KEY');
    const providerModel =
      optionalExactValue(environment, 'WARGR_OPENAI_MODEL') ?? DEFAULT_OPENAI_MODEL;
    if (providerModel !== DEFAULT_OPENAI_MODEL) {
      throw new Error(`WARGR_OPENAI_MODEL must be exactly ${DEFAULT_OPENAI_MODEL}.`);
    }
    const providerSafetyIdentifier = optionalExactValue(
      environment,
      'WARGR_OPENAI_SAFETY_IDENTIFIER',
    );
    if (providerSafetyIdentifier !== undefined && providerSafetyIdentifier.length > 64) {
      throw new Error('WARGR_OPENAI_SAFETY_IDENTIFIER must contain at most 64 characters.');
    }
    return Object.freeze({
      ...base,
      providerApiKey,
      providerBaseUrl,
      providerModel,
      providerSafetyIdentifier,
    });
  }

  // Validation owns no operator credential: fresh unreachable values keep the real auth stack
  // composable without turning development defaults into a release-validation bypass.
  const studioUsername = releaseValidation
    ? randomBase64UrlIdentifier(32)
    : exactSecret(
        environment,
        'WARGR_STUDIO_USERNAME',
        isProduction ? undefined : DEVELOPMENT_STUDIO_USERNAME,
      );
  if (studioUsername.length > 256) {
    throw new Error('WARGR_STUDIO_USERNAME must contain at most 256 characters.');
  }
  const studioPasswordHash = releaseValidation
    ? hashStudioPassword(randomBase64UrlIdentifier(32))
    : exactSecret(
        environment,
        'WARGR_STUDIO_PASSWORD_HASH',
        isProduction ? undefined : developmentStudioPasswordHash(),
      );
  parseStudioPasswordHash(studioPasswordHash);
  const sessionSecret = releaseValidation
    ? randomBase64UrlIdentifier(32)
    : exactSecret(
        environment,
        'WARGR_STUDIO_SESSION_SECRET',
        isProduction ? undefined : DEVELOPMENT_SESSION_SECRET,
      );
  if (sessionSecret.length < 32) {
    throw new Error('WARGR_STUDIO_SESSION_SECRET must contain at least 32 characters.');
  }
  const sessionTtlSeconds = integerEnvironmentValue(environment, 'STUDIO_SESSION_TTL_SECONDS', {
    fallback: STUDIO_SESSION_DEFAULT_TTL_SECONDS,
    minimum: 1,
    maximum: STUDIO_SESSION_MAXIMUM_TTL_SECONDS,
  });
  const browserDirectory = path.join(operationalRoot, 'dist', 'browser');
  const browserDirectoryOverride = optionalExactValue(environment, 'SITE_BROWSER_DIR');
  if (browserDirectoryOverride !== undefined) {
    if (!path.isAbsolute(browserDirectoryOverride)) {
      throw new Error('SITE_BROWSER_DIR must be absolute when it is set.');
    }
    if (isProduction && !releaseValidation) {
      throw new Error(
        'SITE_BROWSER_DIR is available only to development, test, and release validation.',
      );
    }
    assertStrictlyContainedPath(operationalRoot, browserDirectoryOverride, 'SITE_BROWSER_DIR');
  }
  return Object.freeze({
    ...base,
    browserDirectory,
    browserDirectoryOverride,
    cookieSecure: isProduction && !releaseValidation,
    host: localBindHost(environment),
    mutationOrigins: Object.freeze(
      isProduction && !releaseValidation
        ? [WARGR_PUBLIC_ORIGIN, WARGR_WWW_ORIGIN]
        : releaseValidation
          ? [appOrigin]
          : developmentLoopbackOrigins(appOrigin),
    ),
    port: port!,
    sessionSecret,
    sessionTtlSeconds,
    studioPasswordHash,
    studioUsername,
  });
}

/**
 * Development and test bind to loopback, where `127.0.0.1` and `localhost` are one machine but two
 * browser origins. Both spellings are trusted so the owner's address-bar choice cannot turn a
 * local sign-in into an origin refusal. Production and release validation stay exact.
 */
function developmentLoopbackOrigins(appOrigin: string): readonly string[] {
  const url = new URL(appOrigin);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return [appOrigin];
  const siblingHost = url.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
  const sibling = new URL(appOrigin);
  sibling.hostname = siblingHost;
  return [appOrigin, normalizeHttpOrigin(sibling.origin)];
}

function developmentStudioPasswordHash(): string {
  developmentPasswordHash ??= hashStudioPassword(DEVELOPMENT_STUDIO_PASSWORD);
  return developmentPasswordHash;
}

function exactSecret(environment: Environment, name: string, fallback: string | undefined): string {
  const value = environment[name] ?? fallback;
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment value: ${name}.`);
  }
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must not contain surrounding whitespace or control characters.`);
  }
  return value;
}

function optionalExactValue(environment: Environment, name: string): string | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must be a non-empty exact value without control characters.`);
  }
  return value;
}

function binaryEnvironmentSwitch(
  environment: Environment,
  name: string,
  fallback: boolean | undefined,
): boolean {
  const value = environment[name];
  if (value === undefined) {
    if (fallback === undefined) throw new Error(`Missing required environment value: ${name}.`);
    return fallback;
  }
  if (value !== '0' && value !== '1') {
    throw new Error(`${name} must be exactly 0 or 1.`);
  }
  return value === '1';
}

function resolveContainedPath(root: string, configured: string, name: string): string {
  if (
    !configured ||
    configured !== configured.trim() ||
    /[\u0000-\u001f\u007f]/u.test(configured)
  ) {
    throw new Error(`${name} must be a non-empty safe path.`);
  }
  const resolved = path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.resolve(root, configured);
  assertStrictlyContainedPath(root, resolved, name);
  return resolved;
}

function assertStrictlyContainedPath(root: string, candidate: string, name: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${name} must remain strictly inside the operational root.`);
  }
}

function parseTestProviderBaseUrl(
  nodeEnvironment: WargrBaseEnvironment['nodeEnvironment'],
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (nodeEnvironment !== 'test') {
    throw new Error('OPENAI_BASE_URL is available only when NODE_ENV=test.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error('OPENAI_BASE_URL must be a valid loopback URL.', { cause: error });
  }
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/v1' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('OPENAI_BASE_URL must be an exact http://127.0.0.1:<port>/v1 loopback URL.');
  }
  return parsed.toString().replace(/\/$/, '');
}
