import { useState } from 'react';
import { Link, useNavigate, useRouteError, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Popup } from '../lib/api';
import { dateRange, initials, looksLikeEmail } from '../lib/format';
import { useErrorToast, useMe, useSheet, useToast } from '../lib/hooks';
import { Icon } from '../components/Icon';
import { CardSkeletons, Cover, PopupCard, StatusTag } from '../components/PopupBits';
import { Turnstile, useNeedsTurnstile, useProviders } from '../components/Turnstile';
import { Logo } from '../components/Shell';

/* ---------------- Saved ---------------- */
export function Saved() {
  const { data: me, isPending } = useMe();
  const q = useQuery({ queryKey: ['saves'], queryFn: () => api<{ items: Popup[] }>('/me/saves'), enabled: !!me });
  const items = (q.data?.items ?? []).map(p => ({ ...p, me: { saved: true, existence_vote: 0, quality_vote: 0, ...p.me } }));
  const upcoming = items.filter(p => p.end_at >= Date.now());
  const past = items.filter(p => p.end_at < Date.now());
  if (!isPending && !me) return <SignInPrompt title="Saved" text="Sign in to keep a list of pop-ups and get a reminder the day before each one starts." to="/saved" />;
  return (
    <>
      <div className="eyebrow">Your list</div><h1>Saved</h1>
      <p className="intro">We remind you the day before each one starts, and again on its last day.</p>
      <div className="lh"><h2>{upcoming.length} coming up</h2></div>
      {q.isPending ? <CardSkeletons n={3} /> : upcoming.length ? <div className="grid">{upcoming.map(p => <PopupCard key={p.id} p={p} />)}</div>
        : <div className="empty"><Icon name="i-bookmark" className="i big" /><h2>Nothing saved yet</h2><p>Tap the bookmark on any pop-up to keep it here.</p><Link className="btn sm" to="/">Explore pop-ups</Link></div>}
      {past.length ? <><div className="lh"><h2>Already ended</h2></div><div className="grid">{past.map(p => <PopupCard key={p.id} p={p} />)}</div></> : null}
    </>
  );
}

export function SignInPrompt({ title, text, to }: { title: string; text: string; to: string }) {
  return (
    <div className="auth panel">
      <h1 style={{ fontSize: 28 }}>{title}</h1>
      <p className="muted" style={{ margin: '8px 0 18px' }}>{text}</p>
      <Link className="btn primary block" to={`/signin?return_to=${encodeURIComponent(to)}`}>Sign in</Link>
    </div>
  );
}

/* ---------------- Sign in ---------------- */
export function SignIn() {
  const [sp] = useSearchParams();
  const returnTo = sp.get('return_to') ?? '/';
  const { data: me } = useMe();
  const [email, setEmail] = useState('');
  const [bad, setBad] = useState(false);
  const onError = useErrorToast();
  const providers = useProviders();
  const needsBot = useNeedsTurnstile();
  const [botToken, setBotToken] = useState<string | null>(null);
  const [botReset, setBotReset] = useState(0);
  const send = useMutation({
    mutationFn: () => api<{ message: string; dev_link?: string }>('/auth/magic-link', { method: 'POST', json: { email, return_to: returnTo, turnstile_token: botToken } }),
    onError: e => { onError(e); setBotReset(n => n + 1); },
  });
  if (me) {
    return <div className="auth panel"><h1 style={{ fontSize: 28 }}>You are signed in</h1><p className="muted" style={{ margin: '8px 0 18px' }}>as {me.email}</p><Link className="btn primary block" to={returnTo}>Continue</Link></div>;
  }
  return (
    <div className="auth panel">
      <h1 style={{ fontSize: 28 }}>Sign in</h1>
      <p className="muted" style={{ margin: '8px 0 18px' }}>No password. We email you a link that signs you in.</p>
      {providers.data && !providers.data.email && !providers.data.google ? (
        <div className="notice watch"><Icon name="i-clock" /><span>Sign in is not switched on yet. You can still browse every pop-up.</span></div>
      ) : providers.data && !providers.data.email ? null : send.isSuccess ? (
        <div className="stack">
          <div className="notice good"><Icon name="i-mail" /><span>{send.data.message}</span></div>
          {send.data.dev_link ? <a className="btn block" href={send.data.dev_link}>Development: open the sign-in link</a> : null}
          <button className="btn subtle" onClick={() => send.reset()}>Use a different email</button>
        </div>
      ) : (
        <form className="stack" noValidate onSubmit={e => { e.preventDefault(); if (!looksLikeEmail(email)) return setBad(true); send.mutate(); }}>
          <label className="field"><span className="lbl">Email</span>
            <input className={`input ${bad ? 'bad' : ''}`} type="email" autoComplete="email" inputMode="email" value={email} onChange={e => { setEmail(e.target.value); setBad(false); }}
              placeholder="you@email.com" aria-invalid={bad} aria-describedby={bad ? 'emailerr' : undefined} />
            {bad ? <span className="ferr" id="emailerr" role="alert">Enter an email address like name@example.com.</span> : null}</label>
          <Turnstile onToken={setBotToken} resetKey={botReset} />
          <button className="btn primary block" disabled={send.isPending || (needsBot && !botToken)}>{send.isPending ? <span className="spin" /> : <Icon name="i-mail" />}Email me a link</button>
        </form>
      )}
      {providers.data?.google ? (
        <>
          <div className="row" style={{ margin: '16px 0' }}><span className="spacer" style={{ borderTop: '1.5px dashed var(--hair)' }} /><span className="small muted">or</span><span className="spacer" style={{ borderTop: '1.5px dashed var(--hair)' }} /></div>
          <a className="btn block" href={`/api/v1/auth/google?return_to=${encodeURIComponent(returnTo)}`}>Continue with Google</a>
        </>
      ) : null}
      <p className="small muted" style={{ marginTop: 16 }}>We never show your email to other people.</p>
    </div>
  );
}

