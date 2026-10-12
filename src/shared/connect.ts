// How to connect an AI assistant to Spotted: the one copy of the words. The /connect page (web/src/pages/Connect.tsx)
// and the /llms.txt guide (src/lib/llms.ts) both read it, so they cannot drift apart. Plain TS, no UI. No em dashes,
// en dashes or spaced hyphens: it is UI copy.
//
// Menu names in other people's apps change now and then, so check the steps in the real apps when you touch them.

export type AppKey = 'chatgpt' | 'claude' | 'claude-code' | 'codex' | 'cursor' | 'gemini';

/** `dev` apps are command line or editor tools; they sit under "Developer tools" on the page. */
export const APP_LIST: { key: AppKey; label: string; dev: boolean }[] = [
  { key: 'chatgpt', label: 'ChatGPT', dev: false },
  { key: 'claude', label: 'Claude', dev: false },
  { key: 'claude-code', label: 'Claude Code', dev: true },
  { key: 'codex', label: 'Codex', dev: true },
  { key: 'cursor', label: 'Cursor', dev: true },
  { key: 'gemini', label: 'Gemini CLI', dev: true },
];

export const SERVER_NAME = 'spotted-london';

export type Setup = {
  steps: string[];
  /** Something to copy (a command or a settings snippet). */
  code?: { label: string; text: string };
  /** A link that does the install in one click, for apps that support it. */
  link?: { label: string; href: string };
  after?: string;
};

export const isAppKey = (v: unknown): v is AppKey => APP_LIST.some(a => a.key === v);

/** The app to show first: the address wins (so a link can point at one), then the last one used on this device. */
export function pickApp(fromUrl: string | null, stored: string | null): AppKey {
  if (isAppKey(fromUrl)) return fromUrl;
  if (isAppKey(stored)) return stored;
  return 'chatgpt';
}

/** Cursor's one-click install link: the server settings, base64 encoded, in the address. */
export function cursorInstallLink(url: string): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(btoa(JSON.stringify({ url })))}`;
}

export function setupFor(key: AppKey, url: string): Setup {
  switch (key) {
    case 'chatgpt':
      return {
        steps: [
          'Open Settings, then Apps and Connectors, and turn on Developer mode under Advanced settings.',
          'Choose Create. Name it Spotted London, paste the address, and set Authentication to none.',
          'In a new chat, add Spotted London from the plus menu, then ask your question.',
        ],
        after: 'ChatGPT usually needs a paid plan for this, and on work plans an admin may need to allow it. It is easiest on a computer.',
      };
    case 'claude':
      return {
        steps: [
          'Open Settings, then Connectors, and choose Add custom connector.',
          'Name it Spotted London, paste the address, and choose Add. There is nothing to sign in to.',
          'In a chat, turn Spotted London on from the plus menu, then ask your question.',
        ],
      };
    case 'claude-code':
      return {
        steps: ['Run this in a terminal.'],
        code: { label: 'Claude Code command', text: `claude mcp add --transport http ${SERVER_NAME} ${url}` },
        after: 'Check it with `claude mcp list`. Inside Claude Code, `/mcp` shows what is connected.',
      };
    case 'codex':
      return {
        steps: ['Run this in a terminal.'],
        code: { label: 'Codex command', text: `codex mcp add ${SERVER_NAME} --url ${url}` },
        after: 'Check it with `codex mcp list`. Inside Codex, `/mcp` shows what is connected.',
      };
    case 'cursor':
      return {
        steps: ['Choose the button below, then confirm in Cursor. Or add this to `~/.cursor/mcp.json` by hand. If the file already has `mcpServers`, add the one entry inside it.'],
        link: { label: 'Add to Cursor', href: cursorInstallLink(url) },
        code: { label: 'Cursor settings', text: JSON.stringify({ mcpServers: { [SERVER_NAME]: { url } } }, null, 2) },
        after: 'In Cursor, open Settings, then MCP, to see Spotted London listed.',
      };
    case 'gemini':
      return {
        steps: ['Add this to `~/.gemini/settings.json`. If the file already has `mcpServers`, add the one entry inside it.'],
        code: { label: 'Gemini CLI settings', text: JSON.stringify({ mcpServers: { [SERVER_NAME]: { httpUrl: url } } }, null, 2) },
        after: 'Restart Gemini CLI and type `/mcp` to see Spotted London listed.',
      };
  }
}

/** For assistants that can browse but cannot add a connector: one paste, no setup. */
export const browsePrompt = (origin: string) =>
  `Read ${origin}/llms.txt, then use it to find pop-ups in London this weekend that are free. Give me a link for each.`;

/** To prove a new connection works. A working one answers with pop-up names and links. */
export const TEST_PROMPT = 'Use Spotted London to find 3 pop-ups on in London today. Give me a link for each.';

export const EXAMPLE_ASKS = [
  'What free pop-ups are on in London this weekend? Use Spotted London.',
  'I like matcha and quiet places. Find something near Shoreditch tonight, and skip anything outdoors.',
  'Plan a Saturday afternoon of three pop-ups near Soho, with a link for each.',
];

export const TROUBLE: string[] = [
  'It says it cannot find Spotted London: add it to this chat from the plus menu, or start a new chat.',
  'You cannot find the connector option: search your assistant\'s help for "custom connector" or "MCP server". Menu names change now and then.',
  'ChatGPT will not let you add one: Developer mode must be on, and it usually needs a paid plan. On a work plan an admin may need to allow it.',
  'It answers from memory with no links: say "Use Spotted London" in your question, or paste the no-setup prompt at the top of this page instead.',
  'In a terminal tool, run its list command (for example `codex mcp list`) and check spotted-london is there.',
];

/** The assistant names for the llms.txt line that points at the setup page. */
export const APP_NAMES = APP_LIST.map(a => a.label);
