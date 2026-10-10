// The chat side of Ask: how a follow-up is worded, and the quick refinements a visitor can tap on an answer
// ("Only free", "Today"...). Refining works on the picks already received, in the browser, so it costs no question.
// Plain functions with no Worker imports, so the web app and the tests run the same code.

import { haversine } from '../lib/geo';
import { windowFor } from '../lib/time';

/** Longest piece of the earlier question that rides along with a follow-up. */
export const FOLLOW_UP_CONTEXT = 120;

/**
 * The text sent for a message in the chat. The agent answers each question on its own, so a follow-up carries the
 * question it follows ("cheaper" means nothing alone). The visitor still sees only what they typed. The earlier
 * question is cut to fit `max`, and left out when there is no room.
 */
export function composeQuestion(text: string, earlier: string | null, max: number): string {
  const t = text.trim();
  const e = earlier?.trim().replace(/\s+/g, ' ');
  if (!e) return t;
  const lead = ' (Earlier I asked: ';
  const room = Math.min(FOLLOW_UP_CONTEXT, max - t.length - lead.length - 1);
  return room >= 15 ? `${t}${lead}${e.slice(0, room)})` : t;
}

export type Refine = 'free' | 'today' | 'weekend' | 'near';
export const REFINE_LABELS: Record<Refine, string> = { free: 'Only free', today: 'Today', weekend: 'This weekend', near: 'Closest first' };

export interface AskItem { id: string; price: { type: string | null }; start_at: number; end_at: number; location: { lat: number; lng: number } }
export interface PickRef { id: string }
export interface PickRow<P extends PickRef, I extends AskItem> { pick: P; item: I | null; m?: number }

/**
 * The picks of one answer, in the order to show them. When the agent said the request was about where the visitor
 * is, the nearest come first (`near` with a position). `by` narrows them further. `total` is how many there were
 * before `by`, so the page can say "none of these are free". A pick whose pop-up has left the public list is
 * kept (it still has its title) unless a refinement needs facts about it.
 */
export function shapePicks<P extends PickRef, I extends AskItem>(
  picks: readonly P[], byId: ReadonlyMap<string, I>, o: { near: boolean; pos: [number, number] | null; by: Refine | null; now: number; limit: number },
): { rows: PickRow<P, I>[]; total: number } {
  let rows: PickRow<P, I>[] = picks.map(pick => ({ pick, item: byId.get(pick.id) ?? null }));
  const total = rows.length;
  const dist = (r: PickRow<P, I>) => (o.pos && r.item ? haversine(o.pos[0], o.pos[1], r.item.location.lat, r.item.location.lng) : Infinity);
  if ((o.near || o.by === 'near') && o.pos) {
    rows = rows.map(r => ({ ...r, m: dist(r) })).sort((a, b) => a.m! - b.m!).map(r => ({ ...r, m: Number.isFinite(r.m) ? r.m : undefined }));
  }
  if (o.by === 'free') rows = rows.filter(r => r.item?.price.type === 'free');
  else if (o.by === 'today' || o.by === 'weekend') {
    const { from, to } = windowFor(o.by, o.now);
    rows = rows.filter(r => !!r.item && r.item.end_at > from && r.item.start_at < to);
  }
  return { rows: rows.slice(0, o.limit), total };
}