/* ---------------- Me ---------------- */
const REASON_TEXT: Record<string, string> = {
  post_verified: 'Your pop-up was verified', post_removed: 'Your pop-up was removed', vote_matched: 'Your vote matched the result',
  vote_missed: 'Your vote did not match the result', checkin: 'You checked in', upvotes: 'Upvotes on your pop-up',
  report_upheld: 'Your report was upheld', report_rejected: 'Your report was rejected', admin_adjust: 'Adjusted by an admin',
};

export function MePage() {
  const { data: me, isPending } = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const onError = useErrorToast();
  const { open } = useSheet();
  const karma = useQuery({ queryKey: ['karma'], queryFn: () => api<{ items: { delta: number; reason: string; created_at: number }[] }>('/me/karma'), enabled: !!me });
  const mine = useQuery({ queryKey: ['mypopups'], queryFn: () => api<{ items: Popup[] }>('/me/popups'), enabled: !!me });
  const [name, setName] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (display_name: string) => api('/me', { method: 'PATCH', json: { display_name } }),
    onSuccess: () => { setName(null); toast('Name saved'); qc.invalidateQueries({ queryKey: ['me'] }); },
    onError,
  });
  const logout = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSuccess: () => { qc.clear(); nav('/'); toast('Signed out'); },
    onError,
  });
  const newsletter = useMutation({ mutationFn: () => api('/newsletter/subscribe', { method: 'POST', json: { email: me!.email } }), onSuccess: () => toast('Check your inbox to confirm', 'i-mail'), onError });

  if (isPending) return <div className="sk" style={{ height: 300 }} />;
  if (!me) return <SignInPrompt title="Your profile" text="Sign in to add pop-ups, vote, and build karma." to="/me" />;
  const factor = me.karma < 0 ? 0.2 : Math.min(4, 1 + Math.log10(Math.max(me.karma, 1)));

  return (
    <>
      <div className="hero-me">
        <div className="avatar">{initials(me.name, me.email)}</div>
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow">Member since {new Date(me.created_at).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</div>
          {name === null ? (
            <div className="row"><h1 style={{ fontSize: 30 }}>{me.name ?? 'Add your name'}</h1><button className="btn sm subtle" onClick={() => setName(me.name ?? '')}>Edit</button></div>
          ) : (
            <form className="row" onSubmit={e => { e.preventDefault(); rename.mutate(name); }}>
              <label style={{ flex: 1, minWidth: 160 }}><span className="sr">Display name</span><input className="input" autoFocus value={name} maxLength={40} onChange={e => setName(e.target.value)} placeholder="Shown next to your posts" /></label>
              <button className="btn sm primary" disabled={rename.isPending}>Save</button><button type="button" className="btn sm subtle" onClick={() => setName(null)}>Cancel</button>
            </form>
          )}
        </div>
      </div>
      <div className="kpis">
        <div className="kpi"><span className="eyebrow">Karma</span><b className="num">{me.karma}</b></div>
        <div className="kpi"><span className="eyebrow">Vote weight</span><b className="num">{me.vote_weight.toFixed(2)}x</b></div>
        <div className="kpi"><span className="eyebrow">Trust</span><b className="num">{me.trust}</b></div>
        <div className="kpi"><span className="eyebrow">Verified posts</span><b className="num">{me.verified_posts}</b></div>
      </div>

      <div className="lh"><h2>Account</h2></div>
      <div className="menu">
        {me.role === 'admin' ? <Link className="mrow" to="/admin"><Icon name="i-inbox" /><span>Review queue<span className="sub">Posts waiting for a decision</span></span><Icon name="i-down" className="i chev" /></Link> : null}
        <button className="mrow" onClick={() => newsletter.mutate()} disabled={newsletter.isPending || newsletter.isSuccess}><Icon name="i-mail" /><span>Weekend newsletter<span className="sub">{newsletter.isSuccess ? 'Confirmation email sent' : `Send it to ${me.email}`}</span></span><Icon name="i-down" className="i chev" /></button>
        <div className="mrow static"><Icon name="i-bell" /><span>Reminders<span className="sub">Emailed the day before a saved pop-up starts, and on its last day</span></span></div>
        <button className="mrow" onClick={() => logout.mutate()}><Icon name="i-x" /><span>Sign out</span></button>
      </div>

      <div className="lh"><h2>Your pop-ups</h2></div>
      {mine.data?.items.length ? (
        <div className="stack">{mine.data.items.map(p => (
          <Link key={p.id} to={`/p/${p.slug}`} className="mini" onClick={e => { e.preventDefault(); open(p.slug); }}>
            <Cover p={p} className="sw" />
            <span style={{ minWidth: 0, flex: 1 }}><b>{p.title}</b><span>{dateRange(p)}</span></span><StatusTag status={p.status} />
          </Link>
        ))}</div>
      ) : <div className="empty"><p>You have not added any pop-ups yet.</p><Link className="btn sm" to="/add"><Icon name="i-plus" />Add a pop-up</Link></div>}

      <div className="lh"><h2>How your vote weight is worked out</h2></div>
      <div className="rules">
        <div className="panel"><div className="eyebrow">Karma</div><p style={{ marginTop: 6 }}><code>1 + log10({me.karma})</code> = <b className="num">{factor.toFixed(2)}</b></p><p className="small muted" style={{ marginTop: 6 }}>Capped at 4. Negative karma drops to 0.2.</p></div>
        <div className="panel"><div className="eyebrow">Account age</div><p className="small muted" style={{ marginTop: 6 }}>Under a day your votes count 0. Under a week they count half.</p></div>
        <div className="panel"><div className="eyebrow">Proof</div><p className="small muted" style={{ marginTop: 6 }}>A verified email adds 20%. A check-in within 200 m multiplies your vote by 3.</p></div>
      </div>

      <div className="lh"><h2>Recent karma</h2></div>
      {karma.data?.items.length ? (
        <div className="panel" style={{ padding: '6px 16px' }}><table className="log"><tbody>
          {karma.data.items.map((k, i) => (
            <tr key={i}><td>{REASON_TEXT[k.reason] ?? k.reason}</td><td className="muted small" style={{ whiteSpace: 'nowrap' }}>{new Date(k.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</td>
              <td className={`d num ${k.delta > 0 ? 'pos' : 'neg'}`}>{k.delta > 0 ? '+' : ''}{k.delta}</td></tr>
          ))}
        </tbody></table></div>
      ) : <div className="empty"><p>No karma yet. Vote on pop-ups you have seen, or add one.</p></div>}
    </>
  );
}

/* ---------------- Admin queue ---------------- */
type QueueItem = Popup & { poster: { id: string; name: string | null; karma: number; account_age_days: number }; open_reports: number; flags: string[] };
const FLAG_TEXT: Record<string, string> = { no_source_link: 'No source link', new_account: 'New account', reported: 'Reported', community_hidden: 'Hidden by votes' };

export function AdminQueue() {
  const { data: me, isPending } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const { open } = useSheet();
  const q = useQuery({ queryKey: ['queue'], queryFn: () => api<{ items: QueueItem[] }>('/admin/queue'), enabled: me?.role === 'admin' });
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' | 'hide' | 'restore' }) => api(`/admin/popups/${id}/decision`, { method: 'POST', json: { action } }),
    onSuccess: (_d, v) => {
      toast(v.action === 'approve' ? 'Verified. The poster gets 10 karma.' : v.action === 'reject' ? 'Removed. The poster loses 20 karma.' : 'Done', v.action === 'approve' ? 'i-shield' : 'i-check');
      qc.invalidateQueries({ queryKey: ['queue'] }); qc.invalidateQueries({ queryKey: ['popups'] });
    },
    onError,
  });
  if (isPending) return <div className="sk" style={{ height: 300 }} />;
  if (me?.role !== 'admin') return <div className="empty"><Icon name="i-shield" className="i big" /><h2>Admins only</h2><p>This page is for the people who review new posts.</p><Link className="btn sm" to="/">Back to Explore</Link></div>;
  const items = q.data?.items ?? [];
  return (
    <>
      <Link className="btn sm subtle m-only" to="/me" style={{ margin: '-6px 0 8px -10px' }}><Icon name="i-down" className="i" />Back to Me</Link>
      <div className="eyebrow">Admin</div><h1>Review queue</h1>
      <p className="intro">New posts below trust 50, posts the community voted down, and posts with several reports. Your decision overrides community votes.</p>
      <div className="lh"><h2>{items.length} to review</h2><span className="muted small">Target: under 12 hours</span></div>
      {q.isPending ? <div className="sk" style={{ height: 200 }} /> : items.length ? (
        <div className="stack">{items.map(p => (
          <div className="qitem" key={p.id}>
            <Cover p={p} className="sw" />
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="row" style={{ gap: 6 }}><StatusTag status={p.status} /></div>
              <h3 style={{ fontFamily: 'var(--display)', fontSize: 17, fontWeight: 800 }}><a href={`/p/${p.slug}`} style={{ color: 'var(--ink)' }} onClick={e => { e.preventDefault(); open(p.slug); }}>{p.title}</a></h3>
              <div className="small muted">{p.location.borough ?? 'London'} · {dateRange(p)} · by <b>{p.poster.name ?? 'a member'}</b> (karma {p.poster.karma}, {p.poster.account_age_days} days)</div>
              <div className="row" style={{ gap: 6 }}>{p.flags.map(f => <span key={f} className="tag t-err"><Icon name="i-flag" />{FLAG_TEXT[f] ?? f}{f === 'reported' ? ` (${p.open_reports})` : ''}</span>)}</div>
            </div>
            <div className="qactions">
              {p.status === 'hidden' ? <button className="btn sm" onClick={() => decide.mutate({ id: p.id, action: 'restore' })}>Restore</button> : null}
              <button className="btn sm primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, action: 'approve' })}><Icon name="i-shield" />Verify</button>
              <button className="btn sm danger" disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, action: 'reject' })}><Icon name="i-x" />Remove</button>
            </div>
          </div>
        ))}</div>
      ) : <div className="empty"><Icon name="i-checkc" className="i big" /><h2>All clear</h2><p>Nothing waiting for review.</p></div>}
    </>
  );
}

export function NotFound() {
  return (
    <div className="empty" style={{ marginTop: 24 }}>
      <Icon name="i-map" className="i big" />
      <h2>We could not find that page</h2>
      <p>The link may be old or mistyped. Pop-ups that ended are still on Explore under All upcoming.</p>
      <Link className="btn primary" to="/">Back to Explore</Link>
    </div>
  );
}

/** Shown instead of the router's default error screen when a page crashes. */
export function CrashPage() {
  const err = useRouteError();
  // After a deploy, old tabs ask for script files that no longer exist.
  const stale = err instanceof Error && /dynamically imported module|Failed to fetch|Importing a module script/i.test(err.message);
  return (
    <div className="crash">
      <div className="panel">
        <Logo />
        <h1 style={{ fontSize: 28 }}>{stale ? 'Spotted has been updated' : 'Something went wrong'}</h1>
        <p className="muted">{stale ? 'Reload the page to get the latest version.' : 'This page hit a problem. Reload to try again. If it keeps happening, go back to Explore.'}</p>
        <div className="row">
          <button className="btn primary" onClick={() => location.reload()}>Reload</button>
          <a className="btn" href="/">Back to Explore</a>
        </div>
      </div>
    </div>
  );
}
