export const WARGR_PRODUCT_ID = 'wargr';

export const WARGR_PUBLIC_ORIGIN = 'https://wargr.com';
export const WARGR_WWW_ORIGIN = 'https://www.wargr.com';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol';

export const STUDIO_API_PATH = '/api/studio';
export const STUDIO_SESSION_COOKIE = 'wg_studio_session';
export const STUDIO_SESSION_APPLICATION_ID = 'wargr';
export const STUDIO_SESSION_SIGNING_KEY_ID = 'primary';
export const STUDIO_SESSION_DEFAULT_TTL_SECONDS = 8 * 60 * 60;
export const STUDIO_SESSION_MAXIMUM_TTL_SECONDS = 24 * 60 * 60;
// Essay bodies are long-form markdown; the largest published essays are tens of kilobytes, so the
// budget leaves head-room for the complete structured record without admitting unbounded payloads.
export const STUDIO_REQUEST_BODY_LIMIT = '256kb';

export const ARTICLE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const PRIVATE_NOINDEX_PATHS = Object.freeze(['/studio', STUDIO_API_PATH]);
