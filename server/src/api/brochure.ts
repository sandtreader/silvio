// Public brochure site & app shell (decision #12): each group's root is a
// server-rendered public brochure — placeholder content until the CMS lands —
// and the member app under /app/ shares the same shell chrome. Tenancy comes
// from the Host header exactly as for the API; the session cookie makes the
// shell header session-aware.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Storage } from '../storage/interface.js';
import type { Group, Listing } from '../types.js';
import { authenticate } from '../services/auth.js';
import { browse } from '../services/marketplace.js';

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
  .brochure-footer { max-width: 46rem; margin: 0 auto; padding: 1rem 1.25rem;
    color: #777; font-size: 0.85rem; }
  @media (display-mode: standalone) {
    .shell-chrome { display: none; }
  }
</style>`;

/** Shell header: group brand, public nav, and the session corner. */
function shellHeader(groupName: string, memberName: string | undefined): string {
  // Per-group skin placeholder: brand is the group name; logo and header
  // image arrive with group.branding (decision #12).
  const session = memberName === undefined
    ? '<a href="/app/login">Log in</a>'
    : `<span>${escapeHtml(memberName)}</span> <a href="/app/">Open the app</a>`;
  return `<header class="shell-chrome">
  <a class="shell-brand" href="/">${escapeHtml(groupName)}</a>
  <nav>
    <a href="/">Home</a>
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
export function appShellFragment(groupName: string, memberName: string | undefined): string {
  return `${SHELL_STYLE}\n${shellHeader(groupName, memberName)}`;
}

/** A full brochure page in the shared layout. */
function renderPage(
  group: Group,
  memberName: string | undefined,
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
${shellHeader(group.name, memberName)}
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

/** Placeholder brochure home until the CMS (page, news_item) lands. */
function renderHome(group: Group, memberName: string | undefined): string {
  const name = escapeHtml(group.name);
  return renderPage(group, memberName, group.name, `<h1>Welcome to ${name}</h1>
<p>${name} is a local exchange trading system (LETS): a community of
neighbours who trade skills, goods and time with each other using our own
community currency instead of money.</p>
<p>Browse the <a href="/market">market</a> to see what members are offering
and looking for right now.</p>
<p><a href="/app/apply">Join ${name}</a> to start trading.</p>`);
}

/** One listing, escaped, with its category — never member contact details. */
function renderListing(listing: Listing, categoryNames: Map<string, string>): string {
  const category = categoryNames.get(listing.categoryId);
  const categoryLine = category === undefined
    ? ''
    : `\n<p class="category">${escapeHtml(category)}</p>`;
  return `<article>
<h3>${escapeHtml(listing.title)}</h3>${categoryLine}
<p>${escapeHtml(listing.description)}</p>
</article>`;
}

/** Public read-only market browse: active listings as offers and wants. */
function renderMarket(
  group: Group,
  memberName: string | undefined,
  listings: Listing[],
  categoryNames: Map<string, string>,
): string {
  const section = (heading: string, items: Listing[]): string => {
    const bodyHtml = items.length === 0
      ? '<p>Nothing here yet.</p>'
      : items.map((listing) => renderListing(listing, categoryNames)).join('\n');
    return `<section>\n<h2>${heading}</h2>\n${bodyHtml}\n</section>`;
  };
  const offers = listings.filter((listing) => listing.type === 'offer');
  const wants = listings.filter((listing) => listing.type === 'want');
  return renderPage(group, memberName, `Market — ${group.name}`, `<h1>Market</h1>
<p>What members of ${escapeHtml(group.name)} are offering and looking for.
<a href="/app/apply">Join</a> to get in touch and trade.</p>
${section('Offers', offers)}
${section('Wants', wants)}`);
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
 * The session cookie's member display name for this group, or undefined —
 * an invalid, expired or foreign-group cookie never throws, it just renders
 * the logged-out header.
 */
export async function sessionMemberName(
  storage: Storage,
  request: FastifyRequest,
  groupId: string,
): Promise<string | undefined> {
  const token = request.cookies[SESSION_COOKIE];
  if (token === undefined) return undefined;
  try {
    const context = await authenticate(storage, token);
    const member = context?.member;
    return member !== undefined && member.groupId === groupId
      ? member.displayName
      : undefined;
  } catch {
    return undefined;
  }
}

/** Register the server-rendered brochure routes (decision #12) at the root. */
export function registerBrochureRoutes(app: FastifyInstance, storage: Storage): void {
  const htmlType = 'text/html; charset=utf-8';
  // HTML pages, not API operations: keep them out of the OpenAPI document.
  const hidden = { schema: { hide: true } } as const;

  app.get('/', hidden, async (request, reply) => {
    const group = await resolveGroupFromHost(storage, request);
    if (group === undefined) return reply.status(404).type(htmlType).send(NOT_FOUND_PAGE);
    const memberName = await sessionMemberName(storage, request, group.id);
    return reply.type(htmlType).send(renderHome(group, memberName));
  });

  app.get('/market', hidden, async (request, reply) => {
    const group = await resolveGroupFromHost(storage, request);
    if (group === undefined) return reply.status(404).type(htmlType).send(NOT_FOUND_PAGE);
    const memberName = await sessionMemberName(storage, request, group.id);
    const listings = await browse(storage, group.id, {});
    const categories = await storage.listCategories(group.id);
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
    return reply
      .type(htmlType)
      .send(renderMarket(group, memberName, listings, categoryNames));
  });
}
