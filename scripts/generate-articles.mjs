#!/usr/bin/env node
// Generates the Angular pages + routes for wargr.com from the article database — the Admin
// authoring source that replaced the retired ghostwriter repository. Only articles in the
// published state enter the site; drafts and their round history never leave the database.
//
// This runs inside the generated-content transaction (scheduled by the publisher when the
// published closure changes, or manually via pnpm generate:content). It is idempotent and fully
// regenerates src/app/articles/*, the blog index, app.routes.ts, sitemap.xml, robots.txt and the
// RSS feed. It also derives reading-time, renders the structured pull-quotes, and wires every
// story to its related + previous/next neighbours so the article pages link into a dense internal
// graph.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { preflightPublishedArticleInventory } from './article-slugs.mjs';

const TOOL_REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const REPO = resolve(process.env.WARGR_REPO_ROOT ?? TOOL_REPO);
if (!process.env.WARGR_GENERATED_OUTPUT_ROOT) {
  throw new Error(
    'generate-articles.mjs is a staging-only generator; use the generated-content transaction.',
  );
}
const OUTPUT_ROOT = resolve(process.env.WARGR_GENERATED_OUTPUT_ROOT);
if (OUTPUT_ROOT === REPO) {
  throw new Error('Article generation staging output must not be the mutable Wargr checkout root.');
}
const DB_PATH = resolve(process.env.WARGR_DB_PATH ?? join(REPO, 'data', 'wargr.db'));
const APP = join(OUTPUT_ROOT, 'src', 'app');
const ARTICLES_DIR = join(APP, 'articles');
const PAGES_DIR = join(APP, 'pages');
const SITE_ORIGIN = 'https://wargr.com';
const SITE_NAME = 'Wargr';
const AUTHOR = 'Michael Wargr';
const BLOG_DESCRIPTION =
  'Stories by Michael Wargr on philosophy, ethics, fear, self-deception, conformity, purpose, pain, and human nature.';
const WORDS_PER_MINUTE = 200; // dense, reflective prose reads a little slower than news copy.
const RELATED_COUNT = 3;

const AUTHOR_KNOWS_ABOUT = [
  'Philosophy',
  'Ethics',
  'Human nature',
  'Fear',
  'Self-deception',
  'Conformity',
  'Purpose',
  'Pain',
  'Accountability',
  'Moral psychology',
];

