import {
  ArticleValidationError,
  publishFormatProblems,
  validateArticleDocument,
  type ArticleDocument,
  type PolishMode,
} from './article-schema.js';
import { POLISH_MODE_INSTRUCTIONS, VOICE_CONTRACT } from './voice-contract.js';

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
  | { readonly ok: true; readonly value: Result }
  | { readonly error: string; readonly ok: false };

// Long essays need generous budgets: the complete document returns in one response, and the
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

Return the complete rewritten essay as one JSON document with these fields. Every field is part of the work; none is filler.

- \`title\`: a clear title that creates curiosity and remains findable through search.
- \`topic\`: one sentence describing what the article is really about. Internal alignment metadata, never shown to readers, not promotional copy.
- \`ingress\`: one paragraph between 80 and 200 characters. Plain text, no markdown. It creates tension and curiosity without revealing the conclusion. The body must work perfectly if the ingress is removed.
- \`body\`: the chapter itself, as markdown. There is no maximum length. It must be long enough to carry a genuine movement rather than announcing a conclusion and decorating it. Use LF line endings and blank lines between paragraphs. Do not repeat the title, topic or ingress inside the body.
- \`tags\`: ten to twenty lowercase tags, no # prefix, no repeats.
- \`socialPosts\`: three separate social posts, each within 280 characters. Do not number them or include the article title. Use three distinct angles. Keep them plain, direct and curious.
- \`pullQuotes\`: two or three blocks, each with a \`hook\` line and an \`expansion\` paragraph that develops it. The final pull quote is rendered as the article's coda figure. Never begin a hook with \`Create\`.
- \`imagePrompts\`: three image prompts, each beginning with \`Create a\`. Colour photography only, no text in the image. The Wargr visual tone is gritty, intimate, atmospheric and emotionally serious, often with shallow depth of field, physical texture and close focus on one detail. Prefer suggestion over literal illustration. Avoid the obvious symbol. The three prompts must use substantially different motifs.`;

export function articlePolishSpec(
  mode: PolishMode,
  document: ArticleDocument,
  instruction: string | null,
  correction?: string,
): StructuredGenerationSpec<ArticleDocument> {
  const instructions = [
    VOICE_CONTRACT,
    POLISH_MODE_INSTRUCTIONS[mode],
    DOCUMENT_FIELD_CONTRACT,
    ...(correction === undefined
      ? []
      : [
          `## Correction\n\nYour previous output was rejected: ${correction}. Return the complete corrected document.`,
        ]),
  ].join('\n\n');
  const input = [
    'Here is the current state of the essay, as a JSON document. Everything the author has written or kept is in it.',
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
    'Rewrite the essay now. The rewritten document is the response.',
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
