#!/usr/bin/env node
// One-time content migration: move the ghostwriter essays into Wargr's own article database, the
// authoring source that replaced the retired ghostwriter repository. Reads ../ghostwriter/wargr
// (☑-marked files import as published, other root files as format-complete drafts, drafts/ as raw
// drafts) and seeds them through the compiled article repository so every stored record passes the
// exact same validation, hashing, and capacity discipline as a record written through Studio.
//
// Build the server first: pnpm --dir server build
// Seed the development database:  node scripts/import-ghostwriter-articles.mjs
// Seed the production database:   node scripts/import-ghostwriter-articles.mjs --production
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ghostwriterRoot = process.env.WARGR_GHOSTWRITER_ROOT
  ? path.resolve(process.env.WARGR_GHOSTWRITER_ROOT)
  : path.resolve(repoRoot, '..', 'ghostwriter', 'wargr');
const production = process.argv.includes('--production');
const dataDirectory = path.join(repoRoot, ...(production ? ['data'] : ['.run', 'dev', 'data']));
const databasePath = path.join(dataDirectory, 'wargr.db');

const repositoryModule = path.join(repoRoot, 'server', 'dist', 'article-repository.js');
if (!existsSync(repositoryModule)) {
  console.error('Build the server first: pnpm --dir server build');
  process.exit(64);
}
if (!existsSync(ghostwriterRoot)) {
  console.error(`Ghostwriter source not found: ${ghostwriterRoot}`);
  process.exit(66);
}

const { createWargrPersistence } = await import(repositoryModule);

for (const directory of production
  ? [dataDirectory]
  : [path.join(repoRoot, '.run'), path.join(repoRoot, '.run', 'dev'), dataDirectory]) {
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
}

const persistence = createWargrPersistence({
  databasePath,
  operationalRoot: repoRoot,
});

const report = { published: 0, drafts: 0, raw: 0, skipped: 0, fallback: 0 };
try {
  const rootEntries = readdirSync(ghostwriterRoot)
    .filter((name) => name.endsWith('.md'))
    .sort();
  const draftDirectory = path.join(ghostwriterRoot, 'drafts');
  const draftEntries = existsSync(draftDirectory)
    ? readdirSync(draftDirectory)
        .filter((name) => name.endsWith('.md'))
        .sort()
    : [];

  for (const filename of rootEntries) {
    importEssay(path.join(ghostwriterRoot, filename), filename, filename.startsWith('☑'));
  }
  for (const filename of draftEntries) {
    importRawDraft(path.join(draftDirectory, filename), filename);
  }
} finally {
  persistence.close();
}

console.log(
  `Imported into ${path.relative(repoRoot, databasePath)}: ` +
    `${String(report.published)} published, ${String(report.drafts)} format drafts, ` +
    `${String(report.raw)} raw drafts, ${String(report.fallback)} body-only fallbacks, ` +
    `${String(report.skipped)} already present.`,
);

function importEssay(file, filename, published) {
  const slug = slugOf(filename);
  if (persistence.articles.getBySlug(slug)) {
    report.skipped += 1;
    return;
  }
  const raw = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const stat = statSync(file);
  const parsed = parseEssay(raw, slug);
  const publishedAt = published ? (parsed.publishedAt ?? dateOnly(stat.mtimeMs)) : null;
  const record = {
    ...parsed.document,
    createdAt: new Date(Math.min(stat.birthtimeMs || stat.mtimeMs, stat.mtimeMs)).toISOString(),
    id: randomUUID(),
    publishedAt,
    revision: 1,
    slug,
    state: published ? 'published' : 'draft',
    updatedAt: new Date(stat.mtimeMs).toISOString(),
  };
  try {
    persistence.articles.create(record, 'import');
    if (published) report.published += 1;
    else report.drafts += 1;
  } catch (error) {
    if (published) {
      // A published essay must arrive intact; a format surprise here needs a human decision.
      throw new Error(`Published essay ${filename} did not import cleanly: ${message(error)}`);
    }
    importBodyOnly(record, raw, filename, error);
  }
}

