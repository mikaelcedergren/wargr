import type { Server } from 'node:http';

import { listenHttpApplication } from '@mikaelcedergren/cx-framework/server/listen';
import { loadProductManifestFile } from '@mikaelcedergren/cx-framework/server/product-manifest';
import { assertServerProcessRole } from '@mikaelcedergren/cx-framework/server/process-role';
import {
  loadServerReleaseIdentity,
  type ServerReleaseIdentity,
} from '@mikaelcedergren/cx-framework/server/server-identity';
import {
  bindShutdownSignals,
  createGracefulShutdown,
  type GracefulShutdown,
} from '@mikaelcedergren/cx-framework/server/shutdown';
import { assertBrowserServingForStartup } from '@mikaelcedergren/cx-framework/server/static-files';

import { createWargrApplication } from './app.js';
import { createOwnerAuthService } from './auth-service.js';
import { createWargrPersistence, type WargrPersistence } from './article-repository.js';
import { createArticleService } from './article-service.js';
import { createWargrBrowserServing } from './browser-serving.js';
import {
  WARGR_ARTIFACT_ROOT,
  WARGR_MANIFEST_FILE,
  loadWargrEnvironment,
  type WargrEnvironment,
} from './environment.js';
import { createPolishService } from './polish-service.js';
import { verifyWargrDatabaseBeforeWrite } from './database.js';
import { assertWargrProductManifest } from './product-contract.js';

const HTTP_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface WargrRuntime {
  readonly environment: WargrEnvironment;
  readonly identity: ServerReleaseIdentity | undefined;
  readonly persistence: WargrPersistence;
  readonly server: Server;
  readonly shutdown: GracefulShutdown;
}

export async function startWargrServer({
  entrypointUrl,
  environment: sourceEnvironment = process.env,
}: {
  readonly entrypointUrl: string | URL;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<WargrRuntime> {
  const environment = loadWargrEnvironment(sourceEnvironment);
  const { manifest } = loadProductManifestFile(WARGR_MANIFEST_FILE);
  assertWargrProductManifest(manifest);

  const identity = loadServerReleaseIdentity({
    environment: sourceEnvironment,
    required: environment.isProduction || environment.releaseValidation,
  });
  if (identity) {
    assertServerProcessRole({
      artifactRoot: WARGR_ARTIFACT_ROOT,
      entrypointUrl,
      identity,
      role: { kind: 'web' },
    });
  }

  const configuredBrowserServing = createWargrBrowserServing(environment);
  assertBrowserServingForStartup({
    browserServing: configuredBrowserServing,
    environment: sourceEnvironment,
  });

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
  let server: Server | undefined;
  try {
    const authService = createOwnerAuthService({
      cookieSecure: environment.cookieSecure,
      expectedPasswordHash: environment.studioPasswordHash,
      expectedUsername: environment.studioUsername,
      repository: persistence.ownerAuth,
      sessionSecret: environment.sessionSecret,
      sessionTtlSeconds: environment.sessionTtlSeconds,
    });
    const articleService = createArticleService({ articles: persistence.articles });
    const polishService = createPolishService({
      articles: persistence.articles,
      polish: persistence.polish,
      polishAdmission: persistence.polishAdmission,
      providerConfigured: environment.polishEnabled,
    });
    const app = createWargrApplication({
      articleService,
      authService,
      browserServing: configuredBrowserServing,
      databaseReadiness: persistence,
      environment,
      polishService,
      ...(identity === undefined ? {} : { identity }),
    });
    server = await listenHttpApplication(app, {
      host: environment.host,
      port: environment.port,
    });
    const httpShutdown = createGracefulShutdown({
      server,
      timeoutMs: HTTP_SHUTDOWN_TIMEOUT_MS,
    });
    let closing: Promise<void> | undefined;
    let disposeSignals = (): void => undefined;
    const shutdown: GracefulShutdown = {
      get closing() {
        return closing !== undefined;
      },
      close(reason = 'shutdown') {
        if (closing) return closing;
        console.info(`[wargr] web process stopping (${reason})`);
        closing = closeWebRuntime({
          closeHttp: () => httpShutdown.close(reason),
          closePersistence: () => {
            if (!persistenceOpen) return;
            persistenceOpen = false;
            persistence.close();
          },
          disposeSignals: () => disposeSignals(),
        });
        return closing;
      },
    };

    try {
      disposeSignals = bindShutdownSignals({
        onError(error) {
          console.error('[wargr] web process shutdown failed', error);
          process.exitCode = 1;
        },
        shutdown,
        signals: process,
      });
    } catch (signalError) {
      try {
        await shutdown.close('signal_setup_failed');
      } catch (shutdownError) {
        throw new AggregateError(
          [signalError, shutdownError],
          'Wargr signal setup failed and web cleanup was incomplete.',
        );
      }
      throw signalError;
    }

    console.info(
      `[wargr] web process listening on http://${environment.host}:${String(environment.port)}`,
    );
    return Object.freeze({ environment, identity, persistence, server, shutdown });
  } catch (error) {
    const failures: unknown[] = [error];
    if (server?.listening) {
      try {
        await closeServer(server);
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    if (persistenceOpen) {
      persistenceOpen = false;
      try {
        persistence.close();
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, 'Wargr web startup and cleanup both failed.');
  }
}

async function closeWebRuntime({
  closeHttp,
  closePersistence,
  disposeSignals,
}: {
  readonly closeHttp: () => Promise<void>;
  readonly closePersistence: () => void;
  readonly disposeSignals: () => void;
}): Promise<void> {
  const failures: unknown[] = [];
  try {
    await closeHttp();
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
    throw new AggregateError(failures, 'Wargr web shutdown cleanup failed.');
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
