import type { Status } from './lib/scoring';

/** Bindings from wrangler.jsonc plus optional secrets and bindings added later. */
export type Bindings = Cloudflare.Env & {
  AI?: Ai;
  IMAGES?: R2Bucket;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  MAPBOX_TOKEN?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Seals the Manyfold caller tokens of the AI agents. 32+ characters. */
  AGENTS_KEY?: string;
  /** Manyfold API for Connect A2A. Defaults to https://api.manyfold.ai. */
  MANYFOLD_API_URL?: string;
};

export interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: 'user' | 'organizer' | 'admin';
  karma: number;
  verified_posts: number;
  bad_posts: number;
  email_verified: number;
  status: 'active' | 'shadowbanned' | 'banned' | 'deleted';
  created_at: number;
}

export interface PopupRow {
  id: string;
  slug: string;
  title: string;
  host: string | null;
  description: string | null;
  category: string;
  price_type: string | null;
  price_text: string | null;
  address: string | null;
  borough: string | null;
  lat: number;
  lng: number;
  geohash: string;
  start_at: number;
  end_at: number;
  hours_text: string | null;
  source_url: string | null;
  status: Status;
  final_verdict: 'real' | 'fake' | null;
  merged_into: string | null;
  created_by: string;
  exist_pos: number;
  exist_neg: number;
  voter_count: number;
  checkin_count: number;
  confidence: number;
  quality_pos: number;
  quality_neg: number;
  hot: number;
  report_weight: number;
  created_at: number;
  updated_at: number;
  is_example: number;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: { user: UserRow | null; now: number };
};
