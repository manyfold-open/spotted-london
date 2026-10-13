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
    return shouldRewrite(response) ? rewriteDocument(response, mount) : response;
  };
}
