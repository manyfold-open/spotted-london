import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import {
  heuristicDomainScore,
  isNarraGatewayEnabled,
  kickNarraGateway,
  routeEvent,
  staggerWindowMinute,
  type InboundEvent,
} from '@manyfold/narra-agent-kit';
import { seal } from '../src/lib/seal';
import {
  SPOTTED_AGENT_ID,
  SPOTTED_AGENT_SPEC,
  SPOTTED_MATRIX_ID,
  extractPopupQueryFilter,
  fastRespondSpotted,
  fetchSpottedUpdates,
  resolveSpottedA2ACredential,
  spottedGatewayConfig,
} from '../src/narra/gateway';
import worker, { NarraMatrixSync, NarraRoomCoordinator } from '../src/index';
import type { Bindings } from '../src/types';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0); // Fri 9 Oct 2026

function makeEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    roomId: '!spotted_grp:matrix.netmind.chat',
    chatType: 'group',
    eventId: '$sp_ev_1',
    senderId: '@alice:matrix.netmind.chat',
    senderName: 'Alice',
    type: 'm.room.message',
    kind: 'text',
    msgtype: 'm.text',
    text: "What's on in Soho this weekend?",
    timestampMs: NOW,
    timeIso: new Date(NOW).toISOString(),
    mentions: [],
    ...overrides,
  };
}

