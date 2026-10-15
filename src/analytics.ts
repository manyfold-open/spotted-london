/**
 * Google Analytics 4, on the public site only. The Worker writes into each page what the browser needs to measure it
 * (web/src/lib/ga.ts): the property, and whether this visitor must be asked first. Nothing of Google's is in the page
 * itself: the app loads Google's tag, and only once it may.
 *
 * Asked first: visitors in the UK, the EEA and Switzerland, where analytics cookies need consent, and anyone whose
 * country Cloudflare does not know. There the tag loads only after "Allow", so a visitor who never answers sends
 * Google nothing. Elsewhere it loads at once, and the switch in the menu turns it off.
 *
 * Measured only in production, on the host in APP_URL: never on a preview or workers.dev address, never in local dev.
 */

/** The EU 27, Iceland, Liechtenstein, Norway, the UK and Switzerland. */
export const CONSENT_REGIONS: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'CH',
]);

const MEASUREMENT_ID = /^G-[A-Z0-9]{4,24}$/;

interface AnalyticsEnv { GA_MEASUREMENT_ID?: string; ENVIRONMENT?: string; APP_URL?: string }

/** The property this deployment reports to; null when unset or not a GA4 id, and then nothing is measured. */
export const measurementIdFor = (env: { GA_MEASUREMENT_ID?: string }): string | null => {
  const id = env.GA_MEASUREMENT_ID?.trim().toUpperCase() ?? '';
  return MEASUREMENT_ID.test(id) ? id : null;
};

/** Whether a visitor from this country (Cloudflare's code; XX unknown, T1 Tor) is asked first. */
export const consentRequiredFor = (country: unknown): boolean =>
  typeof country !== 'string' || !/^[A-Z]{2}$/.test(country) || country === 'XX' || CONSENT_REGIONS.has(country);

/** The property, when this request is for the public site in production; else null. */
export function measuredId(request: Request, env: AnalyticsEnv): string | null {
  if (env.ENVIRONMENT !== 'production' || !env.APP_URL) return null;
  try {
    if (new URL(request.url).host !== new URL(env.APP_URL).host) return null;
  } catch { return null; }
  return measurementIdFor(env);
}

/** What the browser reads: the property, and data-ask="1" where the visitor is asked first. */
export const analyticsMeta = (id: string, ask: boolean): string =>
  `<meta name="spotted-analytics" content="${id}" data-ask="${ask ? '1' : '0'}">`;

/** A page with the analytics meta in its head, when the page is measured. Anything but a 200 HTML page passes untouched. */
export function withAnalytics(response: Response, request: Request, env: AnalyticsEnv): Response {
  if (response.status !== 200 || !(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) return response;
  const id = measuredId(request, env);
  if (!id) return response;
  const ask = consentRequiredFor((request.cf as { country?: unknown } | undefined)?.country);
  return new HTMLRewriter().on('head', { element: el => void el.append(analyticsMeta(id, ask), { html: true }) }).transform(response);
}
