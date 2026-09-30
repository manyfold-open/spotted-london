# Spotted London

London pop-ups, added by locals and verified by the community. Cloudflare Workers + D1 + R2 + KV, all on the free tier.

- Product and technical spec: [SPEC.md](SPEC.md)
- Clickable UI prototype: [prototype/index.html](prototype/index.html)

## Run it locally

No Cloudflare account is needed for local development. D1, KV and R2 are simulated on your machine.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run db:seed
npm run dev
```

The API is at `http://localhost:8787/api/v1`. The seed has fictional pop-ups, and these users:

| id | role | notes |
|---|---|---|
| `dev_admin` | admin | can use the review queue |
| `dev_zack` | member | karma 58, vote weight 3.3x, trust 44 |
| `dev_new` | member | 12-hour-old account, votes weigh 0 |

In development you act as a user with the `x-dev-user` header. This only works when `ENVIRONMENT=development`, which comes from `.dev.vars` and is never set in production.

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

## Layout

```
src/
  index.ts          Hono app, error format, cron entry
  middleware.ts     session, admin checks, Turnstile, IP hashing
  cron.ts           end expired pop-ups, recompute hot, settle karma, reminders
  lib/scoring.ts    vote weight, Wilson confidence, status rules, trust, hot (SPEC 4)
  lib/extract.ts    paste-a-link autofill parsing (SPEC 3.8)
  lib/time.ts       Europe/London calendar maths
  lib/geo.ts        geohash, distances, London bounds
  db/popups.ts      recompute aggregates and status after every vote
  db/karma.ts       idempotent karma awards with the daily cap
  routes/           popups, extract, me, admin, newsletter, images, users
migrations/         D1 schema
seed/seed.sql       local example data
```

## What is not built yet

- Sign in (Google and email magic link). The session table and cookie check exist; the flows do not.
- Workers AI for autofill. Link parsing works without it (JSON-LD and Open Graph). Pasted text and screenshots need `npx wrangler login` and the `ai` binding in `wrangler.jsonc`.
- Emails: newsletter confirmation and reminders are found by the jobs but not sent yet.
- Vote ring detection in the daily abuse scan.
- The web front end. The prototype shows the intended UI.

## Deploy (later)

```bash
npx wrangler login
npx wrangler d1 create spotted-db    # then put the id in wrangler.jsonc
npx wrangler d1 migrations apply spotted-db --remote
npx wrangler secret put IP_SALT
npx wrangler deploy
```
