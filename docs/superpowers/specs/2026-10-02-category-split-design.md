# Finer categories for pop-ups

Status: taxonomy approved by Zack on 2026-10-02. The rest is for review.
Scope: the `category` field only. No second dimension, no tags.

## Goal

Make the category filter tell pop-ups apart. Today 74 of the 176 real pop-ups are `art` and 76 are `food`, and everything else adds up to under 30, so the chips barely narrow anything.

- `art` is almost all long-running gallery and museum exhibitions (White Cube, Gagosian, Victoria Miro), plus art fairs and a few real pop-ups.
- `food` is almost all chef residencies, supper clubs and London Restaurant Festival dinners, plus a few street-food markets.

Zack's direction: keep one category per pop-up, but split the two overloaded ones and add the obvious missing types.

## Taxonomy

Eleven categories. Four keys already exist and keep their meaning or change it as shown.

| Key | Label | What goes in | Change |
| --- | --- | --- | --- |
| `food` | Food & Drink | pop-up restaurants, stalls, bars, bakeries, tastings | narrowed |
| `dining` | Supper Clubs & Residencies | chef residencies and takeovers, supper clubs, dinner series, festival dinners | new |
| `market` | Markets & Fairs | street-food, craft, vintage and design markets, and art and design fairs | widened to fairs |
| `exhibition` | Exhibitions | gallery and museum shows | new |
| `art` | Art Pop-ups | one-off installations, public art, sculpture trails, immersive work | narrowed |
| `event` | Events & Festivals | museum lates, festivals, anniversary parties, talks, launches with a programme | new |
| `fashion` | Fashion | clothing, shoes, vintage | same |
| `sample` | Sample Sale | sample sales, warehouse sales, brand giveaways | same |
| `beauty` | Beauty | same | same |
| `tech` | Tech | same | same |
| `other` | Other | anything that fits nothing above | same |

Chip order on the Explore and Submit pages follows this table.

Music, Wellness and Kids are not added: no pop-up in the data needs them yet. Adding one later is one entry in the shared list, one icon, one pattern and one migration.

### Tie-break rules

These go into the agent skill and into `guessCategory` so Scout, Triage and the paste-a-link autofill agree.

1. A meal or drinks night run by a named chef or restaurant at a venue, with a set menu or a dated series: `dining`. A stall, bar, bakery or tasting open to walk-ins: `food`. A market of several food stalls: `market`.
2. An art fair is `market`. A show of works in a gallery or museum, even a short one: `exhibition`. A one-off piece, trail or installation in a shop, street or park: `art`.
3. Something with a programme or a crowd rather than a thing to see or buy (a museum late, a festival day, an anniversary party, a talk): `event`.
4. A brand's temporary shop stays `fashion`, `beauty` or `tech`. If the point is a discount, `sample`.
5. When two fit, pick the one the reader would browse under. When none fits, `other`.

## Data model

`popups.category` has a `CHECK` list of eight values. SQLite cannot change a `CHECK` in place, so migration `0014_categories.sql` rebuilds the table.

- Nine tables reference `popups(id)`, and `popups` references itself through `merged_into`. The rebuild order is park the rows in a table `popups_park`, drop `popups`, create it again under the same name, insert the rows back from the park table, and drop the park table. Never rename: a rename leaves the deferred foreign-key violations raised by the drop uncleared and the commit fails once any child row exists.
- The migration starts with `PRAGMA defer_foreign_keys = on`, so the drop does not fail on the children and the constraint is checked once, at the end.
- `popups` is recreated with every column of the live table, including the ones added later (`is_example`, `evidence`, `evidence_url`, `evidence_check`, `lease_agent`, `lease_until`), the same four indexes and the new eleven-value `CHECK`.
- Existing rows keep their current key. All eight old keys stay valid, so old links and API clients that send `art` or `food` keep working. Only what `art` means changes, and reclassification (next section) fixes the rows.
- `is_example` stays. The column and the "Example" label are harmless and removing them is a separate cleanup.

Rehearsal before production, as a step of the plan: load the newest file in `backups/` into a local D1, run the migration, and check that every table's row count is unchanged and `PRAGMA foreign_key_check` returns nothing. The rehearsal caught that the first version (using rename) failed on data with child rows, which is why the migration test re-runs it with child rows present.

## Reclassifying existing rows

About 200 rows (176 real, a share of them Scout drafts still pending) need a new key. The migration does not guess. A script, `scripts/recategorize.mjs`, reads the rows from D1 and proposes a key for each from the tie-break rules, using host, title and description, and writes two things:

- `.wrangler/recategorize.sql`: one `UPDATE popups SET category = ? WHERE id = ?` per changed row.
- A short table of rows it is unsure about, for Zack to settle.

