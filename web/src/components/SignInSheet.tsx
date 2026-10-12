import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useProviders } from './Turnstile';
import { Icon } from './Icon';
import { GateCtx } from '../lib/hooks';
import type { GateAsk } from '../../../src/shared/gate';
import { forgetGate, rememberGate } from '../lib/gate';
import { markSigningIn } from '../lib/track';

/**
 * Asks for sign in without taking you off the page. Shell wraps the app in this, and `useRequireAuth` opens it.
 * It remembers the action (see lib/gate.ts) so it can be finished once you are back from Google.
 */
export function GateProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<GateAsk | null>(null);
  const open = useCallback((a: GateAsk) => { rememberGate(a); setAsk(a); }, []);
  const close = useCallback(() => { forgetGate(); setAsk(null); }, []);
  const leave = useCallback(() => setAsk(null), []); // off to sign in by email: the page stays in the tab, so keep what to finish
  return (
    <GateCtx.Provider value={open}>
      {children}
      {ask ? <SignInSheet ask={ask} onClose={close} onLeave={leave} /> : null}
    </GateCtx.Provider>
  );
}

function SignInSheet({ ask, onClose, onLeave }: { ask: GateAsk; onClose: () => void; onLeave: () => void }) {
  const loc = useLocation();
  const providers = useProviders();
  const box = useRef<HTMLDivElement>(null);
  const [before] = useState(() => document.activeElement as HTMLElement | null);
  const back = encodeURIComponent(loc.pathname + loc.search);
  const p = providers.data;

  useEffect(() => {
    box.current?.querySelector<HTMLElement>('a, button')?.focus({ preventScroll: true });
    return () => { if (before?.isConnected) before.focus({ preventScroll: true }); };
  }, [before]);

  // Escape closes, Tab stays inside
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      if (e.key !== 'Tab') return;
      const f = [...(box.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? [])];
      if (!f.length) return;
      const at = f.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && at <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && at === f.length - 1) { e.preventDefault(); f[0].focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="gate-scrim" onClick={onClose} />
      <div className="gate" role="dialog" aria-modal="true" aria-labelledby="gate-t" ref={box}>
        <span className="handle" aria-hidden="true" />
        <h2 id="gate-t">{ask.why}</h2>
        <p className="muted">{ask.intent ? 'Sign in takes one tap, then we finish what you started.' : 'Sign in takes one tap, then you land back here.'}</p>
        {p?.google ? <a className="btn primary block" href={`/api/v1/auth/google?return_to=${back}`} onClick={() => markSigningIn('sheet')}>Continue with Google</a> : null}
        {p?.email ? <Link className={`btn block ${p.google ? '' : 'primary'}`} to={`/signin?return_to=${back}`} onClick={onLeave}><Icon name="i-mail" />{p.google ? 'Use email instead' : 'Sign in with email'}</Link> : null}
        {p && !p.google && !p.email ? <div className="notice watch"><Icon name="i-clock" /><span>Sign in is not switched on yet. You can still browse every pop-up.</span></div> : null}
        {!p ? <div className="sk" style={{ height: 44, borderRadius: 999 }} /> : null}
        <button type="button" className="btn subtle block" onClick={onClose}>Not now</button>
        <p className="small muted">One account per person keeps votes and new pop-ups honest. We never show your email to other people.</p>
      </div>
    </>
  );
}
