// One-off check that the real Apify actors still return the fields src/lib/social.ts reads.
// Costs about US$0.05. Run it yourself so the token never leaves your shell:
//
//   read -s APIFY_TOKEN && export APIFY_TOKEN && node scripts/apify-smoke.mjs
//
// It prints the field names of the first item from each actor. If a name differs from the ones
// parseItem() uses, change parseItem() and the fixtures in test/social-lib.test.ts, nothing else.

const token = process.env.APIFY_TOKEN;
if (!token) {
  console.error('Set APIFY_TOKEN first (see the comment at the top of this file).');
  process.exit(1);
}

const runs = [
  ['Instagram hashtag', 'apify~instagram-scraper', { resultsType: 'posts', directUrls: ['https://www.instagram.com/explore/tags/londonpopup/'], resultsLimit: 3, onlyPostsNewerThan: '30 days' }],
  ['Threads search', 'themineworks~threads-scraper', { mode: 'search', searchQuery: 'london pop-up', maxPosts: 3 }],
];

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.apify.com/v2${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
  if (!res.ok) throw new Error(`Apify answered ${res.status} for ${path}`);
  return res.json();
};

for (const [name, actor, input] of runs) {
  console.log(`\n=== ${name} (${actor}) ===`);
  try {
    // waitForFinish holds the request until the run ends, at most 120 seconds.
    const { data: run } = await api(`/acts/${actor}/runs?waitForFinish=120`, { method: 'POST', body: JSON.stringify(input) });
    console.log('status:', run.status, '| usageTotalUsd:', run.usageTotalUsd);
    if (!run.defaultDatasetId) continue;
    const items = await api(`/datasets/${run.defaultDatasetId}/items?format=json&clean=true&limit=3`);
    console.log('items:', items.length);
    if (items[0]) {
      console.log('fields:', Object.keys(items[0]).join(', '));
      const short = Object.fromEntries(Object.entries(items[0]).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 80) : v]));
      console.log('first item:', JSON.stringify(short, null, 2).slice(0, 1500));
    }
  } catch (e) {
    console.log('failed:', e.message);
  }
}
