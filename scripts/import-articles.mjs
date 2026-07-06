#!/usr/bin/env node
// Pulls essays from ../ghostwriter/wargr and generates the Angular pages + routes for wargr.com.
//
// Publishing rule: ONLY files whose name starts with "☑" are published. Everything else is a draft
// and is skipped. (The ghostwriter author marks a piece ready by prefixing the filename with ☑.)
//
// Each ghostwriter file has the shape:
//   # <title>
//   ## Topic: <internal note — NOT shown to readers>
//   ## Published: <YYYY-MM-DD or full ISO — the publish date of record; see articleDates()>
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
import sanitizeHtml from 'sanitize-html';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const GHOST = resolve(REPO, '..', 'ghostwriter');
const SRC = join(GHOST, 'wargr');
const APP = join(REPO, 'src', 'app');
const ARTICLES_DIR = join(APP, 'articles');
const PAGES_DIR = join(APP, 'pages');
const SITE_ORIGIN = 'https://wargr.com';
const SITE_NAME = 'Wargr';
const AUTHOR = 'Michael Wargr';
const AUTHOR_DESCRIPTION =
  'Michael Wargr writes reflective essays on philosophy, ethics, fear, self-deception, conformity, purpose, pain, and human nature.';
const HOME_DESCRIPTION =
  'Essays by Michael Wargr on philosophy, ethics, fear, self-deception, conformity, purpose, pain, and human nature.';
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
      'A sharp essay on self-love, negative self-talk, loneliness, and learning to speak to yourself with the kindness you give other people.',
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
      'A face reflected in dark glass, matching an essay on self-love and negative self-talk.',
  },
  'whom-to-listen-to': {
    title: 'Who to listen to when everyone agrees — Michael Wargr',
    description:
      'An essay on consensus, dissent, expertise, and why the lone voice is sometimes worth hearing before everyone else catches up.',
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
    imageAlt: 'A microphone on an empty lecture table, matching an essay on consensus and dissent.',
  },
  'stop-the-pain': {
    title: 'How to stop emotional pain — Michael Wargr',
    description:
      'An essay on emotional pain, avoidance, numbing, and why healing begins when you stop running from what needs to be heard.',
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
    imageAlt: 'A dark, quiet scene matching an essay on emotional pain, avoidance, and healing.',
  },
  'stop-chasing-purpose': {
    title: 'Stop chasing purpose — Michael Wargr',
    description:
      'An essay on purpose anxiety, meaning, and the quiet freedom of putting down the search for a life-defining mission.',
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
      'A quiet path through open landscape, matching an essay on purpose, meaning, and letting go.',
  },
  slaughterhouse: {
    title: 'Herd mentality and the slaughterhouse — Michael Wargr',
    description:
      'An essay on herd mentality, conformity, propaganda, and the invisible ways people choose the stories that lead them.',
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
      'Meat on a table in a slaughterhouse, matching an essay on conformity and herd mentality.',
  },
  'meant-well': {
    title: "I'm sorry. I meant well. — Michael Wargr",
    description:
      'An essay on good intentions, harm, accountability, and why meaning well does not undo the damage people cause.',
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
    imageAlt: 'A tense human scene matching an essay on good intentions, harm, and accountability.',
  },
  corruption: {
    title: 'How fear turns good people into corruption — Michael Wargr',
    description:
      'An essay on corruption, moral compromise, fear, integrity, and how good people become what they once opposed.',
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
      'A solitary figure in a dark room, matching an essay on fear, integrity, and corruption.',
  },
};

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

