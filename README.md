# Spotted London

London pop-ups, added by locals and verified by the community. Cloudflare Workers + D1 + R2 + KV, all on the free tier.

- Product and technical spec: [SPEC.md](SPEC.md)
- Clickable UI prototype: [prototype/index.html](prototype/index.html)

## Run it locally

No Cloudflare account is needed for local development. D1, KV and R2 are simulated on your machine.

```bash
npm install                 # also installs web/
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run db:seed
npm run build:web           # the Worker serves web/dist, so build once
npm run dev                 # terminal 1: Worker + API on :8787
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

- Workers AI for autofill. Link parsing works without it (JSON-LD and Open Graph). Pasted text and screenshots need `npx wrangler login` and the `ai` binding in `wrangler.jsonc`.
- Emails other than sign-in: newsletter confirmation and reminders are found by the jobs but not sent yet.
- Vote ring detection in the daily abuse scan.
- Photo uploads by people other than the poster, and an image moderation step.

## Deploy (later)

```bash
npx wrangler login
npx wrangler d1 create spotted-db    # then put the id in wrangler.jsonc
npx wrangler d1 migrations apply spotted-db --remote
npx wrangler secret put IP_SALT
npx wrangler deploy
```
