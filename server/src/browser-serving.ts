import fs from 'node:fs';

import { missingAssetMiddleware } from '@mikaelcedergren/cx-framework/server/security';
import {
  createBrowserServing,
  resolvePrerenderedEntry,
  retainedReleaseAssetMiddleware,
  staticFileOptions,
  type BrowserServing,
} from '@mikaelcedergren/cx-framework/server/static-files';
import express from 'express';

import type { WargrEnvironment } from './environment.js';

export function createWargrBrowserServing(environment: WargrEnvironment): BrowserServing {
  return createBrowserServing({
    express,
    repoRoot: environment.operationalRoot,
    defaultBrowserDir: environment.browserDirectory,
    ...(environment.browserDirectoryOverride === undefined
      ? {}
      : { browserDirOverride: environment.browserDirectoryOverride }),
  });
}

export function mountWargrBrowser(
  app: express.Express,
  environment: WargrEnvironment,
  browserServing: BrowserServing,
): void {
  app.use(browserServing.staticMiddleware(staticFileOptions()));
  if (browserServing.useReleaseHistory) {
    app.use(retainedReleaseAssetMiddleware({ repoRoot: environment.operationalRoot }));
  }
  app.use(missingAssetMiddleware());
  app.use((request, response, next) => {
    if (!['GET', 'HEAD'].includes(request.method) || request.path.startsWith('/api')) {
      next();
      return;
    }
    try {
      const requestBrowserDirectory = browserServing.browserDirForRequest(request);
      const indexFile = resolvePrerenderedEntry(requestBrowserDirectory, '/');
      if (!indexFile || !isRegularFile(indexFile)) {
        response.status(503).type('text/plain').send('Build missing. Run the build first.');
        return;
      }

      const routeFile = resolvePrerenderedEntry(requestBrowserDirectory, request.path);
      response.setHeader('Cache-Control', 'no-cache');
      if (routeFile && isRegularFile(routeFile)) {
        browserServing.sendFileForRequest(request, response, routeFile);
        return;
      }

      response.status(404);
      const notFoundFile = `${requestBrowserDirectory}/404.html`;
      const csrShellFile = `${requestBrowserDirectory}/index.csr.html`;
      browserServing.sendFileForRequest(
        request,
        response,
        isRegularFile(notFoundFile)
          ? notFoundFile
          : isRegularFile(csrShellFile)
            ? csrShellFile
            : indexFile,
      );
    } catch (error) {
      next(error);
    }
  });
}

function isRegularFile(file: string): boolean {
  try {
    const entry = fs.lstatSync(file);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}
