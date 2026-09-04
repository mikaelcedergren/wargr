import { createHash } from 'node:crypto';

/**
 * The structured essay record. Studio replaced the retired ghostwriter markdown files as the
 * authoring source: one record carries the same content the markdown format carried — title,
 * internal topic line, ingress, body markdown, tags, social posts, pull quotes, and thumbnail
 * prompts. Draft validation enforces only bounded shapes so raw notes stay welcome; the publish
 * contract enforces the complete editorial format the site generator consumes.
 */

export const ARTICLE_MAX_RECORDS = 1_000;
export const ARTICLE_MAX_VERSIONS = 20_000;
export const ARTICLE_MAX_VERSIONS_PER_ARTICLE = 200;
export const ARTICLE_MAX_RECORD_BYTES = 1024 * 1024;

export const ARTICLE_STATES = Object.freeze(['draft', 'published'] as const);
export type ArticleState = (typeof ARTICLE_STATES)[number];

export const POLISH_MODES = Object.freeze(['rough', 'reference', 'developed', 'polish'] as const);
export type PolishMode = (typeof POLISH_MODES)[number];

export const ARTICLE_VERSION_SOURCES = Object.freeze(['author', 'polish', 'import'] as const);
export type ArticleVersionSource = (typeof ARTICLE_VERSION_SOURCES)[number];

export const RESERVED_ARTICLE_SLUGS = Object.freeze(
  new Set(['api', 'assets', 'healthz', 'studio']),
);

export const MAX_TITLE_CHARACTERS = 300;
export const MAX_TOPIC_CHARACTERS = 500;
export const MAX_INGRESS_CHARACTERS = 2_000;
export const MAX_BODY_CHARACTERS = 400_000;
export const MAX_SLUG_CHARACTERS = 80;
export const MAX_TAGS = 30;
export const MAX_TAG_CHARACTERS = 64;
export const MAX_SOCIAL_POSTS = 10;
export const MAX_SOCIAL_POST_CHARACTERS = 2_000;
export const MAX_PULL_QUOTES = 10;
export const MAX_PULL_QUOTE_HOOK_CHARACTERS = 500;
export const MAX_PULL_QUOTE_EXPANSION_CHARACTERS = 4_000;
export const MAX_IMAGE_PROMPTS = 10;
export const MAX_IMAGE_PROMPT_CHARACTERS = 1_000;
export const MAX_POLISH_INSTRUCTION_CHARACTERS = 2_000;

const PUBLISH_MIN_INGRESS_CHARACTERS = 80;
const PUBLISH_MAX_INGRESS_CHARACTERS = 200;
const PUBLISH_MIN_TAGS = 10;
const PUBLISH_MAX_TAGS = 20;
const PUBLISH_SOCIAL_POSTS = 3;
const PUBLISH_MAX_SOCIAL_POST_CHARACTERS = 280;
const PUBLISH_MIN_PULL_QUOTES = 2;
const PUBLISH_MAX_PULL_QUOTES = 3;
const PUBLISH_IMAGE_PROMPTS = 3;

const ARTICLE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PUBLISHED_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/u;

export interface PullQuote {
  readonly expansion: string;
  readonly hook: string;
}

/** The editable content of one essay — the fields the author and the polish worker rewrite. */
export interface ArticleDocument {
  readonly body: string;
  readonly imagePrompts: readonly string[];
  readonly ingress: string;
  readonly pullQuotes: readonly PullQuote[];
  readonly socialPosts: readonly string[];
  readonly tags: readonly string[];
  readonly title: string;
  readonly topic: string;
}

export const ARTICLE_DOCUMENT_FIELDS = Object.freeze([
  'body',
  'imagePrompts',
  'ingress',
  'pullQuotes',
  'socialPosts',
  'tags',
  'title',
  'topic',
] as const);

export interface ArticleRecord extends ArticleDocument {
  readonly createdAt: string;
  readonly id: string;
  readonly publishedAt: string | null;
  readonly revision: number;
  readonly slug: string;
  readonly state: ArticleState;
  readonly updatedAt: string;
}