// The rendered body is injected via [innerHTML] (bypassSecurityTrustHtml in the generated
// components), so the HTML is sanitized ONCE here at import time — never in the Angular runtime.
// The allowlist is exactly what the wg-prose reading layer styles plus the rest of marked's plain
// essay output; scripts, iframes, event handlers and javascript: URLs are stripped. The text filter
// re-applies marked's quote escaping so legitimate essays pass through byte-identical.
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
function gitDates(filename) {
  try {
    const dates = execFileSync(
      'git',
      ['-C', GHOST, 'log', '--follow', '--format=%cI', '--', `wargr/${filename}`],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    if (dates.length) {
      return {
        published: dates[dates.length - 1],
        modified: dates[0],
      };
    }
  } catch {
    /* not a git repo / not committed */
  }
  return null;
}
// The essay's own `## Published:` line is the publish date of record: it travels with the piece, so
// every machine builds the same dates regardless of how deep its ghostwriter clone's history goes.
// Git history supplies dateModified (and the published fallback for essays without the line); file
// mtime is the last resort. A date-only value normalises to noon UTC so it renders as the same
// calendar day in every timezone.
function articleDates(filename, publishedLine) {
  const git = gitDates(filename);
  let published = publishedLine || git?.published;
  if (!published) published = statSync(join(SRC, filename)).mtime.toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(published)) published = `${published}T12:00:00Z`;
  let modified = git?.modified ?? published;
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
    `${title.replace(/[“”"]/g, '').trim()} essay`,
    topic && `${topic} essay`,
    ...tags,
    'Michael Wargr',
    'Wargr essays',
    'philosophy essays',
    'essays on human nature',
  ]);

  return {
    title: configured.title ?? `${title} — ${AUTHOR}`,
    description: configured.description ?? (dek || `${title}, an essay by ${AUTHOR}.`),
    phrases,
    imageAlt: configured.imageAlt ?? `${title}, an essay by ${AUTHOR}.`,
  };
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
  const publishedMatch = raw.match(/^##\s+Published:\s*(.+?)\s*$/m);
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

  const dates = articleDates(filename, publishedMatch ? publishedMatch[1].trim() : null);
  const bodyHtml = sanitizeHtml(marked.parse(bodyMd), SANITIZE_OPTIONS);
  const wordCount = countWords(bodyMd);
  const readingTime = Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
  const pullQuotes = parsePullQuotes(trailing);
  const seo = seoForArticle({ slug, title, dek, tags });
  const hero = findArticleImage(slug);
  const ogCard = findArticleImage(slug, '-og');

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
    hero, // full-bleed header photo, or null for the plain header
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
        .sort(
          (x, y) => new Date(y.b.iso) - new Date(x.b.iso) || (x.b.slug < y.b.slug ? -1 : 1),
        )
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
  const metaRest = ` · ${a.readingTime} min read · ${a.wordCount} words`;
  const src = `import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DomSanitizer } from '@angular/platform-browser';

// Generated by scripts/import-articles.mjs from ../ghostwriter/wargr. Do not edit by hand.
const HTML = ${JSON.stringify(a.bodyHtml)};

type WgLink = { slug: string; title: string };
type WgRelated = { slug: string; title: string; dek: string; meta: string };

@Component({
  selector: 'wg-a-${a.slug}',
  imports: [RouterLink],
  template: \`
    @if (hero) {
      <header class="wg-hero">
        <img class="wg-hero__img" [src]="hero" [alt]="imageAlt" fetchpriority="high" />
        <div class="wg-hero__scrim" aria-hidden="true"></div>
        <div class="wg-hero__inner wg-container">
          <a class="wg-back wg-back--hero" routerLink="/">← Essays</a>
          <div class="wg-hero__head">
            <h1 class="wg-article__title">{{ title }}</h1>
            @if (dek) { <p class="wg-article__dek">{{ dek }}</p> }
            <p class="wg-article__meta wg-meta"><time [attr.datetime]="datetime">{{ date }}</time>{{ metaRest }}</p>
          </div>
        </div>
      </header>
    }
    <article class="wg-container wg-article" [class.wg-article--hero]="!!hero">
      @if (!hero) {
        <a class="wg-back" routerLink="/">← Essays</a>
        <h1 class="wg-article__title">{{ title }}</h1>
        @if (dek) { <p class="wg-article__dek">{{ dek }}</p> }
        <p class="wg-article__meta wg-meta"><time [attr.datetime]="datetime">{{ date }}</time>{{ metaRest }}</p>
      }
      <div class="wg-prose" [innerHTML]="body"></div>
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
  protected readonly date = ${JSON.stringify(a.date)};
  protected readonly datetime = ${JSON.stringify(a.iso.slice(0, 10))};
  protected readonly metaRest = ${JSON.stringify(metaRest)};
  protected readonly kicker = ${JSON.stringify(a.dominantTag)};
  protected readonly imageAlt = ${JSON.stringify(a.imageAlt)};
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
    image: a.hero,
    imageAlt: a.imageAlt,
    monthYear: a.monthYear,
    monthDatetime: a.iso.slice(0, 7),
    metaRest: ` · ${a.readingTime} min read`,
  }));
  const src = `import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

// Generated by scripts/import-articles.mjs. Do not edit by hand.
@Component({
  selector: 'wg-home',
  imports: [RouterLink],
  template: \`
    <section class="wg-container wg-feed">
      @for (a of articles; track a.slug; let first = $first) {
        <a class="wg-entry" [class.wg-entry--lead]="first" [routerLink]="['/', a.slug]" [attr.aria-label]="'Read ' + a.title">
          @if (a.image) {
            <span class="wg-entry__media">
              <img
                [src]="a.image"
                [alt]="a.imageAlt"
                [attr.loading]="first ? 'eager' : 'lazy'"
                [attr.fetchpriority]="first ? 'high' : null"
              />
            </span>
          }
          <div class="wg-entry__body">
            <h2 class="wg-entry__title"><span class="wg-entry__title-text">{{ a.title }}</span></h2>
            @if (a.dek) { <p class="wg-entry__dek">{{ a.dek }}</p> }
            <p class="wg-meta wg-entry__meta"><time [attr.datetime]="a.monthDatetime">{{ a.monthYear }}</time>{{ a.metaRest }}</p>
          </div>
        </a>
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
      ...(a.ogImage ? { ogImage: a.ogImage } : {}),
    };
    return `  {
    path: '${a.slug}',
    loadComponent: () => import('./articles/${a.slug}.component').then((m) => m.${classes[idx]}),
    title: ${JSON.stringify(a.seoTitle)},
    data: { seo: ${JSON.stringify(seo)} satisfies PageSeo },
  },`;
  });
  const homeSeo = {
    path: '/',
    description: HOME_DESCRIPTION,
    headline: 'Essays by Michael Wargr',
    about: AUTHOR_KNOWS_ABOUT,
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
    <title>${SITE_NAME} — essays by ${AUTHOR}</title>
    <link>${SITE_ORIGIN}/</link>
    <atom:link href="${SITE_ORIGIN}/feed.xml" rel="self" type="application/rss+xml" />
    <description>${escapeXml(HOME_DESCRIPTION)}</description>
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
  const lastmod = articles.map((a) => a.modifiedIso.slice(0, 10));
  // The home page changes whenever any essay does, so its lastmod is the newest of them all.
  const homeLastmod = articles.length
    ? new Date(Math.max(...articles.map((a) => new Date(a.modifiedIso).getTime())))
        .toISOString()
        .slice(0, 10)
    : null;
  const body = urls
    .map((u, i) => {
      if (i === 0)
        return `  <url><loc>${u}</loc>${homeLastmod ? `<lastmod>${homeLastmod}</lastmod>` : ''}</url>`;
      const a = articles[i - 1];
      const images = [
        a.hero && {
          loc: `${SITE_ORIGIN}${a.hero}`,
          title: a.title,
          caption: a.imageAlt,
        },
        a.ogImage && {
          loc: a.ogImage,
          title: `${a.title} social card`,
          caption: a.seoDescription,
        },
      ].filter(Boolean);
      const imageXml = images
        .map(
          (img) => `
    <image:image>
      <image:loc>${escapeXml(img.loc)}</image:loc>
      <image:title>${escapeXml(img.title)}</image:title>
      <image:caption>${escapeXml(img.caption)}</image:caption>
    </image:image>`,
        )
        .join('');
      return `  <url><loc>${u}</loc><lastmod>${lastmod[i - 1]}</lastmod>${imageXml}</url>`;
    })
    .join('\n');
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${body}\n</urlset>\n`;
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
  // Newest first by publish date; ties break by modified date, then slug, so the
  // feed/prev/next order is identical on every machine.
  .sort(
    (a, b) =>
      new Date(b.iso) - new Date(a.iso) ||
      new Date(b.modifiedIso) - new Date(a.modifiedIso) ||
      (a.slug < b.slug ? 1 : -1),
  );

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
