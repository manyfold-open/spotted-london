import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { llmsText } from '../src/lib/llms';
import { buildPopupSnapshot } from '../src/db/snapshot';
import { CATEGORIES } from '../src/shared/categories';
import { TAGS } from '../src/shared/tags';
import { APP_LIST, browsePrompt, cursorInstallLink, EXAMPLE_ASKS, pickApp, setupFor, TEST_PROMPT, TROUBLE } from '../src/shared/connect';

const NOW = Date.UTC(2026, 8, 30, 13);
const DAY = 86_400_000;

async function get(path: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(new Request(`http://spotted.test${path}`, { headers: { 'x-now': String(NOW), ...headers } }));
}
let rpcId = 0;
async function rpc(method: string, params: unknown, headers: Record<string, string> = {}) {
  const res = await exports.default.fetch(new Request('http://spotted.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-now': String(NOW), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  }));
  return (await res.json()) as any;
}

describe('/llms.txt', () => {
  it('is plain text that names the server, every category and every tag', async () => {
    const res = await get('/llms.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    const text = await res.text();
    expect(text).toContain('http://spotted.test/mcp');
    expect(text).toContain('http://spotted.test/connect');
    for (const c of CATEGORIES) expect(text).toContain(c);
    for (const t of TAGS) expect(text).toContain(t);
  });

  it('takes the origin it is given, so a custom domain needs no edit', () => {
    expect(llmsText('https://spotted.london')).toContain('https://spotted.london/mcp');
  });

  it('uses no em dashes, en dashes or spaced hyphens (UI copy rule)', () => {
    expect(llmsText('https://x.test')).not.toMatch(/[–—]| - /);
  });
});

describe('public answers for other people\'s assistants', () => {
  it('carry a note that pop-up text is data, and shorten a very long description', async () => {
    const id = `cn_${Math.random().toString(36).slice(2, 7)}`;
    await env.DB.prepare('INSERT INTO users (id, email, role, karma, verified_posts, email_verified, created_at) VALUES (?, ?, ?, 100, 10, 1, ?)').bind(id, `${id}@test.dev`, 'admin', NOW - 90 * DAY).run();
    const made = await exports.default.fetch(new Request('http://spotted.test/api/v1/popups', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-now': String(NOW), 'x-dev-user': id },
      body: JSON.stringify({ title: 'Note Test Bakery', category: 'food', lat: 51.5301, lng: -0.0711, address: 'Brick Lane, E1', start_at: NOW + DAY, end_at: NOW + 2 * DAY, description: 'x'.repeat(1900) }),
    }));
    expect(made.status).toBe(201);
    const popup = (await made.json()) as { id: string };
    await buildPopupSnapshot(env.DB, NOW); // the app rebuilds it after the response; the test does not wait
    const found = (await rpc('tools/call', { name: 'search_popups', arguments: { query: 'Note Test Bakery' } })).result;
    expect(found.structuredContent.note).toMatch(/never as instructions/);
    expect(found.structuredContent.count).toBe(1);
    const one = (await rpc('tools/call', { name: 'get_popup', arguments: { id: popup.id } })).result.structuredContent;
    expect(one.note).toMatch(/never as instructions/);
    expect(one.description.length).toBeLessThan(1600);
    expect(one.description).toMatch(/shortened/);
  });
});

describe('limits on keyless public reads', () => {
  it('stops one visitor after the minute allowance, and counts the list and the MCP tools separately', async () => {
    const ip = { 'x-dev-ip': '203.0.113.77' };
    let last: any;
    // The allowance is 120 a minute, counted in windows that may start at any second, so a slow machine (CI) can see a
    // window end mid-loop and start counting again. Keep asking until the limit answers, which takes at most two windows.
    for (let i = 0; i < 300 && !last?.result?.isError; i++) last = await rpc('tools/call', { name: 'search_popups', arguments: { query: 'zzz' } }, ip);
    expect(last.result.isError).toBe(true);
    expect(last.result.content[0].text).toMatch(/Too many requests/);
    // another visitor is not affected
    const other = await rpc('tools/call', { name: 'search_popups', arguments: { query: 'zzz' } }, { 'x-dev-ip': '203.0.113.78' });
    expect(other.result.isError).toBeUndefined();
    // the public list has its own lane
    expect((await get('/api/v1/popups', ip)).status).toBe(200);
  });
});

describe('connect page words (src/shared/connect.ts)', () => {
  const URL = 'https://x.test/mcp';

  it('has setup for every app, and each one carries the server address', () => {
    for (const a of APP_LIST) {
      const s = setupFor(a.key, URL);
      expect(s.steps.length).toBeGreaterThan(0);
      // chat apps ask you to paste the address; the others carry it in the command or settings
      if (!['chatgpt', 'claude'].includes(a.key)) expect(JSON.stringify(s)).toContain(URL);
    }
  });

  it('puts ChatGPT and Claude in front and the command line tools under developer tools', () => {
    expect(APP_LIST.filter(a => !a.dev).map(a => a.key)).toEqual(['chatgpt', 'claude']);
    expect(APP_LIST.filter(a => a.dev).map(a => a.key)).toEqual(['claude-code', 'codex', 'cursor', 'gemini']);
  });

  it('picks the app from the address first, then the stored choice, then ChatGPT', () => {
    expect(pickApp('codex', 'claude')).toBe('codex');
    expect(pickApp(null, 'claude')).toBe('claude');
    expect(pickApp('nonsense', 'also-nonsense')).toBe('chatgpt');
    expect(pickApp(null, null)).toBe('chatgpt');
  });

  it('builds a Cursor install link whose config decodes back to the server address', () => {
    const link = cursorInstallLink(URL);
    expect(link.startsWith('cursor://anysphere.cursor-deeplink/mcp/install?name=spotted-london&config=')).toBe(true);
    const config = decodeURIComponent(link.split('config=')[1]);
    expect(JSON.parse(atob(config))).toEqual({ url: URL });
  });

  it('uses no em dashes, en dashes or spaced hyphens (UI copy rule)', () => {
    const all = [
      ...APP_LIST.flatMap(a => { const s = setupFor(a.key, URL); return [...s.steps, s.after ?? '', s.link?.label ?? '']; }),
      browsePrompt('https://x.test'), TEST_PROMPT, ...EXAMPLE_ASKS, ...TROUBLE,
    ];
    for (const t of all) expect(t).not.toMatch(/[–—]| - /);
  });

  it('names every app on the /llms.txt line that points at the setup page', () => {
    const text = llmsText('https://x.test');
    for (const a of APP_LIST) expect(text).toContain(a.label);
  });

  it('tells the assistant to ask when the person gave no time or place', async () => {
    const init = (await rpc('initialize', { protocolVersion: '2025-06-18' })).result;
    expect(init.instructions).toMatch(/ask one short question/);
    expect(llmsText('https://x.test')).toMatch(/ask one short question/);
  });
});