const ARTICLE_ROOT_FIELDS = Object.freeze([
  ...ARTICLE_DOCUMENT_FIELDS,
  'createdAt',
  'id',
  'publishedAt',
  'revision',
  'slug',
  'state',
  'updatedAt',
] as const);

export interface CanonicalArticle {
  readonly bytes: Buffer;
  readonly record: ArticleRecord;
  readonly sha256: string;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isArticleId(value: unknown): value is string {
  return typeof value === 'string' && ARTICLE_ID_PATTERN.test(value);
}

export function isArticleSlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_SLUG_CHARACTERS &&
    SLUG_PATTERN.test(value) &&
    !RESERVED_ARTICLE_SLUGS.has(value)
  );
}

export function validateArticleDocument(value: unknown): ArticleDocument {
  const record = requireObject(value, 'article document');
  requireExactFields(record, ARTICLE_DOCUMENT_FIELDS, 'article document');
  return Object.freeze({
    body: boundedText(record['body'], 'body', 0, MAX_BODY_CHARACTERS),
    imagePrompts: boundedLineList(
      record['imagePrompts'],
      'imagePrompts',
      MAX_IMAGE_PROMPTS,
      MAX_IMAGE_PROMPT_CHARACTERS,
    ),
    ingress: boundedLine(record['ingress'], 'ingress', 0, MAX_INGRESS_CHARACTERS),
    pullQuotes: validatePullQuotes(record['pullQuotes']),
    socialPosts: boundedTextList(
      record['socialPosts'],
      'socialPosts',
      MAX_SOCIAL_POSTS,
      MAX_SOCIAL_POST_CHARACTERS,
    ),
    tags: validateTags(record['tags']),
    title: boundedLine(record['title'], 'title', 0, MAX_TITLE_CHARACTERS),
    topic: boundedLine(record['topic'], 'topic', 0, MAX_TOPIC_CHARACTERS),
  });
}

export function validateArticleRecord(value: unknown): ArticleRecord {
  const record = requireObject(value, 'article record');
  requireExactFields(record, ARTICLE_ROOT_FIELDS, 'article record');
  const document = validateArticleDocument(pickDocumentFields(record));
  const id = record['id'];
  if (!isArticleId(id)) throw new ArticleValidationError('id must be a lowercase UUID.');
  const slug = record['slug'];
  if (!isArticleSlug(slug)) {
    throw new ArticleValidationError(
      'slug must be lowercase-hyphenated, at most 80 characters, and outside the reserved platform routes.',
    );
  }
  const state = record['state'];
  if (state !== 'draft' && state !== 'published') {
    throw new ArticleValidationError('state must be exactly draft or published.');
  }
  const createdAt = requiredCanonicalTimestamp(record['createdAt'], 'createdAt');
  const updatedAt = requiredCanonicalTimestamp(record['updatedAt'], 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new ArticleValidationError('updatedAt must not precede createdAt.');
  }
  const publishedAt = record['publishedAt'];
  if (publishedAt !== null && !isPublishedAt(publishedAt)) {
    throw new ArticleValidationError(
      'publishedAt must be null or an ISO date or timestamp of record.',
    );
  }
  if (state === 'published' && publishedAt === null) {
    throw new ArticleValidationError('A published article must carry its publishedAt date.');
  }
  const revision = record['revision'];
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    throw new ArticleValidationError('revision must be a positive safe integer.');
  }
  return Object.freeze({
    ...document,
    createdAt,
    id,
    publishedAt: publishedAt as string | null,
    revision: revision as number,
    slug,
    state,
    updatedAt,
  });
}

export function canonicalArticle(record: ArticleRecord): CanonicalArticle {
  const valid = validateArticleRecord(record);
  const bytes = Buffer.from(canonicalJson(valid), 'utf8');
  if (bytes.length > ARTICLE_MAX_RECORD_BYTES) {
    throw new ArticleValidationError('The article record exceeds the canonical byte budget.');
  }
  return Object.freeze({ bytes, record: valid, sha256: sha256Hex(bytes) });
}

export function parseArticleBytes(bytes: Uint8Array): ArticleRecord {
  if (bytes.length > ARTICLE_MAX_RECORD_BYTES) {
    throw new ArticleValidationError('The stored article record exceeds the byte budget.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new ArticleValidationError('The stored article record is not valid JSON.', {
      cause: error,
    });
  }
  return validateArticleRecord(parsed);
}

