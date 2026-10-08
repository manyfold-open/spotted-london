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
src/db/snapshot.ts      the public list as one row in `snapshots` (key 'popups'): built by cron and by waitUntil when a pop-up enters or leaves the public set; GET /popups/snapshot sends it as stored
src/shared/             plain TS used by both the Worker and web/ (imported by relative path): filterPopups (the browser-side twin of listPopups; test/snapshot.test.ts keeps them equal), my-state, categories (the one list of pop-up categories), taste ("For you": learn from swipes, learn from saves and votes (setActs, syncActions, forgetSwipes), affinity, forYou order, pickDeck; tested in test/taste.test.ts)
src/db/karma.ts         awardKarma(): idempotent per (user, reason, ref), daily cap
src/routes/*.ts         auth, popups, extract, geocode, me, admin, misc (newsletter, images, users)
src/pages.ts            magic-link confirm page, SEO injection for /p/:slug
src/cron.ts             end expired, hourly recompute hot (writes only rows that moved 0.01+), settle karma, purge, reminders (stub), start/check agent runs, fetch Instagram/Threads posts
src/mcp.ts              MCP server at POST /mcp: public search tools, agent tools behind a per-agent key
src/db/publish.ts       publish what agents verified (batch or auto), undo by agent, per-agent publish stats, the auto_publish setting
src/db/agents.ts        AI agents on Manyfold, many per role (scout, triage, checker, concierge): schedules, briefs, run life cycle
src/lib/ask.ts          Ask, pure parts: clean the question, taste summary, the brief for the Concierge, read and check its answer (tested in test/ask.test.ts)
src/db/ask.ts           Ask: the `asks` table, limits counted from it, start the agent, poll it, purge, admin stats
src/routes/ask.ts       POST /ask, GET /ask/status, GET /ask/:id (public, no sign-in)
src/shared/ask-messages.ts  the limit and resting messages, one copy for the Worker and the page; ask-quick.ts: what Ask shows while the agent thinks (tested in test/ask-quick.test.ts)
src/db/scout.ts         Scout's memory: sources to check, pages already read, extra links per pop-up, track records
src/db/social.ts        Instagram/Threads posts for Scout: Apify runs (start, check), budget cap, pause on failures, post queries
src/lib/social.ts       pure helpers: source address to actor input, item parsing, keyword filter, cost constants
src/lib/apify.ts        minimal Apify REST client (token in the Authorization header only)
src/lib/a2a.ts          A2A client: start a Manyfold task, check it with tasks/get, probe a token
src/lib/manyfold.ts     "Connect with Manyfold": Connect A2A device-code sign-in (start, poll) that returns an agent's A2A address and token
skills/spotted-london/  SKILL.md the Manyfold agents install from GitHub; keep it in step with the MCP tools
migrations/             D1 schema, applied in order
test/                   vitest-pool-workers tests; api.test.ts and auth.test.ts cover whole flows
web/src/components/     Shell (menu + bar per route), TopBar, NavMenu, MapSheet, ListBits (usePopups, Filters), PopupSheet, PopupBits, maps, Icon, Turnstile
web/src/pages/          HomePage (full-screen map + list, `/`, `/p/:slug`; `/map` redirects here), Submit, Account (Saved, Me, SignIn, AdminQueue), Agents (lazy, /admin/agent, with ScoutSources)
web/src/lib/            map-home (pure: sheet snap, away check, location start; tested in test/map-home.test.ts), near-me (useNearMe), taste (localStorage `spotted.taste` store, useTaste), ask (in-memory store: sends the question, polls, `useAskStatus`)
```

## Agent fleet (quantity first, quality later)

Direction set by Zack on 2026-10-01: add an agent pipeline next to the existing flow, with many Scouts finding pop-ups and many Checkers verifying them, and cut human review to the cases that need a person. Nothing about the community changes: anyone can still submit, votes and check-ins still decide `verified_community`, and the trust rules for human posts stay as they are. Volume comes first, then quality is tightened. The agent count is not a constraint (Manyfold can host 10 Scouts and 5 Checkers or more); Apify's US$4 per 30 days and the shared sandbox load are.

- **Who schedules a run.** A run starts either from Spotted (`dispatchDue` in the Worker cron, or Run now, over A2A with a brief that already holds a `run_id`) or from a Manyfold automation (`mf automations`), whose fixed prompt tells the agent to call `start_run`. `start_run` creates the `agent_runs` row (trigger `schedule`, no task id) or returns the agent's open one, and returns the same brief text. An agent scheduled on Manyfold has `manyfold_scheduled = 1` (migration 0013) and keeps the same `schedule` and `run_hour` as its automation. Spotted then only backs it up: `dispatchDue` waits `BACKUP_GRACE` (30 minutes) past the slot and starts the agent over A2A, with `agent_runs.via = 'fallback'`, only if no run began from 20 minutes before the slot onward. This covers Manyfold failing to wake a stopped sandbox (`runner_unavailable`). A run from `start_run` has `via = 'manyfold'`. Keep the automation's times and the agent's `schedule`/`run_hour` in step. Such a run has no A2A task, so `checkRuns` only fails it after `RUN_TIMEOUT`; `finish_run` is what closes it.
- **Many instances per role (done, migration 0008).** `agents.role` says what an agent does, `agents.id` is free text (`scout`, `triage`, `checker` stay as the first three, new ones are `<role>-<6 chars>`), and the admin adds more on /admin/agent. Each instance has its own key, schedule, `max_items` and focus text (for example a Scout for listing sites, one for venues, one for social posts). Skill text is shared, so keep SKILL.md role-based, not instance-based.
- **Work is leased, never listed (done, migration 0009).** `list_sources` leases `scout_sources` to the calling agent for 90 minutes (`leased_to`, `lease_until`), and `list_review_queue` and `list_live_popups` lease `popups` for 60 minutes (`lease_agent`, `lease_until`), each with one UPDATE. Asking again returns what the agent already holds; `mark_source_checked` frees a source; an expired lease is free again. A note from any agent of a role takes a pop-up off every agent of that role. The rest of this bullet is the design: Scouts lease sources and Checkers lease pending drafts, with a lease that expires (manyfold-data uses 30 minutes), so two agents never take the same item. `list_sources` and the queue tools must not hand the same row to two runs.
- **Who verifies (done, migration 0010).** The Triage role verifies waiting posts: Scout drafts and posts from people that the trust rules left pending. The Checker role rechecks published pop-ups. A Triage `add_note` with `verdict: looks_real`, its own `evidence` quote (looked up by `src/lib/evidence.ts`), `dates_match` and `place_match` is stored with `publish_ready = 1` only if the server agrees: the post is pending, the quote was found on the page, it is not the agent's own post, no text is aimed at agents, and for a Scout draft the Scout's quote was found (the Scout's own `confidence` no longer decides, see the exception in the auto-publish rule). The reasons come back as `not_ready_because`. A person's post has no Scout quote, so for it the Triage quote and the two matches are the whole test.
- **Independence.** A Checker never checks a draft sent by its own instance, and re-opens the source itself instead of trusting the Scout's quote. It sends its own `evidence`, checked by the same `src/lib/evidence.ts`.
- **Auto-publish rule.** A draft is published as `community` (never `verified_admin`) only when all of these hold: for a Scout draft the Scout's `evidence_check` is `found`, the Triage agent's own evidence is `found` and its dates and place match the draft, and the post was not flagged as aimed at agents. Exception (Zack, 2026-10-03, volume first): the Scout saying `confidence: check` no longer blocks this. A ready Triage note resolves the Scout's own open note, and a draft that has exactly one Triage note, `looks_real` but not ready, while the Scout was unsure, comes back to `list_review_queue` once for a second look. Exception (Zack, 2026-10-02): a Scout draft sent before migration 0007 has no `evidence_check`, so for it the Scout quote and confidence checks are skipped and the Triage agent's own found quote decides (`isLegacyDraft` in `src/mcp.ts`). Such a draft comes back to `list_review_queue` once a day until a Triage note on it carries the agent's own quote (`evidence`); the new Triage note resolves the old one and, if ready, the Scout's note. Everything else goes to the admin queue. In `suggest` mode (the only mode built so far) the admin queue shows a "Publish N" button, `POST /admin/queue/publish-ready`, which re-checks each post and publishes it as `community` with a `popup.agent_publish` audit row naming the agents. Community votes and reports can still demote or hide a published draft.
- **Setting `auto_publish` (done, migration 0011).** Stored in `settings`, changed with `PUT /admin/agents/settings` or the Publishing switch on /admin/agent. `suggest` (default): the Triage agent only marks a post "ready to publish" and the admin confirms the batch with one button. `auto`: `add_note` publishes at once through `publishReady()` in `src/db/publish.ts`, with the agent's own user id on the audit row (`via: auto`). Turn it on once the posts you publish by hand rarely need changing.
- **Undo by agent (done).** `POST /admin/agents/:id/undo {hours}` puts back in the review queue (status `pending`, not `hidden`, because `nextStatus` turns `hidden` back into `community`) every pop-up that agent's work made public in that time: those it marked ready and had published (found through the `popup.agent_publish` audit rows), and those it drafted itself that are `community`. A pop-up that people voted on or whose status changed is listed in `skipped` and left alone. Each undo writes `popup.agent_publish_undo`.
- **Review queue clears itself (Zack, 2026-10-04; migration 0017).** The queue had 71 waiting posts, 46 of them held by a Triage `needs_check` over a detail (a price, a postcode, a sentence no page supports). Goal: a person sees only what needs a person, a few a day. Everything below is in `add_note` (`src/mcp.ts`), with the helpers in `src/lib/triage.ts` and `src/db/triage.ts`, and every change writes an audit row naming the agent with the old values (`popup.agent_fix`, `popup.agent_remove`, `popup.agent_end`).
  - **`fixes`** (verdict `looks_real` only): `remove_text` cuts pieces of the description that no page supports, `clear` blanks `price_text`/`hours_text`, `set` changes `address`, `price_text`, `hours_text`, `start_date`, `end_date` to what the page says. A `set` needs the agent's own evidence quote (found by Spotted) that states the new value, worded the same; a date quote is matched by `dateOnPage`, and a date moves at most 7 days. Triage may fix `pending` posts, Checker `community` ones. Never a post with votes, an admin-verified one, one aimed at agents, or the agent's own. Title and map position are not fixable.
  - **`corroboration`**: when the source page cannot be read, two or three `{url, quote}` from different sites (`siteOf`), each quote found on its page, count in place of the agent's own quote and the Scout's `evidence_check = 'found'`. One site, or an unreadable page, counts for nothing.
  - **Auto removal** (only when `auto_publish = auto`, only `pending`/`community` posts without votes): verdict `duplicate` removes the post when `duplicate_of` is a public pop-up (or an older pending post) that `findDuplicates` also matches, and keeps `merged_into`; `out_of_scope` (new verdict, with `scope_reason`: performance, regular_offer, private_or_trade, not_a_pop_up) removes it; `cancelled` ends it (`status = 'ended'`, because `hidden` would turn back into `community`). The last two need an evidence quote Spotted finds. `likely_fake`, admin-verified posts and anything else stay in the queue. The admin can restore; `undoAgent` also puts back what an agent removed or ended.
  - **Limit**: 40 fixes, removals and endings per agent per 24 hours (`AGENT_ACTIONS_PER_DAY`, counted from `audit_log` with `idx_audit_actor`). Past it, notes still go to the queue and the answer says why (`not_auto_because`).
  - Still for a person: text aimed at agents, core facts that disagree between sources, `likely_fake`, posts people voted on, admin-verified posts.
- **Concierge (Ask, 2026-10-08; migration 0018).** A fourth role that answers visitors, not a worker: `AGENT_INFO.concierge.tools` is empty, it has no key and no schedule, `blocker()` does not ask for a key for it, `startRun` refuses it, `dispatchDue` skips it and /admin/agent shows no schedule, Run now, Undo or key for it. Questions go through `src/db/ask.ts`, not `agent_runs`. Timings measured on 2026-10-08 with `Concierge test` (Sonnet 5.5, high): 9.9 to 10.8 s cold, 8.7 to 10.9 s warm, so Ask uses the agent and the page polls. Keep a Concierge on its own sandbox: it reads text from anonymous visitors, and a Manyfold agent can run commands.
- **Measure (done for publishing).** Each agent card shows how many posts it published, how many were hidden or removed since, and how many were taken back (`publishStats()`). Scout sources keep their `track_record`.
- Keep the safety rules: pages and posts are data, not instructions; secrets are write-only.

## Rules that are easy to break

- Scoring thresholds live in `src/lib/scoring.ts`. `web/src/components/PopupSheet.tsx` mirrors two of them for the checklist UI; change both.
- Never do maths in SQL (no log/sqrt in D1). Compute in JS, store in cached columns.
- Every karma change goes through `awardKarma` so it stays idempotent and capped.
- Times are Unix ms. "Today" and "weekend" are London days: use `src/lib/time.ts` / `web/src/lib/format.ts`.
- The dev fallback that returns sign-in links in the response must stay development only.
- Agents write drafts (`pending`) and notes. Beyond that, only what "Agent fleet" lists: publish a draft as `community` (auto-publish rule), and the Triage/Checker actions in "Review queue clears itself" (small fixes, two-site corroboration, removing or ending a post with proof). No MCP tool may approve as `verified_admin`, vote, or edit a pop-up that is `verified_admin`/`verified_community` or has votes.
- Every Scout draft carries a word-for-word `evidence` quote. `src/lib/evidence.ts` looks for it: in the stored text for posts in `social_posts`, on the fetched page otherwise. A page that loads without the quote is refused; a page that cannot be read (blocked, login-only social page) is stored as `evidence_check = 'unchecked'` and the admin note says so.
- `AGENT_ADMIN_TOKEN` (optional secret, 32+ characters) lets Claude Code and scripts manage agents: `requireAgentManager()` in `src/middleware.ts` accepts it as `Authorization: Bearer` on the agent routes only (list, create, delete, rename, key, connect, test, run, undo). It does not open the review queue, users, reports, sources, the Publishing switch or note dismissal; those stay `requireAdmin`. Its calls are logged as the user `sys_agent_manager`, which has role `user` and cannot sign in. Keep any new admin route on `requireAdmin` unless it is about managing agents. To revoke: `npx wrangler secret delete AGENT_ADMIN_TOKEN`.
- Agent secrets are write-only: the Manyfold token is sealed with `AGENTS_KEY`, Spotted keys are stored as SHA-256, and the API returns only the last four characters.
- Changing an MCP tool's name or inputs means updating `skills/spotted-london/SKILL.md` and `AGENT_INFO` in `src/db/agents.ts`.
- The social fetcher (`src/db/social.ts`) never writes `scout_sources.due_at` or `last_checked_at`; those are Scout's clock. Its own clock is `social_runs`. The Apify cap (US$4 in any rolling 30 days) is `SOCIAL_MONTHLY_BUDGET_USD`; Instagram and Threads actors and prices live in `src/lib/social.ts`.
- The public list (`GET /popups`, `/popups/snapshot`) is the same for everyone and skips the session lookup: never put per-user data in it. Your saves and votes come from `GET /me/state` and are laid over the list in the browser (`mergeMe`). Change a list filter in both `listPopups` and `filterPopups`, or the old/new comparison test fails.
- Categories live only in `src/shared/categories.ts`. A new key needs, in the same change: a migration that rebuilds `popups` to widen its CHECK (SQLite cannot alter one, so park the rows in a copy table, drop `popups`, recreate it under the same name, insert the rows back and drop the copy, with `PRAGMA defer_foreign_keys = on`. Never rename: a rename leaves the deferred foreign-key violations raised by the drop uncleared and the commit fails once any child row exists. See `migrations/0014_categories.sql`), an icon symbol `c-<key>` in `Icon.tsx` and a `.pat-<key>` rule in `styles.css`. `test/categories.test.ts` and `test/category-assets.test.ts` fail when one is missing. The tie-break rules are in `skills/spotted-london/SKILL.md` and in the `submit_draft` category text in `src/mcp.ts`: keep them in step.
- `source_checked` (in the public list and the detail) is not a status: it is `SOURCE_CHECKED_SQL` in `src/db/popups.ts`, a Triage `publish_ready` note with no open flagging note. It only changes the label and pin of a `community` pop-up ("Source checked", green). Votes and check-ins still decide `verified_community`.
- `findDuplicates` ignores `removed` posts, so a person can add something again. Agents (`check_duplicates`, `submit_draft`) pass `removedSince` (30 days, `TURNED_DOWN_FOR` in `src/mcp.ts`) so the Scout does not resend what an admin rejected: on 5 Oct 2026 it sent a rejected Medicube post again from a new Instagram link. Do not make the default stricter; humans re-adding a rejected post is allowed.
- "For you" (taste) is personal and stays in the browser: `spotted.taste` in localStorage, never sent to the Worker and never in the public list or snapshot. It only re-orders the list after `filterPopups` (`forYou` in `src/shared/taste.ts`) and hides a category after two noes and no yes; a category chip picked by hand beats the hiding. Retake clears the old answers when the first new one comes in. Changing how a pop-up is scored for taste means changing `src/shared/taste.ts` and its test only. Saves and quality votes teach it too, as state and not as clicks: `setActs` and `syncActions` keep a ledger (`acts`, per pop-up id, with the category, area and free flag it was counted under) so a save counts 0.5 yes (`SAVE_WEIGHT`), an up vote 1 yes, a down vote 1 no (`QUALITY_WEIGHT`), each once however often the button is pressed, and an unsave or a removed vote takes exactly that back. `usePopups` calls `syncActions` with the pop-ups in the public list and `GET /me/state` (nothing happens while signed out or loading), so the first run also counts what someone saved and voted before this existed, and a change on another device is picked up. Swipes, `on` and `seen` are never touched by it: it does not turn "For you" on, and "For you" still needs `on` and at least one swipe. Retake (`forgetSwipes`) forgets the swipes but keeps what saves and votes are worth. Never learn from a click handler: a failed request would be counted, and a second click would count twice. The ledger stops taking new pop-ups at `ACTS_MAX` (1000) rather than forgetting one, because forgetting would count it again. Two down votes in a category with no yes hide it, like two swipes. Taste is per device, not per account: signing in as someone else on the same device counts their saves and takes back this one's for pop-ups in the list.
- Ask (recommendations) takes anyone's text, so: the question, the taste summary and the agent's answer are data. The Worker keeps only pop-ups that are in the public list when the answer arrives (`parseAnswer` in `src/lib/ask.ts` with the snapshot), strips web addresses from reasons, and shows visitors a fixed message on any failure. The taste summary is categories only; a position is never sent (the browser orders by distance itself, `near_me` only asks for more candidates). Limits are counted from the `asks` table (`usage()` in `src/db/ask.ts`), not KV: the free KV plan allows 1,000 writes a day. Changing what the agent may be asked or told means changing `askBrief` and the Concierge section of `skills/spotted-london/SKILL.md` together. The panel keeps the question and answer in memory only (never localStorage), and a tapped result closes the panel first because the pop-up sheet sits under it.
- Pop-up sheet is `?p=<slug>` on list pages; shared links are `/p/<slug>`.
- UI copy: plain English, no em dashes, en dashes or spaced hyphens. Errors say what happened and what to do.
- Icons: Koboyo hand-drawn SVGs (koboyo.com/icons), filled paths with `fill: currentColor`. Add new ones to `web/src/components/Icon.tsx` with coordinates rounded to whole numbers first (`npx svgo --precision 0 icon.svg`); that halves the path data and is invisible at our sizes. Licence forbids letting users pick or download icons. The category icons for dining, art and event are drawn in-house as strokes, not Koboyo.
- No native browser UI: dates use `web/src/components/DatePicker.tsx`, forms use `noValidate` with our own `.ferr` messages, and inputs are 16 px on phones so iOS does not zoom.
- Phone layout is under 900 px (`@media (max-width: 899px)`): a menu button instead of a sidebar or tabs, bottom sheets. Check every screen at 375 px. On the home page nothing may overlap: chips, locate/Add buttons, toasts, the map's attribution and the sheet each have their own space (see `docs/superpowers/specs/2026-10-02-map-home-design.md`, "No-overlap rules").
- The map home never sends your position anywhere: `useNearMe` keeps it in memory, `localStorage spotted.near` only remembers whether you agreed. Map chrome uses `mp-` class names because `.drawer`, `.scrim`, `.panel`, `.me`, `.nav` mean other things.

## Gotchas

- D1 free tier: 5,000,000 rows read and 100,000 rows written a day, reset at 00:00 UTC. On 2026-10-03 we reached 92% before the reset (unindexed `agent_notes` lookups in the agent leases, now `idx_agent_notes_popup`). Rules that keep us under: every lookup inside a loop or a lease needs an index (`EXPLAIN QUERY PLAN`, see test/agents.test.ts "query plans"); server code does not scan `popups` per call when the snapshot can answer (the MCP `search_popups` reads `snapshotItems()`, about 1 row per call); an agent publishing does not rebuild the snapshot, the 10 minute cron does. Check usage with `npx wrangler d1 info spotted-db --json` and `npx wrangler d1 insights spotted-db --sort-by reads`. Steady state after the fixes was about 90,000 reads an hour. The snapshot row is capped at 1.5 MB (about 2,000 live pop-ups at 745 bytes each).

- npm 10 crashes resolving vitest peers: `.npmrc` sets `legacy-peer-deps=true` (root and web/).
- `compatibility_date` is 2026-08-20 because `@cloudflare/vitest-pool-workers` bundles an older workerd. Raise it only together with that package.
- MapLibre v6 must get its worker via `setWorkerUrl` from `maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` (see `web/src/components/maps.tsx`), or the map stays blank.
- Map pins are plain DOM, not React roots (unmounting roots during render caused races).
- Never use the CSS `scale`, `rotate` or `translate` properties on a map marker to grow or tilt it (hover, highlight). MapLibre places markers with an inline `transform`, these properties apply before it, so `scale: 1.3` multiplies the pin's offset from the map corner and the pin is drawn in the wrong place, drifting as you pan. Change `width`/`height` instead (see `.pinm.hl`).
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
- Secrets set: `IP_SALT`, `TURNSTILE_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AGENTS_KEY`. Optional: `AGENT_ADMIN_TOKEN` (see Rules), also kept in `~/.config/spotted-london/agent-admin-token` (mode 600) for Claude Code.
- Optional secret `APIFY_TOKEN` (not set yet): turns on Instagram and Threads fetching for Scout. Free Apify plan, US$5 a month; we cap at US$4 in any 30 days. Posts and runs are in `social_posts` and `social_runs` (migration 0006).
- AI agents run on Manyfold (not Cloudflare), set up at /admin/agent. See README "AI agents and MCP". Scout, Triage and Checker were connected and tested on 1 Oct 2026; all three share Manyfold sandbox-008, so each agent's key must be added with `mf mcp add ... --scope project` (the default scope is shared by the whole sandbox).
- Google OAuth app is in Testing mode: only Test users added in Google Cloud Console can sign in.
- The fictional examples (`is_example = 1`) were cleared on 2026-10-02 with `seed/clear-examples.sql`, so production holds only real pop-ups. The column and the Example label stay.

## Status and next steps

Done: API, verification and karma, admin queue, email + Google sign in, web app, deploy, Turnstile, examples, photos on R2, Workers AI autofill from links, pasted text and screenshots, MCP server, Manyfold agents (Scout, Triage, Checker) with the /admin/agent settings page, Scout source list and memory (migration 0005) with a Scout sources section on /admin/agent, Instagram and Threads post fetching through Apify (migration 0006, needs the `APIFY_TOKEN` secret).

Not done yet, roughly in priority order:
0. Agent fleet (see "Agent fleet"): built in migrations 0007 to 0011 (evidence check, many agents, leases, Triage verification, auto_publish and undo). Next: watch the numbers, then raise quality (stricter conditions, a second Triage opinion, sampling published posts).
1. Email: Resend for magic links, newsletter confirmation and reminder emails (cron finds reminders but does not send).
2. Hide quality votes on your own posts in the UI (the API already rejects them).
3. Vote ring detection in the daily abuse scan.
4. Custom domain, then move Google OAuth to production and add the domain to Turnstile.
5. Show a pop-up's extra links (`popup_links`) on the pop-up sheet, and let Submit take more than one link.
6. Taste, next steps (decided 2026-10-08 with Zack): sync the taste to the account (needs a migration and `DELETE /me` must remove it), then tags from Scouts for finer taste than the 11 categories. Learning from saves and votes is done (see the "For you" rule). "Ask" (recommendations through a Concierge agent) has its backend built (migration 0018, `src/routes/ask.ts`, see "Concierge" under Agent fleet and the README section "Ask for recommendations"); and its page is the Ask chip and panel on the home page (`web/src/components/AskPanel.tsx`, store in `web/src/lib/ask.ts`). Ask only shows once a Concierge is connected and switched on at /admin/agent.
7. Reduce the main bundle further (about 142 KB gzip after rounding icon paths; React, React Router and TanStack Query are most of it).
