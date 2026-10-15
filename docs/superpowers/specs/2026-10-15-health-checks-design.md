# Health checks for Ask and autofill

Date: 2026-10-15. Approved by Zack in chat the same day.

## Why

Insights (`/admin/insights`) says what people use. It does not say whether the AI features work. Ask keeps only today's
numbers (`askStats`) and its rows are purged after 7 days; autofill failures only reach `console.error`. The only way to
learn that either is broken is for a visitor to hit the error.

## What

1. A daily record of how Ask and autofill do: successes, failures that are ours, failures that are not, and how long
   they took.
2. A **Test now** button for each, so the admin can check on demand.
3. A Health panel on `/admin/insights` showing both.

Out of scope here (a later design): time on site and day-1 / day-7 retention.

## Data (migration 0028)

```sql
CREATE TABLE health_daily (
  day TEXT NOT NULL,            -- London date, YYYY-MM-DD
  feature TEXT NOT NULL CHECK (feature IN ('ask', 'autofill')),
  ok INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,   -- our fault: the agent or the model did not do its job
  other INTEGER NOT NULL DEFAULT 0,    -- not ours: a site blocked the page, the visitor's input was unusable
  ms_sum INTEGER NOT NULL DEFAULT 0,   -- over ok and failed calls that have a duration
  ms_max INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (day, feature)
);
```

Only counts, milliseconds and error text written by our own code. Nothing a visitor typed, no ids, so the privacy policy
is unchanged. The last Test now result is one JSON value in `settings` key `health_test`.

## Recording

- **Ask** adds no write to the request path. The hourly cron rolls the `asks` table of today and yesterday up into
  `health_daily` (one `INSERT ... SELECT ... ON CONFLICT DO UPDATE` per day), before the 7 day purge. Rows from the admin
  test (`ip_hash = 'admin-test'`) are left out. `done` is ok, `failed` is failed, a question still `pending` is not
  counted yet. Duration is `finished_at - asked_at`.
- **Autofill** records one upsert at the end of `POST /extract` through `waitUntil`. A person can autofill only a few
  times a day, so this is a handful of writes. `ai_failed` and `ai_quota` are failed. `fetch_failed`, `unreadable_link`
  and other input problems are other. A request that is refused before any work (daily limit, no input) is not recorded.
- Recording never fails a request: errors are caught and logged. Before migration 0028 is applied it does nothing.

## Test now

`POST /admin/health/test {feature: 'ask' | 'autofill'}` (`requireAdmin`; this is not agent management, so
`AGENT_ADMIN_TOKEN` does not open it). At most one test per feature a minute, counted from `settings` (not KV).

- **autofill** runs the paste-text path of the extractor on a fixed sample announcement (no outside fetch) and passes
  when it returns a title and a start date. It costs a few Workers AI neurons.
- **ask** stores an `asks` row with `ip_hash = 'admin-test'`, starts the available Concierge with a fixed question and
  returns its id. `GET /admin/health/test/ask/:id` advances it the same way a visitor's poll does and returns its state;
  it passes when it is `done` with at least one pick from the public list. The admin test counts towards the daily cap
  like any question.

The result `{feature, ok, ms, detail, at}` is saved as `health_test` and shown in the panel. The sample texts live in
`src/lib/health.ts` so tests and the endpoint agree.

## Page

A Health panel at the top of `/admin/insights`, one row per feature: last 14 days as small bars (green ok, red failed,
grey other), today's success rate, average and slowest time, the last error, and the Test now button with its latest
result. Today is flagged when it has at least 5 calls and under 80% succeeded (`ok / (ok + failed)`; `other` is left
out of the rate). The panel reads from `GET /admin/health`, cached 60 seconds in the Worker.

## Code map

- `src/lib/health.ts`: pure. Classifying an outcome, the success rate and the flag rule, the sample texts, the shape.
- `src/db/health.ts`: `recordAutofill`, `rollupAsks`, `loadHealth`, `saveTest` / `lastTests`, the test runners.
- `src/routes/admin.ts`: the two endpoints. `src/cron.ts`: `rollupAsks` in the hourly step.
- `src/shared/health.ts`: response shape for the Worker and `web/src/pages/Insights.tsx`.

## Tests

Pure rules; the roll-up (counts, excludes admin test, idempotent when run twice); autofill recording by outcome; endpoint
permissions and the one-a-minute limit; working with the table missing.

## Rollout

Migration 0028 must be applied to the remote D1 before merge (`npx wrangler d1 migrations apply
manyfold-spotted-london-db --remote`). The code is safe before that: reads return empty, writes are skipped.
