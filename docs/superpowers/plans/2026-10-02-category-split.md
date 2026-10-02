# Finer Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the overloaded `art` and `food` categories and add `dining`, `exhibition`, `event`, so the category filter tells pop-ups apart (8 categories become 11).

**Architecture:** One shared category list (`src/shared/categories.ts`) replaces four hand-written copies. Migration `0014` rebuilds `popups` to widen the `CHECK`. A pure function plus a script proposes new categories for the existing ~200 rows and writes reviewable SQL. Production writes (migration, reclassification, skill publish) are separate gated steps.

**Tech Stack:** Cloudflare Workers + D1, Hono, Vite + React 19, vitest inside workerd (`@cloudflare/vitest-pool-workers`), Node 22 type stripping for scripts.

**Spec:** `docs/superpowers/specs/2026-10-02-category-split-design.md`

## Global Constraints

- Eleven keys, in this order, which is also the chip order: `food, dining, market, exhibition, art, event, fashion, sample, beauty, tech, other`.
- Labels: Food & Drink, Supper Clubs & Residencies, Markets & Fairs, Exhibitions, Art Pop-ups, Events & Festivals, Fashion, Sample Sale, Beauty, Tech, Other.
- All eight old keys stay valid, so old links and API clients keep working. Only what `art` means changes.
- Keep `is_example` and the Example label. Removing them is out of scope.
- No new colours: cover patterns reuse the existing tint tokens with a different hatch (DESIGN.md rule 2).
- Nothing users see contains em dashes, en dashes or spaced hyphens (DESIGN.md). Use "to" for ranges.
- Code, commits, UI copy and docs other than SPEC.md are in English. SPEC.md and replies to Zack are Traditional Chinese.
- Free tier only. Keep Worker request handlers light.
- Production writes (apply the migration, run the reclassification SQL, publish the skill version) need Zack's explicit yes each time, with a fresh backup first. Never paste secrets into chat.
- Wrangler against production must run as `env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx wrangler ...` (otherwise it hits the wrong Cloudflare account).
- Every commit message ends with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Work in the git worktree `/Users/zack/playground/spotted-london-categories` on branch `category-split` (created from `main`, spec already committed). Another Claude session uses `/Users/zack/playground/spotted-london` and switches its branches, so never work or run commands there. Do not push or open a PR unless Zack says yes.
- Production deploys are by merge: Cloudflare Workers Builds deploys a push to `main`, and other branches only get previews that share production D1. Never run `npm run deploy`. The build token has no D1 access, so the migration is applied by hand before the merge.
- Migration number `0013` belongs to the Manyfold-scheduling work (`0013_manyfold_backup.sql`, already applied to production, not on `main` yet). This plan's migration is `0014_categories.sql`. Do not renumber it.
- Check every screen at 375 px as well as desktop (CLAUDE.md).
- Baseline before this plan: `npx vitest run` gives 14 files and about 270 tests passing, `npx tsc --noEmit` and `(cd web && npx tsc --noEmit)` are clean. Run all three after every task.

## File Structure

| File | Responsibility |
| --- | --- |
| `migrations/0014_categories.sql` (new) | Rebuild `popups` with the eleven-value `CHECK`, same columns, same four indexes |
| `src/shared/categories.ts` (new) | The one list: `CATEGORIES`, `Category`, `CATEGORY_LABELS`, `isCategory` |
| `src/lib/extract.ts` | Re-exports the list. `guessCategory` and `normaliseCategory` know the new keys |
| `src/shared/filter-popups.ts`, `web/src/lib/api.ts`, `web/src/lib/format.ts` | Use the shared list instead of their own copy |
| `src/mcp.ts` | Tool descriptions carry the tie-break rules |
| `web/src/components/Icon.tsx`, `web/src/styles.css` | Icon symbols and cover patterns for every key |
| `src/lib/recategorize.ts` (new) | Pure function: propose a new key for a row, build the UPDATE SQL |
| `scripts/recategorize.mjs` (new), `scripts/recategorize-overrides.json` (new) | Read rows from D1, apply the function and overrides, write `.wrangler/recategorize.sql`, print the unsure table |
| `test/categories.test.ts`, `test/category-assets.test.ts`, `test/recategorize.test.ts` (new) | Schema, list and asset coverage, reclassification rules |
| `skills/spotted-london/SKILL.md`, `docs/DESIGN.md`, `SPEC.md`, `README.md` | Docs |

---

### Task 0: Prepare the worktree

**Files:** none.

The worktree already exists, with `.dev.vars` copied in. It has no `node_modules` yet.

- [ ] **Step 1: Install and take the baseline**

```bash
cd /Users/zack/playground/spotted-london-categories
git branch --show-current
npm install
npx vitest run 2>&1 | tail -6
npx tsc --noEmit && (cd web && npx tsc --noEmit) && echo typecheck-ok
```

Expected: branch `category-split`, tests all passing (14 files, about 270 tests, fewer than on the other branch because `0013_manyfold_backup` and its tests are not here), `typecheck-ok`. If `npm install` fails on peer dependencies, the repo's `.npmrc` already sets `legacy-peer-deps=true`, so check you are in the worktree root.

---

### Task 1: Migration 0014 rebuilds `popups`

**Files:**
- Create: `migrations/0014_categories.sql`
- Create: `test/categories.test.ts`

**Interfaces:**
- Produces: a `popups` table whose `category` accepts the eleven keys above. Tasks 2 to 7 rely on it. Columns, indexes and foreign keys are unchanged.

> Superseded: The SQL shown below was replaced by commit f50d0d9 (park table instead of rename) after the rehearsal found it failed with child rows; the committed `migrations/0014_categories.sql` is the source of truth.

This SQL was already run once in the test pool and passed: all eleven keys inserted, `rave` rejected, `PRAGMA foreign_key_check` empty, four indexes present, whole suite green. D1 refuses `pragma_foreign_key_list` in queries, so the test below reads `sqlite_master` instead. Do not put semicolons inside SQL comments: the migration reader splits on them.

- [ ] **Step 1: Write the failing test**

Create `test/categories.test.ts`:

```ts
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const NEW_KEYS = ['food', 'dining', 'market', 'exhibition', 'art', 'event', 'fashion', 'sample', 'beauty', 'tech', 'other'];

const insertPopup = (id: string, category: string) => env.DB.prepare(
  `INSERT INTO popups (id, slug, title, category, lat, lng, geohash, start_at, end_at, created_by, created_at, updated_at)
   VALUES (?, ?, 'Test', ?, 51.5, -0.1, 'gcpvj', 1, 2, 'cat_user', 1, 1)`,
).bind(id, id, category).run();

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, role, created_at) VALUES ('cat_user', 'cat_user@test.dev', 'user', 1)").run();
});
afterEach(async () => {
  await env.DB.prepare("DELETE FROM popups WHERE id LIKE 'cat\\_%' ESCAPE '\\'").run();
});

describe('popups schema after 0014', () => {
  it('accepts every category and rejects anything else', async () => {
    for (const c of NEW_KEYS) await insertPopup(`cat_${c}`, c);
    await expect(insertPopup('cat_rave', 'rave')).rejects.toThrow();
  });

  it('keeps foreign keys intact and still refers to popups by its own name', async () => {
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    const stale = await env.DB.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%popups_new%' OR sql LIKE '%popups_old%'").all();
    expect(stale.results).toEqual([]);
  });

  it('keeps the four list, geo and user indexes', async () => {
    const idx = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'popups' AND name LIKE 'idx_%' ORDER BY name").all<{ name: string }>();
    expect(idx.results.map(r => r.name)).toEqual(['idx_popups_box', 'idx_popups_geo', 'idx_popups_list', 'idx_popups_user']);
  });

  it('keeps the columns added by later migrations', async () => {
    const cols = (await env.DB.prepare('PRAGMA table_info(popups)').all<{ name: string }>()).results.map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['is_example', 'evidence', 'evidence_url', 'evidence_check', 'lease_agent', 'lease_until']));
    expect(cols).toHaveLength(38);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/categories.test.ts`
Expected: FAIL on "accepts every category" (`CHECK constraint failed` for `dining`). The other three tests may already pass.

- [ ] **Step 3: Write the migration**

Create `migrations/0014_categories.sql`:

