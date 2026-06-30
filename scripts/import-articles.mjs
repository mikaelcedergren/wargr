#!/usr/bin/env node
// Pulls essays from ../ghostwriter/wargr and generates the Angular pages + routes for wargr.com.
//
// Publishing rule: ONLY files whose name starts with "☑" are published. Everything else is a draft
// and is skipped. (The ghostwriter author marks a piece ready by prefixing the filename with ☑.)
//
// Each ghostwriter file has the shape:
//   # <title>
//   ## Topic: <internal note — NOT shown to readers>
//   ---
//   **<ingress / dek>**          <- reader-facing one-line hook
//   <body markdown...>
//   ---
//   <tags, comma-separated>      <- publishing metadata (we use tags as keywords)
//   1. <pull-quote hook>         <- 2–3 hand-authored pull-quotes (hook + elaboration)...
//   <elaboration...>
//   1. Create a ... photograph   <- ...then thumbnail-generation prompts (start with "Create a")
//
// This runs at build time (and on every ghostwriter change via the sync job). It is idempotent and
// fully regenerates src/app/articles/*, the home feed, app.routes.ts, sitemap.xml, robots.txt and
// the RSS feed. It also derives reading-time, reclaims the pull-quotes, and wires every essay to its
// related + previous/next neighbours so the article pages link into a dense internal graph.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const GHOST = resolve(REPO, '..', 'ghostwriter');
const SRC = join(GHOST, 'wargr');
const APP = join(REPO, 'src', 'app');
const ARTICLES_DIR = join(APP, 'articles');
const PAGES_DIR = join(APP, 'pages');
const SITE_ORIGIN = 'https://wargr.com';
const SITE_NAME = 'Wargr';
const AUTHOR = 'Michael Wargr';
const WORDS_PER_MINUTE = 200; // dense, reflective prose reads a little slower than news copy.
const RELATED_COUNT = 3;
const FILED_TAGS = 6; // how many tags to show in the reader-facing "Filed under" line.

// Per-article imagery follows a slug convention in public/assets/articles/ (drop the files in and they
// wire themselves up; no image => the essay keeps the plain header):
//   <slug>.jpg     -> full-bleed hero photo behind the article header
//   <slug>-og.jpg  -> 1200x630 social card, overriding the default OG image for that essay
// Source masters (full-res, pre-optimisation) live in ../article-images and are NOT deployed.
const ARTICLE_IMG_DIR = join(REPO, 'public', 'assets', 'articles');
const articleImages = existsSync(ARTICLE_IMG_DIR) ? readdirSync(ARTICLE_IMG_DIR) : [];
function findArticleImage(slug, suffix = '') {
  const re = new RegExp(`^${slug}${suffix}\\.(jpe?g|png|webp|avif)$`, 'i');
  const f = articleImages.find((name) => re.test(name));
  return f ? `/assets/articles/${f}` : null;
}

marked.setOptions({ gfm: true, breaks: false });

function slugify(name) {
  return name
    .normalize('NFKD')
    .replace(/[☀-➿️]/g, '') // strip the ☑ and any symbols
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function pascal(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}
function gitDate(filename) {
  try {
    const iso = execFileSync(
      'git',
      ['-C', GHOST, 'log', '-1', '--format=%cI', '--', `wargr/${filename}`],
      {
        encoding: 'utf8',
      },
    ).trim();
    if (iso) return iso;
  } catch {
    /* not a git repo / not committed */
  }
  return statSync(join(SRC, filename)).mtime.toISOString();
}
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
function fmtMonth(iso) {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
}
function escapeXml(s) {
  return String(s).replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c],
  );
}
function countWords(md) {
  return md
    .replace(/`[^`]*`/g, ' ') // drop inline code
    .replace(/[#>*_~`>\-]/g, ' ') // drop common markdown punctuation
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Pull the hand-authored pull-quotes out of the trailing metadata. They are numbered blocks
 * ("1. <hook>\n\n<elaboration>"); the thumbnail prompts are ALSO numbered but their hook starts with
 * "Create a", so we drop those. Returns up to 3 { hook, elab } pairs (possibly empty).
 */
