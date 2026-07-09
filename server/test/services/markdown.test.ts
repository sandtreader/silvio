// CMS markdown pipeline (decision #13): markdown source in, safe HTML out.
// These tests pin the safety guarantees — raw HTML escaped, javascript:
// links rejected, image syntax disabled — which must never regress when the
// renderer is later reconfigured.

import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../src/services/markdown.js';

describe('renderMarkdown (#13)', () => {
  it('renders basic constructs', () => {
    const html = renderMarkdown(
      '# Agreement\n\nSome *emphasis* and a [link](https://example.com/).\n\n- one\n- two\n',
    );
    expect(html).toContain('<h1>Agreement</h1>');
    expect(html).toContain('<em>emphasis</em>');
    expect(html).toContain('<a href="https://example.com/">link</a>');
    expect(html).toContain('<li>one</li>');
  });

  it('escapes raw HTML blocks instead of passing them through', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes inline raw HTML', () => {
    const html = renderMarkdown('hello <b onclick="x()">bold</b> world');
    expect(html).not.toContain('<b');
    expect(html).toContain('&lt;b');
  });

  it('rejects javascript: link destinations (no link is produced at all)', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href');
    // Stock markdown-it behaviour: the failed link renders as escaped
    // literal text — ugly but inert, and preferable to custom validation
    // code in the security path (#13: safe unconfigured).
    expect(html).toContain('[click me]');
  });

  it('never produces an img tag (image syntax disabled until the group image store)', () => {
    const html = renderMarkdown('![kittens](https://example.com/tracking.png)');
    expect(html).not.toContain('<img');
    // The alt text is not silently lost.
    expect(html).toContain('kittens');
  });

  it('empty and whitespace-only input renders to empty output', () => {
    expect(renderMarkdown('').trim()).toBe('');
    expect(renderMarkdown('   \n \n').trim()).toBe('');
  });
});
