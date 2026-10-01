import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type ApifySummary, type ScoutSource, type SourceKind, type SourceStatus } from '../lib/api';
import { useErrorToast, useToast } from '../lib/hooks';
import { Icon } from '../components/Icon';

// Where the Scout agent looks on each run (SPEC §13.4). Scout can only suggest sources;
// the admin turns them on, pauses them and sets how often each one is checked.

const KINDS: [SourceKind, string, string][] = [
  ['listing', 'Sites', 'Site'], ['venue', 'Venues', 'Venue'], ['brand', 'Brands', 'Brand'], ['social', 'Social', 'Social account'], ['search', 'Searches', 'Web search'],
];
const kindName = (k: SourceKind) => KINDS.find(x => x[0] === k)![2];
const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' });
const KEY = ['scout-sources'];

type SourcesData = { sources: ScoutSource[]; apify?: ApifySummary };

const apifyLine = (a: ApifySummary) => a.configured
  ? `Apify in the last 30 days: US$${a.spent_usd.toFixed(2)} of US$${a.cap_usd.toFixed(2)}. Fetching stops at the limit.`
  : 'Apify is not set up, so Instagram and Threads sources are not fetched yet. Add the APIFY_TOKEN secret to turn them on.';

export function ScoutSources() {
  const q = useQuery({ queryKey: KEY, queryFn: () => api<SourcesData>('/admin/agents/sources') });
  const [kind, setKind] = useState<SourceKind | null>(null);
  const [paused, setPaused] = useState(false);
  const [adding, setAdding] = useState(false);
  const all = q.data?.sources ?? [];
  const suggested = all.filter(s => s.status === 'suggested');
  const pausedCount = all.filter(s => s.status === 'paused').length;
  const shown = all.filter(s => (s.status === 'active' || (paused && s.status === 'paused')) && (!kind || s.kind === kind));
  const on = all.filter(s => s.status === 'active').length;

  return (
    <>
      <div className="lh"><h2>Scout sources</h2>{q.data ? <span className="small muted">{on} on{pausedCount ? `, ${pausedCount} paused` : ''}</span> : null}</div>
      <p className="small muted" style={{ marginTop: -6, marginBottom: 14, maxWidth: '72ch' }}>
        Where Scout looks on each run: sites, venue pages, brands, social accounts and web searches. Each source shows how many drafts it led to and what happened to them, so you can keep the ones that work. Scout can suggest new ones; they wait here for you.
      </p>
      {q.data?.apify && all.some(s => s.kind === 'social') ? <p className="small muted" style={{ marginTop: -6, marginBottom: 14 }}>{apifyLine(q.data.apify)}</p> : null}
      {q.isPending ? <div className="sk-panel"><div className="sk skl" style={{ width: '60%' }} /><div className="sk skl" style={{ width: '80%' }} /></div>
        : q.error ? <div className="empty"><p>{q.error.message}</p><button className="btn sm" onClick={() => q.refetch()}>Try again</button></div>
        : (
          <div className="stack">
            {suggested.length ? (
              <section className="panel" aria-labelledby="src-sug">
                <div className="row"><h3 id="src-sug">Suggested by Scout</h3><span className="tag t-ai"><Icon name="i-sparkle" />{suggested.length}</span></div>
                <ul className="srcs">{suggested.map(s => <SourceRow key={s.id} s={s} />)}</ul>
              </section>
            ) : null}
            <section className="panel" aria-label="Sources">
              <div className="row srcbar">
                <div className="chips">
                  <button className="chip" aria-pressed={!kind} onClick={() => setKind(null)}>All</button>
                  {KINDS.map(([k, label]) => <button key={k} className="chip" aria-pressed={kind === k} onClick={() => setKind(kind === k ? null : k)}>{label}</button>)}
                  {pausedCount ? <button className="chip" aria-pressed={paused} onClick={() => setPaused(p => !p)}>Show paused</button> : null}
                </div>
                <span className="spacer" />
                <button className="btn sm" aria-expanded={adding} onClick={() => setAdding(a => !a)}><Icon name="i-plus" />Add a source</button>
              </div>
              {adding ? <AddSource onDone={() => setAdding(false)} /> : null}
              {shown.length ? <ul className="srcs">{shown.map(s => <SourceRow key={s.id} s={s} />)}</ul>
                : <p className="small muted" style={{ marginTop: 14 }}>No sources here yet. Add one, or pick another filter.</p>}
            </section>
          </div>
        )}
    </>
  );
}

