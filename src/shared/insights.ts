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
}
export type EventsResult = EventStats | { status: 'not_configured' | 'error'; message: string };
export interface Insights { days: InsightDays; updated_at: number; accounts: Accounts; events: EventsResult }

