# Spotted London

London pop-ups, added by locals and verified by the community. Cloudflare Workers + D1 + R2 + KV, all on the free tier.

- Product and technical spec: [SPEC.md](SPEC.md)
- Design system: [docs/DESIGN.md](docs/DESIGN.md)
- Notes for AI coding agents: [CLAUDE.md](CLAUDE.md)
- Clickable UI prototype: [prototype/index.html](prototype/index.html)

## Set up on a new computer

You need Node.js 22+, git and the GitHub CLI (`gh`).

```bash
gh auth login                                   # the GitHub account that can see tldr0810/spotted-london
gh repo clone tldr0810/spotted-london
cd spotted-london
npm install
cp .dev.vars.example .dev.vars
npm run db:reset
npm run build:web
```

Then `npm run dev` and `npm run dev:web` in two terminals, as below. `npm run dev` needs `npx wrangler login` (sign in as zack11712@gmail.com, check with `npx wrangler whoami`) because AI autofill always runs on Cloudflare. Without an account, use `npm run dev:local` instead: everything works except autofill from pasted text and screenshots.

## Run it locally

D1, KV and R2 are simulated on your machine. Workers AI cannot be, so `npm run dev` connects to Cloudflare for it and needs `npx wrangler login`. `npm run dev:local` skips that; autofill from links still works, pasted text and screenshots show a friendly error.

```bash
npm install                 # also installs web/
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run db:seed
npm run build:web           # the Worker serves web/dist, so build once
npm run dev                 # terminal 1: Worker + API on :8787 (or npm run dev:local without a login)
npm run dev:web             # terminal 2: the app with hot reload on :5173
```

Open `http://localhost:5173`. Vite forwards `/api` and `/login` to the Worker. The API is also at `http://localhost:8787/api/v1`. The seed has fictional pop-ups, and these users:

| id | role | notes |
|---|---|---|
| `dev_admin` | admin | can use the review queue |
| `dev_zack` | member | karma 58, vote weight 3.3x, trust 44 |
| `dev_new` | member | 12-hour-old account, votes weigh 0 |

### Sign in

Open `http://localhost:5173/signin` and enter an email. Without an email provider configured, the page shows the sign-in link instead of sending it. Try `zack@spotted.dev` to sign in as the seeded member.

For scripts and curl you can also act as a user with the `x-dev-user` header. This only works when `ENVIRONMENT=development`, which comes from `.dev.vars` and is never set in production.

```bash
curl "localhost:8787/api/v1/popups?when=weekend"
curl -X PUT localhost:8787/api/v1/popups/arches/vote \
  -H 'x-dev-user: dev_zack' -H 'content-type: application/json' \
  -d '{"kind":"existence","value":1}'
```

Run the scheduled jobs by hand with `npx wrangler dev --test-scheduled`, then open `http://localhost:8787/__scheduled?cron=*/10+*+*+*+*`.

## Tests

```bash
npm test          # unit + API tests inside the Workers runtime, with a local D1
npm run typecheck
```

## Web app

`web/` is a Vite + React single-page app, built to `web/dist` and served by the same Worker as static assets (free, no Worker CPU). Pop-up pages (`/p/:slug`) run through the Worker first, which injects the title, share preview and schema.org Event data, so link previews and search engines see them without JavaScript.

- Routing: React Router. Data: TanStack Query. Maps: MapLibre with OpenFreeMap tiles, loaded only on map screens.
- Address search: Photon (OpenStreetMap), through `/api/v1/geocode`, cached for a day.
- Photos are resized in the browser to WebP, at most 1600 px, before upload.
- Phone layout under 900 px: bottom tabs and bottom sheets. Desktop: sidebar and a right drawer.

## Layout

