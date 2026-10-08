# Ask for recommendations (design, not built)

Written 2026-10-08 with Zack, after "For you" (the swipe deck and taste ranking) shipped. This is the brief for the session that builds "Ask".

## The goal

A person types what they want ("something free and a bit weird this weekend near Shoreditch") and gets a few real pop-ups back with a reason for each. Anyone can use it, signed in or not. The recommendations come from the list Spotted already has, never from the model's imagination.

## Decisions already made (Zack)

- Anyone can ask without signing in. So it needs a per-visitor daily limit and a total daily budget, or one visitor can use up the quota.
- The answer should come from an **agent on Manyfold**, the same way Scout, Triage and Checker run (A2A to start, MCP back to Spotted). Zack asked for this specifically.
- The taste from "For you" (`src/shared/taste.ts`, `spotted.taste` in localStorage) may be sent along as a short summary (liked and left-out categories). Position is not sent; the browser applies "near me" itself (see "The map home never sends your position anywhere" in CLAUDE.md).
- Start with the 11 categories. Finer tags from Scouts come later.

## The one open question: how long does an agent take?

Manyfold agents here run asynchronously: `message/send` with `blocking: false` returns a task at once, then `tasks/get` is polled (`src/lib/a2a.ts`). A sandbox that was stopped has to wake first (`runner_unavailable` is a known failure, see "Agent fleet" in CLAUDE.md). The three existing agents also share one sandbox (sandbox-008). Nobody has measured how long a short question takes.

**Do this first, before building anything:**

1. In Manyfold create an agent `Concierge test`. Add only the public Spotted tools: `mf mcp add spotted https://spotted-london.zack11712.workers.dev/mcp --scope project --agent-id <id>`, with no key. Keep `--scope project` (the default scope is shared by the whole sandbox).
2. Connect it with the device-code flow (`connectStart` and `connectPoll` in `src/lib/manyfold.ts`; the tokens stay in memory, never in chat or logs) and send a question such as "Recommend 3 free pop-ups this weekend. Use search_popups." with `startTask`, then poll `getTask`.
3. Time it cold (sandbox idle for a while) and warm (straight after), a few times each.

Decide from the numbers:

| Wait | Build |
| --- | --- |
| Under about 20 seconds | Answer with the agent. The page polls `GET /ask/:id` every 2 seconds. |
| Longer | Answer at once with Workers AI (a small model turns the sentence into filters, then `filterPopups` and `forYou` pick the pop-ups from the snapshot). The agent only adds a written reason afterwards, or is dropped. |

Either way, show something immediately: the existing filters plus the taste order. The answer improves what is already on screen; it is never a blank wait.

## Shape of the build (if the agent is fast enough)

- A new agent role, say `concierge`. `agents.role` has a CHECK (`migrations/0008`) that allows only scout, triage and checker, so this needs a migration that rebuilds `agents` (follow the park-and-recreate pattern of `0014_categories.sql`). Update `AgentRole`, `AGENT_ROLES` and `AGENT_INFO` in `src/db/agents.ts`, and `skills/spotted-london/SKILL.md` (keep it role-based).
- A table for questions, for example `asks (id, asked_at, ip_hash, text, status, task_id, answer_json, ...)`. The page polls it. Purge old rows in cron.
- The agent reads the list through the public `search_popups` and `get_popup` tools, so it can only recommend pop-ups that exist. The answer is a list of pop-up ids plus a one-line reason each; the Worker checks every id against the snapshot before it sends anything on.
- Limits, all in KV like the other rate limits: a few questions per visitor per day (IP hash, `src/middleware.ts`), Turnstile on the first question, a daily cap on all questions, and a clear fallback message when the cap is hit ("Ask is resting for today. The filters and For you still work.").
- Pop-up text is data, not instructions. The question text is data too. Send the agent only what `search_popups` already returns, and cap the question at a few hundred characters.

## Not in scope

Syncing the taste to the account, learning from saves and votes, and Scout tags are the other next steps (CLAUDE.md "Status and next steps", item 6).

## Done when

- Asking in plain English returns up to 5 real pop-ups with a reason each, or a clear message when there is nothing.
- Hitting a limit never breaks the page.
- A test covers: ids not in the snapshot are dropped, the limits, and the fallback.
- CLAUDE.md, README ("AI agents and MCP"), SKILL.md and SPEC §12 are updated in the same change.
