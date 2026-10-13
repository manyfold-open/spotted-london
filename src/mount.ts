/**
 * One deployment, two addresses (the same approach as the other Manyfold apps, for example manyfold-tarot).
 *
 * The site answers at the root of its own host (local dev, a workers.dev URL) and, when BASE_PATH is set,
 * under that prefix on a host it shares with other apps (app.manyfold.ai/spotted-london). Everything inside
 * (the Hono app, the assets binding) only ever sees root paths. This file is the one place that knows about
 * the prefix:
 *
 *   - on the way in it takes the prefix off and records it in a header that only this wrapper may set;
 *   - on the way out it puts the prefix back wherever a root path is about to reach the browser: a redirect's
 *     Location, and the src, href and action attributes of an HTML document;
 *   - it tells the page where it is mounted in a <meta name="app-base">, which the browser reads before its
 *     first request (web/src/lib/base.ts).
 *
 * Without BASE_PATH none of this runs and the root is served exactly as before.
 */

/** Where the wrapper records the prefix a request arrived under. Like a proxy, it drops any copy a client sent. */
export const PREFIX_HEADER = 'x-forwarded-prefix';

/** Path segments only: the value ends up inside an HTML attribute. */
const SAFE_MOUNT = /^(\/[A-Za-z0-9._~-]+)+$/;

/** BASE_PATH as '' (not mounted) or '/spotted-london': never a trailing slash, never anything odd. */
export const mountPath = (env: { BASE_PATH?: string }): string => {
  const raw = (env.BASE_PATH ?? '').trim().replace(/\/+$/, '');
  return SAFE_MOUNT.test(raw) ? raw : '';
};

/** `/spotted-london` and `/spotted-london/...`, but never `/spotted-londonfoo`. */
export const isUnder = (pathname: string, mount: string): boolean =>
  mount !== '' && (pathname === mount || pathname.startsWith(`${mount}/`));

/** The prefix this request came in under: '' at the root. */
export const mountOf = (c: { req: { header: (name: string) => string | undefined } }): string =>
  c.req.header(PREFIX_HEADER) ?? '';

/** A root-relative URL moved under the mount. Protocol-relative, absolute and relative URLs are left alone. */
export const prefixed = (value: string, mount: string): string =>
  value.startsWith('/') && !value.startsWith('//') ? mount + value : value;

/** Only a 200 HTML document has attributes to rewrite. Images and bundles pass untouched. */
const shouldRewrite = (response: Response): boolean =>
  response.status === 200 && (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');

function rewriteDocument(response: Response, mount: string): Response {
  const attribute = (name: string): HTMLRewriterElementContentHandlers => ({
    element(element) {
      const value = element.getAttribute(name);
      if (value !== null) element.setAttribute(name, prefixed(value, mount));
    },
  });
  const rewritten = new HTMLRewriter()
    .on('head', { element(element) { element.prepend(`<meta name="app-base" content="${mount}">`, { html: true }); } })
    .on('[href^="/"]', attribute('href'))
    .on('[src^="/"]', attribute('src'))
    .on('[action^="/"]', attribute('action'))
    .transform(response);
  // The ETag belongs to the original file, not to the page with the prefix in it: a browser holding the other one
  // would be told "not modified" and keep it.
  const out = new Response(rewritten.body, rewritten);
  out.headers.delete('etag');
  return out;
}

/**
 * The manifest in web/public is written with relative addresses so it works at a root and under a mount. Under a
 * mount it is sent with absolute paths ("/spotted-london/", "/spotted-london/icons/..."), the form every other home
 * screen app uses. The scope is the whole host ("/"), as it was before the move to a shared host: with a scope of only
 * "/spotted-london/" the iOS 26 home screen app drew a browser bar (domain on top, back/share/reload at the bottom)
 * although it reported standalone mode. start_url stays inside the mount.
 */
async function absoluteManifest(response: Response, mount: string): Promise<Response> {
  let manifest: Record<string, unknown>;
  try { manifest = await response.clone().json() as Record<string, unknown>; } catch { return response; }
  const base = new URL(`${mount}/`, 'https://mount.invalid');
  const abs = (value: unknown) => (typeof value === 'string' ? new URL(value, base).pathname + new URL(value, base).search : value);
  for (const key of ['id', 'start_url']) if (key in manifest) manifest[key] = abs(manifest[key]);
  if ('scope' in manifest) manifest.scope = '/';
  for (const list of ['icons', 'shortcuts']) {
    const items = manifest[list];
    if (!Array.isArray(items)) continue;
    manifest[list] = items.map((item: Record<string, unknown>) => {
      const out = { ...item };
      if ('src' in out) out.src = abs(out.src);
      if ('url' in out) out.url = abs(out.url);
      if (Array.isArray(out.icons)) out.icons = out.icons.map((i: Record<string, unknown>) => ({ ...i, src: abs(i.src) }));
      return out;
    });
  }
  const out = new Response(JSON.stringify(manifest), response);
  out.headers.delete('etag');
  out.headers.delete('content-length');
  return out;
}

type Fetch<E> = (request: Request, env: E, ctx: ExecutionContext) => Response | Promise<Response>;

/** Wraps a fetch handler so it can also be served under BASE_PATH. */
export function withMount<E extends { BASE_PATH?: string }>(inner: Fetch<E>): Fetch<E> {
  return async (request, env, ctx) => {
    const mount = mountPath(env);
    const url = new URL(request.url);

    if (!isUnder(url.pathname, mount)) {
      if (!request.headers.has(PREFIX_HEADER)) return inner(request, env, ctx);
      // Only the wrapper says where a request came in; a client's claim is dropped.
      const cleaned = new Request(request);
      cleaned.headers.delete(PREFIX_HEADER);
      return inner(cleaned, env, ctx);
    }

    // The mount root always carries its slash, so there is one address for the front page and not two.
    if (url.pathname === mount) {
      url.pathname = `${mount}/`;
      return Response.redirect(url.toString(), 308);
    }

    url.pathname = url.pathname.slice(mount.length);
    const forwarded = new Request(url.toString(), request);
    forwarded.headers.set(PREFIX_HEADER, mount);
    let response = await inner(forwarded, env, ctx);

    const location = response.headers.get('location');
    if (location && prefixed(location, mount) !== location) {
      response = new Response(response.body, response);
      response.headers.set('location', prefixed(location, mount));
    }
    if (url.pathname === '/manifest.webmanifest' && response.status === 200) return absoluteManifest(response, mount);
    return shouldRewrite(response) ? rewriteDocument(response, mount) : response;
  };
}
