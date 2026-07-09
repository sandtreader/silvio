// Live-preview markdown renderer for the CMS editors (decision #13).
//
// MUST stay in lockstep with server/src/services/markdown.ts — same options,
// same disabled rules — so the preview an admin sees is exactly what the
// brochure will render. Deliberately minimal: `html: false` escapes raw HTML
// in the source (the output can only contain markup generated from markdown
// constructs), markdown-it's default link validator blocks javascript:
// destinations, and the image rule is disabled until a group image store
// exists.

import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false });

md.disable('image');

export function renderMarkdown(source: string): string {
  return md.render(source);
}
