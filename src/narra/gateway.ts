import {
  sanitizeMobileLinks,
  stripAgentMentions,
  type AgentSpec,
  type AgentUpdateItem,
  type InboundEvent,
  type LangCode,
  type RecallTurnResult,
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

export const SPOTTED_AGENT_SPEC: AgentSpec = {
  id: 'spotted-guide',
  matrixId: SPOTTED_MATRIX_ID,
  name: 'Spotted London',
  aliases: ['Spotted London', 'Spotted', '快闪', '快閃', 'spotted-guide'],
  domainDescription:
    'London pop-ups guide (Spotted London): food & dining pop-ups, markets, art exhibitions, events, fashion & sample sales across London with dates, hours, prices, areas, and verification status.',
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
    'shoreditch',
    'soho',
    'hackney',
    'camden',
    'covent garden',
    'brick lane',
    'marylebone',
    'brixton',
    'notting hill',
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
    /\blondon\b.{0,20}(?:pop[- ]?ups?|markets?|exhibitions?|sample\s*sales?|events?|things\s+to\s+do|this\s+weekend)/i,
    /(?:this\s+weekend|today|tonight|what'?s\s+on).{0,20}\blondon\b/i,
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
    'ai in 5',
    'ai5',
    'ai news',
    'ai新闻',
    'ai新聞',
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
  options: { voice?: boolean; intro?: string; isUpdateDigest?: boolean } = {},
): string {
  const top = items.slice(0, options.voice ? 2 : 3);
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

  top.forEach((item, idx) => {
    const area = item.location.borough || item.location.address || 'London';
    const dates = formatPopupDates(item, lang);
    const price = priceLabel(item.price?.type, item.price?.text, lang);
    const ver = verificationLabel(item.status, Boolean(item.source_checked), lang);
    const meta = [area, dates, item.hours_text || '', price, ver].filter(Boolean).join(' | ');
    lines.push(`${idx + 1}. ${item.title} (${meta})`);
    lines.push(`${baseUrl}/p/${item.slug}`);
  });

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
  /^(?:hi|hello|hey|yo|good\s*(?:morning|afternoon|evening)|早安|早上好|你好|您好|哈囉|哈啰|嗨|在嗎|在吗)[!！?？。\s]*$/i;

const COMPLEX_FOLLOWUP_RE =
  /remember|forget|記得|记得|忘掉|忘記|忘记|how\s+(?:do|to)\s+get|tube|bus|station|walk|from\s+|which\s+one|better\s+for|date\s+night|compare|為什麼|为什么|怎麼去|怎么去|坐地鐵|坐地铁|哪一個更好|哪一个更好/i;

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
  { category: 'exhibition', pattern: /\b(?:exhibition|exhibitions|gallery|museum)\b|展覽|展览|看展/i },
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

const TIME_TODAY_RE = /\b(?:today|tonight)\b|今天|今晚|今日/i;
const TIME_WEEKEND_RE =
  /\b(?:weekend|sat(?:urday)?|sun(?:day)?)\b|這?週末|这?周末|週六|周六|週日|周日|禮拜六|礼拜六/i;
const TIME_WEEK_RE = /\b(?:this\s+week|upcoming)\b|這週|这周|本週|本周|最近|近期/i;
const POPUP_ACTIVITY_RE =
  /\b(?:what'?s\s+on|anything\s+(?:fun|on)|pop[- ]?ups?)\b|快閃|快闪|市集|展覽|展览|看展|活動|活动|特賣|特卖|期間限定|期间限定|有什麼好玩的|有什么好玩的/i;

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

  if (POPUP_ACTIVITY_RE.test(text)) {
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

export async function fastRespondSpotted(
  env: Bindings,
  event: InboundEvent,
  decision: TriageDecision,
  _memories: RecallTurnResult,
): Promise<string | null> {
  if (!env.DB) return null;
  const cleanText = stripAgentMentions(event.text ?? '', [...ALL_KNOWN_MENTION_NAMES]);
  if (COMPLEX_FOLLOWUP_RE.test(cleanText)) return null;

  const isUnmentionedGroup =
    event.chatType === 'group' &&
    decision.reason !== 'dm' &&
    decision.reason !== 'explicit_mention' &&
    decision.reason !== 'reply_to_self';

  if (isUnmentionedGroup) {
    const hasAntiHit = hasSpecKeywordHit(cleanText, SPOTTED_AGENT_SPEC.antiKeywords);
    const hasDomainHit = hasSpecKeywordHit(cleanText, SPOTTED_AGENT_SPEC.domainKeywords);
    if (hasAntiHit && !hasDomainHit) return '[NO_REPLY]';
    if (BARE_GREETING_RE.test(cleanText)) return '[NO_REPLY]';
  }

  const lang = decision.detectedLang;
  const nowMs = Date.now();
  const baseUrl = appBase(env);

  if ((event.chatType === 'dm' || decision.reason === 'dm') && BARE_GREETING_RE.test(cleanText)) {
    const list = await listPopups(env.DB, { when: 'weekend', limit: '5' }, nowMs).catch(() => null);
    const real = (list?.items ?? []).filter((i) => !i.example);
    const fallbackList =
      real.length > 0
        ? real
        : ((await listPopups(env.DB, { when: 'week', limit: '5' }, nowMs).catch(() => null))?.items ?? []).filter(
            (i) => !i.example,
          );
    if (fallbackList.length === 0) return null;

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

  let filter = extractPopupQueryFilter(cleanText);
  if (isUnmentionedGroup && !filter.isClearSearch) {
    return '[NO_REPLY]';
  }
  if (!filter.isClearSearch) {
    const aiExtracted = await tryAiExtractFilter(env, cleanText);
    if (!aiExtracted) return null;
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
  try {
    const result = await listPopups(env.DB, queryParams, nowMs);
    items = result.items.filter((i) => !i.example);
    if (items.length === 0 && filter.when !== 'week' && !filter.q && !filter.category) {
      const wider = await listPopups(env.DB, { ...queryParams, when: 'week' }, nowMs);
      items = wider.items.filter((i) => !i.example);
    }
  } catch {
    return null;
  }

  if (items.length > 0) {
    return formatPopupsReply(items, lang, baseUrl, { voice: Boolean(event.isVoice) });
  }

  // If A2A is configured, fall back so Concierge can widen search with geo/fuzzy tools.
  const hasA2A = await resolveSpottedA2ACredential(env);
  if (hasA2A) return null;

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

export const spottedGatewayConfig: NarraGatewayConfig<Bindings> = {
  spec: SPOTTED_AGENT_SPEC,
  fetchUpdates: fetchSpottedUpdates,
  fastRespond: fastRespondSpotted,
  resolveA2ACredential: resolveSpottedA2ACredential,
};
