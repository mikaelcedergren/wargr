import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = path.join(repoRoot, 'bin', 'install-server-daemon');
const label = 'com.wargr.server';
const template = path.join(repoRoot, 'launchd', `${label}.plist`);
const publisherLabel = 'com.wargr.sync';
const publisherTemplate = path.join(repoRoot, 'launchd', `${publisherLabel}.plist`);
const publisherInstaller = path.join(repoRoot, 'bin', 'install-publisher-daemon');

test('LaunchDaemon source selects the immutable local-only Wargr server', () => {
  const source = readFileSync(template, 'utf8');
  assert.match(
    source,
    /\/\.run\/site-releases\/server\/current-server\/artifact\/server\/dist\/index\.js</,
  );
  assert.match(source, /current-server\/server-release\.json</);
  assert.match(source, /<key>HOST<\/key>\s*<string>127\.0\.0\.1<\/string>/);
  assert.match(source, /<key>PORT<\/key>\s*<string>3060<\/string>/);
  assert.doesNotMatch(source, /<key>(?:API_KEY|PASSWORD|SECRET|TOKEN)[^<]*<\/key>/i);
});

test('daemon installer is a thin web-role delegate and never activates the service', () => {
  const source = readFileSync(installer, 'utf8');
  assert.match(source, /install-site-service-definitions\.mjs/);
  assert.match(source, /--site wargr/);
  assert.match(source, /--repo "\$repo" "\$@"/);
  assert.doesNotMatch(source, /com\.wargr\.sync/);
  assert.doesNotMatch(source, /\blaunchctl\b/);
  assert.doesNotMatch(source, /\bsudo\b/);
  assert.doesNotMatch(source, /\.env\.|server\/dist/);

  const direct = execFileSync(installer, [], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.match(direct, /VALID: wargr 1 registered LaunchDaemon definition\./);
  assert.match(direct, /No service definition was installed/);
  assert.equal(
    execFileSync(installer, ['--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }),
    direct,
  );
});

test('scheduled publisher definition selects an immutable digest-qualified tool closure', () => {
  const source = readFileSync(publisherTemplate, 'utf8');
  assert.match(
    source,
    /__WARGR_PUBLISHER_RELEASE__\/server-ops\/bin\/scheduled-publisher-launcher\.mjs/,
  );
  assert.match(source, /<string>--digest<\/string>\s*<string>__WARGR_PUBLISHER_DIGEST__<\/string>/);
  assert.match(source, /<key>CX_DEVELOPMENT_ROOT<\/key>/);
  assert.doesNotMatch(source, /Development\/wargr\/bin\/sync-from-ghostwriter/);
  assert.doesNotMatch(source, /Development\/server-ops\/bin\/site-release\.mjs/);

  const installerSource = readFileSync(publisherInstaller, 'utf8');
  assert.match(installerSource, /MODE="\$\{1:---check\}"/);
  assert.match(installerSource, /install-scheduled-publisher\.mjs/);
  assert.match(installerSource, /--publisher wargr/);
  assert.doesNotMatch(installerSource, /\b(?:bootout|bootstrap|kickstart|restart)\b/);
});
