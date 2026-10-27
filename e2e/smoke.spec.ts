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

test('the Admin stays private: noindexed shell, anonymous session, guarded API', async ({
  page,
  request,
}) => {
  const shell = await page.goto('/admin');
  expect(shell?.ok()).toBeTruthy();
  expect(shell?.headers()['x-robots-tag']).toBe('noindex, nofollow');
  await expect(page).toHaveTitle('Admin — Wargr');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);

  const session = await request.get('/api/admin/session');
  expect(session.ok()).toBeTruthy();
  expect(await session.json()).toEqual({ authenticated: false });

  const articles = await request.get('/api/admin/articles', { failOnStatusCode: false });
  expect(articles.status()).toBe(401);
});

test('the checked-in story snapshot renders from the tracked presentation source alone', async ({
  page,
}) => {
  const response = await page.goto('/blog/');
  expect(response?.ok()).toBeTruthy();
  await expect(page).toHaveURL(new URL('/', OWNED_ORIGIN).href);
  await expect(page).toHaveTitle('Home — Michael Wargr');
  await expect(page.getByRole('link', { name: 'Read The strange mercy of death' })).toBeVisible();
});

test('a prerendered story route remains readable', async ({ page }) => {
  const response = await page.goto('/corruption/');
  expect(response?.ok()).toBeTruthy();
  await expect(page).toHaveTitle(/How fear turns good people into corruption/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('How fear turns the good');
});

test('Home features the latest story once and every story opens with an image-backed title', async ({
  page,
}) => {
  await page.goto('/');
  const featured = page.locator('cx-hero');
  await expect(featured.getByRole('heading', { level: 1 })).toHaveText(
    'The strange mercy of death',
  );
  const latest = featured.getByRole('link', { name: 'Read The strange mercy of death' });
  const cards = page.getByRole('region', { name: 'Stories', exact: true }).getByRole('link');
  await expect(cards).toHaveCount(4);
  const paths = [
    await latest.getAttribute('href'),
    ...(await cards.evaluateAll((links) => links.map((link) => link.getAttribute('href')))),
  ];
  expect(new Set(paths).size).toBe(5);

  for (const route of ['/', ...paths]) {
    await page.goto(route!);
    const hero = page.locator('cx-hero');
    const image = hero.locator('img');
    await expect(image).toBeVisible();
    await expect(image).toHaveJSProperty('complete', true);
    expect(
      await image.evaluate((element: HTMLImageElement) => element.naturalWidth),
    ).toBeGreaterThan(0);
    const imageBounds = (await image.boundingBox())!;
    const titleBounds = (await hero.getByRole('heading', { level: 1 }).boundingBox())!;
    expect(titleBounds.x).toBeGreaterThanOrEqual(imageBounds.x);
    expect(titleBounds.y).toBeGreaterThanOrEqual(imageBounds.y);
    expect(titleBounds.x + titleBounds.width).toBeLessThanOrEqual(
      imageBounds.x + imageBounds.width,
    );
    expect(titleBounds.y + titleBounds.height).toBeLessThanOrEqual(
      imageBounds.y + imageBounds.height,
    );
    if (route !== '/') await expect(page.locator('article .cx-editorial')).toBeVisible();
  }
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
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for isolated Wargr E2E.`);
  return value;
}

test('the personal site leads with the blog and connects all three sections', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Home — Michael Wargr');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('The strange mercy of death');
  const navigation = page.getByRole('navigation', { name: 'Primary' });
  await expect(navigation.getByRole('link')).toHaveText(['Home', 'Videos', 'About']);
  await expect(navigation.getByRole('link', { name: 'Home', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await navigation.getByRole('link', { name: 'Videos', exact: true }).click();
  await expect(page).toHaveURL(/\/videos\/?$/);
  await expect(page).toHaveTitle('Videos — Michael Wargr');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'What the mirror doesn’t show you',
  );
  await expect(page.getByRole('link', { name: 'Watch on YouTube' })).toHaveAttribute(
    'href',
    'https://www.youtube.com/watch?v=iG-Tg92NOH4',
  );
  await expect(page.getByRole('link', { name: 'Videos', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const video = page.getByRole('img', {
    name: 'What the mirror doesn’t show you — video thumbnail',
  });
  const bounds = await video.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width / bounds!.height).toBeCloseTo(16 / 9, 1);
  await page.getByRole('link', { name: 'Read the stories' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('The strange mercy of death');
  await page.getByRole('link', { name: 'Read The strange mercy of death' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('The strange mercy of death');
  await expect(
    page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Home', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  const prose = await page.locator('article .cx-editorial').boundingBox();
  expect(prose?.width).toBeLessThanOrEqual(640);
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page).toHaveTitle('About — Michael Wargr');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Michael Wargr');
  await page.getByRole('link', { name: 'Watch the videos', exact: true }).click();
  await expect(page).toHaveURL(/\/videos\/?$/);
  await expect(page).toHaveTitle('Videos — Michael Wargr');
  await page.getByRole('link', { name: 'Michael Wargr — home' }).click();
  await expect(page).toHaveTitle('Home — Michael Wargr');
});

test('public navigation and the logo remain usable in the night theme', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveClass(/theme-night/);
  await expect(page.locator('.wg-logo-night')).toBeVisible();
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('.wg-logo-light')).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/theme-light/);
  await page.getByRole('button', { name: 'Switch to night theme' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/theme-night/);
  await expect(page.locator('.wg-logo-night')).toBeVisible();
});

test('the masthead menu supports section navigation and Escape', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Menu' })
    .getByRole('link', { name: 'Videos', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'What the mirror doesn’t show you',
  );
  await expect(page.getByRole('dialog', { name: 'Menu' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeFocused();
});

test('the sitemap exposes only canonical, prerendered public pages and crawlable images', async ({
  page,
  request,
}) => {
  const response = await request.get('/sitemap.xml');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('xml');
  await page.goto('/');
  const entries = await page.evaluate(
    (xml) => {
      const document = new DOMParser().parseFromString(xml, 'application/xml');
      if (document.querySelector('parsererror')) throw new Error('Invalid sitemap XML');
      return Array.from(document.getElementsByTagName('url'), (entry) => ({
        url: entry.getElementsByTagName('loc')[0]?.textContent ?? '',
        modified: entry.getElementsByTagName('lastmod')[0]?.textContent ?? null,
        images: Array.from(entry.getElementsByTagNameNS('*', 'loc'))
          .filter((element) => element.prefix === 'image')
          .map((element) => element.textContent ?? ''),
      }));
    },
    await response.text(),
  );
  const urls = entries.map((entry) => entry.url);
  expect(new Set(urls).size).toBe(urls.length);
  expect(urls).toEqual(
    expect.arrayContaining([
      'https://wargr.com/',
      'https://wargr.com/videos/',
      'https://wargr.com/about/',
    ]),
  );
  for (const entry of entries) {
    const url = new URL(entry.url);
    expect(url.origin).toBe('https://wargr.com');
    expect(url.pathname).toMatch(/\/$/);
    expect(url.pathname).not.toMatch(/^\/(admin|api|healthz)(\/|$)/);
    const documentResponse = await request.get(url.pathname, { maxRedirects: 0 });
    expect(documentResponse.status(), entry.url).toBe(200);
    expect(documentResponse.headers()['x-robots-tag'] ?? '').not.toContain('noindex');
    const metadata = await page.evaluate(
      (html) => {
        const document = new DOMParser().parseFromString(html, 'text/html');
        return {
          canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
          robots: document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? '',
          heading: document.querySelector('h1')?.textContent?.trim(),
          modified: document
            .querySelector('meta[property="article:modified_time"]')
            ?.getAttribute('content'),
        };
      },
      await documentResponse.text(),
    );
    expect(metadata.canonical).toBe(entry.url);
    expect(metadata.robots).not.toContain('noindex');
    expect(metadata.heading).toBeTruthy();
    if (entry.modified) expect(entry.modified).toBe(metadata.modified);
    for (const image of entry.images) {
      const imageUrl = new URL(image);
      expect(imageUrl.origin).toBe('https://wargr.com');
      const imageResponse = await request.get(imageUrl.pathname);
      expect(imageResponse.status()).toBe(200);
      expect(imageResponse.headers()['content-type']).toMatch(/^image\//);
    }
  }
  const robots = await request.get('/robots.txt');
  expect(await robots.text()).toContain('Sitemap: https://wargr.com/sitemap.xml');
});
