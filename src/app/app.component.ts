import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { ChangeDetectionStrategy, Component, PLATFORM_ID, inject, signal } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

@Component({
  selector: 'wg-root',
  imports: [RouterOutlet, RouterLink],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private readonly doc = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  protected readonly year = new Date().getFullYear();

  /** Light is the default; the pre-paint script in index.html may have switched to dark already. */
  protected readonly dark = signal(
    this.isBrowser && this.doc.documentElement.classList.contains('theme-dark'),
  );

  protected toggleTheme(): void {
    const next = !this.dark();
    this.dark.set(next);
    const root = this.doc.documentElement;
    root.classList.toggle('theme-dark', next);
    root.classList.toggle('theme-light', !next);
    try {
      localStorage.setItem('wg-theme', next ? 'dark' : 'light');
    } catch {
      /* storage blocked (private mode) — the toggle still works for this session */
    }
  }
}
