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
  cron.ts           end expired pop-ups, recompute hot, settle karma, reminders
  lib/scoring.ts    vote weight, Wilson confidence, status rules, trust, hot (SPEC 4)
  lib/extract.ts    paste-a-link autofill parsing (SPEC 3.8)
  lib/time.ts       Europe/London calendar maths
  lib/geo.ts        geohash, distances, London bounds
  db/popups.ts      recompute aggregates and status after every vote
  db/karma.ts       idempotent karma awards with the daily cap
  routes/           auth, popups, extract, geocode, me, admin, newsletter, images, users
  services/email.ts sending through Resend
migrations/         D1 schema
seed/seed.sql       local example data
web/src/
  main.tsx          routes
  components/       Shell (sidebar, top bar, tabs), PopupSheet, cards, maps, icons
  pages/            Explore, MapPage, Submit, Account (Saved, Me, Sign in, Review queue)
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
| Secrets | `IP_SALT`, `TURNSTILE_SECRET` | set with `wrangler secret put`, never in the repo |

### How deploys happen

The Worker is connected to this repo with **Cloudflare Workers Builds** (no GitHub Actions). Settings live in the dashboard under Workers & Pages → spotted-london → Settings → Build:

| Setting | Value |
|---|---|
| Git repository | `tldr0810/spotted-london` |
| Production branch | `main` |
| Build command | `npm ci && npm run build:web` |
| Deploy command | `npx wrangler deploy` |
| Non-production branches | preview builds on (default preview command) |
| Build variable | `NODE_VERSION=22` |

- A push to `main` builds and deploys production.
- A push to any other branch makes a preview version. Previews use the **same** D1, KV and R2 as production.
- The build token cannot touch D1. When a change adds a file to `migrations/`, apply it from a computer signed in with wrangler **before** merging: `npx wrangler d1 migrations apply spotted-db --remote`. Migrations must stay backwards compatible with the code already running.

Manual deploy from a computer, if ever needed:

```bash
npm run deploy                                                        # build web/ and deploy
npx wrangler d1 migrations apply spotted-db --remote                  # after adding a migration
npx wrangler tail                                                     # live logs
```

### Example data

The live site has fictional pop-ups marked **Example** (`is_example = 1`), hidden from search engines. Their accounts use `@example.invalid` addresses, so nobody can sign in as them. Regenerate with `python3 scripts/seed.py`.

```bash
npx wrangler d1 execute spotted-db --remote --file=./seed/examples.sql        # load
npx wrangler d1 execute spotted-db --remote --file=./seed/clear-examples.sql  # remove before launch
```

### Still to switch on

- **Sign in**: add `RESEND_API_KEY` and `EMAIL_FROM` (email links) and/or `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Until then the site is browse-only.
- **Custom domain**: add it to the Worker, update `APP_URL`, and add the domain to the Turnstile widget.
