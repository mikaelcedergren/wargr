#!/usr/bin/env node
// Builds the deployed hero and social-card JPEGs from the canonical per-essay PNG masters.
// Every published essay must have article-images/<slug>.png; a missing or undersized master is a
// publishing error, not an optional presentation state.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflightPublishedArticleInventory } from './article-slugs.mjs';

const TOOL_REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const REPO = resolve(process.env.WARGR_REPO_ROOT ?? TOOL_REPO);
const DB_PATH = resolve(process.env.WARGR_DB_PATH ?? join(REPO, 'data', 'wargr.db'));
const MASTER_DIR = join(REPO, 'article-images');
if (!process.env.WARGR_GENERATED_OUTPUT_ROOT) {
  throw new Error(
    'prepare-article-images.mjs is a staging-only generator; use the generated-content transaction.',
  );
}
const OUTPUT_ROOT = resolve(process.env.WARGR_GENERATED_OUTPUT_ROOT);
if (OUTPUT_ROOT === REPO) {
  throw new Error('Article-image staging output must not be the mutable Wargr checkout root.');
}
const OUTPUT_DIR = join(OUTPUT_ROOT, 'public', 'assets', 'articles');
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

// Slug identity and the complete essay/master inventory are proved before the first directory
// creation, stale-output deletion, or image render. Article and route generation consume this same
// authority, so two records can never silently address one deployed URL or image pair.
const inventory = preflightPublishedArticleInventory({
  databasePath: DB_PATH,
  imagesRoot: MASTER_DIR,
});
if (!existsSync(SIPS)) throw new Error(`Required macOS image tool not found: ${SIPS}`);

mkdirSync(OUTPUT_DIR, { recursive: true });

console.log(`[images] preparing ${inventory.length} published essay images`);
for (const { slug, masterPath: master } of inventory) {
  const hero = render(master, slug, HERO);
  const social = render(master, slug, SOCIAL);
  console.log(
    `  - ${hero.name} (${hero.width}x${hero.height}) + ${social.name} (${social.width}x${social.height})`,
  );
}
