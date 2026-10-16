// The pure parts of usage tracking, shared by the browser (web/src/lib/track.ts) and tests.
// What is sent, and what it is for, is written on the privacy page (src/privacy.ts): change both together.

/** The page a path belongs to, as a short fixed word. Admin pages are not tracked. Null: do not track it. */
export function routeName(pathname: string): string | null {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/' || p === '/map') return 'home';
  if (p.startsWith('/p/')) return 'popup';
  if (p.startsWith('/admin')) return null;
  const first = p.split('/')[1] ?? '';
  return ['add', 'saved', 'connect', 'me', 'signin'].includes(first) ? first : 'other';
}

/** The slug in /p/<slug>, or null. */
export function slugFromPath(pathname: string): string | null {
  if (!pathname.startsWith('/p/')) return null;
  try { return decodeURIComponent(pathname.slice(3)).replace(/\/+$/, '') || null; } catch { return null; }
}

/** The site a visitor came from, or '' for direct visits and links from our own pages. */
export function referrerHost(referrer: string, ownHost: string): string {
  if (!referrer) return '';
  try {
    const h = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
    return h === ownHost.toLowerCase().replace(/^www\./, '') ? '' : h.slice(0, 60);
  } catch { return ''; }
}

/** What a filter change says, as one fixed word like `cat:food`. Never the text someone typed. Null: nothing to count. */
export function filterEvent(patch: Record<string, string | null>, currentQuery: string): { name: 'filter' | 'search'; detail: string } | null {
  for (const key of ['saved', 'cat', 'when', 'verified'] as const) {
    const v = patch[key];
    if (typeof v === 'string' && v) return { name: 'filter', detail: `${key}:${v}`.toLowerCase().replace(/[^a-z0-9_:.-]/g, '').slice(0, 40) };
  }
  // A search counts once, when it starts, not for every letter
  if (typeof patch.q === 'string' && patch.q.trim() && !currentQuery.trim()) return { name: 'search', detail: '' };
  return null;
}

/* ---------- where a visit came from ---------- */

const clean = (v: string | null, max: number) => (v ?? '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9_.-]/g, '').slice(0, max);
const SEARCH_ENGINES = new Set(['google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'baidu']);

/** The name of a site without its ending or subdomains: l.instagram.com is instagram, www.bbc.co.uk is bbc. */
function siteName(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (labels.length < 2) return clean(labels[0] ?? '', 30);
  const last = labels.at(-1)!, second = labels.at(-2)!;
  const twoPart = last.length === 2 && ['co', 'com', 'org', 'ac', 'gov', 'net'].includes(second) && labels.length >= 3;
  return clean(twoPart ? labels.at(-3)! : second, 30);
}

/**
 * Where a visit came from, as two fixed words: the channel (`instagram:social` from utm_source and utm_medium,
 * `google:cpc` when the address carries a Google Ads click mark, `google:organic` or `instagram:referral` from the
 * site that linked here) and the utm_campaign. The click mark itself is never kept, only that there was one.
 * Null for a direct visit, so the caller can leave an earlier answer alone.
 */
export function landingChannel(search: string, refHost: string): { channel: string; campaign: string } | null {
  const sp = new URLSearchParams(search);
  const source = clean(sp.get('utm_source'), 30);
  if (source) {
    const medium = clean(sp.get('utm_medium'), 30);
    return { channel: medium ? `${source}:${medium}` : source, campaign: clean(sp.get('utm_campaign'), 40) };
  }
  if (sp.has('gclid') || sp.has('gbraid') || sp.has('wbraid')) return { channel: 'google:cpc', campaign: '' };
  const name = refHost ? siteName(refHost) : '';
  if (!name) return null;
  return { channel: `${name}:${SEARCH_ENGINES.has(name) ? 'organic' : 'referral'}`, campaign: '' };
}

/* ---------- why someone was asked to sign in ---------- */

export const SIGNIN_REASONS = ['vote', 'save', 'add', 'checkin', 'report', 'me', 'other'] as const;
export type SigninReason = (typeof SIGNIN_REASONS)[number];

/** The sign-in sheet's heading ("Sign in to vote") as one fixed word. Anything unexpected is `other`. */
export function reasonWord(why: string): SigninReason {
  const w = why.toLowerCase();
  if (w.includes('vote')) return 'vote';
  if (w.includes('check in') || w.includes('check-in')) return 'checkin';
  if (w.includes('report')) return 'report';
  if (w.includes('save')) return 'save';
  if (/\b(add|post)\b/.test(w)) return 'add';
  return 'other';
}

/* ---------- how a pop-up was opened ---------- */

export const OPEN_VIA = ['map', 'list', 'search', 'ask', 'saved', 'own', 'link', 'other'] as const;
export type OpenVia = (typeof OPEN_VIA)[number];

/* ---------- a search or filter that found nothing ---------- */

/** What an empty list says about the search or filters behind it, as one fixed word. Null when no filter is on, so an empty list is not blamed on a person. */
export function emptyEvent(f: { q: string; cat: string; verified: boolean; saved: boolean; when: string }): { name: 'search_empty' | 'filter_empty'; detail: string } | null {
  if (f.q.trim()) return { name: 'search_empty', detail: '' };
  const detail = f.cat ? `cat:${f.cat}` : f.saved ? 'saved:1' : f.verified ? 'verified:1' : f.when && f.when !== 'week' ? `when:${f.when}` : '';
  return detail ? { name: 'filter_empty', detail: detail.toLowerCase().replace(/[^a-z0-9_:.-]/g, '').slice(0, 40) } : null;
}