function importRawDraft(file, filename) {
  const slug = slugOf(filename);
  if (persistence.articles.getBySlug(slug)) {
    report.skipped += 1;
    return;
  }
  const raw = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const stat = statSync(file);
  const titleMatch = raw.match(/^#\s+(.+?)\s*$/m);
  const body = titleMatch ? raw.replace(titleMatch[0], '').trim() : raw.trim();
  const record = {
    body,
    createdAt: new Date(Math.min(stat.birthtimeMs || stat.mtimeMs, stat.mtimeMs)).toISOString(),
    id: randomUUID(),
    imagePrompts: [],
    ingress: '',
    publishedAt: null,
    pullQuotes: [],
    revision: 1,
    slug,
    socialPosts: [],
    state: 'draft',
    tags: [],
    title: titleMatch ? titleMatch[1].trim() : slug,
    topic: '',
    updatedAt: new Date(stat.mtimeMs).toISOString(),
  };
  persistence.articles.create(record, 'import');
  report.raw += 1;
}

function importBodyOnly(record, raw, filename, cause) {
  const fallback = {
    ...record,
    body: raw.trim(),
    imagePrompts: [],
    ingress: '',
    pullQuotes: [],
    socialPosts: [],
    tags: [],
    topic: '',
  };
  persistence.articles.create(fallback, 'import');
  report.fallback += 1;
  console.warn(
    `${filename}: structured import failed (${message(cause)}); imported as a body-only draft.`,
  );
}

/** The retired ghostwriter markdown format, parsed into the structured article document. */
function parseEssay(raw, slug) {
  const titleMatch = raw.match(/^#\s+(.+?)\s*$/m);
  const topicMatch = raw.match(/^##\s+Topic:\s*(.+?)\s*$/m);
  const publishedMatch = raw.match(/^##\s+Published:\s*(.+?)\s*$/m);
  const title = titleMatch ? titleMatch[1].trim() : slug;

  const parts = raw.split(/^\s*---\s*$/m);
  let bodyMd = (parts.length >= 3 ? parts[1] : parts.slice(1).join('\n---\n')).trim();
  const trailing = parts.length >= 3 ? parts.slice(2).join('\n').trim() : '';

  let ingress = '';
  const lines = bodyMd.split('\n');
  let index = 0;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  const bold = lines[index] ? lines[index].match(/^\*\*(.+?)\*\*\s*$/) : null;
  if (bold) {
    ingress = bold[1].trim();
    lines.splice(0, index + 1);
    bodyMd = lines.join('\n').trim();
  }

  const { imagePrompts, pullQuotes, socialPosts, tags } = parseTrailing(trailing);
  return {
    document: {
      body: bodyMd,
      imagePrompts,
      ingress,
      pullQuotes,
      socialPosts,
      tags,
      title,
      topic: topicMatch ? topicMatch[1].trim() : '',
    },
    publishedAt: publishedMatch ? publishedMatch[1].trim() : null,
  };
}

function parseTrailing(trailing) {
  if (!trailing) return { imagePrompts: [], pullQuotes: [], socialPosts: [], tags: [] };
  const lines = trailing.split('\n');
  let tags = [];
  let start = 0;
  for (; start < lines.length; start += 1) {
    const line = lines[start].trim();
    if (!line) continue;
    if (line.includes(',')) {
      tags = line
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean);
      start += 1;
    }
    break;
  }

  const socialPosts = [];
  const numbered = [];
  let current = null;
  let paragraph = [];
  const flushParagraph = () => {
    const text = paragraph.join('\n').trim();
    paragraph = [];
    if (!text) return;
    if (current) current.rest.push(text);
    else socialPosts.push(text);
  };
  for (const line of lines.slice(start)) {
    const item = line.match(/^\s*\d+\.\s+(.*)$/);
    if (item) {
      flushParagraph();
      if (current) numbered.push(current);
      current = { hook: item[1].trim(), rest: [] };
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  if (current) numbered.push(current);

  const pullQuotes = numbered
    .filter((item) => item.hook && !/^create\b/i.test(item.hook))
    .map((item) => ({ expansion: item.rest.join('\n\n').trim(), hook: item.hook }));
  const imagePrompts = numbered
    .filter((item) => /^create\b/i.test(item.hook))
    .map((item) => [item.hook, ...item.rest].join(' ').trim());

  return { imagePrompts, pullQuotes, socialPosts, tags };
}

function slugOf(filename) {
  return filename.replace(/^☑\s*/, '').replace(/\.md$/, '').trim();
}

function dateOnly(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