```
src/
  index.ts          Hono app, error format, cron entry
  middleware.ts     session, CSRF guard, admin checks, Turnstile, IP hashing
  pages.ts          sign-in confirm page, SEO tags for /p/:slug
  cron.ts           end expired pop-ups, settle karma, hourly hot refresh, reminders, start agent runs
  mcp.ts            MCP server at /mcp: public search, plus agent tools with a key
  lib/scoring.ts    vote weight, Wilson confidence, status rules, trust, hot (SPEC 4)
  lib/extract.ts    paste-a-link autofill parsing (SPEC 3.8)
  lib/time.ts       Europe/London calendar maths
  lib/geo.ts        geohash, distances, London bounds
  db/popups.ts      recompute aggregates and status after every vote
  db/karma.ts       idempotent karma awards with the daily cap
  db/agents.ts      AI agents: roles, schedules, starting and checking runs
  lib/a2a.ts        A2A client for Manyfold (start a task, check a task)
  lib/seal.ts       AES-GCM for the stored Manyfold caller tokens
  routes/           auth, popups, extract, geocode, me, admin, agents, newsletter, images, users
  services/email.ts sending through Resend
migrations/         D1 schema
skills/             the skill the Manyfold agents install (spotted-london/SKILL.md)
seed/seed.sql       local example data
web/src/
  main.tsx          routes
  components/       Shell (sidebar, top bar, tabs), PopupSheet, cards, maps, icons
  pages/            Explore, MapPage, Submit, Account (Saved, Me, Sign in, Review queue), Agents
  lib/              API client, hooks, formatting, photo compression
```

## Sign in, in production

Email magic links and Google, no passwords (SPEC 3.4).

- Session cookies are `HttpOnly`, `SameSite=Lax`, 30 days. The database stores only a SHA-256 of each session and each sign-in link.
- Sign-in links work once, last 15 minutes, and open a confirm page first, so email scanners cannot use them up.
- Google uses the authorization code flow with PKCE and a state cookie.
- Writes that carry the session cookie are rejected when they come from another site.

Before deploying, set `APP_URL` in `wrangler.jsonc` and add the secrets:

```bash
npx wrangler secret put RESEND_API_KEY        # from resend.com, free tier
npx wrangler secret put EMAIL_FROM            # e.g. Spotted London <hello@your-domain>
npx wrangler secret put GOOGLE_CLIENT_ID      # Google Cloud console, OAuth client (web)
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

In the Google console, add `<APP_URL>/api/v1/auth/google/callback` as an authorised redirect URI. For local testing with Google, add `http://localhost:8787/api/v1/auth/google/callback` and put the two Google values in `.dev.vars`.

## AI agents and MCP

