import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useToast } from '../lib/hooks';
import { usePhone } from '../lib/motion';
import { Icon } from '../components/Icon';
import { APP_LIST, browsePrompt, EXAMPLE_ASKS, pickApp, setupFor, TEST_PROMPT, TROUBLE, type AppKey } from '../../../src/shared/connect';
import { siteUrl } from '../lib/base';

// How to connect an AI assistant to Spotted. The server needs no sign-in or key, so this page is only instructions
// and things to copy. The words live in src/shared/connect.ts, which /llms.txt (src/lib/llms.ts) reads too.

const KEY = 'spotted.connect.app';
const readApp = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };
const writeApp = (v: string) => { try { localStorage.setItem(KEY, v); } catch { /* private window: it just starts on the default next time */ } };

/** Text with `code` spans between backticks. */
function Inline({ text }: { text: string }) {
  return <>{text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>))}</>;
}

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
  const origin = siteUrl(); // includes the mount prefix, so /llms.txt, /mcp and /connect below are real addresses
  const url = `${origin}/mcp`;
  const toast = useToast();
  const phone = usePhone();
  const [sp, setSp] = useSearchParams();
  const [app, setAppState] = useState<AppKey>(() => pickApp(sp.get('app'), readApp()));
  const setApp = (k: AppKey) => { setAppState(k); writeApp(k); setSp(p => { const n = new URLSearchParams(p); n.set('app', k); return n; }, { replace: true }); };
  const setup = setupFor(app, url);
  const chat = APP_LIST.filter(a => !a.dev);
  const dev = APP_LIST.filter(a => a.dev);
  const devPicked = dev.some(a => a.key === app);

  const sendToComputer = async () => {
    const link = `${origin}/connect`;
    try {
      if (navigator.share) { await navigator.share({ title: 'Spotted London for your AI', url: link }); return; }
      await navigator.clipboard.writeText(link);
      toast('Link copied. Paste it into a message to yourself.', 'i-check');
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return; // closed the share sheet
      toast('Could not share. On your computer, open the menu and choose Use with AI.', 'i-info', true);
    }
  };

  return (
    <div className="cn">
      <div className="eyebrow">For AI assistants</div>
      <h1>Ask your AI about London pop-ups</h1>
      <p className="intro">Connect ChatGPT, Claude, Codex and more to Spotted. Then you can just ask what is on, and your assistant searches the live list, keeps your tastes in mind and sends you the links. No sign-in, no key, free.</p>

      <section className="panel cn-sec" aria-labelledby="cn-0">
        <h2 id="cn-0" className="cn-h">Try it in 30 seconds</h2>
        <p className="muted">No setup. If your assistant can browse the web, paste this. It reads our guide and fetches the list itself.</p>
        <CopyBox text={browsePrompt(origin)} label="Prompt for assistants that browse" />
      </section>

      {phone ? (
        <section className="notice cn-sec cn-phone" aria-label="Setup is easier on a computer">
          <Icon name="i-info" />
          <span>Connecting for good is easier on a computer.<button type="button" className="btn sm" onClick={sendToComputer}><Icon name="i-link" />Send this page to myself</button></span>
        </section>
      ) : null}

      <section className="panel cn-sec" aria-labelledby="cn-1">
        <h2 id="cn-1"><span className="cn-n">1</span>Copy Spotted's address</h2>
        <CopyBox text={url} label="Spotted address" />
      </section>

      <section className="panel cn-sec" aria-labelledby="cn-2">
        <h2 id="cn-2"><span className="cn-n">2</span>Add it to your assistant</h2>
        <div className="chips" role="group" aria-label="Which assistant">
          {chat.map(a => <button key={a.key} type="button" className="chip" aria-pressed={app === a.key} onClick={() => setApp(a.key)}>{a.label}</button>)}
        </div>
        <details className="cn-dev" open={devPicked ? true : undefined}>
          <summary>Developer tools</summary>
          <div className="chips" role="group" aria-label="Which developer tool">
            {dev.map(a => <button key={a.key} type="button" className="chip" aria-pressed={app === a.key} onClick={() => setApp(a.key)}>{a.label}</button>)}
          </div>
        </details>
        <ol className="cn-steps">
          {setup.steps.map(s => <li key={s}><Inline text={s} /></li>)}
        </ol>
        {setup.link ? <a className="btn primary sm cn-link" href={setup.link.href}>{setup.link.label}</a> : null}
        {setup.code ? <CopyBox code text={setup.code.text} label={setup.code.label} /> : null}
        {setup.after ? <p className="muted cn-after"><Inline text={setup.after} /></p> : null}
      </section>

      <section className="panel cn-sec" aria-labelledby="cn-3">
        <h2 id="cn-3"><span className="cn-n">3</span>Check it works</h2>
        <p className="muted">Start a new chat and send this. A working connection answers with pop-up names and links.</p>
        <CopyBox text={TEST_PROMPT} label="Test question" />
        <details className="cn-help">
          <summary>It did not work</summary>
          <ul className="cn-steps">
            {TROUBLE.map(t => <li key={t}><Inline text={t} /></li>)}
          </ul>
        </details>
      </section>

      <section className="panel cn-sec" aria-labelledby="cn-4">
        <h2 id="cn-4"><span className="cn-n">4</span>Ask</h2>
        <p className="muted">Say what you like and where you are. Try one of these.</p>
        {EXAMPLE_ASKS.map(a => <CopyBox key={a} text={a} label="Example question" />)}
      </section>

      <section className="notice cn-sec" aria-label="Privacy">
        <Icon name="i-shield" />
        <span>Spotted only sees the search your assistant sends, like "matcha, Shoreditch". It never sees your chat or who you are. Pop-up text is written by the public, so your assistant is told to treat it as information only. <Link to="/">Back to the map</Link></span>
      </section>
    </div>
  );
}
