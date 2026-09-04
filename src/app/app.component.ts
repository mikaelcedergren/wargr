import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { ChangeDetectionStrategy, Component, PLATFORM_ID, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import {
  CxIconButtonComponent,
  CxNavigationRecoveryComponent,
} from '@mikaelcedergren/cx-framework';

@Component({
  selector: 'wg-root',
  imports: [RouterOutlet, RouterLink, CxIconButtonComponent, CxNavigationRecoveryComponent],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private readonly doc = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly router = inject(Router);
  protected readonly year = new Date().getFullYear();

  /** Routes flagged `chrome: 'bare'` (Studio) own the full viewport without masthead or footer. */
  protected readonly bare = signal(this.routeIsBare());

  /** Light is the default; the pre-paint script in index.html may have switched to night already. */
  protected readonly night = signal(
    this.isBrowser && this.doc.documentElement.classList.contains('theme-night'),
  );

  public constructor() {
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.bare.set(this.routeIsBare()));
  }

  protected toggleTheme(): void {
    const next = !this.night();
    this.night.set(next);
    const root = this.doc.documentElement;
    root.classList.remove('theme-dark');
    root.classList.toggle('theme-night', next);
    root.classList.toggle('theme-light', !next);
    try {
      localStorage.setItem('wg-theme', next ? 'night' : 'light');
    } catch {
      /* storage blocked (private mode) — the toggle still works for this session */
    }
  }

  private routeIsBare(): boolean {
    let route = this.router.routerState.snapshot.root;
    while (route.firstChild) route = route.firstChild;
    return route.data['chrome'] === 'bare';
  }
}
