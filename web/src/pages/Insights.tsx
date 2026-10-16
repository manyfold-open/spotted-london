import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, type InsightDays, type Insights } from '../lib/api';
import type { Contributions } from '../../../src/shared/insights';
import { useMe } from '../lib/hooks';
import { Icon } from '../components/Icon';
import { CATS } from '../lib/format';
import { appUrl } from '../lib/base';
import { HealthPanel } from '../components/HealthPanel';

// Admin only. How people use Spotted, as counts: visitors, what they open and save, whether they come back.
// Nothing here says who anyone is. The events are anonymous (src/lib/events.ts); the account counts come from D1.

type Stats = Extract<Insights['events'], { status: 'ok' }>;

const ROUTES: Record<string, string> = { home: 'Explore', popup: 'Shared pop-up link', add: 'Add a pop-up', saved: 'Saved', me: 'Me', connect: 'Use with AI', signin: 'Sign in', other: 'Other' };
const FILTERS: Record<string, string> = { 'when:today': 'Today', 'when:weekend': 'This weekend', 'when:all': 'Any date', 'when:week': 'Next 7 days', 'verified:1': 'Verified only' };
const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmt = (n: number) => Math.round(n).toLocaleString('en-GB');
const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '0%');

const filterLabel = (k: string) => FILTERS[k] ?? (k.startsWith('cat:') ? `Category: ${CATS[k.slice(4) as keyof typeof CATS] ?? k.slice(4)}` : k);

export default function InsightsPage() {
  const { data: me, isPending } = useMe();
  const [days, setDays] = useState<InsightDays>(7);
  const q = useQuery({ queryKey: ['insights', days], queryFn: () => api<Insights>(`/admin/insights?days=${days}`), enabled: me?.role === 'admin', staleTime: 120_000 });
  if (isPending) return <div className="sk" style={{ height: 160, borderRadius: 16 }} />;
  if (me?.role !== 'admin') return <div className="empty"><Icon name="i-shield" className="i big" /><h2>Admins only</h2><p>This page shows how people use Spotted.</p><Link className="btn sm" to="/">Back to Explore</Link></div>;
  const d = q.data;
  return (
    <>
      <Link className="btn sm subtle m-only" to="/me" style={{ margin: '-6px 0 8px -10px' }}><Icon name="i-left" className="i" />Back to Me</Link>
      <div className="eyebrow">Admin</div><h1>Insights</h1>
      <p className="intro">How people use Spotted, as counts. Nothing here says who anyone is: visitors are a random id kept on their own device, and admins are not counted. People who switch stats off on the Me page, or whose browser says Do Not Track, are not counted either.</p>
      <div className="row ins-bar">
        <div className="chips" role="group" aria-label="Time range">
          {([7, 30] as const).map(n => <button key={n} className="chip" aria-pressed={days === n} onClick={() => setDays(n)}>Last {n} days</button>)}
        </div>
        <span className="small muted">{d ? `Updated ${clock.format(d.updated_at)}. ` : ''}Refreshes every 5 minutes.</span>
      </div>
      <HealthPanel />
      {q.isPending ? <div className="sk" style={{ height: 220, borderRadius: 16, marginTop: 18 }} /> : q.isError || !d ? (
        <div className="empty" style={{ marginTop: 18 }}><p>{q.error?.message ?? 'Could not load the numbers.'}</p><button className="btn sm" onClick={() => q.refetch()}>Try again</button></div>
      ) : (
        <>
          {d.events.status === 'ok' ? <Visitors e={d.events} days={d.days} /> : <Setup events={d.events} retry={() => q.refetch()} />}
          <Accounts a={d.accounts} days={d.days} />
          {d.contributions ? <ContributionsPanel c={d.contributions} accounts={d.accounts.total} days={d.days} /> : null}
          {d.events.status === 'ok' ? <Behaviour e={d.events} /> : null}
        </>
      )}
    </>
  );
}

