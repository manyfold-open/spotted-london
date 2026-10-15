// The shape of GET /admin/health, shared by the Worker (src/db/health.ts) and the Insights page.

export const HEALTH_FEATURES = ['ask', 'autofill'] as const;
export type HealthFeature = (typeof HEALTH_FEATURES)[number];

export interface HealthDay {
  day: string;
  ok: number;
  failed: number;
  other: number;
  /** Average time of the calls that worked or failed, in ms; null when there were none. */
  avg_ms: number | null;
  max_ms: number;
}

export interface TestResult {
  feature: HealthFeature;
  /** null while an Ask test is still waiting for the Concierge. */
  ok: boolean | null;
  ms: number | null;
  detail: string;
  /** When it started (Unix ms); the one-a-minute limit counts from here. */
  at: number;
  /** The question's id, for an Ask test. */
  id?: string;
}

export interface FeatureHealth {
  feature: HealthFeature;
  /** The last 14 London days, oldest first, quiet days as zeros. The last one is today. */
  days: HealthDay[];
  /** ok / (ok + failed) today; null when nothing has run. `other` is left out. */
  rate_today: number | null;
  /** Today looks bad: at least 5 calls and under 80% worked. */
  flagged: boolean;
  last_error: string | null;
  test: TestResult | null;
}

/** null: the health_daily table is not there yet (migration 0028). */
export type Health = { features: FeatureHealth[]; updated_at: number } | null;
