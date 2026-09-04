import { loadProductManifestFile } from '@mikaelcedergren/cx-framework/server/product-manifest';
import { assertServerProcessRole } from '@mikaelcedergren/cx-framework/server/process-role';
import {
  loadServerReleaseIdentity,
  type ServerReleaseIdentity,
} from '@mikaelcedergren/cx-framework/server/server-identity';
import {
  bindShutdownSignals,
  type GracefulShutdown,
} from '@mikaelcedergren/cx-framework/server/shutdown';
import {
  acquireServerWorkerReadinessLease,
  createServerWorkerReadiness,
  signalServerWorkerReadiness,
  type ServerWorkerReadinessLease,
} from '@mikaelcedergren/cx-framework/server/worker-readiness';

import { createWargrPersistence, type WargrPersistence } from './article-repository.js';
import { WARGR_PRODUCT_ID } from './constants.js';
import {
  WARGR_ARTIFACT_ROOT,
  WARGR_MANIFEST_FILE,
  loadWargrEnvironment,
  type WargrWorkerEnvironment,
} from './environment.js';
import { createArticlePolishWorker, type ArticlePolishWorkerLoop } from './polish-worker.js';
import { verifyWargrDatabaseBeforeWrite } from './database.js';
import { createOpenAiResponsesProvider } from './openai-provider.js';
import { assertWargrProductManifest } from './product-contract.js';

export const WARGR_WORKER_KEY = 'jobs';

const WORKER_DRAIN_TIMEOUT_MS = 10_000;

export interface WargrWorkerRuntime {
  readonly claimsEnabled: boolean;
  readonly environment: WargrWorkerEnvironment;
  readonly identity: ServerReleaseIdentity | undefined;
  readonly kind: 'worker';
  readonly persistence: WargrPersistence;
  readonly readinessLease: ServerWorkerReadinessLease | undefined;
  readonly shutdown: GracefulShutdown;
  readonly worker: ArticlePolishWorkerLoop;
}

export interface WargrWorkerValidation {
  readonly environment: WargrWorkerEnvironment;
  readonly identity: ServerReleaseIdentity;
  readonly kind: 'release-validation';
  readonly persistence: WargrPersistence;
  readonly shutdown: GracefulShutdown;
}

