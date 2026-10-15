import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type FeatureHealth, type Health, type TestResult } from '../lib/api';

// Admin only. Are Ask and autofill working? Last 14 days from the database, and a button that tries each one now.
// The numbers are counts and times (src/db/health.ts); nothing a visitor typed is kept.

const NAMES = { ask: 'Ask', autofill: 'Autofill', mcp: 'Assistants (MCP)' } as const;
const NOTES = {
  ask: 'Questions typed into Ask. Failed means the Concierge did not answer, or not in a form Spotted can read.',
  autofill: 'Pasted links, text and screenshots on the Add page. Failed means the AI did not work. A page that blocks us, or text with nothing in it, is counted as "not ours".',
  mcp: 'Searches and lookups that visitors\' own AI assistants make through the Use with AI page. Failed means a tool broke on our side. A bad request is counted as "not ours", and calls stopped by the rate limit are not counted.',
} as const;
const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const secs = (ms: number | null) => (ms === null ? 'none' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export function HealthPanel() {
  const q = useQuery({ queryKey: ['health'], queryFn: () => api<{ health: Health }>('/admin/health'), staleTime: 60_000 });
  return (
    <section className="panel ins-panel" aria-labelledby="in-health">
      <h2 id="in-health">Are the AI features working?</h2>
      {q.isPending ? <div className="sk" style={{ height: 120, borderRadius: 12, marginTop: 12 }} /> : q.isError ? (
        <p className="muted" style={{ marginTop: 8 }}>{q.error.message} <button className="btn sm" onClick={() => q.refetch()}>Try again</button></p>
      ) : !q.data.health ? (
        <p className="muted" style={{ marginTop: 8 }}>Not set up yet: apply migration 0028 first (see the pull request). Test now works only after that.</p>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 6 }}>The last 14 days, one bar for each day. Green worked, red failed, grey was not ours. Days are London days.</p>
          {q.data.health.features.map(f => <Feature key={f.feature} f={f} />)}
        </>
      )}
    </section>
  );
}

function Feature({ f }: { f: FeatureHealth }) {
  const today = f.days[f.days.length - 1]!;
  const peak = Math.max(1, ...f.days.map(d => d.ok + d.failed + d.other));
  const rate = f.rate_today === null ? 'No calls today' : `${Math.round(f.rate_today * 100)}% worked today`;
  return (
    <div className="hl-feature">
      <div className="row hl-head">
        <h3>{NAMES[f.feature]}</h3>
        <span className={`tag ${f.flagged ? 't-err' : f.rate_today === null ? '' : 't-eng'}`}>{f.flagged ? `${rate}: look into it` : rate}</span>
        <Test f={f} />
      </div>
      <div className="hl-bars" role="img" aria-label={`${NAMES[f.feature]} each day, busiest day ${peak} calls`}>
        {f.days.map(d => {
          const n = d.ok + d.failed + d.other;
          return (
            <div key={d.day} className="hl-col" title={`${day.format(new Date(d.day))}: ${d.ok} worked, ${d.failed} failed, ${d.other} not ours${d.avg_ms === null ? '' : `. Average ${secs(d.avg_ms)}, slowest ${secs(d.max_ms)}`}`}>
              <div style={{ height: `${n ? Math.max(4, (n / peak) * 100) : 0}%` }}>
                {d.failed ? <i className="bad" style={{ flexGrow: d.failed }} /> : null}
                {d.other ? <i className="other" style={{ flexGrow: d.other }} /> : null}
                {d.ok ? <i className="good" style={{ flexGrow: d.ok }} /> : null}
              </div>
            </div>
          );
        })}
      </div>
      <p className="small muted">
        Today: {today.ok} worked, {today.failed} failed{today.other ? `, ${today.other} not ours` : ''}. Average {secs(today.avg_ms)}, slowest {secs(today.ok + today.failed ? today.max_ms : null)}.
        {f.last_error ? <> Last error in these 14 days: <span className="hl-err">{f.last_error}</span></> : null}
      </p>
      <p className="small muted">{NOTES[f.feature]}</p>
    </div>
  );
}

/** The Test now button and the result of the last test. An Ask test waits for the Concierge, so it polls until it is done. */
function Test({ f }: { f: FeatureHealth }) {
  const qc = useQueryClient();
  const [result, setResult] = useState<TestResult | null>(f.test);
  const [error, setError] = useState('');
  useEffect(() => setResult(f.test), [f.test]);
  const pending = result?.ok === null && result.id;

  const run = useMutation({
    mutationFn: () => api<{ result: TestResult }>('/admin/health/test', { method: 'POST', json: { feature: f.feature } }),
    onMutate: () => setError(''),
    onSuccess: r => setResult(r.result),
    onError: e => setError(e.message),
  });

  // An Ask test is still waiting: ask how it is doing every 2 seconds, for at most 2 minutes
  useEffect(() => {
    if (!pending || !result?.id) return;
    const id = result.id;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const r = await api<{ result: TestResult | null }>(`/admin/health/test/ask/${id}`);
        if (stopped || !r.result) return;
        setResult(r.result);
        if (r.result.ok !== null) qc.invalidateQueries({ queryKey: ['health'] });
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : 'Could not check the test.'); }
    }, 2000);
    const stop = setTimeout(() => clearInterval(timer), 120_000);
    return () => { stopped = true; clearInterval(timer); clearTimeout(stop); };
  }, [pending, result?.id, qc]);

  const waiting = run.isPending || !!pending;
  return (
    <span className="hl-test">
      <button className="btn sm" onClick={() => run.mutate()} disabled={waiting}>{waiting ? 'Testing...' : 'Test now'}</button>
      <span className="small" aria-live="polite">
        {error ? <span className="hl-err">{error}</span>
          : result && result.ok !== null ? <span className={result.ok ? 'pos' : 'neg'}>{result.ok ? 'Worked' : 'Failed'} at {clock.format(result.at)}{result.ms === null ? '' : `, ${secs(result.ms)}`}. {result.detail}</span>
          : null}
      </span>
    </span>
  );
}