describe('spotted-london Narra Gateway', () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO users (id, email, display_name, role, karma, email_verified, created_at) VALUES ('ng_admin', 'ng_admin@test.dev', 'Admin', 'admin', 100, 1, ?)",
      ).bind(NOW - 90 * DAY),
      env.DB.prepare(
        "INSERT OR IGNORE INTO users (id, email, display_name, role, karma, email_verified, created_at) VALUES ('ng_user', 'ng_user@test.dev', 'User', 'user', 20, 1, ?)",
      ).bind(NOW - 90 * DAY),
    ]);
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM popups WHERE id LIKE 'ng_%'"),
      env.DB.prepare("DELETE FROM agents WHERE id LIKE 'ng_%'"),
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedPopup(id: string, overrides: {
    title?: string;
    category?: string;
    borough?: string;
    priceType?: 'free' | 'paid' | 'unknown';
    status?: string;
    startAt?: number;
    endAt?: number;
    isExample?: number;
    updatedAt?: number;
  } = {}) {
    await env.DB.prepare(
      `INSERT INTO popups
       (id, slug, title, host, description, category, price_type, price_text, address, borough, lat, lng, geohash, start_at, end_at, hours_text, source_url, status, created_by, created_at, updated_at, hot, is_example)
       VALUES (?, ?, ?, 'Host', 'Pop-up description', ?, ?, ?, '10 Berwick St, W1F', ?, 51.5135, -0.134, 'gcpvj', ?, ?, '10:00-18:00', 'https://example.com', ?, 'ng_admin', ?, ?, 2.5, ?)`,
    )
      .bind(
        id,
        id,
        overrides.title ?? `Popup ${id}`,
        overrides.category ?? 'exhibition',
        overrides.priceType ?? 'free',
        overrides.priceType === 'paid' ? '£15' : null,
        overrides.borough ?? 'Soho',
        overrides.startAt ?? NOW - HOUR,
        overrides.endAt ?? NOW + 5 * DAY,
        overrides.status ?? 'verified_admin',
        NOW - DAY,
        overrides.updatedAt ?? NOW,
        overrides.isExample ?? 0,
      )
      .run();
  }

  it('defines spotted-guide AgentSpec and routes London pop-ups while staying silent on off-domain chatter', async () => {
    expect(SPOTTED_AGENT_SPEC.id).toBe('spotted-guide');
    expect(SPOTTED_AGENT_SPEC.matrixId).toBe(SPOTTED_MATRIX_ID);
    expect(SPOTTED_AGENT_SPEC.aliases).toEqual(
      expect.arrayContaining(['Spotted London', 'Spotted', '快闪', '快閃', 'spotted-guide']),
    );
    expect(SPOTTED_AGENT_SPEC.domainKeywords).toEqual(
      expect.arrayContaining(['popup', 'popups', '快閃']),
    );

    const enPopups = await routeEvent(
      makeEvent({ text: 'Any popups in London?' }),
      { roomId: '!grp:matrix.netmind.chat', chatType: 'group', members: [], recentHistory: [] },
      SPOTTED_AGENT_SPEC,
      { nowMs: NOW },
    );
    expect(enPopups.shouldReply).toBe(true);
    expect(enPopups.detectedLang).toBe('en');

    const zhHant = await routeEvent(
      makeEvent({ text: '這週末倫敦有什麼快閃活動？' }),
      { roomId: '!grp:matrix.netmind.chat', chatType: 'group', members: [], recentHistory: [] },
      SPOTTED_AGENT_SPEC,
      { nowMs: NOW },
    );
    expect(zhHant.shouldReply).toBe(true);
    expect(zhHant.detectedLang).toBe('zh-Hant');

    const zhHans = await routeEvent(
      makeEvent({ text: '伦敦周末有什么市集或展览？' }),
      { roomId: '!grp:matrix.netmind.chat', chatType: 'group', members: [], recentHistory: [] },
      SPOTTED_AGENT_SPEC,
      { nowMs: NOW },
    );
    expect(zhHans.shouldReply).toBe(true);
    expect(zhHans.detectedLang).toBe('zh-Hans');

    const offDomain = await routeEvent(
      makeEvent({ text: 'Best Sichuan hotpot and dim sum in Chinatown?' }),
      { roomId: '!grp:matrix.netmind.chat', chatType: 'group', members: [], recentHistory: [] },
      SPOTTED_AGENT_SPEC,
      { nowMs: NOW },
    );
    expect(offDomain.shouldReply).toBe(false);
  });

  it('gates GET /api/admin/gateway/status strictly behind requireAdmin (401 unauth, 403 non-admin, 200 admin) and redacts secrets', async () => {
    const unauth = await exports.default.fetch(
      new Request('http://spotted.test/api/admin/gateway/status', {
        headers: { 'x-now': String(NOW) },
      }),
    );
    expect(unauth.status).toBe(401);

    const nonAdmin = await exports.default.fetch(
      new Request('http://spotted.test/api/admin/gateway/status', {
        headers: { 'x-now': String(NOW), 'x-dev-user': 'ng_user' },
      }),
    );
    expect(nonAdmin.status).toBe(403);

    const v1Unauth = await exports.default.fetch(
      new Request('http://spotted.test/api/v1/admin/gateway/status', {
        headers: { 'x-now': String(NOW) },
      }),
    );
    expect(v1Unauth.status).toBe(401);

    const mountedUnauth = await worker.fetch(
      new Request('https://app.manyfold.ai/spotted-london/api/admin/gateway/status', {
        headers: { 'x-now': String(NOW) },
      }),
      { ...(env as unknown as Bindings), BASE_PATH: '/spotted-london', ENVIRONMENT: 'development' },
      { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
    );
    expect(mountedUnauth.status).toBe(401);

    const adminRes = await exports.default.fetch(
      new Request('http://spotted.test/api/admin/gateway/status', {
        headers: { 'x-now': String(NOW), 'x-dev-user': 'ng_admin' },
      }),
    );
    expect(adminRes.status).toBe(200);
    const json = (await adminRes.json()) as Record<string, unknown>;
    expect(json.enabled).toBe(false);
    expect(json.syncEnabled).toBe(false);
    expect(json.agentId).toBe('spotted-guide');
    expect(json.matrixId).toBe(SPOTTED_MATRIX_ID);
    expect(json.config).toMatchObject({
      NARRA_GATEWAY_ENABLED: 'on',
      NARRA_SYNC: 'on',
      hasNarraAgentToken: false,
      hasSyncDoBinding: true,
      hasRoomDoBinding: true,
      hasDatabaseBinding: true,
    });
  });

  it('guarantees disabled no-op on DO bindings, kickNarraGateway, and */5 * * * * scheduled handler', async () => {
    expect(typeof NarraMatrixSync).toBe('function');
    expect(typeof NarraRoomCoordinator).toBe('function');
    const typedEnv = env as unknown as Bindings;
    expect(isNarraGatewayEnabled(typedEnv)).toBe(false);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const kickRes = await kickNarraGateway(typedEnv, spottedGatewayConfig);
    expect(kickRes).toEqual({
      enabled: false,
      syncKicked: false,
      syncRunning: false,
      broadcast: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    await worker.scheduled(
      { cron: '*/5 * * * *', scheduledTime: NOW, noRetry() {} } as ScheduledController,
      typedEnv,
      ctx,
    );
    await Promise.all(pending);
    expect(fetchSpy).not.toHaveBeenCalled();

    const syncStub = typedEnv.NARRA_SYNC_DO!.get(typedEnv.NARRA_SYNC_DO!.idFromName('narra'));
    const syncKick = (await (
      await syncStub.fetch('https://narra-sync/kick', { method: 'POST' })
    ).json()) as Record<string, unknown>;
    expect(syncKick).toEqual({ ok: true, enabled: false, running: false });

    const roomStub = typedEnv.NARRA_ROOM_DO!.get(typedEnv.NARRA_ROOM_DO!.idFromName('!test:matrix.netmind.chat'));
    const roomRes = (await (
      await roomStub.fetch('https://narra-room/events', {
        method: 'POST',
        body: JSON.stringify({ roomId: '!test:matrix.netmind.chat', events: [] }),
      })
    ).json()) as Record<string, unknown>;
    expect(roomRes).toEqual({ ok: true, enabled: false, ignored: true });
  });

  it('fetchUpdates queries up to 3 newly verified upcoming non-example pop-ups with bare links and dedupes broadcasts', async () => {
    await seedPopup('ng_v1', { title: 'Soho Print Show', status: 'verified_admin', updatedAt: Date.now(), endAt: Date.now() + 3 * DAY });
    await seedPopup('ng_v2', { title: 'Hackney Ceramic Market', status: 'verified_community', updatedAt: Date.now() - 1000, endAt: Date.now() + 4 * DAY });
    await seedPopup('ng_unverified', { title: 'Unverified Post', status: 'community', updatedAt: Date.now(), endAt: Date.now() + 3 * DAY });
    await seedPopup('ng_example', { title: 'Example Post', status: 'verified_admin', isExample: 1, updatedAt: Date.now(), endAt: Date.now() + 3 * DAY });
    await seedPopup('ng_ended', { title: 'Ended Post', status: 'verified_admin', updatedAt: Date.now(), endAt: Date.now() - DAY });

    const groupRoom = '!spotted_bcast:matrix.netmind.chat';
    const syncNs = {
      idFromName: (n: string) => n as unknown as DurableObjectId,
      get: () => ({
        fetch: async (url: string) =>
          url.endsWith('/kick')
            ? Response.json({ ok: true, enabled: true, running: true })
            : Response.json({ roomIds: [groupRoom] }),
      }),
    } as unknown as DurableObjectNamespace;

    const testEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
      NARRA_SYNC_DO: syncNs,
    };

    const updates = await fetchSpottedUpdates(testEnv, new Date(Date.now() - DAY).toISOString());
    expect(updates).toHaveLength(1);
    expect(updates[0].text).toContain('Soho Print Show');
    expect(updates[0].text).toContain('Hackney Ceramic Market');
    expect(updates[0].text).not.toContain('Unverified Post');
    expect(updates[0].text).not.toContain('Example Post');
    expect(updates[0].text).not.toContain('Ended Post');
    expect(updates[0].text).toContain('https://app.manyfold.ai/spotted-london/p/ng_v1');
    expect(updates[0].text).not.toMatch(/\]\(https?:\/\//);

    const minute = staggerWindowMinute('spotted-guide', groupRoom, 60);
    const fixedDate = new Date('2026-10-09T12:00:00.000Z');
    fixedDate.setUTCMinutes(minute, 0, 0);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/api/agent-runtime/chat/send')) {
        return Response.json({ status: 'ok', data: { event_id: '$spotted_bcast_1' } });
      }
      return new Response('not found', { status: 404 });
    });

    const enabledEnv: Bindings = {
      ...testEnv,
      NARRA_GATEWAY_ENABLED: 'on',
      NARRA_SYNC: 'off',
      NARRA_AGENT_TOKEN: 'narra_spotted_tok_123',
      NARRA_AGENT_ID: SPOTTED_AGENT_ID,
    };

    const cfg = { ...spottedGatewayConfig, now: () => fixedDate.getTime() };
    const first = await kickNarraGateway(enabledEnv, cfg);
    expect(first.broadcast?.sent).toHaveLength(1);
    const second = await kickNarraGateway(enabledEnv, cfg);
    expect(second.broadcast?.sent).toHaveLength(0);
    expect(second.broadcast?.skipped).toEqual(
      expect.arrayContaining([{ roomId: groupRoom, updateKey: updates[0].updateKey, reason: 'duplicate_update_key' }]),
    );
  });

  it('fastRespond queries D1 popups in zh-Hant, zh-Hans, en, voice, optional env.AI, and falls back to A2A', async () => {
    const liveEnd = Date.now() + 7 * DAY;
    await seedPopup('ng_soho', {
      title: 'Berwick Street Vinyl Pop-up',
      category: 'market',
      borough: 'Soho',
      priceType: 'free',
      status: 'verified_admin',
      startAt: Date.now() - HOUR,
      endAt: liveEnd,
    });

    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
    };

    const enReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ text: 'Any free markets in Soho this week?' }),
      {
        shouldReply: true,
        tier: 1,
        reason: 'domain_match',
        confidence: 0.8,
        detectedLang: 'en',
        shouldQuote: false,
      },
      emptyMem,
    );
    expect(enReply).toContain('Berwick Street Vinyl Pop-up');
    expect(enReply).toContain('https://app.manyfold.ai/spotted-london/p/ng_soho');
    expect(enReply).not.toMatch(/\]\(https?:\/\//);

    const hantReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ text: '這週 Soho 有什麼免費市集？' }),
      {
        shouldReply: true,
        tier: 1,
        reason: 'domain_match',
        confidence: 0.8,
        detectedLang: 'zh-Hant',
        shouldQuote: false,
      },
      emptyMem,
    );
    expect(hantReply).toContain('倫敦快閃活動');
    expect(hantReply).toContain('已驗證');

    const hansReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ text: '这周 Soho 有什么免费市集？' }),
      {
        shouldReply: true,
        tier: 1,
        reason: 'domain_match',
        confidence: 0.8,
        detectedLang: 'zh-Hans',
        shouldQuote: false,
      },
      emptyMem,
    );
    expect(hansReply).toContain('伦敦快闪活动');
    expect(hansReply).toContain('已验证');

    // Optional env.AI extraction helps handle free-form wording when deterministic keywords don't match
    vi.spyOn(env.AI, 'run').mockResolvedValueOnce({
      response: JSON.stringify({ when: 'week', category: 'market', free: true, q: 'Soho' }),
    } as never);
    const aiAssistedReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ text: 'Somewhere fun around Berwick Street?' }),
      {
        shouldReply: true,
        tier: 0,
        reason: 'explicit_mention',
        confidence: 1,
        detectedLang: 'en',
        shouldQuote: false,
      },
      emptyMem,
    );
    expect(aiAssistedReply).toContain('Berwick Street Vinyl Pop-up');

    const voiceReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'dm', text: 'Any free markets in Soho this week?', isVoice: true }),
      {
        shouldReply: true,
        tier: 0,
        reason: 'dm',
        confidence: 1,
        detectedLang: 'en',
        shouldQuote: false,
      },
      emptyMem,
    );
    expect(voiceReply).toContain('Berwick Street Vinyl Pop-up');
    expect(voiceReply).not.toMatch(/https?:\/\//);

    // Complex follow-up falls back to A2A (returns null)
    const fallback = await fastRespondSpotted(
      typedEnv,
      makeEvent({ text: 'How do I get there by tube from Euston?' }),
      {
        shouldReply: true,
        tier: 0,
        reason: 'active_session',
        confidence: 0.95,
        detectedLang: 'en',
        shouldQuote: false,
      },
      emptyMem,
    );
    expect(fallback).toBeNull();
  });

  it('resolves Manyfold A2A credential from env override or sealed concierge row', async () => {
    const sealed = await seal(env.AGENTS_KEY, 'spotted_a2a_secret_token_999');
    await env.DB.prepare(
      `INSERT INTO agents (id, role, name, user_id, enabled, schedule, run_hour, max_items, rpc_url, token_sealed, token_hint, updated_at, created_at)
       VALUES ('ng_concierge', 'concierge', 'Spotted Guide', 'ng_admin', 1, 'manual', 7, 5, 'https://api.manyfold.ai/api/a2a/agents/spotted/rpc', ?, '…999', ?, ?)`,
    )
      .bind(sealed, NOW, NOW)
      .run();

    const cred = await resolveSpottedA2ACredential(env as unknown as Bindings);
    expect(cred).toEqual({
      url: 'https://api.manyfold.ai/api/a2a/agents/spotted/rpc',
      token: 'spotted_a2a_secret_token_999',
      label: 'Spotted Guide',
    });
  });

  it('handles DM bare 你好 cleanly when decision.reason === "dm" and strips sibling agent mentions', async () => {
    await seedPopup('ng_dm_popup', {
      title: 'Brick Lane Vintage Market',
      category: 'market',
      borough: 'Shoreditch',
      priceType: 'free',
      status: 'verified_admin',
      startAt: Date.now() - HOUR,
      endAt: Date.now() + 7 * DAY,
    });

    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
    };

    // Sibling + self mention stripping in extractPopupQueryFilter
    const filter = extractPopupQueryFilter('@問一籤 @Spotted London 這週末 Soho 有什麼免費市集？');
    expect(filter).toMatchObject({
      when: 'weekend',
      category: 'market',
      free: '1',
      q: 'Soho',
      isClearSearch: true,
    });

    const englishSiblingFilter = extractPopupQueryFilter(
      '@AI Tarot @AI Fortune Stick @Spotted London Any free popups in Soho this weekend?',
    );
    expect(englishSiblingFilter).toMatchObject({
      when: 'weekend',
      free: '1',
      q: 'Soho',
      isClearSearch: true,
    });

    // Wire event may still say chatType: 'group' when router inferred decision.reason === 'dm'
    const dmEvent = makeEvent({ chatType: 'group', text: '你好' });
    const dmDecision = await routeEvent(
      makeEvent({ chatType: 'dm', text: '你好' }),
      { roomId: '!spotted_dm:matrix.netmind.chat', chatType: 'dm', members: [], recentHistory: [] },
      SPOTTED_AGENT_SPEC,
      { nowMs: NOW },
    );
    expect(dmDecision.shouldReply).toBe(true);
    expect(dmDecision.reason).toBe('dm');
    expect(dmDecision.detectedLang).toBe('zh-Hant');

    const reply = await fastRespondSpotted(typedEnv, dmEvent, dmDecision, emptyMem);
    expect(reply).not.toBeNull();
    expect(reply).toContain('你好！這幾天倫敦有幾個不錯的快閃活動');
    expect(reply).toContain('Brick Lane Vintage Market');
    expect(reply).toContain('https://app.manyfold.ai/spotted-london/p/ng_dm_popup');

    // Also handles @Spotted London 你好 in DM
    const mentionedReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: '@Spotted London 你好' }),
      dmDecision,
      emptyMem,
    );
    expect(mentionedReply).toBe(reply);
  });

  it('guards unmentioned active_session chatter and MFD antiKeywords with [NO_REPLY] while preserving genuine pop-up queries', async () => {
    await seedPopup('ng_weekend_exhibit', {
      title: 'Tate Pop-up Print Lab',
      category: 'exhibition',
      borough: 'Southwark',
      priceType: 'free',
      status: 'verified_admin',
      startAt: Date.now() - HOUR,
      endAt: Date.now() + 7 * DAY,
    });

    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
    };

    const chatterFilter = extractPopupQueryFilter('今天天氣真不錯，晚上想早點休息');
    expect(chatterFilter.when).toBe('today');
    expect(chatterFilter.isClearSearch).toBe(false);

    const hackathonFilter = extractPopupQueryFilter('最近有哪些 AI 黑客松可以報名？');
    expect(hackathonFilter.when).toBe('week');
    expect(hackathonFilter.isClearSearch).toBe(false);

    const genuineFilter = extractPopupQueryFilter('這週末倫敦有什麼免費快閃活動或展覽？');
    expect(genuineFilter).toMatchObject({
      when: 'weekend',
      free: '1',
      isClearSearch: true,
    });

    const activeSessionDecision = {
      shouldReply: true,
      tier: 0 as const,
      reason: 'active_session',
      confidence: 0.95,
      detectedLang: 'zh-Hant' as const,
      shouldQuote: false,
    };

    const aiRunSpy = vi.spyOn(env.AI, 'run');

    const chatterReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: '今天天氣真不錯，晚上想早點休息' }),
      activeSessionDecision,
      emptyMem,
    );
    expect(chatterReply).toBe('[NO_REPLY]');

    const hackathonReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: '最近有哪些 AI 黑客松可以報名？' }),
      activeSessionDecision,
      emptyMem,
    );
    expect(hackathonReply).toBe('[NO_REPLY]');

    const greetingReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: '你好' }),
      activeSessionDecision,
      emptyMem,
    );
    expect(greetingReply).toBe('[NO_REPLY]');

    const fundraisingReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: 'Any updates on AI fundraising or marathon schedules?' }),
      { ...activeSessionDecision, detectedLang: 'en' },
      emptyMem,
    );
    expect(fundraisingReply).toBe('[NO_REPLY]');

    // Unmentioned chatter/off-topic must never invoke tryAiExtractFilter
    expect(aiRunSpy).not.toHaveBeenCalled();

    // tryAiExtractFilter rejects non-popup or bare-when outputs even when explicitly mentioned
    aiRunSpy.mockResolvedValueOnce({
      response: JSON.stringify({ isPopupQuery: false, when: 'today' }),
    } as never);
    const nonPopupMention = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: '@Spotted London 今天天氣真不錯' }),
      { ...activeSessionDecision, reason: 'explicit_mention' },
      emptyMem,
    );
    expect(nonPopupMention).toBeNull();

    aiRunSpy.mockResolvedValueOnce({
      response: JSON.stringify({ when: 'week' }),
    } as never);
    const bareWhenMention = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: '@Spotted London 最近好忙' }),
      { ...activeSessionDecision, reason: 'explicit_mention' },
      emptyMem,
    );
    expect(bareWhenMention).toBeNull();

    // Genuine popup query still matches and returns D1 results in active_session
    const genuineReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: '這週末倫敦有什麼免費快閃活動或展覽？' }),
      activeSessionDecision,
      emptyMem,
    );
    expect(genuineReply).toContain('Tate Pop-up Print Lab');
  });

  it('requires activity context for London neighborhoods, matches implicit outing queries, and guards unmentioned AI/empty results with [NO_REPLY]', async () => {
    await seedPopup('ng_soho_outing', {
      title: 'Berwick Street Vinyl Pop-up',
      category: 'market',
      borough: 'Soho',
      priceType: 'free',
      status: 'verified_admin',
      startAt: Date.now() - HOUR,
      endAt: Date.now() + 7 * DAY,
    });

    const grpContext = { roomId: '!grp:matrix.netmind.chat', chatType: 'group' as const, members: [], recentHistory: [] };

    // (a) Soho food/meeting mentions without event/pop-up words must stay below 0.55
    expect(heuristicDomainScore(makeEvent({ text: 'Let us grab dinner in Soho tonight' }), SPOTTED_AGENT_SPEC, grpContext)).toBeLessThan(0.55);
    expect(heuristicDomainScore(makeEvent({ text: '這週末去 Soho 吃拉麵吧' }), SPOTTED_AGENT_SPEC, grpContext)).toBeLessThan(0.55);
    expect(heuristicDomainScore(makeEvent({ text: 'I have a meeting in Shoreditch tomorrow' }), SPOTTED_AGENT_SPEC, grpContext)).toBeLessThan(0.55);

    const casualSohoRoute = await routeEvent(
      makeEvent({ text: 'Anyone want to grab dinner in Soho after work?' }),
      grpContext,
      SPOTTED_AGENT_SPEC,
      { nowMs: NOW },
    );
    expect(casualSohoRoute.shouldReply).toBe(false);

    // Activity-paired neighborhood queries still score >= 0.55
    expect(heuristicDomainScore(makeEvent({ text: "What's on in Soho this weekend?" }), SPOTTED_AGENT_SPEC, grpContext)).toBeGreaterThanOrEqual(0.55);
    expect(heuristicDomainScore(makeEvent({ text: 'Soho pop-up market this weekend' }), SPOTTED_AGENT_SPEC, grpContext)).toBeGreaterThanOrEqual(0.55);

    // (b) Implicit weekend London outing query matches extractPopupQueryFilter with isClearSearch: true
    const implicitFilter = extractPopupQueryFilter('這週末不知道帶朋友去倫敦哪裡逛逛比較特別');
    expect(implicitFilter).toMatchObject({
      when: 'weekend',
      isClearSearch: true,
    });

    // (c) Unmentioned group Tier 1 turn with !filter.isClearSearch falls through to tryAiExtractFilter
    // and returns [NO_REPLY] on null or empty items (when no A2A is configured)
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
    };
    const tier1Decision = {
      shouldReply: true,
      tier: 1 as const,
      reason: 'domain_match',
      confidence: 0.85,
      detectedLang: 'zh-Hant' as const,
      shouldQuote: false,
    };

    const aiRunSpy = vi.spyOn(env.AI, 'run');

    aiRunSpy.mockResolvedValueOnce({
      response: JSON.stringify({ isPopupQuery: true, when: 'week', category: 'market', q: 'Soho' }),
    } as never);
    const aiMatched = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: 'Somewhere fun around Berwick Street?' }),
      tier1Decision,
      emptyMem,
    );
    expect(aiRunSpy).toHaveBeenCalledTimes(1);
    expect(aiMatched).toContain('Berwick Street Vinyl Pop-up');

    aiRunSpy.mockResolvedValueOnce({
      response: JSON.stringify({ isPopupQuery: false }),
    } as never);
    const aiRejected = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: 'Somewhere fun around Berwick Street?' }),
      tier1Decision,
      emptyMem,
    );
    expect(aiRunSpy).toHaveBeenCalledTimes(2);
    expect(aiRejected).toBe('[NO_REPLY]');

    // Empty D1 items in an unmentioned group without A2A returns [NO_REPLY] instead of fallback URL
    const emptyItemsReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: '這週末 Notting Hill 有什麼快閃活動？' }),
      tier1Decision,
      emptyMem,
    );
    expect(emptyItemsReply).toBe('[NO_REPLY]');
  });
});
