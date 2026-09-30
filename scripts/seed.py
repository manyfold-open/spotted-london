#!/usr/bin/env python3
"""Writes the example data (all fictional).

  seed/seed.sql            local dev: examples + dev sign-in users (dev_admin, dev_zack, dev_new)
  seed/examples.sql        production: examples only; example accounts use @example.invalid, so nobody can sign in as them
  seed/clear-examples.sql  removes every example pop-up and example account

Times are relative to when the SQL runs, so the examples never go stale.
Run: python3 scripts/seed.py
"""
from math import sqrt
from pathlib import Path

D, H = '86400000', '3600000'
NOW = "CAST(strftime('%s','now') AS INTEGER)*1000"


def t(days, hour):
    # London is UTC+1 until late October; close enough for example data.
    return f"(CAST(strftime('%s','now','start of day') AS INTEGER)*1000 + ({days})*{D} + ({hour}-1)*{H})"


# id, email local part, name, role, karma, verified posts, account age (days)
DEV_USERS = [
    ('dev_admin', 'admin', 'Dev Admin', 'admin', 500, 10, 400),
    ('dev_zack', 'zack', 'Zack C.', 'user', 58, 3, 31),
    ('dev_new', 'new', 'New Member', 'user', 0, 0, 0.5),
]
EXAMPLE_USERS = [
    ('ex_soho_sips', 'soho_sips', 'soho_sips', 'user', 310, 12, 200),
    ('ex_threadcount', 'threadcount', 'threadcount', 'user', 128, 6, 150),
    ('ex_se1_nights', 'se1_nights', 'se1_nights', 'user', 22, 1, 40),
    ('ex_e8_arts', 'e8_arts', 'e8_arts', 'user', 76, 4, 90),
    ('ex_hypedrop', 'hypedrop', 'hypedrop_ldn', 'user', 1, 0, 3),
]

# id, title, host, category, borough, lat, lng, start day, start hour, end day, end hour, hours, price type, price,
# status, weighted yes, weighted no, voters, check-ins, upvotes, downvotes, poster, source, description, dev only
POPUPS = [
    ('matcha', 'Matcha Lab Pop-up', 'Kumo Tea', 'food', 'Soho', 51.5135, -0.134, -2, 11, 5, 19, 'Daily 11:00 to 19:00', 'paid', 'Free entry, drinks from £4', 'verified_admin', 24.2, 1, 17, 9, 141, 9, 'ex_soho_sips', 'https://instagram.com/kumotea', 'Ceremonial matcha tasting flight, whisking demos every hour and a small shop of Uji tea.', False),
    ('denim', 'Archive Denim Sample Sale', 'Loom & Rivet', 'sample', 'Shoreditch', 51.5262, -0.078, 2, 10, 4, 18, 'Fri to Sun 10:00 to 18:00', 'free', 'Free entry, up to 70% off', 'verified_community', 18.4, 2, 12, 0, 96, 8, 'ex_threadcount', 'https://loomandrivet.co.uk/sale', 'Past season selvedge denim, jackets and deadstock fabric by the metre.', False),
    ('arches', 'Night Market under the Arches', 'Arches Collective', 'market', 'Bermondsey', 51.4975, -0.0735, 2, 17, 3, 23, 'Fri and Sat 17:00 to 23:00', 'free', 'Free', 'community', 7.5, 0.8, 4, 0, 38, 3, 'ex_se1_nights', 'https://instagram.com/archescollective', 'Twenty street food traders, a vinyl stall and a DJ in the railway arches.', False),
    ('riso', 'Riso Print Studio Open Days', 'Inkwell Press', 'art', 'Hackney', 51.5455, -0.0555, 1, 12, 11, 18, 'Thu to Sun 12:00 to 18:00', 'paid', 'Free, workshops £25', 'verified_community', 14.1, 0.5, 9, 3, 57, 2, 'ex_e8_arts', 'https://inkwellpress.london', 'Watch zines being printed and book a print workshop.', False),
    ('corndog', 'Korean Corn Dog Truck', 'Dog Days', 'food', 'Camden', 51.5395, -0.1435, 0, 12, 0, 21, 'Today 12:00 to 21:00', 'paid', 'From £6', 'community', 3.1, 0, 2, 1, 22, 1, 'ex_se1_nights', None, 'One day only by the lock.', False),
    ('kilo', 'Vintage Kilo Sale', 'Second Spin', 'fashion', 'Brixton', 51.4625, -0.1145, 3, 11, 4, 17, 'Sat and Sun 11:00 to 17:00', 'paid', '£20 per kilo, £2 entry', 'verified_admin', 20.3, 1.4, 14, 0, 88, 11, 'ex_threadcount', 'https://secondspin.co.uk', 'Two tonnes of 80s and 90s clothing.', False),
    ('ceramics', 'Ceramics Seconds Sale', 'Rye Lane Pottery', 'market', 'Peckham', 51.4735, -0.069, 3, 10, 3, 16, 'Sat 10:00 to 16:00', 'free', 'Free entry', 'community', 5.2, 0.4, 4, 0, 31, 1, 'ex_e8_arts', 'https://instagram.com/ryelanepottery', 'Slightly wonky mugs, bowls and vases at half price.', False),
    ('perfume', 'Indie Perfume Lab', 'Nose Studio', 'beauty', 'Marylebone', 51.5195, -0.1515, 5, 11, 18, 19, 'Tue to Sun 11:00 to 19:00', 'paid', 'Free, blend your own £45', 'verified_admin', 9.8, 0.2, 7, 0, 41, 3, 'ex_soho_sips', 'https://nosestudio.co', 'Sample 40 independent perfumes and blend a 30ml bottle with a perfumer.', False),
    ('sneaker', 'Sneaker Raffle Store', 'Unknown', 'fashion', 'Covent Garden', 51.5125, -0.1235, 1, 10, 7, 20, 'Daily 10:00 to 20:00', 'paid', 'Raffle entry £5', 'community', 2.4, 3.9, 5, 0, 12, 14, 'ex_hypedrop', None, 'Several people report the shop unit is empty.', False),
    ('noodle', 'Hand Pulled Noodle Pop-up', 'Lanzhou Lane', 'food', 'Soho', 51.512, -0.132, 2, 12, 9, 21, 'Daily 12:00 to 21:00', 'paid', 'From £9', 'pending', 0, 0, 0, 0, 1, 0, 'dev_new', None, 'Hand pulled noodles for one week only.', True),
]


