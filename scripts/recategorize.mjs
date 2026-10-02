// Proposes finer categories for every pop-up and writes .wrangler/recategorize.sql.
// It only reads the database. Applying the SQL is a separate, deliberate step.
//
//   node scripts/recategorize.mjs            reads production (the remote D1)
//   node scripts/recategorize.mjs --local    reads the local dev D1
//
// scripts/recategorize-overrides.json maps a pop-up id to the category Zack chose, and wins over the guess.
// Needs Node 22.18 or later, which runs the .ts imports below without a flag.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

const changed = proposals.filter(p => p.from !== p.to);
if (changed.length > 0) {
  const grouped = {};
  for (const p of changed) {
    const key = `${p.from} -> ${p.to}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(p);
  }
  console.log(`\nAll changes (${changed.length}):`);
  for (const key of Object.keys(grouped).sort()) {
    for (const p of grouped[key]) {
      const r = byId.get(p.id);
      const status = p.sure ? '[sure]' : '[not sure]';
      console.log(`  ${p.id}  ${r.status.padEnd(18)} ${p.from} -> ${p.to}  ${r.title}  |  ${r.host ?? ''}  (${p.why})  ${status}`);
    }
  }
}

const unsure = proposals.filter(p => !p.sure);
console.log(`\nNot sure (${unsure.length}). Settle these in scripts/recategorize-overrides.json, then run again:`);
for (const p of unsure) {
  const r = byId.get(p.id);
  console.log(`  ${p.id}  ${r.status.padEnd(18)} ${p.from} -> ${p.to}  ${r.title}  |  ${r.host ?? ''}  (${p.why})`);
}

const repoRoot = fileURLToPath(new URL('../.wrangler/', import.meta.url));
mkdirSync(repoRoot, { recursive: true });
const sql = updateSql(proposals);
if (sql === '') {
  rmSync(`${repoRoot}recategorize.sql`, { force: true });
  console.log('\nNothing to change, no SQL written.');
} else {
  writeFileSync(`${repoRoot}recategorize.sql`, sql);
  console.log('\nWrote .wrangler/recategorize.sql');
}
