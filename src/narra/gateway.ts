import {
  sanitizeMobileLinks,
  stripAgentMentions,
  type AgentSpec,
  type AgentUpdateItem,
  type InboundEvent,
  type LangCode,
  type RecallTurnResult,
  type RoomContext,
  type TriageDecision,
} from '@manyfold/narra-agent-kit';
import type {
  NarraA2ACredentialResult,
  NarraGatewayConfig,
} from '@manyfold/narra-agent-kit/worker';
import { SOURCE_CHECKED_SQL, toPublic } from '../db/popups';
import { unseal } from '../lib/seal';
import { londonParts } from '../lib/time';
import { listPopups } from '../routes/popups';
import { CATEGORIES, type Category } from '../shared/categories';
import { parseRangesColumn } from '../shared/ranges';
import type { Bindings, PopupRow } from '../types';

export const SPOTTED_AGENT_ID = 'agt_agq66frxtn7pnajpsidj2qhike';
export const SPOTTED_MATRIX_ID = '@agent-f9388b28:matrix.netmind.chat';

const DEFAULT_APP_URL = 'https://app.manyfold.ai/spotted-london';
const DEFAULT_NARRA_ENDPOINT = 'https://api.netmind.chat';
const UPDATE_LOOKBACK_MS = 48 * 3_600_000;

export const ALL_KNOWN_MENTION_NAMES = [
  'Spotted London',
  'Spotted',
  '快闪',
  '快閃',
  'spotted-guide',
  'AI in 5',
  'AI5',
  'ai5-chat',
  'AI新聞',
  'AI新闻',
  '問一籤',
  '问一签',
  'AI Fortune Stick',
  '塔羅大師',
  '塔罗大师',
  'AI Tarot',
  'London Chinese Food',
  'Manyfold Data',
  'Penny',
  'Quidpaw',
] as const;

const LONDON_OUTING_RE =
  /(?:這週末|这周末|週末|周末|weekend).{0,24}(?:倫敦|伦敦|\blondon\b).{0,24}(?:逛|好玩|去哪|特別|特别|things\s+to\s+do)|(?:倫敦|伦敦|\blondon\b).{0,24}(?:逛逛|好去處|好去处|哪裡好玩|哪里好玩|比較特別|比较特别|things\s+to\s+do)|things\s+to\s+do.{0,16}(?:倫敦|伦敦|\blondon\b)/i;

