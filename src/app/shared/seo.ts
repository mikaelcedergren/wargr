import { DOCUMENT } from '@angular/common';
import { Inject, Injectable } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

export const SITE_ORIGIN = 'https://wargr.com';
export const SITE_NAME = 'Wargr';
export const AUTHOR = 'Michael Wargr';
/** Default social-share card (the designed MW monogram card, 1200×630). Override via PageSeo.ogImage. */
export const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/assets/brand/og-default.jpg`;

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
  /** Article enrichment (set by the importer for essay routes). */
  datePublished?: string;
  wordCount?: number;
  /** Reading time in minutes → emitted as ISO-8601 duration timeRequired. */
  readingTime?: number;
  articleSection?: string;
  /** Slugs of related essays, turned into absolute relatedLink URLs in the BlogPosting graph. */
  relatedSlugs?: string[];
  /** Chronological neighbours → <link rel="prev"/"next"> for crawlers and browsers. */
  prevPath?: string;
  nextPath?: string;
  /** Home only: the essay index, emitted as a schema.org ItemList. */
  itemList?: { url: string; name: string }[];
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
    this.meta.updateTag({ name: 'author', content: AUTHOR });
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
    if (seo.ogType === 'article') {
      this.meta.updateTag({ property: 'article:author', content: AUTHOR });
      if (seo.datePublished) {
        this.meta.updateTag({ property: 'article:published_time', content: seo.datePublished });
      }
      if (seo.articleSection) {
        this.meta.updateTag({ property: 'article:section', content: seo.articleSection });
      }
    } else {
      this.meta.removeTag("property='article:published_time'");
      this.meta.removeTag("property='article:section'");
      this.meta.removeTag("property='article:author'");
    }
    // Every share card in this project — the default brand card and the per-essay cards — is a
    // 1200×630 JPEG, so the dimensions/type can be declared statically (lets scrapers skip a fetch).
    const ogImage = seo.ogImage ?? DEFAULT_OG_IMAGE;
    this.meta.updateTag({ property: 'og:image', content: ogImage });
    this.meta.updateTag({ property: 'og:image:type', content: 'image/jpeg' });
    this.meta.updateTag({ property: 'og:image:width', content: '1200' });
    this.meta.updateTag({ property: 'og:image:height', content: '630' });
    this.meta.updateTag({ property: 'og:image:alt', content: `${SITE_NAME} — ${AUTHOR}` });
    this.meta.updateTag({ name: 'twitter:image', content: ogImage });
    this.meta.updateTag({ name: 'twitter:card', content: 'summary_large_image' });

    this.meta.updateTag({ name: 'twitter:title', content: ogTitle });
    this.meta.updateTag({ name: 'twitter:description', content: ogDescription });

    this.setCanonical(canonical);
    this.setRelLink('prev', seo.prevPath ? SITE_ORIGIN + seo.prevPath : null);
    this.setRelLink('next', seo.nextPath ? SITE_ORIGIN + seo.nextPath : null);
    this.setJsonLd(this.buildGraph(canonical, title, seo));
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

  /** Manage a single <link rel="prev"|"next">: create, update, or remove as routes change. */
  private setRelLink(rel: 'prev' | 'next', url: string | null): void {
    const head = this.document.head;
    let link = head.querySelector(`link[rel='${rel}']`) as HTMLLinkElement | null;
    if (!url) {
      link?.remove();
      return;
    }
    if (!link) {
      link = this.document.createElement('link');
      link.setAttribute('rel', rel);
      head.appendChild(link);
    }
    link.setAttribute('href', url);
  }

  private buildGraph(canonical: string, title: string, seo: PageSeo): object {
    const isArticle = seo.ogType === 'article';
    const webpage: Record<string, unknown> = {
      '@type': isArticle ? 'BlogPosting' : 'WebPage',
      '@id': `${canonical}#webpage`,
      url: canonical,
      name: title,
      headline: title,
      description: seo.description,
      inLanguage: 'en-US',
      isPartOf: { '@id': `${SITE_ORIGIN}/#blog` },
      author: { '@id': `${SITE_ORIGIN}/#person` },
      publisher: { '@id': `${SITE_ORIGIN}/#person` },
      mainEntityOfPage: canonical,
      image: seo.ogImage ?? DEFAULT_OG_IMAGE,
    };

    if (isArticle) {
      if (seo.datePublished) {
        webpage['datePublished'] = seo.datePublished;
        webpage['dateModified'] = seo.datePublished;
      }
      if (seo.wordCount) webpage['wordCount'] = seo.wordCount;
      if (seo.readingTime) webpage['timeRequired'] = `PT${seo.readingTime}M`;
      if (seo.articleSection) webpage['articleSection'] = seo.articleSection;
      if (seo.keywords) webpage['keywords'] = seo.keywords;
      if (seo.relatedSlugs?.length) {
        webpage['relatedLink'] = seo.relatedSlugs.map((s) => `${SITE_ORIGIN}/${s}/`);
      }
    }

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
      webpage,
    ];

    if (isArticle) {
      graph.push({
        '@type': 'BreadcrumbList',
        '@id': `${canonical}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Essays', item: `${SITE_ORIGIN}/` },
          { '@type': 'ListItem', position: 2, name: title, item: canonical },
        ],
      });
    }

    if (seo.itemList?.length) {
      graph.push({
        '@type': 'ItemList',
        '@id': `${SITE_ORIGIN}/#essays`,
        name: 'Essays',
        itemListElement: seo.itemList.map((it, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: it.url,
          name: it.name,
        })),
      });
    }

    return { '@context': 'https://schema.org', '@graph': [...graph, ...(seo.graph ?? [])] };
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
