// CMS markdown pipeline (decision #13): markdown source in, safe HTML out.
// Deliberately minimal — default preset, no plugins, no linkify, no
// typographer. `html: false` escapes raw HTML and markdown-it's default
// link validator blocks javascript: destinations; that's the whole security
// story. The tests in test/services/markdown.test.ts pin these guarantees.

import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false });

// Image allowlist (decision #14, amending #13's blanket disable): only the
// local image store's /i/{uuid} URLs render as <img>. Everything else —
// external URLs included, permanently — degrades to the image's alt text,
// so nothing an author wrote is silently lost.
const LOCAL_IMAGE_SRC =
  /^\/i\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The stock rule renders the <img> tag (and fills in alt); keep it for
// allowed sources rather than rebuilding attribute handling here.
const renderImage = md.renderer.rules.image!;

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  if (LOCAL_IMAGE_SRC.test(token.attrGet('src') ?? '')) {
    return renderImage(tokens, idx, options, env, self);
  }
  // Refused source: render the children (the alt text) as plain inline
  // content — no <img>, but the words survive.
  return self.renderInline(token.children ?? [], options, env);
};

// Unsafe link schemes (javascript: etc) are left to markdown-it's default
// validator, which fails the link parse so the source renders as escaped
// literal text — ugly but inert. Deliberately no custom handling: upstream's
// guard is better tested than anything we would write (#13).

export function renderMarkdown(source: string): string {
  return md.render(source);
}
