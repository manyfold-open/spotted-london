import { useEffect, useState } from 'react';
import { Link, useNavigate, useRouteError, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AgentNote, type Popup } from '../lib/api';
import { dateRange, initials, looksLikeEmail } from '../lib/format';
import { useErrorToast, useGate, useMe, useMyState, useSheet, useToast } from '../lib/hooks';
import { mergeMe } from '../lib/cache';
import { useLocalSaves } from '../lib/local-saves';
import { Icon } from '../components/Icon';
import { CardSkeletons, Cover, MAX_CROP_SMALL, PopupCard, StatusTag } from '../components/PopupBits';
import { Turnstile, useNeedsTurnstile, useProviders } from '../components/Turnstile';
import { Logo } from '../components/Shell';
import { flushTaste, forgetTaste } from '../lib/taste';
import { markSigningIn, setTrackingOptOut, trackingOptedOut } from '../lib/track';

/* ---------------- Saved ---------------- */
export function Saved() {
  const { data: me, isPending } = useMe();
  const gate = useGate();
  const local = useLocalSaves();
  const q = useQuery({ queryKey: ['saves'], queryFn: () => api<{ items: Popup[] }>('/me/saves'), enabled: !!me });
  // Signed out: the public list (already loaded for the map) narrowed to what you saved on this device
  const snap = useQuery({ queryKey: ['popups', 'snapshot'], queryFn: () => api<{ items: Popup[] }>('/popups/snapshot', { cache: 'no-cache' }), staleTime: 60_000, enabled: me === null });
  const mine = useMyState();
  const items = me
    ? (q.data?.items ?? []).map(p => ({ ...p, me: { saved: true, existence_vote: 0, quality_vote: 0, ...p.me } }))
    : mergeMe((snap.data?.items ?? []).filter(p => local.some(s => s.id === p.id)), mine);
  const loading = isPending || (me ? q.isPending : snap.isPending);
  const upcoming = items.filter(p => p.end_at >= Date.now());
  const past = items.filter(p => p.end_at < Date.now());
  return (
    <>
      <div className="eyebrow">Your list</div><h1>Saved</h1>
      {me ? <p className="intro">We remind you the day before each one starts, and again on its last day.</p> : null}
      {me === null ? (
        <div className="notice note" style={{ marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <Icon name="i-bookmark" />
          <span style={{ flex: 1, minWidth: 200 }}><b>Saved on this device only.</b> Sign in to keep them on every device and get a reminder the day before each one starts.</span>
          <button className="btn primary sm" onClick={() => gate({ why: 'Sign in to keep your saved list' })}>Sign in</button>
        </div>
      ) : null}
      <div className="lh"><h2>{upcoming.length} coming up</h2></div>
      {loading ? <CardSkeletons n={3} /> : upcoming.length ? <div className="grid">{upcoming.map(p => <PopupCard key={p.id} p={p} />)}</div>
        : <div className="empty"><Icon name="i-bookmark" className="i big" /><h2>Nothing saved yet</h2><p>Tap the bookmark on any pop-up to keep it here.{me === null ? ' No account needed.' : ''}</p><Link className="btn sm" to="/">Explore pop-ups</Link></div>}
      {past.length ? <><div className="lh"><h2>Already ended</h2></div><div className="grid">{past.map(p => <PopupCard key={p.id} p={p} />)}</div></> : null}
    </>
  );
}

/** A whole page that needs an account (Add a pop-up, Me): the Google button is right here, one tap. */
export function SignInPrompt({ title, text, to }: { title: string; text: string; to: string }) {
  const providers = useProviders();
  const p = providers.data;
  const back = encodeURIComponent(to);
  return (
    <div className="auth panel">
      <h1 style={{ fontSize: 28 }}>{title}</h1>
      <p className="muted" style={{ margin: '8px 0 18px' }}>{text}</p>
      <div className="stack">
        {p?.google ? <a className="btn primary block" href={`/api/v1/auth/google?return_to=${back}`} onClick={() => markSigningIn('page')}>Continue with Google</a> : null}
        {!p || p.email || !p.google ? <Link className={`btn block ${p?.google ? '' : 'primary'}`} to={`/signin?return_to=${back}`}>{p?.google ? 'Use email instead' : 'Sign in'}</Link> : null}
        <Link className="btn subtle block" to="/">Keep browsing</Link>
      </div>
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
    onSuccess: () => markSigningIn('email'),
    onError: e => { onError(e); setBotReset(n => n + 1); },
  });
  if (me) {
    return <div className="auth panel"><h1 style={{ fontSize: 28 }}>You are signed in</h1><p className="muted" style={{ margin: '8px 0 18px' }}>as {me.email}</p><Link className="btn primary block" to={returnTo}>Continue</Link></div>;
  }
  return (
    <div className="auth panel">
      <h1 style={{ fontSize: 28 }}>Sign in</h1>
      <p className="muted" style={{ margin: '8px 0 18px' }}>{providers.data && !providers.data.email ? 'Sign in with your Google account. No password to remember.' : 'No password. We email you a link that signs you in.'}</p>
      {providers.isPending ? <div className="sk" style={{ height: 44, borderRadius: 999 }} /> : null}
      {providers.data && !providers.data.email && !providers.data.google ? (
        <div className="notice watch"><Icon name="i-clock" /><span>Sign in is not switched on yet. You can still browse every pop-up.</span></div>
      ) : providers.data && !providers.data.email ? null : send.isSuccess ? (
        <div className="stack">
          <div className="notice good"><Icon name="i-mail" /><span>{send.data.message}</span></div>
          {send.data.dev_link ? <a className="btn block" href={send.data.dev_link}>Development: open the sign-in link</a> : null}
          <button className="btn subtle" onClick={() => send.reset()}>Use a different email</button>
        </div>
      ) : providers.data ? (
        <form className="stack" noValidate onSubmit={e => { e.preventDefault(); if (!looksLikeEmail(email)) return setBad(true); send.mutate(); }}>
          <label className="field"><span className="lbl">Email</span>
            <input className={`input ${bad ? 'bad' : ''}`} type="email" autoComplete="email" inputMode="email" value={email} onChange={e => { setEmail(e.target.value); setBad(false); }}
              placeholder="you@email.com" aria-invalid={bad} aria-describedby={bad ? 'emailerr' : undefined} />
            {bad ? <span className="ferr" id="emailerr" role="alert">Enter an email address like name@example.com.</span> : null}</label>
          <Turnstile onToken={setBotToken} resetKey={botReset} />
          <button className="btn primary block" disabled={send.isPending || (needsBot && !botToken)}>{send.isPending ? <span className="spin" /> : <Icon name="i-mail" />}Email me a link</button>
        </form>
      ) : null}
      {providers.data?.google ? (
        <>
          {providers.data.email ? <div className="row" style={{ margin: '16px 0' }}><span className="spacer" style={{ borderTop: '1.5px dashed var(--hair)' }} /><span className="small muted">or</span><span className="spacer" style={{ borderTop: '1.5px dashed var(--hair)' }} /></div> : null}
          <a className={`btn block ${providers.data.email ? '' : 'primary'}`} href={`/api/v1/auth/google?return_to=${encodeURIComponent(returnTo)}`} onClick={() => markSigningIn('page')}>Continue with Google</a>
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
    mutationFn: async () => { await flushTaste(); return api('/auth/logout', { method: 'POST' }); },
    onSuccess: () => { forgetTaste(); qc.clear(); nav('/'); toast('Signed out'); },
    onError,
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [statsOff, setStatsOff] = useState(trackingOptedOut);
  const del = useMutation({
    mutationFn: async () => {
      await api('/me', { method: 'DELETE' });
      await api('/auth/logout', { method: 'POST' }).catch(() => {}); // the account is gone either way: this only clears the cookie
    },
    onSuccess: () => { forgetTaste(); qc.clear(); nav('/'); toast('Your account is deleted', 'i-check'); },
    onError,
  });
  const newsletter = useMutation({ mutationFn: () => api('/newsletter/subscribe', { method: 'POST', json: { email: me!.email } }), onSuccess: () => toast('Check your inbox to confirm', 'i-mail'), onError });

  if (isPending) return <MeSkeleton />;
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
        {me.role === 'admin' ? <Link className="mrow" to="/admin/insights"><Icon name="i-list" /><span>Insights<span className="sub">Visitors, what they open and save, how they come back</span></span><Icon name="i-down" className="i chev" /></Link> : null}
        {me.role === 'admin' ? <Link className="mrow" to="/admin/agent"><Icon name="i-sparkle" /><span>Agents<span className="sub">AI helpers that find, check and flag pop-ups</span></span><Icon name="i-down" className="i chev" /></Link> : null}
        <Link className="mrow" to="/connect"><Icon name="i-sparkle" /><span>Use with your AI<span className="sub">Ask ChatGPT, Claude or Codex what is on</span></span><Icon name="i-down" className="i chev" /></Link>
        <button className="mrow" onClick={() => newsletter.mutate()} disabled={newsletter.isPending || newsletter.isSuccess}><Icon name="i-mail" /><span>Weekend newsletter<span className="sub">{newsletter.isSuccess ? 'Confirmation email sent' : `Send it to ${me.email}`}</span></span><Icon name="i-down" className="i chev" /></button>
        <div className="mrow static"><Icon name="i-bell" /><span>Reminders<span className="sub">Emailed the day before a saved pop-up starts, and on its last day</span></span></div>
        <button className="mrow" role="switch" aria-checked={!statsOff} onClick={() => { setTrackingOptOut(!statsOff); setStatsOff(trackingOptedOut()); }}><Icon name="i-info" /><span>Anonymous usage stats<span className="sub">{statsOff ? 'Off on this device. Nothing is counted.' : 'On. Counts visits and taps, never who you are.'}</span></span></button>
        <button className="mrow" onClick={() => logout.mutate()}><Icon name="i-x" /><span>Sign out</span></button>
        <button className="mrow" aria-expanded={confirmDelete} onClick={() => setConfirmDelete(v => !v)}><Icon name="i-flag" /><span>Delete account<span className="sub">Removes your email, name and saved list</span></span></button>
      </div>
      {confirmDelete ? (
        <div className="notice err" role="alertdialog" aria-labelledby="del-t" style={{ marginTop: 12, flexDirection: 'column', alignItems: 'stretch' }}>
          <b id="del-t">Delete your account?</b>
          <span>We remove your email, name and saved list and sign you out for good. Pop-ups you added stay on Spotted without your name, because other people have voted on them. This cannot be undone.</span>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn danger" disabled={del.isPending} onClick={() => del.mutate()}>{del.isPending ? <span className="spin" /> : null}Yes, delete my account</button>
            <button className="btn" disabled={del.isPending} onClick={() => setConfirmDelete(false)}>Keep my account</button>
          </div>
        </div>
      ) : null}

      <div className="lh"><h2>Your pop-ups</h2></div>
      {mine.data?.items.length ? (
        <div className="stack">{mine.data.items.map(p => (
          <Link key={p.id} to={`/p/${p.slug}`} className="mini" onClick={e => { e.preventDefault(); open(p.slug, e.currentTarget.querySelector('.sw')); }}>
            <Cover p={p} className="sw" fit={MAX_CROP_SMALL} />
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
type QueueItem = Popup & { poster: { id: string; name: string | null; karma: number; account_age_days: number }; open_reports: number; flags: string[]; agent_notes: AgentNote[]; ready_to_publish?: boolean };
const FLAG_TEXT: Record<string, string> = { no_source_link: 'No source link', new_account: 'New account', reported: 'Reported', community_hidden: 'Hidden by votes', by_agent: 'Found by an agent' };
const VERDICT: Record<string, [string, string]> = {
  looks_real: ['Looks real', 't-eng'], needs_check: ['Needs a check', 't-watch'], likely_fake: ['Likely fake', 't-err'],
  duplicate: ['Duplicate', 't-err'], details_changed: ['Details changed', 't-watch'], cancelled: ['Cancelled', 't-err'], out_of_scope: ['Not a pop-up', 't-err'],
};
const AGENT_NAME: Record<string, string> = { scout: 'Scout', triage: 'Triage', checker: 'Checker' };

function AgentNotes({ notes, onDismiss, busy }: { notes: AgentNote[]; onDismiss: (id: string) => void; busy: boolean }) {
  const { open } = useSheet();
  return (
    <div className="anotes">{notes.map(n => (
      <div key={n.id} className="anote">
        <div className="row" style={{ gap: 6 }}>
          <span className="tag t-ai"><Icon name="i-sparkle" />{n.agent_name ?? AGENT_NAME[n.agent_id] ?? n.agent_id}</span>
          <span className={`tag ${VERDICT[n.verdict]?.[1] ?? 't-mute'}`}>{VERDICT[n.verdict]?.[0] ?? n.verdict}</span>
          {n.publish_ready ? <span className="tag t-eng"><Icon name="i-checkc" />Ready to publish</span> : null}
        </div>
        <p className="small">{n.note}</p>
        {n.evidence ? <p className="small muted">Quote: &ldquo;{n.evidence}&rdquo;</p> : null}
        <div className="row small" style={{ gap: 12 }}>
          {n.evidence_url ? <a href={n.evidence_url} target="_blank" rel="noopener noreferrer"><Icon name="i-ext" className="i" /> Source</a> : null}
          {n.duplicate_of ? <a href={`/p/${n.duplicate_of}`} onClick={e => { e.preventDefault(); open(n.duplicate_of!); }}>Open the original</a> : null}
          <span className="spacer" />
          <button className="btn sm subtle" disabled={busy} onClick={() => onDismiss(n.id)}>Dismiss</button>
        </div>
      </div>
    ))}</div>
  );
}

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
  const publishReady = useMutation({
    mutationFn: () => api<{ published: number }>('/admin/queue/publish-ready', { method: 'POST', json: {} }),
    onSuccess: r => { toast(r.published === 1 ? '1 post published. Votes and reports still apply.' : `${r.published} posts published. Votes and reports still apply.`, 'i-checkc'); qc.invalidateQueries({ queryKey: ['queue'] }); qc.invalidateQueries({ queryKey: ['popups'] }); },
    onError,
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api(`/admin/agents/notes/${id}/dismiss`, { method: 'POST' }),
    onSuccess: () => { toast('Note dismissed'); qc.invalidateQueries({ queryKey: ['queue'] }); },
    onError,
  });
  if (isPending) return <QueueSkeleton />;
  if (me?.role !== 'admin') return <div className="empty"><Icon name="i-shield" className="i big" /><h2>Admins only</h2><p>This page is for the people who review new posts.</p><Link className="btn sm" to="/">Back to Explore</Link></div>;
  const items = q.data?.items ?? [];
  const ready = items.filter(p => p.ready_to_publish).length;
  return (
    <>
      <Link className="btn sm subtle m-only" to="/me" style={{ margin: '-6px 0 8px -10px' }}><Icon name="i-left" className="i" />Back to Me</Link>
      <div className="eyebrow">Admin</div><h1>Review queue</h1>
      <p className="intro">New posts below trust 50, posts the community voted down, posts with several reports, and anything an <Link to="/admin/agent">agent</Link> flagged. Your decision overrides community votes.</p>
      <div className="lh"><h2>{items.length} to review</h2><span className="muted small">Target: under 12 hours</span></div>
      {ready ? (
        <div className="notice" style={{ marginBottom: 14 }}>
          <Icon name="i-sparkle" />
          <span>{ready === 1 ? '1 post was checked by a second agent against its source and is ready to publish.' : `${ready} posts were checked by a second agent against their sources and are ready to publish.`} They go live as community posts, so votes and reports still apply.</span>
          <button className="btn sm primary" disabled={publishReady.isPending} onClick={() => publishReady.mutate()}>{publishReady.isPending ? <span className="spin" /> : <Icon name="i-checkc" />}Publish {ready}</button>
        </div>
      ) : null}
      {q.isPending ? <QueueSkeleton list /> : items.length ? (
        <div className="stack">{items.map(p => (
          <div className="qitem" key={p.id}>
            <Cover p={p} className="sw" fit={MAX_CROP_SMALL} />
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="row" style={{ gap: 6 }}><StatusTag status={p.status} />{p.ready_to_publish ? <span className="tag t-eng"><Icon name="i-checkc" />Ready to publish</span> : null}</div>
              <h3 style={{ fontFamily: 'var(--display)', fontSize: 17, fontWeight: 800 }}><a href={`/p/${p.slug}`} style={{ color: 'var(--ink)' }} onClick={e => { e.preventDefault(); open(p.slug); }}>{p.title}</a></h3>
              <div className="small muted">{p.location.borough ?? 'London'} · {dateRange(p)} · by <b>{p.poster.name ?? 'a member'}</b> (karma {p.poster.karma}, {p.poster.account_age_days} days)</div>
              <div className="row" style={{ gap: 6 }}>{p.flags.map(f => <span key={f} className={`tag ${f === 'by_agent' ? 't-ai' : 't-err'}`}><Icon name={f === 'by_agent' ? 'i-sparkle' : 'i-flag'} />{FLAG_TEXT[f] ?? f}{f === 'reported' ? ` (${p.open_reports})` : ''}</span>)}</div>
              {p.agent_notes?.length ? <AgentNotes notes={p.agent_notes} busy={dismiss.isPending} onDismiss={id => dismiss.mutate(id)} /> : null}
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

function MeSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading your profile">
      <div className="hero-me"><div className="avatar sk" style={{ border: 0 }} /><div className="sk-block" style={{ flex: 1 }}><div className="sk skl" style={{ width: 130 }} /><div className="sk" style={{ height: 30, width: '55%' }} /></div></div>
      <div className="kpis">{Array.from({ length: 4 }, (_, i) => <div key={i} className="sk-panel" style={{ padding: '14px 16px' }}><div className="sk skl" style={{ width: '60%' }} /><div className="sk" style={{ height: 28, width: '40%' }} /></div>)}</div>
      <div className="sk-panel" style={{ marginTop: 28, height: 220 }} />
    </div>
  );
}

function QueueSkeleton({ list }: { list?: boolean }) {
  const rows = <div className="stack">{Array.from({ length: 3 }, (_, i) => (
    <div key={i} className="qitem skc"><div className="sw sk" /><div className="sk-block"><div className="sk skl pill" /><div className="sk skl h" style={{ width: '70%' }} /><div className="sk skl" style={{ width: '85%' }} /></div></div>
  ))}</div>;
  if (list) return rows;
  return <div aria-busy="true" aria-label="Loading the review queue"><div className="sk skl" style={{ width: 80 }} /><div className="sk" style={{ height: 40, width: 260, margin: '10px 0 28px' }} />{rows}</div>;
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

/** Old tabs and installed apps ask for script or style files that a deploy has removed. */
const STALE = /dynamically imported module|Importing a module script|Unable to preload|Failed to fetch|Load failed/i;
const RELOADED = 'spotted.crash-reload';

/** Forgets the service worker and its saved files, then loads the app fresh from the network. */
async function resetAndReload() {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all((regs ?? []).map(r => r.unregister()));
    await Promise.all((await caches.keys()).map(k => caches.delete(k)));
  } catch { /* no service worker or no cache storage: a plain reload is all there is */ }
  location.reload();
}

/** Shown instead of the router's default error screen when a page crashes. */
export function CrashPage() {
  const err = useRouteError();
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const stale = STALE.test(detail);
  useEffect(() => {
    console.error(err);
    // Once per tab, a stale app fixes itself. If it crashes again the page below stays put.
    if (!stale) return;
    try { if (sessionStorage.getItem(RELOADED)) return; sessionStorage.setItem(RELOADED, '1'); } catch { return; }
    void resetAndReload();
  }, [err, stale]);
  return (
    <div className="crash">
      <div className="panel">
        <Logo />
        <h1 style={{ fontSize: 28 }}>{stale ? 'Spotted has been updated' : 'Something went wrong'}</h1>
        <p className="muted">{stale ? 'Reload the page to get the latest version.' : 'This page hit a problem. Reload to try again. If it keeps happening, go back to Explore.'}</p>
        <div className="row">
          <button className="btn primary" onClick={() => void resetAndReload()}>Reload</button>
          <a className="btn" href="/">Back to Explore</a>
        </div>
        <p className="small muted" style={{ overflowWrap: 'anywhere' }}>{detail.slice(0, 300)}</p>
      </div>
    </div>
  );
}