def q(v):
    if v is None:
        return 'NULL'
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def wilson(p, n):
    total = p + n
    if not total:
        return 0
    z, ph = 1.28, p / total
    return round((ph + z * z / (2 * total) - z * sqrt((ph * (1 - ph) + z * z / (4 * total)) / total)) / (1 + z * z / total), 4)


def geohash(lat, lng, precision=7):
    b = '0123456789bcdefghjkmnpqrstuvwxyz'
    la, lo, out, even, bit, ch = [-90, 90], [-180, 180], '', True, 0, 0
    while len(out) < precision:
        r, v = (lo, lng) if even else (la, lat)
        mid = (r[0] + r[1]) / 2
        if v >= mid:
            ch |= 1 << (4 - bit); r[0] = mid
        else:
            r[1] = mid
        even = not even
        if bit < 4:
            bit += 1
        else:
            out += b[ch]; bit = 0; ch = 0
    return out


def build(dev: bool) -> str:
    domain = 'spotted.dev' if dev else 'example.invalid'
    users = (DEV_USERS if dev else []) + EXAMPLE_USERS
    out = [f'-- Generated by scripts/seed.py. Fictional example data{" and dev users" if dev else ""}.']
    if dev:
        out.append('DELETE FROM agent_notes; DELETE FROM agent_runs; DELETE FROM votes; DELETE FROM checkins; DELETE FROM reports; DELETE FROM saves; DELETE FROM popup_images; DELETE FROM karma_log;'
                   ' DELETE FROM popups; DELETE FROM sessions; DELETE FROM login_tokens; DELETE FROM subscribers; DELETE FROM audit_log;'
                   # the agents table points at the agent accounts, so they stay
                   " DELETE FROM users WHERE id NOT LIKE 'agent\\_%' ESCAPE '\\';")
    out.append('')
    for (uid, local, name, role, karma, vp, age) in users:
        email = f'{local}@{domain}' if uid.startswith('dev_') or dev else f'{uid}@{domain}'
        out.append(f"INSERT OR IGNORE INTO users (id, email, display_name, role, karma, verified_posts, email_verified, created_at) VALUES "
                   f"({q(uid)}, {q(email)}, {q(name)}, {q(role)}, {karma}, {vp}, 1, {NOW} - {age}*{D});")
    out.append('')
    for p in POPUPS:
        (pid, title, host, cat, area, lat, lng, sd, sh, ed, eh, hours, pt, price, st, pos, neg, voters, ci, qp, qn, by, src, desc, dev_only) = p
        if dev_only and not dev:
            continue
        verdict = "'real'" if st.startswith('verified') else 'NULL'
        out.append(
            'INSERT OR IGNORE INTO popups (id, slug, title, host, description, category, price_type, price_text, borough, address, lat, lng, geohash, '
            'start_at, end_at, hours_text, source_url, status, final_verdict, created_by, exist_pos, exist_neg, voter_count, checkin_count, '
            'confidence, quality_pos, quality_neg, is_example, created_at, updated_at) VALUES '
            f"({q('ex_' + pid)}, {q(pid + '-example')}, {q(title)}, {q(host)}, {q(desc)}, {q(cat)}, {q(pt)}, {q(price)}, {q(area)}, "
            f"{q(area + ', London')}, {lat}, {lng}, {q(geohash(lat, lng))}, {t(sd, sh)}, {t(ed, eh)}, {q(hours)}, {q(src)}, {q(st)}, {verdict}, "
            f"{q(by)}, {pos}, {neg}, {voters}, {ci}, {wilson(pos, neg)}, {qp}, {qn}, 1, {NOW}, {NOW});")
    out.append(f'''
-- Vote and check-in rows behind the cached counts, so recomputing after a new vote keeps them.
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 160)
INSERT OR IGNORE INTO users (id, email, display_name, role, karma, verified_posts, email_verified, created_at)
SELECT 'ex_voter' || n, 'ex_voter' || n || '@{domain}', 'Voter ' || n, 'user', 20, 0, 1, {NOW} - 90*{D} FROM s;

WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 160)
INSERT OR IGNORE INTO votes (user_id, popup_id, kind, value, weight, ip_hash, created_at)
SELECT 'ex_voter' || s.n, p.id, 'existence', 1, p.exist_pos * 1.0 / (p.voter_count - (p.exist_neg > 0)), 'exip' || s.n, {NOW}
FROM popups p JOIN s ON s.n <= p.voter_count - (p.exist_neg > 0) WHERE p.is_example = 1 AND p.exist_pos > 0;

INSERT OR IGNORE INTO votes (user_id, popup_id, kind, value, weight, ip_hash, created_at)
SELECT 'ex_voter160', id, 'existence', -1, exist_neg, 'exip160', {NOW} FROM popups WHERE is_example = 1 AND exist_neg > 0;

WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 160)
INSERT OR IGNORE INTO votes (user_id, popup_id, kind, value, weight, created_at)
SELECT 'ex_voter' || s.n, p.id, 'quality', CASE WHEN s.n <= p.quality_pos - 1 THEN 1 ELSE -1 END, 1, {NOW}
FROM popups p JOIN s ON s.n <= p.quality_pos - 1 + p.quality_neg WHERE p.is_example = 1;
INSERT OR IGNORE INTO votes (user_id, popup_id, kind, value, weight, created_at)
SELECT created_by, id, 'quality', 1, 1, {NOW} FROM popups WHERE is_example = 1 AND quality_pos > 0;

WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 160)
INSERT OR IGNORE INTO checkins (user_id, popup_id, distance_m, valid, created_at)
SELECT 'ex_voter' || s.n, p.id, 40, 1, {NOW} FROM popups p JOIN s ON s.n <= p.checkin_count WHERE p.is_example = 1;

INSERT OR IGNORE INTO reports (id, user_id, popup_id, reason, note, weight, created_at)
VALUES ('ex_r1', 'ex_soho_sips', 'ex_sneaker', 'not_exist', 'Unit is empty', 3.6, {NOW});
UPDATE popups SET report_weight = 3.6 WHERE id = 'ex_sneaker';''')
    if dev:
        out.append(f"\nINSERT INTO saves (user_id, popup_id, remind, created_at) VALUES ('dev_zack', 'ex_denim', 1, {NOW}), ('dev_zack', 'ex_kilo', 1, {NOW});")
    return '\n'.join(out) + '\n'


