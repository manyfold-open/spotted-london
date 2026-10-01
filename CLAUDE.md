# Spotted London

London pop-up discovery platform: anyone adds a pop-up, the community verifies it with weighted votes and check-ins (Reddit-style), admins can override. Mobile first.

- Product and technical spec (Chinese): [SPEC.md](SPEC.md). Decisions are logged in SPEC §12.
- Design system: [docs/DESIGN.md](docs/DESIGN.md). Source of truth is `web/src/styles.css`.
- Setup, commands and production facts: [README.md](README.md).
- Original clickable prototype: `prototype/index.html` (published as a claude.ai artifact).

## Working with Zack

- Zack writes in casual Traditional Chinese (Taiwan). Reply in Traditional Chinese. Code, commits, UI copy and docs other than SPEC.md are in English.
- Zack is the product owner, not a Cloudflare or Google Console expert. When a step needs their account (dashboards, billing, OAuth consoles), give numbered click-by-click steps.
- Never ask Zack to paste secrets into chat. Secrets go in with `npx wrangler secret put NAME` or the Cloudflare dashboard (Workers → spotted-london → Settings → Variables and Secrets, type Secret).
- Confirm before anything outward-facing or hard to undo: production DB writes, deleting resources, changing Google OAuth publishing status.

## Stack

- One Cloudflare Worker (`src/`, Hono) serves the API under `/api/v1`, a few server pages, and the SPA from `web/dist` as static assets.
- D1 (SQLite) for data, KV for autofill cache and rate limits, R2 bucket `spotted-images` for photos, Cron Triggers for background jobs, Turnstile for bot checks.
- Web app in `web/`: Vite + React 19, React Router 8 (library mode), TanStack Query, MapLibre + OpenFreeMap tiles. No SSR: `/p/:slug` gets SEO/Open Graph/schema.org tags injected by the Worker with HTMLRewriter.
- Free tier only. Workers Free has about 10 ms CPU per request, so keep request handlers light and push heavy work into cron.

## Commands

```bash
npm install                  # root + web/ (postinstall)
npm run db:reset             # local D1: migrate + seed
npm run build:web            # needed once before `npm run dev`; the Worker serves web/dist
npm run dev                  # Worker on :8787 (needs `npx wrangler login` for Workers AI)
npm run dev:local            # same without a Cloudflare login; AI autofill returns an error
npm run dev:web              # Vite on :5173, proxies /api and /login to :8787
npm test                     # builds web, then vitest inside workerd (unit + API tests)
npm run typecheck && (cd web && npx tsc --noEmit)
npm run deploy               # build web + wrangler deploy (production)
python3 scripts/seed.py      # regenerate seed/*.sql
```

Local dev signs you in through the page at `/signin` (the magic link is shown on screen when no email provider is set) or with the `x-dev-user: dev_zack` header. Dev-only headers (`x-dev-user`, `x-now`, `x-dev-ip`) work only when `ENVIRONMENT=development`, which only `.dev.vars` sets.

## Code map

```
src/index.ts            Hono app, error format { error: { code, message } }, cron entry
src/middleware.ts       session cookie (sha256 stored), CSRF origin check, Turnstile, IP hash
src/lib/scoring.ts      ALL verification rules: vote weight, Wilson, status transitions, trust, hot, karma table
src/lib/extract.ts      paste-a-link autofill parsing (JSON-LD, Open Graph, LLM prompt/schema)
src/lib/time.ts         Europe/London calendar maths (BST safe)
src/db/popups.ts        recompute(): aggregates + status after every vote/check-in/report
src/db/karma.ts         awardKarma(): idempotent per (user, reason, ref), daily cap
src/routes/*.ts         auth, popups, extract, geocode, me, admin, misc (newsletter, images, users)
src/pages.ts            magic-link confirm page, SEO injection for /p/:slug
src/cron.ts             end expired, recompute hot, settle karma, purge, reminders (stub), start/check agent runs
src/mcp.ts              MCP server at POST /mcp: public search tools, agent tools behind a per-agent key
src/db/agents.ts        AI agents on Manyfold (Scout, Triage, Checker): schedules, briefs, run life cycle
src/db/scout.ts         Scout's memory: sources to check, pages already read, extra links per pop-up, track records
src/lib/a2a.ts          A2A client: start a Manyfold task, check it with tasks/get, probe a token
src/lib/manyfold.ts     "Connect with Manyfold": Connect A2A device-code sign-in (start, poll) that returns an agent's A2A address and token
skills/spotted-london/  SKILL.md the Manyfold agents install from GitHub; keep it in step with the MCP tools
migrations/             D1 schema, applied in order
test/                   vitest-pool-workers tests; api.test.ts and auth.test.ts cover whole flows
web/src/components/     Shell (sidebar, top bar, bottom tabs), PopupSheet, PopupBits, maps, Icon, Turnstile
web/src/pages/          Explore, MapPage (lazy), Submit, Account (Saved, Me, SignIn, AdminQueue), Agents (lazy, /admin/agent)
```

## Rules that are easy to break