export async function startWargrWorker({
  acquireReadinessLease = acquireServerWorkerReadinessLease,
  entrypointUrl,
  environment: sourceEnvironment = process.env,
  releaseValidationReference = releaseProcessValidationReference,
  signalReadiness = signalServerWorkerReadiness,
  signals = process,
}: {
  readonly acquireReadinessLease?: typeof acquireServerWorkerReadinessLease;
  readonly entrypointUrl: string | URL;
  readonly environment?: NodeJS.ProcessEnv;
  readonly releaseValidationReference?: () => void;
  readonly signalReadiness?: typeof signalServerWorkerReadiness;
  readonly signals?: Parameters<typeof bindShutdownSignals>[0]['signals'];
}): Promise<WargrWorkerRuntime | WargrWorkerValidation> {
  const environment = loadWargrEnvironment(sourceEnvironment, 'worker');
  const { manifest } = loadProductManifestFile(WARGR_MANIFEST_FILE);
  assertWargrProductManifest(manifest);
  if (manifest.id !== WARGR_PRODUCT_ID) {
    throw new Error('Wargr worker manifest identity is invalid.');
  }

  const identity = loadServerReleaseIdentity({
    environment: sourceEnvironment,
    required: environment.isProduction || environment.releaseValidation,
  });
  if (identity) {
    assertServerProcessRole({
      artifactRoot: WARGR_ARTIFACT_ROOT,
      entrypointUrl,
      identity,
      role: { key: WARGR_WORKER_KEY, kind: 'worker' },
    });
  }

  const persistence = createWargrPersistence({
    databasePath: environment.databasePath,
    operationalRoot: environment.operationalRoot,
    ...(environment.isProduction && !environment.releaseValidation
      ? {
          requireExisting: true as const,
          verifyBeforeWrite: verifyWargrDatabaseBeforeWrite,
        }
      : {}),
  });
  let persistenceOpen = true;
  try {
    if (environment.releaseValidation) {
      if (!identity) {
        throw new Error('Wargr worker validation requires a sealed server identity.');
      }
      let closing: Promise<void> | undefined;
      let disposeSignals = (): void => undefined;
      const shutdown: GracefulShutdown = {
        get closing() {
          return closing !== undefined;
        },
        close(reason = 'shutdown') {
          if (closing) return closing;
          console.info(`[wargr] worker validation stopping (${reason})`);
          closing = closeWorkerValidation({
            closePersistence: () => {
              if (!persistenceOpen) return;
              persistenceOpen = false;
              persistence.close();
            },
            disposeSignals: () => disposeSignals(),
            releaseValidationReference,
          });
          return closing;
        },
      };
      try {
        disposeSignals = bindShutdownSignals({
          onError(error) {
            console.error('[wargr] worker validation shutdown failed', error);
            process.exitCode = 1;
            try {
              releaseValidationReference();
            } catch (releaseError) {
              console.error('[wargr] worker validation reference release failed', releaseError);
            }
          },
          shutdown,
          signals,
        });
        await signalReadiness(
          createServerWorkerReadiness({
            identity,
            productId: manifest.id,
            workerKey: WARGR_WORKER_KEY,
          }),
          { environment: sourceEnvironment },
        );
      } catch (startupError) {
        try {
          await shutdown.close('startup_failure');
        } catch (shutdownError) {
          throw new AggregateError(
            [startupError, shutdownError],
            'Wargr worker validation failed and cleanup was incomplete.',
          );
        }
        throw startupError;
      }
      console.info('[wargr] worker release validation ready');
      return Object.freeze({
        environment,
        identity,
        kind: 'release-validation' as const,
        persistence,
        shutdown,
      });
    }

    let provider: ReturnType<typeof createOpenAiResponsesProvider> | undefined;
    if (environment.polishEnabled) {
      if (!environment.providerApiKey) {
        throw new Error('Wargr worker requires OPENAI_API_KEY when claims are enabled.');
      }
      provider = createOpenAiResponsesProvider({
        apiKey: environment.providerApiKey,
        model: environment.providerModel,
        repository: persistence.polish,
        ...(environment.providerBaseUrl === undefined
          ? {}
          : { baseUrl: environment.providerBaseUrl }),
      });
    }
    const worker = createArticlePolishWorker({
      articles: persistence.articles,
      enabled: environment.polishEnabled,
      maintenance: persistence.polishMaintenance,
      onError(error) {
        console.error('[wargr] article polish worker operation failed', error);
      },
      onMaintenance(result) {
        if (
          result.ambiguous > 0 ||
          result.effects > 0 ||
          result.failed > 0 ||
          result.jobs > 0 ||
          result.responseBytes > 0 ||
          result.runs > 0
        ) {
          console.info('[wargr] article polish maintenance completed', result);
        }
      },
      onRecovery(result) {
        if (
          result.ambiguousEffects > 0 ||
          result.ambiguousRuns > 0 ||
          result.failedJobs > 0 ||
          result.failedRuns > 0 ||
          result.resumedRuns > 0 ||
          result.retriedJobs > 0
        ) {
          console.info('[wargr] article polish recovery completed', result);
        }
      },
      polish: persistence.polish,
      ...(provider === undefined ? {} : { provider }),
      store: persistence.jobs,
    });

    let closing: Promise<void> | undefined;
    let disposeSignals = (): void => undefined;
    let readinessLease: ServerWorkerReadinessLease | undefined;
    let workerStarted = false;
    const shutdown: GracefulShutdown = {
      get closing() {
        return closing !== undefined;
      },
      close(reason = 'shutdown') {
        if (closing) return closing;
        console.info(`[wargr] worker stopping (${reason})`);
        closing = closeWorkerRuntime({
          closeReadinessLease: () => {
            readinessLease?.close();
          },
          closePersistence: () => {
            if (!persistenceOpen) return;
            persistenceOpen = false;
            persistence.close();
          },
          disposeSignals: () => disposeSignals(),
          reason,
          worker: workerStarted ? worker : undefined,
        });
        return closing;
      },
    };

    try {
      disposeSignals = bindShutdownSignals({
        onError(error) {
          console.error('[wargr] worker shutdown failed', error);
          process.exitCode = 1;
        },
        shutdown,
        signals,
      });
      readinessLease = acquireWargrWorkerReadinessLease({
        acquireReadinessLease,
        environment: sourceEnvironment,
        identity,
        production: environment.isProduction,
      });
      workerStarted = true;
      worker.start();
    } catch (startupError) {
      try {
        await shutdown.close('startup_failure');
      } catch (shutdownError) {
        throw new AggregateError(
          [startupError, shutdownError],
          'Wargr worker startup failed and cleanup was incomplete.',
        );
      }
      throw startupError;
    }

    console.info(
      environment.polishEnabled
        ? '[wargr] article polish worker ready with claims enabled'
        : '[wargr] article polish worker ready with claims disabled',
    );
    return Object.freeze({
      claimsEnabled: environment.polishEnabled,
      environment,
      identity,
      kind: 'worker' as const,
      persistence,
      readinessLease,
      shutdown,
      worker,
    });
  } catch (error) {
    if (!persistenceOpen) throw error;
    persistenceOpen = false;
    try {
      persistence.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'Wargr worker startup and persistence cleanup both failed.',
      );
    }
    throw error;
  }
}