export class ArticleValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArticleValidationError';
  }
}

/**
 * The publish contract — the mechanical half of the retired ghostwriter format checker, applied to
 * the structured record instead of a markdown file. Voice, truth, and the decision that an essay is
 * finished remain human editorial gates; this proves only the structural furniture the site needs.
 */
export function publishFormatProblems(document: ArticleDocument): readonly string[] {
  const problems: string[] = [];
  if (document.title.length < 1) problems.push('The title is empty.');
  if (document.topic.length < 1) {
    problems.push('The internal topic line is empty.');
  }
  const ingressLength = [...document.ingress].length;
  if (
    ingressLength < PUBLISH_MIN_INGRESS_CHARACTERS ||
    ingressLength > PUBLISH_MAX_INGRESS_CHARACTERS
  ) {
    problems.push(
      `The ingress must contain between ${String(PUBLISH_MIN_INGRESS_CHARACTERS)} and ${String(PUBLISH_MAX_INGRESS_CHARACTERS)} characters; it has ${String(ingressLength)}.`,
    );
  }
  if (document.body.trim().length < 1) problems.push('The body is empty.');
  if (document.tags.length < PUBLISH_MIN_TAGS || document.tags.length > PUBLISH_MAX_TAGS) {
    problems.push(
      `Between ${String(PUBLISH_MIN_TAGS)} and ${String(PUBLISH_MAX_TAGS)} tags are required; there are ${String(document.tags.length)}.`,
    );
  }
  if (document.socialPosts.length !== PUBLISH_SOCIAL_POSTS) {
    problems.push(`Exactly ${String(PUBLISH_SOCIAL_POSTS)} social posts are required.`);
  }
  for (const [index, post] of document.socialPosts.entries()) {
    if ([...post].length > PUBLISH_MAX_SOCIAL_POST_CHARACTERS) {
      problems.push(
        `Social post ${String(index + 1)} exceeds ${String(PUBLISH_MAX_SOCIAL_POST_CHARACTERS)} characters.`,
      );
    }
    if (post.trim().length < 1) problems.push(`Social post ${String(index + 1)} is empty.`);
  }
  if (
    document.pullQuotes.length < PUBLISH_MIN_PULL_QUOTES ||
    document.pullQuotes.length > PUBLISH_MAX_PULL_QUOTES
  ) {
    problems.push(
      `Between ${String(PUBLISH_MIN_PULL_QUOTES)} and ${String(PUBLISH_MAX_PULL_QUOTES)} pull quotes are required.`,
    );
  }
  for (const [index, quote] of document.pullQuotes.entries()) {
    if (quote.hook.trim().length < 1) {
      problems.push(`Pull quote ${String(index + 1)} has an empty hook line.`);
    }
    if (quote.hook.startsWith('Create')) {
      problems.push(
        `Pull quote ${String(index + 1)} starts with "Create"; that line belongs to the image prompts.`,
      );
    }
    if (quote.expansion.trim().length < 1) {
      problems.push(`Pull quote ${String(index + 1)} has no expansion paragraph.`);
    }
  }
  if (document.imagePrompts.length !== PUBLISH_IMAGE_PROMPTS) {
    problems.push(`Exactly ${String(PUBLISH_IMAGE_PROMPTS)} thumbnail prompts are required.`);
  }
  for (const [index, prompt] of document.imagePrompts.entries()) {
    if (!prompt.startsWith('Create a')) {
      problems.push(`Thumbnail prompt ${String(index + 1)} must start with "Create a".`);
    }
  }
  return Object.freeze(problems);
}

