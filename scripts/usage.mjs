#!/usr/bin/env node
// What this app used on Cloudflare in the last 24 hours and the last 30 days, next to what the Workers Paid plan includes,
// so a surprise shows up here before it shows up on the bill. Read only.
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run usage
//
// The token needs Account Analytics: Read. The numbers come from Cloudflare's GraphQL analytics API and are a few
// minutes behind. The allowances below are the Workers Paid plan's monthly amounts: check the pricing pages
// (developers.cloudflare.com/d1/platform/pricing, /r2/pricing, /workers/platform/pricing) when they matter.
import { readFileSync } from 'node:fs';

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID first.');
  process.exit(1);
}

// Names come from wrangler.jsonc (the first d1_databases, r2_buckets and the Worker's name), or from the file in
// WRANGLER_CONFIG when another config is to be checked.
const config = readFileSync(process.env.WRANGLER_CONFIG || new URL("../wrangler.jsonc", import.meta.url), 'utf8');
const pick = re => config.match(re)?.[1];
const worker = pick(/"name":\s*"([^"]+)"/);
const databaseId = pick(/"database_id":\s*"([^"]+)"/);
const bucket = pick(/"bucket_name":\s*"([^"]+)"/);

// Monthly amounts included in Workers Paid, per product.
const INCLUDED = {
  d1RowsRead: 25_000_000_000, d1RowsWritten: 50_000_000, d1StorageGb: 5,
  r2ClassA: 1_000_000, r2ClassB: 10_000_000, r2StorageGb: 10,
  requests: 10_000_000,
};

const day = n => new Date(Date.now() - n * 86_400_000);
const date = d => d.toISOString().slice(0, 10);
const iso = d => d.toISOString();

async function gql(query, variables) {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors.map(e => e.message).join('; '));
  return body.data.viewer.accounts[0];
}

const QUERY = `query($a: String!, $d1: Date!, $d2: Date!, $t1: Time!, $t2: Time!, $db: String!, $b: String!, $w: String!) {
  viewer { accounts(filter: { accountTag: $a }) {
    d1: d1AnalyticsAdaptiveGroups(limit: 1, filter: { date_geq: $d1, date_leq: $d2, databaseId: $db }) { sum { rowsRead rowsWritten readQueries writeQueries } }
    ops: r2OperationsAdaptiveGroups(limit: 50, filter: { date_geq: $d1, date_leq: $d2, bucketName: $b }) { sum { requests } dimensions { actionType } }
    store: r2StorageAdaptiveGroups(limit: 1, orderBy: [datetime_DESC], filter: { date_geq: $d1, date_leq: $d2, bucketName: $b }) { max { payloadSize metadataSize objectCount } dimensions { datetime } }
    inv: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $w, datetime_geq: $t1, datetime_leq: $t2 }) { sum { requests errors subrequests } }
  } } }`;

async function usage(days) {
  const a = await gql(QUERY, { a: account, d1: date(day(days)), d2: date(day(0)), t1: iso(day(days)), t2: iso(day(0)), db: databaseId, b: bucket, w: worker });
  const d1 = a.d1[0]?.sum ?? {};
  let classA = 0, classB = 0;
  for (const o of a.ops) (/^(Get|Head)/.test(o.dimensions.actionType) ? (classB += o.sum.requests) : (classA += o.sum.requests));
  const store = a.store[0]?.max ?? {};
  return {
    rowsRead: d1.rowsRead ?? 0, rowsWritten: d1.rowsWritten ?? 0, classA, classB,
    requests: a.inv[0]?.sum.requests ?? 0, errors: a.inv[0]?.sum.errors ?? 0,
    storageGb: ((store.payloadSize ?? 0) + (store.metadataSize ?? 0)) / 1e9, objects: store.objectCount ?? 0,
  };
}

const n = v => v.toLocaleString('en-GB');
const share = (v, included, days) => `${((v / (included * days / 30)) * 100).toFixed(1)}%`;

const [d, m] = [await usage(1), await usage(30)];
console.log(`\n${worker}  (D1 ${databaseId}, R2 ${bucket})\n`);
console.log('                      last 24 h         last 30 d     share of the monthly allowance (pro rata)');
const rows = [
  ['D1 rows read', 'rowsRead', INCLUDED.d1RowsRead], ['D1 rows written', 'rowsWritten', INCLUDED.d1RowsWritten],
  ['R2 class A ops', 'classA', INCLUDED.r2ClassA], ['R2 class B ops', 'classB', INCLUDED.r2ClassB],
  ['Worker requests', 'requests', INCLUDED.requests],
];
let warn = false;
for (const [label, k, included] of rows) {
  const s = (d[k] / (included / 30)) * 100;
  if (s >= 50) warn = true;
  console.log(`${label.padEnd(20)}${n(d[k]).padStart(14)}${n(m[k]).padStart(18)}    24 h: ${share(d[k], included, 1).padStart(6)}   30 d: ${share(m[k], included, 30).padStart(6)}${s >= 50 ? '   <-- check' : ''}`);
}
console.log(`${'Worker errors'.padEnd(20)}${n(d.errors).padStart(14)}${n(m.errors).padStart(18)}`);
console.log(`${'R2 storage'.padEnd(20)}${`${d.storageGb.toFixed(2)} GB, ${n(d.objects)} objects`.padStart(32)}    of ${INCLUDED.r2StorageGb} GB included`);
console.log(warn ? '\nA line is at half of its daily share or more: look at what is running (agents, cron, a loop).\n' : '\nEverything is well inside the allowance.\n');
