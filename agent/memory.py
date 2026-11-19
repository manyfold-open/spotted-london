#!/usr/bin/env python3
"""Lightweight SQLite self-learning memory store for the Spotted London guide.

Stdlib-only CLI storing per-user and per-room preferences, language settings,
unmet pop-up demands, and feedback under ~/.cache/spotted/memory.sqlite3.

Privacy invariant:
  When `recall --chat-type group` is used, private user memories (--private or
  inherently sensitive keys) are NEVER returned.
"""

import argparse
import datetime
import json
import os
import re
import sqlite3
import sys

DEFAULT_DB = os.path.expanduser(
    os.environ.get('SPOTTED_MEMORY_DB', '~/.cache/spotted/memory.sqlite3')
)

SENSITIVE_USER_KEYS = frozenset({
    'address',
    'birthday',
    'dob',
    'email',
    'home',
    'home_address',
    'mobile',
    'phone',
    'postcode',
    'private',
    'schedule',
    'secret',
    'zip',
})
SENSITIVE_KEY_PREFIXES = ('private_', 'dm_', 'secret_')

RAW_INJECTION_PATTERNS = (
    re.compile(r'</', re.IGNORECASE),
    re.compile(r'<\s*(?:narra-|system|instructions?|prompt|tool_call)\b', re.IGNORECASE),
    re.compile(r'\[\s*(?:channel message context|internal hint|system)\s*\]', re.IGNORECASE),
)

NORMALIZED_INJECTION_PATTERNS = (
    re.compile(r'\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\b'),
    re.compile(r'\bdisregard\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\b'),
    re.compile(r'\bforget\s+(?:all\s+|your\s+)?(?:previous\s+|prior\s+)?(?:instructions?|rules?|prompts?)\b'),
    re.compile(r'\boverride\s+(?:all\s+|your\s+)?(?:instructions?|rules?|prompts?|system)\b'),
    re.compile(r'\b(?:system|developer)\s+(?:prompt|instructions?|message)\b'),
    re.compile(
        r'\b(?:reveal|leak|dump|print|show|expose)\s+(?:your\s+|the\s+)?'
        r'(?:system\s+prompt|instructions?|tokens?|secrets?|env(?:ironment)?|api\s+keys?|passwords?|actor\s+token)\b'
    ),
    re.compile(r'\bactor\s+token\b'),
    re.compile(r'\bmanyfold\s+token\b'),
    re.compile(r'\byou\s+are\s+now\b'),
    re.compile(r'\bnew\s+instructions?\s*:'),
    re.compile(r'\bact\s+as\s+(?:a\s+)?(?:system|developer|admin)\b'),
)


def utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def resolve_db(args) -> str:
    return os.path.expanduser(
        getattr(args, 'db', None) or os.environ.get('SPOTTED_MEMORY_DB') or DEFAULT_DB
    )


def validate_safe_text(label: str, text: str, max_len: int = 500) -> str:
    if not isinstance(text, str) or not text.strip():
        raise ValueError(f'{label} must not be empty')
    if '\x00' in text:
        raise ValueError(f'rejected {label}: null byte is not allowed')
    cleaned = text.strip()
    if len(cleaned) > max_len:
        raise ValueError(f'rejected {label}: exceeds {max_len} characters')
    for pat in RAW_INJECTION_PATTERNS:
        if pat.search(cleaned):
            raise ValueError(f'rejected {label}: contains disallowed tag or control pattern')
    normalized = re.sub(r'[\s_-]+', ' ', cleaned.lower())
    for pat in NORMALIZED_INJECTION_PATTERNS:
        if pat.search(normalized):
            raise ValueError(f'rejected {label}: contains disallowed instruction-override pattern')
    return cleaned


def is_sensitive_key(key: str) -> bool:
    low = key.strip().lower()
    return low in SENSITIVE_USER_KEYS or low.startswith(SENSITIVE_KEY_PREFIXES)


