// Public brochure site & app shell (decision #12): each group's root is a
// server-rendered public brochure and the member app under /app/ shares the
// same shell chrome. CMS pages (decision #13) render here — markdown source
// through renderMarkdown, visibility-tiered, with a `home` page overriding
// the placeholder front page. Tenancy comes from the Host header exactly as
// for the API; the session cookie makes the shell header session-aware.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Storage } from '../storage/interface.js';
import type { Group, Listing, Member, NewsItem, Page } from '../types.js';
import { authenticate } from '../services/auth.js';
import { listingPhotoIds } from '../services/images.js';
import { browse } from '../services/marketplace.js';
import { renderMarkdown } from '../services/markdown.js';

/** Session cookie name, shared with the API routes in app.ts. */
export const SESSION_COOKIE = 'silvio_session';

/** Escape user content for interpolation into HTML text or attributes. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Progressive chrome (decision #12): full nav in a browser, hidden entirely
// in the installed PWA via the display-mode media query. The same style block
// serves brochure pages and the injected app shell.
const SHELL_STYLE = `<style>
  body { margin: 0; font-family: system-ui, sans-serif; line-height: 1.5; color: #1a1a1a; }
  .shell-chrome { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem 1.5rem;
    padding: 0.75rem 1.25rem; border-bottom: 1px solid #ddd; background: #f6f6f2; }
  .shell-chrome .shell-brand { font-size: 1.25rem; font-weight: 700; color: inherit;
    text-decoration: none; margin-right: auto; }
  .shell-chrome nav { display: flex; flex-wrap: wrap; gap: 1rem; }
  .shell-chrome a { color: #205a3b; }
  .brochure-main { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1.25rem; }
  .brochure-main article { border-bottom: 1px solid #eee; padding: 0.75rem 0; }
  .brochure-main .category { color: #555; font-size: 0.9rem; margin: 0.25rem 0; }
  .brochure-main .photos img { max-height: 6rem; max-width: 100%; border-radius: 0.25rem; }
  .brochure-footer { max-width: 46rem; margin: 0 auto; padding: 1rem 1.25rem;
    color: #777; font-size: 0.85rem; }
  @media (display-mode: standalone) {
    .shell-chrome { display: none; }
  }
</style>`;

/** What the shell nav needs of a CMS page (#13). */
export interface NavPage {
  slug: string;
  title: string;
}

/** Shell header: group brand, public nav with CMS pages, the session corner. */
function shellHeader(
  groupName: string,
  memberName: string | undefined,
  navPages: NavPage[],
): string {
  // Per-group skin placeholder: brand is the group name; logo and header
  // image arrive with group.branding (decision #12).
  const session = memberName === undefined
    ? '<a href="/app/login">Log in</a>'
    : `<span>${escapeHtml(memberName)}</span> <a href="/app/">Open the app</a>`;
  // CMS pages the viewer may see, between Home and News/Market (#13).
  const pageLinks = navPages
    .map((page) => `<a href="/p/${page.slug}">${escapeHtml(page.title)}</a>\n    `)
    .join('');
  return `<header class="shell-chrome">
  <a class="shell-brand" href="/">${escapeHtml(groupName)}</a>
  <nav>
    <a href="/">Home</a>
    ${pageLinks}<a href="/news">News</a>
    <a href="/market">Market</a>
    ${session}
  </nav>
</header>`;
}

/**
 * Shell fragment injected after <body> of the member app's index.html: the
 * chrome style plus the header, so app routes render inside the same shell
 * as brochure pages (decision #12).
 */
export function appShellFragment(
  groupName: string,
  memberName: string | undefined,
  navPages: NavPage[] = [],
): string {
  return `${SHELL_STYLE}\n${shellHeader(groupName, memberName, navPages)}`;
}