export function isPublishedAt(value: unknown): value is string {
  if (typeof value !== 'string' || !PUBLISHED_AT_PATTERN.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function requiredCanonicalTimestamp(value: unknown, label: string): string {
  if (!isCanonicalTimestamp(value)) {
    throw new ArticleValidationError(`${label} must be a canonical UTC millisecond timestamp.`);
  }
  return value;
}

export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export function normalizePolishInstruction(value: string): string {
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  if (normalized.length > MAX_POLISH_INSTRUCTION_CHARACTERS) {
    throw new ArticleValidationError(
      `A polish instruction must contain at most ${String(MAX_POLISH_INSTRUCTION_CHARACTERS)} characters.`,
    );
  }
  return normalized;
}

function pickDocumentFields(record: Record<string, unknown>): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  for (const field of ARTICLE_DOCUMENT_FIELDS) document[field] = record[field];
  return document;
}

function validateTags(value: unknown): readonly string[] {
  const tags = requireArray(value, 'tags', MAX_TAGS);
  const seen = new Set<string>();
  for (const [index, tag] of tags.entries()) {
    const label = `tags[${String(index)}]`;
    const text = boundedLine(tag, label, 1, MAX_TAG_CHARACTERS);
    if (text !== text.toLocaleLowerCase('en-GB')) {
      throw new ArticleValidationError(`${label} must be lowercase.`);
    }
    if (text.startsWith('#')) {
      throw new ArticleValidationError(`${label} must not start with #.`);
    }
    if (text.includes('  ')) {
      throw new ArticleValidationError(`${label} must not contain double spaces.`);
    }
    if (seen.has(text)) throw new ArticleValidationError(`${label} repeats an earlier tag.`);
    seen.add(text);
  }
  return Object.freeze(tags.map((tag) => tag as string));
}

function validatePullQuotes(value: unknown): readonly PullQuote[] {
  const quotes = requireArray(value, 'pullQuotes', MAX_PULL_QUOTES);
  return Object.freeze(
    quotes.map((quote, index) => {
      const record = requireObject(quote, `pullQuotes[${String(index)}]`);
      requireExactFields(record, ['expansion', 'hook'], `pullQuotes[${String(index)}]`);
      return Object.freeze({
        expansion: boundedText(
          record['expansion'],
          `pullQuotes[${String(index)}].expansion`,
          0,
          MAX_PULL_QUOTE_EXPANSION_CHARACTERS,
        ),
        hook: boundedLine(
          record['hook'],
          `pullQuotes[${String(index)}].hook`,
          0,
          MAX_PULL_QUOTE_HOOK_CHARACTERS,
        ),
      });
    }),
  );
}

function boundedLineList(
  value: unknown,
  label: string,
  maximumEntries: number,
  maximumCharacters: number,
): readonly string[] {
  const entries = requireArray(value, label, maximumEntries);
  return Object.freeze(
    entries.map((entry, index) =>
      boundedLine(entry, `${label}[${String(index)}]`, 1, maximumCharacters),
    ),
  );
}

function boundedTextList(
  value: unknown,
  label: string,
  maximumEntries: number,
  maximumCharacters: number,
): readonly string[] {
  const entries = requireArray(value, label, maximumEntries);
  return Object.freeze(
    entries.map((entry, index) =>
      boundedText(entry, `${label}[${String(index)}]`, 1, maximumCharacters),
    ),
  );
}

function boundedLine(value: unknown, label: string, minimum: number, maximum: number): string {
  const text = boundedText(value, label, minimum, maximum);
  if (/[\n\r]/u.test(text)) {
    throw new ArticleValidationError(`${label} must be a single line.`);
  }
  return text;
}

function boundedText(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') {
    throw new ArticleValidationError(`${label} must be a string.`);
  }
  if (value.length < minimum || value.length > maximum) {
    throw new ArticleValidationError(
      `${label} must contain between ${String(minimum)} and ${String(maximum)} characters.`,
    );
  }
  if (value !== value.replace(/\r\n?/gu, '\n')) {
    throw new ArticleValidationError(`${label} must use LF line endings.`);
  }
  if (containsForbiddenControlCharacters(value)) {
    throw new ArticleValidationError(`${label} must not contain control characters.`);
  }
  return value;
}

function containsForbiddenControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x0a) continue;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArticleValidationError(`The ${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string, maximumEntries: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximumEntries) {
    throw new ArticleValidationError(
      `${label} must be an array of at most ${String(maximumEntries)} entries.`,
    );
  }
  return value;
}

function requireExactFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ArticleValidationError(`The ${label} must contain exactly: ${expected.join(', ')}.`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  const body = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',');
  return `{${body}}`;
}