function useUpdate(id: string) {
  const qc = useQueryClient();
  const onError = useErrorToast();
  return useMutation({
    mutationFn: (patch: { status?: SourceStatus; every_days?: number }) => api<ScoutSource>(`/admin/agents/sources/${id}`, { method: 'PATCH', json: patch }),
    onSuccess: s => qc.setQueryData<SourcesData>(KEY, v => v && { ...v, sources: v.sources.map(x => (x.id === s.id ? s : x)) }),
    onError,
  });
}

function Target({ s }: { s: ScoutSource }) {
  if (s.kind === 'search') return <span className="small srcurl">Search for <b>{s.target}</b></span>;
  return <a className="small srcurl" href={s.target} target="_blank" rel="noopener noreferrer">{s.target.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</a>;
}

function Record({ s }: { s: ScoutSource }) {
  const r = s.track_record;
  if (!r.drafts) return <span className="small muted">No drafts yet</span>;
  return (
    <span className="small">
      {r.drafts} {r.drafts === 1 ? 'draft' : 'drafts'}: <b style={{ color: 'var(--eng)' }}>{r.published} published</b>
      {r.rejected ? `, ${r.rejected} rejected` : ''}{r.waiting ? `, ${r.waiting} waiting` : ''}
    </span>
  );
}

function FetchInfo({ s }: { s: ScoutSource }) {
  const f = s.fetch!;
  const r = f.last_run;
  let line: string;
  if (!f.fetchable) line = 'Not fetched. Use an Instagram account, hashtag or place address, or a Threads account address like threads.net/@name.';
  else if (!r) line = 'Not fetched yet.';
  else if (r.status === 'running') line = 'Fetching now.';
  else if (r.status === 'failed') {
    const why = (r.error ?? 'unknown error').replace(/\.+$/, '');
    line = `Last fetch failed: ${why}.${s.status === 'active' ? ' Spotted tries again in 6 hours.' : ''}`;
  }
  else if (r.status === 'skipped_budget') line = 'Skipped. The Apify limit for the last 30 days is used up. Fetching resumes when older spend drops out of that window.';
  else line = `Fetched ${day.format(r.at)}: kept ${r.kept} of ${r.items} posts, US$${r.cost_usd.toFixed(2)}.`;
  return (
    <div className="row srcmeta">
      {f.mode ? <span className="tag t-mute">{f.mode}</span> : null}
      <span className="small muted">{line}</span>
      {f.new_posts ? <span className="small">{f.new_posts} new for Scout</span> : null}
    </div>
  );
}

function SourceRow({ s }: { s: ScoutSource }) {
  const toast = useToast();
  const save = useUpdate(s.id);
  const set = (patch: { status?: SourceStatus; every_days?: number }, done?: string) => save.mutate(patch, { onSuccess: () => done && toast(done) });

  if (s.status === 'suggested') {
    return (
      <li>
        <div className="row" style={{ gap: 8 }}><b>{s.label}</b><span className="tag t-mute">{kindName(s.kind)}</span></div>
        <Target s={s} />
        {s.note ? <p className="small summary">{s.note}</p> : null}
        <div className="row">
          <button className="btn sm primary" disabled={save.isPending} onClick={() => set({ status: 'active' }, `${s.label} is on. Scout checks it from the next run.`)}><Icon name="i-check" />Turn on</button>
          <button className="btn sm subtle" disabled={save.isPending} onClick={() => set({ status: 'rejected' }, 'Suggestion rejected. Scout will not suggest it again.')}><Icon name="i-x" />Reject</button>
        </div>
      </li>
    );
  }
  return (
    <li className={s.status === 'paused' ? 'src off' : 'src'}>
      <div className="srcinfo">
        <div className="row" style={{ gap: 8 }}>
          <b>{s.label}</b><span className="tag t-mute">{kindName(s.kind)}</span>
          {s.status === 'paused' ? <span className="tag t-watch">Paused</span> : null}
        </div>
        <Target s={s} />
        {s.fetch ? <FetchInfo s={s} /> : null}
        <div className="row srcmeta">
          <Record s={s} />
          <span className="small muted">{s.last_checked_at ? `Checked ${day.format(s.last_checked_at)}` : 'Not checked yet'}</span>
        </div>
      </div>
      <div className="row srcctl">
        <div className="stepper" role="group" aria-label={`How often Scout checks ${s.label}`}>
          <button className="btn sm" aria-label="More often" disabled={save.isPending || s.every_days <= 1} onClick={() => set({ every_days: s.every_days - 1 })}>−</button>
          <b className="num">{s.every_days === 1 ? 'Daily' : `Every ${s.every_days} days`}</b>
          <button className="btn sm" aria-label="Less often" disabled={save.isPending || s.every_days >= 60} onClick={() => set({ every_days: s.every_days + 1 })}>+</button>
        </div>
        {s.status === 'paused'
          ? <button className="btn sm" disabled={save.isPending} onClick={() => set({ status: 'active' }, `${s.label} is on again.`)}>Turn on</button>
          : <button className="btn sm subtle" disabled={save.isPending} onClick={() => set({ status: 'paused' }, `${s.label} is paused. Scout skips it until you turn it on.`)}>Pause</button>}
      </div>
    </li>
  );
}

type Errors = Partial<Record<'target' | 'label', string>>;

function AddSource({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const [kind, setKind] = useState<SourceKind>('listing');
  const [target, setTarget] = useState('');
  const [label, setLabel] = useState('');
  const [every, setEvery] = useState(1);
  const [errors, setErrors] = useState<Errors>({});
  const search = kind === 'search';
  const add = useMutation({
    mutationFn: () => api<ScoutSource>('/admin/agents/sources', { method: 'POST', json: { kind, target, label, every_days: every } }),
    onSuccess: s => {
      qc.setQueryData<SourcesData>(KEY, v => v && { ...v, sources: [...v.sources, s] });
      toast(`${s.label} added. Scout checks it on its next run.`);
      onDone();
    },
    onError: e => {
      if (e instanceof ApiError && (e.code === 'target_invalid' || e.code === 'source_exists' || e.code.startsWith('target_'))) setErrors({ target: e.message });
      else if (e instanceof ApiError && e.code.startsWith('label_')) setErrors({ label: e.message });
      else onError(e);
    },
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Errors = {};
    if (!target.trim()) errs.target = search ? 'Type the words Scout should search for.' : 'Paste the web address of the page Scout should check.';
    if (!label.trim()) errs.label = 'Give it a short name, like "Dover Street Market events".';
    setErrors(errs);
    if (!Object.keys(errs).length) add.mutate();
  };
  const err = (k: keyof Errors) => (errors[k] ? <span className="ferr" role="alert">{errors[k]}</span> : null);

  return (
    <form className="srcadd" noValidate onSubmit={submit}>
      <div className="field">
        <span className="lbl">What is it</span>
        <div className="chips">{KINDS.map(([k, , name]) => <button type="button" key={k} className="chip" aria-pressed={kind === k} onClick={() => { setKind(k); setErrors({}); if (k === 'social') setEvery(3); }}>{name}</button>)}</div>
      </div>
      <div className="field">
        <label className="lbl" htmlFor="src-target">{search ? 'Search words' : 'Web address'}</label>
        <input id="src-target" className="input" value={target} maxLength={500} autoComplete="off" inputMode={search ? 'text' : 'url'}
          placeholder={search ? 'site:instagram.com London sample sale' : kind === 'social' ? 'https://www.instagram.com/explore/tags/londonpopup/' : 'https://www.example.com/whats-on'}
          onChange={e => { setTarget(e.target.value); setErrors(x => ({ ...x, target: undefined })); }} aria-invalid={!!errors.target} />
        {err('target') ?? <span className="hint">{search ? 'Scout runs this in its web search. site:instagram.com, site:tiktok.com and site:xiaohongshu.com find public posts.' : kind === 'social' ? 'Spotted fetches these through Apify: an Instagram account, hashtag or place address, or a Threads account (threads.net/@name).' : 'The page that lists pop-ups, like a venue\'s what\'s on page.'}</span>}
      </div>
      <div className="field">
        <label className="lbl" htmlFor="src-label">Name</label>
        <input id="src-label" className="input" value={label} maxLength={80} autoComplete="off" placeholder="Dover Street Market events"
          onChange={e => { setLabel(e.target.value); setErrors(x => ({ ...x, label: undefined })); }} aria-invalid={!!errors.label} />
        {err('label')}
      </div>
      <div className="field">
        <span className="lbl">How often</span>
        <div className="stepper">
          <button type="button" className="btn sm" aria-label="More often" disabled={every <= 1} onClick={() => setEvery(n => n - 1)}>−</button>
          <b className="num">{every === 1 ? 'Daily' : `Every ${every} days`}</b>
          <button type="button" className="btn sm" aria-label="Less often" disabled={every >= 60} onClick={() => setEvery(n => n + 1)}>+</button>
        </div>
      </div>
      <div className="row">
        <button className="btn sm primary" disabled={add.isPending}>{add.isPending ? <span className="spin" /> : <Icon name="i-plus" />}Add source</button>
        <button type="button" className="btn sm subtle" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