function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return <div className="kpi"><span className="eyebrow">{label}</span><b className="num">{value}</b>{sub ? <span className="small muted">{sub}</span> : null}</div>;
}

/** Rows with a bar behind the number, longest first. `max` is the biggest value, so rows compare with each other. */
function Rows({ rows, label }: { rows: { key: string; label: ReactNode; n: number; extra?: string }[]; label: string }) {
  const max = Math.max(1, ...rows.map(r => r.n));
  if (!rows.length) return <p className="muted" style={{ marginTop: 8 }}>Nothing yet.</p>;
  return (
    <ul className="ins-rows" aria-label={label}>
      {rows.map(r => (
        <li key={r.key}>
          <span className="ins-name">{r.label}</span>
          <span className="meter" aria-hidden="true"><i style={{ width: `${Math.max(3, (r.n / max) * 100)}%` }} /></span>
          <b className="num">{fmt(r.n)}</b>{r.extra ? <span className="small muted ins-extra">{r.extra}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function Visitors({ e, days }: { e: Stats; days: number }) {
  const peak = Math.max(1, ...e.daily.map(x => x.visitors));
  const back = e.retention;
  return (
    <>
      <div className="kpis ins-kpis">
        <Kpi label="Visitors" value={fmt(e.visitors)} sub={`last ${days} days`} />
        <Kpi label="Visits" value={fmt(e.visits)} sub={`${fmt(e.views)} page views`} />
        <Kpi label="Signed in" value={pct(e.signed_in_visitors, e.visitors)} sub={`${fmt(e.signed_in_visitors)} visitors`} />
        <Kpi label="Came back" value={back.rate === null ? 'Not yet' : pct(back.came_back, back.last_week)} sub={back.rate === null ? 'needs 2 weeks of data' : `of last week's ${fmt(back.last_week)} visitors`} />
      </div>
      <section className="panel ins-panel" aria-labelledby="in-days">
        <h2 id="in-days">Visitors each day</h2>
        <div className="ins-chart" role="img" aria-label={`Visitors each day, busiest day ${fmt(peak)}`}>
          {e.daily.map(x => <div key={x.day} className="ins-col" title={`${day.format(new Date(x.day))}: ${fmt(x.visitors)} visitors, ${fmt(x.views)} page views`}><i style={{ height: `${Math.max(2, (x.visitors / peak) * 100)}%` }} /></div>)}
        </div>
        <div className="row small muted" style={{ justifyContent: 'space-between' }}><span>{day.format(new Date(e.daily[0]!.day))}</span><span>{day.format(new Date(e.daily.at(-1)!.day))} · busiest {fmt(peak)}</span></div>
        <p className="small muted" style={{ marginTop: 8 }}>Days are UTC. A visitor is a browser, so one person on two devices counts twice. Counts are estimates once traffic is high.</p>
      </section>
    </>
  );
}

function Accounts({ a, days }: { a: Insights['accounts']; days: number }) {
  const act = a.actions;
  return (
    <section className="panel ins-panel" aria-labelledby="in-acc">
      <h2 id="in-acc">Accounts and actions</h2>
      <p className="muted" style={{ marginTop: 6 }}>{fmt(a.total)} accounts in all, {fmt(a.new_in_period)} new in the last {days} days. These counts come from the database, so they include everything since the start.</p>
      <ul className="ins-facts">
        <li><b className="num">{fmt(act.saves)}</b> {act.saves === 1 ? 'pop-up' : 'pop-ups'} saved</li>
        <li><b className="num">{fmt(act.votes)}</b> {act.votes === 1 ? 'vote' : 'votes'}</li>
        <li><b className="num">{fmt(act.checkins)}</b> {act.checkins === 1 ? 'check-in' : 'check-ins'}</li>
        <li><b className="num">{fmt(act.reports)}</b> {act.reports === 1 ? 'report' : 'reports'}</li>
        <li><b className="num">{fmt(act.popups_added)}</b> {act.popups_added === 1 ? 'pop-up' : 'pop-ups'} added by people</li>
        <li><b className="num">{fmt(act.asks)}</b> Ask {act.asks === 1 ? 'question' : 'questions'}</li>
      </ul>
      <h3 style={{ marginTop: 16 }}>Most saved right now</h3>
      <Rows label="Most saved pop-ups" rows={a.most_saved.map(m => ({ key: m.slug, label: <a href={appUrl(`/p/${m.slug}`)} target="_blank" rel="noopener">{m.title}</a>, n: m.saves }))} />
    </section>
  );
}

const wait = (h: number | null) => (h === null ? 'No first action yet' : h < 1 ? 'under an hour' : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`);
const per = (n: number, of: number) => (of > 0 ? (n / of).toFixed(1) : '0');

/** What people give back: who contributes, how much, whether it sticks, and whether the list is being vouched for. */
function ContributionsPanel({ c, accounts, days }: { c: Contributions; accounts: number; days: number }) {
  const { activation: act, repeat, coverage, origin, posts, spread, by_kind: kinds } = c;
  const noOpens = origin.people.opens === null;
  const supply = (rows: Contributions['by_category'], name: (k: string) => string) =>
    rows.map(r => ({ key: r.key, label: name(r.key), n: r.saves, extra: `${fmt(r.live)} on the list${r.opens === null ? '' : `, ${fmt(r.opens)} opens`}, ${fmt(r.saves)} saved` }));
  return (
    <section className="panel ins-panel" aria-labelledby="in-con">
      <h2 id="in-con">Contributions</h2>
      <p className="muted" style={{ marginTop: 6 }}>What signed-in people did in the last {days} days: saved, voted, checked in, reported or added a pop-up. Counts only, never who. Agents and system accounts are left out.</p>
      <div className="kpis ins-kpis">
        <Kpi label="Contributors" value={fmt(c.contributors)} sub={`of ${fmt(accounts)} accounts`} />
        <Kpi label="Came back" value={repeat.rate === null ? 'Not yet' : pct(repeat.came_back, repeat.last_period)} sub={repeat.rate === null ? 'needs 5 people in the period before' : `of ${fmt(repeat.last_period)} active the period before`} />
        <Kpi label="New accounts that acted" value={act.new_accounts ? pct(act.acted, act.new_accounts) : 'None new'} sub={act.new_accounts ? `${fmt(act.acted)} of ${fmt(act.new_accounts)}. First action after ${wait(act.median_hours)}` : `no sign-ups in ${days} days`} />
        <Kpi label="Vouched for" value={coverage.live ? pct(coverage.checked, coverage.live) : 'None live'} sub={`${fmt(coverage.checked)} of ${fmt(coverage.live)} live pop-ups have a vote or a check-in`} />
      </div>

      <h3 style={{ marginTop: 16 }}>What people did</h3>
      <p className="small muted">Different people who did each thing at least once.</p>
      <Rows label="People per kind of action" rows={[
        { key: 'saves', label: 'Saved a pop-up', n: kinds.saves }, { key: 'votes', label: 'Voted', n: kinds.votes }, { key: 'checkins', label: 'Checked in', n: kinds.checkins },
        { key: 'reports', label: 'Reported a problem', n: kinds.reports }, { key: 'posts', label: 'Added a pop-up', n: kinds.posts },
      ]} />

      <h3 style={{ marginTop: 16 }}>How much each person does</h3>
      <Rows label="Contributors by number of actions" rows={[
        { key: 'once', label: 'Once', n: spread.once, extra: pct(spread.once, c.contributors) }, { key: 'few', label: '2 to 5 times', n: spread.few, extra: pct(spread.few, c.contributors) },
        { key: 'many', label: '6 times or more', n: spread.many, extra: pct(spread.many, c.contributors) },
      ]} />
      <p className="small muted" style={{ marginTop: 8 }}>{c.top_share === null ? 'The busiest 10% share needs at least 10 contributors.' : `The busiest 10% of contributors did ${pct(c.top_share, 1)} of all actions.`}</p>

      <h3 style={{ marginTop: 16 }}>Pop-ups people added</h3>
      <ul className="ins-facts">
        <li><b className="num">{fmt(posts.total)}</b> added in the last {days} days</li>
        <li><b className="num">{fmt(posts.live)}</b> on the list now, <b className="num">{fmt(posts.verified)}</b> of them verified</li>
        <li><b className="num">{fmt(posts.waiting)}</b> waiting for a check, <b className="num">{fmt(posts.turned_down)}</b> hidden or removed, <b className="num">{fmt(posts.ended)}</b> already over</li>
        <li>{coverage.live ? <><b className="num">{fmt(coverage.by_status.community)}</b> on the list are community posts, <b className="num">{fmt(coverage.by_status.verified_community)}</b> verified by the community, <b className="num">{fmt(coverage.by_status.verified_admin)}</b> by an admin</> : 'No pop-ups on the list right now'}</li>
      </ul>

      <h3 style={{ marginTop: 16 }}>Added by people or by agents</h3>
      <p className="small muted">Pop-ups on the list now. Saves{noOpens ? '' : ' and opens'} are from the last {days} days.</p>
      <ul className="ins-facts">
        {([['People', origin.people], ['Agents', origin.agents]] as const).map(([name, o]) => (
          <li key={name}><b>{name}</b>: <b className="num">{fmt(o.live)}</b> on the list, <b className="num">{per(o.saves, o.live)}</b> saves each{o.opens === null ? '' : <>, <b className="num">{per(o.opens, o.live)}</b> opens each</>}</li>
        ))}
      </ul>

      <h3 style={{ marginTop: 16 }}>What is listed and what people save</h3>
      <p className="small muted">Bars show saves in the last {days} days. If a category has many pop-ups and few saves, or the other way round, that is where Scouts should look.</p>
      <Rows label="Saves by category" rows={supply(c.by_category, k => CATS[k as keyof typeof CATS] ?? k)} />
      <h3 style={{ marginTop: 16 }}>By area</h3>
      <Rows label="Saves by area" rows={supply(c.by_area, k => k)} />
    </section>
  );
}

function Behaviour({ e }: { e: Stats }) {
  const f = (name: string) => e.funnel[name] ?? { n: 0, people: 0 };
  const opened = f('popup_open').people;
  const steps: [string, number][] = [
    ['Opened a pop-up', opened], ['Saved one', f('save').people], ['Voted', f('vote').people], ['Checked in', f('checkin').people],
    ['Shared a link', f('share').people], ['Went to the source or directions', f('outbound').people], ['Asked for recommendations', f('ask_send').people],
  ];
  const sets = f('signin_start').people, done = f('signin_done').people;
  const views = Object.fromEntries(e.pages.map(p => [p.route, p.n]));
  return (
    <>
      <section className="panel ins-panel" aria-labelledby="in-do">
        <h2 id="in-do">What people do</h2>
        <p className="muted" style={{ marginTop: 6 }}>Visitors who did each thing at least once. The share is of visitors who opened a pop-up.</p>
        <Rows label="Visitors per action" rows={steps.map(([label, n]) => ({ key: label, label, n, extra: opened ? pct(n, opened) : undefined }))} />
        <h3 style={{ marginTop: 16 }}>Sign in and add</h3>
        <ul className="ins-facts">
          <li><b className="num">{fmt(sets)}</b> started to sign in, <b className="num">{fmt(done)}</b> came back signed in{sets ? ` (${pct(done, sets)})` : ''}</li>
          <li><b className="num">{fmt(views.add ?? 0)}</b> opened Add a pop-up, <b className="num">{fmt(f('submit_done').n)}</b> posted{views.add ? ` (${pct(f('submit_done').n, views.add)})` : ''}</li>
          <li><b className="num">{fmt(f('search').n)}</b> searches, <b className="num">{fmt(f('filter').n)}</b> filter taps, <b className="num">{fmt(f('pwa_install').n)}</b> installs to the home screen</li>
        </ul>
      </section>

      <section className="panel ins-panel" aria-labelledby="in-pop">
        <h2 id="in-pop">What people open</h2>
        <h3 style={{ marginTop: 10 }}>Pop-ups</h3>
        <Rows label="Most opened pop-ups" rows={e.top_popups.map(p => ({ key: p.slug, label: <a href={appUrl(`/p/${p.slug}`)} target="_blank" rel="noopener">{p.title}</a>, n: p.opens, extra: p.saves ? `${fmt(p.saves)} saved` : undefined }))} />
        <h3 style={{ marginTop: 16 }}>Categories</h3>
        <Rows label="Opens per category" rows={e.categories.map(c => ({ key: c.key, label: CATS[c.key as keyof typeof CATS] ?? c.key, n: c.opens, extra: c.saves ? `${fmt(c.saves)} saved` : undefined }))} />
        <h3 style={{ marginTop: 16 }}>Filters used</h3>
        <Rows label="Filters used" rows={e.filters.map(x => ({ key: x.key, label: filterLabel(x.key), n: x.n }))} />
      </section>

      <section className="panel ins-panel" aria-labelledby="in-from">
        <h2 id="in-from">Where visitors come from</h2>
        <h3 style={{ marginTop: 10 }}>Visits by site</h3>
        <Rows label="Visits by referrer" rows={e.referrers.map(r => ({ key: r.host || 'direct', label: r.host || 'Direct or app', n: r.n }))} />
        <h3 style={{ marginTop: 16 }}>Pages</h3>
        <Rows label="Page views per page" rows={e.pages.map(p => ({ key: p.route, label: ROUTES[p.route] ?? p.route, n: p.n }))} />
        <h3 style={{ marginTop: 16 }}>Countries and devices</h3>
        <Rows label="Visits by country" rows={e.countries.map(c => ({ key: c.code, label: c.code, n: c.n }))} />
        <p className="small muted" style={{ marginTop: 8 }}>{pct(e.devices.mobile, e.devices.mobile + e.devices.desktop)} of visits are on a phone-sized screen.</p>
      </section>
    </>
  );
}

function Setup({ events, retry }: { events: Exclude<Insights['events'], { status: 'ok' }>; retry: () => void }) {
  return (
    <section className="panel ins-panel" aria-labelledby="in-set">
      <h2 id="in-set">{events.status === 'error' ? 'Could not read the visitor numbers' : 'One more step to see visitor numbers'}</h2>
      {events.status === 'error' ? (
        <>
          <p className="muted" style={{ marginTop: 6 }}>{events.message}</p>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={retry}>Try again</button>
        </>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 6 }}>Visits and taps are already being counted. Reading them back needs your Cloudflare account id and a read-only token, kept as secrets. Account numbers below work without this.</p>
          <ol className="ins-steps">
            <li>Open the Cloudflare dashboard. Your <b>Account ID</b> is on the right of the Workers &amp; Pages overview page. Copy it.</li>
            <li>In a terminal in the project, run <code>npx wrangler secret put CF_ACCOUNT_ID</code> and paste the Account ID.</li>
            <li>In Cloudflare, open <b>My Profile</b>, <b>API Tokens</b>, <b>Create Token</b>, then <b>Create Custom Token</b>. Name it Spotted Insights, set Permissions to <b>Account</b>, <b>Account Analytics</b>, <b>Read</b>, and create it. Copy the token once.</li>
            <li>Run <code>npx wrangler secret put CF_ANALYTICS_TOKEN</code> and paste the token. Never paste it into chat.</li>
            <li>Reload this page. Numbers start from the day the first visit was counted.</li>
          </ol>
        </>
      )}
    </section>
  );
}
