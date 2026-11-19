#!/usr/bin/env python3
"""Spotted London lookups for the guide agent.

Read-only: every call is a GET to the site's public API (and postcodes.io to
place a postcode or area on the map). Prints short plain text meant to be read
by the agent, with each pop-up's page link. Times are London time.

  python3 spotted.py search [--when today|weekend|week|all] [--category C[,C]] [--tag T] [--avoid T] [--free] [--verified]
                            [--q WORDS] [--near <university | station | postcode | area | lat,lng>] [--radius KM] [--limit N]
  python3 spotted.py get <slug | id | page link>
  python3 spotted.py covers <slug | id> [<slug | id> ...]   up to 3 pop-ups' pictures, to send with the reply
  python3 spotted.py vocab
  python3 spotted.py updates [--when weekend|week] [--mark] check for newly verified upcoming pop-ups
"""

import argparse
import datetime
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = 'https://app.manyfold.ai/spotted-london'
POSTCODES = 'https://api.postcodes.io'
UA = 'spotted-london-guide-agent (Manyfold)'
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.expanduser(os.environ.get('SPOTTED_CACHE_DIR', '~/.cache/spotted'))
MEDIA = 'media'
VERIFIED_STATUSES = frozenset({'verified_admin', 'verified_community'})


def _read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write_json_atomic(path, data):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)
# Manyfold sends a workspace file after the reply text when the reply links to
# it (apps/api/src/modules/channels/workspace-file-refs.ts). Narra shows a fenced
# block's opening line as nothing (chat-markdown.tsx splitFencedCode), so the
# references ride there unseen.
IMAGE_REF = '![]({})'


def image_line(paths):
    return '```' + ' '.join(IMAGE_REF.format(p) for p in paths) + '```'
CATEGORIES = ['food', 'dining', 'market', 'exhibition', 'art', 'event', 'fashion', 'sample', 'beauty', 'tech', 'other']
TAGS = ['interactive', 'immersive', 'tasting', 'live_music', 'talk', 'shopping', 'freebies', 'vintage', 'vegan', 'collab',
        'fandom', 'makers', 'outdoors', 'late_night', 'booking_needed', 'family', 'adults_only', 'dog_friendly']
STATUS = {
    'verified_admin': 'verified by the Spotted team',
    'verified_community': 'verified by people who went',
    'community': 'not confirmed yet',
}

try:
    from zoneinfo import ZoneInfo
    LONDON = ZoneInfo('Europe/London')
except Exception:
    LONDON = datetime.timezone.utc


def get(url, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.load(res)


def km(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def plain(text):
    return ''.join(ch for ch in text.lower() if ch.isalnum())


# Campuses and stations come from London Chinese Food's source (campuses.ts,
# stations-data.ts), the same places both guides know.
def campus_or_station(text):
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'places-geo.json')) as f:
        g = json.load(f)
    q = plain(text.replace('station', '').replace('站', ''))
    if not q:
        return None
    for c in g['campuses']:
        names = [c['short'], c['en'], c['zh'], c['id']]
        if any(q == plain(n) for n in names) or (len(q) >= 3 and any(q in plain(n) for n in names[1:3])):
            return c['lat'], c['lng'], f"{c['short']} ({c['area']})"
    exact = [s for s in g['stations'] if plain(s[0]) == q]
    loose = exact or [s for s in g['stations'] if len(q) >= 4 and plain(s[0]).startswith(q)]
    return (loose[0][1], loose[0][2], f'{loose[0][0]} station') if loose else None


def locate(where):
    text = where.strip()
    parts = text.split(',')
    if len(parts) == 2:
        try:
            return float(parts[0]), float(parts[1]), text
        except ValueError:
            pass
    known = campus_or_station(text)
    if known:
        return known
    compact = text.replace(' ', '').upper()
    tries = []
    if compact.isalnum() and 5 <= len(compact) <= 7:
        tries.append(f'{POSTCODES}/postcodes/{urllib.parse.quote(compact)}')
    if compact.isalnum() and 2 <= len(compact) <= 4:
        tries.append(f'{POSTCODES}/outcodes/{urllib.parse.quote(compact)}')
    for url in tries:
        try:
            r = get(url)['result']
            return r['latitude'], r['longitude'], text.upper()
        except (urllib.error.HTTPError, KeyError, TypeError):
            continue
    try:
        found = get(f'{POSTCODES}/places?q={urllib.parse.quote(text)}&limit=5')['result'] or []
    except urllib.error.HTTPError:
        found = []
    london = [p for p in found if p.get('region') == 'London'] or found
    if london:
        p = london[0]
        return p['latitude'], p['longitude'], f"{p['name_1']} ({p.get('outcode')})"
    sys.exit(f'could not place "{where}" on the map: ask for a postcode, a station or an area')


