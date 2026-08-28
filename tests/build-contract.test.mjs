import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('clean development and production builds compile the tracked presentation snapshot', async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const scripts = packageJson.scripts;

  assert.equal(scripts.dev, 'ng serve --configuration local --host 127.0.0.1 --port 4260');
  assert.equal(scripts.build, 'pnpm run build:browser && pnpm run build:server');
  assert.equal(scripts['build:browser'], 'ng build --configuration prod');
  assert.equal(
    scripts['build:release'],
    'ng build --configuration prod --output-path "$SITE_RELEASE_DIR"',
  );
  assert.equal(scripts['build:local'], 'ng build --configuration local');
  assert.equal(scripts['sync:content'], 'bin/sync-content');
  assert.equal(scripts.images, 'pnpm run sync:content');
  assert.equal(scripts.e2e, 'node scripts/run-e2e.mjs');
  assert.match(scripts.check, /pnpm build$/);
  assert.doesNotMatch(
    [
      scripts.dev,
      scripts.build,
      scripts['build:browser'],
      scripts['build:release'],
      scripts['build:local'],
    ].join('\n'),
    /ghostwriter|import|images|prepare-article|sips|sync:content/,
  );

  const e2eServer = await readFile(path.join(repoRoot, 'scripts', 'e2e-server.mjs'), 'utf8');
  assert.match(e2eServer, /runPackageScript\(\s*'build:server'/);
  assert.match(e2eServer, /runPackageScript\(\s*'build:release'/);
  assert.match(
    e2eServer,
    /env:\s*createHermeticE2EChildEnvironment\(\s*createE2EServerEnvironment\(/,
  );
  assert.match(e2eServer, /\{ targetServer: true \}/);
  assert.doesNotMatch(e2eServer, /\.\.\.process\.env/);
  assert.doesNotMatch(e2eServer, /ghostwriter|import-articles|prepare-article|sync:content|sips/);
});