export const SPOTTED_AGENT_SPEC: AgentSpec = {
  id: 'spotted-guide',
  matrixId: SPOTTED_MATRIX_ID,
  name: 'Spotted London',
  aliases: ['Spotted London', 'Spotted', '快闪', '快閃', 'spotted-guide'],
  domainDescription:
    'London pop-ups guide (Spotted London): ONLY limited-time pop-ups, sample sales, art exhibitions, weekend markets, and unique weekend events/outings across London — explicitly NOT everyday restaurants, hunger, or general "where to eat" queries.',
  domainKeywords: [
    'spotted london',
    'spotted',
    'pop-up',
    'pop-ups',
    'popup',
    'popups',
    'sample sale',
    'sample sales',
    'supper club',
    'supper clubs',
    'exhibition',
    'exhibitions',
    'art exhibition',
    'market',
    'markets',
    'immersive',
    'freebies',
    '快閃',
    '快闪',
    '快閃店',
    '快闪店',
    '市集',
    '展覽',
    '展览',
    '看展',
    '藝術展',
    '艺术展',
    '畫展',
    '画展',
    '攝影展',
    '摄影展',
    '美展',
    '特展',
    '免費展',
    '免费展',
    '樣品特賣',
    '样品特卖',
    '特賣會',
    '特卖会',
    '期間限定',
    '期间限定',
    '倫敦週末',
    '伦敦周末',
    '倫敦活動',
    '伦敦活动',
    '週末好去處',
    '周末好去处',
    '有什麼好玩的',
    '有什么好玩的',
    '倫敦哪裡逛',
    '伦敦哪里逛',
    '倫敦逛逛',
    '伦敦逛逛',
    '去倫敦逛',
    '這週末去哪',
    '这周末去哪',
    LONDON_OUTING_RE,
    /\blondon\b.{0,20}(?:pop[- ]?ups?|markets?|exhibitions?|sample\s*sales?|events?|things\s+to\s+do|this\s+weekend)/i,
    /(?:this\s+weekend|today|tonight|what'?s\s+on).{0,20}\blondon\b/i,
    /\b(?:shoreditch|soho|hackney|camden|covent\s*garden|brick\s*lane|marylebone|brixton|notting\s*hill|king'?s\s*cross|euston|holborn|waterloo|southbank|london\s*bridge|canary\s*wharf|stratford|kensington|angel|battersea)\b.{0,24}(?:\b(?:pop[- ]?ups?|markets?|exhibitions?|sample\s*sales?|events?|gallery|galleries|what'?s\s+on|things\s+to\s+do)\b|快閃|快闪|市集|展覽|展览|特賣|特卖|活動|活动|逛逛|逛一逛|好去處|好去处)/i,
    /(?:\b(?:pop[- ]?ups?|markets?|exhibitions?|sample\s*sales?|events?|gallery|galleries|what'?s\s+on|things\s+to\s+do)\b|快閃|快闪|市集|展覽|展览|特賣|特卖|活動|活动|逛逛|逛一逛|好去處|好去处).{0,24}\b(?:shoreditch|soho|hackney|camden|covent\s*garden|brick\s*lane|marylebone|brixton|notting\s*hill|king'?s\s*cross|euston|holborn|waterloo|southbank|london\s*bridge|canary\s*wharf|stratford|kensington|angel|battersea)\b/i,
  ],
  antiKeywords: [
    'dim sum',
    'hotpot',
    'bubble tea',
    '火鍋',
    '火锅',
    '點心',
    '点心',
    '奶茶',
    '中餐',
    '川菜',
    '粵菜',
    '粤菜',
    'chinatown',
    '中國城',
    '中国城',
    '唐人街',
    '好餓',
    '好饿',
    '餓了',
    '饿了',
    '推薦吃的',
    '推荐吃的',
    '吃什麼',
    '吃什么',
    '吃飯',
    '吃饭',
    '餐廳',
    '餐厅',
    '麵館',
    '面馆',
    '拉麵',
    '拉面',
    'hungry',
    'where to eat',
    'good restaurant',
    'chinese restaurant',
    'ai in 5',
    'ai5',
    'ai news',
    'ai新闻',
    'ai新聞',
    'openai',
    'anthropic',
    'claude',
    'gemini',
    'deepseek',
    'llm',
    '大模型',
    '新模型',
    'tarot',
    '塔羅',
    '塔罗',
    '求籤',
    '求签',
    '問一籤',
    '问一签',
    'fortune stick',
    'promo code',
    'discount code',
    'voucher',
    '優惠碼',
    '优惠码',
    'splitwise',
    'aa制',
    '分帳',
    '分账',
    'visa change',
    '簽證',
    '签证',
    'recall',
    '召回',
    'hackathon',
    'hackathons',
    '黑客松',
    '駭客松',
    '融資',
    '融资',
    'fundraising',
    '獎學金',
    '奖学金',
    'scholarship',
    '馬拉松',
    '马拉松',
    'marathon',
    'robotaxi',
    'data center',
  ],
  silenceThreshold: 0.55,
  sessionWindowMs: 180_000,
  politeYieldDelayMs: 1_800,
};

function appBase(env: Pick<Bindings, 'APP_URL'>): string {
  return (env.APP_URL ?? DEFAULT_APP_URL).trim().replace(/\/+$/, '') || DEFAULT_APP_URL;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatSpan(startMs: number, endMs: number): string {
  const a = londonParts(startMs);
  const b = londonParts(endMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dA = `${DAYS[a.dow]} ${a.d} ${MONTHS[a.m - 1]}`;
  const dB = `${DAYS[b.dow]} ${b.d} ${MONTHS[b.m - 1]}`;
  if (a.y === b.y && a.m === b.m && a.d === b.d) {
    if (a.hh === 0 && a.mm === 0 && b.hh === 23 && b.mm === 59) return dA;
    return `${dA} ${pad(a.hh)}:${pad(a.mm)}-${pad(b.hh)}:${pad(b.mm)}`;
  }
  return `${dA} to ${dB}`;
}

export function formatPopupDates(
  p: Pick<PopupRow, 'start_at' | 'end_at' | 'date_kind' | 'date_ranges'> | { start_at: number; end_at: number; date_kind?: string; ranges?: [number, number][] },
  lang: LangCode,
): string {
  const ranges = 'ranges' in p && Array.isArray(p.ranges)
    ? p.ranges
    : 'date_ranges' in p
      ? parseRangesColumn(p.date_ranges)
      : null;

  if (p.date_kind === 'undated') {
    if (lang === 'zh-Hant') return '日期待定';
    if (lang === 'zh-Hans') return '日期待定';
    return 'dates TBC';
  }
  if (p.date_kind === 'open_end') {
    const a = londonParts(p.start_at);
    const startLabel = `${DAYS[a.dow]} ${a.d} ${MONTHS[a.m - 1]}`;
    if (lang === 'zh-Hant') return `${startLabel} 起（結束日未定）`;
    if (lang === 'zh-Hans') return `${startLabel} 起（结束日未定）`;
    return `from ${startLabel} (end TBC)`;
  }
  if (ranges && ranges.length > 0) {
    return ranges.map(([s, e]) => formatSpan(s, e)).join('; ');
  }
  return formatSpan(p.start_at, p.end_at);
}

function verificationLabel(
  status: string,
  sourceChecked: boolean,
  lang: LangCode,
): string {
  if (status === 'verified_admin' || status === 'verified_community') {
    if (lang === 'zh-Hant') return '已驗證';
    if (lang === 'zh-Hans') return '已验证';
    return 'verified';
  }
  if (lang === 'zh-Hant') return sourceChecked ? '待確認（已核對來源）' : '待確認';
  if (lang === 'zh-Hans') return sourceChecked ? '待确认（已核对来源）' : '待确认';
  return sourceChecked ? 'not confirmed yet, source checked' : 'not confirmed yet';
}

function priceLabel(
  priceType: string | null | undefined,
  priceText: string | null | undefined,
  lang: LangCode,
): string {
  if (priceType === 'free') {
    const base = lang === 'zh-Hant' ? '免費' : lang === 'zh-Hans' ? '免费' : 'free';
    return priceText ? `${base} (${priceText})` : base;
  }
  if (priceText) return priceText;
  if (priceType === 'paid') {
    return lang === 'zh-Hant' ? '收費' : lang === 'zh-Hans' ? '收费' : 'paid';
  }
  return '';
}

type PublicPopup = ReturnType<typeof toPublic>;

export function formatPopupsReply(
  items: PublicPopup[],
  lang: LangCode,
  baseUrl: string,
  options: { voice?: boolean; intro?: string; isUpdateDigest?: boolean; maxItems?: number } = {},
): string {
  const defaultMax = options.voice ? 2 : 3;
  const maxItems =
    typeof options.maxItems === 'number' && Number.isFinite(options.maxItems)
      ? Math.max(1, Math.min(5, Math.floor(options.maxItems)))
      : defaultMax;
  const top = items.slice(0, options.voice ? Math.min(maxItems, 2) : maxItems);
  if (options.voice) {
    const spoken = top.map((item) => {
      const area = item.location.borough || item.location.address || 'London';
      const dates = formatPopupDates(item, lang);
      return `${item.title} in ${area}, ${dates}`;
    });
    if (lang === 'zh-Hant') {
      const list = top
        .map((item) => `${item.title}，地點在 ${item.location.borough || item.location.address || '倫敦'}，時間 ${formatPopupDates(item, lang)}`)
        .join('；');
      return `倫敦最近值得去的快閃有：${list}。想聽哪一個的詳細資訊嗎？`;
    }
    if (lang === 'zh-Hans') {
      const list = top
        .map((item) => `${item.title}，地点在 ${item.location.borough || item.location.address || '伦敦'}，时间 ${formatPopupDates(item, lang)}`)
        .join('；');
      return `伦敦最近值得去的快闪有：${list}。想听哪一个的详细信息吗？`;
    }
    return `Here are top London pop-ups right now: ${spoken.join('; ')}. Would you like details on any of these?`;
  }

  const lines: string[] = [];
  if (options.intro) {
    lines.push(options.intro);
  } else if (options.isUpdateDigest) {
    if (lang === 'zh-Hant') lines.push('倫敦新驗證快閃活動推薦：');
    else if (lang === 'zh-Hans') lines.push('伦敦新验证快闪活动推荐：');
    else lines.push('Newly verified upcoming pop-ups on Spotted London:');
  } else if (lang === 'zh-Hant') {
    lines.push('以下是符合條件的倫敦快閃活動：');
  } else if (lang === 'zh-Hans') {
    lines.push('以下是符合条件的伦敦快闪活动：');
  } else {
    lines.push('Here is what is on in London:');
  }

  top.forEach((item) => {
    const area = item.location.borough || item.location.address || 'London';
    const dates = formatPopupDates(item, lang);
    const price = priceLabel(item.price?.type, item.price?.text, lang);
    const ver = verificationLabel(item.status, Boolean(item.source_checked), lang);
    const meta = [area, dates, item.hours_text || '', price, ver].filter(Boolean).join(' | ');
    lines.push(`• ${item.title} (${meta})`);
    lines.push(`${baseUrl}/p/${item.slug}`);
  });

  return sanitizeMobileLinks(lines.join('\n'));
}

function extractPopupSlugs(text: string, limit = 3): string[] {
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const match of (text ?? '').matchAll(/\/p\/([a-z0-9_-]+)/gi)) {
    const slug = match[1]?.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
    if (slugs.length >= limit) break;
  }
  return slugs;
}

function extractPriorSelfPopupSlugs(context?: RoomContext, limit = 3): string[] {
  if (context?.replyToTarget?.isSelf || context?.replyToTarget?.senderId === SPOTTED_MATRIX_ID) {
    const replySlugs = extractPopupSlugs(context.replyToTarget.text, limit);
    if (replySlugs.length > 0) return replySlugs;
  }
  const selfTurns = [...(context?.recentHistory ?? [])]
    .reverse()
    .filter((h) => h.isSelf || h.senderId === SPOTTED_MATRIX_ID);
  for (const turn of selfTurns.slice(0, 4)) {
    const slugs = extractPopupSlugs(turn.text ?? '', limit);
    if (slugs.length > 0) return slugs;
  }
  return [];
}

function validHttpsUrl(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

function excerptDescription(description: string | null | undefined, maxLen = 220): string {
  const clean = (description ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const sentences = clean.match(/[^.!?。！？]+(?:[.!?。！？]+(?=\s|$)|[。！？]+)/g);
  if (sentences && sentences.length > 0) {
    let out = sentences[0].trim();
    if (sentences.length > 1) {
      const second = sentences[1].trim();
      const sep = /[。！？]$/.test(out) ? '' : ' ';
      if (out.length + sep.length + second.length <= maxLen) {
        out = `${out}${sep}${second}`;
      }
    }
    if (out.length <= maxLen) return out;
    return `${out.slice(0, maxLen - 1).trimEnd()}…`;
  }
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1).trimEnd()}…`;
}

export function formatPopupDetailsReply(
  items: PublicPopup[],
  lang: LangCode,
  baseUrl: string,
  options: { voice?: boolean } = {},
): string {
  const top = items.slice(0, 3);
  if (options.voice) {
    const spoken = top.map((item) => {
      const area = item.location.borough?.trim() || '';
      const addr = item.location.address?.trim() || '';
      const where =
        area && addr && !addr.toLowerCase().includes(area.toLowerCase())
          ? `${addr}, ${area}`
          : addr || area || 'London';
      const dates = formatPopupDates(item, lang);
      const hours = item.hours_text?.trim() || '';
      const price = priceLabel(item.price?.type, item.price?.text, lang);
      const excerpt = excerptDescription(item.description, 140);
      if (lang === 'zh-Hant') {
        return [item.title, `地點在 ${where}`, `日期 ${dates}`, hours ? `時間 ${hours}` : '', price ? `費用 ${price}` : '', excerpt]
          .filter(Boolean)
          .join('，');
      }
      if (lang === 'zh-Hans') {
        return [item.title, `地点在 ${where}`, `日期 ${dates}`, hours ? `时间 ${hours}` : '', price ? `费用 ${price}` : '', excerpt]
          .filter(Boolean)
          .join('，');
      }
      return [item.title, `at ${where}`, dates, hours, price, excerpt].filter(Boolean).join(', ');
    });
    return spoken.join('； ');
  }

  const lines: string[] = [];
  if (lang === 'zh-Hant') lines.push(top.length > 1 ? '這幾個活動的詳細資訊如下：' : '活動詳細資訊如下：');
  else if (lang === 'zh-Hans') lines.push(top.length > 1 ? '这几个活动的详细信息如下：' : '活动详细信息如下：');
  else lines.push('Here are the full details:');

  for (const item of top) {
    const area = item.location.borough?.trim() || '';
    const addr = item.location.address?.trim() || '';
    const locationText =
      area && addr
        ? addr.toLowerCase().includes(area.toLowerCase())
          ? addr
          : `${area} · ${addr}`
        : addr || area || (lang === 'zh-Hant' ? '倫敦' : lang === 'zh-Hans' ? '伦敦' : 'London');
    const dates = formatPopupDates(item, lang);
    const hours = item.hours_text?.trim() || '';
    const price = priceLabel(item.price?.type, item.price?.text, lang);
    const ver = verificationLabel(item.status, Boolean(item.source_checked), lang);
    const excerpt = excerptDescription(item.description);
    const sourceUrl = validHttpsUrl(item.source_url);

    lines.push(`• ${item.title}`);
    if (lang === 'zh-Hant') {
      lines.push(`地點：${locationText}`);
      lines.push(`時間：${[dates, hours].filter(Boolean).join(' · ')}`);
      lines.push(`費用：${[price, ver].filter(Boolean).join(' · ')}`);
    } else if (lang === 'zh-Hans') {
      lines.push(`地点：${locationText}`);
      lines.push(`时间：${[dates, hours].filter(Boolean).join(' · ')}`);
      lines.push(`费用：${[price, ver].filter(Boolean).join(' · ')}`);
    } else {
      lines.push(`Where: ${locationText}`);
      lines.push(`When: ${[dates, hours].filter(Boolean).join(' · ')}`);
      lines.push(`Entry: ${[price, ver].filter(Boolean).join(' · ')}`);
    }
    if (excerpt) lines.push(excerpt);
    lines.push(`${baseUrl}/p/${item.slug}`);
    if (sourceUrl) {
      if (lang === 'zh-Hant') lines.push(`官方來源： ${sourceUrl}`);
      else if (lang === 'zh-Hans') lines.push(`官方来源： ${sourceUrl}`);
      else lines.push(`Source: ${sourceUrl}`);
    }
  }

  return sanitizeMobileLinks(lines.join('\n'));
}

async function discoverGroupRooms(env: Bindings): Promise<string[]> {
  const rooms = new Set<string>();

  if (env.NARRA_SYNC_DO) {
    try {
      const stub = env.NARRA_SYNC_DO.get(env.NARRA_SYNC_DO.idFromName('narra'));
      const res = await stub.fetch('https://narra-sync/status');
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { roomIds?: unknown } | null;
        const roomIds = Array.isArray(body?.roomIds)
          ? body.roomIds.filter((id): id is string => typeof id === 'string' && id.startsWith('!'))
          : [];
        for (const roomId of roomIds) {
          if (env.NARRA_ROOM_DO) {
            try {
              const roomStub = env.NARRA_ROOM_DO.get(env.NARRA_ROOM_DO.idFromName(roomId));
              const roomRes = await roomStub.fetch('https://narra-room/status');
              if (roomRes.ok) {
                const meta = (await roomRes.json().catch(() => null)) as { chatType?: string | null } | null;
                if (meta?.chatType === 'dm') continue;
              }
            } catch {
              // Keep room if room DO check is unavailable.
            }
          }
          rooms.add(roomId);
        }
      }
    } catch {
      // Ignore unreachable sync DO.
    }
  }

  if (env.DB) {
    try {
      const { results } = await env.DB.prepare(
        'SELECT DISTINCT room_id FROM narra_room_memory WHERE agent_id = ? LIMIT 50',
      )
        .bind(SPOTTED_AGENT_SPEC.id)
        .all<{ room_id: string }>();
      for (const row of results ?? []) {
        if (row.room_id?.startsWith('!')) rooms.add(row.room_id);
      }
    } catch {
      // Memory table is created lazily on first enabled message.
    }
  }

  if (rooms.size === 0 && (env.NARRA_AGENT_TOKEN ?? '').trim()) {
    try {
      const endpoint = (env.NARRA_API_ENDPOINT ?? DEFAULT_NARRA_ENDPOINT).replace(/\/+$/, '');
      const res = await fetch(`${endpoint}/api/agent-runtime/chat/rooms?conversation_type=group`, {
        headers: { authorization: `Bearer ${env.NARRA_AGENT_TOKEN!.trim()}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        const data = (
          body && typeof body.data === 'object' && body.data ? body.data : body
        ) as Record<string, unknown> | null;
        const list = Array.isArray(data?.rooms) ? (data.rooms as Array<Record<string, unknown>>) : [];
        for (const entry of list) {
          if (typeof entry.room_id === 'string' && entry.room_id.startsWith('!')) {
            rooms.add(entry.room_id);
          }
        }
      }
    } catch {
      // Non-fatal fallback.
    }
  }

  return [...rooms];
}

