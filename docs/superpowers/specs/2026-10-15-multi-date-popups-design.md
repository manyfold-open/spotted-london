# Pop-ups with more than one date range (design)

Status: proposed, waiting for Zack's OK (15 Oct 2026). No migration or code yet.

## Problem

A pop-up has one `start_at` and one `end_at`. Pages that list separate dates (Bank of England tours on 29 Oct and 26 Nov, Science Museum Power Up on 15 Oct, 12 Nov and 10 Dec, Local Makers markets on 7 Nov and 5 Dec) cannot be one post. Put in one range they look open the whole month; split into one post per date they make duplicates, split saves and votes and clutter the list.

Dates are whole London days today (`start_at` is 00:00, `end_at` is 23:59, times of day live in free text `hours_text`). That stays: a range is a first day and a last day, and one hours text covers all of them.

## Options

**A. Child table `popup_dates`** (one row per range). Clean SQL, but every reader needs a second query or a join, the snapshot builder needs a new lookup, edits must keep two tables in step, and `carryOver` (merge) and delete need to move the children. More rows read on a free plan that is already watched.

**B. `start_at`/`end_at` = the range that is current or next, others listed beside it.** Old clients that only know `start_at`/`end_at` show a sensible date. But a cron has to move it forward when a range ends (up to an hour stale, one write per pop-up per range, snapshot rebuilt), the expiry rule needs "no later range", and the "this weekend" window can miss a pop-up: ranges Thu 16 and Sat 18, asked on Wed, the stored range is Thu, which ends before the weekend window starts.

**C (recommended). `start_at`/`end_at` = the whole span (first day to last day), plus a compact `date_ranges` JSON column on the same row.** The span never changes after a save, so everything that only needs "is it over" or "could it overlap" keeps working untouched: the expiry cron, the indexes, `recomputeHot`'s query, the snapshot's SQL window, saves/votes joins, duplicate candidates, `merge`. Only the places that ask "is it on at this moment / in this window" look at the ranges, through one pure function. No cron change, nothing to go stale, no extra table or query.

**D. Separate linked posts** (a "series"). Keeps every rule as is, but it is the workaround we have now, with saves, votes and check-ins split, and a bigger list. Rejected.

## Design (option C)

### Data

Migration `0027_date_ranges.sql`: `ALTER TABLE popups ADD COLUMN date_ranges TEXT;` Nothing else. `NULL` means an ordinary pop-up (one range = `start_at` to `end_at`). Otherwise `[[start,end],[start,end],...]` in Unix ms: sorted, no overlap, at least 2, at most 12 (`MAX_RANGES`). Invariant, checked in one place (`normaliseRanges` in `src/lib/time.ts`): `start_at = first.start`, `end_at = last.end`. The migration is additive, so the code that is deployed now keeps working: it ignores the column, and old writes leave it `NULL`.

Each range is at most 180 days (`MAX_DURATION`); the whole span is at most 365 days (`OPEN_END`) so a "monthly for a year" market fits and nothing runs forever. A longer range, an open end or no dates keep the `date_kind` rules of migration 0026 and cannot be mixed with `date_ranges` (a post is either one of those or a list of ranges). A migration that rebuilds `popups` must carry `date_ranges` as well as `tags` and `date_kind`.

### One function for "is it on"

`src/shared/ranges.ts` (plain TS, used by Worker and browser): `rangesOf(p)` (the list, or the single span), `overlaps(p, from, to)`, `openAt(p, now)`, `currentOrNext(p, now)`, `nextStart(p, now)`. `filterPopups` uses `overlaps` after the cheap span test; `listPopups` (SQL) adds `AND (date_ranges IS NULL OR EXISTS (SELECT 1 FROM json_each(date_ranges) r WHERE json_extract(r.value,'$[1]') > ? AND json_extract(r.value,'$[0]') < ?))`. The `OR` makes the JSON work run only for the few multi-range rows. `test/snapshot.test.ts` gets multi-range pop-ups so the two paths stay equal.