def when(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, LONDON)


def span(start, end):
    a, b = when(start), when(end)
    if a.date() == b.date():
        if (a.hour, a.minute, b.hour, b.minute) == (0, 0, 23, 59):
            return f"{a:%a %-d %b} (times not given)"
        return f"{a:%a %-d %b} {a:%H:%M}–{b:%H:%M}"
    return f"{a:%a %-d %b} – {b:%a %-d %b %Y}"


# A pop-up on separate dates carries ranges; start_at/end_at are then only the
# first and last of them, never one open run (llms.txt).
def dates(p):
    ranges = p.get('ranges') or []
    if ranges:
        return '; '.join(span(r[0], r[1]) for r in ranges)
    if p.get('start_at') and p.get('end_at'):
        return span(p['start_at'], p['end_at'])
    return 'dates not given'


def price(p):
    pr = p.get('price') or {}
    kind, text = pr.get('type'), pr.get('text')
    if kind == 'free':
        return 'free' + (f' ({text})' if text else '')
    if kind == 'paid':
        return text or 'paid'
    return text or 'price not given'


def status(p):
    label = STATUS.get(p.get('status'), p.get('status') or '')
    if p.get('status') == 'community' and p.get('source_checked'):
        label += ', source checked'
    return label


def summary(p, origin=None):
    loc = p.get('location') or {}
    bits = [p.get('category') or '', dates(p), price(p), loc.get('borough') or '', status(p)]
    if origin and loc.get('lat') is not None:
        d = km(origin[0], origin[1], loc['lat'], loc['lng'])
        bits.append(f'{d:.1f} km, ~{max(1, round(d * 15))} min walk')
    head = p['title'] + (f" by {p['host']}" if p.get('host') else '')
    tags = f" tags: {', '.join(p['tags'])}" if p.get('tags') else ''
    if p.get('cover_url'):
        tags += ' (has a picture)'
    return f"- {head} [{' | '.join(b for b in bits if b)}]{tags}\n  {BASE}/p/{p['slug']}"


def cmd_search(args):
    params = {'when': args.when, 'limit': min(max(args.limit, 1), 50)}
    if args.category:
        params['category'] = args.category
    if args.tag:
        params['tag'] = args.tag
    if args.avoid:
        params['avoid'] = args.avoid
    if args.free:
        params['free'] = 1
    if args.verified:
        params['verified'] = 1
    if args.q:
        params['q'] = args.q
    origin = locate(args.near) if args.near else None
    if origin:
        params.update(near=f'{origin[0]},{origin[1]}', radius_km=args.radius, sort='distance')
    try:
        res = get(f'{BASE}/api/v1/popups?{urllib.parse.urlencode(params)}')
    except urllib.error.HTTPError as err:
        sys.exit(f"the API refused that query ({err.code}): {err.read().decode('utf-8', 'replace')[:300]}")
    items = res.get('items') or []
    now = datetime.datetime.now(LONDON)
    where = f', within {args.radius} km of {origin[2]}' if origin else ''
    print(f"{len(items)} pop-ups for when={args.when}{where} (now {now:%a %-d %b %H:%M} London time):")
    for p in items:
        print(summary(p, origin))
    if res.get('next_cursor') and len(items) >= params['limit']:
        print('… more exist: narrow the search or raise --limit (up to 50)')


def cmd_get(args):
    key = args.key.strip().rstrip('/').split('/')[-1]
    try:
        p = get(f'{BASE}/api/v1/popups/{urllib.parse.quote(key)}')
    except urllib.error.HTTPError as err:
        sys.exit(f'no pop-up "{key}" ({err.code}): search first')
    loc = p.get('location') or {}
    v = p.get('verification') or {}
    print(p['title'] + (f" by {p['host']}" if p.get('host') else ''))
    print(f"Category: {p.get('category')}" + (f"; tags: {', '.join(p['tags'])}" if p.get('tags') else ''))
    print(f'When: {dates(p)}')
    if p.get('hours_text'):
        print(f"Hours: {p['hours_text']}")
    print(f'Price: {price(p)}')
    print(f"Where: {loc.get('address') or ''} ({loc.get('borough') or ''})")
    print(f'Status: {status(p)}; {v.get("voters", 0)} voters, {v.get("checkins", 0)} check-ins')
    print(f"About (written by the public): {p.get('description') or ''}")
    if p.get('source_url'):
        print(f"Source: {p['source_url']}")
    print(f"Page: {BASE}/p/{p['slug']}")


