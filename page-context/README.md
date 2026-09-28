# PageContext

Extract the meaningful content of the webpage in your active browser tab and turn
it into clean **Markdown**, **plain text**, or **JSON** — ready to feed to an AI
agent, RAG pipeline, or LLM.

PageContext is a **Manifest V3** Chrome/Chromium extension. The core extraction
runs **entirely locally** in your browser. There is no backend, no API key, no
account, and no external service required.

---

## Features

- One-click extraction of the **currently rendered DOM** (works with SPAs and
  JavaScript-rendered pages, not just static HTML).
- Generic extraction — **no site-specific selectors**. Amazon, Wikipedia, MDN,
  news articles, docs, and plain HTML all work through the same engine.
- Metadata: title, URL, domain, language, description, canonical URL, author,
  published date.
- Structure-preserving conversion: headings, paragraphs, ordered/unordered
  lists, tables, blockquotes, code blocks, links, and image metadata.
- Three output formats with **instant switching** (no re-extraction needed).
- Copy to clipboard and download (`.md` / `.txt` / `.json`) with a safe filename
  derived from the page title.
- Conservative noise removal (nav, footer, sidebars, ads, cookie banners) that
  avoids deleting real content.
- Hidden-element filtering, open Shadow DOM traversal, and intelligent
  truncation at paragraph/sentence boundaries for very large pages.
- Configurable via an options page; latest extraction is remembered per page.

---

## Installation

1. Clone or download this repository.
2. Build the injected content bundle (one-time / after edits):
   ```bash
   npm install
   npm run build
   ```
3. Open `chrome://extensions`.
4. Enable **Developer mode** (top right).
5. Click **Load unpacked**.
6. Select the `page-context/` directory.

> The `npm run build` step bundles the content-script modules into
> `src/content/content.bundle.js`, which the extension injects on demand. This
> file is git-ignored and must be built before loading the extension.

---

## Usage

1. Open any webpage.
2. Click the **PageContext** toolbar icon.
3. Click **Extract Page**.
4. Choose an output format (Markdown / Plain Text / JSON).
5. **Copy** or **Download** the result.

Try the included `test-page.html` locally (open it with `file://`) to see a full
example with headings, lists, a table, code, a quote, links, and images.

---

## How it works (architecture)

```
Popup (popup.js)
    │  chrome.runtime.sendMessage(REQUEST_EXTRACTION)
    ▼
Service worker (service-worker.js)
    │  ensure content bundle injected → chrome.tabs.sendMessage(EXTRACT)
    ▼
Content script (content.js, bundled)
    │
    ▼
extractPage()                         (src/lib/extractor.js)
    ├── extractMetadata()             read <title>/<meta>/<link>
    ├── cleanDOM()                    clone DOM, drop hidden + noise (cleaner.js)
    ├── detectMainContent()           semantic tags → ARIA → heuristic scoring
    ├── extractHeadings/Paragraphs/Lists/Tables/Links/Images()
    ├── toMarkdown()                  structure-preserving MD (markdown.js)
    └── serialize()                   stable JSON payload
    ▼
Result JSON → popup renders (renderFormat) → copy / download
             → service worker stores latest in chrome.storage.local
```

### Source layout

| Path | Responsibility |
|---|---|
| `manifest.json` | MV3 manifest (least-privilege permissions) |
| `src/background/service-worker.js` | Tab detection, content-script injection, messaging, storage of last extraction |
| `src/content/content.js` | Content-script entry (bundled); wires messaging to the engine |
| `src/lib/extractor.js` | Orchestrator + metadata, main-content detection, structure extraction, serialization |
| `src/lib/cleaner.js` | Clones the DOM and removes hidden/noise elements (never mutates the live page) |
| `src/lib/markdown.js` | HTML → Markdown, including tables |
| `src/lib/dom.js` | Visibility detection + Shadow DOM traversal |
| `src/lib/format.js` | Renders a payload into Markdown/Text/JSON; file extension + MIME helpers |
| `src/utils/constants.js` | Configuration constants and defaults |
| `src/utils/helpers.js` | Pure string/URL helpers (whitespace, counts, slug, truncation) |
| `src/popup/*` | Popup UI (extract, format switch, copy, download) |
| `src/options/*` | Settings page persisted to `chrome.storage.local` |
| `src/content/{extractor,cleaner,markdown,serializer}.js` | Thin re-export shims matching the documented layout; single source of truth lives in `src/lib/` |
| `scripts/build.js` | esbuild bundler for the content script |
| `tests/*` | Vitest + jsdom tests and an HTML fixture |

