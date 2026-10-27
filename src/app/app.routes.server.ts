import { RenderMode, ServerRoute } from '@angular/ssr';

/** The web server redirects the former index; content pages remain prerendered. */
export const serverRoutes: ServerRoute[] = [
  { path: 'blog', renderMode: RenderMode.Client },
  { path: '**', renderMode: RenderMode.Prerender },
];
