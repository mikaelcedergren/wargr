import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const syncWrapperSource = fs.readFileSync(
  new URL('../bin/sync-from-ghostwriter', import.meta.url),
  'utf8',
);
const syncSource = fs.readFileSync(
  new URL('../bin/sync-from-ghostwriter-transaction', import.meta.url),
  'utf8',
);
const allowlist = JSON.parse(
  fs.readFileSync(new URL('../scripts/ghostwriter-generated-source.json', import.meta.url), 'utf8'),
);
const imageSource = fs.readFileSync(
  new URL('../scripts/prepare-article-images.mjs', import.meta.url),
  'utf8',
);
const importSource = fs.readFileSync(
  new URL('../scripts/import-articles.mjs', import.meta.url),
  'utf8',
);
const manualSyncSource = fs.readFileSync(new URL('../bin/sync-content', import.meta.url), 'utf8');

test('automatic Ghostwriter publication proves a clean and bounded source transition', () => {
  const recovery = syncSource.indexOf('"$NODE" "$CONTENT_TRANSACTION" recover');
  const firstInput = syncSource.indexOf('input_before="$("$NODE" "$INPUT_STATE" capture)"');
  const unchangedExit = syncSource.indexOf('matches "$input_before"');
  const baseline = syncSource.indexOf('--baseline "$ALLOWLIST"');
  const generation = syncSource.indexOf(
    '"$NODE" "$CONTENT_TRANSACTION" generate --defer-attestation',
  );
  const secondInput = syncSource.indexOf(
    'input_after="$("$NODE" "$INPUT_STATE" capture)"',
    generation,
  );
  const inputProof = syncSource.indexOf('"$input_after" != "$input_before"', secondInput);
  const allowedGate = syncSource.indexOf('--capture "$ALLOWLIST"');
  const revisionProof = syncSource.indexOf('--expected-revision "$pre_revision"');
  const transactionCommit = syncSource.indexOf(
    '"$NODE" "$CONTENT_TRANSACTION" commit',
    allowedGate,
  );
  const release = syncSource.indexOf('"$NODE" "$SITE_RELEASE"', allowedGate);
  const expectedFingerprint = syncSource.indexOf('--expected-source-fingerprint');
  const inputStamp = syncSource.indexOf('record "$input_after"');

  assert.match(
    syncWrapperSource,
    /exec \/usr\/bin\/lockf -t 0 -k "\$LOCK" \/bin\/zsh "\$LOCKED_TRANSACTION"/,
  );
  assert.match(syncWrapperSource, /sync-from-ghostwriter-transaction/);
  assert.doesNotMatch(syncWrapperSource, /exec 9>|lockf -s -t 0 9/);
  assert.doesNotMatch(syncWrapperSource, /(?:\brm\b|\bunlink\b)[^\n]*\$LOCK/);
  assert.doesNotMatch(syncSource, /\/usr\/bin\/lockf/);
  assert.ok(recovery >= 0);
  assert.ok(recovery < firstInput);
  assert.ok(firstInput < unchangedExit);
  assert.ok(unchangedExit < baseline);
  assert.ok(baseline < generation);
  assert.match(syncSource, /--attestation "\$SOURCE_ATTESTATION"/);
  assert.match(syncSource, /--clean-head-policy wargr-browser-presentation/);
  assert.ok(generation < secondInput);
  assert.ok(secondInput < inputProof);
  assert.ok(inputProof < allowedGate);
  assert.ok(generation < allowedGate);
  assert.ok(allowedGate < revisionProof);
  assert.ok(allowedGate < transactionCommit);
  assert.ok(transactionCommit < release);
  assert.ok(release < expectedFingerprint);
  assert.ok(expectedFingerprint < inputStamp);
  assert.match(syncSource, /trap cleanup_transaction EXIT/);
  assert.match(syncSource, /WARGR_PUBLISHER_TOOL_ROOT/);
  assert.match(syncSource, /WARGR_SERVER_OPS_TOOL_ROOT/);
  assert.match(syncSource, /generated-content recovery failed/);
  assert.doesNotMatch(syncSource, /--record-attestation "\$SOURCE_ATTESTATION"/);
  assert.doesNotMatch(syncSource, /\$REPO\/\.\.\/server-ops\/bin\/site-release\.mjs/);
  assert.match(syncSource, /--site wargr[\s\\]+--browser-only/);
  assert.doesNotMatch(syncSource, /\bfind\b|\bstat\b|shasum/);
  assert.equal([...syncSource.matchAll(/"\$NODE" "\$CONTENT_TRANSACTION" generate/g)].length, 1);
  assert.equal([...syncSource.matchAll(/"\$NODE" "\$SITE_RELEASE"/g)].length, 1);
});

test('automatic Ghostwriter publication can change only its tracked browser snapshot', () => {
  assert.deepEqual(Object.keys(allowlist).sort(), ['exactPaths', 'pathPatterns', 'schemaVersion']);
  assert.equal(allowlist.schemaVersion, 1);
  assert.deepEqual(allowlist.exactPaths, [
    'public/feed.xml',
    'public/robots.txt',
    'public/sitemap.xml',
    'src/app/app.routes.ts',
    'src/app/pages/home.component.ts',
    'src/app/pages/not-found.component.ts',
  ]);
  assert.deepEqual(allowlist.pathPatterns, [
    '^public/assets/articles/[a-z0-9]+(?:-[a-z0-9]+)*(?:-og)?\\.jpg$',
    '^src/app/articles/[a-z0-9]+(?:-[a-z0-9]+)*\\.component\\.ts$',
  ]);
  const serialized = JSON.stringify(allowlist);
  for (const forbidden of [
    'package.json',
    'pnpm-lock.yaml',
    'server/',
    'src/app/shared/',
    'src/styles.scss',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replaceAll('.', '\\.')));
  }
});

test('images, imports, and routes share one exact slug authority', () => {
  for (const source of [imageSource, importSource]) {
    assert.match(source, /from '\.\/article-slugs\.mjs'/);
    assert.match(source, /preflightPublishedEssayInventory/);
    assert.doesNotMatch(source, /function slugify\(/);
    assert.match(source, /staging-only generator/);
  }
});

test('manual content synchronization shares the crash-releasing scheduled lock', () => {
  assert.match(manualSyncSource, /exec 9>"\$LOCK"/);
  assert.match(manualSyncSource, /\/usr\/bin\/lockf -s -t 0 9/);
  assert.doesNotMatch(manualSyncSource, /(?:\brm\b|\bunlink\b)[^\n]*\$LOCK/);
  assert.match(manualSyncSource, /generated-content-transaction\.mjs" generate/);
  assert.doesNotMatch(manualSyncSource, /import-articles|prepare-article-images/);
});
