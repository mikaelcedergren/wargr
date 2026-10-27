import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  CxButtonComponent,
  CxHeroComponent,
  CxInlineComponent,
  CxImageComponent,
} from '@mikaelcedergren/cx-framework';

@Component({
  selector: 'wg-videos',
  imports: [RouterLink, CxButtonComponent, CxHeroComponent, CxInlineComponent, CxImageComponent],
  template: `
    <cx-hero heading="What the mirror doesn’t show you" layout="split">
      <cx-image
        media
        [image]="{
          src: '/assets/videos/what-the-mirror-doesnt-show-you.jpg',
          alt: 'What the mirror doesn’t show you — video thumbnail',
          intrinsicWidth: 1280,
          intrinsicHeight: 720,
          loading: 'eager',
          fetchPriority: 'high',
        }"
      />
      <cx-inline actions gap="lg" align="center">
        <cx-button
          text="Watch on YouTube"
          icon="play"
          href="https://www.youtube.com/watch?v=iG-Tg92NOH4"
        />
        <a routerLink="/">Read the stories</a>
      </cx-inline>
    </cx-hero>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VideosComponent {}