/** A full brochure page in the shared layout. */
function renderPage(
  group: Group,
  memberName: string | undefined,
  navPages: NavPage[],
  title: string,
  main: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${SHELL_STYLE}
</head>
<body>
${shellHeader(group.name, memberName, navPages)}
<main class="brochure-main">
${main}
</main>
<footer class="brochure-footer">
<p>${escapeHtml(group.name)} runs on Silvio, community exchange software.</p>
</footer>
</body>
</html>`;
}

/** Minimal 404 page for hosts that resolve to no group. */
const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Not found</title></head>
<body><h1>Not found</h1><p>No group is served at this address.</p></body>
</html>`;

/** Placeholder brochure home, shown until an admin authors a `home` page (#13). */
function renderHome(group: Group, memberName: string | undefined, navPages: NavPage[]): string {
  const name = escapeHtml(group.name);
  return renderPage(group, memberName, navPages, group.name, `<h1>Welcome to ${name}</h1>
<p>${name} is a local exchange trading system (LETS): a community of
neighbours who trade skills, goods and time with each other using our own
community currency instead of money.</p>
<p>Browse the <a href="/market">market</a> to see what members are offering
and looking for right now.</p>
<p><a href="/app/apply">Join ${name}</a> to start trading.</p>`);
}

/** One listing, escaped, with its category — never member contact details. */
function renderListing(
  listing: Listing,
  categoryNames: Map<string, string>,
  photoIds: string[],
): string {
  const category = categoryNames.get(listing.categoryId);
  const categoryLine = category === undefined
    ? ''
    : `\n<p class="category">${escapeHtml(category)}</p>`;
  // Listing photos (#14 phase 3): thumbnails by opaque id. alt is empty —
  // the title just above already names what the photos show.
  const photoLine = photoIds.length === 0
    ? ''
    : `\n<p class="photos">${photoIds
        .map((id) => `<img src="/i/${id}" alt="" loading="lazy">`)
        .join(' ')}</p>`;
  return `<article>
<h3>${escapeHtml(listing.title)}</h3>${categoryLine}
<p>${escapeHtml(listing.description)}</p>${photoLine}
</article>`;
}

/** Public read-only market browse: active listings as offers and wants. */
function renderMarket(
  group: Group,
  memberName: string | undefined,
  navPages: NavPage[],
  listings: Listing[],
  categoryNames: Map<string, string>,
  photosByListing: Map<string, string[]>,
): string {
  const section = (heading: string, items: Listing[]): string => {
    const bodyHtml = items.length === 0
      ? '<p>Nothing here yet.</p>'
      : items
          .map((listing) =>
            renderListing(listing, categoryNames, photosByListing.get(listing.id) ?? []),
          )
          .join('\n');
    return `<section>\n<h2>${heading}</h2>\n${bodyHtml}\n</section>`;
  };
  const offers = listings.filter((listing) => listing.type === 'offer');
  const wants = listings.filter((listing) => listing.type === 'want');
  return renderPage(group, memberName, navPages, `Market — ${group.name}`, `<h1>Market</h1>
<p>What members of ${escapeHtml(group.name)} are offering and looking for.
<a href="/app/apply">Join</a> to get in touch and trade.</p>
${section('Offers', offers)}
${section('Wants', wants)}`);
}

/** One news item (#13): escaped title, dated, markdown body rendered. */
function renderNewsItem(item: NewsItem): string {
  // publishedAt is ISO 8601; the date part alone reads fine on a noticeboard.
  const date = item.publishedAt.slice(0, 10);
  return `<article>
<h2>${escapeHtml(item.title)}</h2>
<p class="category">${escapeHtml(date)}</p>
${renderMarkdown(item.body)}
</article>`;
}

/** The community noticeboard (#13): current news only, newest first. */
function renderNews(
  group: Group,
  memberName: string | undefined,
  navPages: NavPage[],
  items: NewsItem[],
): string {
  const articles = items.length === 0
    ? '<p>No news right now.</p>'
    : items.map((item) => renderNewsItem(item)).join('\n');
  return renderPage(group, memberName, navPages, `News — ${group.name}`, `<h1>News</h1>
${articles}`);
}

/** Host header -> group, exactly as the API's tenancy resolution (port stripped). */
export async function resolveGroupFromHost(
  storage: Storage,
  request: FastifyRequest,
): Promise<Group | undefined> {
  const hostname = (request.headers.host ?? '').split(':')[0] ?? '';
  return storage.groupByDomain(hostname);
}

/**
 * The session cookie's member for this group, or undefined — an invalid,
 * expired or foreign-group cookie never throws, it just renders the
 * logged-out header. The member (not just the name) drives page visibility
 * tiers (#13): role 'admin' unlocks admin-visibility pages.
 */
export async function sessionMember(
  storage: Storage,
  request: FastifyRequest,
  groupId: string,
): Promise<Member | undefined> {
  const token = request.cookies[SESSION_COOKIE];
  if (token === undefined) return undefined;
  try {
    const context = await authenticate(storage, token);
    const member = context?.member;
    return member !== undefined && member.groupId === groupId ? member : undefined;
  } catch {
    return undefined;
  }
}

/** Visibility tiers (#13): public for all, members with a session, admin by role. */
function canSee(page: Page, member: Member | undefined): boolean {
  if (page.visibility === 'public') return true;
  if (page.visibility === 'members') return member !== undefined;
  return member?.role === 'admin';
}

/**
 * CMS pages for the shell nav: what this viewer may see, in storage order
 * (position then slug). `home` is excluded — it is served at / itself (#13).
 */
export async function navPagesFor(
  storage: Storage,
  groupId: string,
  member: Member | undefined,
): Promise<NavPage[]> {
  const pages = await storage.listPages(groupId);
  return pages
    .filter((page) => page.slug !== 'home' && canSee(page, member))
    .map((page) => ({ slug: page.slug, title: page.title }));
}

/** Register the server-rendered brochure routes (decision #12) at the root. */
export function registerBrochureRoutes(app: FastifyInstance, storage: Storage): void {
  const htmlType = 'text/html; charset=utf-8';
  // HTML pages, not API operations: keep them out of the OpenAPI document.
  const hidden = { schema: { hide: true } } as const;

  app.get('/', hidden, async (request, reply) => {
    const group = await resolveGroupFromHost(storage, request);
    if (group === undefined) return reply.status(404).type(htmlType).send(NOT_FOUND_PAGE);
    const member = await sessionMember(storage, request, group.id);
    const navPages = await navPagesFor(storage, group.id, member);
    // Home override (#13): a page with slug `home` replaces the placeholder
    // copy. It renders whatever its visibility field says — putting it at
    // `home` is the admin's explicit choice of front page, and a front page
    // that 404s for visitors helps nobody.
    const home = await storage.pageBySlug(group.id, 'home');
    const html = home === undefined
      ? renderHome(group, member?.displayName, navPages)
      : renderPage(group, member?.displayName, navPages, home.title, renderMarkdown(home.body));
    return reply.type(htmlType).send(html);
  });

  // CMS pages (#13): markdown body rendered server-side into the shell. A
  // page the viewer may not see 404s exactly like a missing one — visibility
  // hides existence, not just content.
  app.get('/p/:slug', hidden, async (request, reply) => {
    const group = await resolveGroupFromHost(storage, request);
    if (group === undefined) return reply.status(404).type(htmlType).send(NOT_FOUND_PAGE);
    const member = await sessionMember(storage, request, group.id);
    const { slug } = request.params as { slug: string };
    const page = await storage.pageBySlug(group.id, slug);
    if (page === undefined || !canSee(page, member)) {
      return reply.status(404).type(htmlType).send(NOT_FOUND_PAGE);
    }
    const navPages = await navPagesFor(storage, group.id, member);
    // The <h1> comes from the markdown itself; page.title only names the tab.
    return reply
      .type(htmlType)
      .send(renderPage(group, member?.displayName, navPages, page.title, renderMarkdown(page.body)));
  });

  // News (#13): the public noticeboard — items published by now and not yet
  // expired; scheduled and expired ones exist only in the admin area.
  app.get('/news', hidden, async (request, reply) => {
    const group = await resolveGroupFromHost(storage, request);
    if (group === undefined) return reply.status(404).type(htmlType).send(NOT_FOUND_PAGE);
    const member = await sessionMember(storage, request, group.id);
    const navPages = await navPagesFor(storage, group.id, member);
    const items = await storage.listNews(group.id, { currentAt: new Date().toISOString() });
    return reply
      .type(htmlType)
      .send(renderNews(group, member?.displayName, navPages, items));
  });

  // Image serving (decision #14): bytes by opaque id. No group or session
  // check — the unguessable UUID is the access control (CMS and listing
  // images are public-brochure content anyway). An id's content never
  // changes (re-upload mints a new id), hence the immutable cache header;
  // nosniff because the bytes are member-supplied.
  app.get('/i/:id', hidden, async (request, reply) => {
    const { id } = request.params as { id: string };
    const image = await storage.getImage(id).catch(() => undefined);
    if (image === undefined) {
      return reply.status(404).type(htmlType).send(NOT_FOUND_PAGE);
    }
    return reply
      .type(image.mime)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(await storage.imageData(id));
  });

  app.get('/market', hidden, async (request, reply) => {
    const group = await resolveGroupFromHost(storage, request);
    if (group === undefined) return reply.status(404).type(htmlType).send(NOT_FOUND_PAGE);
    const member = await sessionMember(storage, request, group.id);
    const navPages = await navPagesFor(storage, group.id, member);
    const listings = await browse(storage, group.id, {});
    const categories = await storage.listCategories(group.id);
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
    // Listing photos (#14 phase 3): one group-wide query, keyed by listing.
    const photosByListing = await listingPhotoIds(storage, group.id);
    return reply
      .type(htmlType)
      .send(
        renderMarket(group, member?.displayName, navPages, listings, categoryNames, photosByListing),
      );
  });
}
