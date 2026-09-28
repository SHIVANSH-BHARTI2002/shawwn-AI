import { JSDOM } from 'jsdom';

/**
 * Build a jsdom Document from an HTML string.
 * Returns { doc, win } with a stable URL so metadata/link resolution works.
 */
export function makeDoc(html, url = 'https://example.com/page') {
  const dom = new JSDOM(html, { url });
  return { doc: dom.window.document, win: dom.window };
}