- Scoring thresholds live in `src/lib/scoring.ts`. `web/src/components/PopupSheet.tsx` mirrors two of them for the checklist UI; change both.
- Never do maths in SQL (no log/sqrt in D1). Compute in JS, store in cached columns.
- Every karma change goes through `awardKarma` so it stays idempotent and capped.
- Times are Unix ms. "Today" and "weekend" are London days: use `src/lib/time.ts` / `web/src/lib/format.ts`.
- The dev fallback that returns sign-in links in the response must stay development only.
- Agents only write drafts (`pending`) and notes. Never give an MCP tool the power to approve, remove, vote or edit a live pop-up.
- Agent secrets are write-only: the Manyfold token is sealed with `AGENTS_KEY`, Spotted keys are stored as SHA-256, and the API returns only the last four characters.
- Changing an MCP tool's name or inputs means updating `skills/spotted-london/SKILL.md` and `AGENT_INFO` in `src/db/agents.ts`.
- Pop-up sheet is `?p=<slug>` on list pages; shared links are `/p/<slug>`.
- UI copy: plain English, no em dashes, en dashes or spaced hyphens. Errors say what happened and what to do.
- Icons: Koboyo hand-drawn SVGs (koboyo.com/icons), filled paths with `fill: currentColor`. Add new ones to `web/src/components/Icon.tsx` with coordinates rounded to whole numbers first (`npx svgo --precision 0 icon.svg`); that halves the path data and is invisible at our sizes. Licence forbids letting users pick or download icons.
- No native browser UI: dates use `web/src/components/DatePicker.tsx`, forms use `noValidate` with our own `.ferr` messages, and inputs are 16 px on phones so iOS does not zoom.
- Phone layout is under 900 px (`@media (max-width: 899px)`): bottom tabs, bottom sheets. Check every screen at 375 px.

## Gotchas

- npm 10 crashes resolving vitest peers: `.npmrc` sets `legacy-peer-deps=true` (root and web/).
- `compatibility_date` is 2026-08-20 because `@cloudflare/vitest-pool-workers` bundles an older workerd. Raise it only together with that package.
- MapLibre v6 must get its worker via `setWorkerUrl` from `maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` (see `web/src/components/maps.tsx`), or the map stays blank.
- Map pins are plain DOM, not React roots (unmounting roots during render caused races).
- Branch builds run `wrangler preview`, which reads only the `previews` block in `wrangler.jsonc`. Add every new var or binding there too, or preview builds fail.
- Tests never reach Cloudflare: `vitest.config.ts` sets `remoteBindings: false` and `test/setup.ts` swaps `env.AI` for a stub; mock `env.AI.run` per test.
- After `npm run build:web`, a running `wrangler dev` can serve 404s for every page. Restart it.
- Tests share one D1 per file, so give each test its own titles and coordinates or the duplicate check (same place, similar title) returns 409.
- Address search uses Photon (photon.komoot.io), a free fair-use service. Move to Mapbox's free tier if traffic grows.
- On Zack's first Mac, `~/.zshrc` exports a `CLOUDFLARE_API_TOKEN` for a different (work) Cloudflare account. If `npx wrangler whoami` does not say zack11712@gmail.com, run `unset CLOUDFLARE_API_TOKEN` in that shell first.

## Production

Deploys run on Cloudflare Workers Builds (connected 2026-09-30), linked to this repo (no GitHub Actions minutes available). Push to `main` deploys production; other branches get preview versions that share production D1/KV/R2. Work on a branch and open a PR; Zack merges. The build token has no D1 access: if a PR adds a migration, say so in the PR and ask Zack to run `npx wrangler d1 migrations apply spotted-db --remote` before merging (migrations must not break the currently deployed code). Build settings are listed in README "How deploys happen".

- https://spotted-london.zack11712.workers.dev, Cloudflare account zack11712@gmail.com (`d6f9da63682de8b145e22e38bc511416`).
- Admin: zack11712@gmail.com (promoted 2026-09-30, recorded in audit_log).
- Secrets set: `IP_SALT`, `TURNSTILE_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AGENTS_KEY`.
- AI agents run on Manyfold (not Cloudflare), set up at /admin/agent. See README "AI agents and MCP". Scout, Triage and Checker were connected and tested on 1 Oct 2026; all three share Manyfold sandbox-008, so each agent's key must be added with `mf mcp add ... --scope project` (the default scope is shared by the whole sandbox).
- Google OAuth app is in Testing mode: only Test users added in Google Cloud Console can sign in.
- Live data is fictional examples (`is_example = 1`, labelled, noindex). Clear before launch with `seed/clear-examples.sql`.

## Status and next steps

Done: API, verification and karma, admin queue, email + Google sign in, web app, deploy, Turnstile, examples, photos on R2, Workers AI autofill from links, pasted text and screenshots, MCP server, Manyfold agents (Scout, Triage, Checker) with the /admin/agent settings page, Scout source list and memory (API only, migration 0005).

Not done yet, roughly in priority order:
1. Email: Resend for magic links, newsletter confirmation and reminder emails (cron finds reminders but does not send).
2. Hide quality votes on your own posts in the UI (the API already rejects them).
3. Vote ring detection in the daily abuse scan.
4. Custom domain, then move Google OAuth to production and add the domain to Turnstile.
5. Scout sources in the web app: a Sources tab on /admin/agent (API is at /api/v1/admin/agents/sources), extra links on the pop-up sheet and in Submit.
6. Reduce the main bundle further (about 142 KB gzip after rounding icon paths; React, React Router and TanStack Query are most of it).
