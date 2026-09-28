/**
 * Render a stored extraction payload into a chosen output format.
 * Shared by the popup (display, copy, download) so format switching never
 * requires re-extracting the page.
 */

import { FORMAT } from '../utils/constants.js';

/** Return the string representation of `result` for the given format. */
export function renderFormat(result, format) {
  if (!result) return '';
  switch (format) {
    case FORMAT.TEXT:
      return result.content.text || '';
    case FORMAT.JSON:
      return JSON.stringify(result, null, 2);
    case FORMAT.MARKDOWN:
    default:
      return result.content.markdown || '';
  }
}

/** File extension for a format. */
export function extensionFor(format) {
  switch (format) {
    case FORMAT.TEXT:
      return 'txt';
    case FORMAT.JSON:
      return 'json';
    case FORMAT.MARKDOWN:
    default:
      return 'md';
  }
}

/** MIME type for a format (used for Blob downloads). */
export function mimeFor(format) {
  switch (format) {
    case FORMAT.JSON:
      return 'application/json';
    case FORMAT.TEXT:
      return 'text/plain';
    case FORMAT.MARKDOWN:
    default:
      return 'text/markdown';
  }
}
