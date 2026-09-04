import type {
  ArticleDocument,
  ArticleState,
  ArticleVersionSource,
  PolishMode,
} from './article-schema.js';

export interface ArticleSummaryDto {
  readonly createdAt: string;
  readonly id: string;
  readonly publishedAt: string | null;
  readonly revision: number;
  readonly slug: string;
  readonly state: ArticleState;
  readonly title: string;
  readonly updatedAt: string;
}

export interface ArticleDto extends ArticleSummaryDto, ArticleDocument {}

export interface ArticleVersionSummaryDto {
  readonly articleVersion: number;
  readonly createdAt: string;
  readonly polishRunId: string | null;
  readonly source: ArticleVersionSource;
}

export interface ArticleVersionDto extends ArticleVersionSummaryDto {
  readonly document: ArticleDocument;
}

export type ArticleMutationResult<T> =
  | T
  | { readonly status: 'not_found' }
  | { readonly currentRevision: number; readonly status: 'revision_conflict' };

export interface UpdateArticleInput {
  readonly document: ArticleDocument;
  readonly expectedRevision: number;
  readonly id: string;
  readonly slug?: string;
}

export interface ArticleService {
  createArticle(input: { readonly title: string }): Promise<ArticleDto>;
  deleteArticle(input: {
    readonly expectedRevision: number;
    readonly id: string;
  }): Promise<ArticleMutationResult<{ readonly status: 'deleted' }>>;
  getArticle(id: string): Promise<ArticleDto | null>;
  getVersion(id: string, articleVersion: number): Promise<ArticleVersionDto | null>;
  listArticles(): Promise<readonly ArticleSummaryDto[]>;
  listVersions(id: string): Promise<readonly ArticleVersionSummaryDto[]>;
  publishArticle(input: {
    readonly expectedRevision: number;
    readonly id: string;
  }): Promise<ArticleMutationResult<ArticleDto>>;
  unpublishArticle(input: {
    readonly expectedRevision: number;
    readonly id: string;
  }): Promise<ArticleMutationResult<ArticleDto>>;
  updateArticle(input: UpdateArticleInput): Promise<ArticleMutationResult<ArticleDto>>;
}

export type PolishRunState = 'queued' | 'running' | 'succeeded' | 'failed' | 'ambiguous';

export interface PolishAcceptance {
  readonly articleId: string;
  readonly articleRevision: number;
  readonly jobId: string;
  readonly runId: string;
  readonly state: 'queued';
}

export interface PolishStatus {
  readonly articleId: string;
  readonly articleRevision: number;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
  readonly instruction: string | null;
  readonly jobId: string;
  readonly mode: PolishMode;
  readonly runId: string;
  readonly state: PolishRunState;
  readonly updatedAt: string;
}

export interface PolishService {
  getStatus(articleId: string): Promise<PolishStatus | null>;
  listRecoverableStatuses(): Promise<readonly PolishStatus[]>;
  startPolish(input: {
    readonly articleId: string;
    readonly expectedRevision: number;
    readonly instruction: string | null;
    readonly mode: PolishMode;
    readonly ownerSessionIdHash: string;
  }): Promise<ArticleMutationResult<PolishAcceptance>>;
}

/** A synchronous SQLite readiness view. It must never perform migrations or external effects. */
export interface DatabaseReadiness {
  isReady(): boolean;
}