export async function queryVerifiedUpcomingPopups(
  env: Pick<Bindings, 'DB'>,
  sinceIso: string,
  nowMs = Date.now(),
): Promise<PublicPopup[]> {
  if (!env.DB) return [];
  const parsedSince = Date.parse(sinceIso);
  const cutoff = Number.isFinite(parsedSince) ? Math.max(0, parsedSince - UPDATE_LOOKBACK_MS) : 0;

  try {
    const { results } = await env.DB.prepare(
      `SELECT *, (SELECT COALESCE(i.thumb_key, i.r2_key) FROM popup_images i WHERE i.popup_id = popups.id ORDER BY position LIMIT 1) AS cover_key,
          ${SOURCE_CHECKED_SQL}
       FROM popups
       WHERE status IN ('verified_admin', 'verified_community')
         AND is_example = 0
         AND end_at > ?
         AND updated_at >= ?
       ORDER BY updated_at DESC, hot DESC
       LIMIT 3`,
    )
      .bind(nowMs, cutoff)
      .all<PopupRow & { cover_key?: string | null; source_checked?: number | null }>();

    return (results ?? []).map((row) => toPublic(row));
  } catch {
    return [];
  }
}

export async function fetchSpottedUpdates(
  env: Bindings,
  sinceIso: string,
): Promise<AgentUpdateItem[]> {
  const nowMs = Date.now();
  const popups = await queryVerifiedUpcomingPopups(env, sinceIso, nowMs);
  if (popups.length === 0) return [];

  const rooms = await discoverGroupRooms(env);
  if (rooms.length === 0) return [];

  const text = formatPopupsReply(popups, 'en', appBase(env), { isUpdateDigest: true });
  const updateKey = `popups:${popups.map((p) => p.id).sort().join(',')}`;

  return rooms.map((roomId) => ({
    updateKey,
    roomId,
    chatType: 'group',
    title: 'Spotted London verified pop-ups',
    text,
    lang: 'en',
    createdAt: new Date(nowMs).toISOString(),
  }));
}

