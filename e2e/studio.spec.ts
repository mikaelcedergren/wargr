import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';

const origin = requiredEnvironment('CX_E2E_BASE_URL');

test('a delayed save cannot replace the essay opened afterward', async ({ page }) => {
  const [first, second] = await openWorkspace(page);
  await openEssay(page, first.title);
  await page.getByRole('textbox', { name: 'Topic', exact: true }).fill('First essay edit');
  const held = await holdResponse(page, `**/api/studio/articles/${first.id}`, 'PUT');
  try {
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await held.received;
    await page.getByRole('button', { name: 'Essays', exact: true }).click();
    await openEssay(page, second.title);
    held.release();
    await page.getByRole('textbox', { name: 'Topic', exact: true }).fill('Second essay edit');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    const [savedFirst, savedSecond] = await Promise.all([
      readArticle(page, first.id),
      readArticle(page, second.id),
    ]);
    expect(savedFirst.title).toBe(first.title);
    expect(savedFirst.topic).toBe('First essay edit');
    expect(savedSecond.title).toBe(second.title);
    expect(savedSecond.topic).toBe('Second essay edit');
  } finally {
    held.release();
  }
});

test('a save preserves address and document edits made while its response is pending', async ({
  page,
}) => {
  const [article] = await openWorkspace(page);
  await openEssay(page, article.title);
  await page.getByRole('textbox', { name: 'Address', exact: true }).fill('submitted-address');
  const held = await holdResponse(page, `**/api/studio/articles/${article.id}`, 'PUT');
  try {
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await held.received;
    await page.getByRole('textbox', { name: 'Address', exact: true }).fill('later-address');
    await page.getByRole('textbox', { name: 'Topic', exact: true }).fill('Later topic');
    held.release();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toHaveValue(
      'later-address',
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    const saved = await readArticle(page, article.id);
    expect(saved.slug).toBe('later-address');
    expect(saved.topic).toBe('Later topic');
  } finally {
    held.release();
  }
});

test('a delayed version response cannot replace the newly opened essay draft', async ({ page }) => {
  const [first, second] = await openWorkspace(page);
  await openEssay(page, first.title);
  await page.getByRole('button', { name: 'Rounds', exact: true }).click();
  const held = await holdResponse(page, `**/api/studio/articles/${first.id}/versions/1`, 'GET');
  try {
    await page.getByRole('button', { name: 'Load into editor', exact: true }).click();
    await held.received;
    await page.getByRole('button', { name: 'Essays', exact: true }).click();
    await openEssay(page, second.title);
    const completed = page.waitForResponse((response) =>
      response.url().endsWith(`/articles/${first.id}/versions/1`),
    );
    held.release();
    await completed;
    await page.getByRole('textbox', { name: 'Topic', exact: true }).fill('Second remains current');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    expect((await readArticle(page, second.id)).title).toBe(second.title);
  } finally {
    held.release();
  }
});

test('a delayed publication refusal stays with its original editor', async ({ page }) => {
  const [first, second] = await openWorkspace(page);
  await openEssay(page, first.title);
  const held = await holdResponse(page, `**/api/studio/articles/${first.id}/publish`, 'POST');
  try {
    await page.getByRole('button', { name: 'Essay actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Publish essay', exact: true }).click();
    await held.received;
    await page.getByRole('button', { name: 'Essays', exact: true }).click();
    await openEssay(page, second.title);
    const completed = page.waitForResponse((response) =>
      response.url().endsWith(`/articles/${first.id}/publish`),
    );
    held.release();
    await completed;
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    await expect(page.getByText('The essay does not meet the publish format yet.')).toHaveCount(0);
  } finally {
    held.release();
  }
});

test('polish admission stops when its prerequisite save finishes in another editor', async ({
  page,
}) => {
  const [first, second] = await openWorkspace(page);
  await openEssay(page, first.title);
  await page.getByRole('textbox', { name: 'Topic', exact: true }).fill('Save before polishing');
  const admissions: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/polish')) {
      admissions.push(request.url());
    }
  });
  const held = await holdResponse(page, `**/api/studio/articles/${first.id}`, 'PUT');
  try {
    await page.getByRole('button', { name: 'Run the ghostwriter', exact: true }).click();
    await held.received;
    await page.getByRole('button', { name: 'Essays', exact: true }).click();
    await openEssay(page, second.title);
    held.release();
    await page.getByRole('textbox', { name: 'Topic', exact: true }).fill('Second essay edit');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    expect(admissions).toEqual([]);
    expect((await readArticle(page, first.id)).topic).toBe('Save before polishing');
  } finally {
    held.release();
  }
});