**Design note:** the extraction engine lives in `src/lib/` as pure ES modules so
it can be unit-tested with jsdom and reused. Content scripts cannot use ES module
`import` directly, so `content.js` is bundled into a single classic IIFE
(`content.bundle.js`) via esbuild. This keeps one source of truth while producing
a loadable extension.

---

## Output shape

```json
{
  "page": {
    "title": "...",
    "url": "...",
    "domain": "...",
    "language": "en",
    "description": "...",
    "canonicalUrl": "...",
    "author": "...",
    "publishedDate": "..."
  },
  "content": {
    "markdown": "# ...",
    "text": "...",
    "wordCount": 1200,
    "characterCount": 7200
  },
  "structure": {
    "headings": [{ "level": 1, "text": "..." }],
    "paragraphs": ["..."],
    "lists": [{ "ordered": false, "items": ["..."] }],
    "tables": [{ "headers": ["..."], "rows": [["..."]], "markdown": "| ... |" }],
    "links": [{ "text": "...", "url": "..." }],
    "images": [{ "alt": "...", "src": "...", "title": "..." }]
  },
  "metadata": {
    "extractedAt": "ISO_TIMESTAMP",
    "truncated": false,
    "maxContentLength": 100000
  }
}
```

This object is intentionally stable so it can later become the request payload
for a RAG backend (FastAPI → chunker → embeddings → vector DB → retriever → LLM).
The extension itself only does high-quality page-context extraction.

---

## Development

```bash
npm install          # install dev dependencies (esbuild, vitest, jsdom)
npm run build        # bundle content script → src/content/content.bundle.js
npm run build:watch  # rebuild on change
npm test             # run the test suite once
npm run test:watch   # watch mode
```

After changing anything under `src/content/` or `src/lib/`, run `npm run build`
and reload the extension in `chrome://extensions`.

---

## Testing

Tests use **Vitest** with a **jsdom** environment and cover the extraction logic:

- Helpers (whitespace, counts, domain, URL resolution, slug, truncation).
- Markdown conversion (headings, lists, emphasis, links, quotes, code, tables).
- Full extraction against an HTML fixture: metadata, cleaning, main-content
  detection, structured output, hidden/noise exclusion, links, images.
- Edge cases: empty body, malformed HTML, navigation-only page, very large page
  (truncation).

Run them with:

```bash
npm test
```

---

## Privacy

PageContext processes page content locally in the browser.

The extension does not automatically upload extracted page content to a server.

No browsing history is collected.

No cookies or authentication credentials are collected.

No page data is transmitted externally by the core extension.

Permissions requested are minimal: `activeTab`, `scripting`, and `storage`. The
content script is injected only when you click **Extract Page**, and only into
the active tab.

---

## Known limitations

- **Build step required:** the content bundle must be built (`npm run build`)
  before loading; it is not committed.
- **Cross-origin iframes** cannot be read (browser security). Only same-origin
  iframe content that the browser exposes is available.
- **Closed Shadow DOM** is inaccessible by design and is skipped. Open shadow
  roots are traversed.
- **No auto-scroll:** only the currently loaded DOM is extracted. Infinite-scroll
  content below the loaded region is not fetched (the engine is structured to add
  an "extract + scroll" mode later).
- **Restricted pages** (`chrome://`, `chrome-extension://`, the Chrome Web Store,
  and other browser-internal pages) cannot run content scripts; the popup shows a
  clear message instead of failing.
- **Heuristic extraction** is generic and tuned to be conservative. On unusual
  layouts it may include some peripheral text or miss a fragment; it never
  guarantees a perfect reading-mode result.
- **Truncation** applies per format at the configured maximum content length
  (default 100,000 characters), cutting at a paragraph/sentence/word boundary.

---

## License

MIT