const SEO_BY_SLUG = {
  'wtf-is-self-love': {
    title: 'WTF is self-love? — Michael Wargr',
    description:
      'A sharp story on self-love, negative self-talk, loneliness, and learning to speak to yourself with the kindness you give other people.',
    phrases: [
      'self-love',
      'negative self-talk',
      'inner voice',
      'loneliness',
      'mental health',
      'self-compassion',
      'wellness critique',
      'how to talk to yourself',
    ],
    imageAlt:
      'A face reflected in dark glass, matching a story on self-love and negative self-talk.',
  },
  'whom-to-listen-to': {
    title: 'Who to listen to when everyone agrees — Michael Wargr',
    description:
      'A story on consensus, dissent, expertise, and why the lone voice is sometimes worth hearing before everyone else catches up.',
    phrases: [
      'who to listen to',
      'consensus and dissent',
      'experts and outsiders',
      'contrarian ideas',
      'intellectual courage',
      'truth and consensus',
      'medical history',
      'paradigm shifts',
    ],
    imageAlt: 'A microphone on an empty lecture table, matching a story on consensus and dissent.',
  },
  'stop-the-pain': {
    title: 'How to stop emotional pain — Michael Wargr',
    description:
      'A story on emotional pain, avoidance, numbing, and why healing begins when you stop running from what needs to be heard.',
    phrases: [
      'how to stop emotional pain',
      'emotional pain',
      'avoidance',
      'numbing',
      'healing',
      'sit with pain',
      'pain and addiction',
      'mental health',
    ],
    imageAlt: 'A dark, quiet scene matching a story on emotional pain, avoidance, and healing.',
  },
  'stop-chasing-purpose': {
    title: 'Stop chasing purpose — Michael Wargr',
    description:
      'A story on purpose anxiety, meaning, and the quiet freedom of putting down the search for a life-defining mission.',
    phrases: [
      'stop chasing purpose',
      'purpose anxiety',
      'finding meaning',
      'meaning in life',
      'life purpose',
      'existential search',
      'self-help critique',
      'quiet purpose',
    ],
    imageAlt:
      'A quiet path through open landscape, matching a story on purpose, meaning, and letting go.',
  },
  slaughterhouse: {
    title: 'Herd mentality and the slaughterhouse — Michael Wargr',
    description:
      'A story on herd mentality, conformity, propaganda, and the invisible ways people choose the stories that lead them.',
    phrases: [
      'herd mentality',
      'conformity',
      'propaganda',
      'mass psychology',
      'consensus',
      'dissent',
      'media manipulation',
      'groupthink',
    ],
    imageAlt:
      'Meat on a table in a slaughterhouse, matching a story on conformity and herd mentality.',
  },
  'meant-well': {
    title: "I'm sorry. I meant well. — Michael Wargr",
    description:
      'A story on good intentions, harm, accountability, and why meaning well does not undo the damage people cause.',
    phrases: [
      'good intentions',
      'intentions versus impact',
      'accountability',
      'meaning well',
      'harm and responsibility',
      'self-deception',
      'moral philosophy',
      'relationships',
    ],
    imageAlt: 'A tense human scene matching a story on good intentions, harm, and accountability.',
  },
  corruption: {
    title: 'How fear turns good people into corruption — Michael Wargr',
    description:
      'A story on corruption, moral compromise, fear, integrity, and how good people become what they once opposed.',
    phrases: [
      'how good people become corrupt',
      'corruption',
      'moral compromise',
      'fear and integrity',
      'ethical failure',
      'power and responsibility',
      'self-deception',
      'character',
    ],
    imageAlt:
      'A solitary figure in a dark room, matching a story on fear, integrity, and corruption.',
  },
};

// Every published article requires the optimized pair generated by prepare-article-images.mjs:
//   <slug>.jpg     -> article hero photo
//   <slug>-og.jpg  -> 1200x630 social card for that story
// Source masters (full-res, pre-optimisation) live in article-images and are NOT deployed.
const ARTICLE_IMG_DIR = join(OUTPUT_ROOT, 'public', 'assets', 'articles');
const articleImages = existsSync(ARTICLE_IMG_DIR) ? readdirSync(ARTICLE_IMG_DIR) : [];
function requireArticleImage(slug, suffix = '') {
  const filename = `${slug}${suffix}.jpg`;
  if (!articleImages.includes(filename)) {
    throw new Error(
      `Missing required article image: public/assets/articles/${filename}. Run pnpm images.`,
    );
  }
  return `/assets/articles/${filename}`;
}

marked.setOptions({ gfm: true, breaks: false });

// The rendered body is injected via [innerHTML] (bypassSecurityTrustHtml in the generated
// components), so the HTML is sanitized ONCE here at import time — never in the Angular runtime.
// The allowlist is exactly what the shared editorial typography supports plus the rest of marked's plain
// story output; scripts, iframes, event handlers and javascript: URLs are stripped. The text filter
// re-applies marked's quote escaping so legitimate stories pass through byte-identical.
const SANITIZE_OPTIONS = {
  allowedTags: [
    'p',
    'br',
    'h1',
    'h2',
    'h3',
    'h4',
    'strong',
    'em',
    'del',
    'a',
    'blockquote',
    'ul',
    'ol',
    'li',
    'hr',
    'img',
    'code',
    'pre',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title'],
    ol: ['start'],
    code: ['class'], // marked marks fenced code blocks with class="language-…"
  },
  allowedClasses: { code: [/^language-/] },
  allowedSchemes: ['https', 'http', 'mailto'],
  allowProtocolRelative: false,
  textFilter: (text) => text.replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
};

