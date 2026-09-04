import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild,
  ViewEncapsulation,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  CxAccountControlComponent,
  CxAlertComponent,
  CxButtonComponent,
  CxCardComponent,
  CxDialogComponent,
  CxDividerComponent,
  CxDropdownComponent,
  CxExpansionPanelComponent,
  CxIconButtonComponent,
  CxIconComponent,
  CxInlineComponent,
  CxMarkdownEditorComponent,
  CxPasswordFieldComponent,
  CxSideNavComponent,
  CxStackComponent,
  CxStateMessageComponent,
  CxTableComponent,
  CxTagFieldComponent,
  CxTextAreaComponent,
  CxTextFieldComponent,
  CxTopBarComponent,
  type CxDropdownOption,
  type CxFieldValidation,
  type CxMenuItem,
  type CxSideNavGroup,
  type CxStateMessageAction,
  type CxTableColumn,
  type CxTableRow,
  type CxTableRowActivateEvent,
  type CxTableRowMenuSelectEvent,
  type CxThemeMode,
  CX_THEMES,
  CX_THEME_ICONS,
  CX_THEME_LABELS,
  cxThemeStartsGroup,
  isCxThemeMode,
} from '@mikaelcedergren/cx-framework';

type AuthResponse = { authenticated?: boolean; ok?: boolean };

type ArticleState = 'draft' | 'published';
type PolishMode = 'rough' | 'reference' | 'developed' | 'polish';
type PolishState = 'queued' | 'running' | 'succeeded' | 'failed' | 'ambiguous';
type View = 'list' | 'editor';

type PullQuote = { hook: string; expansion: string };

type ArticleDocument = {
  title: string;
  topic: string;
  ingress: string;
  body: string;
  tags: string[];
  socialPosts: string[];
  pullQuotes: PullQuote[];
  imagePrompts: string[];
};

type Article = ArticleDocument & {
  id: string;
  slug: string;
  state: ArticleState;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  revision: number;
};

type ArticleSummary = {
  id: string;
  slug: string;
  state: ArticleState;
  title: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  revision: number;
};

type ArticleVersionSummary = {
  articleVersion: number;
  createdAt: string;
  polishRunId: string | null;
  source: 'author' | 'polish' | 'import';
};

type PolishStatus = {
  articleId: string;
  articleRevision: number;
  runId: string;
  jobId: string;
  mode: PolishMode;
  instruction: string | null;
  state: PolishState;
  updatedAt: string;
  error?: { code: string; message: string };
};

type ApiError = {
  error?: {
    code?: string;
    message?: string;
    details?: { currentRevision?: number; problems?: string[] };
  };
};

const DEFAULT_THEME: CxThemeMode = 'night';
const THEME_STORAGE_KEY = 'wg-studio-theme';

const POLISH_MODE_OPTIONS: CxDropdownOption[] = [
  {
    id: 'rough',
    label: 'Rough material',
    description: 'Raw ingredients. The ghostwriter rebuilds everything except the truth.',
  },
  {
    id: 'reference',
    label: 'Treat as reference',
    description: 'Extract what it means, then write it again from the ground up.',
  },
  {
    id: 'developed',
    label: 'Developed draft',
    description: 'The structure works. Narrow changes: phrasing, joins, thin scenes.',
  },
  {
    id: 'polish',
    label: 'Final polish',
    description: 'Grammar, rhythm and weak words only. Nothing is restructured.',
  },
];

const ARTICLE_COLUMNS: CxTableColumn[] = [
  { id: 'status', label: 'Status', size: 'content', hideable: false, pinnable: false },
  { id: 'title', label: 'Essay', key: true, size: 'flex', hideable: false, pinnable: false },
  {
    id: 'updated',
    label: 'Updated',
    size: 'content',
    align: 'end',
    hideable: false,
    pinnable: false,
  },
];

const LIST_MENU: CxMenuItem[] = [
  { id: 'delete', label: 'Delete essay', prependIcon: 'delete', danger: true },
];

const VERSION_SOURCE_LABELS: Record<ArticleVersionSummary['source'], string> = {
  author: 'Your edit',
  polish: 'Ghostwriter',
  import: 'Imported',
};

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function emptyDocument(): ArticleDocument {
  return {
    title: '',
    topic: '',
    ingress: '',
    body: '',
    tags: [],
    socialPosts: [],
    pullQuotes: [],
    imagePrompts: [],
  };
}

