// The shape of GET /admin/insights, shared by the Worker (src/db/insights.ts) and the page (web/src/pages/Insights.tsx).

export const INSIGHT_DAYS = [7, 30] as const;
export type InsightDays = (typeof INSIGHT_DAYS)[number];

export interface Accounts {
  total: number;
  new_in_period: number;
  per_day: { day: string; n: number }[];
  actions: { saves: number; votes: number; checkins: number; reports: number; popups_added: number; asks: number };
  most_saved: { slug: string; title: string; saves: number }[];
}
export interface EventStats {
  status: 'ok';
  visitors: number;
  signed_in_visitors: number;
  visits: number;
  views: number;
  daily: { day: string; visitors: number; views: number }[];
  /** Of last week's visitors, how many came back this week (approximate: unique counts are estimates). */
  retention: { last_week: number; came_back: number; rate: number | null };
  funnel: Record<string, { n: number; people: number }>;
  top_popups: { slug: string; title: string; opens: number; saves: number }[];
  categories: { key: string; opens: number; saves: number }[];
  filters: { key: string; n: number }[];
  referrers: { host: string; n: number }[];
  pages: { route: string; n: number }[];
  countries: { code: string; n: number }[];
  devices: { mobile: number; desktop: number };
  /** Where visits came from (utm tags, Google Ads click mark, or the linking site), with what each channel's visitors went on to do. '' is direct, or a visit before channels were counted. */
  channels: { key: string; visitors: number; opened: number; saved: number; signed_in: number; posted: number }[];
  campaigns: { key: string; visits: number }[];
  /** For each reason the sign-in sheet opened: people who saw it, tapped Continue, and came back signed in. */
  gate: { key: string; seen: number; started: number; done: number }[];
  /** How pop-ups were opened (map, list, search, ask, saved, own, link). */
  open_via: { key: string; n: number }[];
  /** Adding a pop-up: people who started, the autofill kinds used and whether they filled anything, the field that stopped people. */
  add: { started: number; autofill: { kind: string; ok: number; empty: number }[]; stuck: { key: string; n: number }[] };
  /** Searches (`search`) and filters (`cat:food` ...) that found nothing. */
  empty: { key: string; n: number }[];
}
export type EventsResult = EventStats | { status: 'not_configured' | 'error'; message: string };

/** One row of "what is on the list against what people do with it". `opens` is null when visitor numbers are not set up. */
export interface SupplyRow { key: string; live: number; saves: number; opens: number | null }
interface Origin { live: number; saves: number; opens: number | null }
/**
 * What people give back, from D1 (and the opens from Analytics Engine when it is set up). Counts and shares only:
 * nothing here says who anyone is. Real accounts only, so agents and system accounts are left out of the people.
 */
export interface Contributions {
  /** People who saved, voted, checked in, reported or posted at least once in the period. */
  contributors: number;
  /** For each kind, how many different people did it at least once. */
  by_kind: { saves: number; votes: number; checkins: number; reports: number; posts: number };
  /** Contributors by how much they did in the period: once, 2 to 5 times, 6 or more. */
  spread: { once: number; few: number; many: number };
  /** The share of all actions done by the busiest 10% of contributors. Null with fewer than 10 contributors. */
  top_share: number | null;
  /** Of the people active in the period before, how many were active again in this one. */
  repeat: { last_period: number; came_back: number; rate: number | null };
  /** Accounts made in the period: how many did anything at all (ever, since signing up), and the median wait for the first thing. */
  activation: { new_accounts: number; acted: number; median_hours: number | null };
  /** Posts people made in the period, by where they are now. `verified` is part of `live`. */
  posts: { total: number; waiting: number; live: number; verified: number; turned_down: number; ended: number };
  /** Pop-ups on the list now that at least one person has vouched for (an existence vote or a check-in). */
  coverage: { live: number; checked: number; by_status: { community: number; verified_community: number; verified_admin: number } };
  /** Pop-ups on the list now, by who made the post, and what people did with them in the period. */
  origin: { people: Origin; agents: Origin };
  by_category: SupplyRow[];
  by_area: SupplyRow[];
}

/** `contributions` is null when it could not be worked out; the rest of the page still shows. */
export interface Insights { days: InsightDays; updated_at: number; accounts: Accounts; events: EventsResult; contributions: Contributions | null }

