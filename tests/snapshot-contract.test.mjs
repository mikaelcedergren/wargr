import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the tracked essay snapshot is internally complete without its external authoring source', async () => {
  const [articleEntries, imageEntries, routes, home, sitemap, feed] = await Promise.all([
    readdir(path.join(repoRoot, 'src', 'app', 'articles')),
    readdir(path.join(repoRoot, 'public', 'assets', 'articles')),
    readFile(path.join(repoRoot, 'src', 'app', 'app.routes.ts'), 'utf8'),
    readFile(path.join(repoRoot, 'src', 'app', 'pages', 'home.component.ts'), 'utf8'),
    readFile(path.join(repoRoot, 'public', 'sitemap.xml'), 'utf8'),
    readFile(path.join(repoRoot, 'public', 'feed.xml'), 'utf8'),
  ]);

  const articleSlugs = sorted(
    articleEntries
      .filter((name) => name.endsWith('.component.ts'))
      .map((name) => name.slice(0, -'.component.ts'.length)),
  );
  assert.ok(articleSlugs.length > 0, 'The tracked snapshot must contain at least one essay.');

  const routeSlugs = sorted(
    [...routes.matchAll(/^\s+path: '([^']+)',$/gm)]
      .map((match) => match[1])
      .filter((slug) => slug !== '**'),
  );
  const homeSlugs = sorted([...home.matchAll(/"slug":"([^"]+)"/g)].map((match) => match[1]));
  const heroSlugs = sorted(
    imageEntries
      .filter((name) => name.endsWith('.jpg') && !name.endsWith('-og.jpg'))
      .map((name) => name.slice(0, -'.jpg'.length)),
  );
  const socialSlugs = sorted(
    imageEntries
      .filter((name) => name.endsWith('-og.jpg'))
      .map((name) => name.slice(0, -'-og.jpg'.length)),
  );
  const sitemapSlugs = sorted(
    [...sitemap.matchAll(/<loc>https:\/\/wargr\.com\/([^<]*)<\/loc>/g)]
      .map((match) => match[1].replace(/\/$/, ''))
      .filter(Boolean),
  );
  const feedSlugs = sorted(
    [...feed.matchAll(/<link>https:\/\/wargr\.com\/([^<]*)<\/link>/g)]
      .map((match) => match[1].replace(/\/$/, ''))
      .filter(Boolean),
  );

  for (const [label, slugs] of [
    ['routes', routeSlugs],
    ['home feed', homeSlugs],
    ['hero images', heroSlugs],
    ['social images', socialSlugs],
    ['sitemap', sitemapSlugs],
    ['RSS feed', feedSlugs],
  ]) {
    assert.deepEqual(slugs, articleSlugs, `${label} must exactly match the tracked essay set`);
  }
});

function sorted(values) {
  return [...new Set(values)].sort();
}
