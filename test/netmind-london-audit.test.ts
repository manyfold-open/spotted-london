import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { routeEvent, type InboundEvent, type RoomContext } from '@manyfold/narra-agent-kit';
import {
  SPOTTED_AGENT_SPEC,
  SPOTTED_MATRIX_ID,
  fastRespondSpotted,
  fetchSpottedUpdates,
  specificNameTerms,
} from '../src/narra/gateway';
import type { Bindings } from '../src/types';

// Cases from the Netmind London group, 2026-11-23..25.
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.now();
const MEM = { userMemories: [], roomMemories: [], promptSafeLines: [] };
const A2A_ENV = {
  ...(env as unknown as Bindings),
  MANYFOLD_A2A_URL: 'https://a2a.spotted.test/rpc',
  MANYFOLD_A2A_TOKEN: 'a2a_spotted_test_tok',
} as Bindings;

function makeEvent(text: string, ts = NOW): InboundEvent {
  return {
    roomId: '!london:matrix.netmind.chat',
    chatType: 'group',
    eventId: `$ev_${text.length}_${ts}`,
    senderId: '@zack:matrix.netmind.chat',
    senderName: 'Zack',
    type: 'm.room.message',
    kind: 'text',
    msgtype: 'm.text',
    text,
    timestampMs: ts,
    timeIso: new Date(ts).toISOString(),
    mentions: [],
  };
}

async function seed(id: string, title: string, borough: string, category = 'market') {
  await env.DB.prepare(
    `INSERT INTO popups
     (id, slug, title, host, description, category, price_type, price_text, address, borough, lat, lng, geohash, start_at, end_at, hours_text, source_url, status, created_by, created_at, updated_at, hot, is_example)
     VALUES (?, ?, ?, 'Host', 'A pop-up', ?, 'free', NULL, ?, ?, 51.5, -0.1, 'gcpvj', ?, ?, '10:00-18:00', 'https://example.com', 'verified_admin', 'ng_admin', ?, ?, 2.5, 0)`,
  )
    .bind(id, id, title, category, `${borough} address`, borough, NOW - HOUR, NOW + 5 * DAY, NOW - DAY, NOW)
    .run();
}

