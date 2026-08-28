import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverIdentityFile = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'synthetic-server-release.json',
);

test(
  'the compiled entrypoint pins its artifact manifest and serves the essay-site contract',
  { timeout: 15_000 },
  async (t) => {
    const entrypointSource = await readFile(path.join(repoRoot, 'server', 'index.ts'), 'utf8');
    assert.match(entrypointSource, /entrypointUrl:\s*import\.meta\.url/);
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'wargr-server-'));
    const browserDir = path.join(fixtureRoot, 'browser');
    const port = await reservePort();
    await mkdir(browserDir, { recursive: true });
    await writeFile(
      path.join(browserDir, 'index.html'),
      '<!doctype html><title>Wargr fixture</title>',
    );
    await writeFile(
      path.join(browserDir, '404.html'),
      '<!doctype html><title>Wargr missing</title><p>wargr-product-404</p>',
    );
    const articleDir = path.join(browserDir, 'corruption');
    await mkdir(articleDir, { recursive: true });
    await writeFile(
      path.join(articleDir, 'index.html'),
      '<!doctype html><title>Corruption fixture</title>',
    );
    await writeFile(
      path.join(browserDir, 'main-0123456789abcdef.js'),
      'globalThis.wargrFixture = true;',
    );
    await writeFile(path.join(browserDir, 'feed.xml'), '<rss version="2.0"></rss>\n');
    const serverIdentity = JSON.parse(await readFile(serverIdentityFile, 'utf8'));
    const artifactManifest = JSON.parse(
      await readFile(path.join(repoRoot, 'cx-product.json'), 'utf8'),
    );
    const operationalManifestFile = path.join(fixtureRoot, 'cx-product.json');
    await writeFile(
      operationalManifestFile,
      `${JSON.stringify({ ...artifactManifest, id: 'mutable-source-before' }, null, 2)}\n`,
    );

    const child = spawn(process.execPath, [path.join(repoRoot, 'server', 'dist', 'index.js')], {
      cwd: fixtureRoot,
      env: {
        CX_SERVER_RELEASE_IDENTITY_FILE: serverIdentityFile,
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
        PATH: process.env.PATH,
        PORT: String(port),
        SITE_BROWSER_DIR: browserDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));

    t.after(async () => {
      await stopChild(child);
      await rm(fixtureRoot, { recursive: true, force: true });
    });

    const origin = `http://127.0.0.1:${port}`;
    const health = await waitForHealth(`${origin}/healthz`, child, () => output);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { app: 'wargr', ok: true, port });
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(health.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(
      health.headers.get('permissions-policy'),
      'camera=(), microphone=(), geolocation=()',
    );
    assert.equal(health.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(health.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(health.headers.get('origin-agent-cluster'), '?1');
    assert.equal(health.headers.get('x-dns-prefetch-control'), 'off');
    assert.equal(health.headers.get('x-download-options'), 'noopen');
    assert.equal(health.headers.get('x-permitted-cross-domain-policies'), 'none');
    assert.equal(health.headers.get('x-xss-protection'), '0');
    assert.equal(health.headers.get('x-powered-by'), null);
    assert.match(health.headers.get('content-type') ?? '', /^application\/json(?:;|$)/);

    await writeFile(
      operationalManifestFile,
      `${JSON.stringify({ ...artifactManifest, id: 'mutable-source-after' }, null, 2)}\n`,
    );
    const healthAfterSourceMutation = await localFetch(`${origin}/healthz`);
    assert.deepEqual(await healthAfterSourceMutation.json(), { app: 'wargr', ok: true, port });

    const identity = await localFetch(`${origin}/cx-server.json`);
    assert.equal(identity.status, 200);
    assert.equal(identity.headers.get('cache-control'), 'no-store');
    assert.match(identity.headers.get('content-type') ?? '', /^application\/json/);
    assert.deepEqual(await identity.json(), serverIdentity);

    const missingApi = await localFetch(`${origin}/api/not-a-route`);
    assert.equal(missingApi.status, 404);
    const requestId = missingApi.headers.get('x-request-id');
    assert.match(requestId ?? '', /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/);
    assert.deepEqual(await missingApi.json(), {
      error: {
        code: 'route_not_found',
        message: 'No route exists at /api/not-a-route.',
        requestId,
      },
    });

    const missingAsset = await localFetch(`${origin}/main.missing.js`);
    assert.equal(missingAsset.status, 404);
    assert.equal(missingAsset.headers.get('cache-control'), 'no-store');
    assert.equal(await missingAsset.text(), 'Asset not found');

    const immutableAsset = await localFetch(`${origin}/main-0123456789abcdef.js`);
    assert.equal(immutableAsset.status, 200);
    assert.equal(
      immutableAsset.headers.get('cache-control'),
      'public, max-age=31536000, immutable',
    );
    assert.equal(await immutableAsset.text(), 'globalThis.wargrFixture = true;');

    const ordinaryAsset = await localFetch(`${origin}/feed.xml`);
    assert.equal(ordinaryAsset.status, 200);
    assert.equal(ordinaryAsset.headers.get('cache-control'), 'public, max-age=3600');
    assert.equal(await ordinaryAsset.text(), '<rss version="2.0"></rss>\n');

    const home = await localFetch(origin);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('cache-control'), 'no-cache');
    assert.match(await home.text(), /Wargr fixture/);

    const articleRoute = await localFetch(`${origin}/corruption/`);
    assert.equal(articleRoute.status, 200);
    assert.equal(articleRoute.headers.get('cache-control'), 'no-cache');
    assert.match(await articleRoute.text(), /Corruption fixture/);

    const missingProductRoute = await localFetch(`${origin}/not-a-product-route`);
    assert.equal(missingProductRoute.status, 404);
    assert.equal(missingProductRoute.headers.get('cache-control'), 'no-cache');
    assert.match(missingProductRoute.headers.get('content-type') ?? '', /^text\/html/);
    assert.match(await missingProductRoute.text(), /wargr-product-404/);

    assert.deepEqual(await stopChild(child), { code: 0, signal: null });
  },
);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error('Could not reserve an isolated test port.'));
        else resolve(port);
      });
    });
  });
}

function localFetch(input, init) {
  const url = new URL(input);
  assert.ok(
    ['127.0.0.1', '::1', 'localhost'].includes(url.hostname),
    `Wargr contract tests refuse non-loopback fetches: ${url.origin}`,
  );
  return fetch(url, init);
}

async function waitForHealth(url, child, readOutput) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Production entrypoint exited before health check:\n${readOutput()}`);
    }
    try {
      const response = await localFetch(url);
      if (response.ok) return response;
    } catch {
      // The isolated process has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}:\n${readOutput()}`);
}

async function stopChild(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Wargr server did not terminate after SIGTERM.'));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
    child.kill('SIGTERM');
  });
}