Nothing is written to production until Zack has read the table and says go. A fresh backup is taken just before. Rows are matched by `id`, so running the file twice does nothing new.

The snapshot rebuilds on its own within ten minutes (cron), so the public list follows the update without a manual step.

## Code changes

One list instead of four. The category list today is written out in `src/lib/extract.ts`, `src/shared/filter-popups.ts`, `web/src/lib/api.ts` and `web/src/lib/format.ts`.

- New `src/shared/categories.ts` exports `CATEGORIES` (keys, in chip order), the `Category` type and `CATEGORY_LABELS`. The Worker and `web/` import it by relative path, as they already do for `filter-popups.ts`. It uses only type syntax the bundlers and Node accept.
- `src/lib/extract.ts`: `CATEGORIES` re-exported from the shared file. `CATEGORY_WORDS` (the regex guess) gets patterns for `dining`, `exhibition`, `event` and the fair case of `market`, placed before the broader ones. `normaliseCategory` maps the obvious spoken forms ("supper club", "residency", "gallery", "festival", "art fair") to the new keys. The LLM prompt and JSON schema pick up the new list through `CATEGORIES`.
- `src/routes/popups.ts`, `src/mcp.ts`, `src/shared/filter-popups.ts`: use the shared list. The MCP search description changes from "food, fashion, samples, art, markets, beauty and tech" to the new wording. The `submit_popup` category description carries the tie-break rules in one sentence.
- `web/src/lib/format.ts`: `CATS` built from the shared labels. `Explore.tsx` and `Submit.tsx` already render from `CAT_LIST`, so the chips follow. The chip row already scrolls sideways on phones.
- Icons and patterns: each category has an icon symbol (`c-<key>` in `web/src/components/Icon.tsx`) and a cover pattern (`.pat-<key>` in `web/src/styles.css`). `dining`, `exhibition`, `art`, `event` need new or reassigned ones. The current `c-art` easel suits `exhibition`. `art` gets a new sculpture or frame icon. `dining` and `event` get new ones in the same thick-ink line style. Patterns use the existing tint tokens with a different hatch, so no new colours enter the design system (DESIGN.md rule 2). `docs/DESIGN.md` gets one line listing the patterns.
- `skills/spotted-london/SKILL.md`: the category line and the tie-break rules.

Rejected: a second "format" field next to the theme. It would let readers cross-filter, but the filter bar gets heavier and Scout has two judgements to make per draft. Nothing in the data asks for it yet.

## Agent-facing text

Scout and Triage read their category list from the skill in Zack's Manyfold skill library (`skl_agqpimhpz5y2rcx6wcz7d7v67q`, shared by Scout, Triage and Checker), and `submit_popup` rejects a category outside the enum. After deploy, the skill needs a new version with the new categories and the tie-break rules. Publishing it changes what live agents do, so it waits for Zack's go and happens after the migration is live, never before. Until then agents keep sending the old eight keys, which the new table still accepts.

## Order of rollout

Production deploys run on Cloudflare Workers Builds: a push to `main` deploys, other branches only get preview versions, and the build token has no D1 access. So the migration goes first, by hand, and the merge is the deploy. Migration number `0013` is taken by the Manyfold-scheduling work (already applied to production), so this one is `0014`.

1. Work on branch `category-split` in its own git worktree. Local rehearsal on the newest backup.
2. Fresh backup. Apply `0014` to remote D1 (`env -u` the two Cloudflare vars, as in the project notes). Old code keeps working because the new table accepts a superset, and branch previews share production D1, so this must come before the PR.
3. Open the PR, saying it adds a migration that is already applied. Zack merges, and the merge deploys the Worker and web build.
4. Run the reclassification after Zack has read the unsure-rows table. Fresh backup first.
5. Publish the new skill version to the Manyfold library.

Steps 2, 3, 4 and 5 write to production or to live agents, or publish outward, so each waits for an explicit go.

## Tests

- `test/lib.test.ts`: `guessCategory` and `normaliseCategory` for each new key and each tie-break rule, including "art fair" to `market` and "supper club" to `dining`.
- API: `POST /popups` and `submit_popup` accept each of the eleven keys and reject a twelfth with the error that lists them. `GET /popups?category=dining,exhibition` filters.
- `test/snapshot.test.ts`: the browser-side filter and the SQL filter still agree with the new keys in the fixture.
- A test that fails when the shared list and the `CHECK` in the newest migration drift apart, so the next category cannot be added in one place only.
- Web: chips render from the shared list, and every key has an icon symbol and a `.pat-<key>` rule.
- Migration: row counts and `foreign_key_check`, run in the rehearsal step rather than in the suite.

## Out of scope

- Music, Wellness, Kids or any other new theme.
- A format or tag dimension.
- Removing `is_example` or the Example label.
- Hiding exhibitions by default. Zack may want that once the split is live, as a separate decision.