### What changes where

| Place | Change |
|---|---|
| Public JSON (`toPublic`, snapshot) | `ranges: [[s,e],...]` only when there are 2+ (about 30 bytes a range, only on those pop-ups; no change for the rest). `start_at`/`end_at` stay the span. |
| `hot()` | takes the current-or-next range, so a gap between dates gets no "live now" lift and the "starts in N hours" decay counts to the next date. |
| `isLive`, `startsTomorrow`, card/sheet date text (`dateRange`) | use `ranges`. Text: "29 Oct and 26 Nov"; for 3 or more "15 Oct, 12 Nov and 10 Dec"; ranges that are runs: "1 to 3 Nov and 10 to 12 Dec". Cards show the next date first ("Next: 12 Nov, then 10 Dec"). |
| Check-in | allowed only while a range is open (`openAt`), so not in a gap. One check-in per person per pop-up stays (no schema change): it proves the place exists, a second one proves nothing new. |
| Expiry cron | none. It ends the pop-up when the last range is over (`end_at`). |
| Duplicates | SQL still uses the span (a superset); the JS step after it drops a candidate whose ranges do not touch (`findDuplicates`, `mergeCandidates`, `duplicatePairs`). A pop-up with several dates still matches a one-date post on any of its dates. |
| Edits (`PATCH`) | accepts `date_ranges`. Votes on "is it real" are reset when the place moves or an existing range is changed or removed, but not when dates are only added (a common fix: the page lists one more date). |
| Create (`POST`) and Submit page | "Add another date" under the dates; a person may add up to 12. Posting with 2+ ranges has no extra review rule beyond the normal ones. |
| EditPanel (admins, PR #24) | the same list editor. |
| MCP `submit_draft` | new optional `dates: [{start_date, end_date}]`. When given it replaces `start_date`/`end_date` (which stay required for compatibility and must equal the first start and last end, or be omitted: agents can send either). Scout still needs a quote for the dates. `search_popups` results carry `dates` text and `ranges`. Triage `fixes.set` stays single date. `AGENT_INFO` and `skills/spotted-london/SKILL.md` updated. |
| Admin queue | shows all ranges; `publishReady` unchanged. |
| SEO (`src/pages.ts`) | description lists the dates; schema.org gets an `Event` with `eventSchedule` (or one sub-event per range) instead of one `startDate`/`endDate`. |
| `/llms.txt`, `/connect`, privacy | text for the new `ranges` field and `dates` input; privacy needs no change (no new personal data). |
| Reminders (cron stub) | note in code: when built, use the next range's start. |

### Snapshot size

Today about 800 bytes a pop-up. A multi-range pop-up adds about 30 bytes per range after the first. Even at 10% of the list having three ranges the list grows under 1%.

### D1 cost

No new table, no new query in the snapshot builder, no per-request scan. The only new SQL is the `EXISTS (json_each ...)` guarded by `date_ranges IS NULL OR`, run on rows the existing filters already read.

### Not doing (YAGNI)

Different opening hours per date (use `hours_text`), a recurring rule ("every first Saturday"), per-date saves or votes, per-date check-in counts, giving Scouts open-ended or very long runs.

## Testing

`test/ranges.test.ts` for the pure functions (gap, weekend window, BST edge, sorting and overlap errors); API tests for create, edit, vote reset rule, check-in in a gap, and listing in a gap; `snapshot.test.ts` equal results for SQL and browser filters with multi-range rows; MCP tests for `submit_draft` with `dates`; web checks at 375 px and desktop.

## Rollout

One migration, additive. Zack runs `npx wrangler d1 migrations apply manyfold-spotted-london-db --remote` before merging. The new code reads `date_ranges` only if the column exists in the row it loaded, so a deploy before the migration would fail on writes that set it: the PR says to apply the migration first.
