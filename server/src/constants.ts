export const WARGR_PRODUCT_ID = 'wargr';

export const WARGR_PUBLIC_ORIGIN = 'https://wargr.com';
export const WARGR_WWW_ORIGIN = 'https://www.wargr.com';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol';

export const ADMIN_API_PATH = '/api/admin';
export const ADMIN_SESSION_COOKIE = 'wg_admin_session';
export const ADMIN_SESSION_APPLICATION_ID = 'wargr';
export const ADMIN_SESSION_SIGNING_KEY_ID = 'primary';
export const ADMIN_SESSION_DEFAULT_TTL_SECONDS = 8 * 60 * 60;
export const ADMIN_SESSION_MAXIMUM_TTL_SECONDS = 24 * 60 * 60;
// Story bodies are long-form markdown; the largest published stories are tens of kilobytes, so the
// budget leaves head-room for the complete structured record without admitting unbounded payloads.
export const ADMIN_REQUEST_BODY_LIMIT = '256kb';

export const ARTICLE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const PRIVATE_NOINDEX_PATHS = Object.freeze(['/admin', ADMIN_API_PATH]);
