/**
 * Where the site is mounted, without a trailing slash: '' at the root of its own host (local dev, a workers.dev
 * address) and '/spotted-london' under app.manyfold.ai/spotted-london.
 *
 * The Worker says so in a <meta name="app-base"> it writes into the page, only when the page was asked for under
 * the prefix (src/mount.ts). It is read rather than guessed from the URL because the URL cannot say where the
 * mount ends. The page never moves to another origin, so reading it once is enough.
 */
// Typed by hand, not with the DOM types, because the tests (which have none) import this file too.
interface Queryable { querySelector(selector: string): { content?: string } | null }
const browser = globalThis as unknown as { document?: Queryable; location: { origin: string } };

export const baseFrom = (doc: Queryable): string => doc.querySelector('meta[name="app-base"]')?.content ?? '';

export const BASE = browser.document ? baseFrom(browser.document) : '';

/** A root path moved under `base`. Other URLs, and a path that already carries `base`, are left alone. */
export const joinBase = (base: string, path: string): string =>
  path.startsWith('/') && !path.startsWith('//') && !(base && path.startsWith(`${base}/`)) ? base + path : path;

/** An in-app path ('/api/v1/e', '/p/some-slug', '/api/v1/images/a.jpg') as the browser must ask for it. Safe to apply twice. */
export const appUrl = (path: string): string => joinBase(BASE, path);

/** The site's own address on the host in use, with the mount prefix and no trailing slash: https://app.manyfold.ai/spotted-london. */
export const siteUrl = (): string => `${browser.location.origin}${BASE}`;

/** The address a person can share for an in-app path, on the host they are using. */
export const shareUrl = (path: string): string => `${browser.location.origin}${appUrl(path)}`;
