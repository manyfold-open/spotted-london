import { lazy, Suspense, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Category, type Place, type Popup } from '../lib/api';
import { popupQuery } from '../lib/cache';
import { CAT_LIST, CATS, catIcon, londonDate, londonTs } from '../lib/format';
import { useDebounced, useErrorToast, useToast } from '../lib/hooks';
import { DatePicker } from './DatePicker';
import { ExtraDates } from './ExtraDates';
import { datesProblem, rangesPayload, rowsOf, type DateRow } from '../lib/date-rows';
import { Icon } from './Icon';

const PinPicker = lazy(() => import('./maps').then(m => ({ default: m.PinPicker })));

type DateMode = 'dates' | 'no_end' | 'no_dates';
const today = () => londonDate(Date.now());

/**
 * Admin only: fix the details of a pop-up before or after deciding on it, so a post with one wrong line (an address,
 * a date, a price) does not have to be removed. It saves with PATCH /popups/:id, which already lets an admin edit any
 * post; the server keeps the old values in the audit log and does not change the status, so approving stays a separate
 * step. Moving the pin or the dates clears the "it's real" votes, as for any edit.
 */
export function EditPanel({ slug, onDone, onCancel }: { slug: string; onDone: () => void; onCancel: () => void }) {
  const full = useQuery(popupQuery(slug));
  if (full.isPending) return <div className="panel"><div className="sk" style={{ height: 220 }} aria-busy="true" aria-label="Loading the pop-up" /></div>;
  if (!full.data) return <div className="panel"><p className="small muted">This pop-up could not be loaded. Close this and try again.</p></div>;
  return <EditForm p={full.data} onDone={onDone} onCancel={onCancel} />;
}