const BARE_GREETING_RE =
  /^(?:hi|hello|hey|yo|good\s*(?:morning|afternoon|evening)|早安|早上好|你好|您好|哈囉|哈啰|嗨|在嗎|在吗|你是誰|你是谁|who\s+are\s+you)[!！?？。\s]*$/i;

const CAPABILITY_QUERY_RE =
  /^(?:請問|请问)?(?:你(?:能|可以)(?:幫我|帮我)?(?:查|做)(?:什麼|什么|哪些)(?:呢|嗎|吗)?|what\s+can\s+you\s+(?:do|help(?:\s+(?:me\s+)?with)?|find))[!！?？。\s]*$/i;

const THANKS_RE =
  /^(?:(?:好的|ok|okay)[,，!！.\s]*)?(?:(?:非常|真的|太|很)?(?:謝謝|谢谢|謝啦|谢啦|感謝|感谢|多謝|多谢)(?:你|您)?(?:啦|喔|哦|呀)?|thanks?(?:\s+(?:a\s+lot|so\s+much))?|thank\s+you(?:\s+(?:so\s+much|very\s+much))?|thx|tysm|cheers)[!！。.?？~～\s]*$/i;

const DM_OFF_TOPIC_RE =
  /比特幣|比特币|\bbitcoin\b|\bbtc\b|以太幣|以太坊|\bethereum\b|股價|股价|匯率|汇率|股票|股市|財經|财经|外匯|外汇|\bstock\s+price\b|\bcrypto(?:currency)?\b|\bexchange\s+rate\b|天氣|天气|會下雨|会下雨|下不下雨|\bweather(?:\s+forecast)?\b|\bwill\s+it\s+rain\b|塔羅|塔罗|求籤|求签|抽籤|抽签|算命|占卜|\btarot\b|\bfortune\s+stick\b|食譜|食谱|怎麼煮|怎么煮|怎麼炒|怎么炒|寫程式|写程式|寫代碼|写代码|寫程式碼|写程序|\brecipes?\b|\bhow\s+to\s+cook\b|\b(?:python|javascript|typescript|coding|debug)\b|\bwrite\s+(?:a\s+)?(?:code|script|function|program)\b/i;

const COMPLEX_FOLLOWUP_RE =
  /remember|forget|記得|记得|忘掉|忘記|忘记|how\s+(?:do|to)\s+get|tube|bus|station|walk|from\s+|which\s+one|better\s+for|date\s+night|compare|為什麼|为什么|怎麼去|怎么去|坐地鐵|坐地铁|哪一個更好|哪一个更好/i;

const COMPARATIVE_FOLLOWUP_RE =
  /(?:這幾個|这几个|這幾間|这几间|裡面哪一?[個个]|里面哪一?[个]|哪一?[個个]最(?:適合|适合|推薦|推荐|好|值得)|比較適合|比较适合|適不適合|适不适合|帶朋友去拍照|带朋友去拍照|怎麼搭地鐵|怎么搭地铁|坐什麼地鐵|坐什么地铁|\b(?:which\s+(?:one\s+)?is\s+(?:best|better|most\s+suitable)|compare\s+(?:them|these)|how\s+(?:do\s+(?:i|we)|to)\s+get\s+there)\b)/i;

const DETAIL_FOLLOWUP_RE =
  /細節|细节|詳細|详细|更多|詳情|详情|地址|時間|时间|門票|门票|預約|预约|訂票|订票|在哪[裡里]?|\b(?:more\s+(?:details?|info)|details?|address|hours?|timing|tickets?|book(?:ing)?|reserv(?:e|ation)|where\s+is\s+it|tell\s+me\s+more)\b/i;

const BOOKING_FOLLOWUP_RE = /預約|预约|訂票|订票|\b(?:book(?:ing)?|reserv(?:e|ation))\b/i;
const LIST_ORDINAL_RE = /第\s*([一二三四五1-5])\s*[個个項项場场]|\b(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|[45]th)\s+(?:one|event|option)\b/i;
const LIST_ORDINAL_INDEX: Record<string, number> = {
  一: 0, 二: 1, 三: 2, 四: 3, 五: 4, '1': 0, '2': 1, '3': 2, '4': 3, '5': 4,
  first: 0, second: 1, third: 2, fourth: 3, fifth: 4, '1st': 0, '2nd': 1, '3rd': 2, '4th': 3, '5th': 4,
};

function formatBookingReply(item: PublicPopup, lang: LangCode, baseUrl: string): string {
  const ticketed = /\bticketed\b|憑票|凭票/.test(item.price?.text?.toLowerCase() ?? '');
  const guidance = lang === 'zh-Hant'
    ? `${ticketed ? '活動標示為憑票入場。' : ''}是否需要提前預約，請看主辦方最新資訊。`
    : lang === 'zh-Hans'
      ? `${ticketed ? '活动标注为凭票入场。' : ''}是否需要提前预约，请查看主办方最新信息。`
      : `${ticketed ? 'Entry is listed as ticketed. ' : ''}Check the organiser’s latest information to see if you need to book ahead.`;
  return sanitizeMobileLinks([item.title, guidance, validHttpsUrl(item.source_url) ?? `${baseUrl}/p/${item.slug}`].join('\n'));
}

const REQUESTED_LIMIT_ZH_RE = /(?:各)?(?:推|推薦|推荐|給|给|挑|找|來|来)\s*([1-5一二兩两三四五])\s*[間家個个]/;
const REQUESTED_LIMIT_EN_RE = /\b(?:just|only|pick|top)\s+([1-5]|one|two|three|four|five)\b/i;

