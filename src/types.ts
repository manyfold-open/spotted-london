import type { Status } from './lib/scoring';

/** Bindings from wrangler.jsonc plus optional secrets and bindings added later. */
export type Bindings = Cloudflare.Env & {
  AI?: Ai;
  IMAGES?: R2Bucket;
  /** Calls per minute for anonymous POST /mcp (wrangler.jsonc `ratelimits`). Missing in some setups: then nothing is limited. */
  MCP_LIMIT?: RateLimit;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  MAPBOX_TOKEN?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Seals the Manyfold caller tokens of the AI agents. 32+ characters. */
  AGENTS_KEY?: string;
  /** Lets Claude Code and scripts manage AI agents (create, keys, connect, run), and nothing else. */
  AGENT_ADMIN_TOKEN?: string;
  /** Manyfold API for Connect A2A. Defaults to https://api.manyfold.ai. */
  MANYFOLD_API_URL?: string;
  /** Apify API token for fetching Instagram and Threads posts. Without it nothing is fetched. */
  APIFY_TOKEN?: string;
  /** Most Ask questions in one London day, for all visitors together. Defaults to 150; 0 switches Ask off. */
  ASK_DAILY_CAP?: string;
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
  /** NULL: nobody has looked; '': none apply; ',a,b,': see src/shared/tags.ts. Absent before migration 0020. */
  tags?: string | null;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: { user: UserRow | null; now: number };
};