describe('Netmind London audit fixes', () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM popups WHERE id LIKE 'nla_%'").run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, email, display_name, role, karma, email_verified, created_at) VALUES ('ng_admin', 'ng_admin@test.dev', 'Admin', 'admin', 100, 1, ?)",
    ).bind(NOW - 90 * DAY).run();
  });

  it('finds the specific name in a short message', () => {
    expect(specificNameTerms('Leadenhall Market')).toEqual(['leadenhall']);
    expect(specificNameTerms('any pop up in leadenhall market？')).toEqual(['leadenhall']);
    expect(specificNameTerms('Is there anything fun at Leadenhall Market this weekend?')).toEqual(['leadenhall']);
    expect(specificNameTerms('What can we do in London tonight after work?')).toEqual([]);
    expect(specificNameTerms('gta快闪在哪里')).toEqual(['gta']);
    expect(specificNameTerms('有什么popup可以去玩吗')).toEqual([]);
    expect(specificNameTerms('Any more?')).toEqual([]);
    expect(specificNameTerms('What can we do in London this weekend with friends?')).toEqual([]);
  });

  it('does not answer "Leadenhall Market" with an unrelated market list when the concierge can search', async () => {
    await seed('nla_canopy', 'Canopy Christmas Market', "King's Cross");
    const event = makeEvent('Leadenhall Market');
    const context: RoomContext = { roomId: event.roomId, chatType: 'group', members: [], recentHistory: [] };
    const decision = { shouldReply: true, tier: 0, reason: 'explicit_mention', confidence: 1, detectedLang: 'en', shouldQuote: false } as const;
    expect(await fastRespondSpotted(A2A_ENV, event, decision, MEM, context)).toBeNull();
    // Same question as a sentence (Netmind London, 12:05).
    expect(await fastRespondSpotted(A2A_ENV, makeEvent('any pop up in leadenhall market？'), decision, MEM, context)).toBeNull();
    // A matching listing is still answered straight from the database.
    await seed('nla_leaden', 'Leadenhall Market Christmas Lights', 'City of London');
    const reply = await fastRespondSpotted(A2A_ENV, event, decision, MEM, context);
    expect(reply).toContain('Leadenhall Market Christmas Lights');
  });

  it('puts pop-ups it has not just recommended first', async () => {
    await seed('nla_a', 'Anne Ryan Folkmoot', 'City of London', 'exhibition');
    await seed('nla_b', 'Earthly Paradise', 'Walthamstow', 'exhibition');
    await seed('nla_c', 'Living Room Gallery', 'Shoreditch', 'exhibition');
    const event = makeEvent('有什么popup可以去玩吗');
    const prior = {
      eventId: '$prev',
      senderId: SPOTTED_MATRIX_ID,
      isAgent: true,
      isSelf: true,
      text: 'https://app.manyfold.ai/spotted-london/p/nla_a\nhttps://app.manyfold.ai/spotted-london/p/nla_b',
      timestampMs: NOW - 60_000,
    };
    const context: RoomContext = { roomId: event.roomId, chatType: 'group', members: [], recentHistory: [prior] };
    const decision = await routeEvent(event, { ...context, recentHistory: [] }, SPOTTED_AGENT_SPEC, { nowMs: NOW });
    const reply = (await fastRespondSpotted(env as unknown as Bindings, event, { ...decision, reason: 'explicit_mention' }, MEM, context)) ?? '';
    expect(reply.indexOf('Living Room Gallery')).toBeGreaterThan(-1);
    expect(reply.indexOf('Living Room Gallery')).toBeLessThan(reply.indexOf('Anne Ryan Folkmoot'));
  });

  it('hands an after-work question with no listed evening hours to the concierge instead of a dead end', async () => {
    await seed('nla_day', 'Daytime Only', 'Holborn', 'exhibition');
    const event = makeEvent('今天下班去哪儿玩');
    const context: RoomContext = { roomId: event.roomId, chatType: 'group', members: [], recentHistory: [] };
    const decision = await routeEvent(event, context, SPOTTED_AGENT_SPEC, { nowMs: NOW });
    const reply = await fastRespondSpotted(A2A_ENV, event, decision, MEM, context);
    expect(reply ?? '').not.toContain('找不到');
  });

  it('digests render in the room language and carry the pop-up ids for per-room dedupe', async () => {
    await env.DB.prepare(
      `INSERT INTO popups (id, slug, title, host, description, category, price_type, address, borough, lat, lng, geohash, start_at, end_at, hours_text, source_url, status, created_by, created_at, updated_at, hot, is_example)
       VALUES ('nla_gta', 'nla_gta', 'GTA 6 pop-up store', 'Host', 'Merch', 'other', 'free', 'Selfridges', 'Mayfair', 51.5, -0.15, 'gcpvj', ?, ?, '10:00-21:00', 'https://example.com', 'verified_admin', 'ng_admin', ?, ?, 2.5, 0)`,
    ).bind(NOW - HOUR, NOW + 3 * DAY, NOW - DAY, NOW).run();
    const syncNs = {
      idFromName: (n: string) => n as unknown as DurableObjectId,
      get: () => ({ fetch: async () => Response.json({ roomIds: ['!london:matrix.netmind.chat'] }) }),
    } as unknown as DurableObjectNamespace;
    const updates = await fetchSpottedUpdates({ ...(env as unknown as Bindings), NARRA_SYNC_DO: syncNs }, new Date(NOW - DAY).toISOString());
    expect(updates[0]?.itemKeys).toContain('nla_gta');
    expect(updates[0]?.render?.('zh-Hans', ['nla_gta'])).toContain('伦敦新验证快闪活动推荐');
    expect(updates[0]?.render?.('zh-Hant', ['nla_gta'])).toContain('GTA 6 pop-up store');
  });
});
