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
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'manyfold-spotted-london-db', where, '--json', '--command', sql],
    { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out)[0].results;
}

const tables = rows(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name",
).map(r => r.name);
for (const t of tables) console.log(`${t} ${rows(`SELECT COUNT(*) AS n FROM "${t}"`)[0].n}`);