```sql
-- Finer categories, see docs/superpowers/specs/2026-10-02-category-split-design.md.
-- SQLite cannot change a CHECK in place, so popups is rebuilt: create the new table, copy, drop, rename.
-- Never rename the old table first, because SQLite would then point every child table at the old name.
-- defer_foreign_keys lets the drop run while nine tables still reference popups and checks them once at the end.
PRAGMA defer_foreign_keys = on;

CREATE TABLE popups_new (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  host TEXT,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN ('food', 'dining', 'market', 'exhibition', 'art', 'event', 'fashion', 'sample', 'beauty', 'tech', 'other')),
  price_type TEXT CHECK (price_type IN ('free', 'paid', 'unknown')),
  price_text TEXT,
  address TEXT,
  borough TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  geohash TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  hours_text TEXT,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'community', 'verified_community', 'verified_admin', 'hidden', 'removed', 'ended')),
  final_verdict TEXT CHECK (final_verdict IN ('real', 'fake')),
  merged_into TEXT REFERENCES popups(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  exist_pos REAL NOT NULL DEFAULT 0,
  exist_neg REAL NOT NULL DEFAULT 0,
  voter_count INTEGER NOT NULL DEFAULT 0,
  checkin_count INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  quality_pos INTEGER NOT NULL DEFAULT 0,
  quality_neg INTEGER NOT NULL DEFAULT 0,
  hot REAL NOT NULL DEFAULT 0,
  report_weight REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_example INTEGER NOT NULL DEFAULT 0,
  evidence TEXT,
  evidence_url TEXT,
  evidence_check TEXT CHECK (evidence_check IN ('found', 'unchecked')),
  lease_agent TEXT,
  lease_until INTEGER
);

INSERT INTO popups_new (
  id, slug, title, host, description, category, price_type, price_text, address, borough, lat, lng, geohash,
  start_at, end_at, hours_text, source_url, status, final_verdict, merged_into, created_by,
  exist_pos, exist_neg, voter_count, checkin_count, confidence, quality_pos, quality_neg, hot, report_weight,
  created_at, updated_at, is_example, evidence, evidence_url, evidence_check, lease_agent, lease_until
) SELECT
  id, slug, title, host, description, category, price_type, price_text, address, borough, lat, lng, geohash,
  start_at, end_at, hours_text, source_url, status, final_verdict, merged_into, created_by,
  exist_pos, exist_neg, voter_count, checkin_count, confidence, quality_pos, quality_neg, hot, report_weight,
  created_at, updated_at, is_example, evidence, evidence_url, evidence_check, lease_agent, lease_until
FROM popups;

DROP TABLE popups;
ALTER TABLE popups_new RENAME TO popups;

CREATE INDEX idx_popups_list ON popups(status, end_at, hot DESC);
CREATE INDEX idx_popups_geo ON popups(geohash);
CREATE INDEX idx_popups_box ON popups(lat, lng);
CREATE INDEX idx_popups_user ON popups(created_by, created_at);
```

- [ ] **Step 4: Run the test and the whole suite**

Run: `npx vitest run test/categories.test.ts` then `npx vitest run`
Expected: both PASS. If `toHaveLength(38)` fails, count the columns in the migration (there are 38, the 30 original ones plus the eight added by migrations 0003, 0007 and 0009) and fix whichever side is wrong, never loosen the check.

- [ ] **Step 5: Commit**