function pascal(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}
// The record's own publish date is the date of record: it travels with the story, so every machine
// builds the same dates. The record's modified date is Admin's last accepted write. A date-only
// value normalises to noon UTC so it renders as the same calendar day in every timezone.
function articleDates(record) {
  let published = record.publishedAt;
  if (/^\d{4}-\d{2}-\d{2}$/.test(published)) published = `${published}T12:00:00Z`;
  let modified = record.updatedAt;
  if (new Date(modified) < new Date(published)) modified = published;
  return { published, modified };
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

function unique(items) {
  const seen = new Set();
  return items
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function seoForArticle({ slug, title, dek, tags }) {
  const configured = SEO_BY_SLUG[slug] ?? {};
  const topic = tags[0] || '';
  const phrases = unique([
    ...(configured.phrases ?? []),
    `${title.replace(/[“”"]/g, '').trim()} story`,
    topic && `${topic} story`,
    ...tags,
    'Michael Wargr',
    'Wargr stories',
    'philosophy stories',
    'stories on human nature',
  ]);

  return {
    title: configured.title ?? `${title} — ${AUTHOR}`,
    description: configured.description ?? (dek || `${title}, a story by ${AUTHOR}.`),
    phrases,
    imageAlt: configured.imageAlt ?? `${title}, a story by ${AUTHOR}.`,
  };
}

/** Map one stored published record onto the exact article shape the site generator renders. */
function fromRecord({ slug, record }) {
  const title = record.title;
  const dek = record.ingress;
  const tags = record.tags.slice(0, 20);
  const dates = articleDates(record);
  const bodyHtml = sanitizeHtml(marked.parse(record.body), SANITIZE_OPTIONS);
  const wordCount = countWords(record.body);
  const readingTime = Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
  const pullQuotes = record.pullQuotes.map((quote) => ({
    hook: quote.hook,
    elab: quote.expansion,
  }));
  const seo = seoForArticle({ slug, title, dek, tags });
  const hero = requireArticleImage(slug);
  const ogCard = requireArticleImage(slug, '-og');

  return {
    slug,
    title,
    dek,
    bodyHtml,
    tags,
    seoTitle: seo.title,
    seoDescription: seo.description,
    seoPhrases: seo.phrases,
    imageAlt: seo.imageAlt,
    dominantTag: tags[0] || '',
    iso: dates.published,
    modifiedIso: dates.modified,
    date: fmtDate(dates.published),
    monthYear: fmtMonth(dates.published),
    wordCount,
    readingTime,
    pullQuotes,
    hero,
    ogImage: SITE_ORIGIN + ogCard,
  };
}

/**
 * For each story, rank the others by weighted shared-tag overlap. Tags that appear in more than half
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
        return { b, score: shared.length };
      });
    scored.sort(
      (x, y) =>
        y.score - x.score ||
        new Date(y.b.iso) - new Date(x.b.iso) ||
        (x.b.slug < y.b.slug ? -1 : 1),
    );

    let top = scored.filter((s) => s.score >= 1).slice(0, RELATED_COUNT);
    if (top.length < RELATED_COUNT) {
      const have = new Set(top.map((s) => s.b.slug));
      const backfill = scored
        .filter((s) => !have.has(s.b.slug))
        .sort((x, y) => new Date(y.b.iso) - new Date(x.b.iso) || (x.b.slug < y.b.slug ? -1 : 1))
        .slice(0, RELATED_COUNT - top.length);
      top = top.concat(backfill);
    }

    a.related = top.map(({ b }) => ({
      slug: b.slug,
      title: b.title,
      dek: b.dek,
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
  const metaRest = ` · ${a.readingTime} min read`;
  const src = `import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DomSanitizer } from '@angular/platform-browser';
import { CxHeroComponent, CxStackComponent } from '@mikaelcedergren/cx-framework';

// Generated by scripts/generate-articles.mjs from the wargr article database. Do not edit by hand.
const HTML = ${JSON.stringify(a.bodyHtml)};

type WgRelated = { slug: string; title: string; dek: string };

@Component({
  selector: 'wg-a-${a.slug}',
  imports: [RouterLink, CxHeroComponent, CxStackComponent],
  template: \`
    <cx-stack gap="2xl">
    <cx-hero [heading]="title" layout="cover" [overlayOpacity]="60">
      <a context class="cx-text-ink" routerLink="/">Home</a>
      @if (dek) { <p body>{{ dek }}</p> }
      <p meta><time [attr.datetime]="datetime">{{ date }}</time>{{ metaRest }}</p>
      <img media [src]="hero" [alt]="imageAlt" fetchpriority="high" />
    </cx-hero>
    <article class="cx-container wg-section">
      <div class="cx-editorial cx-measure-md" [innerHTML]="body"></div>
    </article>
    </cx-stack>
    @if (related.length) {
      <aside class="cx-container wg-section" aria-label="Related stories">
        <cx-stack class="cx-measure-md" gap="lg">
          <h2>Related stories</h2>
          @for (r of related; track r.slug) {
            <div class="cx-editorial">
              <h3><a [routerLink]="['/', r.slug]">{{ r.title }}</a></h3>
              <p>{{ r.dek }}</p>
            </div>
          }
          <a routerLink="/">All stories</a>
        </cx-stack>
      </aside>
    }
  \`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ${cls} {
  protected readonly title = ${JSON.stringify(a.title)};
  protected readonly dek = ${JSON.stringify(a.dek)};
  protected readonly date = ${JSON.stringify(a.date)};
  protected readonly datetime = ${JSON.stringify(a.iso.slice(0, 10))};
  protected readonly metaRest = ${JSON.stringify(metaRest)};
  protected readonly imageAlt = ${JSON.stringify(a.imageAlt)};
  protected readonly related: WgRelated[] = ${JSON.stringify(a.related)};
  protected readonly hero = ${JSON.stringify(a.hero)};
  protected readonly body = inject(DomSanitizer).bypassSecurityTrustHtml(HTML);
}
`;
  mkdirSync(ARTICLES_DIR, { recursive: true });
  writeFileSync(join(ARTICLES_DIR, `${a.slug}.component.ts`), src);
  return cls;
}

function writeBlog(articles) {
  const feed = articles.map((a) => ({
    slug: a.slug,
    title: a.title,
    dek: a.dek,
    image: a.hero,
    imageAlt: a.imageAlt,
    monthYear: a.monthYear,
    monthDatetime: a.iso.slice(0, 7),
    metaRest: ` · ${a.readingTime} min read`,
  }));
  const src = `import { ChangeDetectionStrategy, Component } from '@angular/core';
import { CxHeroComponent, CxButtonComponent, CxCardComponent, CxGridComponent, CxStackComponent, CxImageComponent } from '@mikaelcedergren/cx-framework';

// Generated by scripts/generate-articles.mjs. Do not edit by hand.
@Component({
  selector: 'wg-blog',
  imports: [CxHeroComponent, CxButtonComponent, CxCardComponent, CxGridComponent, CxStackComponent, CxImageComponent],
  template: \`
    <cx-stack gap="2xl">
    @if (latest; as a) {
      <cx-hero [heading]="a.title" layout="cover" [overlayOpacity]="60">
        <span context>Latest story</span>
        @if (a.dek) { <p body>{{ a.dek }}</p> }
        <cx-button actions text="Read the story" [href]="'/' + a.slug + '/'" [ariaLabel]="'Read ' + a.title" />
        <p meta><time [attr.datetime]="a.monthDatetime">{{ a.monthYear }}</time>{{ a.metaRest }}</p>
        <img media [src]="a.image" [alt]="a.imageAlt" fetchpriority="high" />
      </cx-hero>
    } @else {
      <cx-hero heading="Home">
        <p body>No stories published yet.</p>
      </cx-hero>
    }
    @if (remaining.length) {
    <section class="cx-container wg-section" aria-label="Stories">
      <cx-grid [columns]="2" [columnsMobile]="1" gap="xl">
        @for (a of remaining; track a.slug; let index = $index) {
          <cx-card variant="discreet" [href]="'/' + a.slug + '/'" [ariaLabel]="'Read ' + a.title">
            <cx-stack gap="lg">
              <cx-image [image]="{ src: a.image, alt: a.imageAlt, loading: index < 2 ? 'eager' : 'lazy' }" />
              <div class="cx-editorial">
                <h2>{{ a.title }}</h2>
                @if (a.dek) { <p>{{ a.dek }}</p> }
                <p><small><time [attr.datetime]="a.monthDatetime">{{ a.monthYear }}</time>{{ a.metaRest }}</small></p>
              </div>
            </cx-stack>
          </cx-card>
        }
      </cx-grid>
    </section>
    }
    </cx-stack>
  \`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BlogComponent {
  protected readonly articles = ${JSON.stringify(feed)};
  protected readonly latest = this.articles[0];
  protected readonly remaining = this.articles.slice(1);
}
`;
  mkdirSync(PAGES_DIR, { recursive: true });
  writeFileSync(join(PAGES_DIR, 'blog.component.ts'), src);
}

function writeRoutes(articles, classes) {
  const entries = articles.map((a, idx) => {
    const seo = {
      path: `/${a.slug}/`,
      description: a.seoDescription,
      ogType: 'article',
      headline: a.title,
      keywords: a.seoPhrases.join(', '),
      about: a.seoPhrases,
      datePublished: a.iso,
      dateModified: a.modifiedIso,
      wordCount: a.wordCount,
      readingTime: a.readingTime,
      imageAlt: a.imageAlt,
      ...(a.dominantTag ? { articleSection: a.dominantTag } : {}),
      ...(a.related.length ? { relatedSlugs: a.related.map((r) => r.slug) } : {}),
      ...(a.prev ? { prevPath: `/${a.prev.slug}/` } : {}),
      ...(a.next ? { nextPath: `/${a.next.slug}/` } : {}),
      ogImage: a.ogImage,
    };
    return `  {
    path: '${a.slug}',
    loadComponent: () => import('./articles/${a.slug}.component').then((m) => m.${classes[idx]}),
    title: ${JSON.stringify(a.seoTitle)},
    data: { section: 'blog', seo: ${JSON.stringify(seo)} satisfies PageSeo },
  },`;
  });
  const blogSeo = {
    path: '/',
    description: BLOG_DESCRIPTION,
    headline: 'Stories by Michael Wargr',
    about: AUTHOR_KNOWS_ABOUT,
    itemList: articles.map((a) => ({ url: `${SITE_ORIGIN}/${a.slug}/`, name: a.title })),
  };
  const src = `import { Routes } from '@angular/router';
import { PageSeo } from './shared/seo';

// GENERATED by scripts/generate-articles.mjs from the wargr article database. Do not edit by hand.
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./pages/blog.component').then((m) => m.BlogComponent),
    title: 'Home — Michael Wargr',
    data: { section: 'blog', seo: ${JSON.stringify(blogSeo)} satisfies PageSeo },
  },
  {
    path: 'videos',
    loadComponent: () => import('./pages/videos.component').then((m) => m.VideosComponent),
    title: 'Videos — Michael Wargr',
    data: { section: 'videos', seo: { path: '/videos/', description: 'Videos by Michael Wargr on philosophy, ethics, and human nature.' } satisfies PageSeo },
  },
  {
    path: 'blog',
    pathMatch: 'full',
    redirectTo: '',
  },
  {
    path: 'about',
    loadComponent: () => import('./pages/about.component').then((m) => m.AboutComponent),
    title: 'About — Michael Wargr',
    data: { section: 'about', seo: { path: '/about/', description: 'About Michael Wargr, who makes videos and writes stories on philosophy, ethics, and human nature.' } satisfies PageSeo },
  },
  {
    path: 'admin',
    loadComponent: () => import('./admin/admin.component').then((m) => m.AdminComponent),
    title: 'Admin — Wargr',
    data: { chrome: 'bare', seo: { path: '/admin', description: 'Wargr admin.', noindex: true } satisfies PageSeo },
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
      <description>${escapeXml(a.seoDescription)}</description>
      ${a.tags.map((t) => `<category>${escapeXml(t)}</category>`).join('')}
    </item>`,
    )
    .join('\n');
  const updated = articles[0]
    ? new Date(Math.max(...articles.map((a) => new Date(a.modifiedIso).getTime()))).toUTCString()
    : new Date(0).toUTCString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${SITE_NAME} — stories by ${AUTHOR}</title>
    <link>${SITE_ORIGIN}/</link>
    <atom:link href="${SITE_ORIGIN}/feed.xml" rel="self" type="application/rss+xml" />
    <description>${escapeXml(BLOG_DESCRIPTION)}</description>
    <language>en-us</language>
    <lastBuildDate>${updated}</lastBuildDate>
${items}
  </channel>
</rss>
`;
  mkdirSync(join(OUTPUT_ROOT, 'public'), { recursive: true });
  writeFileSync(join(OUTPUT_ROOT, 'public', 'feed.xml'), xml);
}

function writeSitemapAndRobots(articles) {
  // Section pages have no authoritative content-modification timestamp. Omit lastmod
  // rather than report build time or the date of an unrelated story.
  const pages = [
    { path: '/' },
    { path: '/videos/' },
    { path: '/about/' },
    ...articles.map((article) => ({
      path: `/${article.slug}/`,
      modified: article.modifiedIso,
      image: `${SITE_ORIGIN}${article.hero}`,
    })),
  ];
  const body = pages
    .map((page) => {
      const lastmod = page.modified ? `\n    <lastmod>${escapeXml(page.modified)}</lastmod>` : '';
      // Index the image readers see, using the supported image-sitemap fields.
      const imageXml = page.image
        ? `
    <image:image>
      <image:loc>${escapeXml(page.image)}</image:loc>
    </image:image>`
        : '';
      return `  <url>\n    <loc>${escapeXml(SITE_ORIGIN + page.path)}</loc>${lastmod}${imageXml}\n  </url>`;
    })
    .join('\n');
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${body}\n</urlset>\n`;
  mkdirSync(join(OUTPUT_ROOT, 'public'), { recursive: true });
  writeFileSync(join(OUTPUT_ROOT, 'public', 'sitemap.xml'), sitemap);
  writeFileSync(
    join(OUTPUT_ROOT, 'public', 'robots.txt'),
    `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
  );
}

// ---- run ----
// Re-prove the same complete slug/master inventory used by image preparation before rendering or
// writing. Routes, components, image names, feeds, and canonical URLs therefore share one exact
// non-empty and collision-free identity set.
const inventory = preflightPublishedArticleInventory({
  databasePath: DB_PATH,
  imagesRoot: join(REPO, 'article-images'),
});
const published = inventory
  .map(fromRecord)
  // Newest first by publish date; ties break by modified date, then slug, so the
  // feed/prev/next order is identical on every machine.
  .sort(
    (a, b) =>
      new Date(b.iso) - new Date(a.iso) ||
      new Date(b.modifiedIso) - new Date(a.modifiedIso) ||
      (a.slug < b.slug ? 1 : -1),
  );

buildRelated(published);

// Only replace generated output after every published story has parsed and passed image validation.
rmSync(ARTICLES_DIR, { recursive: true, force: true });

const classes = published.map(writeArticleComponent);
writeBlog(published);
writeRoutes(published, classes);
writeFeed(published);
writeSitemapAndRobots(published);

console.log(`[generate] published ${published.length} stories:`);
for (const a of published) {
  console.log(
    `  - /${a.slug}/  "${a.title}"  (${a.date}, ${a.readingTime} min, ${a.tags.length} tags, ${a.pullQuotes.length} quotes, ${a.related.length} related)`,
  );
}
