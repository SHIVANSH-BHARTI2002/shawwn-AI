import { describe, it, expect } from 'vitest';
import { makeDoc } from './helpers.js';
import { toMarkdown, tableToMarkdown, tableToModel } from '../src/lib/markdown.js';

function body(html) {
  const { doc } = makeDoc(`<body>${html}</body>`);
  return doc.body;
}

describe('markdown conversion', () => {
  it('converts headings', () => {
    const md = toMarkdown(body('<h1>Title</h1><h2>Sub</h2><h3>Deep</h3>'));
    expect(md).toContain('# Title');
    expect(md).toContain('## Sub');
    expect(md).toContain('### Deep');
  });

  it('converts unordered lists', () => {
    const md = toMarkdown(body('<ul><li>One</li><li>Two</li></ul>'));
    expect(md).toContain('- One');
    expect(md).toContain('- Two');
  });

  it('converts ordered lists', () => {
    const md = toMarkdown(body('<ol><li>First</li><li>Second</li></ol>'));
    expect(md).toContain('1. First');
    expect(md).toContain('2. Second');
  });

  it('converts inline emphasis and code', () => {
    const md = toMarkdown(body('<p>a <strong>b</strong> <em>c</em> <code>d</code></p>'));
    expect(md).toContain('**b**');
    expect(md).toContain('*c*');
    expect(md).toContain('`d`');
  });

  it('converts links with resolved urls', () => {
    const md = toMarkdown(body('<p><a href="/x">link</a></p>'), { baseUrl: 'https://s.com' });
    expect(md).toContain('[link](https://s.com/x)');
  });

  it('omits links when includeLinks is false', () => {
    const md = toMarkdown(body('<p><a href="/x">link</a></p>'), { includeLinks: false });
    expect(md).toContain('link');
    expect(md).not.toContain('](');
  });

  it('converts blockquotes', () => {
    const md = toMarkdown(body('<blockquote>quoted</blockquote>'));
    expect(md).toContain('> quoted');
  });

  it('converts code blocks with language', () => {
    const md = toMarkdown(body('<pre><code class="language-js">const x=1;</code></pre>'));
    expect(md).toContain('```js');
    expect(md).toContain('const x=1;');
  });

  it('builds a markdown table', () => {
    const md = tableToMarkdown(
      body('<table><thead><tr><th>K</th><th>V</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>').querySelector('table')
    );
    expect(md).toContain('| K | V |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| a | b |');
  });

  it('models a table into headers/rows', () => {
    const model = tableToModel(
      body('<table><tr><th>Spec</th><th>Val</th></tr><tr><td>Brand</td><td>Sony</td></tr></table>').querySelector('table')
    );
    expect(model.headers).toEqual(['Spec', 'Val']);
    expect(model.rows).toEqual([['Brand', 'Sony']]);
  });

  it('escapes pipes in table cells', () => {
    const md = tableToMarkdown(
      body('<table><tr><th>A</th></tr><tr><td>x|y</td></tr></table>').querySelector('table')
    );
    expect(md).toContain('x\\|y');
  });
});