```bash
git add migrations/0014_categories.sql test/categories.test.ts
git commit -m "Rebuild popups so category can take eleven values" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: One shared category list

**Files:**
- Create: `src/shared/categories.ts`
- Modify: `src/lib/extract.ts:7-10`
- Modify: `src/shared/filter-popups.ts:5-8` and `:31-34`
- Modify: `web/src/lib/api.ts:3`
- Modify: `web/src/lib/format.ts:1-9`
- Modify: `test/categories.test.ts`

**Interfaces:**
- Produces, from `src/shared/categories.ts`: `CATEGORIES` (readonly tuple of the eleven keys in chip order), `type Category`, `CATEGORY_LABELS: Record<Category, string>`, `isCategory(s: string): s is Category`.
- `src/lib/extract.ts` keeps exporting `CATEGORIES` and `Category`, so `src/routes/popups.ts` and `src/mcp.ts` need no import change.
- `web/src/lib/api.ts` keeps exporting `type Category`. `web/src/lib/format.ts` keeps exporting `CATS` and `CAT_LIST`, so the pages need no change.

- [ ] **Step 1: Write the failing tests**

Append to `test/categories.test.ts` (and add the import at the top with the others):

```ts
import { CATEGORIES, CATEGORY_LABELS, isCategory } from '../src/shared/categories';
```

```ts
describe('shared category list', () => {
  it('has the eleven keys in chip order', () => {
    expect([...CATEGORIES]).toEqual(NEW_KEYS);
  });

  it('gives every key one unique label with no dashes', () => {
    expect(Object.keys(CATEGORY_LABELS)).toEqual([...CATEGORIES]);
    const labels = Object.values(CATEGORY_LABELS);
    expect(new Set(labels).size).toBe(CATEGORIES.length);
    for (const l of labels) expect(l).not.toMatch(/[–—]| - /);
  });

  it('isCategory accepts keys and nothing else', () => {
    expect(isCategory('dining')).toBe(true);
    expect(isCategory('rave')).toBe(false);
    expect(isCategory('')).toBe(false);
  });

  it('matches the CHECK in the live popups table, so the two cannot drift apart', async () => {
    const row = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'popups'").first<{ sql: string }>();
    const m = row!.sql.match(/category TEXT NOT NULL CHECK \(category IN \(([^)]*)\)\)/);
    expect(m).not.toBeNull();
    const inDb = m![1].split(',').map(s => s.trim().replace(/'/g, ''));
    expect([...inDb].sort()).toEqual([...CATEGORIES].sort());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/categories.test.ts`
Expected: FAIL, `Cannot find module '../src/shared/categories'`.

- [ ] **Step 3: Create the shared list**

Create `src/shared/categories.ts`:

```ts
// The one list of pop-up categories. The Worker, the web app and the agent tools all import it.
// A new key needs, in the same change: a migration that widens the CHECK on popups.category,
// an icon symbol (c-<key>) in web/src/components/Icon.tsx and a .pat-<key> rule in web/src/styles.css.
// test/categories.test.ts and test/category-assets.test.ts fail when one of those is missing.

/** In chip order. */
export const CATEGORIES = [
  'food', 'dining', 'market', 'exhibition', 'art', 'event', 'fashion', 'sample', 'beauty', 'tech', 'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  food: 'Food & Drink',
  dining: 'Supper Clubs & Residencies',
  market: 'Markets & Fairs',
  exhibition: 'Exhibitions',
  art: 'Art Pop-ups',
  event: 'Events & Festivals',
  fashion: 'Fashion',
  sample: 'Sample Sale',
  beauty: 'Beauty',
  tech: 'Tech',
  other: 'Other',
};

export const isCategory = (s: string): s is Category => (CATEGORIES as readonly string[]).includes(s);
```

- [ ] **Step 4: Use it in `src/lib/extract.ts`**

Replace lines 7 to 10:

```ts
import { londonDateString, londonParts } from './time';

export const CATEGORIES = ['food', 'fashion', 'sample', 'art', 'market', 'beauty', 'tech', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
```

with:

```ts
import { londonDateString, londonParts } from './time';
import { CATEGORIES, type Category } from '../shared/categories';

export { CATEGORIES };
export type { Category };
```

- [ ] **Step 5: Use it in `src/shared/filter-popups.ts`**

Replace line 8 (`const CATEGORIES = ['food', 'fashion', ...];`) with an import placed under the two existing imports at the top, and delete the old constant. The top of the file becomes:

```ts
import { boxAround, haversine } from '../lib/geo';
import { windowFor, type When } from '../lib/time';
import { CATEGORIES, isCategory } from './categories';

const PUBLIC = ['community', 'verified_community', 'verified_admin'];
```

(keep the `const VERIFIED = ...` line that follows). Then in `filterPopups`, replace

```ts
    const cats = q.category.split(',').filter(x => CATEGORIES.includes(x));
```

with

```ts
    const cats = q.category.split(',').filter(isCategory);
```

The error line below it (`CATEGORIES.join(', ')`) stays as it is.

- [ ] **Step 6: Use it in the web app**

In `web/src/lib/api.ts` replace line 3:

```ts
export type Category = 'food' | 'fashion' | 'sample' | 'art' | 'market' | 'beauty' | 'tech' | 'other';
```

with

```ts
import type { Category } from '../../../src/shared/categories';
export type { Category };
```

In `web/src/lib/format.ts` replace lines 1 to 9 (the two imports, `CATS`, `CAT_LIST`, `catIcon`):

```ts
import type { Category, Popup, Status } from './api';
import type { IconName } from '../components/Icon';

export const CATS: Record<Category, string> = {
  food: 'Food & Drink', fashion: 'Fashion', sample: 'Sample Sale', art: 'Art & Culture',
  market: 'Market', beauty: 'Beauty', tech: 'Tech', other: 'Other',
};
export const CAT_LIST = Object.keys(CATS) as Category[];
export const catIcon = (c: Category) => `c-${c}` as IconName;
```

with:

```ts
import type { Popup, Status } from './api';
import type { IconName } from '../components/Icon';
import { CATEGORIES, CATEGORY_LABELS, type Category } from '../../../src/shared/categories';

export const CATS: Record<Category, string> = CATEGORY_LABELS;
export const CAT_LIST: Category[] = [...CATEGORIES];
export const catIcon = (c: Category) => `c-${c}` as IconName;
```

- [ ] **Step 7: Run everything**

Run: `npx vitest run` then `npx tsc --noEmit` then `(cd web && npx tsc --noEmit)`
Expected: all PASS and clean. (Until Task 5 the three new keys have no icon or pattern, which only matters visually.)

- [ ] **Step 8: Commit**

```bash
git add src/shared/categories.ts src/lib/extract.ts src/shared/filter-popups.ts web/src/lib/api.ts web/src/lib/format.ts test/categories.test.ts
git commit -m "Keep the category list in one place" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Autofill guesses the new categories

**Files:**
- Modify: `src/lib/extract.ts` (`CATEGORY_WORDS`, `guessCategory`, `normaliseCategory`, about lines 171 to 190)
- Modify: `test/lib.test.ts` (import line 5 to 6 and the test at about line 109)

**Interfaces:**
- Consumes: `CATEGORIES`, `Category` from Task 2.
- Produces: `guessCategory(text): Category | null` and `normaliseCategory(v: unknown): Category | null` (same signatures, wider answers). Order of rules matters and is part of the contract: sample, market, dining, food, event, art, exhibition, fashion, beauty, tech.

- [ ] **Step 1: Write the failing tests**

In `test/lib.test.ts` add `normaliseCategory` to the import from `'../src/lib/extract'`:

```ts
import {
  emptyExtraction, finalise, fromLlm, guessCategory, mergeInto, normaliseCategory, parseJsonLdEvent, parseOpenGraph, readableText, safeUrl,
} from '../src/lib/extract';
```

Replace the test `it('guesses categories from words', ...)` with:

```ts
  it('guesses categories from words', () => {
    expect(guessCategory('Archive denim sample sale, up to 70% off')).toBe('sample');
    expect(guessCategory('Hand pulled noodles')).toBe('food');
    expect(guessCategory('Matcha Lab by Kettl')).toBe('food');
  });

  it('guesses the finer categories, following the tie-break rules', () => {
    // 1. dated chef or restaurant meals are dining, stalls and bars are food, a market of stalls is market
    expect(guessCategory("Frank's Dinner Series: The Seahorse")).toBe('dining');
    expect(guessCategory('A.Wong Residency at Mandarin Oriental Mayfair')).toBe('dining');
    expect(guessCategory('Pernod Ricard Charity Supper Club')).toBe('dining');
    expect(guessCategory("Chet's Thai Dinner, London Restaurant Festival")).toBe('dining');
    expect(guessCategory('BANCARELLA Italian Street Food Market')).toBe('market');
    // 2. an art fair is a market, a gallery show an exhibition, a one-off piece art
    expect(guessCategory('Affordable Art Fair Battersea Autumn')).toBe('market');
    expect(guessCategory('Solo exhibition at White Cube gallery')).toBe('exhibition');
    expect(guessCategory('Frieze Sculpture 2026')).toBe('art');
    expect(guessCategory('Immersive light installation')).toBe('art');
    // 3. a programme or a crowd is an event
    expect(guessCategory('Tate Modern Lates: 10th Birthday')).toBe('event');
    expect(guessCategory('Japan Matsuri festival')).toBe('event');
    // nothing to go on
    expect(guessCategory('Open studio weekend')).toBeNull();
  });

  it('turns an answer into a category key', () => {
    expect(normaliseCategory('Food')).toBe('food');
    expect(normaliseCategory('dining')).toBe('dining');
    expect(normaliseCategory('Supper Club')).toBe('dining');
    expect(normaliseCategory('chef residency')).toBe('dining');
    expect(normaliseCategory('art fair')).toBe('market');
    expect(normaliseCategory('Gallery')).toBe('exhibition');
    expect(normaliseCategory('Festival')).toBe('event');
    expect(normaliseCategory('Installation')).toBe('art');
    expect(normaliseCategory('sample sale')).toBe('sample');
    expect(normaliseCategory('rave')).toBeNull();
    expect(normaliseCategory('')).toBeNull();
    expect(normaliseCategory(42)).toBeNull();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib.test.ts`
Expected: FAIL on the two new tests (for example `guessCategory('Frank's Dinner Series...')` returns `null`, `normaliseCategory` for `'Supper Club'` returns `'food'`).

- [ ] **Step 3: Replace the rules in `src/lib/extract.ts`**

Replace the block from `const CATEGORY_WORDS` through the end of `normaliseCategory` (the block that currently runs from `const CATEGORY_WORDS: [Category, RegExp][] = [` to the closing brace of `normaliseCategory`) with:

```ts
// Order matters: the first rule that matches wins. A dated chef or restaurant meal is dining before it is food,
// an art fair is a market before it is art, and a festival dinner is dining before it is an event.
const CATEGORY_WORDS: [Category, RegExp][] = [
  ['sample', /sample sale|warehouse sale|% off|up to \d+%|clearance/i],
  ['market', /art fair|design fair|craft fair|book fair|\bfairs?\b|\bmarkets?\b|car boot|makers|flea|stalls/i],
  ['dining', /supper club|residenc(?:y|ies)|takeover|dinner series|set menu|tasting menu|\bdinners?\b|restaurant festival/i],
  ['food', /food|coffee|matcha|bakery|noodle|ramen|pizza|burger|brunch|dessert|gelato|tasting|chef|wine|beer|cocktail/i],
  ['event', /\blates?\b|festival|anniversary|birthday|party|\btalks?\b/i],
  ['art', /installation|sculpture|public art|mural|immersive|\bzines?\b|ceramic|pottery|\btrail\b/i],
  ['exhibition', /exhibition|gallery|museum|solo show|group show|retrospective/i],
  ['fashion', /fashion|vintage|clothing|denim|sneaker|streetwear|thrift|kilo sale|jewellery|jewelry/i],
  ['beauty', /beauty|perfume|fragrance|skincare|makeup|cosmetic|nail/i],
  ['tech', /tech|gadget|gaming|robot|repair|3d print|vr\b/i],
];
export function guessCategory(text: string): Category | null {
  for (const [c, re] of CATEGORY_WORDS) if (re.test(text)) return c;
  return null;
}

// Spoken forms an LLM or a person might answer with, tried when the answer is not a key.
const CATEGORY_ALIASES: [RegExp, Category][] = [
  [/sample/, 'sample'],
  [/supper|residen|dinner/, 'dining'],
  [/fair/, 'market'],
  [/exhibit|gallery|museum/, 'exhibition'],
  [/festival|event|party|\blates?\b/, 'event'],
  [/installation|sculpture|public art/, 'art'],
];

export function normaliseCategory(v: unknown): Category | null {
  const s = typeof v === 'string' ? v.toLowerCase().trim() : '';
  if ((CATEGORIES as readonly string[]).includes(s)) return s as Category;
  for (const [re, c] of CATEGORY_ALIASES) if (re.test(s)) return c;
  return s ? guessCategory(s) : null;
}
```

- [ ] **Step 4: Run everything**

Run: `npx vitest run` then `npx tsc --noEmit`
Expected: PASS and clean. If an older test in `test/api.test.ts` that relies on autofill (around lines 225 to 290) now fails, look at which word it relied on before changing any rule: those tests expect `food` and `market` for "Kimchi Club pop-up" and "Autumn Flower Market", which the rules above still return.

- [ ] **Step 5: Commit**

```bash
git add src/lib/extract.ts test/lib.test.ts
git commit -m "Let autofill guess supper clubs, exhibitions, art pop-ups and events" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: API and MCP take the new keys and explain them

**Files:**
- Modify: `src/mcp.ts` (the `search_popups` description and `category` property at about lines 182 to 185, the `submit_draft` `category` property at about line 400)
- Modify: `test/api.test.ts` (inside `describe('creating pop-ups')` and `describe('lists')`)
- Modify: `test/agents.test.ts` (import, and inside `describe('MCP server, public')`)

**Interfaces:**
- Consumes: `CATEGORIES` from Task 2. `POST /popups` already validates with `oneOf(b, 'category', CATEGORIES, ...)` and `GET /popups` already reads the list, so only text and tests change here.

- [ ] **Step 1: Write the failing tests**

In `test/api.test.ts`, add an import under the existing imports:

```ts
import { CATEGORIES } from '../src/shared/categories';
```

Inside `describe('creating pop-ups', ...)`, after the test `'rejects bad input with clear codes'`, add:

```ts
  it('accepts every category and names them all when one is wrong', async () => {
    const boss = await user({ role: 'admin' });
    for (const [i, category] of CATEGORIES.entries()) {
      const r = await api('POST', '/popups', { user: boss, body: popupBody({ title: `Category check ${category} ${i}`, category, lat: 51.45 + i * 0.02, lng: -0.2 + i * 0.02 }) });
      expect([category, r.status]).toEqual([category, 201]);
    }
    const bad = await api('POST', '/popups', { user: boss, body: popupBody({ category: 'rave' }) });
    expect(bad.json.error.code).toBe('category_invalid');
    for (const c of CATEGORIES) expect(bad.json.error.message).toContain(c);
  });
```

Inside `describe('lists', ...)`, after the existing category test, add:

```ts
  it('filters by several of the new categories at once', async () => {
    const boss = await user({ role: 'admin' });
    const make = (title: string, category: string, i: number) =>
      api('POST', '/popups', { user: boss, body: popupBody({ title, category, lat: 51.4 + i * 0.03, lng: -0.3 + i * 0.03 }) });
    await make('Zebra supper club', 'dining', 1);
    await make('Zebra gallery show', 'exhibition', 2);
    await make('Zebra street stall', 'food', 3);
    const titles = async (q: string) => (await api('GET', `/popups?${q}&q=Zebra`)).json.items.map((p: any) => p.title).sort();
    expect(await titles('when=all&category=dining,exhibition')).toEqual(['Zebra gallery show', 'Zebra supper club']);
    expect(await titles('when=all&category=food')).toEqual(['Zebra street stall']);
  });
```

In `test/agents.test.ts`, add under the existing imports:

```ts
import { CATEGORIES } from '../src/shared/categories';
```

and inside `describe('MCP server, public', ...)` after `'initialises and lists only the public tools without a key'` add:

```ts
  it('offers every category in the search filter and explains the new ones', async () => {
    const search = (await mcp('tools/list', {})).json.result.tools.find((t: { name: string }) => t.name === 'search_popups');
    expect(search.inputSchema.properties.category.enum).toEqual([...CATEGORIES]);
    expect(search.inputSchema.properties.category.description).toMatch(/dining/);
    expect(search.description).toMatch(/exhibitions/);
  });
```

- [ ] **Step 2: Run to verify the right ones fail**

Run: `npx vitest run test/api.test.ts test/agents.test.ts`
Expected: the two API tests PASS already (the shared list is wired in Task 2), the MCP test FAILS on the `dining` and `exhibitions` text matches.

- [ ] **Step 3: Update the MCP text**

In `src/mcp.ts`, in `search_popups`, replace the `description` line

```ts
    description: 'Search pop-ups in London listed on Spotted London: food, fashion, samples, art, markets, beauty and tech. Returns up to 20, soonest and most popular first, each with a link.',
```

with

```ts
    description: 'Search pop-ups in London listed on Spotted London: food, supper clubs and residencies, markets and fairs, exhibitions, art pop-ups, events, fashion, sample sales, beauty and tech. Returns up to 20, soonest and most popular first, each with a link.',
```

and the `category` property line

```ts
      category: S('Only this category.', { enum: [...CATEGORIES] }),
```

with

```ts
      category: S('Only this category. food: stalls, bars, tastings. dining: supper clubs, chef residencies, dinner series. market: markets and fairs, including art fairs. exhibition: gallery and museum shows. art: one-off installations and public art. event: lates, festivals, parties, talks.', { enum: [...CATEGORIES] }),
```

In `submit_draft`, replace

```ts
      category: S('Best fitting category.', { enum: [...CATEGORIES] }),
```

with

```ts
      category: S('Best fitting category. A dated dinner or residency by a chef or restaurant is dining, a stall, bar or tasting is food, a market of stalls or an art fair is market, a gallery or museum show is exhibition, a one-off installation or public art is art, a late, festival, party or talk is event. A brand shop stays fashion, beauty or tech, and a discount is sample. When none fits, other.', { enum: [...CATEGORIES] }),
```

- [ ] **Step 4: Run everything**

Run: `npx vitest run` then `npx tsc --noEmit`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add src/mcp.ts test/api.test.ts test/agents.test.ts
git commit -m "Explain the eleven categories to agents and test them end to end" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Icons, cover patterns and the chips

**Files:**
- Modify: `web/src/components/Icon.tsx` (rename one symbol, add three, type the names)
- Modify: `web/src/styles.css` (the `.pat-art` line at about line 191)
- Modify: `web/src/lib/format.ts` (`catIcon`)
- Modify: `vitest.config.ts` (line 24)
- Modify: `test/env.d.ts`
- Create: `test/category-assets.test.ts`

**Interfaces:**
- Consumes: `CATEGORIES`, `Category` from Task 2.
- Produces: for every key, a `<symbol id="c-<key>" ...>` in `Icon.tsx` and a `.pat-<key> {` rule in `styles.css`. The existing easel symbol becomes `c-exhibition`, so exhibitions keep their blue striped cover. `art` gets a new icon and a dotted blue cover.

- [ ] **Step 1: Let the tests read source files**

In `vitest.config.ts` change line 24

```ts
    test: { setupFiles: ['./test/setup.ts'] },
```

to

```ts
    // css.include lets a test read web/src/styles.css as text (`?raw`). Vitest blanks CSS files by default.
    test: { setupFiles: ['./test/setup.ts'], css: { include: [/styles\.css/] } },
```

Append to `test/env.d.ts` (it is a global declaration file, keep it that way):

```ts
declare module '*?raw' {
  const text: string;
  export default text;
}
```

- [ ] **Step 2: Write the failing test**

Create `test/category-assets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import iconSource from '../web/src/components/Icon.tsx?raw';
import styles from '../web/src/styles.css?raw';
import { CATEGORIES } from '../src/shared/categories';

describe('every category has its look', () => {
  it.each([...CATEGORIES])('%s has an icon symbol', c => {
    expect(iconSource).toContain(`<symbol id="c-${c}" `);
  });

  it.each([...CATEGORIES])('%s has a cover pattern', c => {
    expect(styles).toMatch(new RegExp(`^\\.pat-${c} \\{`, 'm'));
  });

  it('has no symbol or pattern for a category that no longer exists', () => {
    const symbols = [...iconSource.matchAll(/<symbol id="c-([a-z]+)"/g)].map(m => m[1]);
    const patterns = [...styles.matchAll(/^\.pat-([a-z]+) \{/gm)].map(m => m[1]);
    expect(symbols.sort()).toEqual([...CATEGORIES].sort());
    expect(patterns.sort()).toEqual([...CATEGORIES].sort());
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/category-assets.test.ts`
Expected: FAIL for `dining`, `exhibition` and `event` (no symbol, no pattern). `art` passes for now because the old easel still carries that id.

- [ ] **Step 4: Icons**

In `web/src/components/Icon.tsx`:

1. Rename the existing easel so exhibitions keep it. Replace the exact text `<symbol id="c-art" viewBox="0 0 137 217">` with `<symbol id="c-exhibition" viewBox="0 0 137 217">` (this string occurs once).
2. Insert these three symbols on their own lines directly before the line that starts `<symbol id="c-beauty"`. They are drawn as strokes in the same thick-ink style, so each sets its own `fill="none"` (the sprite's default `fill: currentColor` would otherwise fill them):

```html
<symbol id="c-dining" viewBox="0 0 160 160"><g fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"><path d="M32 112a48 48 0 0 1 96 0z"/><path d="M20 128h120"/><circle cx="80" cy="50" r="7"/></g></symbol>
<symbol id="c-art" viewBox="0 0 160 160"><g fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"><circle cx="80" cy="56" r="26"/><path d="M68 54a12 12 0 0 1 12-12"/><path d="M52 92h56v36H52z"/><path d="M38 134h84"/></g></symbol>
<symbol id="c-event" viewBox="0 0 160 160"><g fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"><path d="M22 48h116v24a12 12 0 0 0 0 24v24H22V96a12 12 0 0 0 0-24z"/><path d="M100 58v6M100 81v6M100 104v6"/></g></symbol>
```

3. In the `IconName` type (a single long line starting `export type IconName = 'i-search' | ...`), replace the exact text

```
'c-food' | 'c-fashion' | 'c-sample' | 'c-art' | 'c-market' | 'c-beauty' | 'c-tech' | 'c-other'
```

with

```
`c-${Category}`
```

and add this import at the top of the file, under its leading comment:

```ts
import type { Category } from '../../../src/shared/categories';
```

In `web/src/lib/format.ts` the cast in `catIcon` is no longer needed. Replace

```ts
export const catIcon = (c: Category) => `c-${c}` as IconName;
```

with

```ts
export const catIcon = (c: Category): IconName => `c-${c}`;
```

- [ ] **Step 5: Cover patterns**

In `web/src/styles.css`, replace the single `.pat-art { ... }` line (about line 191) with these four lines. Exhibition takes over the old blue stripes, the other three reuse existing tints with a different hatch:

```css
.pat-dining { background-color: var(--you-bg); background-image: repeating-linear-gradient(45deg, rgba(29,27,24,.07) 0 2px, transparent 2px 12px), repeating-linear-gradient(-45deg, rgba(29,27,24,.07) 0 2px, transparent 2px 12px) }
.pat-exhibition { background-color: var(--ai-bg); background-image: repeating-linear-gradient(90deg, rgba(29,27,24,.07) 0 2px, transparent 2px 14px) }
.pat-art { background-color: var(--ai-bg); background-image: radial-gradient(rgba(29,27,24,.13) 1.5px, transparent 1.7px); background-size: 12px 12px }
.pat-event { background-color: var(--sim-bg); background-image: repeating-conic-gradient(rgba(29,27,24,.07) 0 25%, transparent 0 50%); background-size: 22px 22px }
```

- [ ] **Step 6: Run everything**

Run: `npx vitest run` then `npx tsc --noEmit` then `(cd web && npx tsc --noEmit)` then `npm run build:web`
Expected: PASS, clean, and the build succeeds.

- [ ] **Step 7: Look at it**

Run these in a terminal (local dev data only, nothing production):

```bash
npm run db:reset
npx wrangler d1 execute spotted-db --local --command "UPDATE popups SET category = 'dining' WHERE id IN (SELECT id FROM popups WHERE category = 'food' LIMIT 1)"
npx wrangler d1 execute spotted-db --local --command "UPDATE popups SET category = 'exhibition' WHERE id IN (SELECT id FROM popups WHERE category = 'art' LIMIT 1)"
npx wrangler d1 execute spotted-db --local --command "UPDATE popups SET category = 'event' WHERE id IN (SELECT id FROM popups WHERE category = 'market' LIMIT 1)"
npm run dev:local
```

Open `http://localhost:8787` in the browser pane. Check at 1280 px and at 375 px wide: the category chips scroll sideways on the phone and each shows its own icon, the cards for the three changed rows show the cross-hatch, blue stripes and checker covers with the right icons, the Submit page lists all eleven chips, and `?cat=dining` filters. Stop the server afterwards. If an icon reads badly at 18 px (chip) or 62 px (card), adjust its path and re-look. Do not skip this step: the tests only prove the icon exists, not that it looks right.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/Icon.tsx web/src/styles.css web/src/lib/format.ts vitest.config.ts test/env.d.ts test/category-assets.test.ts
git commit -m "Give dining, exhibitions, art pop-ups and events their own icon and cover" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Docs and the agent skill text

**Files:**
- Modify: `skills/spotted-london/SKILL.md` (the "Categories:" paragraph at about lines 92 to 94)
- Modify: `docs/DESIGN.md` (line 42)
- Modify: `SPEC.md` (the `| 範例資料 |` row in §12, and one new row)
- Modify: `README.md` (lines 233 to 237)
- Modify: `CLAUDE.md` (code map, one rule, the Icons rule, the Production data line)

No tests: these are text. Check each by reading the diff.

- [ ] **Step 1: The skill**

In `skills/spotted-london/SKILL.md` replace the paragraph

```
Categories: `food` (food and drink), `fashion` (clothing, shoes, vintage), `sample` (sample sales and
brand giveaways), `art` (exhibitions, installations), `market` (markets and fairs), `beauty`,
`tech`, `other`.
```

with

```
Categories, one per pop-up:

- `food`: pop-up restaurants, stalls, bars, bakeries, tastings.
- `dining`: supper clubs, chef residencies and takeovers, dinner series, festival dinners.
- `market`: street-food, craft, vintage and design markets, and art and design fairs.
- `exhibition`: gallery and museum shows.
- `art`: one-off installations, public art, sculpture trails, immersive work.
- `event`: museum lates, festivals, anniversary parties, talks.
- `fashion` (clothing, shoes, vintage), `sample` (sample sales and brand giveaways), `beauty`, `tech`.
- `other`: anything that fits nothing above.

When two fit, use these rules in order:

1. A meal or drinks night run by a named chef or restaurant at a venue, with a set menu or a dated series, is `dining`. A stall, bar, bakery or tasting open to walk-ins is `food`. A market of several food stalls is `market`.
2. An art fair is `market`. A show of works in a gallery or museum, even a short one, is `exhibition`. A one-off piece, trail or installation in a shop, street or park is `art`.
3. Something with a programme or a crowd rather than a thing to see or buy (a museum late, a festival day, an anniversary party, a talk) is `event`.
4. A brand's temporary shop stays `fashion`, `beauty` or `tech`. If the point is a discount, it is `sample`.
5. Otherwise pick the one a reader would browse under. When none fits, `other`.
```

- [ ] **Step 2: Design doc**

In `docs/DESIGN.md` replace line 42

```
Category covers without a photo use a soft tint plus an ink hatch pattern (`.pat-food`, `.pat-market`, ...), with the category icon on top.
```

with

```
Category covers without a photo use a soft tint plus an ink hatch pattern (`.pat-food`, `.pat-market`, ...), with the category icon on top. Related categories share a tint and differ by hatch: food (diagonal) and dining (cross-hatch) are orange, exhibition (stripes) and art (dots) are blue. The eleven keys live in `src/shared/categories.ts`, and a new one needs a symbol `c-<key>` in `Icon.tsx` and a `.pat-<key>` rule, which `test/category-assets.test.ts` enforces.
```

- [ ] **Step 3: SPEC (Traditional Chinese)**

In `SPEC.md` §12, replace the row

```
| 範例資料 | 線上放標示「Example」的虛構活動、noindex；正式上線前用 `seed/clear-examples.sql` 清除 |
```

with

```
| 範例資料 | 已於 2026-10-02 用 `seed/clear-examples.sql` 從線上清除（9 個虛構活動、165 個假帳號）。`is_example` 欄位與 Example 標示保留，之後要用範例資料可重新載入 `seed/examples.sql` |
```

and add this row directly after the `| Icons |` row (the last row of the table):

```
| 分類 | 11 類，每個活動一類：`food`、`dining`（主廚駐店與晚宴）、`market`（市集與藝博會）、`exhibition`（畫廊與美術館展覽）、`art`（一次性裝置與公共藝術）、`event`、`fashion`、`sample`、`beauty`、`tech`、`other`。清單只寫在 `src/shared/categories.ts`；新增一類要同時加 migration、icon、封面圖案。Scout 與 Triage 的判斷規則在 `skills/spotted-london/SKILL.md`。新分類的 icon 是自繪的線條圖，不是 Koboyo。設計：`docs/superpowers/specs/2026-10-02-category-split-design.md` |
```

- [ ] **Step 4: README**

In `README.md` replace the sentence at line 233

```
The live site has fictional pop-ups marked **Example** (`is_example = 1`), hidden from search engines. Their accounts use `@example.invalid` addresses, so nobody can sign in as them. Regenerate with `python3 scripts/seed.py`.
```

with

```
The live site had fictional pop-ups marked **Example** (`is_example = 1`) until 2026-10-02, when they were removed with `seed/clear-examples.sql`. The column and the label stay. Their accounts used `@example.invalid` addresses, so nobody could sign in as them. To load examples again, regenerate with `python3 scripts/seed.py` and run the first command below.
```

and change the comment on the clear command line (line 237) from `# remove before launch` to `# remove again`. Leave the code fence and the load command as they are.

- [ ] **Step 5: CLAUDE.md**

Four small edits in `CLAUDE.md` (read each line first, the wording may have moved):

1. In the code map, change the `src/shared/` line's tail from `my-state` to `my-state, categories (the one list of pop-up categories)`.
2. In "Rules that are easy to break", add this bullet after the one about the public list and `filterPopups`:

```
- Categories live only in `src/shared/categories.ts`. A new key needs, in the same change: a migration that rebuilds `popups` to widen its CHECK (SQLite cannot alter one: create the new table, copy, drop, rename, with `PRAGMA defer_foreign_keys = on`), an icon symbol `c-<key>` in `Icon.tsx` and a `.pat-<key>` rule in `styles.css`. `test/categories.test.ts` and `test/category-assets.test.ts` fail when one is missing. The tie-break rules are in `skills/spotted-london/SKILL.md` and in the `submit_draft` category text in `src/mcp.ts`: keep them in step.
```

3. At the end of the "Icons:" rule, add: ` The category icons for dining, art and event are drawn in-house as strokes, not Koboyo.`
4. In "Production", replace the line

```
- Live data is fictional examples (`is_example = 1`, labelled, noindex). Clear before launch with `seed/clear-examples.sql`.
```

with

```
- The fictional examples (`is_example = 1`) were cleared on 2026-10-02 with `seed/clear-examples.sql`, so production holds only real pop-ups. The column and the Example label stay.
```

- [ ] **Step 6: Verify and commit**

Run: `git diff --stat` and read `git diff` once. Expected: only the five files above changed, no stray edits.

```bash
git add skills/spotted-london/SKILL.md docs/DESIGN.md SPEC.md README.md CLAUDE.md
git commit -m "Document the eleven categories and that the examples are gone" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Propose categories for the existing rows

**Files:**
- Create: `src/lib/recategorize.ts`
- Create: `scripts/recategorize.mjs`
- Create: `scripts/recategorize-overrides.json`
- Create: `test/recategorize.test.ts`
- Modify: `package.json` (one script)

**Interfaces:**
- Consumes: `Category`, `CATEGORIES` from Task 2.
- Produces, from `src/lib/recategorize.ts` (no runtime imports, so Node can load it with type stripping):
  - `interface Row { id: string; title: string; host: string | null; description: string | null; category: string }`
  - `interface Proposal { id: string; from: string; to: Category; sure: boolean; why: string }`
  - `proposeCategory(row: Row): Proposal`
  - `updateSql(changes: Proposal[]): string`
- Only rows currently `food` or `art` can change. Everything else is returned unchanged with `sure: true`.

- [ ] **Step 1: Write the failing tests**

Create `test/recategorize.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { proposeCategory, updateSql, type Row } from '../src/lib/recategorize';

const row = (category: string, title: string, host: string | null = null, description: string | null = null): Row =>
  ({ id: `id_${title.length}`, category, title, host, description });

describe('proposing a category for an old row', () => {
  it('moves chef dinners from food to dining', () => {
    const p = proposeCategory(row('food', 'Archipelago with Marios Milios at Fig House, Dalston', 'table&candle with chef Marios Milios'));
    expect(p).toMatchObject({ from: 'food', to: 'dining', sure: true });
  });

  it('moves festival dinners to dining even without the word dinner', () => {
    expect(proposeCategory(row('food', 'Gourmet Odyssey Shoreditch', 'London Restaurant Festival')).to).toBe('dining');
  });

  it('moves street-food markets to market', () => {
    expect(proposeCategory(row('food', 'BANCARELLA Italian Street Food Market', 'We Love It CIC at Lower Stable Street Market')))
      .toMatchObject({ to: 'market', sure: true });
  });

  it('keeps real food as food', () => {
    expect(proposeCategory(row('food', 'Mooncake bakery'))).toMatchObject({ to: 'food', sure: true });
  });

  it('suggests event for a restaurant anniversary but is not sure', () => {
    expect(proposeCategory(row('food', 'Planque Turns 5', 'Planque'))).toMatchObject({ to: 'event', sure: false });
  });

  it('keeps food it knows nothing about as food and flags it', () => {
    expect(proposeCategory(row('food', 'Japan Matsuri 2026', 'The Japan Society'))).toMatchObject({ to: 'food', sure: false });
  });

  it('moves art fairs to market', () => {
    expect(proposeCategory(row('art', 'The Other Art Fair London', 'The Other Art Fair'))).toMatchObject({ to: 'market', sure: true });
  });

  it('moves museum lates to event', () => {
    expect(proposeCategory(row('art', 'Tate Modern Lates: 10th Birthday', 'Tate Modern'))).toMatchObject({ to: 'event', sure: true });
  });

  it('keeps one-off sculpture as art', () => {
    expect(proposeCategory(row('art', 'Frieze Sculpture 2026', 'Frieze and The Royal Parks'))).toMatchObject({ to: 'art', sure: true });
  });

  it('moves gallery shows to exhibition', () => {
    expect(proposeCategory(row('art', 'ArtEvol 2026: A View from Everywhere', 'London Art Collective at Saatchi Gallery')))
      .toMatchObject({ to: 'exhibition', sure: true });
  });

  it('falls back to exhibition and flags it when only the description gives a hint', () => {
    expect(proposeCategory(row('art', 'Reverence', 'Anna Blom', 'An exhibition of new paintings'))).toMatchObject({ to: 'exhibition', sure: false });
  });

  it('falls back to exhibition and flags it when there is no hint at all', () => {
    expect(proposeCategory(row('art', 'Create & Annoy', 'StolenSpace'))).toMatchObject({ to: 'exhibition', sure: false });
  });

  it('leaves other categories alone', () => {
    expect(proposeCategory(row('fashion', 'Sign of the Times Preloved Designer Sale'))).toMatchObject({ to: 'fashion', sure: true, why: 'unchanged' });
  });
});

describe('the SQL', () => {
  it('writes one guarded UPDATE per changed row and skips unchanged ones', () => {
    const sql = updateSql([
      { id: 'a1', from: 'food', to: 'dining', sure: true, why: 'x' },
      { id: 'b2', from: 'food', to: 'food', sure: true, why: 'x' },
    ]);
    expect(sql).toBe("UPDATE popups SET category = 'dining' WHERE id = 'a1' AND category = 'food';\n");
  });

  it('escapes quotes in ids', () => {
    expect(updateSql([{ id: "o'brien", from: 'art', to: 'event', sure: true, why: 'x' }])).toContain("WHERE id = 'o''brien'");
  });

  it('is empty when nothing changes', () => {
    expect(updateSql([])).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/recategorize.test.ts`
Expected: FAIL, `Cannot find module '../src/lib/recategorize'`.

- [ ] **Step 3: Write the function**

Create `src/lib/recategorize.ts`:

```ts
// Proposes a new category for a pop-up filed under the old eight keys, from its title, host and description.
// Only food and art rows can change, because those are the two keys whose meaning was split.
// No runtime imports on purpose: scripts/recategorize.mjs loads this file with Node's type stripping.

import type { Category } from '../shared/categories';

export interface Row { id: string; title: string; host: string | null; description: string | null; category: string }
export interface Proposal { id: string; from: string; to: Category; sure: boolean; why: string }

const MARKET = /art fair|design fair|craft fair|book fair|\bfairs?\b|\bmarkets?\b|car boot|flea/i;
const DINING = /supper club|residenc(?:y|ies)|takeover|dinner series|set menu|tasting menu|\bdinners?\b|\bchef\b|restaurant festival/i;
const EVENT = /\blates?\b|festival|anniversary|birthday|party|\btalks?\b|\bturns \d+\b/i;
const ART = /installation|sculpture|public art|mural|immersive|\bzines?\b|ceramic|pottery|\btrail\b/i;
const EXHIBITION = /exhibition|gallery|museum|solo show|group show|retrospective/i;
const FOOD_WORDS = /food|coffee|matcha|bakery|noodle|ramen|pizza|burger|brunch|dessert|gelato|tasting|wine|beer|cocktail|\bbar\b|stall/i;

function fromFood(text: string): Category | null {
  if (DINING.test(text)) return 'dining';
  if (MARKET.test(text)) return 'market';
  if (EVENT.test(text)) return 'event';
  return null;
}

function fromArt(text: string): Category | null {
  if (MARKET.test(text)) return 'market';
  if (EVENT.test(text)) return 'event';
  if (ART.test(text)) return 'art';
  if (EXHIBITION.test(text)) return 'exhibition';
  return null;
}

/**
 * Title and host decide. The description is only a weaker second look, and anything it decides is marked not sure.
 * A food row with no signal stays food, an art row with no signal becomes exhibition (most were gallery shows).
 */
export function proposeCategory(row: Row): Proposal {
  const { id, category: from } = row;
  if (from !== 'food' && from !== 'art') return { id, from, to: from as Category, sure: true, why: 'unchanged' };
  const pick = from === 'food' ? fromFood : fromArt;
  const stay: Category = from === 'food' ? 'food' : 'exhibition';
  const strong = `${row.title} ${row.host ?? ''}`;

  const hit = pick(strong);
  if (hit) return { id, from, to: hit, sure: !(from === 'food' && hit === 'event'), why: `title or host suggests ${hit}` };

  const soft = row.description ? pick(row.description) : null;
  if (soft) return { id, from, to: soft, sure: false, why: `description suggests ${soft}` };

  const looksLikeFood = from === 'food' && FOOD_WORDS.test(strong);
  return { id, from, to: stay, sure: looksLikeFood, why: looksLikeFood ? 'food words, no other signal' : `no signal, kept as ${stay}` };
}

/** One UPDATE per changed row. The `AND category = from` guard makes a second run do nothing and never overwrites a later edit. */
export function updateSql(changes: Proposal[]): string {
  const q = (s: string) => s.replace(/'/g, "''");
  return changes
    .filter(c => c.from !== c.to)
    .map(c => `UPDATE popups SET category = '${c.to}' WHERE id = '${q(c.id)}' AND category = '${c.from}';\n`)
    .join('');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/recategorize.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Write the script**

Create `scripts/recategorize-overrides.json` with an empty object (decisions about single rows go here, by id, once Zack has seen the unsure table):

```json
{}
```

Create `scripts/recategorize.mjs`:

```js
// Proposes finer categories for every pop-up and writes .wrangler/recategorize.sql.
// It only reads the database. Applying the SQL is a separate, deliberate step.
//
//   node scripts/recategorize.mjs            reads production (the remote D1)
//   node scripts/recategorize.mjs --local    reads the local dev D1
//
// scripts/recategorize-overrides.json maps a pop-up id to the category Zack chose, and wins over the guess.
// Needs Node 22.18 or later, which runs the .ts imports below without a flag.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CATEGORIES } from '../src/shared/categories.ts';
import { proposeCategory, updateSql } from '../src/lib/recategorize.ts';

const where = process.argv.includes('--local') ? '--local' : '--remote';
const env = { ...process.env };
delete env.CLOUDFLARE_API_TOKEN; // these two point wrangler at the wrong Cloudflare account
delete env.CLOUDFLARE_ACCOUNT_ID;

const out = execFileSync('npx', [
  'wrangler', 'd1', 'execute', 'spotted-db', where, '--json', '--command',
  'SELECT id, title, host, description, category, status FROM popups WHERE is_example = 0 ORDER BY category, title',
], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const rows = JSON.parse(out)[0].results;

const overrides = JSON.parse(readFileSync(new URL('./recategorize-overrides.json', import.meta.url), 'utf8'));
for (const [id, c] of Object.entries(overrides)) {
  if (!CATEGORIES.includes(c)) throw new Error(`override for ${id}: "${c}" is not a category`);
  if (!rows.some(r => r.id === id)) console.warn(`override for ${id}: no such pop-up, ignored`);
}

const proposals = rows.map(row => {
  const p = proposeCategory(row);
  const o = overrides[row.id];
  return o ? { ...p, to: o, sure: true, why: 'chosen by Zack' } : p;
});
const byId = new Map(rows.map(r => [r.id, r]));

const moves = {};
for (const p of proposals) if (p.from !== p.to) moves[`${p.from} -> ${p.to}`] = (moves[`${p.from} -> ${p.to}`] ?? 0) + 1;
console.log(`${rows.length} pop-ups read from ${where.slice(2)}, ${proposals.filter(p => p.from !== p.to).length} change category.\n`);
console.log('Moves:');
for (const [k, n] of Object.entries(moves).sort()) console.log(`  ${String(n).padStart(3)}  ${k}`);

const unsure = proposals.filter(p => !p.sure);
console.log(`\nNot sure (${unsure.length}). Settle these in scripts/recategorize-overrides.json, then run again:`);
for (const p of unsure) {
  const r = byId.get(p.id);
  console.log(`  ${p.id}  ${r.status.padEnd(18)} ${p.from} -> ${p.to}  ${r.title}  |  ${r.host ?? ''}  (${p.why})`);
}

mkdirSync('.wrangler', { recursive: true });
writeFileSync('.wrangler/recategorize.sql', updateSql(proposals));
console.log('\nWrote .wrangler/recategorize.sql');
```

In `package.json` add one line to `scripts` (after `"db:reset"`):

```json
    "recategorize": "node scripts/recategorize.mjs",
```

- [ ] **Step 6: Try the script against the local dev database**

Run:

```bash
npm run db:reset
node scripts/recategorize.mjs --local
```

Expected: it prints "N pop-ups read from local", a Moves list, a "Not sure" list and "Wrote .wrangler/recategorize.sql", with no stack trace. (Local seed data is fictional, so only the shape of the output matters here. The real run is Task 9.) Then confirm the file is valid SQL: `npx wrangler d1 execute spotted-db --local --file=.wrangler/recategorize.sql` and expect it to finish without an error.

- [ ] **Step 7: Run everything and commit**

Run: `npx vitest run` then `npx tsc --noEmit`
Expected: PASS and clean.

```bash
git add src/lib/recategorize.ts scripts/recategorize.mjs scripts/recategorize-overrides.json test/recategorize.test.ts package.json
git commit -m "Propose finer categories for existing pop-ups and write reviewable SQL" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Rehearse on a copy of production

Nothing in this task touches production. It runs the migration, the script and the UI against the newest backup in a local D1.

**Files:**
- Create: `scripts/table-counts.mjs`
- Modify: `scripts/recategorize-overrides.json` (Zack's choices for the unsure rows)

The rest is evidence (counts, screenshots) reported back to Zack.

- [ ] **Step 1: Load the newest backup into a fresh local D1**

```bash
rm -rf .wrangler/state/v3/d1
BACKUP=$(ls -t backups/spotted-db-*.sql | head -1); echo "$BACKUP"
npx wrangler d1 execute spotted-db --local --file="$BACKUP"
```

Expected: the file loads without errors. The backup already contains `d1_migrations` rows up to `0013_manyfold_backup.sql` (applied to production, but not a file on this branch), so the next step applies only `0014`. If wrangler complains about the file's own `PRAGMA` or `_cf_KV` statements, remove the offending lines from a copy in the scratchpad directory and load the copy. Never edit the file in `backups/`.

- [ ] **Step 2: Add a table-count script and count before the migration**

Create `scripts/table-counts.mjs`. It is used here and again in Task 9, so a before and an after can be diffed:

```js
// Prints "table count" for every table, so a before and an after can be diffed.
// The migration bookkeeping table is left out because it is meant to grow.
//
//   node scripts/table-counts.mjs            production (the remote D1)
//   node scripts/table-counts.mjs --local    the local dev D1

import { execFileSync } from 'node:child_process';

const where = process.argv.includes('--local') ? '--local' : '--remote';
const env = { ...process.env };
delete env.CLOUDFLARE_API_TOKEN; // these two point wrangler at the wrong Cloudflare account
delete env.CLOUDFLARE_ACCOUNT_ID;

function rows(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'spotted-db', where, '--json', '--command', sql],
    { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out)[0].results;
}

const tables = rows(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name",
).map(r => r.name);
for (const t of tables) console.log(`${t} ${rows(`SELECT COUNT(*) AS n FROM "${t}"`)[0].n}`);
```

Then count (still before the migration):

```bash
node scripts/table-counts.mjs --local | tee .wrangler/counts-before.txt
```

Expected: one `table count` line per table, with `popups` equal to the production count at the time of the backup (176 real rows at the time of writing).

- [ ] **Step 3: Apply the migration locally and count again**

```bash
npm run db:migrate
node scripts/table-counts.mjs --local > .wrangler/counts-after.txt
diff .wrangler/counts-before.txt .wrangler/counts-after.txt && echo "counts identical"
npx wrangler d1 execute spotted-db --local --command "PRAGMA foreign_key_check"
```

Expected: `counts identical`, and `foreign_key_check` returns an empty result. Any difference, or any foreign key violation, is a stop: do not continue to Task 9, report it to Zack.

- [ ] **Step 4: Run the proposal script on real data, locally**

```bash
node scripts/recategorize.mjs --local
```

Expected: a Moves list and a "Not sure" list built from the real 176 rows. Keep the full output. Read every row in the "Not sure" list and decide a category for each using the rules in the spec (for example `PAD London` is an art fair so `market`, `Hauser & Wirth Publishers Pop-Up` is a pop-up so `art`). Write the decisions into `scripts/recategorize-overrides.json` as `{ "<id>": "<category>", ... }`, run the script again, and expect the "Not sure" list to be empty or only rows you deliberately left.

- [ ] **Step 5: Apply the SQL locally and look at the result**

```bash
npx wrangler d1 execute spotted-db --local --file=.wrangler/recategorize.sql
npx wrangler d1 execute spotted-db --local --command "SELECT category, COUNT(*) n FROM popups GROUP BY category ORDER BY n DESC"
npm run build:web && npm run dev:local
```

Expected: counts for all eleven categories that have rows, no row left under a key the rules should have moved, and the total unchanged. Open `http://localhost:8787` in the browser pane at 1280 px and 375 px. Check: each category chip filters to a believable set, "Exhibitions" and "Supper Clubs & Residencies" are now sensible sizes, covers and icons look right on real cards, and nothing overflows on the phone. Stop the server.

- [ ] **Step 6: Commit the overrides and report**

```bash
git add scripts/table-counts.mjs scripts/recategorize-overrides.json
git commit -m "Add a table-count check and record the category choices for the unsure rows" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Report to Zack in Traditional Chinese: the counts-identical result, the final per-category counts, the list of rows you settled by hand (id, title, chosen category) so he can disagree, and screenshots of the desktop and phone views. Then stop and wait for his go before Task 9.

---

### Task 9: Roll out to production (each gate waits for Zack's yes)

Every gate below writes to production or to live agents. For each: say exactly what will happen, wait for an explicit yes in chat, do it, verify, report. A yes for one gate is not a yes for the next. Always `env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID` before wrangler.

The order is A (migration), B (PR and merge, the merge deploys), C (publish the new skill version immediately after the deploy finishes, and note the publish time as unix ms `T`), D (reclassify with `--created-before T`). Why: the skill must not be published before the deploy, because the old Worker rejects the new category keys. Reclassification assumes every `food` or `art` row still has the old meaning, so it must never touch rows that agents filed under the new meaning after the skill went live, and the `T` cutoff guarantees that.

**Gate A: apply migration 0014 to remote D1**

- [ ] **Step 1: Fresh backup, pre-apply checks, rehearsal on that backup, and a before count**

```bash
F=backups/spotted-db-$(date +%Y%m%d-%H%M%S).sql
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx wrangler d1 export spotted-db --remote --output "$F"
```

Then check that production still has the shape the migration was written against. The migration rebuilds `popups` from its own `CREATE TABLE`, so anything added outside this repo would be dropped silently:

```bash
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx wrangler d1 execute spotted-db --remote --json --command "PRAGMA table_info(popups)"
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx wrangler d1 execute spotted-db --remote --json --command "SELECT type, name FROM sqlite_master WHERE tbl_name = 'popups'"
```

Expected: `PRAGMA table_info` shows exactly the 38 columns of the `CREATE TABLE popups` in `migrations/0014_categories.sql`, in the same order (`id, slug, title, host, description, category, price_type, price_text, address, borough, lat, lng, geohash, start_at, end_at, hours_text, source_url, status, final_verdict, merged_into, created_by, exist_pos, exist_neg, voter_count, checkin_count, confidence, quality_pos, quality_neg, hot, report_weight, created_at, updated_at, is_example, evidence, evidence_url, evidence_check, lease_agent, lease_until`). `sqlite_master` shows only the table, the four indexes `idx_popups_list`, `idx_popups_geo`, `idx_popups_box`, `idx_popups_user`, and the two automatic indexes (`sqlite_autoindex_popups_1` for the primary key and `sqlite_autoindex_popups_2` for the unique slug), with no triggers. Anything else, such as an extra column or a trigger added outside this repo, is a STOP: the migration would drop it silently. Report it to Zack and do not continue.

The Task 8 rehearsal used an older backup, so repeat it on this fresh one before applying: load the fresh backup into local D1 (as in Task 8 Step 1), run `npm run db:migrate`, run `node scripts/table-counts.mjs --local` before and after the migration and diff the two, and run `npx wrangler d1 execute spotted-db --local --command "PRAGMA foreign_key_check"` (expect an empty result). Any difference or violation is a STOP.

Finally take the production count that the apply will be compared with:

```bash
node scripts/table-counts.mjs | tee .wrangler/prod-before.txt
date +%s000   # note the time of this before count
```

- [ ] **Step 2: Apply (after the yes)**

Consider pausing agent dispatch for these few minutes, so nothing inserts between the two count commands.

```bash
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx wrangler d1 migrations apply spotted-db --remote
```

Expected: it lists `0014_categories.sql` and asks to confirm, then reports it applied. Old code keeps working because the new table accepts a superset of the old values. The migration runs as one transaction and D1 serialises writes, so no row is lost if a Scout run is writing at that moment. A count difference between the before and after counts can only come from a real insert between the two count commands: explain any difference by listing rows with `created_at` greater than the time of the before count (`SELECT id, title, created_at FROM popups WHERE created_at > <before count time> ORDER BY created_at`).

- [ ] **Step 3: Verify**

Run `node scripts/table-counts.mjs > .wrangler/prod-after.txt`, then `diff .wrangler/prod-before.txt .wrangler/prod-after.txt` (expect no difference, or only rows explained by the `created_at` check in Step 2) and `env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx wrangler d1 execute spotted-db --remote --command "PRAGMA foreign_key_check"` (expect an empty result). Open the live site and confirm the list still loads. If a count differs without an explanation, tell Zack straight away and do not continue.

**Gate B: open the PR, Zack merges, the merge deploys**

- [ ] **Step 4: Push and open the PR (after the yes)**

Pushing a branch and opening a PR is outward-facing, so ask first. Then:

```bash
git push -u origin category-split
gh pr create --title "Split the overloaded categories: eleven instead of eight" --body-file .wrangler/pr-body.md
```

Write `.wrangler/pr-body.md` first. It must say, in plain English: what changed (the eleven categories and why, with the 74 `art` and 76 `food` figures), that it **adds migration `0014_categories.sql`, which has already been applied to production** (rebuilds `popups` to widen a `CHECK`, row counts compared before and after), that the existing rows are reclassified separately after the merge from a reviewed script, that the Manyfold skill text changes in a separate step, that the 64 entries in `scripts/recategorize-overrides.json` are proposals pending Zack's confirmation, and the screenshots from Task 8. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Do not enable auto-merge. Zack merges.

- [ ] **Step 5: Verify after Zack merges**

Workers Builds deploys `main`. Once the deploy has finished (check the Cloudflare dashboard build, or wait a few minutes and poll):

```bash
curl -s "https://spotted-london.zack11712.workers.dev/api/v1/popups?when=all&category=dining,exhibition"
```

Expected: JSON with an `items` array (empty until agents file under the new keys or Gate D reclassifies) and not a `category_invalid` error. The live Explore page shows eleven chips.

**Gate C: publish the skill version to the Manyfold library, straight after the deploy**

- [ ] **Step 6: Publish (after the yes) and note the time T**

Do this immediately after the deploy in Step 5 has finished, never before it. `skills/spotted-london/SKILL.md` now holds the new categories and rules, and agents that install the skill from GitHub get it once the PR is merged. The copy in the Manyfold library is the skill `skl_agqpimhpz5y2rcx6wcz7d7v67q` in Zack's Manyfold library, shared by Scout, Triage and Checker, last published as v1.2.0 and now needing v1.3.0. Use the `manyfold:manyfold-cli-usage` skill and `mf help --agent` for the exact publish command, profile and flags (the notes say to use `mf --profile default` only). Before publishing, run `git diff main -- skills/spotted-london/SKILL.md` and make sure nothing else changed in the file that Zack has not seen. Run `date +%s000` right as the publish command finishes and write the value down as `T` (unix ms). After publishing, read the skill back from the library and confirm the new category text is there.

Rows created between the merge and `T` were filed under the old skill, so the reclassification will include them. Review them by hand anyway, because agents that install the skill from GitHub may have used the new meaning from the merge on: list them with `SELECT id, title, category, created_at FROM popups WHERE created_at >= <merge time> AND created_at < <T> ORDER BY created_at` (production, `--remote`) and compare each with what the proposal says in Gate D.

**Gate D: reclassify the existing rows, only those created before T**

- [ ] **Step 7: Show the plan on production data**

```bash
node scripts/recategorize.mjs --created-before T
```

Replace `T` with the value from Step 6. Reads production only, and only rows with `created_at` below `T`, so rows agents filed under the new meaning are never touched. Show Zack the Moves counts and any "Not sure" rows. If production has rows that were not in the local rehearsal (new drafts since the backup), settle them in `scripts/recategorize-overrides.json` and run again until he is happy. Commit any override change.

- [ ] **Step 8: Apply (after the yes)**

```bash
F=backups/spotted-db-$(date +%Y%m%d-%H%M%S).sql
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx wrangler d1 export spotted-db --remote --output "$F"
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx wrangler d1 execute spotted-db --remote --yes --file=.wrangler/recategorize.sql
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx wrangler d1 execute spotted-db --remote --command "SELECT category, COUNT(*) n FROM popups GROUP BY category ORDER BY n DESC"
```

Expected: the per-category counts match the Moves the script printed, and the total equals the `popups` count in `.wrangler/prod-after.txt` plus any rows inserted since. The public list follows within ten minutes (the snapshot cron). After ten minutes, load the live site and check that each chip shows a believable set.

- [ ] **Step 9: Wrap up**

Tell Zack in Traditional Chinese: what is live, the final per-category counts, the backups taken, the value of `T`, and that agents will start using the eleven categories on their next run. Offer to remove the worktree (`git worktree remove ../spotted-london-categories`) and the merged branch once he is happy, and do not do it unasked.

---

## Self-Review Notes

Spec coverage (Task 0 only prepares the worktree): taxonomy and tie-break rules (Tasks 3, 4, 6); data model migration and rehearsal (Tasks 1, 8); reclassification with review table and overrides (Tasks 7, 8, 9D); shared list and each code change (Tasks 2 to 5); agent-facing text and gated skill publish (Tasks 4, 6, 9C); rollout order (Task 9, gates A to D); tests including the drift test (Tasks 1, 2, 5). One deliberate addition to the spec: `scripts/recategorize-overrides.json`, the place where Zack's answers to the unsure rows are recorded so a rerun reproduces them.

Known limits: the new icons are hand-drawn strokes and may need a second pass after Task 5 Step 7 and Task 8 Step 5. `guessCategory` is a fallback that always flags `check`. The reclassifier never reads `status`, so Scout drafts that are still pending are moved with the rest.