@Component({
  selector: 'wg-studio',
  imports: [
    CxAccountControlComponent,
    CxAlertComponent,
    CxButtonComponent,
    CxCardComponent,
    CxDialogComponent,
    CxDividerComponent,
    CxDropdownComponent,
    CxExpansionPanelComponent,
    CxIconButtonComponent,
    CxIconComponent,
    CxInlineComponent,
    CxMarkdownEditorComponent,
    CxPasswordFieldComponent,
    CxSideNavComponent,
    CxStackComponent,
    CxStateMessageComponent,
    CxTableComponent,
    CxTagFieldComponent,
    CxTextAreaComponent,
    CxTextFieldComponent,
    CxTopBarComponent,
  ],
  templateUrl: './studio.component.html',
  styleUrl: './studio.component.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StudioComponent implements OnInit, OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private pollSequence = 0;
  private saveQueue: Promise<void> = Promise.resolve();

  @ViewChild('usernameField')
  private readonly usernameField?: CxTextFieldComponent;

  @ViewChild(CxPasswordFieldComponent)
  private readonly passwordField?: CxPasswordFieldComponent;

  @ViewChild('newTitleField')
  private readonly newTitleField?: CxTextFieldComponent;

  protected readonly authenticated = signal(false);
  protected readonly submitting = signal(false);
  protected readonly username = signal('');
  protected readonly password = signal('');
  protected readonly usernameValidation = signal<CxFieldValidation | undefined>(undefined);
  protected readonly passwordValidation = signal<CxFieldValidation | undefined>(undefined);
  protected readonly requestError = signal('');

  protected readonly view = signal<View>('list');
  protected readonly articles = signal<ArticleSummary[]>([]);
  protected readonly article = signal<Article | undefined>(undefined);
  protected readonly draft = signal<ArticleDocument>(emptyDocument());
  protected readonly slugDraft = signal('');
  protected readonly listError = signal('');
  protected readonly editorError = signal('');
  protected readonly editorNotice = signal('');
  protected readonly publishProblems = signal<string[]>([]);
  protected readonly saving = signal(false);

  protected readonly polishMode = signal<PolishMode>('developed');
  protected readonly polishInstruction = signal('');
  protected readonly polishing = signal(false);
  protected readonly polishError = signal('');

  protected readonly versions = signal<ArticleVersionSummary[]>([]);

  protected readonly newEssayOpen = signal(false);
  protected readonly newTitle = signal('');
  protected readonly newTitleValidation = signal<CxFieldValidation | undefined>(undefined);
  protected readonly creating = signal(false);
  protected readonly pendingDelete = signal<ArticleSummary | undefined>(undefined);
  protected readonly mobileNavOpen = signal(false);

  protected readonly polishModeOptions = POLISH_MODE_OPTIONS;
  protected readonly articleColumns = ARTICLE_COLUMNS;
  protected readonly newEssayAction: CxStateMessageAction = {
    text: 'New essay',
    mood: 'primary',
    icon: 'new',
  };

  protected readonly dirty = computed(() => {
    const saved = this.article();
    if (!saved) return false;
    const current = this.draft();
    return (
      JSON.stringify(current) !== JSON.stringify(documentOf(saved)) ||
      this.slugDraft() !== saved.slug
    );
  });

  protected readonly ingressHint = computed(() => {
    const used = [...this.draft().ingress].length;
    return `Bold opening paragraph, 80–200 characters. Creates tension without revealing the conclusion. · ${String(used)}/200`;
  });

  protected readonly tagValues = computed(() => this.draft().tags);

  protected readonly availableTags = computed(() =>
    this.draft().tags.map((tag) => ({ id: tag, name: tag })),
  );

  protected readonly articleRows = computed<CxTableRow[]>(() =>
    this.articles().map((item) => ({
      id: item.id,
      cells: {
        status: {
          kind: 'status-tag',
          mood: item.state === 'published' ? 'success' : 'warning',
          icon: item.state === 'published' ? 'check' : 'edit',
          text: item.state === 'published' ? 'Published' : 'Draft',
        },
        title: { kind: 'text', value: item.title || item.slug, strong: true },
        updated: { kind: 'text', value: this.dateLabel(item.updatedAt), muted: true },
      },
      menuItems: LIST_MENU,
    })),
  );

  protected readonly editorMenu = computed<CxMenuItem[]>(() => {
    const current = this.article();
    const items: CxMenuItem[] = [];
    if (current?.state === 'draft') {
      items.push({ id: 'publish', label: 'Publish essay', prependIcon: 'send' });
    }
    if (current?.state === 'published') {
      items.push({ id: 'unpublish', label: 'Unpublish essay', prependIcon: 'reset' });
    }
    items.push({
      id: 'delete',
      label: 'Delete essay',
      prependIcon: 'delete',
      danger: true,
      dividerBefore: true,
    });
    return items;
  });

  protected readonly topBarHeading = computed(() => {
    if (this.view() === 'editor') return this.article()?.title || 'Essay';
    return 'Essays';
  });

  protected readonly topBarDescription = computed(() => {
    if (this.view() === 'editor') {
      const current = this.article();
      if (!current) return '';
      return current.state === 'published' ? `Published · wargr.com/${current.slug}/` : 'Draft';
    }
    return 'Write rough, polish in the voice, publish when it is true.';
  });

  protected readonly theme = signal<CxThemeMode>(DEFAULT_THEME);

  protected readonly accountMenu = computed<CxMenuItem[]>(() => {
    const current = this.theme();
    return [
      {
        id: 'theme',
        label: 'Theme',
        prependIcon: CX_THEME_ICONS[current],
        selection: 'single',
        items: CX_THEMES.map((definition, index) => ({
          id: `theme:${definition.id}`,
          label: CX_THEME_LABELS[definition.id],
          prependIcon: CX_THEME_ICONS[definition.id],
          type: 'choice' as const,
          selected: definition.id === current,
          dividerBefore: cxThemeStartsGroup(index),
        })),
      },
      { id: 'logout', label: 'Log out', prependIcon: 'log-out', danger: true, dividerBefore: true },
    ];
  });

  protected readonly navGroups: CxSideNavGroup[] = [
    {
      id: 'studio',
      label: 'Studio',
      items: [{ id: 'essays', label: 'Essays', icon: 'edit', routerLink: ['/studio'] }],
    },
  ];

  public constructor() {
    this.applyTheme(this.theme());
  }

  public ngOnInit(): void {
    if (this.browser) {
      this.restoreTheme();
      void this.restoreSession();
    }
  }

  public ngOnDestroy(): void {
    this.pollSequence += 1;
    this.document.documentElement.classList.remove(`theme-${this.theme()}`);
  }

  /* Sign in */

  protected updateUsername(value: string): void {
    this.username.set(value);
    this.usernameValidation.set(undefined);
    this.requestError.set('');
  }

  protected updatePassword(value: string): void {
    this.password.set(value);
    this.passwordValidation.set(undefined);
    this.requestError.set('');
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    void this.signIn();
  }

  protected async signIn(): Promise<void> {
    if (this.submitting()) return;

    const username = this.username().trim();
    const password = this.password();
    const usernameMissing = username.length === 0;
    const passwordMissing = password.length === 0;

    this.usernameValidation.set(usernameMissing ? 'Enter a username.' : undefined);
    this.passwordValidation.set(passwordMissing ? 'Enter a password.' : undefined);
    this.requestError.set('');

    if (usernameMissing || passwordMissing) {
      queueMicrotask(() =>
        usernameMissing ? this.usernameField?.focus() : this.passwordField?.focus(),
      );
      return;
    }

    this.submitting.set(true);
    try {
      const response = await this.request('/api/studio/login', {
        method: 'POST',
        body: { username, password },
      });
      if (!response.ok) {
        // Unexpected refusals (an origin guard, a proxy problem) surface the server's own words
        // so the real cause is readable instead of hiding behind a generic connection message.
        this.requestError.set(
          response.status === 401
            ? 'Username or password is incorrect. Try again.'
            : response.status === 429
              ? 'Too many sign-in attempts. Try again later.'
              : await this.apiErrorMessage(
                  response,
                  'Studio cannot be reached right now. Try again.',
                ),
        );
        return;
      }
      this.authenticated.set(true);
      this.password.set('');
      await this.loadWorkspace();
    } catch {
      this.requestError.set('Studio cannot be reached right now. Try again.');
    } finally {
      this.submitting.set(false);
    }
  }

  protected async signOut(): Promise<void> {
    if (this.submitting()) return;
    this.submitting.set(true);
    try {
      await this.request('/api/studio/logout', { method: 'POST' });
    } finally {
      this.pollSequence += 1;
      this.authenticated.set(false);
      this.username.set('');
      this.password.set('');
      this.requestError.set('');
      this.resetStudio();
      this.submitting.set(false);
      queueMicrotask(() => this.usernameField?.focus());
    }
  }

  /* List */

  protected startNewEssay(): void {
    this.newTitle.set('');
    this.newTitleValidation.set(undefined);
    this.newEssayOpen.set(true);
    queueMicrotask(() => this.newTitleField?.focus());
  }

  protected closeNewEssay(): void {
    this.newEssayOpen.set(false);
  }

  protected updateNewTitle(value: string): void {
    this.newTitle.set(value);
    this.newTitleValidation.set(undefined);
  }

  protected async createEssay(): Promise<void> {
    if (this.creating()) return;
    const title = this.newTitle().trim();
    if (title.length === 0) {
      this.newTitleValidation.set('Give the essay a working title.');
      queueMicrotask(() => this.newTitleField?.focus());
      return;
    }
    this.creating.set(true);
    try {
      const response = await this.request('/api/studio/articles', {
        method: 'POST',
        body: { title },
      });
      if (response.status === 401) {
        this.expireSession();
        return;
      }
      if (!response.ok) {
        this.newTitleValidation.set(
          await this.apiErrorMessage(response, 'The essay could not be created. Try again.'),
        );
        return;
      }
      const payload = (await response.json()) as { article?: Article };
      this.newEssayOpen.set(false);
      await this.refreshArticles();
      if (payload.article) this.openLoadedArticle(payload.article);
    } catch {
      this.newTitleValidation.set('Studio cannot be reached right now. Try again.');
    } finally {
      this.creating.set(false);
    }
  }

  protected onRowActivate(event: CxTableRowActivateEvent): void {
    const summary = this.articles().find((item) => item.id === event.rowId);
    if (summary) void this.openArticle(summary.id);
  }

  protected onRowMenu(event: CxTableRowMenuSelectEvent): void {
    const summary = this.articles().find((item) => item.id === event.rowId);
    if (summary && event.itemId === 'delete') this.pendingDelete.set(summary);
  }

  protected showList(): void {
    this.pollSequence += 1;
    this.view.set('list');
    this.article.set(undefined);
    this.versions.set([]);
    this.editorError.set('');
    this.editorNotice.set('');
    this.publishProblems.set([]);
    this.polishError.set('');
    this.polishing.set(false);
    void this.refreshArticles();
  }

  /* Editor */

  protected async openArticle(id: string): Promise<void> {
    const sequence = ++this.pollSequence;
    this.listError.set('');
    try {
      const response = await this.request(`/api/studio/articles/${id}`);
      if (sequence !== this.pollSequence) return;
      if (response.status === 401) {
        this.expireSession();
        return;
      }
      if (!response.ok) {
        this.listError.set(
          await this.apiErrorMessage(response, 'That essay could not be opened. Try again.'),
        );
        return;
      }
      const payload = (await response.json()) as { article?: Article };
      if (!payload.article) {
        this.listError.set('That essay could not be opened. Try again.');
        return;
      }
      this.openLoadedArticle(payload.article);
      await this.recoverPolishWork(payload.article.id);
    } catch {
      if (sequence !== this.pollSequence) return;
      this.listError.set('Studio cannot be reached right now. Try again.');
    }
  }

  private openLoadedArticle(article: Article): void {
    this.article.set(article);
    this.draft.set(documentOf(article));
    this.slugDraft.set(article.slug);
    this.editorError.set('');
    this.editorNotice.set('');
    this.publishProblems.set([]);
    this.polishError.set('');
    this.polishing.set(false);
    this.view.set('editor');
    void this.refreshVersions(article.id);
  }

  protected updateDraftField(field: 'title' | 'topic' | 'ingress' | 'body', value: string): void {
    this.draft.update((current) => ({ ...current, [field]: value }));
    this.editorNotice.set('');
  }

  protected updateSlug(value: string): void {
    this.slugDraft.set(value);
    this.editorNotice.set('');
  }

  protected updateTags(values: string[]): void {
    this.draft.update((current) => ({
      ...current,
      tags: values.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0),
    }));
  }

  protected updateListEntry(
    field: 'socialPosts' | 'imagePrompts',
    index: number,
    value: string,
  ): void {
    this.draft.update((current) => ({
      ...current,
      [field]: current[field].map((entry, position) => (position === index ? value : entry)),
    }));
  }

  protected addListEntry(field: 'socialPosts' | 'imagePrompts'): void {
    this.draft.update((current) => ({ ...current, [field]: [...current[field], ''] }));
  }

  protected removeListEntry(field: 'socialPosts' | 'imagePrompts', index: number): void {
    this.draft.update((current) => ({
      ...current,
      [field]: current[field].filter((_, position) => position !== index),
    }));
  }

  protected updatePullQuote(index: number, field: 'hook' | 'expansion', value: string): void {
    this.draft.update((current) => ({
      ...current,
      pullQuotes: current.pullQuotes.map((quote, position) =>
        position === index ? { ...quote, [field]: value } : quote,
      ),
    }));
  }

  protected addPullQuote(): void {
    this.draft.update((current) => ({
      ...current,
      pullQuotes: [...current.pullQuotes, { hook: '', expansion: '' }],
    }));
  }

  protected removePullQuote(index: number): void {
    this.draft.update((current) => ({
      ...current,
      pullQuotes: current.pullQuotes.filter((_, position) => position !== index),
    }));
  }

  protected async save(): Promise<void> {
    const current = this.article();
    if (!current || !this.dirty() || this.saving() || this.polishing()) return;
    this.saving.set(true);
    this.editorError.set('');
    this.saveQueue = this.saveQueue.then(() => this.persistDraft(current));
    try {
      await this.saveQueue;
    } finally {
      this.saving.set(false);
    }
  }

  private async persistDraft(saved: Article): Promise<void> {
    const document = normalizedDraft(this.draft());
    const slug = this.slugDraft().trim();
    try {
      const response = await this.request(`/api/studio/articles/${saved.id}`, {
        method: 'PUT',
        body:
          slug === saved.slug
            ? { expectedRevision: saved.revision, document }
            : { expectedRevision: saved.revision, document, slug },
      });
      if (response.status === 401) {
        this.expireSession();
        return;
      }
      if (!response.ok) {
        this.editorError.set(
          await this.apiErrorMessage(response, 'The essay could not be saved. Try again.'),
        );
        if (response.status === 409) await this.reloadArticle(saved.id);
        return;
      }
      const payload = (await response.json()) as { article?: Article };
      if (payload.article) {
        this.article.set(payload.article);
        this.draft.set(normalizedDraft(this.draft()));
        this.slugDraft.set(payload.article.slug);
        this.editorNotice.set('Saved.');
        void this.refreshVersions(payload.article.id);
      }
    } catch {
      this.editorError.set('Studio cannot be reached right now. The text stays here unsaved.');
    }
  }

  private async reloadArticle(id: string): Promise<void> {
    try {
      const response = await this.request(`/api/studio/articles/${id}`);
      if (!response.ok) return;
      const payload = (await response.json()) as { article?: Article };
      if (payload.article) {
        this.article.set(payload.article);
      }
    } catch {
      // The next explicit action retries; the draft keeps the author's text either way.
    }
  }

  /* Polish */

  protected selectPolishMode(id: string | undefined): void {
    if (id === 'rough' || id === 'reference' || id === 'developed' || id === 'polish') {
      this.polishMode.set(id);
    }
  }

  protected updatePolishInstruction(value: string): void {
    this.polishInstruction.set(value);
  }

  protected async startPolish(): Promise<void> {
    const current = this.article();
    if (!current || this.polishing()) return;
    if (this.dirty()) {
      await this.save();
      if (this.dirty()) return;
    }
    const saved = this.article();
    if (!saved) return;

    this.polishError.set('');
    this.editorNotice.set('');
    this.polishing.set(true);
    try {
      const instruction = this.polishInstruction().trim();
      const response = await this.request(`/api/studio/articles/${saved.id}/polish`, {
        method: 'POST',
        body: {
          expectedRevision: saved.revision,
          mode: this.polishMode(),
          ...(instruction.length > 0 ? { instruction } : {}),
        },
      });
      if (response.status === 401) {
        this.expireSession();
        return;
      }
      if (!response.ok) {
        this.polishError.set(
          await this.apiErrorMessage(response, this.polishErrorFor(response.status)),
        );
        this.polishing.set(false);
        if (response.status === 409) await this.reloadArticle(saved.id);
        return;
      }
      const sequence = ++this.pollSequence;
      void this.pollPolish(saved.id, sequence);
    } catch {
      this.polishError.set('Studio cannot be reached right now. Try again.');
      this.polishing.set(false);
    }
  }

  private async pollPolish(articleId: string, sequence: number): Promise<void> {
    while (sequence === this.pollSequence) {
      try {
        const response = await this.request(`/api/studio/articles/${articleId}/polish/status`);
        if (sequence !== this.pollSequence) return;
        if (response.status === 401) {
          this.expireSession();
          return;
        }
        if (!response.ok) {
          this.polishError.set(
            await this.apiErrorMessage(response, 'The polish status cannot be read right now.'),
          );
          this.polishing.set(false);
          return;
        }
        const payload = (await response.json()) as { status?: PolishStatus };
        const status = payload.status;
        if (!status || status.articleId !== articleId) {
          this.polishError.set('The polish status came back incomplete. Try again.');
          this.polishing.set(false);
          return;
        }
        if (status.state === 'failed' || status.state === 'ambiguous') {
          this.polishError.set(polishFailureMessage(status));
          this.polishing.set(false);
          return;
        }
        if (status.state === 'succeeded') {
          await this.applyPolishedArticle(articleId, sequence);
          return;
        }
      } catch {
        if (sequence !== this.pollSequence) return;
        this.polishError.set('The polish status cannot be reached right now. Retrying…');
      }
      await pollDelay();
    }
  }

  private async applyPolishedArticle(articleId: string, sequence: number): Promise<void> {
    try {
      const response = await this.request(`/api/studio/articles/${articleId}`);
      if (sequence !== this.pollSequence) return;
      if (!response.ok) {
        this.polishError.set('The polished essay could not be loaded. Reload the page.');
        return;
      }
      const payload = (await response.json()) as { article?: Article };
      if (!payload.article) return;
      this.article.set(payload.article);
      this.draft.set(documentOf(payload.article));
      this.slugDraft.set(payload.article.slug);
      this.polishInstruction.set('');
      this.editorNotice.set(
        'The ghostwriter finished this round. Read it, edit what is yours, then run the next round.',
      );
      void this.refreshVersions(articleId);
    } finally {
      if (sequence === this.pollSequence) this.polishing.set(false);
    }
  }

  private async recoverPolishWork(articleId: string): Promise<void> {
    const sequence = this.pollSequence;
    try {
      const response = await this.request(`/api/studio/articles/${articleId}/polish/status`);
      if (sequence !== this.pollSequence || !this.authenticated()) return;
      if (!response.ok) return;
      const payload = (await response.json()) as { status?: PolishStatus };
      const status = payload.status;
      if (!status) return;
      if (status.state === 'queued' || status.state === 'running') {
        this.polishing.set(true);
        this.polishMode.set(status.mode);
        void this.pollPolish(articleId, sequence);
      }
    } catch {
      // Durable work remains on the server; the next polish action reads it again.
    }
  }

  /* Publish, unpublish, delete */

  protected onEditorMenu(action: string): void {
    if (action === 'publish') void this.publish();
    if (action === 'unpublish') void this.unpublish();
    if (action === 'delete') {
      const current = this.article();
      if (current) {
        this.pendingDelete.set({
          id: current.id,
          slug: current.slug,
          state: current.state,
          title: current.title,
          createdAt: current.createdAt,
          updatedAt: current.updatedAt,
          publishedAt: current.publishedAt,
          revision: current.revision,
        });
      }
    }
  }

  protected async publish(): Promise<void> {
    await this.changeState('publish');
  }

  protected async unpublish(): Promise<void> {
    await this.changeState('unpublish');
  }

  private async changeState(action: 'publish' | 'unpublish'): Promise<void> {
    const current = this.article();
    if (!current || this.saving() || this.polishing()) return;
    if (this.dirty()) {
      await this.save();
      if (this.dirty()) return;
    }
    const saved = this.article();
    if (!saved) return;
    this.publishProblems.set([]);
    this.editorError.set('');
    try {
      const response = await this.request(`/api/studio/articles/${saved.id}/${action}`, {
        method: 'POST',
        body: { expectedRevision: saved.revision },
      });
      if (response.status === 401) {
        this.expireSession();
        return;
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as ApiError;
        const problems = payload.error?.details?.problems;
        if (response.status === 422 && Array.isArray(problems)) {
          this.publishProblems.set(problems);
          this.editorError.set('The essay does not meet the publish format yet.');
        } else {
          this.editorError.set(
            payload.error?.message ?? 'That change could not be made. Try again.',
          );
          if (response.status === 409) await this.reloadArticle(saved.id);
        }
        return;
      }
      const payload = (await response.json()) as { article?: Article };
      if (payload.article) {
        this.article.set(payload.article);
        this.slugDraft.set(payload.article.slug);
        this.editorNotice.set(
          action === 'publish'
            ? 'Published. The essay is now marked for the next site release.'
            : 'Unpublished. The essay returns to drafts.',
        );
      }
      await this.refreshArticles();
    } catch {
      this.editorError.set('Studio cannot be reached right now. Try again.');
    }
  }

  protected cancelDelete(): void {
    this.pendingDelete.set(undefined);
  }

  protected async confirmDelete(): Promise<void> {
    const target = this.pendingDelete();
    this.pendingDelete.set(undefined);
    if (!target) return;
    let deleted = false;
    try {
      const response = await this.request(`/api/studio/articles/${target.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"${String(target.revision)}"` },
      });
      if (response.status === 401) {
        this.expireSession();
        return;
      }
      if (!response.ok) {
        const message = await this.apiErrorMessage(response, 'That essay could not be deleted.');
        if (this.view() === 'editor') this.editorError.set(message);
        else this.listError.set(message);
        return;
      }
      deleted = true;
    } catch {
      this.listError.set('That essay could not be deleted. Check the connection.');
    } finally {
      if (deleted && this.article()?.id === target.id) {
        this.showList();
      } else {
        await this.refreshArticles();
      }
    }
  }

  /* Versions */

  protected async restoreVersion(version: ArticleVersionSummary): Promise<void> {
    const current = this.article();
    if (!current) return;
    try {
      const response = await this.request(
        `/api/studio/articles/${current.id}/versions/${String(version.articleVersion)}`,
      );
      if (!response.ok) {
        this.editorError.set('That version could not be loaded.');
        return;
      }
      const payload = (await response.json()) as {
        version?: { document?: ArticleDocument };
      };
      if (!payload.version?.document) return;
      this.draft.set({ ...emptyDocument(), ...payload.version.document });
      this.editorNotice.set(
        `Version ${String(version.articleVersion)} is loaded into the editor. Save to keep it.`,
      );
    } catch {
      this.editorError.set('Studio cannot be reached right now. Try again.');
    }
  }

  protected versionLabel(version: ArticleVersionSummary): string {
    return `${VERSION_SOURCE_LABELS[version.source]} · ${this.timeLabel(version.createdAt)}`;
  }

  /* Shared helpers */

  protected dateLabel(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown date' : DATE_FORMAT.format(date);
  }

  protected timeLabel(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown time' : TIME_FORMAT.format(date);
  }

  protected onAccountMenu(itemId: string): void {
    if (itemId === 'logout') return;
    const mode = itemId.startsWith('theme:') ? itemId.slice('theme:'.length) : '';
    if (!isCxThemeMode(mode)) return;
    this.applyTheme(mode);
    try {
      this.document.defaultView?.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // A blocked storage quota must not stop the theme from applying for this session.
    }
  }

  protected closeMobileNav(): void {
    this.mobileNavOpen.set(false);
  }

  protected toggleMobileNav(): void {
    this.mobileNavOpen.update((open) => !open);
  }

  private applyTheme(mode: CxThemeMode): void {
    const root = this.document.documentElement;
    for (const definition of CX_THEMES) {
      root.classList.toggle(`theme-${definition.id}`, definition.id === mode);
    }
    this.theme.set(mode);
  }

  private restoreTheme(): void {
    let stored: string | null = null;
    try {
      stored = this.document.defaultView?.localStorage.getItem(THEME_STORAGE_KEY) ?? null;
    } catch {
      stored = null;
    }
    this.applyTheme(isCxThemeMode(stored) ? stored : DEFAULT_THEME);
  }

  private async restoreSession(): Promise<void> {
    try {
      const response = await this.request('/api/studio/session');
      if (!response.ok) return;
      const payload = (await response.json()) as AuthResponse;
      this.authenticated.set(payload.authenticated === true);
      if (payload.authenticated) await this.loadWorkspace();
    } catch {
      // The login form remains available when the development API server is not running.
    }
  }

  private async loadWorkspace(): Promise<void> {
    await this.refreshArticles();
  }

  private async refreshArticles(): Promise<void> {
    try {
      const response = await this.request('/api/studio/articles');
      if (!response.ok) return;
      const payload = (await response.json()) as { articles?: ArticleSummary[] };
      this.articles.set(payload.articles ?? []);
    } catch {
      // Keep the current list rather than clearing it on a transient failure.
    }
  }

  private async refreshVersions(articleId: string): Promise<void> {
    try {
      const response = await this.request(`/api/studio/articles/${articleId}/versions`);
      if (!response.ok || this.article()?.id !== articleId) return;
      const payload = (await response.json()) as { versions?: ArticleVersionSummary[] };
      if (this.article()?.id === articleId) this.versions.set(payload.versions ?? []);
    } catch {
      // The history panel stays as it was; the next save refreshes it.
    }
  }

  private expireSession(): void {
    this.pollSequence += 1;
    this.authenticated.set(false);
    this.requestError.set('Your session expired. Sign in again.');
    this.resetStudio();
  }

  private async apiErrorMessage(response: Response, fallback: string): Promise<string> {
    const payload = (await response.json().catch(() => ({}))) as ApiError;
    return payload.error?.message || fallback;
  }

  private polishErrorFor(status: number): string {
    if (status === 429) return 'The ghostwriter is busy right now. Try again shortly.';
    if (status === 503) {
      return 'OpenAI is not connected yet. Add the API key to the worker-owned .env.worker file and restart the jobs worker.';
    }
    return 'The polish could not be started right now. Try again.';
  }

  private resetStudio(): void {
    this.view.set('list');
    this.articles.set([]);
    this.article.set(undefined);
    this.draft.set(emptyDocument());
    this.slugDraft.set('');
    this.versions.set([]);
    this.listError.set('');
    this.editorError.set('');
    this.editorNotice.set('');
    this.publishProblems.set([]);
    this.saving.set(false);
    this.polishing.set(false);
    this.polishError.set('');
    this.polishInstruction.set('');
    this.polishMode.set('developed');
    this.newEssayOpen.set(false);
    this.newTitle.set('');
    this.creating.set(false);
    this.pendingDelete.set(undefined);
    this.mobileNavOpen.set(false);
  }

  private request(
    path: string,
    options: {
      body?: object;
      headers?: Readonly<Record<string, string>>;
      method?: 'DELETE' | 'GET' | 'POST' | 'PUT';
    } = {},
  ): Promise<Response> {
    const init: RequestInit = {
      credentials: 'same-origin',
      method: options.method ?? 'GET',
    };
    if (options.body) {
      init.body = JSON.stringify(options.body);
      init.headers = { ...options.headers, 'Content-Type': 'application/json' };
    } else if (options.headers) {
      init.headers = options.headers;
    }
    return fetch(path, init);
  }
}

function documentOf(article: Article): ArticleDocument {
  return {
    title: article.title,
    topic: article.topic,
    ingress: article.ingress,
    body: article.body,
    tags: [...article.tags],
    socialPosts: [...article.socialPosts],
    pullQuotes: article.pullQuotes.map((quote) => ({ ...quote })),
    imagePrompts: [...article.imagePrompts],
  };
}

/** Empty list rows are editor scaffolding, not content; they leave before the document is saved. */
function normalizedDraft(draft: ArticleDocument): ArticleDocument {
  return {
    ...draft,
    socialPosts: draft.socialPosts.filter((post) => post.trim().length > 0),
    imagePrompts: draft.imagePrompts.filter((prompt) => prompt.trim().length > 0),
    pullQuotes: draft.pullQuotes.filter(
      (quote) => quote.hook.trim().length > 0 || quote.expansion.trim().length > 0,
    ),
  };
}

function polishFailureMessage(status: PolishStatus): string {
  return (
    status.error?.message ??
    (status.state === 'ambiguous'
      ? 'The provider may have received the request, so it was not sent again. Review the round before retrying.'
      : 'The polish round failed. Try it again.')
  );
}

function pollDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1_000));
}