export function acquireWargrWorkerReadinessLease({
  acquireReadinessLease,
  environment,
  identity,
  production,
}: {
  readonly acquireReadinessLease: typeof acquireServerWorkerReadinessLease;
  readonly environment: NodeJS.ProcessEnv;
  readonly identity: ServerReleaseIdentity | undefined;
  readonly production: boolean;
}): ServerWorkerReadinessLease | undefined {
  if (!production) return undefined;
  const readinessLease = acquireReadinessLease({
    environment,
    identity,
    workerKey: WARGR_WORKER_KEY,
  });
  if (!readinessLease) {
    throw new Error('Wargr production worker did not acquire its server readiness lease.');
  }
  return readinessLease;
}

export async function closeWorkerRuntime({
  closeReadinessLease,
  closePersistence,
  disposeSignals,
  reason,
  worker,
}: {
  readonly closeReadinessLease: () => void;
  readonly closePersistence: () => void;
  readonly disposeSignals: () => void;
  readonly reason: string;
  readonly worker: ArticlePolishWorkerLoop | undefined;
}): Promise<void> {
  const failures: unknown[] = [];
  try {
    closeReadinessLease();
  } catch (error) {
    failures.push(error);
  }
  try {
    worker?.stopClaiming();
  } catch (error) {
    failures.push(error);
  }
  try {
    worker?.abortActive(new Error(`Wargr worker stopped (${reason}).`));
  } catch (error) {
    failures.push(error);
  }
  try {
    await worker?.drain(WORKER_DRAIN_TIMEOUT_MS);
  } catch (error) {
    failures.push(error);
  }
  try {
    disposeSignals();
  } catch (error) {
    failures.push(error);
  }
  try {
    closePersistence();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Wargr worker shutdown cleanup failed.');
  }
}

async function closeWorkerValidation({
  closePersistence,
  disposeSignals,
  releaseValidationReference,
}: {
  readonly closePersistence: () => void;
  readonly disposeSignals: () => void;
  readonly releaseValidationReference: () => void;
}): Promise<void> {
  const failures: unknown[] = [];
  for (const operation of [disposeSignals, closePersistence, releaseValidationReference]) {
    try {
      operation();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Wargr worker validation cleanup failed.');
  }
}

function releaseProcessValidationReference(): void {
  process.channel?.unref();
}
