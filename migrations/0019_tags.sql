-- Tags for finer taste (docs/superpowers/specs/2026-10-08-scout-tags-design.md).
--
-- popups.tags holds NULL (nobody has looked yet), '' (looked, none apply) or ',a,b,' (sorted keys from
-- src/shared/tags.ts with a comma at each end, so a tag is found with instr(tags, ',a,')). No CHECK: the list of tags is
-- code, so adding or retiring one needs no migration.
--
-- Safe for the code deployed before this migration: it names its columns in every INSERT and ignores columns it does not
-- know. Any future migration that rebuilds `popups` (a new category does) must carry this column along.
ALTER TABLE popups ADD COLUMN tags TEXT;