test('a delayed polish refusal stays with its original editor', async ({ page }) => {
  const [first, second] = await openWorkspace(page);
  await openEssay(page, first.title);
  const held = await holdResponse(page, `**/api/studio/articles/${first.id}/polish`, 'POST');
  try {
    await page.getByRole('button', { name: 'Run the ghostwriter', exact: true }).click();
    await held.received;
    await page.getByRole('button', { name: 'Essays', exact: true }).click();
    await openEssay(page, second.title);
    const completed = page.waitForResponse((response) =>
      response.url().endsWith(`/articles/${first.id}/polish`),
    );
    held.release();
    await completed;
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    await expect(page.getByText('Article polishing is not configured on this server.')).toHaveCount(
      0,
    );
    await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
      second.title,
    );
  } finally {
    held.release();
  }
});

test('a conflict reload cannot replace an essay opened while the reload was pending', async ({
  page,
}) => {
  const [first, second] = await openWorkspace(page);
  await openEssay(page, first.title);
  const read = await page.request.get(`/api/studio/articles/${first.id}`);
  const { article } = await read.json();
  const changed = await page.request.put(`/api/studio/articles/${first.id}`, {
    headers: { Origin: origin },
    data: {
      expectedRevision: article.revision,
      document: {
        title: article.title,
        topic: 'Concurrent edit',
        body: article.body,
        ingress: article.ingress,
        tags: article.tags,
        socialPosts: article.socialPosts,
        pullQuotes: article.pullQuotes,
        imagePrompts: article.imagePrompts,
      },
    },
  });
  expect(changed.status()).toBe(200);
  await page.getByRole('textbox', { name: 'Topic', exact: true }).fill('Outdated edit');
  const held = await holdResponse(page, `**/api/studio/articles/${first.id}`, 'GET');
  try {
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await held.received;
    await page.getByRole('button', { name: 'Essays', exact: true }).click();
    await openEssay(page, second.title);
    held.release();
    await page.getByRole('textbox', { name: 'Topic', exact: true }).fill('Second essay edit');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    expect((await readArticle(page, first.id)).title).toBe(first.title);
    expect((await readArticle(page, second.id)).topic).toBe('Second essay edit');
  } finally {
    held.release();
  }
});

type Article = { id: string; title: string; topic: string; slug: string };

for (const receipt of ['recovered', 'failed', 'http-error', 'succeeded'] as const) {
  test(`a delayed ${receipt} polish JSON receipt cannot alter another editor`, async ({ page }) => {
    const [first, second] = await openWorkspace(page);
    const statusPath = `/api/studio/articles/${first.id}/polish/status`;
    let statusRequests = 0;
    await page.route(`**${statusPath}`, async (route) => {
      statusRequests += 1;
      if (statusRequests > 1 && receipt === 'http-error') {
        await route.fulfill({
          status: 503,
          json: { error: { message: 'Original essay polish unavailable.' } },
        });
        return;
      }
      await route.fulfill({
        json: {
          status: {
            articleId: first.id,
            mode: 'developed',
            state:
              statusRequests === 1 ? 'running' : receipt === 'succeeded' ? 'succeeded' : 'failed',
            error: { code: 'synthetic_failure', message: 'Original essay polish failed.' },
          },
        },
      });
    });
    const body = await holdJsonBody(
      page,
      receipt === 'succeeded' ? `/api/studio/articles/${first.id}` : statusPath,
      receipt === 'recovered' ? 1 : 2,
    );
    try {
      await openEssay(page, first.title);
      await body.received();
      await page.getByRole('button', { name: 'Essays', exact: true }).click();
      await openEssay(page, second.title);
      await body.release();
      await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
        second.title,
      );
      await expect(page.getByRole('textbox', { name: 'Topic', exact: true })).toBeEnabled();
      await expect(page.getByText('Original essay polish failed.', { exact: true })).toHaveCount(0);
      await expect(
        page.getByText('Original essay polish unavailable.', { exact: true }),
      ).toHaveCount(0);
    } finally {
      await body.release();
    }
  });
}

