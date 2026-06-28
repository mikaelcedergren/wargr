import { DOCUMENT } from '@angular/common';
import { Inject, Injectable } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

export const SITE_ORIGIN = 'https://wargr.com';
export const SITE_NAME = 'Wargr';
export const AUTHOR = 'Michael Wargr';

/** Per-page SEO, carried on each route's `data.seo`. */
export interface PageSeo {
  /** Canonical path, e.g. '/' or '/corruption/'. */
  path: string;
  description: string;
  keywords?: string;
  ogTitle?: string;
  ogDescription?: string;
  /** Absolute image URL; only emitted if provided (no default — essays have no thumbnail asset yet). */
  ogImage?: string;
  /** og:type — 'website' (default) or 'article'. */
  ogType?: string;
  noindex?: boolean;
  /** Extra JSON-LD @graph nodes (e.g. a BlogPosting) appended after Person/WebSite/WebPage. */
  graph?: object[];
}

/**
 * Sets title + per-route description, canonical, Open Graph, Twitter and JSON-LD @graph on every
 * navigation. Runs during prerendering too, so each static page ships with its own metadata.
 */
@Injectable()
export class SeoTitleStrategy extends TitleStrategy {
  constructor(
    private readonly titleService: Title,
    private readonly meta: Meta,
    @Inject(DOCUMENT) private readonly document: Document,
  ) {
    super();
  }

  override updateTitle(snapshot: RouterStateSnapshot): void {
    let route = snapshot.root;
    while (route.firstChild) route = route.firstChild;

    const seo = (route.data['seo'] as PageSeo | undefined) ?? { path: '/', description: '' };
    const title = this.buildTitle(snapshot) ?? SITE_NAME;
    const canonical = SITE_ORIGIN + seo.path;
    const ogTitle = seo.ogTitle ?? title;
    const ogDescription = seo.ogDescription ?? seo.description;

    this.document.documentElement.setAttribute('lang', 'en');
    this.titleService.setTitle(title);
    this.meta.updateTag({ name: 'description', content: seo.description });
    if (seo.keywords) {
      this.meta.updateTag({ name: 'keywords', content: seo.keywords });
    }
    if (seo.noindex) {
      this.meta.updateTag({ name: 'robots', content: 'noindex, follow' });
    } else {
      this.meta.removeTag("name='robots'");
    }

    this.meta.updateTag({ property: 'og:type', content: seo.ogType ?? 'website' });
    this.meta.updateTag({ property: 'og:url', content: canonical });
    this.meta.updateTag({ property: 'og:site_name', content: SITE_NAME });
    this.meta.updateTag({ property: 'og:locale', content: 'en_US' });
    this.meta.updateTag({ property: 'og:title', content: ogTitle });
    this.meta.updateTag({ property: 'og:description', content: ogDescription });
    if (seo.ogImage) {
      this.meta.updateTag({ property: 'og:image', content: seo.ogImage });
      this.meta.updateTag({ name: 'twitter:image', content: seo.ogImage });
      this.meta.updateTag({ name: 'twitter:card', content: 'summary_large_image' });
    } else {
      this.meta.updateTag({ name: 'twitter:card', content: 'summary' });
    }

    this.meta.updateTag({ name: 'twitter:title', content: ogTitle });
    this.meta.updateTag({ name: 'twitter:description', content: ogDescription });

    this.setCanonical(canonical);
    this.setJsonLd(this.buildGraph(canonical, title, seo, snapshot));
  }

  private setCanonical(url: string): void {
    const head = this.document.head;
    let link = head.querySelector("link[rel='canonical']") as HTMLLinkElement | null;
    if (!link) {
      link = this.document.createElement('link');
      link.setAttribute('rel', 'canonical');
      head.appendChild(link);
    }
    link.setAttribute('href', url);
  }

  private buildGraph(canonical: string, title: string, seo: PageSeo, _s: RouterStateSnapshot): object {
    const graph: object[] = [
      {
        '@type': 'Person',
        '@id': `${SITE_ORIGIN}/#person`,
        name: AUTHOR,
        url: `${SITE_ORIGIN}/`,
      },
      {
        '@type': 'Blog',
        '@id': `${SITE_ORIGIN}/#blog`,
        url: `${SITE_ORIGIN}/`,
        name: SITE_NAME,
        inLanguage: 'en-US',
        author: { '@id': `${SITE_ORIGIN}/#person` },
        publisher: { '@id': `${SITE_ORIGIN}/#person` },
      },
      {
        '@type': seo.ogType === 'article' ? 'BlogPosting' : 'WebPage',
        '@id': `${canonical}#webpage`,
        url: canonical,
        name: title,
        headline: title,
        description: seo.description,
        inLanguage: 'en-US',
        isPartOf: { '@id': `${SITE_ORIGIN}/#blog` },
        author: { '@id': `${SITE_ORIGIN}/#person` },
        publisher: { '@id': `${SITE_ORIGIN}/#person` },
      },
      ...(seo.graph ?? []),
    ];
    return { '@context': 'https://schema.org', '@graph': graph };
  }

  private setJsonLd(data: object | null): void {
    const id = 'wg-jsonld';
    let script = this.document.getElementById(id) as HTMLScriptElement | null;
    if (!data) {
      script?.remove();
      return;
    }
    if (!script) {
      script = this.document.createElement('script');
      script.id = id;
      script.setAttribute('type', 'application/ld+json');
      this.document.head.appendChild(script);
    }
    script.textContent = JSON.stringify(data);
  }
}
