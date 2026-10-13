import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CxHeroComponent } from '@mikaelcedergren/cx-framework';

@Component({
  selector: 'wg-not-found',
  imports: [RouterLink, CxHeroComponent],
  template: `
    <cx-hero heading="Page not found">
      <p body>That page doesn't exist.</p>
      <a actions routerLink="/">Back to home</a>
    </cx-hero>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFoundComponent {}