CLEAR = '''-- Removes every example pop-up and example account. Real data is untouched.
DELETE FROM votes WHERE popup_id IN (SELECT id FROM popups WHERE is_example = 1) OR user_id LIKE 'ex\\_%' ESCAPE '\\';
DELETE FROM checkins WHERE popup_id IN (SELECT id FROM popups WHERE is_example = 1) OR user_id LIKE 'ex\\_%' ESCAPE '\\';
DELETE FROM reports WHERE popup_id IN (SELECT id FROM popups WHERE is_example = 1) OR user_id LIKE 'ex\\_%' ESCAPE '\\';
DELETE FROM saves WHERE popup_id IN (SELECT id FROM popups WHERE is_example = 1);
DELETE FROM agent_notes WHERE popup_id IN (SELECT id FROM popups WHERE is_example = 1) OR duplicate_of IN (SELECT id FROM popups WHERE is_example = 1);
DELETE FROM popup_images WHERE popup_id IN (SELECT id FROM popups WHERE is_example = 1);
DELETE FROM karma_log WHERE user_id LIKE 'ex\\_%' ESCAPE '\\';
DELETE FROM popups WHERE is_example = 1;
DELETE FROM users WHERE id LIKE 'ex\\_%' ESCAPE '\\' AND id NOT IN (SELECT created_by FROM popups);
'''

root = Path(__file__).resolve().parent.parent / 'seed'
(root / 'seed.sql').write_text(build(dev=True))
(root / 'examples.sql').write_text(build(dev=False))
(root / 'clear-examples.sql').write_text(CLEAR)
print('wrote seed/seed.sql, seed/examples.sql, seed/clear-examples.sql')
