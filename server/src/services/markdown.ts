// CMS markdown pipeline (decision #13): markdown source in, safe HTML out.
// Deliberately minimal — default preset, no plugins, no linkify, no
// typographer. `html: false` escapes raw HTML and markdown-it's default
// link validator blocks javascript: destinations; that's the whole security
// story. The tests in test/services/markdown.test.ts pin these guarantees.

import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false });

// Images are off until a group image store exists (#13). With the rule
// disabled, ![alt](url) degrades to "!" plus a rendered link — the alt text
// survives and no <img> is ever emitted, which is acceptable for now.
md.disable('image');

// Unsafe link schemes (javascript: etc) are left to markdown-it's default
// validator, which fails the link parse so the source renders as escaped
// literal text — ugly but inert. Deliberately no custom handling: upstream's
// guard is better tested than anything we would write (#13).

export function renderMarkdown(source: string): string {
  return md.render(source);
}
