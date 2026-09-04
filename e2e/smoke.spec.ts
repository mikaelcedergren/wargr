import { expect, test } from '@playwright/test';

const OWNED_ORIGIN = requiredEnvironment('CX_E2E_BASE_URL');
const OWNED_E2E_PORT = Number(new URL(OWNED_ORIGIN).port);
const OTHER_E2E_ORIGIN = `http://127.0.0.1:${OWNED_E2E_PORT === 49_152 ? 49_153 : 49_152}`;
const BLOCKED_BROWSER_TARGETS = [
  'http://127.0.0.1:3060/healthz',
  `${OTHER_E2E_ORIGIN}/healthz`,
  'https://cx-e2e-network-isolation.invalid/probe',
] as const;
const BLOCKED_PROXY_TARGETS = [
  'http://127.0.0.1:3060/healthz',
  `${OTHER_E2E_ORIGIN}/healthz`,
  'http://cx-e2e-network-isolation.invalid/probe',
] as const;
const unexpectedExternalRequests = new WeakMap<object, string[]>();

test.beforeEach(async ({ context }) => {
  const unexpected: string[] = [];
  unexpectedExternalRequests.set(context, unexpected);
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === OWNED_ORIGIN) {
      await route.continue();
      return;
    }

    unexpected.push(`${request.method()} ${url.href}`);
    await route.abort('blockedbyclient');
  });
});

test.afterEach(async ({ context }) => {
  expect(unexpectedExternalRequests.get(context) ?? []).toEqual([]);
});

test('the browser rejects production, another E2E origin, and the public network', async ({
  context,
  page,
}) => {
  const recorded = unexpectedExternalRequests.get(context);
  for (const target of BLOCKED_BROWSER_TARGETS) {
    const failedRequest = page.waitForEvent('requestfailed', (request) => request.url() === target);
    await page.goto(target).catch(() => undefined);
    expect((await failedRequest).failure()?.errorText).toBe('net::ERR_BLOCKED_BY_CLIENT');
  }
  expect(recorded).toEqual(BLOCKED_BROWSER_TARGETS.map((target) => `GET ${target}`));
  recorded?.splice(0);
});

test('browser launch transport sends production through the owned proxy', async ({
  context,
  page,
}) => {
  await context.unroute('**/*');
  const response = await page.goto('http://127.0.0.1:3060/cx-e2e-launch-proxy-proof');
  expect(response?.status()).toBe(403);
  expect(await response?.text()).toContain('E2E proxy denied this origin.');
});

test('the API request context can reach only the owned origin through its proxy', async ({
  request,
}) => {
  for (const target of BLOCKED_PROXY_TARGETS) {
    const response = await request.get(target, {
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    expect(response.status()).toBe(403);
    expect(response.url()).toBe(target);
  }
});

test('test-worker fetch rejects every origin except the owned server', async () => {
  for (const target of BLOCKED_BROWSER_TARGETS) {
    await expect(globalThis.fetch(target)).rejects.toThrow('E2E network isolation blocked fetch');
  }
});

test('the isolated production server exposes health and security headers', async ({ request }) => {
  const response = await request.get('/healthz');
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({ app: 'wargr', ok: true });
  expect(response.headers()['x-frame-options']).toBe('SAMEORIGIN');
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
});

test('the server identity endpoint reports the selected synthetic release', async ({ request }) => {
  const response = await request.get('/cx-server.json');
  expect(response.ok()).toBeTruthy();
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.json()).toMatchObject({
    releaseId: 'synthetic-wargr-test',
    entrypoint: 'server/dist/index.js',
    nodeMajor: 26,
  });
});

test('the Studio stays private: noindexed shell, anonymous session, guarded API', async ({
  page,
  request,
}) => {
  const shell = await page.goto('/studio');
  expect(shell?.ok()).toBeTruthy();
  expect(shell?.headers()['x-robots-tag']).toBe('noindex, nofollow');
  await expect(page).toHaveTitle('Studio — Wargr');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  const session = await request.get('/api/studio/session');
  expect(session.ok()).toBeTruthy();
  expect(await session.json()).toEqual({ authenticated: false });

  const articles = await request.get('/api/studio/articles', { failOnStatusCode: false });
  expect(articles.status()).toBe(401);
});

test('the checked-in essay snapshot renders from the tracked presentation source alone', async ({
  page,
}) => {
  const response = await page.goto('/');
  expect(response?.ok()).toBeTruthy();
  await expect(page).toHaveTitle('Wargr — essays by Michael Wargr');
  await expect(page.getByRole('link', { name: 'Read The strange mercy of death' })).toBeVisible();
});

test('a prerendered essay route remains readable', async ({ page }) => {
  const response = await page.goto('/corruption/');
  expect(response?.ok()).toBeTruthy();
  await expect(page).toHaveTitle(/How fear turns good people into corruption/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('How fear turns the good');
});

test('a missing browser asset returns a real non-cacheable 404', async ({ request }) => {
  const response = await request.get('/missing-phase-one.js');
  expect(response.status()).toBe(404);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.text()).toBe('Asset not found');
});

test('an unknown product route returns the real no-cache 404 page', async ({ page }) => {
  const response = await page.goto('/not-a-real-wargr-route');
  expect(response?.status()).toBe(404);
  expect(response?.headers()['cache-control']).toBe('no-cache');
  expect(response?.headers()['content-type']).toContain('text/html');
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for isolated Wargr E2E.`);
  return value;
}