def connect(db_path: str) -> sqlite3.Connection:
    parent = os.path.dirname(os.path.abspath(db_path))
    os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS memories (
            scope TEXT NOT NULL CHECK (scope IN ('user', 'room')),
            target_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            is_private INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (scope, target_id, key)
        );
        CREATE TABLE IF NOT EXISTS demands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL,
            user_id TEXT,
            room_id TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('positive', 'negative')),
            note TEXT,
            created_at TEXT NOT NULL
        );
        """
    )
    return conn


def cmd_remember(args, conn: sqlite3.Connection) -> None:
    target_id = validate_safe_text('id', args.id, max_len=200)
    key = validate_safe_text('key', args.key, max_len=100)
    value = validate_safe_text('value', args.value, max_len=500)
    is_private = 1 if (args.private or (args.scope == 'user' and is_sensitive_key(key))) else 0
    conn.execute(
        """
        INSERT INTO memories (scope, target_id, key, value, is_private, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, target_id, key) DO UPDATE SET
            value = excluded.value,
            is_private = excluded.is_private,
            updated_at = excluded.updated_at
        """,
        (args.scope, target_id, key, value, is_private, utc_now()),
    )
    conn.commit()
    vis = 'private' if is_private else 'shared'
    print(f'OK: remembered {args.scope} {target_id} {key}={value} ({vis})')


def cmd_recall(args, conn: sqlite3.Connection) -> None:
    if not args.user and not args.room:
        raise ValueError('specify --user or --room')
    user_id = validate_safe_text('user', args.user, max_len=200) if args.user else None
    room_id = validate_safe_text('room', args.room, max_len=200) if args.room else None
    chat_type = args.chat_type or ('group' if room_id else 'dm')

    if not user_id:
        user_prefs = {}
    elif chat_type == 'group':
        user_rows = conn.execute(
            """
            SELECT key, value, is_private, updated_at
            FROM memories
            WHERE scope = 'user' AND target_id = ? AND is_private = 0
            ORDER BY key
            """,
            (user_id,),
        ).fetchall()
        user_prefs = {
            r['key']: r['value']
            for r in user_rows
            if r['is_private'] == 0 and not is_sensitive_key(r['key'])
        }
    else:
        user_rows = conn.execute(
            """
            SELECT key, value, is_private, updated_at
            FROM memories
            WHERE scope = 'user' AND target_id = ?
            ORDER BY key
            """,
            (user_id,),
        ).fetchall()
        user_prefs = {r['key']: r['value'] for r in user_rows}

    room_memories = {}
    room_feedback = []
    if room_id:
        room_rows = conn.execute(
            """
            SELECT key, value, is_private
            FROM memories
            WHERE scope = 'room' AND target_id = ?
            ORDER BY key
            """,
            (room_id,),
        ).fetchall()
        room_memories = {
            r['key']: r['value']
            for r in room_rows
            if chat_type == 'dm' or r['is_private'] == 0
        }
        fb_rows = conn.execute(
            """
            SELECT kind, note, created_at
            FROM feedback
            WHERE room_id = ?
            ORDER BY id DESC
            LIMIT 3
            """,
            (room_id,),
        ).fetchall()
        room_feedback = [
            {'kind': r['kind'], 'note': r['note'] or '', 'created_at': r['created_at']}
            for r in fb_rows
        ]

    payload = {
        'chat_type': chat_type,
        'user_id': user_id,
        'room_id': room_id,
        'user_memories': user_prefs,
        'room_memories': room_memories,
        'recent_feedback': room_feedback,
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
        return

    print(f'chat_type: {chat_type}')
    if user_id:
        print(f'user: {user_id}')
    if room_id:
        print(f'room: {room_id}')
    if user_id:
        print('user_memories:')
        if user_prefs:
            for k, v in user_prefs.items():
                print(f'  {k}: {v}')
        else:
            print('  (none)')
    if room_id:
        print('room_memories:')
        if room_memories:
            for k, v in room_memories.items():
                print(f'  {k}: {v}')
        else:
            print('  (none)')
        if room_feedback:
            print('recent_feedback:')
            for fb in room_feedback:
                note = f" ({fb['note']})" if fb['note'] else ''
                print(f"  - {fb['kind']}{note} [{fb['created_at']}]")


def cmd_forget(args, conn: sqlite3.Connection) -> None:
    target_id = validate_safe_text('id', args.id, max_len=200)
    if args.all:
        cur = conn.execute(
            'DELETE FROM memories WHERE scope = ? AND target_id = ?',
            (args.scope, target_id),
        )
        conn.commit()
        print(f'OK: forgot {cur.rowcount} memories for {args.scope} {target_id}')
        return
    if not args.key:
        raise ValueError('specify --key <k> or --all')
    key = validate_safe_text('key', args.key, max_len=100)
    cur = conn.execute(
        'DELETE FROM memories WHERE scope = ? AND target_id = ? AND key = ?',
        (args.scope, target_id, key),
    )
    conn.commit()
    print(f'OK: forgot {args.scope} {target_id} {key} (removed={cur.rowcount})')


def cmd_demand(args, conn: sqlite3.Connection) -> None:
    text = validate_safe_text('text', args.text, max_len=500)
    user_id = validate_safe_text('user', args.user, max_len=200) if args.user else None
    room_id = validate_safe_text('room', args.room, max_len=200) if args.room else None
    conn.execute(
        'INSERT INTO demands (text, user_id, room_id, created_at) VALUES (?, ?, ?, ?)',
        (text, user_id, room_id, utc_now()),
    )
    conn.commit()
    print(f'OK: logged demand "{text}"')


def cmd_lang(args, conn: sqlite3.Connection) -> None:
    user_id = validate_safe_text('user', args.user, max_len=200)
    if args.set:
        conn.execute(
            """
            INSERT INTO memories (scope, target_id, key, value, is_private, updated_at)
            VALUES ('user', ?, 'language', ?, 0, ?)
            ON CONFLICT(scope, target_id, key) DO UPDATE SET
                value = excluded.value,
                is_private = 0,
                updated_at = excluded.updated_at
            """,
            (user_id, args.set, utc_now()),
        )
        conn.commit()
        print(f'OK: user {user_id} language={args.set}')
        return
    row = conn.execute(
        "SELECT value FROM memories WHERE scope = 'user' AND target_id = ? AND key = 'language'",
        (user_id,),
    ).fetchone()
    print(row['value'] if row else 'unset')


def cmd_feedback(args, conn: sqlite3.Connection) -> None:
    room_id = validate_safe_text('room', args.room, max_len=200)
    note = validate_safe_text('note', args.note, max_len=500) if args.note else None
    conn.execute(
        'INSERT INTO feedback (room_id, kind, note, created_at) VALUES (?, ?, ?, ?)',
        (room_id, args.kind, note, utc_now()),
    )
    conn.commit()
    print(f'OK: recorded {args.kind} feedback for {room_id}')


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--db', default=argparse.SUPPRESS, help='Override SQLite path')

    ap = argparse.ArgumentParser(description='Self-learning memory store for Spotted London')
    ap.add_argument('--db', default=None, help='Override SQLite path')
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('remember', parents=[common])
    p.add_argument('--scope', choices=['user', 'room'], required=True)
    p.add_argument('--id', required=True)
    p.add_argument('--key', required=True)
    p.add_argument('--value', required=True)
    p.add_argument('--private', action='store_true')
    p.set_defaults(fn=cmd_remember)

    p = sub.add_parser('recall', parents=[common])
    p.add_argument('--user')
    p.add_argument('--room')
    p.add_argument('--chat-type', choices=['dm', 'group'], default=None)
    p.add_argument('--json', action='store_true')
    p.set_defaults(fn=cmd_recall)

    p = sub.add_parser('forget', parents=[common])
    p.add_argument('--scope', choices=['user', 'room'], required=True)
    p.add_argument('--id', required=True)
    p.add_argument('--key')
    p.add_argument('--all', action='store_true')
    p.set_defaults(fn=cmd_forget)

    p = sub.add_parser('demand', parents=[common])
    p.add_argument('--text', required=True)
    p.add_argument('--user')
    p.add_argument('--room')
    p.set_defaults(fn=cmd_demand)

    p = sub.add_parser('lang', parents=[common])
    p.add_argument('--user', required=True)
    p.add_argument('--set', choices=['zh-Hant', 'zh-Hans', 'en'])
    p.set_defaults(fn=cmd_lang)

    p = sub.add_parser('feedback', parents=[common])
    p.add_argument('--room', required=True)
    p.add_argument('--kind', choices=['positive', 'negative'], required=True)
    p.add_argument('--note')
    p.set_defaults(fn=cmd_feedback)

    return ap


def main() -> None:
    ap = build_parser()
    args = ap.parse_args()
    try:
        conn = connect(resolve_db(args))
        try:
            args.fn(args, conn)
        finally:
            conn.close()
    except ValueError as err:
        print(f'ERROR: {err}', file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
