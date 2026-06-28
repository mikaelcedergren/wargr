import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'wg-not-found',
  imports: [RouterLink],
  template: `
    <section class="wg-container wg-article">
      <h1 class="wg-article__title">Not found</h1>
      <p class="wg-article__dek">That page doesn't exist.</p>
      <a class="wg-back" routerLink="/">← All essays</a>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFoundComponent {}
