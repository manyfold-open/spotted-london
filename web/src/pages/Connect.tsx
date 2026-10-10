import { useState } from 'react';
import { Link } from 'react-router';
import { useToast } from '../lib/hooks';
import { Icon } from '../components/Icon';

// How to connect an AI assistant to Spotted. The server needs no sign-in or key, so this page is only instructions
// and things to copy. The same facts are in src/lib/llms.ts (the /llms.txt guide for assistants). Keep them in step.

type App = 'chatgpt' | 'claude' | 'codex' | 'gemini';
const APPS: [App, string][] = [['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['codex', 'Codex'], ['gemini', 'Gemini CLI']];

const ASKS = [
  'What free pop-ups are on in London this weekend? Use Spotted London.',
  'I like matcha and quiet places. Find something near Shoreditch tonight, and skip anything outdoors.',
  'Plan a Saturday afternoon of three pop-ups near Soho, with a link for each.',
];

function CopyBox({ text, label, code }: { text: string; label: string; code?: boolean }) {
  const toast = useToast();
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast('Copied', 'i-check'); } catch { toast('Could not copy. Select the text and copy it by hand.', 'i-info', true); }
  };
  return (
    <div className="cn-box">
      {code ? <pre tabIndex={0} aria-label={label}>{text}</pre> : <p aria-label={label}>{text}</p>}
      <button type="button" className="btn sm" onClick={copy} aria-label={`Copy: ${label}`}><Icon name="i-link" />Copy</button>
    </div>
  );
}

export function Connect() {
  const origin = window.location.origin;
  const url = `${origin}/mcp`;
  const [app, setApp] = useState<App>('chatgpt');

  return (
    <div className="cn">
      <div className="eyebrow">For AI assistants</div>
      <h1>Ask your AI about London pop-ups</h1>
      <p className="intro">Connect ChatGPT, Claude, Codex or Gemini to Spotted. Then you can just ask what is on, and your assistant searches the live list, keeps your tastes in mind and sends you the links. No sign-in, no key, free.</p>

      <section className="panel cn-sec" aria-labelledby="cn-1">
        <h2 id="cn-1"><span className="cn-n">1</span>Copy Spotted's address</h2>
        <CopyBox text={url} label="Spotted address" />
      </section>

      <section className="panel cn-sec" aria-labelledby="cn-2">
        <h2 id="cn-2"><span className="cn-n">2</span>Add it to your assistant</h2>
        <div className="chips" role="group" aria-label="Which assistant">
          {APPS.map(([k, label]) => <button key={k} type="button" className="chip" aria-pressed={app === k} onClick={() => setApp(k)}>{label}</button>)}
        </div>
        {app === 'chatgpt' ? (
          <ol className="cn-steps">
            <li>Open Settings, then Apps and Connectors, and turn on Developer mode under Advanced settings.</li>
            <li>Choose Create. Name it Spotted London, paste the address, and set Authentication to none.</li>
            <li>In a new chat, add Spotted London from the plus menu, then ask your question.</li>
          </ol>
        ) : null}
        {app === 'claude' ? (
          <ol className="cn-steps">
            <li>Open Settings, then Connectors, and choose Add custom connector.</li>
            <li>Name it Spotted London, paste the address, and choose Add. There is nothing to sign in to.</li>
            <li>In a chat, turn Spotted London on from the plus menu, then ask your question.</li>
          </ol>
        ) : null}
        {app === 'codex' ? (
          <>
            <ol className="cn-steps">
              <li>Run this in a terminal.</li>
            </ol>
            <CopyBox code text={`codex mcp add spotted-london --url ${url}`} label="Codex command" />
            <p className="muted cn-after">Check it with <code>codex mcp list</code>. Inside Codex, <code>/mcp</code> shows what is connected.</p>
          </>
        ) : null}
        {app === 'gemini' ? (
          <>
            <ol className="cn-steps">
              <li>Add this to <code>~/.gemini/settings.json</code>. If the file already has <code>mcpServers</code>, add the one entry inside it.</li>
            </ol>
            <CopyBox code label="Gemini CLI settings" text={JSON.stringify({ mcpServers: { 'spotted-london': { httpUrl: url } } }, null, 2)} />
            <p className="muted cn-after">Restart Gemini CLI and type <code>/mcp</code> to see Spotted London listed.</p>
          </>
        ) : null}
        <p className="muted cn-after">Menu names change now and then. If you cannot find an option, search your assistant's help for "custom connector" or "MCP server". ChatGPT usually needs a paid plan for this, and on work plans an admin may need to allow it.</p>
      </section>

      <section className="panel cn-sec" aria-labelledby="cn-3">
        <h2 id="cn-3"><span className="cn-n">3</span>Ask</h2>
        <p className="muted">Say what you like and where you are. Try one of these.</p>
        {ASKS.map(a => <CopyBox key={a} text={a} label="Example question" />)}
      </section>

      <section className="cn-sec" aria-labelledby="cn-4">
        <h2 id="cn-4" className="cn-h">Cannot add a connector?</h2>
        <p className="muted">If your assistant can browse the web, paste this instead. It will read our guide and fetch the list itself.</p>
        <CopyBox text={`Read ${origin}/llms.txt, then use it to find pop-ups in London this weekend that are free. Give me a link for each.`} label="Prompt for assistants that browse" />
      </section>

      <section className="notice cn-sec" aria-label="Privacy">
        <Icon name="i-shield" />
        <span>Spotted only sees the search your assistant sends, like "matcha, Shoreditch". It never sees your chat or who you are. Pop-up text is written by the public, so your assistant is told to treat it as information only. <Link to="/">Back to the map</Link></span>
      </section>
    </div>
  );
}
