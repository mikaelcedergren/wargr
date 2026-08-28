import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  captureGhostwriterInputDigest,
  readRecordedInputDigest,
  writeRecordedInputDigest,
} from '../scripts/ghostwriter-input-state.mjs';

test('input digest binds published bytes and relevant Git history but ignores drafts', (t) => {
  const fixture = createFixture(t);
  const initial = capture(fixture);

  fs.writeFileSync(path.join(fixture.essaysRoot, 'draft.md'), 'changed draft\n');
  assert.equal(capture(fixture), initial);
  runGit(fixture.ghostwriterRoot, ['add', 'wargr/draft.md']);
  runGit(fixture.ghostwriterRoot, ['commit', '--quiet', '-m', 'draft only']);
  assert.equal(capture(fixture), initial);

  fs.chmodSync(path.join(fixture.essaysRoot, '☑ essay.md'), 0o755);
  runGit(fixture.ghostwriterRoot, ['add', 'wargr/☑ essay.md']);
  runGit(fixture.ghostwriterRoot, ['commit', '--quiet', '-m', 'published history only']);
  assert.notEqual(capture(fixture), initial);
});

test('input digest catches same-size same-mtime essay and image mutations', (t) => {
  const fixture = createFixture(t);
  const initial = capture(fixture);
  const essay = path.join(fixture.essaysRoot, '☑ essay.md');
  const essayTimes = fs.statSync(essay);
  fs.writeFileSync(essay, 'published B\n');
  fs.utimesSync(essay, essayTimes.atime, essayTimes.mtime);
  const essayChanged = capture(fixture);
  assert.notEqual(essayChanged, initial);

  const image = path.join(fixture.imagesRoot, 'essay.png');
  const imageTimes = fs.statSync(image);
  fs.writeFileSync(image, 'image bytes B\n');
  fs.utimesSync(image, imageTimes.atime, imageTimes.mtime);
  assert.notEqual(capture(fixture), essayChanged);
});

test('input digest binds published-file mtime used by the generation fallback', (t) => {
  const fixture = createFixture(t);
  const initial = capture(fixture);
  const essay = path.join(fixture.essaysRoot, '☑ essay.md');
  const before = fs.statSync(essay);
  fs.utimesSync(essay, before.atime, new Date(before.mtime.getTime() + 2_000));
  assert.notEqual(capture(fixture), initial);
});

test('input inventory enforces selected-file and total-entry ceilings before content reads', (t) => {
  const fixture = createFixture(t);
  const originalOpendir = fs.opendirSync;
  for (const scenario of [
    { count: 2_049, extension: '.png', message: /exceeds 2048 files/ },
    { count: 16_385, extension: '.txt', message: /exceeds 16384 entries/ },
  ]) {
    let closed = false;
    fs.opendirSync = function boundedSyntheticDirectory(candidate, options) {
      if (path.resolve(candidate) !== path.resolve(fixture.imagesRoot)) {
        return originalOpendir.call(this, candidate, options);
      }
      let index = 0;
      return {
        readSync() {
          if (index >= scenario.count) return null;
          const name = Buffer.from(`entry-${String(index).padStart(5, '0')}${scenario.extension}`);
          index += 1;
          return { name };
        },
        closeSync() {
          closed = true;
        },
      };
    };
    try {
      assert.throws(() => capture(fixture), scenario.message);
      assert.equal(closed, true);
    } finally {
      fs.opendirSync = originalOpendir;
    }
  }
});

test('input capture rejects mutation during a stable file read', (t) => {
  const fixture = createFixture(t);
  const essay = path.join(fixture.essaysRoot, '☑ essay.md');
  const originalRead = fs.readSync;
  let mutated = false;
  fs.readSync = function mutateDuringRead(descriptor, ...args) {
    const result = originalRead.call(this, descriptor, ...args);
    if (!mutated) {
      mutated = true;
      fs.writeFileSync(essay, 'published B\n');
    }
    return result;
  };
  try {
    assert.throws(
      () => capture(fixture),
      /changed before it was read|changed while it was read|changed before capture completed/,
    );
  } finally {
    fs.readSync = originalRead;
  }
  assert.equal(mutated, true);
});

test('input capture rejects symbolic and hard-linked publication inputs', (t) => {
  for (const linkKind of ['symbolic', 'hard']) {
    const fixture = createFixture(t);
    const image = path.join(fixture.imagesRoot, 'essay.png');
    const other = path.join(fixture.productRoot, 'other.png');
    fs.writeFileSync(other, 'other image\n');
    fs.unlinkSync(image);
    if (linkKind === 'symbolic') fs.symlinkSync(other, image);
    else fs.linkSync(other, image);
    assert.throws(() => capture(fixture), /regular, unaliased file/, linkKind);
  }
});

test('input digest state records atomically and refuses linked state', (t) => {
  const fixture = createFixture(t);
  const statePath = path.join(fixture.productRoot, '.run/ghostwriter-input.json');
  const digest = capture(fixture);
  assert.equal(readRecordedInputDigest({ repoRoot: fixture.productRoot, statePath }), null);
  writeRecordedInputDigest({ repoRoot: fixture.productRoot, statePath, digest });
  assert.equal(readRecordedInputDigest({ repoRoot: fixture.productRoot, statePath }), digest);

  fs.unlinkSync(statePath);
  fs.symlinkSync(path.join(fixture.productRoot, 'other-state.json'), statePath);
  assert.throws(
    () => writeRecordedInputDigest({ repoRoot: fixture.productRoot, statePath, digest }),
    /regular, unaliased file/,
  );
});

function capture(fixture) {
  return captureGhostwriterInputDigest({
    ghostwriterRoot: fixture.ghostwriterRoot,
    essaysRoot: fixture.essaysRoot,
    imagesRoot: fixture.imagesRoot,
  });
}

function createFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wargr-input-state-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ghostwriterRoot = path.join(root, 'ghostwriter');
  const essaysRoot = path.join(ghostwriterRoot, 'wargr');
  const productRoot = path.join(root, 'wargr');
  const imagesRoot = path.join(productRoot, 'article-images');
  fs.mkdirSync(essaysRoot, { recursive: true });
  fs.mkdirSync(imagesRoot, { recursive: true });
  fs.mkdirSync(path.join(productRoot, '.run'), { recursive: true });
  runGit(ghostwriterRoot, ['init', '--quiet']);
  runGit(ghostwriterRoot, ['config', 'user.email', 'tests@example.test']);
  runGit(ghostwriterRoot, ['config', 'user.name', 'Tests']);
  fs.writeFileSync(path.join(essaysRoot, '☑ essay.md'), 'published A\n');
  fs.writeFileSync(path.join(essaysRoot, 'draft.md'), 'draft content\n');
  fs.writeFileSync(path.join(imagesRoot, 'essay.png'), 'image bytes A\n');
  runGit(ghostwriterRoot, ['add', '.']);
  runGit(ghostwriterRoot, ['commit', '--quiet', '-m', 'fixture']);
  return { ghostwriterRoot, essaysRoot, productRoot, imagesRoot };
}

function runGit(cwd, args, extraEnvironment = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnvironment },
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
