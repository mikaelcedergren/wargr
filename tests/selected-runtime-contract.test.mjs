import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_LEGACY_ENTRYPOINT_SHA256 =
  'eeb09b5ae1663821a856357d0e8873d8f10240350f30ddd1ebb1dffe64d61ff0';

test('the currently selected legacy entrypoint remains exact until compiled-server cutover', async () => {
  const source = await readFile(path.join(REPO_ROOT, 'server', 'index.mjs'));
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    EXPECTED_LEGACY_ENTRYPOINT_SHA256,
  );
});
