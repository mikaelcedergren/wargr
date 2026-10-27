import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import {
  CX_THEMES,
  CxIconButtonComponent,
  CxNavigationRecoveryComponent,
  CxMastheadComponent,
  CxInlineComponent,
  type CxMastheadItem,
} from '@mikaelcedergren/cx-framework';

import { Appearance } from './shared/appearance';

@Component({
  selector: 'wg-root',
  imports: [
    RouterOutlet,
    RouterLink,
    CxIconButtonComponent,
    CxNavigationRecoveryComponent,
    CxMastheadComponent,
    CxInlineComponent,
  ],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private readonly doc = inject(DOCUMENT);
  private readonly appearance = inject(Appearance);
  private readonly router = inject(Router);
  protected readonly year = new Date().getFullYear();
  private readonly page = signal(this.pageData());
  protected readonly navigation = computed<CxMastheadItem[]>(() => [
    { id: 'videos', label: 'Videos', href: '/', active: this.page()['section'] === 'videos' },
    { id: 'blog', label: 'Blog', href: '/blog/', active: this.page()['section'] === 'blog' },
    { id: 'about', label: 'About', href: '/about/', active: this.page()['section'] === 'about' },
  ]);

  /** Private routes own their viewport without public navigation. */
  protected readonly bare = computed(() => this.page()['chrome'] === 'bare');

  protected readonly night = computed(() => this.appearance.reader() === 'night');

  public constructor() {
    effect(() => {
      const mode = this.bare() ? this.appearance.admin() : this.appearance.reader();
      for (const theme of CX_THEMES) {
        this.doc.documentElement.classList.toggle(`theme-${theme.id}`, theme.id === mode);
      }
    });

    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.page.set(this.pageData()));
  }

  protected toggleTheme(): void {
    this.appearance.toggleReader();
  }

  private pageData() {
    let route = this.router.routerState.snapshot.root;
    while (route.firstChild) route = route.firstChild;
    return route.data;
  }
}