# Pictures are kept in the workspace a day, by the pop-up's id.
def media(url, name):
    folder = os.path.join(HERE, MEDIA)
    os.makedirs(folder, exist_ok=True)
    for old in os.listdir(folder):
        try:
            if time.time() - os.path.getmtime(os.path.join(folder, old)) > 86400:
                os.remove(os.path.join(folder, old))
        except OSError:
            pass
    path = os.path.join(folder, name)
    if not os.path.exists(path):
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=20) as res:
            body = res.read()
        with open(path + '.tmp', 'wb') as f:
            f.write(body)
        os.replace(path + '.tmp', path)
    return f'{MEDIA}/{name}'


def _download_popup_cover(p):
    cover = p.get('cover_url')
    if not cover:
        return None, 'no picture'
    ext = cover.split('?')[0].rsplit('.', 1)[-1].lower()
    try:
        ref = media(urllib.parse.urljoin(BASE + '/', cover.lstrip('/')), f"cover-{p['id']}.{ext}")
        return ref, None
    except (urllib.error.URLError, TimeoutError):
        return None, 'the picture did not download'


def cmd_covers(args):
    refs = []
    for key in args.keys[:3]:
        key = key.strip().rstrip('/').split('/')[-1]
        try:
            p = get(f'{BASE}/api/v1/popups/{urllib.parse.quote(key)}')
        except urllib.error.HTTPError:
            print(f'- {key}: no such pop-up')
            continue
        ref, err = _download_popup_cover(p)
        if ref:
            refs.append(ref)
            print(f"- {p['title']}: picture {len(refs)}")
        else:
            print(f"- {p['title']}: {err}")
    if refs:
        print('Images, in the order above: end your reply with the next line, exactly as it is.')
        print(image_line(refs))


def cmd_vocab(args):
    print('when: today, weekend, week, all')
    print('categories: ' + ', '.join(CATEGORIES))
    print('tags: ' + ', '.join(TAGS))


def cmd_updates(args):
    """Print up to 3 newly verified upcoming pop-ups vs last-announced.json."""
    params = {'when': args.when, 'verified': 1, 'limit': 50}
    res = get(f'{BASE}/api/v1/popups?{urllib.parse.urlencode(params)}')
    items = res.get('items') or []
    state_path = os.path.join(CACHE, 'last-announced.json')
    state = _read_json(state_path) or {}
    announced = list(state.get('announced_ids') or [])
    seen = set(announced)

    candidates = [
        p for p in items
        if p.get('status') in VERIFIED_STATUSES
        and not p.get('example')
        and (p.get('id') or p.get('slug')) not in seen
    ]
    if not candidates:
        print('NO_UPDATES')
        return

    top = candidates[:3]
    now = datetime.datetime.now(LONDON)
    print(f"{len(top)} verified pop-ups for when={args.when} (now {now:%a %-d %b %H:%M} London time):")
    refs = []
    for p in top:
        print(summary(p))
        ref, _ = _download_popup_cover(p)
        if ref:
            refs.append(ref)
    if refs:
        print('Images, in the order above: end your reply with the next line, exactly as it is.')
        print(image_line(refs))

    if args.mark:
        new_ids = [p.get('id') or p.get('slug') for p in top if (p.get('id') or p.get('slug'))]
        merged = (announced + [i for i in new_ids if i not in seen])[-500:]
        _write_json_atomic(state_path, {
            'announced_ids': merged,
            'updated_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        })


def main():
    ap = argparse.ArgumentParser(description='Spotted London lookups')
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('search')
    s.add_argument('--when', choices=['today', 'weekend', 'week', 'all'], default='week')
    s.add_argument('--category')
    s.add_argument('--tag')
    s.add_argument('--avoid')
    s.add_argument('--free', action='store_true')
    s.add_argument('--verified', action='store_true')
    s.add_argument('--q')
    s.add_argument('--near')
    s.add_argument('--radius', type=float, default=2)
    s.add_argument('--limit', type=int, default=8)
    s.set_defaults(fn=cmd_search)
    s = sub.add_parser('get')
    s.add_argument('key')
    s.set_defaults(fn=cmd_get)
    s = sub.add_parser('covers')
    s.add_argument('keys', nargs='+')
    s.set_defaults(fn=cmd_covers)
    sub.add_parser('vocab').set_defaults(fn=cmd_vocab)
    s = sub.add_parser('updates')
    s.add_argument('--when', choices=['weekend', 'week'], default='week')
    s.add_argument('--mark', action='store_true')
    s.set_defaults(fn=cmd_updates)
    args = ap.parse_args()
    try:
        args.fn(args)
    except (urllib.error.URLError, TimeoutError) as err:
        sys.exit(f'Spotted London did not answer ({err}); say it is unreachable right now')


if __name__ == '__main__':
    main()
