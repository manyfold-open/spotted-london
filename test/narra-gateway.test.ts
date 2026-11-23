import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import {
  createWorkersAiTriageModel,
  heuristicDomainScore,
  isNarraGatewayEnabled,
  kickNarraGateway,
  routeEvent,
  staggerWindowMinute,
  type InboundEvent,
  type RoomContext,
} from '@manyfold/narra-agent-kit';
import { seal } from '../src/lib/seal';
import {
  SPOTTED_AGENT_ID,
  SPOTTED_AGENT_SPEC,
  SPOTTED_MATRIX_ID,
  buildSpottedExtraEnvelopeFields,
  createSpottedGatewayConfig,
  extractPopupQueryFilter,
  fastRespondSpotted,
  fetchSpottedUpdates,
  formatPopupsReply,
  parseRequestedLimit,
  resolveSpottedA2ACredential,
  spottedGatewayConfig,
  spottedOffTopicRedirect,
  spottedThanksReply,
  spottedThinkingMessage,
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
    slug?: string;
    title?: string;
    description?: string;
    address?: string;
    hoursText?: string;
    sourceUrl?: string | null;
    category?: string;
    borough?: string;
    priceType?: 'free' | 'paid' | 'unknown';
    priceText?: string;
    status?: string;
    startAt?: number;
    endAt?: number;
    isExample?: number;
    updatedAt?: number;
  } = {}) {
    await env.DB.prepare(
      `INSERT INTO popups
       (id, slug, title, host, description, category, price_type, price_text, address, borough, lat, lng, geohash, start_at, end_at, hours_text, source_url, status, created_by, created_at, updated_at, hot, is_example)
       VALUES (?, ?, ?, 'Host', ?, ?, ?, ?, ?, ?, 51.5135, -0.134, 'gcpvj', ?, ?, ?, ?, ?, 'ng_admin', ?, ?, 2.5, ?)`,
    )
      .bind(
        id,
        overrides.slug ?? id,
        overrides.title ?? `Popup ${id}`,
        overrides.description ?? 'Pop-up description',
        overrides.category ?? 'exhibition',
        overrides.priceType ?? 'free',
        overrides.priceText ?? (overrides.priceType === 'paid' ? '£15' : null),
        overrides.address ?? '10 Berwick St, W1F',
        overrides.borough ?? 'Soho',
        overrides.startAt ?? NOW - HOUR,
        overrides.endAt ?? NOW + 5 * DAY,
        overrides.hoursText ?? '10:00-18:00',
        overrides.sourceUrl === undefined ? 'https://example.com' : overrides.sourceUrl,
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

    const shelvedEventReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: '活動先放著，最近有什麼 AI 模型發布的新聞？有的話挑一則。' }),
      activeSessionDecision,
      emptyMem,
    );
    expect(shelvedEventReply).toBe('[NO_REPLY]');

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

  it('disambiguates general Soho hunger from implicit London weekend outing queries', async () => {
    await seedPopup('ng_weekend_outing', {
      title: 'Berwick Street Vinyl Pop-up',
      category: 'market',
      borough: 'Soho',
      priceType: 'free',
      status: 'verified_admin',
      startAt: Date.now() - HOUR,
      endAt: Date.now() + 7 * DAY,
    });

    const grpContext = { roomId: '!grp:matrix.netmind.chat', chatType: 'group' as const, members: [], recentHistory: [] };
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
    };
    const aiRunSpy = vi.spyOn(env.AI, 'run');
    const triageModel = createWorkersAiTriageModel(env.AI);

    // 1. General Soho hunger query must score < 0.55 and return [NO_REPLY] in unmentioned group fastRespondSpotted
    const hungerText = '好餓喔，等下在 Soho 附近有沒有推薦吃的？';
    expect(heuristicDomainScore(makeEvent({ text: hungerText }), SPOTTED_AGENT_SPEC, grpContext)).toBeLessThan(0.55);

    const hungerTriage = await triageModel.score({
      event: makeEvent({ text: hungerText }),
      context: grpContext,
      spec: SPOTTED_AGENT_SPEC,
      detectedLang: 'zh-Hant',
    });
    expect(hungerTriage.score).toBeLessThan(0.55);

    const hungerRoute = await routeEvent(
      makeEvent({ text: hungerText }),
      grpContext,
      SPOTTED_AGENT_SPEC,
      { nowMs: NOW, triageModel },
    );
    expect(hungerRoute.shouldReply).toBe(false);

    const hungerReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: hungerText }),
      {
        shouldReply: true,
        tier: 1,
        reason: 'domain_match',
        confidence: 0.6,
        detectedLang: 'zh-Hant',
        shouldQuote: false,
      },
      emptyMem,
    );
    expect(hungerReply).toBe('[NO_REPLY]');
    expect(aiRunSpy).not.toHaveBeenCalled();

    // 2. Unmentioned bare-area mention without antiKeywords falls through to tryAiExtractFilter and returns [NO_REPLY] on null
    const bareAreaFilter = extractPopupQueryFilter('等下在 Soho 附近走走');
    expect(bareAreaFilter).toMatchObject({ q: 'Soho', isClearSearch: true });

    aiRunSpy.mockResolvedValueOnce({ response: JSON.stringify({ isPopupQuery: false }) } as never);
    const bareAreaReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: '等下在 Soho 附近走走' }),
      {
        shouldReply: true,
        tier: 1,
        reason: 'domain_match',
        confidence: 0.6,
        detectedLang: 'zh-Hant',
        shouldQuote: false,
      },
      emptyMem,
    );
    expect(aiRunSpy).toHaveBeenCalledTimes(1);
    expect(bareAreaReply).toBe('[NO_REPLY]');

    // Explicit mention with bare area still queries Soho pop-ups
    const mentionedAreaReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: '@Spotted London Soho' }),
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
    expect(mentionedAreaReply).toContain('Berwick Street Vinyl Pop-up');

    // 3. Implicit London weekend outing query scores >= 0.55 (and >= 0.85 on triageModel) and matches pop-ups
    const outingText = '這週末不知道帶朋友去倫敦哪裡逛逛比較特別';
    expect(heuristicDomainScore(makeEvent({ text: outingText }), SPOTTED_AGENT_SPEC, grpContext)).toBeGreaterThanOrEqual(0.55);

    const outingTriage = await triageModel.score({
      event: makeEvent({ text: outingText }),
      context: grpContext,
      spec: SPOTTED_AGENT_SPEC,
      detectedLang: 'zh-Hant',
    });
    expect(outingTriage.score).toBeGreaterThanOrEqual(0.85);

    const outingRoute = await routeEvent(
      makeEvent({ text: outingText }),
      grpContext,
      SPOTTED_AGENT_SPEC,
      { nowMs: NOW, triageModel },
    );
    expect(outingRoute.shouldReply).toBe(true);
    expect(outingRoute.confidence).toBeGreaterThanOrEqual(0.85);

    const outingReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: outingText }),
      outingRoute,
      emptyMem,
    );
    expect(outingReply).toContain('Berwick Street Vinyl Pop-up');
    expect(outingReply).toContain('https://app.manyfold.ai/spotted-london/p/ng_weekend_outing');
    // Outing triage + outing fastRespondSpotted both resolved deterministically without needing AI fallback
    expect(aiRunSpy).toHaveBeenCalledTimes(1);
  });

  it('formats multi-popup lists with bullet points and suppresses past-tense Camden backdrop when peer AI model question is asked', async () => {
    const formatted = formatPopupsReply(
      [
        {
          id: 'p1',
          slug: 'first-pop',
          title: 'First Pop-up',
          category: 'exhibition',
          tags: [],
          description: '',
          start_at: NOW,
          end_at: NOW + DAY,
          date_kind: 'fixed',
          ranges: null,
          hours_text: null,
          timezone: 'Europe/London',
          location: { borough: 'Shoreditch', address: null, lat: null, lng: null, postcode: null },
          price: { type: 'free', text: 'Free' },
          images: [],
          source: null,
          source_url: 'https://example.com/1',
          source_checked: 1,
          status: 'verified_admin',
          example: false,
          votes: 0,
          created_at: NOW,
          updated_at: NOW,
        } as unknown as Parameters<typeof formatPopupsReply>[0][number],
        {
          id: 'p2',
          slug: 'second-pop',
          title: 'Second Pop-up',
          category: 'market',
          tags: [],
          description: '',
          start_at: NOW,
          end_at: NOW + DAY,
          date_kind: 'fixed',
          ranges: null,
          hours_text: null,
          timezone: 'Europe/London',
          location: { borough: 'Soho', address: null, lat: null, lng: null, postcode: null },
          price: { type: 'free', text: 'Free' },
          images: [],
          source: null,
          source_url: 'https://example.com/2',
          source_checked: 1,
          status: 'verified_admin',
          example: false,
          votes: 0,
          created_at: NOW,
          updated_at: NOW,
        } as unknown as Parameters<typeof formatPopupsReply>[0][number],
      ],
      'zh-Hant',
      'https://app.manyfold.ai/spotted-london',
    );
    expect(formatted).toContain('• First Pop-up');
    expect(formatted).toContain('• Second Pop-up');
    expect(formatted).not.toMatch(/^1\.\s/m);

    const camdenAiText = '剛跟朋友逛完 Camden 市集超累，順便問一下大家今天 Anthropic 或 OpenAI 有發新模型嗎？';
    const grpContext = { roomId: '!grp:matrix.netmind.chat', chatType: 'group' as const, members: [], recentHistory: [] };
    expect(heuristicDomainScore(makeEvent({ text: camdenAiText }), SPOTTED_AGENT_SPEC, grpContext)).toBeLessThan(0.55);

    const triageModel = createWorkersAiTriageModel(env.AI);
    const decision = await routeEvent(
      makeEvent({ text: camdenAiText }),
      grpContext,
      SPOTTED_AGENT_SPEC,
      { nowMs: NOW, triageModel },
    );
    expect(decision.shouldReply).toBe(false);
  });

  it('I3: answers detail follow-ups locally via replyToTarget or recentHistory /p/<slug> without hitting A2A', async () => {
    const liveEnd = Date.now() + 7 * DAY;
    await seedPopup('ng_detail_1', {
      slug: 'berwick-vinyl-residency',
      title: 'Berwick Vinyl Residency',
      borough: 'Soho',
      address: '10 Berwick St, W1F 0PP',
      hoursText: '11:00-19:00',
      priceType: 'free',
      description:
        'Limited-run Japanese pressing listening room and weekend market. First 50 visitors receive a canvas tote bag. Third extra sentence should stay trimmed.',
      sourceUrl: 'https://berwickvinyl.example/event',
      status: 'verified_admin',
      startAt: Date.now() - HOUR,
      endAt: liveEnd,
    });
    await seedPopup('ng_detail_ex', {
      slug: 'example-hidden-popup',
      title: 'Hidden Example Popup',
      isExample: 1,
      startAt: Date.now() - HOUR,
      endAt: liveEnd,
    });

    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
      MANYFOLD_A2A_URL: 'https://a2a.spotted.test/rpc',
      MANYFOLD_A2A_TOKEN: 'a2a_spotted_test_tok',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    // 1. UI Reply to Spotted London's /p/<slug> message with @Spotted London 有更多細節嗎？
    const replyContext: RoomContext = {
      roomId: '!spotted_grp:matrix.netmind.chat',
      chatType: 'group',
      members: [
        { matrixId: '@alice:matrix.netmind.chat', displayName: 'Alice', isAgent: false },
        { matrixId: SPOTTED_MATRIX_ID, displayName: 'Spotted London', isAgent: true },
      ],
      recentHistory: [],
      replyToTarget: {
        eventId: '$spotted_list_1',
        senderId: SPOTTED_MATRIX_ID,
        senderName: 'Spotted London',
        isSelf: true,
        isAgent: true,
        text: '• Berwick Vinyl Residency (Soho | Fri 9 Oct to Fri 16 Oct | 11:00-19:00 | free | verified)\nhttps://app.manyfold.ai/spotted-london/p/berwick-vinyl-residency',
      },
    };
    const replyEvent = makeEvent({
      chatType: 'group',
      text: '@Spotted London 有更多細節嗎？',
      mentions: [SPOTTED_MATRIX_ID],
      replyToEventId: '$spotted_list_1',
    });
    const replyDecision = await routeEvent(replyEvent, replyContext, SPOTTED_AGENT_SPEC, { nowMs: NOW });
    expect(replyDecision.shouldReply).toBe(true);
    expect(replyDecision.reason).toBe('reply_to_self');
    expect(replyDecision.detectedLang).toBe('zh-Hant');

    const detailReply = await fastRespondSpotted(typedEnv, replyEvent, replyDecision, emptyMem, replyContext);
    expect(detailReply).not.toBeNull();
    expect(detailReply).toContain('• Berwick Vinyl Residency');
    expect(detailReply).toContain('Soho · 10 Berwick St, W1F 0PP');
    expect(detailReply).toContain('11:00-19:00');
    expect(detailReply).toContain('免費');
    expect(detailReply).toContain('Limited-run Japanese pressing listening room and weekend market.');
    expect(detailReply).toContain('First 50 visitors receive a canvas tote bag.');
    expect(detailReply).not.toContain('Third extra sentence');
    expect(detailReply).toContain('https://app.manyfold.ai/spotted-london/p/berwick-vinyl-residency');
    expect(detailReply).toContain('https://berwickvinyl.example/event');
    expect(detailReply).not.toMatch(/\]\(https?:\/\//);
    expect(fetchSpy).not.toHaveBeenCalled();

    // 2. Fallback to most recent h.isSelf turn in recentHistory (explicit_mention & active_session)
    const historyContext: RoomContext = {
      ...replyContext,
      replyToTarget: undefined,
      recentHistory: [
        {
          eventId: '$spotted_hist_1',
          senderId: SPOTTED_MATRIX_ID,
          senderName: 'Spotted London',
          isAgent: true,
          isSelf: true,
          text: 'Here is what is on in London:\n• Berwick Vinyl Residency\nhttps://app.manyfold.ai/spotted-london/p/berwick-vinyl-residency',
          timestampMs: NOW - 10_000,
        },
      ],
    };

    const enActive = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: 'Where is it? Tell me more about hours and tickets' }),
      {
        shouldReply: true,
        tier: 0,
        reason: 'active_session',
        confidence: 0.95,
        detectedLang: 'en',
        shouldQuote: false,
      },
      emptyMem,
      historyContext,
    );
    expect(enActive).toContain('• Berwick Vinyl Residency');
    expect(enActive).toContain('Where: Soho · 10 Berwick St, W1F 0PP');
    expect(enActive).toContain('11:00-19:00');
    expect(enActive).toContain('https://app.manyfold.ai/spotted-london/p/berwick-vinyl-residency');
    expect(enActive).toContain('https://berwickvinyl.example/event');

    const hansMention = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: '@Spotted London 地址和营业时间是什么？' }),
      {
        shouldReply: true,
        tier: 0,
        reason: 'explicit_mention',
        confidence: 1,
        detectedLang: 'zh-Hans',
        shouldQuote: false,
      },
      emptyMem,
      historyContext,
    );
    expect(hansMention).toContain('地点：Soho · 10 Berwick St, W1F 0PP');
    expect(hansMention).toContain('11:00-19:00');
    expect(hansMention).toContain('免费');

    // Example pop-ups remain excluded
    const exampleReply = await fastRespondSpotted(
      typedEnv,
      replyEvent,
      replyDecision,
      emptyMem,
      {
        ...replyContext,
        replyToTarget: {
          ...replyContext.replyToTarget!,
          text: 'https://app.manyfold.ai/spotted-london/p/example-hidden-popup',
        },
      },
    );
    expect(exampleReply).toBeNull();

    // Complex follow-ups still fall back to A2A even when replying to /p/<slug>
    const complexReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: '@Spotted London How do I get there by tube from Euston?' }),
      replyDecision,
      emptyMem,
      replyContext,
    );
    expect(complexReply).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('responds locally to bare @Spotted London in groups both when popups exist and when none are listed', async () => {
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
    };
    const grpContext: RoomContext = {
      roomId: '!spotted_bare:matrix.netmind.chat',
      chatType: 'group',
      userLanguageHint: 'zh-Hant',
      members: [
        { matrixId: '@alice:matrix.netmind.chat', displayName: 'Alice', isAgent: false },
        { matrixId: SPOTTED_MATRIX_ID, displayName: 'Spotted London', isAgent: true },
      ],
      recentHistory: [],
    };

    const bareEv = makeEvent({
      chatType: 'group',
      text: '@Spotted London',
      mentions: [SPOTTED_MATRIX_ID],
    });
    const bareDec = await routeEvent(bareEv, grpContext, SPOTTED_AGENT_SPEC, { nowMs: NOW });
    expect(bareDec.shouldReply).toBe(true);
    expect(bareDec.reason).toBe('explicit_mention');

    // 1. When no non-example popups exist -> brief localized greeting (never null)
    const emptyDbReplyHant = await fastRespondSpotted(typedEnv, bareEv, bareDec, emptyMem, grpContext);
    expect(emptyDbReplyHant).not.toBeNull();
    expect(emptyDbReplyHant).not.toBe('[NO_REPLY]');
    expect(emptyDbReplyHant).toContain('Spotted London');
    expect(emptyDbReplyHant).toContain('https://app.manyfold.ai/spotted-london');

    const emptyDbReplyHans = await fastRespondSpotted(
      typedEnv,
      bareEv,
      { ...bareDec, detectedLang: 'zh-Hans' },
      emptyMem,
      grpContext,
    );
    expect(emptyDbReplyHans).toContain('伦敦');
    expect(emptyDbReplyHans).toContain('https://app.manyfold.ai/spotted-london');

    const emptyDbReplyEn = await fastRespondSpotted(
      typedEnv,
      bareEv,
      { ...bareDec, detectedLang: 'en' },
      emptyMem,
      grpContext,
    );
    expect(emptyDbReplyEn).toContain('Hi! I am Spotted London.');
    expect(emptyDbReplyEn).toContain('https://app.manyfold.ai/spotted-london');

    // 2. When upcoming popups exist -> responds locally with greeting + upcoming pop-ups
    await seedPopup('ng_bare_1', {
      slug: 'shoreditch-print-fair',
      title: 'Shoreditch Print Fair',
      borough: 'Shoreditch',
      startAt: Date.now() - HOUR,
      endAt: Date.now() + 7 * DAY,
    });
    const withPopupsReply = await fastRespondSpotted(
      typedEnv,
      bareEv,
      { ...bareDec, detectedLang: 'en' },
      emptyMem,
      grpContext,
    );
    expect(withPopupsReply).toContain('Hi! Here are a few London pop-ups worth checking out right now:');
    expect(withPopupsReply).toContain('Shoreditch Print Fair');
    expect(withPopupsReply).toContain('https://app.manyfold.ai/spotted-london/p/shoreditch-print-fair');
  });

  it('relaxes neighborhood filter (Relaxation A) when area + category/free has no exact D1 match', async () => {
    const liveEnd = Date.now() + 7 * DAY;
    await seedPopup('ng_relax_a_soho', {
      slug: 'soho-free-weekend-market',
      title: 'Soho Free Weekend Market',
      category: 'market',
      borough: 'Soho',
      priceType: 'free',
      status: 'verified_admin',
      startAt: Date.now() - HOUR,
      endAt: liveEnd,
    });
    // Example pop-ups in the target area remain excluded and must not block relaxation
    await seedPopup('ng_relax_a_ex', {
      slug: 'shoreditch-example-market',
      title: 'Shoreditch Example Market',
      category: 'market',
      borough: 'Shoreditch',
      priceType: 'free',
      isExample: 1,
      startAt: Date.now() - HOUR,
      endAt: liveEnd,
    });

    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
      MANYFOLD_A2A_URL: 'https://a2a.spotted.test/rpc',
      MANYFOLD_A2A_TOKEN: 'a2a_spotted_test_tok',
    };
    const grpContext: RoomContext = {
      roomId: '!spotted_relax_a:matrix.netmind.chat',
      chatType: 'group',
      members: [
        { matrixId: '@alice:matrix.netmind.chat', displayName: 'Alice', isAgent: false },
        { matrixId: SPOTTED_MATRIX_ID, displayName: 'Spotted London', isAgent: true },
      ],
      recentHistory: [],
    };

    const hantText = '這週末倫敦 Shoreditch 有什麼免費快閃市集？';
    const hantDecision = await routeEvent(makeEvent({ text: hantText }), grpContext, SPOTTED_AGENT_SPEC, { nowMs: NOW });
    expect(hantDecision.shouldReply).toBe(true);
    expect(hantDecision.detectedLang).toBe('zh-Hant');

    const hantReply = await fastRespondSpotted(typedEnv, makeEvent({ text: hantText }), hantDecision, emptyMem, grpContext);
    expect(hantReply).not.toBeNull();
    expect(hantReply).not.toBe('[NO_REPLY]');
    expect(hantReply).toContain('Shoreditch 暫時沒有完全符合條件的活動，以下是倫敦其他區域符合條件的快閃精選：');
    expect(hantReply).toContain('Soho Free Weekend Market');
    expect(hantReply).toContain('https://app.manyfold.ai/spotted-london/p/soho-free-weekend-market');
    expect(hantReply).not.toMatch(/\]\(https?:\/\//);

    const hansReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ text: '这周末伦敦 Shoreditch 有什么免费快闪市集？' }),
      { ...hantDecision, detectedLang: 'zh-Hans' },
      emptyMem,
      grpContext,
    );
    expect(hansReply).toContain('Shoreditch 暂时没有完全符合条件的活动，以下是伦敦其他区域符合条件的快闪精选：');
    expect(hansReply).toContain('https://app.manyfold.ai/spotted-london/p/soho-free-weekend-market');

    const enReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ text: 'Any free markets in Shoreditch this weekend?' }),
      { ...hantDecision, detectedLang: 'en' },
      emptyMem,
      grpContext,
    );
    expect(enReply).toContain('No exact match in Shoreditch right now — here are matching London pop-ups nearby:');
    expect(enReply).toContain('https://app.manyfold.ai/spotted-london/p/soho-free-weekend-market');
  });

  it('relaxes category/free/time filters while keeping neighborhood (Relaxation B) and falls back to A2A only when all relaxations miss', async () => {
    const liveEnd = Date.now() + 7 * DAY;
    await seedPopup('ng_relax_b_shoreditch', {
      slug: 'shoreditch-paid-gallery',
      title: 'Shoreditch Paid Gallery',
      category: 'exhibition',
      borough: 'Shoreditch',
      priceType: 'paid',
      status: 'verified_admin',
      startAt: Date.now() - HOUR,
      endAt: liveEnd,
    });
    await seedPopup('ng_relax_b_hackney_week', {
      slug: 'hackney-upcoming-print-show',
      title: 'Hackney Upcoming Print Show',
      category: 'exhibition',
      borough: 'Hackney',
      priceType: 'paid',
      status: 'verified_admin',
      startAt: Date.now() + 2 * DAY,
      endAt: Date.now() + 5 * DAY,
    });

    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
      MANYFOLD_A2A_URL: 'https://a2a.spotted.test/rpc',
      MANYFOLD_A2A_TOKEN: 'a2a_spotted_test_tok',
    };
    const grpContext: RoomContext = {
      roomId: '!spotted_relax_b:matrix.netmind.chat',
      chatType: 'group',
      members: [
        { matrixId: '@alice:matrix.netmind.chat', displayName: 'Alice', isAgent: false },
        { matrixId: SPOTTED_MATRIX_ID, displayName: 'Spotted London', isAgent: true },
      ],
      recentHistory: [],
    };

    const hantText = '這週末倫敦 Shoreditch 有什麼免費快閃市集？';
    const hantDecision = await routeEvent(makeEvent({ text: hantText }), grpContext, SPOTTED_AGENT_SPEC, { nowMs: NOW });
    expect(hantDecision.shouldReply).toBe(true);

    const hantReply = await fastRespondSpotted(typedEnv, makeEvent({ text: hantText }), hantDecision, emptyMem, grpContext);
    expect(hantReply).not.toBeNull();
    expect(hantReply).not.toBe('[NO_REPLY]');
    expect(hantReply).toContain('Shoreditch 暫時沒有完全符合全部篩選條件的活動，但 Shoreditch 附近還有這些快閃可以逛：');
    expect(hantReply).toContain('Shoreditch Paid Gallery');
    expect(hantReply).toContain('https://app.manyfold.ai/spotted-london/p/shoreditch-paid-gallery');
    expect(hantReply).not.toMatch(/\]\(https?:\/\//);

    const hansReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ text: '这周末伦敦 Shoreditch 有什么免费快闪市集？' }),
      { ...hantDecision, detectedLang: 'zh-Hans' },
      emptyMem,
      grpContext,
    );
    expect(hansReply).toContain('Shoreditch 暂时没有完全符合全部筛选条件的活动，但 Shoreditch 附近还有这些快闪可以逛：');
    expect(hansReply).toContain('https://app.manyfold.ai/spotted-london/p/shoreditch-paid-gallery');

    const enReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ text: 'Any free markets in Shoreditch this weekend?' }),
      { ...hantDecision, detectedLang: 'en' },
      emptyMem,
      grpContext,
    );
    expect(enReply).toContain('No exact match for every filter in Shoreditch, but here is what else is on around Shoreditch:');
    expect(enReply).toContain('https://app.manyfold.ai/spotted-london/p/shoreditch-paid-gallery');

    // Also widens today -> week in Relaxation B when matching borough only has upcoming events later this week
    const todayHackneyReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ text: 'Any free markets in Hackney today?' }),
      { ...hantDecision, detectedLang: 'en' },
      emptyMem,
      grpContext,
    );
    expect(todayHackneyReply).toContain('No exact match for every filter in Hackney, but here is what else is on around Hackney:');
    expect(todayHackneyReply).toContain('Hackney Upcoming Print Show');
    expect(todayHackneyReply).toContain('https://app.manyfold.ai/spotted-london/p/hackney-upcoming-print-show');

    // When all relaxations still return 0 results and A2A is configured, falls back to null
    const missAllReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ text: 'Any free markets in Camden this weekend?' }),
      { ...hantDecision, detectedLang: 'en' },
      emptyMem,
      grpContext,
    );
    expect(missAllReply).toBeNull();
  });

  it('leaves a time-only refinement with the agent that just answered', async () => {
    const event = makeEvent({ text: '只要週末的呢？' });
    const decision = { shouldReply: true, tier: 1 as const, reason: 'active_session' as const, confidence: 1, detectedLang: 'zh-Hant' as const, shouldQuote: false };
    const context: RoomContext = {
      roomId: event.roomId,
      chatType: 'group',
      members: [],
      recentHistory: [{
        eventId: '$hackathon-results',
        senderId: '@agent-data:matrix.netmind.chat',
        isAgent: true,
        text: 'Manyfold Data found verified AI hackathons in London.',
        timestampMs: event.timestampMs - 1000,
      }],
    };
    const memories = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    expect(await fastRespondSpotted(env as unknown as Bindings, event, decision, memories, context))
      .toBe('[NO_REPLY]');
    await seedPopup('weekend-control', {
      title: 'Weekend Exhibition',
      startAt: Date.now() - DAY,
      endAt: Date.now() + 10 * DAY,
    });
    const topicSwitch = { ...event, text: '這週末 Soho 有什麼展覽？' };
    expect(await fastRespondSpotted(env as unknown as Bindings, topicSwitch, decision, memories, context))
      .toContain('Weekend Exhibition');
  });

  it('answers a booking follow-up for only the requested item in the previous list', async () => {
    await seedPopup('booking-first', { title: 'First Soho exhibition' });
    await seedPopup('booking-second', {
      title: 'Second Soho exhibition',
      hoursText: '11am-6pm',
      priceText: 'Free ticketed entry',
      sourceUrl: 'https://exhibitions.example/second',
    });
    const event = makeEvent({ text: '第二個要預約嗎？' });
    const context: RoomContext = {
      roomId: event.roomId,
      chatType: 'group',
      members: [],
      recentHistory: [{
        eventId: '$exhibition-list',
        senderId: SPOTTED_MATRIX_ID,
        isSelf: true,
        isAgent: true,
        text: 'https://app.manyfold.ai/spotted-london/p/booking-first\nhttps://app.manyfold.ai/spotted-london/p/booking-second',
        timestampMs: NOW - 1000,
      }],
    };
    const reply = await fastRespondSpotted(
      env as unknown as Bindings,
      event,
      { shouldReply: true, tier: 1, reason: 'active_session', confidence: 1, detectedLang: 'zh-Hant', shouldQuote: false },
      { userMemories: [], roomMemories: [], promptSafeLines: [] },
      context,
    );
    expect(reply).toContain('Second Soho exhibition');
    expect(reply).toContain('活動標示為憑票入場');
    expect(reply).toContain('https://exhibitions.example/second');
    expect(reply).not.toContain('First Soho exhibition');

    const hoursReply = await fastRespondSpotted(
      env as unknown as Bindings,
      { ...event, text: '第二個星期日幾點關門？' },
      { shouldReply: true, tier: 1, reason: 'active_session', confidence: 1, detectedLang: 'zh-Hant', shouldQuote: false },
      { userMemories: [], roomMemories: [], promptSafeLines: [] },
      context,
    );
    expect(hoursReply).toContain('Second Soho exhibition');
    expect(hoursReply).toContain('11am-6pm');
    expect(hoursReply).toContain('https://exhibitions.example/second');
    expect(hoursReply).not.toContain('First Soho exhibition');
  });

  it('handles 1v1 DM detail follow-up, off-topic redirect, polite thanks, capability queries, and preserves A2A follow-ups', async () => {
    const liveEnd = Date.now() + 7 * DAY;
    await seedPopup('ng_dm_detail_1', {
      slug: 'shoreditch-matcha-popup',
      title: 'Shoreditch Matcha Pop-up',
      borough: 'Shoreditch',
      address: '24 Redchurch St, E2 7DP',
      hoursText: '10:00-17:00',
      priceType: 'free',
      description: 'Ceremonial matcha tastings and limited-run ceramic cups all weekend.',
      sourceUrl: 'https://matcha.example/shoreditch',
      status: 'verified_admin',
      startAt: Date.now() - HOUR,
      endAt: liveEnd,
    });

    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
      MANYFOLD_A2A_URL: 'https://a2a.spotted.test/rpc',
      MANYFOLD_A2A_TOKEN: 'a2a_spotted_test_tok',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const dmRoomId = '!spotted_dm_1v1:matrix.netmind.chat';
    const dmContext: RoomContext = {
      roomId: dmRoomId,
      chatType: 'dm',
      members: [
        { matrixId: '@alice:matrix.netmind.chat', displayName: 'Alice', isAgent: false },
        { matrixId: SPOTTED_MATRIX_ID, displayName: 'Spotted London', isAgent: true },
      ],
      recentHistory: [
        {
          eventId: '$dm_list_1',
          senderId: SPOTTED_MATRIX_ID,
          senderName: 'Spotted London',
          isAgent: true,
          isSelf: true,
          text: '以下是符合條件的倫敦快閃活動：\n• Shoreditch Matcha Pop-up (Shoreditch | free | verified)\nhttps://app.manyfold.ai/spotted-london/p/shoreditch-matcha-popup',
          timestampMs: NOW - 10_000,
        },
      ],
    };

    // 1. DM "有更多細節嗎？" right after a Spotted list reply returns D1 details locally
    const detailEv = makeEvent({
      roomId: dmRoomId,
      chatType: 'dm',
      eventId: '$dm_detail_q',
      text: '有更多細節嗎？',
    });
    const detailDec = await routeEvent(detailEv, dmContext, SPOTTED_AGENT_SPEC, { nowMs: NOW });
    expect(detailDec.shouldReply).toBe(true);
    expect(detailDec.reason).toBe('dm');
    expect(detailDec.detectedLang).toBe('zh-Hant');

    const detailReply = await fastRespondSpotted(typedEnv, detailEv, detailDec, emptyMem, dmContext);
    expect(detailReply).not.toBeNull();
    expect(detailReply).toContain('Shoreditch Matcha Pop-up');
    expect(detailReply).toContain('Shoreditch · 24 Redchurch St, E2 7DP');
    expect(detailReply).toContain('10:00-17:00');
    expect(detailReply).toContain('Ceremonial matcha tastings and limited-run ceramic cups all weekend.');
    expect(detailReply).toContain('https://app.manyfold.ai/spotted-london/p/shoreditch-matcha-popup');
    expect(detailReply).toContain('https://matcha.example/shoreditch');
    expect(fetchSpy).not.toHaveBeenCalled();

    // 2. DM "幫我查一下今天的比特幣價格" returns warm zh-Hant off-topic redirect locally (NOT null)
    const btcEv = makeEvent({
      roomId: dmRoomId,
      chatType: 'dm',
      eventId: '$dm_btc',
      text: '幫我查一下今天的比特幣價格',
    });
    const btcDec = await routeEvent(btcEv, dmContext, SPOTTED_AGENT_SPEC, { nowMs: NOW });
    expect(btcDec.shouldReply).toBe(true);
    expect(btcDec.reason).toBe('dm');
    const btcReply = await fastRespondSpotted(typedEnv, btcEv, btcDec, emptyMem, dmContext);
    expect(btcReply).toBe(spottedOffTopicRedirect('zh-Hant'));
    expect(btcReply).not.toBeNull();

    const weatherEnReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({ roomId: dmRoomId, chatType: 'dm', text: 'What is the weather forecast in London?' }),
      { ...btcDec, detectedLang: 'en' },
      emptyMem,
      dmContext,
    );
    expect(weatherEnReply).toBe(spottedOffTopicRedirect('en'));

    // 3. DM "謝謝！" returns warm thanks reply locally, whereas unmentioned group active_session returns [NO_REPLY]
    const thanksEv = makeEvent({
      roomId: dmRoomId,
      chatType: 'dm',
      eventId: '$dm_thanks',
      text: '謝謝！',
    });
    const thanksDec = await routeEvent(thanksEv, dmContext, SPOTTED_AGENT_SPEC, { nowMs: NOW });
    const thanksReply = await fastRespondSpotted(typedEnv, thanksEv, thanksDec, emptyMem, dmContext);
    expect(thanksReply).toBe(spottedThanksReply('zh-Hant'));

    const activeThanks = await fastRespondSpotted(
      typedEnv,
      makeEvent({ chatType: 'group', text: '謝謝！' }),
      {
        shouldReply: true,
        tier: 0,
        reason: 'active_session',
        confidence: 0.95,
        detectedLang: 'zh-Hant',
        shouldQuote: false,
      },
      emptyMem,
    );
    expect(activeThanks).toBe('[NO_REPLY]');

    // 4. DM capability query triggers greeting + weekend highlights locally
    const capEv = makeEvent({
      roomId: dmRoomId,
      chatType: 'dm',
      eventId: '$dm_cap',
      text: '你能幫我查什麼？',
    });
    const capDec = await routeEvent(capEv, dmContext, SPOTTED_AGENT_SPEC, { nowMs: NOW });
    const capReply = await fastRespondSpotted(typedEnv, capEv, capDec, emptyMem, dmContext);
    expect(capReply).toContain('Shoreditch Matcha Pop-up');
    expect(capReply).toContain('https://app.manyfold.ai/spotted-london/p/shoreditch-matcha-popup');

    // 5. Complex/popup follow-ups ("how do I get there by tube?", "is it kid-friendly?") still return null for A2A
    const tubeDm = await fastRespondSpotted(
      typedEnv,
      makeEvent({ roomId: dmRoomId, chatType: 'dm', text: 'how do I get there by tube?' }),
      { ...btcDec, detectedLang: 'en' },
      emptyMem,
      dmContext,
    );
    expect(tubeDm).toBeNull();

    const kidFriendlyDm = await fastRespondSpotted(
      typedEnv,
      makeEvent({ roomId: dmRoomId, chatType: 'dm', text: 'is it kid-friendly?' }),
      { ...btcDec, detectedLang: 'en' },
      emptyMem,
      dmContext,
    );
    expect(kidFriendlyDm).toBeNull();
  });

  it('wires Phase 1-4 gateway config (thinkingMessage, enableA2AFailureReply, buildExtraEnvelopeFields) with slug & weekend D1 prefetch', async () => {
    const liveStart = Date.now() - HOUR;
    const liveEnd = Date.now() + 7 * DAY;
    await seedPopup('ng_pref_1', {
      slug: 'soho-ceramics-popup',
      title: 'Soho Ceramics Studio Pop-up',
      borough: 'Soho',
      address: '14 Marshall St, W1F 7EN',
      hoursText: '10:30-18:30',
      priceType: 'free',
      description: 'Handmade London ceramics workshop and weekend showcase. Family and kid-friendly ground floor space.',
      sourceUrl: 'https://sohoceramics.example/popup',
      status: 'verified_admin',
      startAt: liveStart,
      endAt: liveEnd,
    });
    await seedPopup('ng_pref_2', {
      slug: 'hackney-print-market',
      title: 'Hackney Print Market',
      borough: 'Hackney',
      address: '55 Mare St, E8 4RG',
      hoursText: '11:00-17:00',
      priceType: 'paid',
      description: 'Independent printmakers and zine stalls all weekend.',
      sourceUrl: 'https://hackneyprint.example/weekend',
      status: 'verified_admin',
      startAt: liveStart,
      endAt: liveEnd,
    });
    await seedPopup('ng_pref_ex', {
      slug: 'example-ignored-popup',
      title: 'Example Ignored Popup',
      isExample: 1,
      startAt: liveStart,
      endAt: liveEnd,
    });

    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
    };
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const dummyEvent = makeEvent({ text: 'how do I get there by tube?' });
    const dummyDecision = {
      shouldReply: true,
      tier: 0 as const,
      reason: 'dm',
      confidence: 1,
      detectedLang: 'en' as const,
      shouldQuote: false,
    };

    // 1. Config & thinkingMessage checks
    const cfg = createSpottedGatewayConfig();
    expect(cfg.enableA2AFailureReply).toBe(true);
    expect(spottedGatewayConfig.enableA2AFailureReply).toBe(true);
    expect(cfg.thinkingMessage).toBe(spottedThinkingMessage);
    expect(cfg.buildExtraEnvelopeFields).toBe(buildSpottedExtraEnvelopeFields);

    expect(cfg.thinkingMessage!('zh-Hant', dummyEvent, dummyDecision)).toBe(
      '📍 正在幫你查詢倫敦最新快閃活動與細節，稍等一下…',
    );
    expect(cfg.thinkingMessage!('zh-Hans', dummyEvent, dummyDecision)).toBe(
      '📍 正在帮你查询伦敦最新快闪活动与细节，稍等一下…',
    );
    expect(cfg.thinkingMessage!('en', dummyEvent, dummyDecision)).toBe(
      '📍 Looking up London pop-up details for you, one moment…',
    );

    // 2. Extracts slug from replyToTarget and returns rich concise D1 facts (<= 1400 chars)
    const replyCtx: RoomContext = {
      roomId: '!spotted_pref:matrix.netmind.chat',
      chatType: 'dm',
      members: [],
      recentHistory: [],
      replyToTarget: {
        eventId: '$sp_reply_1',
        senderId: SPOTTED_MATRIX_ID,
        senderName: 'Spotted London',
        isSelf: true,
        isAgent: true,
        text: '• Soho Ceramics Studio Pop-up\nhttps://app.manyfold.ai/spotted-london/p/soho-ceramics-popup',
      },
    };
    const replyFields = await buildSpottedExtraEnvelopeFields(
      typedEnv,
      dummyEvent,
      dummyDecision,
      emptyMem,
      replyCtx,
    );
    expect(replyFields).not.toBeNull();
    expect(replyFields!.d1_prefetched_records.length).toBeLessThanOrEqual(1_400);
    expect(replyFields!.d1_prefetched_records).toContain('Soho Ceramics Studio Pop-up');
    expect(replyFields!.d1_prefetched_records).toContain('14 Marshall St, W1F 7EN');
    expect(replyFields!.d1_prefetched_records).toContain('10:30-18:30');
    expect(replyFields!.d1_prefetched_records).toContain('https://sohoceramics.example/popup');
    expect(replyFields!.d1_prefetched_records).toContain('kid-friendly');

    // 3. Falls back to latest self turn in recentHistory
    const historyCtx: RoomContext = {
      roomId: '!spotted_pref:matrix.netmind.chat',
      chatType: 'dm',
      members: [],
      recentHistory: [
        {
          eventId: '$sp_hist_1',
          senderId: SPOTTED_MATRIX_ID,
          senderName: 'Spotted London',
          isAgent: true,
          isSelf: true,
          text: '• Hackney Print Market\nhttps://app.manyfold.ai/spotted-london/p/hackney-print-market',
          timestampMs: NOW - 5_000,
        },
      ],
    };
    const histFields = await buildSpottedExtraEnvelopeFields(
      typedEnv,
      makeEvent({ text: 'is it kid-friendly?' }),
      dummyDecision,
      emptyMem,
      historyCtx,
    );
    expect(histFields?.d1_prefetched_records).toContain('Hackney Print Market');
    expect(histFields?.d1_prefetched_records).toContain('55 Mare St, E8 4RG');
    expect(histFields?.d1_prefetched_records).toContain('£15');
    expect(histFields?.d1_prefetched_records).toContain('https://hackneyprint.example/weekend');

    // 4. Falls back to top 3 weekend non-example popups when history has no slugs
    const fallbackCtx: RoomContext = {
      roomId: '!spotted_pref:matrix.netmind.chat',
      chatType: 'dm',
      members: [],
      recentHistory: [],
    };
    const weekendFields = await buildSpottedExtraEnvelopeFields(
      typedEnv,
      makeEvent({ text: 'Which one is best for a rainy Saturday?' }),
      dummyDecision,
      emptyMem,
      fallbackCtx,
    );
    expect(weekendFields).not.toBeNull();
    expect(weekendFields!.d1_prefetched_records.length).toBeLessThanOrEqual(1_400);
    expect(weekendFields!.d1_prefetched_records).toContain('Soho Ceramics Studio Pop-up');
    expect(weekendFields!.d1_prefetched_records).not.toContain('Example Ignored Popup');
  });

  it('caps formatted popups via parseRequestedLimit so "各推 1 個" returns exactly 1 popup', async () => {
    const liveStart = Date.now() - HOUR;
    const liveEnd = Date.now() + 7 * DAY;
    await seedPopup('ng_lim_1', {
      slug: 'soho-print-exhibition-1',
      title: 'Soho Print Exhibition One',
      category: 'exhibition',
      borough: 'Soho',
      priceType: 'free',
      status: 'verified_admin',
      startAt: liveStart,
      endAt: liveEnd,
    });
    await seedPopup('ng_lim_2', {
      slug: 'soho-photo-exhibition-2',
      title: 'Soho Photo Exhibition Two',
      category: 'exhibition',
      borough: 'Soho',
      priceType: 'free',
      status: 'verified_admin',
      startAt: liveStart,
      endAt: liveEnd,
    });
    await seedPopup('ng_lim_3', {
      slug: 'soho-design-exhibition-3',
      title: 'Soho Design Exhibition Three',
      category: 'exhibition',
      borough: 'Soho',
      priceType: 'free',
      status: 'verified_admin',
      startAt: liveStart,
      endAt: liveEnd,
    });

    expect(parseRequestedLimit('週末先在 Soho 吃點心再逛展覽，各推 1 個')).toBe(1);
    expect(parseRequestedLimit('推 2 個 Soho 展覽')).toBe(2);
    expect(parseRequestedLimit('这周末伦敦有哪两个展览可以去？')).toBe(2);
    expect(parseRequestedLimit('just 1 Soho exhibition')).toBe(1);
    expect(parseRequestedLimit('pick two pop-ups')).toBe(2);
    expect(parseRequestedLimit('這週末 Soho 有什麼展覽？')).toBeNull();

    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
    };
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };

    const onePopupReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({
        eventId: '$sp_lim_1',
        text: '@Spotted London 週末先在 Soho 吃點心再逛展覽，各推 1 個',
      }),
      {
        shouldReply: true,
        tier: 0,
        reason: 'explicit_mention',
        confidence: 1,
        detectedLang: 'zh-Hant',
        shouldQuote: true,
      },
      emptyMem,
    );
    expect(onePopupReply).toBeTruthy();
    const oneUrls = onePopupReply!.match(/https:\/\/app\.manyfold\.ai\/spotted-london\/p\/[^\s]+/g) ?? [];
    expect(oneUrls).toHaveLength(1);
    const oneBullets = onePopupReply!.match(/^• /gm) ?? [];
    expect(oneBullets).toHaveLength(1);

    const conversationalOne = await fastRespondSpotted(
      typedEnv,
      makeEvent({ text: '這週末 Soho 有免費展嗎？可以給我一個選擇嗎？' }),
      { shouldReply: true, tier: 1, reason: 'domain_match', confidence: 1, detectedLang: 'zh-Hant', shouldQuote: false },
      emptyMem,
    );
    expect(conversationalOne?.match(/^• /gm)).toHaveLength(1);
    expect(parseRequestedLimit('週末 Soho 有免費展嗎？可以給我兩個選擇嗎？')).toBe(2);

    // "推 2 個" returns exactly 2 popups
    const twoPopupsReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({
        eventId: '$sp_lim_2',
        text: '@Spotted London 週末 Soho 展覽推 2 個',
      }),
      {
        shouldReply: true,
        tier: 0,
        reason: 'explicit_mention',
        confidence: 1,
        detectedLang: 'zh-Hant',
        shouldQuote: true,
      },
      emptyMem,
    );
    expect(twoPopupsReply).toBeTruthy();
    expect(twoPopupsReply!.match(/https:\/\/app\.manyfold\.ai\/spotted-london\/p\/[^\s]+/g)).toHaveLength(2);

    // Without explicit count, default max (3) returns all 3 Soho exhibitions
    const defaultReply = await fastRespondSpotted(
      typedEnv,
      makeEvent({
        eventId: '$sp_lim_default',
        text: '@Spotted London 週末 Soho 有什麼展覽？',
      }),
      {
        shouldReply: true,
        tier: 0,
        reason: 'explicit_mention',
        confidence: 1,
        detectedLang: 'zh-Hant',
        shouldQuote: true,
      },
      emptyMem,
    );
    expect(defaultReply).toBeTruthy();
    expect(defaultReply!.match(/https:\/\/app\.manyfold\.ai\/spotted-london\/p\/[^\s]+/g)).toHaveLength(3);
  });

  it('delegates comparative and tube follow-ups to A2A after a DM popup list instead of matching "週六" into unrelated exhibitions', async () => {
    const liveStart = Date.now() - HOUR;
    const liveEnd = Date.now() + 7 * DAY;
    await seedPopup('ng_comp_mkt_1', {
      slug: 'hackney-vintage-market',
      title: 'Hackney Vintage Market',
      category: 'market',
      borough: 'Hackney',
      address: '10 Mare St, E8 4RP',
      hoursText: '10:00-17:00',
      priceType: 'free',
      description: 'Open-air weekend craft and vintage market with colourful murals and photo spots.',
      status: 'verified_admin',
      startAt: liveStart,
      endAt: liveEnd,
    });
    await seedPopup('ng_comp_mkt_2', {
      slug: 'soho-makers-market',
      title: 'Soho Makers Market',
      category: 'market',
      borough: 'Soho',
      address: '18 Berwick St, W1F 0PP',
      hoursText: '11:00-18:00',
      priceType: 'free',
      description: 'Independent ceramicists and street-food stalls in central Soho.',
      status: 'verified_admin',
      startAt: liveStart,
      endAt: liveEnd,
    });
    await seedPopup('ng_comp_exh_1', {
      slug: 'unrelated-weekend-exhibition',
      title: 'Unrelated Weekend Exhibition',
      category: 'exhibition',
      borough: 'Chelsea',
      priceType: 'paid',
      status: 'verified_admin',
      startAt: liveStart,
      endAt: liveEnd,
    });

    const aiRunSpy = vi.fn(async () => ({
      response: JSON.stringify({ isPopupQuery: true, when: 'weekend', category: 'exhibition' }),
    }));
    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
      AI: { run: aiRunSpy } as unknown as Ai,
    };
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const dmRoomId = '!spotted_dm_comp:matrix.netmind.chat';

    // Turn 1: DM asks for free weekend markets -> fastRespondSpotted returns free markets from D1
    const turn1Event = makeEvent({
      roomId: dmRoomId,
      chatType: 'dm',
      eventId: '$dm_comp_t1',
      text: '這週末倫敦有免費市集嗎？',
      timestampMs: NOW - 30_000,
    });
    const dmCtxTurn1: RoomContext = {
      roomId: dmRoomId,
      chatType: 'dm',
      members: [
        { matrixId: '@alice:matrix.netmind.chat', displayName: 'Alice', isAgent: false },
        { matrixId: SPOTTED_MATRIX_ID, displayName: 'Spotted London', isAgent: true },
      ],
      recentHistory: [],
    };
    const turn1Decision = await routeEvent(turn1Event, dmCtxTurn1, SPOTTED_AGENT_SPEC, { nowMs: NOW });
    expect(turn1Decision.shouldReply).toBe(true);
    expect(turn1Decision.reason).toBe('dm');
    expect(turn1Decision.detectedLang).toBe('zh-Hant');

    const turn1Reply = await fastRespondSpotted(typedEnv, turn1Event, turn1Decision, emptyMem, dmCtxTurn1);
    expect(turn1Reply).toBeTruthy();
    expect(turn1Reply).toContain('Hackney Vintage Market');
    expect(turn1Reply).toContain('Soho Makers Market');
    expect(turn1Reply).toContain('https://app.manyfold.ai/spotted-london/p/hackney-vintage-market');
    expect(turn1Reply).toContain('https://app.manyfold.ai/spotted-london/p/soho-makers-market');
    expect(turn1Reply).not.toContain('Unrelated Weekend Exhibition');

    // Turn 2: DM asks comparative photo + Tube follow-up referencing Turn 1's list -> returns null for A2A
    const turn2Event = makeEvent({
      roomId: dmRoomId,
      chatType: 'dm',
      eventId: '$dm_comp_t2',
      text: '這幾個裡面哪個最適合週六下午帶朋友去拍照？怎麼搭地鐵去？',
      timestampMs: NOW,
    });
    const dmCtxTurn2: RoomContext = {
      ...dmCtxTurn1,
      recentHistory: [
        {
          eventId: '$dm_comp_t1',
          senderId: '@alice:matrix.netmind.chat',
          senderName: 'Alice',
          isAgent: false,
          text: turn1Event.text,
          timestampMs: NOW - 30_000,
        },
        {
          eventId: '$dm_comp_r1',
          senderId: SPOTTED_MATRIX_ID,
          senderName: 'Spotted London',
          isAgent: true,
          isSelf: true,
          text: turn1Reply!,
          timestampMs: NOW - 20_000,
        },
      ],
    };
    const turn2Decision = await routeEvent(turn2Event, dmCtxTurn2, SPOTTED_AGENT_SPEC, { nowMs: NOW });
    expect(turn2Decision.shouldReply).toBe(true);
    expect(turn2Decision.reason).toBe('dm');

    const turn2Reply = await fastRespondSpotted(typedEnv, turn2Event, turn2Decision, emptyMem, dmCtxTurn2);
    expect(turn2Reply).toBeNull();
    expect(aiRunSpy).not.toHaveBeenCalled();

    // Simplified Chinese "哪一个" comparative follow-ups also delegate to A2A instead of fast-pathing
    for (const zhHansComp of ['里面哪一个值得去？', '哪一个最值得去？', '哪一个最好？']) {
      const zhHansEv = makeEvent({
        roomId: dmRoomId,
        chatType: 'dm',
        eventId: `$dm_comp_zh_hans_${zhHansComp.length}`,
        text: zhHansComp,
        timestampMs: NOW,
      });
      const zhHansDec = await routeEvent(zhHansEv, dmCtxTurn2, SPOTTED_AGENT_SPEC, { nowMs: NOW });
      expect(zhHansDec.shouldReply, zhHansComp).toBe(true);
      const zhHansReply = await fastRespondSpotted(typedEnv, zhHansEv, zhHansDec, emptyMem, dmCtxTurn2);
      expect(zhHansReply, zhHansComp).toBeNull();
    }

    // And A2A envelope prefetch includes those exact Turn 1 markets
    const prefetched = await buildSpottedExtraEnvelopeFields(
      typedEnv,
      turn2Event,
      turn2Decision,
      emptyMem,
      dmCtxTurn2,
    );
    expect(prefetched?.d1_prefetched_records).toContain('Hackney Vintage Market');
    expect(prefetched?.d1_prefetched_records).toContain('Soho Makers Market');
    expect(prefetched?.d1_prefetched_records).not.toContain('Unrelated Weekend Exhibition');
  });

  it("handles dual-@ King's Cross co-mention without dropping on peer anti-keywords and returns 1 pick", async () => {
    const liveStart = Date.now() - HOUR;
    const liveEnd = Date.now() + 7 * DAY;
    await seedPopup('ng_dual_kx_1', {
      slug: 'kings-cross-canopy-market',
      title: "King's Cross Canopy Design Market",
      category: 'market',
      borough: "King's Cross",
      address: 'West Handyside Canopy, N1C 4BH',
      hoursText: '11:00-18:00',
      priceType: 'free',
      status: 'verified_admin',
      startAt: liveStart,
      endAt: liveEnd,
    });
    await seedPopup('ng_dual_kx_2', {
      slug: 'kings-cross-vinyl-popup',
      title: "King's Cross Vinyl & Print Pop-up",
      category: 'exhibition',
      borough: "King's Cross",
      address: 'Coal Drops Yard, N1C 4DQ',
      hoursText: '10:00-19:00',
      priceType: 'free',
      status: 'verified_admin',
      startAt: liveStart,
      endAt: liveEnd,
    });

    const dualText = "@London Chinese Food @Spotted London 週末想去 King's Cross 吃飯加逛逛，各推 1 個";
    const filter = extractPopupQueryFilter(dualText);
    expect(filter.isClearSearch).toBe(true);
    expect(filter.when).toBe('weekend');
    expect(filter.q).toBe("King's Cross");

    const aiRunSpy = vi.fn(async () => ({ response: '{"score":0.1,"reason":"unexpected_ai_call"}' }));
    const triageModel = createWorkersAiTriageModel({ run: aiRunSpy } as unknown as Ai);
    const groupCtx: RoomContext = {
      roomId: '!spotted_dual_kx:matrix.netmind.chat',
      chatType: 'group',
      members: [
        { matrixId: '@alice:matrix.netmind.chat', displayName: 'Alice', isAgent: false },
        { matrixId: SPOTTED_MATRIX_ID, displayName: 'Spotted London', isAgent: true },
        { matrixId: '@agent-b2b526f3:matrix.netmind.chat', displayName: 'London Chinese Food', isAgent: true },
      ],
      recentHistory: [],
    };
    const dualEvent = makeEvent({
      roomId: '!spotted_dual_kx:matrix.netmind.chat',
      chatType: 'group',
      eventId: '$sp_dual_kx',
      text: dualText,
      mentions: ['@agent-b2b526f3:matrix.netmind.chat', SPOTTED_MATRIX_ID],
    });

    const decision = await routeEvent(dualEvent, groupCtx, SPOTTED_AGENT_SPEC, { nowMs: NOW, triageModel });
    expect(decision.shouldReply).toBe(true);
    expect(decision.reason).toBe('multi_mention_domain_match');
    expect(decision.detectedLang).toBe('zh-Hant');
    expect(aiRunSpy).not.toHaveBeenCalled();

    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
    };
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const reply = await fastRespondSpotted(typedEnv, dualEvent, decision, emptyMem, groupCtx);
    expect(reply).toBeTruthy();
    expect(reply).not.toBe('[NO_REPLY]');
    expect(reply).toContain("King's Cross");
    expect(reply!.match(/https:\/\/app\.manyfold\.ai\/spotted-london\/p\/[^\s]+/g)).toHaveLength(1);
    expect(reply!.match(/^• /gm)).toHaveLength(1);
    expect(reply).not.toMatch(/\]\(https?:\/\//);
  });

  it('scopes buildSpottedExtraEnvelopeFields prefetch to latest self turn with popup slugs (and replyToTarget) without mixing older self turns', async () => {
    const liveStart = Date.now() - HOUR;
    const liveEnd = Date.now() + 7 * DAY;
    await seedPopup('ng_scope_old', {
      slug: 'older-topic-sample-sale',
      title: 'Older Topic Sample Sale',
      category: 'sample',
      borough: 'Mayfair',
      status: 'verified_admin',
      startAt: liveStart,
      endAt: liveEnd,
    });
    await seedPopup('ng_scope_new', {
      slug: 'latest-topic-ceramics-market',
      title: 'Latest Topic Ceramics Market',
      category: 'market',
      borough: 'Hackney',
      status: 'verified_admin',
      startAt: liveStart,
      endAt: liveEnd,
    });

    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
    };
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const dec = {
      shouldReply: true,
      tier: 0 as const,
      reason: 'dm',
      confidence: 1,
      detectedLang: 'zh-Hans' as const,
      shouldQuote: false,
    };

    const olderTurn = {
      eventId: '$sp_old_1',
      senderId: SPOTTED_MATRIX_ID,
      senderName: 'Spotted London',
      isAgent: true,
      isSelf: true,
      text: '• Older Topic Sample Sale\nhttps://app.manyfold.ai/spotted-london/p/older-topic-sample-sale',
      timestampMs: NOW - 3_600_000,
    };
    const latestTurn = {
      eventId: '$sp_new_1',
      senderId: SPOTTED_MATRIX_ID,
      senderName: 'Spotted London',
      isAgent: true,
      isSelf: true,
      text: '• Latest Topic Ceramics Market\nhttps://app.manyfold.ai/spotted-london/p/latest-topic-ceramics-market',
      timestampMs: NOW - 30_000,
    };
    const nonUrlTurn = {
      eventId: '$sp_ack_1',
      senderId: SPOTTED_MATRIX_ID,
      senderName: 'Spotted London',
      isAgent: true,
      isSelf: true,
      text: '不客气！还有想了解的吗？',
      timestampMs: NOW - 10_000,
    };

    // 1. Latest self reply yields popup slug -> older self turn is excluded
    const latestFields = await buildSpottedExtraEnvelopeFields(
      typedEnv,
      makeEvent({ chatType: 'dm', text: '这几个里面哪一个最值得去？' }),
      dec,
      emptyMem,
      {
        roomId: '!spotted_scope:matrix.netmind.chat',
        chatType: 'dm',
        members: [],
        recentHistory: [olderTurn, latestTurn],
      },
    );
    expect(latestFields?.d1_prefetched_records).toContain('Latest Topic Ceramics Market');
    expect(latestFields?.d1_prefetched_records).not.toContain('Older Topic Sample Sale');

    // 2. Non-URL follow-up self reply falls back to most recent self turn with URLs, still excluding older turns
    const afterAckFields = await buildSpottedExtraEnvelopeFields(
      typedEnv,
      makeEvent({ chatType: 'dm', text: '怎么搭地铁去？' }),
      dec,
      emptyMem,
      {
        roomId: '!spotted_scope:matrix.netmind.chat',
        chatType: 'dm',
        members: [],
        recentHistory: [olderTurn, latestTurn, nonUrlTurn],
      },
    );
    expect(afterAckFields?.d1_prefetched_records).toContain('Latest Topic Ceramics Market');
    expect(afterAckFields?.d1_prefetched_records).not.toContain('Older Topic Sample Sale');

    // 3. replyToTarget takes priority without mixing recentHistory
    const replyFields = await buildSpottedExtraEnvelopeFields(
      typedEnv,
      makeEvent({ chatType: 'group', text: '这个要预约吗？' }),
      dec,
      emptyMem,
      {
        roomId: '!spotted_scope:matrix.netmind.chat',
        chatType: 'group',
        members: [],
        recentHistory: [olderTurn, latestTurn],
        replyToTarget: {
          eventId: '$sp_old_1',
          senderId: SPOTTED_MATRIX_ID,
          senderName: 'Spotted London',
          isAgent: true,
          isSelf: true,
          text: olderTurn.text,
        },
      },
    );
    expect(replyFields?.d1_prefetched_records).toContain('Older Topic Sample Sale');
    expect(replyFields?.d1_prefetched_records).not.toContain('Latest Topic Ceramics Market');
  });

  it('routes Chinese art exhibition prompts ("伦敦最近有没有免费的艺术展？") via domainKeywords and extracts exhibition + free filters', async () => {
    const liveStart = Date.now() - HOUR;
    const liveEnd = Date.now() + 7 * DAY;
    await seedPopup('ng_art_exh_free', {
      slug: 'free-contemporary-art-exhibition',
      title: 'Free Contemporary Art Exhibition',
      category: 'exhibition',
      borough: 'Southwark',
      address: 'Bankside, SE1 9TG',
      hoursText: '10:00-18:00',
      priceType: 'free',
      status: 'verified_admin',
      startAt: liveStart,
      endAt: liveEnd,
    });
    await seedPopup('ng_art_exh_paid', {
      slug: 'paid-sculpture-exhibition',
      title: 'Paid Sculpture Exhibition',
      category: 'exhibition',
      borough: 'Mayfair',
      priceType: 'paid',
      status: 'verified_admin',
      startAt: liveStart,
      endAt: liveEnd,
    });

    const queryText = '伦敦最近有没有免费的艺术展？';
    const groupCtx: RoomContext = {
      roomId: '!spotted_art_exh:matrix.netmind.chat',
      chatType: 'group',
      members: [
        { matrixId: '@alice:matrix.netmind.chat', displayName: 'Alice', isAgent: false },
        { matrixId: SPOTTED_MATRIX_ID, displayName: 'Spotted London', isAgent: true },
      ],
      recentHistory: [],
    };
    const ev = makeEvent({
      roomId: '!spotted_art_exh:matrix.netmind.chat',
      chatType: 'group',
      eventId: '$sp_art_exh_1',
      text: queryText,
    });

    expect(heuristicDomainScore(ev, SPOTTED_AGENT_SPEC, groupCtx)).toBeGreaterThanOrEqual(0.55);
    const decision = await routeEvent(ev, groupCtx, SPOTTED_AGENT_SPEC, { nowMs: NOW });
    expect(decision.shouldReply).toBe(true);
    expect(decision.detectedLang).toBe('zh-Hans');

    const filter = extractPopupQueryFilter(queryText);
    expect(filter.isClearSearch).toBe(true);
    expect(filter.free).toBe('1');
    expect(filter.category?.split(',')).toContain('exhibition');

    // Pure exhibition variants (e.g. 画展 / 摄影展 / 免费展) extract category: 'exhibition'
    expect(extractPopupQueryFilter('伦敦最近有没有免费的画展？')).toMatchObject({
      category: 'exhibition',
      free: '1',
      isClearSearch: true,
    });
    expect(extractPopupQueryFilter('這週末有什麼免費攝影展或特展？')).toMatchObject({
      category: 'exhibition',
      free: '1',
      isClearSearch: true,
    });

    const typedEnv = {
      ...(env as unknown as Bindings),
      APP_URL: 'https://app.manyfold.ai/spotted-london',
    };
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const reply = await fastRespondSpotted(typedEnv, ev, decision, emptyMem, groupCtx);
    expect(reply).toBeTruthy();
    expect(reply).not.toBe('[NO_REPLY]');
    expect(reply).toContain('Free Contemporary Art Exhibition');
    expect(reply).toContain('https://app.manyfold.ai/spotted-london/p/free-contemporary-art-exhibition');
    expect(reply).not.toContain('Paid Sculpture Exhibition');
  });

  it('answers an unmentioned after-work outing using only events open in the evening', async () => {
    const startAt = Date.parse('2026-11-23T00:00:00Z');
    const endAt = Date.parse('2026-11-24T00:00:00Z');
    await seedPopup('daytime', { title: 'Daytime Exhibit', hoursText: '11am-6pm', startAt, endAt });
    await seedPopup('after-work', { title: 'After Work Exhibit', hoursText: '12:00-21:00', startAt, endAt });
    const event = makeEvent({ text: '今天下班去哪儿玩', timestampMs: startAt + 15 * 3_600_000 });
    const context: RoomContext = { roomId: event.roomId, chatType: 'group', members: [], recentHistory: [] };
    const decision = await routeEvent(event, context, SPOTTED_AGENT_SPEC, { nowMs: event.timestampMs });
    expect(decision.shouldReply).toBe(true);
    const answer = await fastRespondSpotted(env as unknown as Bindings, event, decision,
      { userMemories: [], roomMemories: [], promptSafeLines: [] }, context);
    expect(answer).toContain('After Work Exhibit');
    expect(answer).toContain('21:00');
    expect(answer).not.toContain('Daytime Exhibit');
  });

  it('keeps the Friday, Soho, exhibition and free constraints through a later-hours follow-up', async () => {
    const nowMs = Date.parse('2026-11-23T12:00:00Z');
    const startAt = Date.parse('2026-11-27T00:00:00Z');
    const endAt = Date.parse('2026-11-28T00:00:00Z');
    for (const [id, title, hoursText, borough, priceType] of [
      ['close-six', 'Six Close', '11am-6pm', 'Soho', 'free'],
      ['close-seven', 'Seven Close', '10:00-19:00', 'Soho', 'free'],
      ['open-late', 'Evening Exhibition', '17:00-21:00', 'Soho', 'free'],
      ['different-area', 'Other Area', '17:00-21:00', 'Camden', 'free'],
      ['paid-late', 'Paid Evening', '17:00-21:00', 'Soho', 'paid'],
      ['unknown-hours', 'Unknown Hours', 'Check opening hours', 'Soho', 'free'],
    ] as const) {
      await seedPopup(id, { title, hoursText, borough, priceType, startAt, endAt });
    }
    const question = makeEvent({
      text: 'BAO 先留著。吃完想走去看展，週五晚在 Soho 附近有免費展覽嗎？',
      timestampMs: nowMs - 2000,
    });
    const event = makeEvent({
      text: '六點關的那間先跳過，有沒有晚上七點後還能去的？',
      timestampMs: nowMs,
    });
    const context: RoomContext = {
      roomId: event.roomId,
      chatType: 'group',
      members: [],
      activeSession: { active: true },
      recentHistory: [
        { eventId: '$friday-query', senderId: event.senderId, isAgent: false,
          text: question.text, timestampMs: question.timestampMs },
        { eventId: '$spotted-list', senderId: SPOTTED_MATRIX_ID, isAgent: true, isSelf: true,
          text: 'Soho 展覽清單', timestampMs: nowMs - 1000 },
      ],
    };
    const memories = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const typedEnv = env as unknown as Bindings;
    const opening = await routeEvent(question, context, SPOTTED_AGENT_SPEC, { nowMs });
    const first = await fastRespondSpotted(typedEnv, question, opening, memories, { ...context, recentHistory: [] });
    expect(first).toContain('週五 18:00');
    expect(first).not.toContain('Six Close');
    const combined = { ...question, text: '那週五在 Soho 先吃個不辣的中餐，飯後附近有免費展嗎？' };
    const combinedReply = await fastRespondSpotted(typedEnv, combined, opening, memories, { ...context, recentHistory: [] });
    expect(combinedReply).toContain('週五 18:00');
    expect(combinedReply).toContain('Evening Exhibition');
    expect(combinedReply).not.toContain('Six Close');

    const lunch = { ...combined, text: '那週五中午在 Soho 先吃個不辣的中餐，飯後附近有免費展嗎？' };
    const lunchReply = await fastRespondSpotted(typedEnv, lunch, opening, memories, { ...context, recentHistory: [] });
    expect(lunchReply).not.toContain('週五 18:00');

    const following = await routeEvent(event, context, SPOTTED_AGENT_SPEC, { nowMs });
    expect(following.shouldReply).toBe(true);
    const second = await fastRespondSpotted(typedEnv, event, following, memories, context);
    expect(second).toContain('週五 19:00');
    expect(second).toContain('Evening Exhibition');
    expect(second).not.toMatch(/Six Close|Seven Close|Other Area|Paid Evening|Unknown Hours/);
  });
});

