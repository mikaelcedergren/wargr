import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { POLISH_MODES, type ArticleDocument } from './article-schema.js';
import { articlePolishSpec } from './polish-content.js';
import { APPROVED_VOICE_REFERENCE, AUTHOR_PACING_REFERENCE } from './voice-reference.js';

test('the voice reference preserves the complete edition the author accepted', () => {
  // This digest is of the reading draft accepted on 27 October 2026, including its final LF.
  // A changed reference needs explicit acceptance, not an incidental prose cleanup.
  assert.equal(
    createHash('sha256').update(APPROVED_VOICE_REFERENCE).digest('hex'),
    '8080313344abcae9637a8c88a0de9eb0ddae145d7805f7d974c800691bf5bc8c',
  );
});

test('every editing scope receives the accepted references separately from the current story', () => {
  const document: ArticleDocument = {
    title: 'Synthetic current story',
    topic: 'A synthetic repair decision.',
    ingress: '',
    body: 'The supplied repair notes belong to this story alone.',
    tags: [],
    socialPosts: [],
    pullQuotes: [],
    imagePrompts: [],
  };
  const instruction = 'Keep the supplied phrase about the repair.';

  for (const mode of POLISH_MODES) {
    const spec = articlePolishSpec(mode, document, instruction);
    assert.equal(spec.instructions.split(APPROVED_VOICE_REFERENCE).length, 2, mode);
    assert.equal(spec.instructions.split(AUTHOR_PACING_REFERENCE).length, 2, mode);
    assert.match(
      spec.instructions,
      /not supplied facts for the current document/,
      'reference biography must not be presented as current-story material',
    );
    assert.equal(spec.input.includes(APPROVED_VOICE_REFERENCE), false, mode);
    assert.equal(spec.input.includes(AUTHOR_PACING_REFERENCE), false, mode);
    assert.ok(spec.input.includes(JSON.stringify(document, null, 2)), mode);
    assert.ok(spec.input.includes(instruction), mode);
  }
});
