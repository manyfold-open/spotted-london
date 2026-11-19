# Spotted London Narra Agent (`spotted-guide`)

Workspace files for the Manyfold agent `spotted-guide` (`agt_agq66frxtn7pnajpsidj2qhike`).

## Files

- `AGENTS.md`: Guide behavior, trilingual script rules (`zh-Hant` / `zh-Hans` / `en`), multi-agent group rules, picture rules, and self-learning instructions.
- `spotted.py`: Read-only CLI against `https://app.manyfold.ai/spotted-london/api/v1/*` and postcodes.io, plus cover image caching (`media/`, git-ignored) and proactive `updates` check against `~/.cache/spotted/last-announced.json`.
- `places-geo.json`: Static lookup dataset (~16 KB; 10 London university campuses and 421 Underground/Overground/DLR/Elizabeth line stations, derived from `manyfold-london-chinese-food`) used by `spotted.py search --near`.
- `memory.py`: Stdlib SQLite self-learning store (`~/.cache/spotted/memory.sqlite3`) with DM/group privacy isolation and prompt-injection filtering.
- `test_agent.py`: Offline `unittest` suite (`python3 -m unittest agent/test_agent.py`).

## Live sandbox sync

Upload only agent files (`AGENTS.md`, `spotted.py`, `memory.py`, and `places-geo.json` when updated) with `mf`:

```bash
mf --profile manyfold --agent-id agt_agq66frxtn7pnajpsidj2qhike files upload agent/AGENTS.md AGENTS.md
mf --profile manyfold --agent-id agt_agq66frxtn7pnajpsidj2qhike files upload agent/spotted.py spotted.py
mf --profile manyfold --agent-id agt_agq66frxtn7pnajpsidj2qhike files upload agent/memory.py memory.py
```

Do not overwrite `CLAUDE.md` (which includes `@AGENTS.manyfold.md` + `@AGENTS.md`), `.manyfold-config-delivery`, `.narra/`, or secrets.
