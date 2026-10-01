// Scout's memory (SPEC §13.4): the sources it checks, the pages it already read, and the extra
// links it attaches to drafts. Track records are counted from scout_seen and the pop-ups' fate,
// so there are no counters to drift.

import { DAY, PUBLIC_STATUSES } from '../lib/scoring';
import { safeUrl } from '../lib/extract';

export const SOURCE_KINDS = ['listing', 'venue', 'brand', 'social', 'search'] as const;
export const SOURCE_STATUSES = ['active', 'suggested', 'paused', 'rejected'] as const;
export const SEEN_OUTCOMES = ['sent', 'duplicate', 'not_popup', 'ended', 'too_far_ahead', 'no_details', 'outside_london', 'other'] as const;
export const SKIP_OUTCOMES = SEEN_OUTCOMES.filter(o => o !== 'sent');
export const LINK_KINDS = ['official', 'venue', 'ticket', 'article', 'instagram', 'tiktok', 'xiaohongshu', 'other'] as const;

export type SourceKind = typeof SOURCE_KINDS[number];
export type LinkKind = typeof LINK_KINDS[number];

/** A page read this recently is not read again, unless it led to a draft (then never). */
export const SEEN_FOR = 30 * DAY;
/** Skipped pages are forgotten after this; pages that led to drafts are kept. */
export const SEEN_KEEP = 90 * DAY;

export interface SourceRow {
  id: string;
  kind: SourceKind;
  target: string;
  label: string;
  status: typeof SOURCE_STATUSES[number];
  every_days: number;
  note: string | null;
  suggested_by_run: string | null;
  last_checked_at: number | null;
  due_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SourceStats { drafts: number; published: number; rejected: number; waiting: number }

const TRACKING = /^(utm_|fbclid$|gclid$|igsh$|igshid$|si$|share_|xsec_|mc_)/i;

/** One spelling per page: lower-case host, no tracking parameters, no fragment, no trailing slash. */
export function normalizeUrl(input: string): string | null {
  const u = safeUrl(input);
  if (!u) return null;
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

/** Social links are recognised by their address, whatever kind the agent gave. */
export function linkKind(url: string, given: string | null): LinkKind {
  const h = new URL(url).hostname.replace(/^www\./, '');
  if (h === 'instagram.com' || h.endsWith('.instagram.com') || h === 'instagr.am') return 'instagram';
  if (h === 'tiktok.com' || h.endsWith('.tiktok.com')) return 'tiktok';
  if (h === 'xiaohongshu.com' || h.endsWith('.xiaohongshu.com') || h === 'xhslink.com') return 'xiaohongshu';
  return (LINK_KINDS as readonly string[]).includes(given ?? '') && !['instagram', 'tiktok', 'xiaohongshu'].includes(given!) ? given as LinkKind : 'other';
}

/** Next time a source is due after a check. */
export const nextDue = (everyDays: number, now: number) => now + everyDays * DAY;

/** Drafts each source led to, and what the admin or the community made of them. */
export async function sourceStats(db: D1Database, ids: string[]): Promise<Map<string, SourceStats>> {
  const out = new Map<string, SourceStats>();
  if (!ids.length) return out;
  const { results } = await db.prepare(
    `SELECT s.source_id, p.status, p.final_verdict, p.merged_into FROM scout_seen s JOIN popups p ON p.id = s.popup_id
     WHERE s.outcome = 'sent' AND s.source_id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<{ source_id: string; status: string; final_verdict: string | null; merged_into: string | null }>();
  for (const r of results) {
    const s = out.get(r.source_id) ?? { drafts: 0, published: 0, rejected: 0, waiting: 0 };
    s.drafts++;
    if (r.final_verdict === 'real' || (PUBLIC_STATUSES as string[]).includes(r.status)) s.published++;
    else if (r.status === 'removed' && !r.merged_into) s.rejected++;
    else if (r.status === 'pending') s.waiting++;
    out.set(r.source_id, s);
  }
  return out;
}

/** Extra links for each pop-up, keyed by pop-up id. */
export async function linksFor(db: D1Database, ids: string[]): Promise<Map<string, { url: string; kind: LinkKind }[]>> {
  const out = new Map<string, { url: string; kind: LinkKind }[]>();
  if (!ids.length) return out;
  const { results } = await db.prepare(
    `SELECT popup_id, url, kind FROM popup_links WHERE popup_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`,
  ).bind(...ids).all<{ popup_id: string; url: string; kind: LinkKind }>();
  for (const r of results) out.set(r.popup_id, [...(out.get(r.popup_id) ?? []), { url: r.url, kind: r.kind }]);
  return out;
}

/** Validates a source target: a public web address, or search words for kind 'search'. */
export function sourceTarget(kind: SourceKind, target: string): string | null {
  if (kind === 'search') return target.trim().replace(/\s+/g, ' ').slice(0, 200) || null;
  return normalizeUrl(target);
}
