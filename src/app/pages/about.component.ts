import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CxHeroComponent, CxInlineComponent } from '@mikaelcedergren/cx-framework';

@Component({
  selector: 'wg-about',
  imports: [RouterLink, CxHeroComponent, CxInlineComponent],
  template: `
    <cx-hero heading="Michael Wargr">
      <p body>
        I make videos and write essays about philosophy, ethics, and human nature: how fear shapes
        us, the stories we tell ourselves, and what it means to know who we are.
      </p>
      <cx-inline actions gap="lg">
        <a routerLink="/">Watch the videos</a>
        <a routerLink="/blog">Read the blog</a>
      </cx-inline>
    </cx-hero>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AboutComponent {}
