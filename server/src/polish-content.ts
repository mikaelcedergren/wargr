import {
  ArticleValidationError,
  publishFormatProblems,
  validateArticleDocument,
  type ArticleDocument,
  type PolishMode,
} from './article-schema.js';
import { POLISH_MODE_INSTRUCTIONS, VOICE_CONTRACT } from './voice-contract.js';
import { VOICE_REFERENCE_INSTRUCTIONS } from './voice-reference.js';

export type JsonSchemaFormat = Readonly<{
  type: 'json_schema';
  name: string;
  strict: true;
  schema: Readonly<Record<string, unknown>>;
}>;

export interface StructuredGenerationSpec<Result> {
  readonly format: JsonSchemaFormat;
  readonly input: string;
  readonly instructions: string;
  readonly maxOutputTokens: number;
  readonly operation: string;
  readonly pollDeadlineMs: number;
  validate(value: unknown): ValidationResult<Result>;
}

export type ValidationResult<Result> =
  { readonly ok: true; readonly value: Result } | { readonly error: string; readonly ok: false };

// Long stories need generous budgets: the complete document returns in one response, and the
// provider runs it as a background response that can take several minutes at full reasoning depth.
const POLISH_MAX_OUTPUT_TOKENS = 32_000;
const POLISH_POLL_DEADLINE_MS = 10 * 60 * 1_000;

const textSchema = (maxLength: number) => ({
  type: 'string',
  minLength: 1,
  maxLength,
});

export const ARTICLE_DOCUMENT_FORMAT: JsonSchemaFormat = Object.freeze({
  type: 'json_schema',
  name: 'wargr_article_document',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      title: textSchema(300),
      topic: textSchema(500),
      ingress: textSchema(300),
      body: { type: 'string', minLength: 1 },
      tags: {
        type: 'array',
        minItems: 10,
        maxItems: 20,
        items: textSchema(64),
      },
      socialPosts: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: textSchema(280),
      },
      pullQuotes: {
        type: 'array',
        minItems: 2,
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            hook: textSchema(500),
            expansion: textSchema(4_000),
          },
          required: ['hook', 'expansion'],
          additionalProperties: false,
        },
      },
      imagePrompts: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: textSchema(1_000),
      },
    },
    required: [
      'title',
      'topic',
      'ingress',
      'body',
      'tags',
      'socialPosts',
      'pullQuotes',
      'imagePrompts',
    ],
    additionalProperties: false,
  },
});

const DOCUMENT_FIELD_CONTRACT = `## Output contract

Return the complete story document as JSON. Work on the body first, within this round's editing scope. Derive its supporting fields only after the prose is settled. Do not shape the body to produce promotional hooks. This is one generation request, not a claim that separate drafting and review calls have occurred. Preserve effective existing fields when the round does not require changing them.

- \`title\`: a specific, accurate, sentence-case title. Name the actual subject or tension; do not promise a revelation the piece does not deliver.
- \`topic\`: one sentence describing what the article is really about. Internal alignment metadata, never shown to readers, not promotional copy.
- \`ingress\`: one plain-text paragraph between 80 and 200 characters. Follow the voice contract's introduction guidance: its sole purpose is curiosity that draws the reader into the whole article. It may leave the thought unresolved or end with "..."; it does not need a summary or conclusion. The body must work without the ingress.
- \`body\`: the piece as markdown, at the length the available material warrants. No required chapter shape, personal opening, conversion or moral. Use LF line endings and blank lines between paragraphs. Do not paste the title, internal topic or ingress into the body as an extra preface.
- \`tags\`: ten to twenty lowercase tags, no # prefix, no repeats.
- \`socialPosts\`: three separate posts, each within 280 characters. Derive each from a specific part of the finished piece. Do not number them, repeat the title, invent a stronger claim, or manufacture a takeaway.
- \`pullQuotes\`: two or three blocks with a \`hook\` and \`expansion\`. Select accurate excerpts or faithful descriptions of existing points. Do not insert maxims into the body to supply these fields, add another ending, or claim an unverified rendering behavior. Never begin a hook with \`Create\`.
- \`imagePrompts\`: three image prompts, each beginning with \`Create a\`. Colour photography only, no text in the image. The Wargr visual tone is gritty, intimate, atmospheric and emotionally serious, often with shallow depth of field, physical texture and close focus on one detail. Prefer suggestion over literal illustration. Avoid the obvious symbol. The three prompts must use substantially different motifs.`;

export function articlePolishSpec(
  mode: PolishMode,
  document: ArticleDocument,
  instruction: string | null,
  correction?: string,
): StructuredGenerationSpec<ArticleDocument> {
  const instructions = [
    VOICE_CONTRACT,
    VOICE_REFERENCE_INSTRUCTIONS,
    POLISH_MODE_INSTRUCTIONS[mode],
    DOCUMENT_FIELD_CONTRACT,
    ...(correction === undefined
      ? []
      : [
          `## Correction\n\nYour previous output was rejected: ${correction}. Return the complete corrected document.`,
        ]),
  ].join('\n\n');
  const input = [
    'Here is the current story document. It may contain notes, author wording, or earlier generated prose. Its presence does not certify its style or verify its factual claims. Use only the supplied material and current instruction; no previous rounds or feedback history are included.',
    JSON.stringify(
      {
        title: document.title,
        topic: document.topic,
        ingress: document.ingress,
        body: document.body,
        tags: document.tags,
        socialPosts: document.socialPosts,
        pullQuotes: document.pullQuotes,
        imagePrompts: document.imagePrompts,
      },
      null,
      2,
    ),
    ...(instruction === null
      ? []
      : [`The author added this instruction for the current round:\n\n${instruction}`]),
    'Apply the requested editing scope. Return the complete document, including unchanged passages and fields where appropriate.',
  ].join('\n\n');

  return Object.freeze({
    format: ARTICLE_DOCUMENT_FORMAT,
    input,
    instructions,
    maxOutputTokens: POLISH_MAX_OUTPUT_TOKENS,
    operation: `article-polish:${mode}`,
    pollDeadlineMs: POLISH_POLL_DEADLINE_MS,
    validate(value: unknown): ValidationResult<ArticleDocument> {
      let parsed: ArticleDocument;
      try {
        parsed = validateArticleDocument(normalizeLineEndings(value));
      } catch (error) {
        if (error instanceof ArticleValidationError) {
          return Object.freeze({ error: error.message, ok: false });
        }
        throw error;
      }
      const problems = publishFormatProblems(parsed);
      if (problems.length > 0) {
        return Object.freeze({ error: problems.join(' '), ok: false });
      }
      return Object.freeze({ ok: true, value: parsed });
    },
  });
}

function normalizeLineEndings(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\r\n?/gu, '\n');
  if (Array.isArray(value)) return value.map(normalizeLineEndings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        normalizeLineEndings(entry),
      ]),
    );
  }
  return value;
}