type JsonBodyGate = { ready: boolean; release: () => void };

async function holdJsonBody(page: Page, path: string, occurrence: number) {
  await page.evaluate(
    ({ path, occurrence }) => {
      const browser = window as typeof window & { studioJsonBodyGate?: JsonBodyGate };
      const originalFetch = browser.fetch.bind(browser);
      let release = () => {};
      const pending = new Promise<void>((resolve) => (release = resolve));
      const gate = { ready: false, release };
      browser.studioJsonBodyGate = gate;
      let received = 0;
      browser.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (new URL(response.url).pathname !== path || ++received !== occurrence) return response;
        const originalJson = response.json.bind(response);
        response.json = async () => {
          const payload = await originalJson();
          gate.ready = true;
          await pending;
          return payload;
        };
        return response;
      };
    },
    { path, occurrence },
  );
  return {
    received: () =>
      page.waitForFunction(
        () =>
          (window as typeof window & { studioJsonBodyGate?: JsonBodyGate }).studioJsonBodyGate
            ?.ready === true,
      ),
    release: () =>
      page.evaluate(async () => {
        (
          window as typeof window & { studioJsonBodyGate?: JsonBodyGate }
        ).studioJsonBodyGate?.release();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }),
  };
}

for (const failure of ['http', 'network'] as const) {
  test(`failed ${failure} logout retains the editor and a successful retry clears the session`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const [article] = await openWorkspace(page);
    await openEssay(page, article.title);
    await page.getByRole('textbox', { name: 'Topic', exact: true }).fill('Unsaved author text');
    let rejected = false;
    await page.route('**/api/studio/logout', async (route) => {
      if (rejected) {
        await route.fallback();
        return;
      }
      rejected = true;
      if (failure === 'network') await route.abort('failed');
      else
        await route.fulfill({
          status: 503,
          json: { error: { message: 'Synthetic logout refusal.' } },
        });
    });
    await logout(page);
    await expect(
      page.getByText(
        failure === 'http' ? 'Synthetic logout refusal.' : 'Studio could not sign out. Try again.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Topic', exact: true })).toHaveValue(
      'Unsaved author text',
    );
    expect(await (await page.request.get('/api/studio/session')).json()).toEqual({
      authenticated: true,
    });
    await logout(page);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(await (await page.request.get('/api/studio/session')).json()).toEqual({
      authenticated: false,
    });
    expect(errors).toEqual([]);
  });
}

async function logout(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: 'Account actions for Michael Wargr', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
}

async function openWorkspace(page: Page): Promise<[Article, Article]> {
  const login = await page.request.post('/api/studio/login', {
    headers: { Origin: origin },
    data: { username: 'dev', password: 'dev' },
  });
  expect(login.status()).toBe(200);
  const articles: Article[] = [];
  for (const name of ['First', 'Second']) {
    const response = await page.request.post('/api/studio/articles', {
      headers: { Origin: origin },
      data: { title: `${name} synthetic ${randomUUID()}` },
    });
    expect(response.status()).toBe(201);
    articles.push((await response.json()).article);
  }
  await page.goto('/studio');
  return articles as [Article, Article];
}

async function openEssay(page: Page, title: string): Promise<void> {
  await page.getByText(title, { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(title);
}

async function readArticle(page: Page, id: string): Promise<Article> {
  const response = await page.request.get(`/api/studio/articles/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).article;
}

async function holdResponse(page: Page, url: string, method: string) {
  let release = () => {};
  let received = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ready = new Promise<void>((resolve) => (received = resolve));
  let captured = false;
  const handler = async (route: Route) => {
    if (captured || route.request().method() !== method) {
      await route.fallback();
      return;
    }
    captured = true;
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response });
  };
  await page.route(url, handler);
  return { received: ready, release };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for isolated Wargr E2E.`);
  return value;
}