function EditForm({ p, onDone, onCancel }: { p: Popup; onDone: () => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const [title, setTitle] = useState(p.title);
  const [host, setHost] = useState(p.host ?? '');
  const [category, setCategory] = useState<Category>(p.category);
  const [whereText, setWhereText] = useState(p.location.address ?? '');
  const [place, setPlace] = useState<Place | null>({ label: p.location.address ?? '', name: null, address: p.location.address ?? '', area: p.location.borough, lat: p.location.lat, lng: p.location.lng });
  const [dateMode, setDateMode] = useState<DateMode>(p.date_kind === 'undated' ? 'no_dates' : p.date_kind === 'open_end' ? 'no_end' : 'dates');
  // With several ranges, start_at and end_at are the whole span: the first range is the first one in the list.
  const first = p.ranges?.[0] ?? [p.start_at, p.end_at];
  const [start, setStart] = useState(p.date_kind === 'undated' ? today() : londonDate(first[0]));
  const [end, setEnd] = useState(p.date_kind === 'undated' || p.date_kind === 'open_end' ? today() : londonDate(first[1]));
  const [moreDates, setMoreDates] = useState<DateRow[]>(() => rowsOf(p));
  const [hours, setHours] = useState(p.hours_text ?? '');
  const [priceType, setPriceType] = useState<'free' | 'paid' | 'unknown'>((p.price.type as 'free' | 'paid' | 'unknown' | null) ?? 'unknown');
  const [price, setPrice] = useState(p.price.text ?? '');
  const [desc, setDesc] = useState(p.description ?? '');
  const [src, setSrc] = useState(p.source_url ?? '');
  const [error, setError] = useState<string | null>(null);

  /* ----- address search, as on the Add page ----- */
  const [suggestOpen, setSuggestOpen] = useState(false);
  const dq = useDebounced(whereText, 350);
  const suggest = useQuery({
    queryKey: ['geocode', dq],
    queryFn: () => api<{ items: Place[] }>(`/geocode?q=${encodeURIComponent(dq)}`),
    enabled: dq.trim().length >= 3 && !place,
    staleTime: 86_400_000,
  });
  const pickPlace = (x: Place) => { setPlace(x); setWhereText(x.label); setSuggestOpen(false); };
  const movePin = async (lat: number, lng: number) => {
    setPlace(x => (x ? { ...x, lat, lng } : x));
    try {
      const r = await api<Place>(`/geocode/reverse?lat=${lat}&lng=${lng}`);
      setPlace(r); setWhereText(r.label);
    } catch { /* keep the moved pin even if the address lookup fails */ }
  };
  useEffect(() => { setError(null); }, [title, whereText, place, dateMode, start, end, moreDates, src]);

  const save = useMutation({
    mutationFn: () => api<Popup & { votes_reset?: boolean }>(`/popups/${p.id}`, {
      method: 'PATCH',
      json: {
        title: title.trim(), host: host.trim() || null, category, description: desc.trim() || null,
        address: place!.address, borough: place!.area, lat: place!.lat, lng: place!.lng,
        start_at: dateMode === 'no_dates' ? null : londonTs(start, 0), end_at: dateMode === 'dates' ? londonTs(end, 23, 59) : null,
        ranges: dateMode === 'dates' ? rangesPayload(start, end, moreDates) : null,
        hours_text: hours.trim() || null, price_type: priceType, price_text: price.trim() || null, source_url: src.trim() || null,
      },
    }),
    onSuccess: r => {
      toast(r.votes_reset ? 'Saved. The place or dates changed, so the "it\'s real" votes were cleared.' : 'Saved', 'i-check');
      qc.invalidateQueries({ queryKey: ['queue'] }); qc.invalidateQueries({ queryKey: ['popup'] }); qc.invalidateQueries({ queryKey: ['popups'] });
      onDone();
    },
    onError,
  });
  const submit = () => {
    if (title.trim().length < 3) return setError('Give it a name of at least 3 characters.');
    if (!place) return setError('Choose an address from the list, or drop the pin on the map.');
    if (dateMode !== 'no_dates' && !start) return setError('Pick a start date.');
    if (dateMode === 'dates' && (!end || end < start)) return setError('The end date must be on or after the start.');
    if (dateMode === 'dates') { const bad = datesProblem(start, end, moreDates); if (bad) return setError(bad); }
    save.mutate();
  };

  return (
    <form className="panel" style={{ padding: 14 }} noValidate onSubmit={e => { e.preventDefault(); submit(); }}>
      <h3>Edit details</h3>
      <p className="small muted" style={{ margin: '4px 0 12px' }}>Saving does not approve it. The old values stay in the audit log.</p>
      <div className="fields">
        <label className="field"><span className="lbl">Name of the pop-up</span>
          <input className="input" value={title} onChange={e => setTitle(e.target.value)} autoComplete="off" /></label>
        <label className="field"><span className="lbl">Host or brand <span className="muted small">(optional)</span></span>
          <input className="input" value={host} onChange={e => setHost(e.target.value)} autoComplete="off" /></label>
        <div className="field"><span className="lbl" id={`cat-${p.id}`}>Category</span>
          <div className="chips" role="radiogroup" aria-labelledby={`cat-${p.id}`}>
            {CAT_LIST.map(c => <button key={c} type="button" className="chip" role="radio" aria-checked={category === c} aria-pressed={category === c} onClick={() => setCategory(c)}><Icon name={catIcon(c)} />{CATS[c]}</button>)}
          </div></div>

        <div className="field">
          <label className="lbl" htmlFor={`where-${p.id}`}>Where</label>
          <input id={`where-${p.id}`} className="input" value={whereText} autoComplete="off" placeholder="Start typing an address or venue"
            onChange={e => { setWhereText(e.target.value); setPlace(null); setSuggestOpen(true); }}
            onFocus={() => setSuggestOpen(true)} onBlur={() => setTimeout(() => setSuggestOpen(false), 150)} />
          {suggestOpen && suggest.data?.items.length && !place ? (
            <ul className="suggest">{suggest.data.items.map(x => (
              <li key={`${x.lat},${x.lng}`}><button type="button" onMouseDown={e => e.preventDefault()} onClick={() => pickPlace(x)}>{x.name ?? x.address}<small>{x.name ? x.address : x.area}</small></button></li>
            ))}</ul>
          ) : null}
          {suggest.isFetching ? <span className="hint"><span className="spin" style={{ width: 11, height: 11 }} /> Searching</span> : null}
          {place ? (
            <Suspense fallback={<div className="minimap sk" />}>
              <PinPicker lat={place.lat} lng={place.lng} onMove={movePin} />
              <span className="hint">Drag the pin or tap the map if it is not quite right.</span>
            </Suspense>
          ) : null}
        </div>

        <div className="field"><span className="lbl" id={`mode-${p.id}`}>Dates</span>
          <div className="chips" role="radiogroup" aria-labelledby={`mode-${p.id}`}>
            {([['dates', 'I know the dates'], ['no_end', 'No end date'], ['no_dates', 'No dates announced']] as const).map(([k, l]) =>
              <button key={k} type="button" className="chip" role="radio" aria-checked={dateMode === k} aria-pressed={dateMode === k} onClick={() => setDateMode(k)}>{l}</button>)}
          </div>
        </div>
        <div className="two">
          {dateMode === 'no_dates' ? null : <div className="field"><span className="lbl" id={`start-${p.id}`}>Starts</span>
            <DatePicker title="Starts" labelledBy={`start-${p.id}`} value={start} today={today()} min={londonDate(Date.now() - 365 * 86_400_000)} range={[start, end]}
              onChange={v => { setStart(v); if (end < v) setEnd(v); }} /></div>}
          {dateMode === 'dates' ? <div className="field"><span className="lbl" id={`end-${p.id}`}>Ends</span>
            <DatePicker title="Ends" labelledBy={`end-${p.id}`} value={end} today={today()} min={start} range={[start, end]} onChange={setEnd} /></div> : null}
        </div>
        {dateMode === 'dates' ? <ExtraDates firstEnd={end} rows={moreDates} onChange={setMoreDates} /> : null}
        <label className="field"><span className="lbl">Opening hours <span className="muted small">(optional)</span></span>
          <input className="input" value={hours} onChange={e => setHours(e.target.value)} placeholder="e.g. Sat 10:00 to 16:00" /></label>
        <div className="field"><span className="lbl" id={`price-${p.id}`}>Price</span>
          <div className="chips" role="radiogroup" aria-labelledby={`price-${p.id}`}>
            {([['free', 'Free'], ['paid', 'Paid'], ['unknown', 'Not sure']] as const).map(([k, l]) => <button key={k} type="button" className="chip" role="radio" aria-checked={priceType === k} aria-pressed={priceType === k} onClick={() => setPriceType(k)}>{l}</button>)}
          </div>
          <input className="input" value={price} onChange={e => setPrice(e.target.value)} placeholder="Details, e.g. £5 entry, bowls from £9" aria-label="Price details" />
        </div>
        <label className="field"><span className="lbl">What to expect <span className="muted small">(optional)</span></span>
          <textarea className="input" value={desc} onChange={e => setDesc(e.target.value)} maxLength={2000} rows={4} /></label>
        <label className="field"><span className="lbl">Source link <span className="muted small">(optional)</span></span>
          <input className="input" value={src} onChange={e => setSrc(e.target.value)} placeholder="https://" autoComplete="off" spellCheck={false} /></label>
      </div>
      {error ? <span className="ferr" role="alert" style={{ display: 'block', marginTop: 10 }}>{error}</span> : null}
      <div className="row" style={{ gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
        <button type="button" className="btn sm subtle" onClick={onCancel} disabled={save.isPending}>Cancel</button>
        <button type="submit" className="btn sm primary" disabled={save.isPending}>{save.isPending ? <span className="spin" /> : <Icon name="i-check" />}Save changes</button>
      </div>
    </form>
  );
}