const REQUESTED_LIMIT_MAP: Record<string, number> = {
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  一: 1,
  二: 2,
  兩: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

export function parseRequestedLimit(text: string): number | null {
  const input = (text ?? '').trim();
  if (!input) return null;
  const zhMatch = input.match(REQUESTED_LIMIT_ZH_RE);
  if (zhMatch?.[1]) {
    const val = REQUESTED_LIMIT_MAP[zhMatch[1]];
    if (val) return Math.max(1, Math.min(5, val));
  }
  const enMatch = input.match(REQUESTED_LIMIT_EN_RE);
  if (enMatch?.[1]) {
    const val = REQUESTED_LIMIT_MAP[enMatch[1].toLowerCase()];
    if (val) return Math.max(1, Math.min(5, val));
  }
  return null;
}

const CJK_CHAR_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const escapeKeywordRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hasSpecKeywordHit(text: string, keywords?: Array<string | RegExp>): boolean {
  const normalized = (text ?? '').normalize('NFKC').trim();
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  for (const kw of keywords ?? []) {
    if (kw instanceof RegExp) {
      if (kw.test(normalized)) return true;
      continue;
    }
    const needle = kw.normalize('NFKC').trim().toLowerCase();
    if (!needle) continue;
    if (CJK_CHAR_RE.test(needle)) {
      if (lower.includes(needle)) return true;
    } else if (new RegExp(`(?<![a-z0-9])${escapeKeywordRegex(needle)}(?![a-z0-9])`, 'i').test(normalized)) {
      return true;
    }
  }
  return false;
}

const CATEGORY_HINTS: Array<{ category: Category; pattern: RegExp }> = [
  { category: 'food', pattern: /\b(?:food|street\s*food|coffee|bakery|matcha|pastry|dessert|drink)\b|美食|小吃|甜點|甜点|咖啡|烘焙/i },
  { category: 'dining', pattern: /\b(?:dining|supper\s*club|residency|tasting\s*menu)\b|私房菜|快閃餐廳|快闪餐厅|晚餐聚會|晚餐聚会/i },
  { category: 'market', pattern: /\b(?:market|markets|fair|fairs)\b|市集|集市/i },
  { category: 'exhibition', pattern: /\b(?:exhibition|exhibitions|gallery|museum)\b|展覽|展览|看展|藝術展|艺术展|畫展|画展|攝影展|摄影展|美展|特展|免費展|免费展/i },
  { category: 'art', pattern: /\b(?:art|installation)\b|藝術|艺术|畫廊|画廊/i },
  { category: 'fashion', pattern: /\b(?:fashion|clothing|archive)\b|時尚|时尚|服飾|服饰|潮牌/i },
  { category: 'sample', pattern: /\b(?:sample\s*sale|sample)\b|特賣|特卖|樣品|样品|折扣/i },
  { category: 'beauty', pattern: /\b(?:beauty|skincare|makeup|fragrance|perfume)\b|美妝|美妆|護膚|护肤|香水/i },
  { category: 'tech', pattern: /\b(?:tech|hardware|gadget)\b|科技/i },
  { category: 'event', pattern: /\b(?:event|events|festival)\b|活動|活动|派對|派对/i },
];

const LONDON_AREAS = [
  'Soho',
  'Shoreditch',
  'Hackney',
  'Camden',
  'Covent Garden',
  'Mayfair',
  'Marylebone',
  'Brixton',
  'Dalston',
  'Notting Hill',
  'Chelsea',
  'Kensington',
  'Greenwich',
  'Peckham',
  'Stratford',
  'Canary Wharf',
  'Islington',
  'Fitzrovia',
  'Bermondsey',
  'Westminster',
  'Southwark',
  'Tower Hamlets',
  "King's Cross",
  'Kings Cross',
  'Coal Drops Yard',
  'Euston',
  'Holborn',
  'Waterloo',
  'Southbank',
  'London Bridge',
  'Borough',
  'Angel',
  'Brick Lane',
  'Clerkenwell',
  'Spitalfields',
  'Battersea',
];

const TAG_HINTS: Array<{ tag: string; pattern: RegExp }> = [
  { tag: 'outdoors', pattern: /\b(?:outdoors?|outside)\b|戶外|户外|露天/i },
  { tag: 'family', pattern: /\b(?:family|kids|children)\b|親子|亲子|帶娃|带娃|小孩/i },
  { tag: 'dog_friendly', pattern: /\b(?:dog|dogs|pet)\b|狗|寵物|宠物/i },
  { tag: 'vegan', pattern: /\bvegan\b|素食|純素|纯素/i },
  { tag: 'live_music', pattern: /\blive\s*music\b|現場音樂|现场音乐/i },
  { tag: 'late_night', pattern: /\blate\s*night\b|深夜|夜晚/i },
  { tag: 'tasting', pattern: /\btasting\b|試吃|试吃|品鑑|品鉴/i },
  { tag: 'vintage', pattern: /\bvintage\b|復古|复古|古著|古着/i },
  { tag: 'immersive', pattern: /\bimmersive\b|沉浸/i },
  { tag: 'freebies', pattern: /\bfreebies?\b|免費贈品|免费赠品|小樣|小样/i },
];

export interface PopupQueryFilter {
  when: 'today' | 'weekend' | 'week' | 'all';
  category?: string;
  tag?: string;
  free?: '1';
  verified?: '1';
  borough?: string;
  q?: string;
  isClearSearch: boolean;
}

const TIME_ONLY_FOLLOWUP_RE =
  /^(?:(?:那|只要|只看|只找|有沒有|有没有|那就)?\s*(?:這?週末|这?周末|週六|周六|週日|周日|今天|今晚|明天)(?:的)?(?:呢|嗎|吗)?|(?:what\s+about\s+|how\s+about\s+|only\s+|just\s+)(?:the\s+|this\s+)?(?:weekend|saturday|sunday|today|tonight|tomorrow)(?:\s+ones?)?)[？?。.!！]*$/i;

const TIME_TODAY_RE = /\b(?:today|tonight)\b|今天|今晚|今日/i;
const TIME_WEEKEND_RE =
  /\b(?:weekend|sat(?:urday)?|sun(?:day)?)\b|這?週末|这?周末|週六|周六|週日|周日|禮拜六|礼拜六/i;
const TIME_WEEK_RE = /\b(?:this\s+week|upcoming)\b|這週|这周|本週|本周|最近|近期/i;
const POPUP_ACTIVITY_RE =
  /\b(?:what'?s\s+on|anything\s+(?:fun|on)|pop[- ]?ups?)\b|快閃|快闪|市集|展覽|展览|看展|藝術展|艺术展|畫展|画展|攝影展|摄影展|美展|特展|免費展|免费展|活動|活动|特賣|特卖|期間限定|期间限定|有什麼好玩的|有什么好玩的|逛逛|逛一逛|好去處|好去处|去哪逛|哪裡逛|哪里逛/i;

export function extractPopupQueryFilter(rawText: string): PopupQueryFilter {
  const text = stripAgentMentions(rawText ?? '', [...ALL_KNOWN_MENTION_NAMES]);

  let when: PopupQueryFilter['when'] = 'week';
  let hasSignal = false;

  if (TIME_TODAY_RE.test(text)) {
    when = 'today';
  } else if (TIME_WEEKEND_RE.test(text)) {
    when = 'weekend';
  } else if (TIME_WEEK_RE.test(text)) {
    when = 'week';
  }

  if (POPUP_ACTIVITY_RE.test(text) || LONDON_OUTING_RE.test(text)) {
    hasSignal = true;
  }

  let free: '1' | undefined;
  if (/\bfree\b|免費|免费|不要錢|不要钱/i.test(text)) {
    free = '1';
    hasSignal = true;
  }

  let verified: '1' | undefined;
  if (/\b(?:verified|confirmed)\b|已驗證|已验证|確認過|确认过/i.test(text)) {
    verified = '1';
    hasSignal = true;
  }

  const matchedCats = CATEGORY_HINTS.filter((h) => h.pattern.test(text)).map((h) => h.category);
  const category = matchedCats.length > 0 ? [...new Set(matchedCats)].join(',') : undefined;
  if (category) hasSignal = true;

  const matchedTags = TAG_HINTS.filter((h) => h.pattern.test(text)).map((h) => h.tag);
  const tag = matchedTags.length > 0 ? matchedTags[0] : undefined;
  if (tag) hasSignal = true;

  const lower = text.toLowerCase();
  const area = LONDON_AREAS.find((a) => lower.includes(a.toLowerCase()));
  if (area) hasSignal = true;

  return {
    when,
    ...(category ? { category } : {}),
    ...(tag ? { tag } : {}),
    ...(free ? { free } : {}),
    ...(verified ? { verified } : {}),
    ...(area ? { q: area } : {}),
    isClearSearch: hasSignal,
  };
}

async function tryAiExtractFilter(env: Bindings, text: string): Promise<Partial<PopupQueryFilter> | null> {
  if (!env.AI || typeof (env.AI as { run?: unknown }).run !== 'function') return null;
  try {
    const model = (env.AI_TEXT_MODEL ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast') as keyof AiModels;
    const res = (await (env.AI as Ai).run(model, {
      messages: [
        {
          role: 'system',
          content:
            'Extract JSON filter from a London pop-up query: {"isPopupQuery":boolean,"when":"today|weekend|week|all","category":"optional one of ' +
            CATEGORIES.join(',') +
            '","free":boolean,"q":"optional neighborhood/keyword"}. Set isPopupQuery=false for casual chatter or unrelated topics. Reply JSON only.',
        },
        { role: 'user', content: text.slice(0, 300) },
      ],
      max_tokens: 120,
    })) as { response?: unknown };

    const raw = typeof res?.response === 'string' ? res.response : JSON.stringify(res?.response ?? '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (parsed.isPopupQuery === false) return null;
    const when =
      parsed.when === 'today' || parsed.when === 'weekend' || parsed.when === 'week' || parsed.when === 'all'
        ? parsed.when
        : 'week';
    const cat =
      typeof parsed.category === 'string' && (CATEGORIES as readonly string[]).includes(parsed.category)
        ? parsed.category
        : undefined;
    const q = typeof parsed.q === 'string' && parsed.q.trim() ? parsed.q.trim().slice(0, 60) : undefined;
    if (!cat && parsed.free !== true && !q && parsed.isPopupQuery !== true) return null;
    return {
      when,
      ...(cat ? { category: cat } : {}),
      ...(parsed.free === true ? { free: '1' } : {}),
      ...(q ? { q } : {}),
    };
  } catch {
    // AI binding may be unmocked in local tests or unavailable; fall back seamlessly.
    return null;
  }
}

export async function resolveSpottedA2ACredential(
  env: Bindings,
): Promise<NarraA2ACredentialResult | null> {
  const directUrl = (env.MANYFOLD_A2A_URL ?? '').trim();
  const directToken = (env.MANYFOLD_A2A_TOKEN ?? '').trim();
  if (directUrl && directToken) {
    return { url: directUrl, token: directToken, label: SPOTTED_AGENT_SPEC.name };
  }

  if (!env.DB || !env.AGENTS_KEY || env.AGENTS_KEY.length < 32) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT id, name, rpc_url, token_sealed
       FROM agents
       WHERE enabled = 1
         AND rpc_url IS NOT NULL
         AND token_sealed IS NOT NULL
         AND (role = 'concierge' OR lower(id) LIKE '%spotted%' OR lower(name) LIKE '%spotted%')
       ORDER BY CASE WHEN lower(id) LIKE '%spotted%' OR lower(name) LIKE '%spotted%' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
    ).first<{ id: string; name: string; rpc_url: string; token_sealed: string }>();

    if (!row?.rpc_url || !row.token_sealed) return null;
    const token = await unseal(env.AGENTS_KEY, row.token_sealed);
    return { url: row.rpc_url, token, label: row.name || SPOTTED_AGENT_SPEC.name };
  } catch {
    return null;
  }
}

/** Localized intro line when a pop-up search returns results only after relaxing filters. */
function relaxedFilterIntro(
  kind: 'dropArea' | 'dropFilters',
  area: string,
  lang: LangCode,
): string {
  if (kind === 'dropArea') {
    if (lang === 'zh-Hant') return `${area} 暫時沒有完全符合條件的活動，以下是倫敦其他區域符合條件的快閃精選：`;
    if (lang === 'zh-Hans') return `${area} 暂时没有完全符合条件的活动，以下是伦敦其他区域符合条件的快闪精选：`;
    return `No exact match in ${area} right now — here are matching London pop-ups nearby:`;
  }
  if (lang === 'zh-Hant') return `${area} 暫時沒有完全符合全部篩選條件的活動，但 ${area} 附近還有這些快閃可以逛：`;
  if (lang === 'zh-Hans') return `${area} 暂时没有完全符合全部筛选条件的活动，但 ${area} 附近还有这些快闪可以逛：`;
  return `No exact match for every filter in ${area}, but here is what else is on around ${area}:`;
}

export function spottedThanksReply(lang: LangCode): string {
  if (lang === 'zh-Hant') return '不客氣！有想找倫敦哪一區或這週末的快閃活動、市集或展覽，隨時問我。';
  if (lang === 'zh-Hans') return '不客气！有想找伦敦哪一区或这周末的快闪活动、市集或展览，随时问我。';
  return "You're welcome! Ask anytime if you'd like to find London pop-ups, markets, or exhibitions.";
}

export function spottedOffTopicRedirect(lang: LangCode): string {
  if (lang === 'zh-Hant') {
    return '我主要是幫你找倫敦的快閃活動、市集、展覽與免費好去處，這題比較不在我的專長範圍喔！想看看這週末倫敦有什麼好玩活動嗎？';
  }
  if (lang === 'zh-Hans') {
    return '我主要是帮你找伦敦的快闪活动、市集、展览与免费好去处，这题比较不在我的专长范围哦！想看看这周末伦敦有什么好玩活动吗？';
  }
  return "I focus on London pop-ups, markets, exhibitions, and free things to do — that one is outside my lane! Want to see what's on around London this weekend?";
}

export async function fastRespondSpotted(
  env: Bindings,
  event: InboundEvent,
  decision: TriageDecision,
  _memories: RecallTurnResult,
  context?: RoomContext,
): Promise<string | null> {
  if (!env.DB) return null;
  const cleanText = stripAgentMentions(event.text ?? '', [...ALL_KNOWN_MENTION_NAMES]);
  if (COMPLEX_FOLLOWUP_RE.test(cleanText)) return null;

  const isUnmentionedGroup =
    event.chatType === 'group' &&
    decision.reason !== 'dm' &&
    decision.reason !== 'explicit_mention' &&
    decision.reason !== 'multi_mention_domain_match' &&
    decision.reason !== 'reply_to_self';

  if (isUnmentionedGroup) {
    if (TIME_ONLY_FOLLOWUP_RE.test(cleanText.trim())) {
      const previous = context?.recentHistory
        .filter((turn) => turn.eventId !== event.eventId && turn.timestampMs <= event.timestampMs)
        .reduce<(typeof context.recentHistory)[number] | undefined>(
          (latest, turn) => !latest || turn.timestampMs >= latest.timestampMs ? turn : latest,
          undefined,
        );
      if (previous?.isAgent && !previous.isSelf && previous.senderId !== SPOTTED_MATRIX_ID) {
        return '[NO_REPLY]';
      }
    }
    const hasAntiHit = hasSpecKeywordHit(cleanText, SPOTTED_AGENT_SPEC.antiKeywords);
    const hasDomainHit = hasSpecKeywordHit(cleanText, SPOTTED_AGENT_SPEC.domainKeywords);
    if (hasAntiHit && !hasDomainHit) return '[NO_REPLY]';
    if (
      BARE_GREETING_RE.test(cleanText) ||
      (decision.reason === 'active_session' &&
        (THANKS_RE.test(cleanText) || CAPABILITY_QUERY_RE.test(cleanText)))
    ) {
      return '[NO_REPLY]';
    }
  }

  const lang = decision.detectedLang;
  const nowMs = Date.now();
  const baseUrl = appBase(env);

  if (
    !isUnmentionedGroup &&
    (event.chatType === 'dm' ||
      decision.reason === 'dm' ||
      decision.reason === 'explicit_mention' ||
      decision.reason === 'reply_to_self') &&
    THANKS_RE.test(cleanText)
  ) {
    return spottedThanksReply(lang);
  }

  if (
    (event.chatType === 'dm' || decision.reason === 'dm' || decision.reason === 'explicit_mention') &&
    (!cleanText || BARE_GREETING_RE.test(cleanText) || CAPABILITY_QUERY_RE.test(cleanText))
  ) {
    const list = await listPopups(env.DB, { when: 'weekend', limit: '5' }, nowMs).catch(() => null);
    const real = (list?.items ?? []).filter((i) => !i.example);
    const fallbackList =
      real.length > 0
        ? real
        : ((await listPopups(env.DB, { when: 'week', limit: '5' }, nowMs).catch(() => null))?.items ?? []).filter(
            (i) => !i.example,
          );
    if (fallbackList.length === 0) {
      if (event.isVoice) {
        if (lang === 'zh-Hant') return '你好！我是 Spotted London，想找倫敦這週末的快閃活動、市集或展覽嗎？跟我說區域或想逛的類型就行。';
        if (lang === 'zh-Hans') return '你好！我是 Spotted London，想找伦敦这周末的快闪活动、市集或展览吗？跟我说区域或想逛的类型就行。';
        return 'Hi! I am Spotted London. Ask me about pop-ups, markets, or exhibitions in any London neighbourhood.';
      }
      if (lang === 'zh-Hant') {
        return sanitizeMobileLinks(`你好！我是 Spotted London，想找倫敦哪一區或這週末的快閃活動、市集、展覽？也可以逛逛清單： ${baseUrl}`);
      }
      if (lang === 'zh-Hans') {
        return sanitizeMobileLinks(`你好！我是 Spotted London，想找伦敦哪一区或这周末的快闪活动、市集、展览？也可以逛逛列表： ${baseUrl}`);
      }
      return sanitizeMobileLinks(`Hi! I am Spotted London. Ask me about London pop-ups, markets, or exhibitions, or browse all listings here: ${baseUrl}`);
    }

    const intro =
      lang === 'zh-Hant'
        ? '你好！這幾天倫敦有幾個不錯的快閃活動，看看有沒有你想去的：'
        : lang === 'zh-Hans'
          ? '你好！这几天伦敦有几个不错的快闪活动，看看有没有你想去的：'
          : 'Hi! Here are a few London pop-ups worth checking out right now:';
    return formatPopupsReply(fallbackList, lang, baseUrl, {
      voice: Boolean(event.isVoice),
      intro,
    });
  }

  const priorSelfSlugs = extractPriorSelfPopupSlugs(context, 5);
  if (
    (!isUnmentionedGroup || decision.reason === 'active_session') &&
    (COMPLEX_FOLLOWUP_RE.test(cleanText) || COMPARATIVE_FOLLOWUP_RE.test(cleanText)) &&
    priorSelfSlugs.length > 0
  ) {
    return null;
  }

  if (
    (['dm', 'reply_to_self', 'explicit_mention', 'active_session'].includes(decision.reason) ||
      event.chatType === 'dm') &&
    DETAIL_FOLLOWUP_RE.test(cleanText) &&
    !COMPLEX_FOLLOWUP_RE.test(cleanText) &&
    !COMPARATIVE_FOLLOWUP_RE.test(cleanText)
  ) {
    const ordinalMatch = LIST_ORDINAL_RE.exec(cleanText);
    const ordinal = (ordinalMatch?.[1] ?? ordinalMatch?.[2])?.toLowerCase();
    if (ordinal && priorSelfSlugs.length > 0 && !priorSelfSlugs[LIST_ORDINAL_INDEX[ordinal]]) {
      return lang === 'zh-Hant' ? '我剛才的清單沒有這一項。你指的是哪個活動？'
        : lang === 'zh-Hans' ? '我刚才的列表没有这一项。你指的是哪个活动？'
          : 'That number isn’t in my last list. Which event did you mean?';
    }
    const slugs = ordinal
      ? priorSelfSlugs.slice(LIST_ORDINAL_INDEX[ordinal], LIST_ORDINAL_INDEX[ordinal] + 1)
      : priorSelfSlugs.slice(0, 3);
    if (slugs.length > 0) {
      try {
        const placeholders = slugs.map(() => '?').join(', ');
        const { results } = await env.DB.prepare(
          `SELECT *, (SELECT COALESCE(i.thumb_key, i.r2_key) FROM popup_images i WHERE i.popup_id = popups.id ORDER BY position LIMIT 1) AS cover_key,
              ${SOURCE_CHECKED_SQL}
           FROM popups
           WHERE slug IN (${placeholders})
             AND is_example = 0
           LIMIT 3`,
        )
          .bind(...slugs)
          .all<PopupRow & { cover_key?: string | null; source_checked?: number | null }>();
        const rows = [...(results ?? [])].sort((a, b) => slugs.indexOf(a.slug) - slugs.indexOf(b.slug));
        if (rows.length > 0) {
          const items = rows.map((row) => toPublic(row));
          if (items.length === 1 && BOOKING_FOLLOWUP_RE.test(cleanText)) {
            return formatBookingReply(items[0]!, lang, baseUrl);
          }
          return formatPopupDetailsReply(items, lang, baseUrl, {
            voice: Boolean(event.isVoice),
          });
        }
      } catch {
        // Fall through to query / A2A if detail lookup fails unexpectedly.
      }
    }
  }

  let filter = extractPopupQueryFilter(cleanText);
  const isDm = event.chatType === 'dm' || decision.reason === 'dm';
  if (
    isDm &&
    (DM_OFF_TOPIC_RE.test(cleanText) || hasSpecKeywordHit(cleanText, SPOTTED_AGENT_SPEC.antiKeywords)) &&
    !POPUP_ACTIVITY_RE.test(cleanText) &&
    !LONDON_OUTING_RE.test(cleanText) &&
    !filter.category &&
    !filter.tag
  ) {
    return spottedOffTopicRedirect(lang);
  }
  if (
    isUnmentionedGroup &&
    filter.isClearSearch &&
    !POPUP_ACTIVITY_RE.test(cleanText) &&
    !LONDON_OUTING_RE.test(cleanText) &&
    !filter.category &&
    !filter.tag &&
    !filter.free &&
    !filter.verified
  ) {
    filter = { ...filter, isClearSearch: false };
  }
  if (!filter.isClearSearch) {
    if (isUnmentionedGroup && decision.reason === 'active_session') {
      return '[NO_REPLY]';
    }
    const aiExtracted = await tryAiExtractFilter(env, cleanText);
    if (!aiExtracted) {
      return isUnmentionedGroup ? '[NO_REPLY]' : null;
    }
    filter = {
      when: aiExtracted.when ?? 'week',
      category: aiExtracted.category,
      free: aiExtracted.free,
      q: aiExtracted.q,
      isClearSearch: true,
    };
  }

  const queryParams: Record<string, string> = {
    when: filter.when,
    limit: '10',
    ...(filter.category ? { category: filter.category } : {}),
    ...(filter.tag ? { tag: filter.tag } : {}),
    ...(filter.free ? { free: filter.free } : {}),
    ...(filter.verified ? { verified: filter.verified } : {}),
    ...(filter.q ? { q: filter.q } : {}),
  };

  let items: PublicPopup[] = [];
  let relaxedIntro: string | undefined;
  const queryNonExamplePopups = async (params: Record<string, string>): Promise<PublicPopup[]> => {
    const result = await listPopups(env.DB, params, nowMs);
    return result.items.filter((i) => !i.example);
  };
  try {
    items = await queryNonExamplePopups(queryParams);
    if (items.length === 0 && filter.q && (filter.category || filter.free)) {
      items = await queryNonExamplePopups({
        when: filter.when,
        limit: '10',
        ...(filter.category ? { category: filter.category } : {}),
        ...(filter.free ? { free: filter.free } : {}),
      });
      if (items.length > 0) {
        relaxedIntro = relaxedFilterIntro('dropArea', filter.q, lang);
      }
    }
    if (items.length === 0 && filter.q) {
      const bWhen = filter.when === 'today' ? 'week' : filter.when;
      items = await queryNonExamplePopups({
        when: bWhen,
        limit: '10',
        q: filter.q,
      });
      if (items.length === 0 && bWhen !== 'week') {
        items = await queryNonExamplePopups({
          when: 'week',
          limit: '10',
          q: filter.q,
        });
      }
      if (items.length > 0) {
        relaxedIntro = relaxedFilterIntro('dropFilters', filter.q, lang);
      }
    }
    if (items.length === 0 && filter.when !== 'week' && !filter.q && !filter.category) {
      items = await queryNonExamplePopups({ ...queryParams, when: 'week' });
    }
  } catch {
    return null;
  }

  if (items.length > 0) {
    const requestedLimit = parseRequestedLimit(cleanText);
    const displayItems = requestedLimit !== null ? items.slice(0, requestedLimit) : items;
    return formatPopupsReply(displayItems, lang, baseUrl, {
      voice: Boolean(event.isVoice),
      ...(requestedLimit !== null ? { maxItems: requestedLimit } : {}),
      ...(relaxedIntro ? { intro: relaxedIntro } : {}),
    });
  }

  // If A2A is configured, fall back so Concierge can widen search with geo/fuzzy tools.
  const hasA2A = await resolveSpottedA2ACredential(env);
  if (hasA2A) return null;

  if (isUnmentionedGroup) return '[NO_REPLY]';

  if (event.isVoice) {
    if (lang === 'zh-Hant') return '目前資料庫裡暫時沒有完全符合這個條件的倫敦快閃活動，要試試換個區域或看這週末的精選嗎？';
    if (lang === 'zh-Hans') return '目前数据库里暂时没有完全符合这个条件的伦敦快闪活动，要试试换个区域或看这周末的精选吗？';
    return 'I could not find an exact match in Spotted London right now. Would you like to try a different area or hear this weekend highlights?';
  }

  if (lang === 'zh-Hant') {
    return `暫時沒有找到完全符合條件的倫敦快閃活動，可以到這裡逛逛全部清單： ${baseUrl}`;
  }
  if (lang === 'zh-Hans') {
    return `暂时没有找到完全符合条件的伦敦快闪活动，可以到这里逛逛全部列表： ${baseUrl}`;
  }
  return `No exact matches on Spotted London right now. Browse all upcoming pop-ups here: ${baseUrl}`;
}

const MAX_PREFETCH_CHARS = 1_400;

function formatPrefetchedPopup(item: PublicPopup, lang: LangCode, baseUrl: string): string {
  const area = item.location.borough?.trim() || '';
  const addr = item.location.address?.trim() || '';
  const dates = formatPopupDates(item, lang);
  const hours = item.hours_text?.trim() || '';
  const price = priceLabel(item.price?.type, item.price?.text, lang);
  const excerpt = excerptDescription(item.description, 160);
  const officialUrl = validHttpsUrl(item.source_url);
  const pageUrl = `${baseUrl}/p/${item.slug}`;

  return [
    `[${item.slug}] ${item.title}`,
    area ? `Area: ${area}` : '',
    addr ? `Address: ${addr}` : '',
    dates ? `Dates: ${dates}` : '',
    hours ? `Hours: ${hours}` : '',
    price ? `Price: ${price}` : '',
    excerpt ? `Info: ${excerpt}` : '',
    `Page: ${pageUrl}`,
    officialUrl ? `Official: ${officialUrl}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

export async function buildSpottedExtraEnvelopeFields(
  env: Bindings,
  _event: InboundEvent,
  decision: TriageDecision,
  _memories: RecallTurnResult,
  context: RoomContext,
): Promise<Record<string, string> | null> {
  if (!env.DB) return null;

  const replySlugs = context?.replyToTarget?.text
    ? extractPopupSlugs(context.replyToTarget.text)
    : [];
  const slugs = replySlugs.length > 0 ? replySlugs : extractPriorSelfPopupSlugs(context);

  let items: PublicPopup[] = [];
  if (slugs.length > 0) {
    try {
      const placeholders = slugs.map(() => '?').join(', ');
      const { results } = await env.DB.prepare(
        `SELECT *, (SELECT COALESCE(i.thumb_key, i.r2_key) FROM popup_images i WHERE i.popup_id = popups.id ORDER BY position LIMIT 1) AS cover_key,
            ${SOURCE_CHECKED_SQL}
         FROM popups
         WHERE slug IN (${placeholders})
           AND is_example = 0
         LIMIT 3`,
      )
        .bind(...slugs)
        .all<PopupRow & { cover_key?: string | null; source_checked?: number | null }>();
      const sorted = [...(results ?? [])].sort((a, b) => slugs.indexOf(a.slug) - slugs.indexOf(b.slug));
      items = sorted.map((r) => toPublic(r));
    } catch {
      items = [];
    }
  }

  if (items.length === 0) {
    const weekend = await listPopups(env.DB, { when: 'weekend', limit: '5' }, Date.now()).catch(() => null);
    items = (weekend?.items ?? []).filter((i) => !i.example).slice(0, 3);
  }

  if (items.length === 0) return null;

  const baseUrl = appBase(env);
  const combined = items
    .map((item) => formatPrefetchedPopup(item, decision.detectedLang, baseUrl))
    .join('\n');
  const trimmed =
    combined.length <= MAX_PREFETCH_CHARS
      ? combined
      : `${combined.slice(0, MAX_PREFETCH_CHARS - 1).trimEnd()}…`;
  return { d1_prefetched_records: trimmed };
}

export const spottedThinkingMessage = (lang: LangCode): string =>
  lang === 'zh-Hant'
    ? '📍 正在幫你查詢倫敦最新快閃活動與細節，稍等一下…'
    : lang === 'zh-Hans'
      ? '📍 正在帮你查询伦敦最新快闪活动与细节，稍等一下…'
      : '📍 Looking up London pop-up details for you, one moment…';

export function createSpottedGatewayConfig(
  overrides: Partial<NarraGatewayConfig<Bindings>> = {},
): NarraGatewayConfig<Bindings> {
  return {
    spec: SPOTTED_AGENT_SPEC,
    fetchUpdates: fetchSpottedUpdates,
    fastRespond: fastRespondSpotted,
    resolveA2ACredential: resolveSpottedA2ACredential,
    buildExtraEnvelopeFields: buildSpottedExtraEnvelopeFields,
    thinkingMessage: spottedThinkingMessage,
    enableA2AFailureReply: true,
    ...overrides,
  };
}

export const spottedGatewayConfig: NarraGatewayConfig<Bindings> = createSpottedGatewayConfig();
