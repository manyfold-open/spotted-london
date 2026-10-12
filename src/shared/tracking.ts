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
