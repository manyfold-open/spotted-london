# Small food and shop pop-ups: more sources

Date: 2026-10-02. Status: approved by Zack in chat.

## Problem

Cafe, bakery, ice cream and small shop pop-ups are rare in the list. The seeded sources are big listing sites
(Time Out, Londonist, Hypebeast) and big venues (Westfield, Coal Drops Yard), which mostly publish brand
pop-ups, exhibitions and sample sales. Small food pop-ups are announced on the shop's own Instagram,
on food media (Hot Dinners, The Infatuation, Eater) and at small food markets, none of which were sources.

## What counts

A permanent shop can host a pop-up: a dated collab, a guest chef, baker or bartender, a limited flavour or
menu, a seasonal stand, a weekend stall, a residency in its kitchen. A new branch, a reopening or a
permanent menu item does not count. The rule is in `skills/spotted-london/SKILL.md` (version 1.8.0).

## Changes

1. Migration `0015_food_sources.sql`: 37 new `scout_sources` rows (food media guides, small food markets and
   yards, pop-up space marketplaces, Eventbrite food searches, and 13 searches by kind of thing, two in
   Chinese for Xiaohongshu). Every address was opened and returned a page before it was added. The rows use a
   different `created_at` than the first seed so `test/agents.test.ts` and `test/social.test.ts` clear them.
2. SKILL.md: what a shop-hosted pop-up is, and how to read small shop sources.
3. Watch list of places (not in git): Zack's Google Maps lists are read with his earlier `import-gmaps-list`
   function into `tmp-places/` (ignored). Each in-London place becomes a `brand` source (its website,
   every 14 days) or a `search` source (name, area and "pop-up collab", every 30 days) when no website is
   found. First checks are spread over 14 days. The SQL is generated locally and applied by Zack with
   `wrangler d1 execute`, so the personal list never reaches the repo.
4. Instagram stays off for places: `social` sources are fetched by cron and spend the US$4 Apify budget, so
   handles are kept in the source note only. Decide on Instagram accounts after the first week of numbers.

## Measure

`track_record` per source on /admin/agent after a week: drop sources with no drafts, keep the ones that publish.

## Not changed

Scoring, trust rules, the auto-publish rule and the category list are untouched.
