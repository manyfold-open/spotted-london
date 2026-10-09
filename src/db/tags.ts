// What agents may do with tags (docs/superpowers/specs/2026-10-08-scout-tags-design.md). The Scout sets tags in its
// draft, and Triage and Checker may remove or add them on a post they read. Every change after the draft writes an
// audit row that names the agent and keeps the old and new set. Tags never block a note or a draft: a tag that is not
// accepted is dropped and reported, and the rest goes through.

import type { PopupRow } from '../types';
import { newId } from '../lib/util';
import { DAY } from '../lib/scoring';
import type { QuoteCheck } from '../lib/evidence';
import { quoteProblem, type TagQuote } from '../lib/tagging';
import { formatTagColumn, isClaimTag, MAX_TAGS, parseTagColumn, TAGS, type Tag } from '../shared/tags';
import { snapshotItems } from './snapshot';

export const TAG_ACTION = 'popup.agent_tags';

export interface Dropped { tag: string; why: string }

/** Looks the quotes up: all of them against one page, fetched once. */
export type QuoteLookup = (quotes: string[], url: string) => Promise<Map<string, QuoteCheck>>;

/**
 * Keeps the tags an agent may set. A plain tag is kept as it is. A claim tag (family, adults_only, dog_friendly, vegan,
 * late_night, booking_needed) needs a quote in `quotes` that says something about it and that Spotted finds on the page;
 * without one, or when the page cannot be read, only that tag is dropped.
 */
export async function vetClaimTags(tags: readonly Tag[], quotes: readonly TagQuote[], defaultUrl: string | null, lookup: QuoteLookup): Promise<{ kept: Tag[]; dropped: Dropped[] }> {
  const kept: Tag[] = [];
  const dropped: Dropped[] = [];
  const byUrl = new Map<string, { tag: Tag; quote: string }[]>();
  for (const tag of tags) {
    if (!isClaimTag(tag)) { kept.push(tag); continue; }
    const q = quotes.find(x => x.tag === tag);
    const problem = quoteProblem(q);
    const url = q?.url ?? defaultUrl;
    if (problem) dropped.push({ tag, why: problem });
    else if (!url) dropped.push({ tag, why: 'needs a page to find the quote on (url)' });
    else byUrl.set(url, [...(byUrl.get(url) ?? []), { tag, quote: q!.quote }]);
  }
  for (const [url, items] of byUrl) {
    let found: Map<string, QuoteCheck>;
    try { found = await lookup(items.map(i => i.quote), url); } catch { found = new Map(); }
    for (const { tag, quote } of items) {
      const r = found.get(quote) ?? 'unchecked';
      if (r === 'found') kept.push(tag);
      else dropped.push({ tag, why: r === 'missing' ? 'its quote is not on that page. Copy it word for word' : 'Spotted could not read that page to find its quote' });
    }
  }
  // keep the order the agent gave
  return { kept: tags.filter(t => kept.includes(t)), dropped };
}

/** The set a change leads to: what was there, minus `remove`, plus `add`, at most MAX_TAGS. What does not fit is returned. */
export function mergeTags(current: readonly Tag[], add: readonly Tag[], remove: readonly Tag[]): { next: Tag[]; over: Tag[] } {
  const all = [...current.filter(t => !remove.includes(t)), ...add.filter(t => !current.includes(t))];
  return { next: all.slice(0, MAX_TAGS), over: all.slice(MAX_TAGS) };
}

/** Tag changes this agent made in the last 24 hours (uses idx_audit_actor). */
export async function tagEditsInLastDay(db: D1Database, userId: string, now: number): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE admin_id = ? AND action = ? AND created_at > ?').bind(userId, TAG_ACTION, now - DAY).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Stores a tag set on a post an agent has just read and writes the audit row. Returns false when the post changed status
 * while the agent was looking, or when nothing would change.
 */
export async function setAgentTags(
  db: D1Database, p: Pick<PopupRow, 'id' | 'status' | 'tags'>, next: readonly Tag[], agent: { id: string; user_id: string; role: string }, now: number,
): Promise<boolean> {
  const to = formatTagColumn(next);
  const from = p.tags ?? null;
  if (to === from) return false;
  const moved = await db.prepare('UPDATE popups SET tags = ?, updated_at = ? WHERE id = ? AND status = ?').bind(to, now, p.id, p.status).run();
  if (!moved.meta.changes) return false;
  await db.prepare('INSERT INTO audit_log (id, admin_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), agent.user_id, TAG_ACTION, 'popup', p.id, JSON.stringify({ agent: agent.id, role: agent.role, status: p.status, from, to }), now).run();
  return true;
}

export const currentTags = (p: Pick<PopupRow, 'tags'>): Tag[] => parseTagColumn(p.tags) ?? [];

export interface TagReport {
  /** Live pop-ups (the public list): tagged, looked at with no tag, and not looked at yet. */
  coverage: { live: number; tagged: number; none_apply: number; not_looked_at: number };
  /** How many live pop-ups carry each tag. A tag under about 1% of them is a candidate to drop or merge. */
  uses: { tag: Tag; n: number; share: number }[];
  /** Tag changes by Triage and Checker in the last 30 days: how many tags they added and removed. */
  changes: { agent: string; role: string; edits: number; added: number; removed: number }[];
  /** Ten tagged pop-ups picked at random, to check by eye. */
  samples: { id: string; slug: string; title: string; tags: Tag[]; source_url: string | null }[];
}

/** The numbers behind the tags section of /admin/agent. Reads the snapshot (one row) and the audit rows of the last 30 days. */
export async function tagReport(db: D1Database, now: number, rand: () => number = Math.random): Promise<TagReport> {
  const items = await snapshotItems(db, now);
  const tagged = items.filter(p => p.tags && p.tags.length);
  const uses = TAGS.map(tag => ({ tag, n: items.filter(p => p.tags?.includes(tag)).length })).map(u => ({ ...u, share: items.length ? Math.round((u.n / items.length) * 1000) / 1000 : 0 })).sort((a, b) => b.n - a.n);
  const { results } = await db.prepare('SELECT detail FROM audit_log WHERE action = ? AND created_at > ? LIMIT 3000').bind(TAG_ACTION, now - 30 * DAY).all<{ detail: string }>();
  const by = new Map<string, { agent: string; role: string; edits: number; added: number; removed: number }>();
  for (const r of results) {
    let d: { agent?: string; role?: string; from?: string | null; to?: string | null };
    try { d = JSON.parse(r.detail); } catch { continue; }
    const from = parseTagColumn(d.from) ?? [], to = parseTagColumn(d.to) ?? [];
    const row = by.get(d.agent ?? '?') ?? { agent: d.agent ?? '?', role: d.role ?? '?', edits: 0, added: 0, removed: 0 };
    row.edits += 1;
    row.added += to.filter(t => !from.includes(t)).length;
    row.removed += from.filter(t => !to.includes(t)).length;
    by.set(row.agent, row);
  }
  const pool = [...tagged];
  const samples: TagReport['samples'] = [];
  while (samples.length < 10 && pool.length) {
    const [p] = pool.splice(Math.floor(rand() * pool.length), 1);
    samples.push({ id: p.id, slug: p.slug, title: p.title, tags: p.tags as Tag[], source_url: p.source_url });
  }
  return {
    coverage: { live: items.length, tagged: tagged.length, none_apply: items.filter(p => p.tags && !p.tags.length).length, not_looked_at: items.filter(p => !p.tags).length },
    uses, changes: [...by.values()].sort((a, b) => b.edits - a.edits), samples,
  };
}
