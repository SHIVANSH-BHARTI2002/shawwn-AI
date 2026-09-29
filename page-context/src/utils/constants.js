/**
 * Shared configuration constants for PageContext.
 * Pure module: safe to import from content script, popup, options and tests.
 */

/** Output formats supported by the extension. */
export const FORMAT = Object.freeze({
  MARKDOWN: 'markdown',
  TEXT: 'text',
  JSON: 'json'
});

/** Maximum size of extracted content (characters) before truncation. */
export const MAX_CONTENT_LENGTH = 100000;

/** chrome.storage.local keys. */
export const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'pagecontext.settings',
  LAST_EXTRACTION: 'pagecontext.lastExtraction',
  SHAWWN_SETTINGS: 'shawwn.settings'
});

/** Default backend URL for the shawwn RAG API. Overridable in options. */
export const DEFAULT_BACKEND_URL = 'http://localhost:8000';

/** Default settings for the shawwn chat integration. */
export const DEFAULT_SHAWWN_SETTINGS = Object.freeze({
  backendUrl: DEFAULT_BACKEND_URL,
  apiToken: ''
});

/**
 * Default user settings. Mirrored by the options page.
 * These flags are passed to the extractor as its options object.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  removeNavigation: true,
  removeAdvertisements: true,
  removeFooter: true,
  removeSidebars: true,
  includeLinks: true,
  includeImages: true,
  includeMetadata: true,
  defaultFormat: FORMAT.MARKDOWN,
  maxContentLength: MAX_CONTENT_LENGTH,
  waitForPageMs: 0
});

/**
 * URL schemes / hosts where content scripts cannot run.
 * Used to give the user a clear message instead of failing silently.
 */
export const RESTRICTED_URL_PREFIXES = Object.freeze([
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'devtools://',
  'view-source:',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com'
]);

/** Tags that are never useful content and are always removed. */
export const ALWAYS_REMOVE_TAGS = Object.freeze([
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'canvas',
  'template',
  'link',
  'meta',
  'object',
  'embed'
]);

/**
 * Structural tags removed only when the corresponding setting is enabled.
 * Keyed by the setting flag that governs them.
 */
export const STRUCTURAL_REMOVE_TAGS = Object.freeze({
  removeNavigation: ['nav'],
  removeFooter: ['footer'],
  removeSidebars: ['aside']
});

/**
 * Semantic hints suggesting an element is UI noise rather than content.
 * These contribute to a removal *score*; elements are not removed on a single
 * match, to avoid deleting real content (e.g. an article *about* advertising).
 */
export const NOISE_HINTS = Object.freeze([
  'advertisement',
  'advert',
  'ads',
  'adslot',
  'banner',
  'cookie',
  'consent',
  'popup',
  'modal',
  'newsletter',
  'subscribe',
  'social',
  'share',
  'sharing',
  'sidebar',
  'navigation',
  'navbar',
  'menu',
  'breadcrumb',
  'recommend',
  'related',
  'promo',
  'sponsor',
  'skip-link',
  'pagination'
]);

/** Score at or above which an element is treated as noise and removed. */
export const NOISE_REMOVE_THRESHOLD = 2;

/** Tags that positively signal main content, with their weights. */
export const CONTENT_POSITIVE_TAGS = Object.freeze({
  p: 3,
  article: 5,
  main: 5,
  section: 1,
  h1: 3,
  h2: 2,
  h3: 2,
  li: 1,
  table: 3,
  pre: 3,
  blockquote: 2
});

/** Tags/roles that negatively signal main content. */
export const CONTENT_NEGATIVE_TAGS = Object.freeze([
  'nav',
  'footer',
  'header',
  'aside',
  'menu'
]);