Four kinds of AI agent run on [Manyfold](https://manyfold.ai), not on Cloudflare, so they cost no Workers AI quota. Spotted keeps their settings at **/admin/agent**, starts their runs, and shows what they did.

| Agent | Job | Writes |
|---|---|---|
| Scout | finds new pop-ups on the public web | pending drafts, posted as "Scout agent" |
| Triage | checks each post in the review queue | a note per post (looks real, needs a check, likely fake, duplicate, not a pop-up); fixes small details itself, publishes what it confirmed, removes duplicates and non pop-ups with proof |
| Checker | rechecks live pop-ups against their source | a flag when one is cancelled or changed |
| Concierge | answers the questions visitors type into Ask | nothing: it only reads the public list and replies with pop-up ids and a reason each |

Nothing an agent writes is published without the admin. Drafts are always `pending`, and notes show in the review queue until the admin decides or dismisses them.

How it fits together:

- **Connecting**: "Connect with Manyfold" on each agent card uses Manyfold's Connect A2A sign-in (a device-code flow, `POST /api/connect/a2a/start` then `/poll`). The admin checks the code in Manyfold, picks the agent and approves; Spotted receives the A2A address and a token for that one agent. The device code never leaves the Worker (sealed in KV for 15 minutes). Pasting an address and token by hand still works as a fallback.
- **Spotted to agent**: the `*/10` cron starts agents that are due over A2A as an async submit (`message/send` with `blocking: false`, so Manyfold's 10-minute blocking cap does not apply), gets the task id back at once, and later checks with `tasks/get`. Runs that do not finish in 3 hours are marked failed. "Run now" starts one straight away.
- **Agent to Spotted**: `POST /mcp` (MCP, Streamable HTTP, stateless). Without a key it offers `search_popups` and `get_popup` to anyone's AI assistant. With `Authorization: Bearer spk_...` it adds the tools for that agent's job. Keys are stored as SHA-256 and each agent has its own.
- **What the agent knows**: `skills/spotted-london/SKILL.md`, installed on each agent from GitHub, plus a short brief per run with the run id, limits and the admin's instructions.

One-time setup:

1. Set the secret that encrypts the Manyfold tokens: `npx wrangler secret put AGENTS_KEY` (32+ random characters, for example from `openssl rand -base64 32`). Changing it later means pasting the tokens again.
2. Apply the migration: `npx wrangler d1 migrations apply spotted-db --remote`.
3. For each agent, follow the steps at the bottom of /admin/agent: create the agent in Manyfold, install the skill from `https://github.com/tldr0810/spotted-london/tree/main/skills/spotted-london`, give the agent its own Spotted key with `mf mcp add spotted <APP_URL>/mcp --scope project --header "Authorization: Bearer $(pbpaste)" --agent-id agt_…` (Manyfold has no per-agent secrets; the key lives in the MCP server's header). Keep `--scope project`: the default scope writes `~/.claude.json`, which every agent on the same Manyfold sandbox shares, so the last key added would win for all of them (seen on 1 Oct: Triage ran with the Checker's key), press Connect with Manyfold and approve, then Run now.

Scout's memory (migration `0005_scout_sources.sql`, `src/db/scout.ts`):

- **Sources** (`scout_sources`): listing sites, venue pages, brand sites, social accounts and web searches, each checked every N days. Scout reads them with `list_sources` and marks them with `mark_source_checked`. Scout can only `suggest_source`; suggestions wait in **Scout sources** on /admin/agent, where the admin turns sources on, pauses them, adds new ones and sets how often each is checked (API: `/api/v1/admin/agents/sources`). `GET` lists them with a track record (drafts sent, published, rejected) counted from the drafts themselves.
- **Pages already read** (`scout_seen`): `check_seen` tells Scout which pages it read in the last 30 days, `skip_url` records why a page was not sent. Skipped pages are purged after 90 days; pages that led to drafts stay for the track record.
- **Extra links** (`popup_links`): a draft can carry up to 5 more links (brand site, venue, tickets, Instagram, TikTok, Xiaohongshu). Instagram and Threads posts are fetched for Scout through Apify (see below) and arrive as leads, found alongside web searches; Scout never logs in itself, and confirms details on a page it can read.

A run counts as done only when the agent reports back with `finish_run`. A turn that ends without it is marked failed, which usually means the agent's `spotted` MCP server is missing or carries another agent's key.

When a Manyfold token expires or is revoked, runs fail with "Manyfold rejected the agent token"; press Connect again on that agent.

## Ask for recommendations (Concierge)

A visitor types what they want ("something free and a bit weird this weekend near Shoreditch") and gets up to 5 real pop-ups back with a reason each. Anyone can ask, signed in or not. Design and the measured wait: `docs/superpowers/specs/2026-10-08-ask-recommendations-design.md`.

- **Flow**: `POST /api/v1/ask {text, taste?, near_me?, turnstile_token?}` stores the question in `asks` and starts the Concierge over A2A (not waiting). The page polls `GET /api/v1/ask/:id` every 2 seconds; each poll asks Manyfold how the task is doing, at most once every 1.5 seconds. `GET /api/v1/ask/status` says whether Ask is on, whether it is resting and how many questions this visitor has left.
- **The agent can only read**: a Concierge has the public `search_popups` and `get_popup` tools and no Spotted key. It replies with JSON, and Spotted keeps only the pop-ups that are in the public list at that moment. Reasons lose web addresses. The question, the taste summary and pop-up text are data for the agent, never instructions; the brief says so, and the agent's skill (section Concierge) repeats it.
- **The page**: an **Ask** chip, first in the chip row, opens a full-screen panel (`web/src/components/AskPanel.tsx`). It only shows while a Concierge is on. The question and the answer live in memory on the device; polling runs in `web/src/lib/ask.ts`, so closing the panel while the agent thinks loses nothing and the chip gets a dot when the answer is ready. Until the answer comes (and when it cannot) the panel shows what the filters and For you would pick for the words in the question (`src/shared/ask-quick.ts`), so it is never a blank wait.
- **Privacy**: only a short summary of the taste goes along (liked and left-out categories, and whether free entry is liked; `tasteSummary` in `src/shared/taste.ts`). The position never leaves the browser; `near_me` only says the browser can order by distance, and the agent answers `near: true` when the request was about where you are, so the browser puts the nearest first. The question is kept 7 days with a salted hash of the IP, never the IP.
- **Limits** (counted from the `asks` table, no KV writes): 5 questions per visitor per London day, 150 for everyone (`ASK_DAILY_CAP`, optional variable, `0` switches Ask off), Turnstile on a visitor's first question of the day, 90 seconds to answer. At a limit the API answers 429 or 503 with a message the page shows; nothing else on the page changes.
- **Cost**: every question is one model turn on Manyfold (Sonnet 5.5, high effort in the first tests). Lower `ASK_DAILY_CAP` if that matters.

One-time setup:

1. Apply the migration: `npx wrangler d1 migrations apply spotted-db --remote` (0018 adds the `concierge` role and the `asks` table). Do this before merging the pull request; the code deployed now keeps working with the new schema.
2. In Manyfold, create an agent for it on its **own sandbox** (it reads text typed by anonymous visitors) and give it the public tools with no key: `mf mcp add spotted <APP_URL>/mcp --scope project --agent-id agt_…`.
3. On /admin/agent press **Concierge** under Add another, press Connect with Manyfold, approve that agent, and switch it on. Ask shows for visitors only while a Concierge is on.

## "For you" taste on your account

- The taste ("For you", the 10 swipes) is used from the browser, in `localStorage` key `spotted.taste`, so it works signed out and offline. Signed-out people never send it anywhere.
- Signed-in people also keep a copy on the account, so a new device gets it back: `GET /api/v1/me/taste` and `PUT /api/v1/me/taste {taste, base}` (table `user_taste`, migration 0020). `base` is the `updated_at` the browser last saw (0 for none); if the account moved on, the answer is 409 `taste_changed` with the current copy. The body is cleaned with `parseTaste` and capped at 256,000 characters. Deleting the account deletes the row.
- Which copy wins is `decideSync` in `src/shared/taste-sync.ts` (rules in its comment and in CLAUDE.md). In short: the whole taste, the more recent change wins; an empty device takes the account's; a first sign-in with picks and an empty account uploads them; signing out clears the device so a shared browser starts empty.
- The public list and snapshot are the same for everyone and carry no taste.
- Migration 0020 is a new table only. Run it before merging: `npx wrangler d1 migrations apply spotted-db --remote`. The code deployed now never reads the table, and the new code answers 503 on `/me/taste` (and still deletes accounts) if it runs first.

## Instagram and Threads posts (Apify)

Scout can read public Instagram and Threads posts that Spotted fetches for it. Add sources on `/admin/agent` under Scout sources, kind Social, with a real address:

| Address | What is fetched |
| --- | --- |
| `https://www.instagram.com/<name>/` | an account's recent posts |
| `https://www.instagram.com/explore/tags/<tag>/` | a hashtag |
| `https://www.instagram.com/explore/locations/<id>/` | a place |
| `https://www.threads.net/@<name>` | a Threads account |

A cron job starts an Apify run for each source when it is due (the "How often" setting), keeps posts that talk about pop-ups, and stores them. Scout reads them with `get_social_posts`, confirms each on a brand or venue page, and sends drafts. Cost is capped at US$4 in any 30 days (the Apify free plan gives US$5 a month); fetching stops at the cap and the screen shows the spend. Each run is also capped on Apify's side by items, charge and time.

Turn it on:

1. Make a free account at apify.com, then Settings, then API & Integrations, and copy the API token.
2. In a terminal in this folder run `npx wrangler secret put APIFY_TOKEN` and paste the token when asked.
3. Before merging a branch that adds migration 0006, run `npx wrangler d1 migrations apply spotted-db --remote`.
4. Add a few Social sources, then wait for the next 10 minute cron tick. Check `npx wrangler tail` if nothing appears.
5. Reinstall the updated skill on the Scout agent in Manyfold (SKILL.md is version 1.11.0).

Check the actors still return the fields we read (about US$0.05): `read -s APIFY_TOKEN && export APIFY_TOKEN && node scripts/apify-smoke.mjs; unset APIFY_TOKEN`.

## What is not built yet

- Emails other than sign-in: newsletter confirmation and reminders are found by the jobs but not sent yet.
- Vote ring detection in the daily abuse scan.
- Photo uploads by people other than the poster, and an image moderation step.

## Production

Live at **https://spotted-london.zack11712.workers.dev** (Cloudflare account zack11712@gmail.com).

| Resource | Name | Notes |
|---|---|---|
| Worker | `spotted-london` | cron: every 10 min, hourly, daily 04:00 UTC |
| D1 | `spotted-db` (WEUR) | id in `wrangler.jsonc` |
| KV | `CACHE` | autofill cache and rate limits |
| R2 | `spotted-images` (WEUR) | photos, served through `/api/v1/images/...` |
| Turnstile | "Spotted London" | site key in `wrangler.jsonc`, secret in `TURNSTILE_SECRET` |
| Secrets | `IP_SALT`, `TURNSTILE_SECRET`, `AGENTS_KEY` | set with `wrangler secret put`, never in the repo |

### How deploys happen

The Worker is connected to this repo with **Cloudflare Workers Builds** (no GitHub Actions). Settings live in the dashboard under Workers & Pages → spotted-london → Settings → Build:

| Setting | Value |
|---|---|
| Git repository | `tldr0810/spotted-london` |
| Production branch | `main` |
| Build command | `npm ci && npm run build:web` |
| Deploy command | `npx wrangler deploy` |
| Non-production branches | preview builds on, deploy command `npx wrangler preview` (uses the `previews` block in `wrangler.jsonc`) |
| Build variable | `NODE_VERSION=22` |

- A push to `main` builds and deploys production.
- A push to any other branch makes a preview version. Previews use the **same** D1, KV and R2 as production. They take their vars and bindings from the `previews` block in `wrangler.jsonc`, so a new binding or var goes in both places. Previews have no secrets and a different address, so you are signed out there and sign in, adding a pop-up and reporting do not work. Browsing does.
- The build token cannot touch D1. When a change adds a file to `migrations/`, apply it from a computer signed in with wrangler **before** merging: `npx wrangler d1 migrations apply spotted-db --remote`. Migrations must stay backwards compatible with the code already running.

Manual deploy from a computer, if ever needed:

```bash
npm run deploy                                                        # build web/ and deploy
npx wrangler d1 migrations apply spotted-db --remote                  # after adding a migration
npx wrangler tail                                                     # live logs
```

### Example data

The live site had fictional pop-ups marked **Example** (`is_example = 1`) until 2026-10-02, when they were removed with `seed/clear-examples.sql`. The column and the label stay. Their accounts used `@example.invalid` addresses, so nobody could sign in as them. To load examples again, regenerate with `python3 scripts/seed.py` and run the first command below.

```bash
npx wrangler d1 execute spotted-db --remote --file=./seed/examples.sql        # load
npx wrangler d1 execute spotted-db --remote --file=./seed/clear-examples.sql  # remove again
```

### Still to switch on

- **Sign in**: add `RESEND_API_KEY` and `EMAIL_FROM` (email links) and/or `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Until then the site is browse-only.
- **Custom domain**: add it to the Worker, update `APP_URL`, and add the domain to the Turnstile widget.
