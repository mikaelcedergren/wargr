#!/usr/bin/env node
// Builds the deployed hero and social-card JPEGs from the canonical per-essay PNG masters.
// Every published essay must have article-images/<slug>.png; a missing or undersized master is a
// publishing error, not an optional presentation state.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const GHOSTWRITER_DIR = resolve(REPO, '..', 'ghostwriter', 'wargr');
const MASTER_DIR = join(REPO, 'article-images');
const OUTPUT_DIR = join(REPO, 'public', 'assets', 'articles');
const SIPS = '/usr/bin/sips';

const HERO = { suffix: '', ratioWidth: 16, ratioHeight: 9, maxWidth: 1920, quality: 82 };
const SOCIAL = {
  suffix: '-og',
  ratioWidth: 40,
  ratioHeight: 21,
  width: 1200,
  height: 630,
  quality: 86,
};

function slugify(filename) {
  return filename
    .normalize('NFKD')
    .replace(/[☀-➿️]/g, '')
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function dimensions(path) {
  const output = execFileSync(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', path], {
    encoding: 'utf8',
  });
  const width = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1]);
  if (!width || !height) throw new Error(`Could not read image dimensions: ${path}`);
  return { width, height };
}

function largestExactCrop(width, height, ratioWidth, ratioHeight) {
  const scale = Math.min(Math.floor(width / ratioWidth), Math.floor(height / ratioHeight));
  return { width: scale * ratioWidth, height: scale * ratioHeight };
}

function render(master, slug, specification) {
  const source = dimensions(master);
  const crop = largestExactCrop(
    source.width,
    source.height,
    specification.ratioWidth,
    specification.ratioHeight,
  );
  const outputWidth = specification.width ?? Math.min(crop.width, specification.maxWidth);
  const outputHeight =
    specification.height ??
    Math.round((outputWidth * specification.ratioHeight) / specification.ratioWidth);

  if (crop.width < outputWidth || crop.height < outputHeight) {
    throw new Error(
      `${basename(master)} is ${source.width}x${source.height}; ${outputWidth}x${outputHeight} output would require upscaling.`,
    );
  }

  const finalName = `${slug}${specification.suffix}.jpg`;
  const finalPath = join(OUTPUT_DIR, finalName);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const cropPath = join(OUTPUT_DIR, `.${slug}-${nonce}-crop.png`);
  const temporaryPath = join(OUTPUT_DIR, `.${slug}-${nonce}.jpg`);

  try {
    execFileSync(
      SIPS,
      [master, '--cropToHeightWidth', String(crop.height), String(crop.width), '--out', cropPath],
      { stdio: 'ignore' },
    );
    execFileSync(
      SIPS,
      [
        cropPath,
        '--resampleHeightWidth',
        String(outputHeight),
        String(outputWidth),
        '--setProperty',
        'format',
        'jpeg',
        '--setProperty',
        'formatOptions',
        String(specification.quality),
        '--out',
        temporaryPath,
      ],
      { stdio: 'ignore' },
    );

    const rendered = dimensions(temporaryPath);
    if (rendered.width !== outputWidth || rendered.height !== outputHeight) {
      throw new Error(
        `${finalName} rendered at ${rendered.width}x${rendered.height}; expected ${outputWidth}x${outputHeight}.`,
      );
    }
    if (statSync(temporaryPath).size === 0) throw new Error(`${finalName} rendered empty.`);
    renameSync(temporaryPath, finalPath);
    return { name: finalName, width: outputWidth, height: outputHeight };
  } finally {
    rmSync(cropPath, { force: true });
    rmSync(temporaryPath, { force: true });
  }
}

if (!existsSync(GHOSTWRITER_DIR)) {
  throw new Error(`Ghostwriter source not found: ${GHOSTWRITER_DIR}`);
}
if (!existsSync(SIPS)) throw new Error(`Required macOS image tool not found: ${SIPS}`);

const slugs = readdirSync(GHOSTWRITER_DIR)
  .filter((name) => name.endsWith('.md') && name.trimStart().startsWith('☑'))
  .map(slugify)
  .sort();

const missing = slugs.filter((slug) => !existsSync(join(MASTER_DIR, `${slug}.png`)));
if (missing.length) {
  throw new Error(
    `Published essays are missing canonical image masters:\n${missing.map((slug) => `  - article-images/${slug}.png`).join('\n')}`,
  );
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const expected = new Set(slugs.flatMap((slug) => [`${slug}.jpg`, `${slug}-og.jpg`]));
for (const filename of readdirSync(OUTPUT_DIR)) {
  if (/\.jpe?g$/i.test(filename) && !expected.has(filename)) {
    rmSync(join(OUTPUT_DIR, filename));
  }
}

console.log(`[images] preparing ${slugs.length} published essay images`);
for (const slug of slugs) {
  const master = join(MASTER_DIR, `${slug}.png`);
  const hero = render(master, slug, HERO);
  const social = render(master, slug, SOCIAL);
  console.log(
    `  - ${hero.name} (${hero.width}x${hero.height}) + ${social.name} (${social.width}x${social.height})`,
  );
}