function parsePullQuotes(trailing) {
  if (!trailing) return [];
  const items = [];
  let cur = null;
  for (const line of trailing.split('\n')) {
    const m = line.match(/^\s*\d+\.\s+(.*)$/);
    if (m) {
      if (cur) items.push(cur);
      cur = { hook: m[1].trim(), rest: [] };
    } else if (cur) {
      cur.rest.push(line);
    }
  }
  if (cur) items.push(cur);
  return items
    .filter((it) => it.hook && !/^create\b/i.test(it.hook))
    .slice(0, 3)
    .map((it) => ({ hook: it.hook, elab: it.rest.join('\n').trim() }));
}

function parse(filename) {
  const raw = readFileSync(join(SRC, filename), 'utf8').replace(/\r\n/g, '\n');
  const slug = slugify(filename);
  const titleMatch = raw.match(/^#\s+(.+?)\s*$/m);
  const topicMatch = raw.match(/^##\s+Topic:\s*(.+?)\s*$/m);
  const title = titleMatch ? titleMatch[1].trim() : slug;

  // Split on horizontal rules. Published shape => [preamble, body, trailingMeta].
  const parts = raw.split(/^\s*---\s*$/m);
  let bodyMd = (parts.length >= 3 ? parts[1] : parts.slice(1).join('\n---\n')).trim();
  const trailing = parts.length >= 3 ? parts.slice(2).join('\n').trim() : '';

  // Ingress: the first bolded line of the body is the reader-facing dek; lift it out of the body.
  let dek = topicMatch ? topicMatch[1].trim() : '';
  const lines = bodyMd.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const ing = lines[i] ? lines[i].match(/^\*\*(.+?)\*\*\s*$/) : null;
  if (ing) {
    dek = ing[1].trim();
    lines.splice(0, i + 1);
    bodyMd = lines.join('\n').trim();
  }

  // Tags: first non-empty line of the trailing metadata, comma-separated.
  let tags = [];
  if (trailing) {
    const firstLine = trailing.split('\n').find((l) => l.trim());
    if (firstLine && firstLine.includes(',')) {
      tags = firstLine
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 20);
    }
  }

  const iso = gitDate(filename);
  const bodyHtml = marked.parse(bodyMd);
  const wordCount = countWords(bodyMd);
  const readingTime = Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
  const pullQuotes = parsePullQuotes(trailing);
  const ogCard = findArticleImage(slug, '-og');

  return {
    slug,
    title,
    dek,
    bodyHtml,
    dropcap: bodyHtml.trimStart().startsWith('<p'), // drop cap only when the first block is a paragraph
    tags,
    dominantTag: tags[0] || '',
    iso,
    date: fmtDate(iso),
    monthYear: fmtMonth(iso),
    wordCount,
    readingTime,
    pullQuotes,
    coda: pullQuotes.length ? pullQuotes[pullQuotes.length - 1] : null, // close on the sharpest line
    hero: findArticleImage(slug), // full-bleed header photo, or null for the plain header
    ogImage: ogCard ? SITE_ORIGIN + ogCard : null, // per-essay social card overriding the default
  };
}

/**
 * For each essay, rank the others by weighted shared-tag overlap. Tags that appear in more than half
 * the corpus (e.g. "philosophy", "human nature") carry no weight, so "related" stays topically
 * specific instead of degrading to "all of them". Ties break by recency; thin matches backfill with
 * the most recent others so the block is never empty.
 */
function buildRelated(published) {
  const n = published.length;
  const df = new Map();
  for (const a of published) for (const t of new Set(a.tags)) df.set(t, (df.get(t) || 0) + 1);
  const ubiquitous = n / 2;

  for (const a of published) {
    const aTags = new Set(a.tags);
    const scored = published
      .filter((b) => b.slug !== a.slug)
      .map((b) => {
        const shared = [...new Set(b.tags)].filter((t) => aTags.has(t) && df.get(t) <= ubiquitous);
        shared.sort((x, y) => df.get(x) - df.get(y)); // rarest (most specific) shared tag first
        return { b, score: shared.length, shared };
      });
    scored.sort((x, y) => y.score - x.score || (x.b.iso < y.b.iso ? 1 : -1));

    let top = scored.filter((s) => s.score >= 1).slice(0, RELATED_COUNT);
    if (top.length < RELATED_COUNT) {
      const have = new Set(top.map((s) => s.b.slug));
      const backfill = scored
        .filter((s) => !have.has(s.b.slug))
        .sort((x, y) => (x.b.iso < y.b.iso ? 1 : -1))
        .slice(0, RELATED_COUNT - top.length);
      top = top.concat(backfill);
    }

    a.related = top.map(({ b, shared }) => ({
      slug: b.slug,
      title: b.title,
      dek: b.dek,
      meta: `${b.monthYear} · ${b.readingTime} min${shared[0] ? ` · Shared: ${shared[0]}` : ''}`,
    }));
  }

  // Chronological flip: published is newest-first, so prev = older (next index), next = newer.
  published.forEach((a, i) => {
    const older = published[i + 1];
    const newer = published[i - 1];
    a.prev = older ? { slug: older.slug, title: older.title } : null;
    a.next = newer ? { slug: newer.slug, title: newer.title } : null;
  });
}

function writeArticleComponent(a) {
  const cls = `Article${pascal(a.slug)}Component`;
  const proseClass = a.dropcap ? 'wg-prose wg-prose--dropcap' : 'wg-prose';
  const filed = a.tags.slice(0, FILED_TAGS).join(' · ');
  const meta = `${a.date} · ${a.readingTime} min read · ${a.wordCount} words`;
  const src = `import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DomSanitizer } from '@angular/platform-browser';

// Generated by scripts/import-articles.mjs from ../ghostwriter/wargr. Do not edit by hand.
const HTML = ${JSON.stringify(a.bodyHtml)};

type WgLink = { slug: string; title: string };
type WgQuote = { hook: string; elab: string };
type WgRelated = { slug: string; title: string; dek: string; meta: string };

@Component({
  selector: 'wg-a-${a.slug}',
  imports: [RouterLink],
  template: \`
    @if (hero) {
      <header class="wg-hero">
        <img class="wg-hero__img" [src]="hero" alt="" fetchpriority="high" />
        <div class="wg-hero__scrim" aria-hidden="true"></div>
        <div class="wg-hero__inner wg-container">
          <a class="wg-back wg-back--hero" routerLink="/">← Essays</a>
          <div class="wg-hero__head">
            @if (kicker) { <p class="wg-kicker">{{ kicker }}</p> }
            <h1 class="wg-article__title">{{ title }}</h1>
            @if (dek) { <p class="wg-article__dek">{{ dek }}</p> }
            <p class="wg-article__meta wg-meta">{{ meta }}</p>
          </div>
        </div>
      </header>
    }
    <article class="wg-container wg-article" [class.wg-article--hero]="!!hero">
      @if (!hero) {
        <a class="wg-back" routerLink="/">← Essays</a>
        @if (kicker) { <p class="wg-kicker">{{ kicker }}</p> }
        <h1 class="wg-article__title">{{ title }}</h1>
        @if (dek) { <p class="wg-article__dek">{{ dek }}</p> }
        <p class="wg-article__meta wg-meta">{{ meta }}</p>
      }
      <div class="${proseClass}" [innerHTML]="body"></div>
      @if (coda) {
        <figure class="wg-pullquote">
          <p class="wg-pullquote__hook">{{ coda.hook }}</p>
          @if (coda.elab) { <figcaption class="wg-pullquote__elab">{{ coda.elab }}</figcaption> }
        </figure>
      }
      @if (filed) { <p class="wg-filed">Filed under: {{ filed }}</p> }
      <p class="wg-finis" aria-hidden="true">§</p>
    </article>
    @if (related.length || prev || next) {
      <aside class="wg-next">
        <div class="wg-container">
          @if (related.length) {
            <nav class="wg-related" aria-label="Related essays">
              <p class="wg-related__head">Related essays</p>
              @for (r of related; track r.slug) {
                <a class="wg-related__item" [routerLink]="['/', r.slug]">
                  <span class="wg-related__title">{{ r.title }}</span>
                  @if (r.dek) { <span class="wg-related__dek">{{ r.dek }}</span> }
                  <span class="wg-meta wg-related__meta">{{ r.meta }}</span>
                </a>
              }
            </nav>
          }
          @if (prev || next) {
            <nav class="wg-flip" aria-label="Essay navigation">
              @if (prev) {
                <a class="wg-flip__side wg-flip__prev" [routerLink]="['/', prev.slug]" rel="prev">
                  <span class="wg-flip__label">Previous</span>
                  <span class="wg-flip__title">{{ prev.title }}</span>
                </a>
              } @else {
                <span class="wg-flip__side"></span>
              }
              @if (next) {
                <a class="wg-flip__side wg-flip__next" [routerLink]="['/', next.slug]" rel="next">
                  <span class="wg-flip__label">Next</span>
                  <span class="wg-flip__title">{{ next.title }}</span>
                </a>
              } @else {
                <span class="wg-flip__side"></span>
              }
            </nav>
          }
        </div>
      </aside>
    }
  \`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ${cls} {
  protected readonly title = ${JSON.stringify(a.title)};
  protected readonly dek = ${JSON.stringify(a.dek)};
  protected readonly meta = ${JSON.stringify(meta)};
  protected readonly kicker = ${JSON.stringify(a.dominantTag)};
  protected readonly filed = ${JSON.stringify(filed)};
  protected readonly coda: WgQuote | null = ${JSON.stringify(a.coda)};
  protected readonly related: WgRelated[] = ${JSON.stringify(a.related)};
  protected readonly prev: WgLink | null = ${JSON.stringify(a.prev)};
  protected readonly next: WgLink | null = ${JSON.stringify(a.next)};
  protected readonly hero: string | null = ${JSON.stringify(a.hero)};
  protected readonly body = inject(DomSanitizer).bypassSecurityTrustHtml(HTML);
}
`;
  mkdirSync(ARTICLES_DIR, { recursive: true });
  writeFileSync(join(ARTICLES_DIR, `${a.slug}.component.ts`), src);
  return cls;
}

function writeHome(articles) {
  const feed = articles.map((a) => ({
    slug: a.slug,
    title: a.title,
    dek: a.dek,
    kicker: a.dominantTag,
    meta: `${a.monthYear} · ${a.readingTime} min read`,
  }));
  const src = `import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

// Generated by scripts/import-articles.mjs. Do not edit by hand.
@Component({
  selector: 'wg-home',
  imports: [RouterLink],
  template: \`
    <section class="wg-container wg-feed">
      <p class="wg-feed__dek">Essays on character, fear, and the stories we tell ourselves.</p>
      @for (a of articles; track a.slug; let first = $first) {
        <article class="wg-entry" [class.wg-entry--lead]="first">
          @if (a.kicker) { <p class="wg-kicker">{{ a.kicker }}</p> }
          <h2 class="wg-entry__title"><a [routerLink]="['/', a.slug]">{{ a.title }}</a></h2>
          @if (a.dek) { <p class="wg-entry__dek">{{ a.dek }}</p> }
          <p class="wg-meta wg-entry__meta">{{ a.meta }}</p>
        </article>
      }
    </section>
  \`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomeComponent {
  protected readonly articles = ${JSON.stringify(feed)};
}
`;
  mkdirSync(PAGES_DIR, { recursive: true });
  writeFileSync(join(PAGES_DIR, 'home.component.ts'), src);
}

function writeNotFound() {
  const src = `import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'wg-not-found',
  imports: [RouterLink],
  template: \`
    <section class="wg-container wg-article">
      <h1 class="wg-article__title">Not found</h1>
      <p class="wg-article__dek">That page doesn't exist.</p>
      <a class="wg-back" routerLink="/">← Essays</a>
    </section>
  \`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFoundComponent {}
`;
  writeFileSync(join(PAGES_DIR, 'not-found.component.ts'), src);
}

function writeRoutes(articles, classes) {
  const entries = articles.map((a, idx) => {
    const seo = {
      path: `/${a.slug}/`,
      description: a.dek || a.title,
      ogType: 'article',
      ...(a.tags.length ? { keywords: a.tags.join(', ') } : {}),
      datePublished: a.iso,
      wordCount: a.wordCount,
      readingTime: a.readingTime,
      ...(a.dominantTag ? { articleSection: a.dominantTag } : {}),
      ...(a.related.length ? { relatedSlugs: a.related.map((r) => r.slug) } : {}),
      ...(a.prev ? { prevPath: `/${a.prev.slug}/` } : {}),
      ...(a.next ? { nextPath: `/${a.next.slug}/` } : {}),
      ...(a.ogImage ? { ogImage: a.ogImage } : {}),
    };
    return `  {
    path: '${a.slug}',
    loadComponent: () => import('./articles/${a.slug}.component').then((m) => m.${classes[idx]}),
    title: ${JSON.stringify(`${a.title} — ${SITE_NAME}`)},
    data: { seo: ${JSON.stringify(seo)} satisfies PageSeo },
  },`;
  });
  const homeSeo = {
    path: '/',
    description: 'Essays by Michael Wargr.',
    itemList: articles.map((a) => ({ url: `${SITE_ORIGIN}/${a.slug}/`, name: a.title })),
  };
  const src = `import { Routes } from '@angular/router';
import { PageSeo } from './shared/seo';

// GENERATED by scripts/import-articles.mjs from ../ghostwriter/wargr. Do not edit by hand.
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/home.component').then((m) => m.HomeComponent),
    title: 'Wargr — essays by Michael Wargr',
    data: { seo: ${JSON.stringify(homeSeo)} satisfies PageSeo },
  },
${entries.join('\n')}
  {
    path: '**',
    loadComponent: () => import('./pages/not-found.component').then((m) => m.NotFoundComponent),
    title: 'Not found — Wargr',
    data: { seo: { path: '/404', description: 'Not found.', noindex: true } satisfies PageSeo },
  },
];
`;
  writeFileSync(join(APP, 'app.routes.ts'), src);
}

function writeFeed(articles) {
  const items = articles
    .map(
      (a) => `    <item>
      <title>${escapeXml(a.title)}</title>
      <link>${SITE_ORIGIN}/${a.slug}/</link>
      <guid isPermaLink="true">${SITE_ORIGIN}/${a.slug}/</guid>
      <pubDate>${new Date(a.iso).toUTCString()}</pubDate>
      <description>${escapeXml(a.dek || a.title)}</description>
      ${a.tags.map((t) => `<category>${escapeXml(t)}</category>`).join('')}
    </item>`,
    )
    .join('\n');
  const updated = articles[0] ? new Date(articles[0].iso).toUTCString() : new Date(0).toUTCString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${SITE_NAME} — essays by ${AUTHOR}</title>
    <link>${SITE_ORIGIN}/</link>
    <atom:link href="${SITE_ORIGIN}/feed.xml" rel="self" type="application/rss+xml" />
    <description>Essays by ${AUTHOR}.</description>
    <language>en-us</language>
    <lastBuildDate>${updated}</lastBuildDate>
${items}
  </channel>
</rss>
`;
  mkdirSync(join(REPO, 'public'), { recursive: true });
  writeFileSync(join(REPO, 'public', 'feed.xml'), xml);
}

function writeSitemapAndRobots(articles) {
  const urls = [`${SITE_ORIGIN}/`, ...articles.map((a) => `${SITE_ORIGIN}/${a.slug}/`)];
  const lastmod = articles.map((a) => a.iso.slice(0, 10));
  const body = urls
    .map(
      (u, i) =>
        `  <url><loc>${u}</loc>${i > 0 ? `<lastmod>${lastmod[i - 1]}</lastmod>` : ''}</url>`,
    )
    .join('\n');
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  mkdirSync(join(REPO, 'public'), { recursive: true });
  writeFileSync(join(REPO, 'public', 'sitemap.xml'), sitemap);
  writeFileSync(
    join(REPO, 'public', 'robots.txt'),
    `User-agent: *\nAllow: /\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
  );
}

// ---- run ----
if (!existsSync(SRC)) {
  console.error(`[import] ghostwriter source not found: ${SRC}`);
  process.exit(1);
}
// Clean previously-generated output so removed/unpublished pieces disappear.
rmSync(ARTICLES_DIR, { recursive: true, force: true });

const published = readdirSync(SRC)
  .filter((f) => f.endsWith('.md') && f.trimStart().startsWith('☑'))
  .map(parse)
  .sort((a, b) => (a.iso < b.iso ? 1 : -1)); // newest first

buildRelated(published);

const classes = published.map(writeArticleComponent);
writeHome(published);
writeNotFound();
writeRoutes(published, classes);
writeFeed(published);
writeSitemapAndRobots(published);

console.log(`[import] published ${published.length} essays:`);
for (const a of published) {
  console.log(
    `  - /${a.slug}/  "${a.title}"  (${a.date}, ${a.readingTime} min, ${a.tags.length} tags, ${a.pullQuotes.length} quotes, ${a.related.length} related)`,
  );
}