it('speaks only on its own topic in mixed group chatter', async () => {
  const cases = [
    '晚上能吃啥',
    '我先去開個會',
    '今晚倫敦有什麼市集',
    '今天 AI 圈有啥新消息',
    '能抽張塔羅看看工作嗎',
    '幫我求一支籤',
    '有英國簽證資料可以查嗎',
    '晚餐 £80 我付的，四個人怎麼分',
    'Boots 有折扣碼嗎',
    '昨天吃火鍋超爽',
  ];
  const nowMs = Date.now();
  const replies: string[] = [];
  for (const text of cases) {
    const event = makeEvent({ text, timestampMs: nowMs, chatType: 'group', mentions: [] });
    const context = { roomId: event.roomId, chatType: 'group' as const, members: [], recentHistory: [] };
    if ((await routeEvent(event, context, SPOTTED_AGENT_SPEC, { nowMs })).shouldReply) replies.push(text);
  }
  expect(replies).toEqual(["今晚倫敦有什麼市集"]);

  const text = '今晚倫敦有什麼市集';
  const directedEvent = makeEvent({ text: `@Ken ${text}`, timestampMs: nowMs, chatType: 'group', mentions: ['@ken:example.com'] });
  const directedContext = { roomId: directedEvent.roomId, chatType: 'group' as const, members: [], recentHistory: [] };
  expect((await routeEvent(directedEvent, directedContext, SPOTTED_AGENT_SPEC, { nowMs })).shouldReply).toBe(false);
});

it('takes its own part of the mixed dinner and exhibition request after a peer answers', async () => {
  const nowMs = Date.now();
  const event = makeEvent({
    text: '那週五在 Soho 先吃個不辣的中餐，飯後附近有免費展嗎？',
    timestampMs: nowMs,
    chatType: 'group',
    mentions: [],
  });
  const peer = { matrixId: '@agent-b2b526f3:matrix.netmind.chat', displayName: 'London Chinese Food', isAgent: true };
  const context = {
    roomId: event.roomId,
    chatType: 'group' as const,
    members: [peer],
    recentHistory: [{
      eventId: '$peer-already-answered',
      senderId: peer.matrixId,
      isAgent: true,
      timestampMs: nowMs + 5,
      text: 'Here are options for my part.',
    }],
  };
  expect(await routeEvent(event, context, SPOTTED_AGENT_SPEC, { nowMs: nowMs + 10 }))
    .toMatchObject({ shouldReply: true, independentGroupReply: true });
  expect(await routeEvent(event, { ...context, members: [], recentHistory: [] }, SPOTTED_AGENT_SPEC, { nowMs: nowMs + 10 }))
    .not.toHaveProperty('independentGroupReply');
});
