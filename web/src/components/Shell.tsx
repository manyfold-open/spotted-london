import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useIsFetching, useQuery } from '@tanstack/react-query';
import { api, type Popup } from '../lib/api';
import { initials } from '../lib/format';
import { useMe, useToast } from '../lib/hooks';
import { isPhone, scrollBehavior, useExit } from '../lib/motion';
import { Icon, type IconName } from './Icon';
import { PopupSheet } from './PopupSheet';

const LOGIN_ERRORS: Record<string, string> = {
  google_cancelled: 'Google sign in was cancelled.',
  state_mismatch: 'Sign in timed out. Try again.',
  state_expired: 'Sign in timed out. Try again.',
  banned: 'This account is suspended.',
};

export function Shell() {
  const { data: me } = useMe();
  const loc = useLocation();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const toast = useToast();
  const sheet = sp.get('p') ?? (loc.pathname.startsWith('/p/') ? decodeURIComponent(loc.pathname.slice(3)) : null);
  const [shownSheet, sheetLeaving] = useExit(sheet, 220);
  // A list is loading for new filters or a new search.
  const busy = useIsFetching({ predicate: q => q.queryKey[0] === 'popups' && q.state.data === undefined }) > 0;
  const topbar = useTucked();

  const saves = useQuery({ queryKey: ['saves'], queryFn: () => api<{ items: Popup[] }>('/me/saves'), enabled: !!me });
  const queue = useQuery({ queryKey: ['queue'], queryFn: () => api<{ items: Popup[] }>('/admin/queue'), enabled: me?.role === 'admin' });
  const savedCount = saves.data?.items.length ?? 0;
  const queueCount = queue.data?.items.length ?? 0;

  // Google sign in comes back with ?login_error=... when it fails.
  useEffect(() => {
    const err = sp.get('login_error');
    if (!err) return;
    toast(LOGIN_ERRORS[err] ?? 'Sign in did not finish. Try again.', 'i-info', true);
    const next = new URLSearchParams(sp); next.delete('login_error'); setSp(next, { replace: true });
  }, [sp, setSp, toast]);

  // Search lives in ?q; typing elsewhere jumps to Explore.
  const [q, setQ] = useState(sp.get('q') ?? '');
  useEffect(() => { setQ(sp.get('q') ?? ''); }, [sp]);
  const onSearch = (v: string) => {
    setQ(v);
    const target = loc.pathname === '/map' ? '/map' : '/';
    const next = new URLSearchParams(target === loc.pathname ? sp : undefined);
    if (v) next.set('q', v); else next.delete('q');
    nav({ pathname: target, search: next.toString() }, { replace: target === loc.pathname });
  };

  const items: [string, IconName, string, number?, boolean?][] = [
    ['/', 'i-list', 'Explore'], ['/map', 'i-map', 'Map'], ['/add', 'i-plus', 'Add a pop-up'],
    ['/saved', 'i-bookmark', 'Saved', savedCount], ['/me', 'i-user', 'Me'],
  ];
  if (me?.role === 'admin') items.push(['/admin', 'i-inbox', 'Review queue', queueCount, true]);

  return (
    <div className="shell">
      <aside className="side">
        <NavLink to="/" className="brand">
          <Logo />
          <span className="brandtxt"><b>Spotted</b><small>London pop-ups, checked by locals</small></span>
        </NavLink>
        <nav className="sidenav" aria-label="Main">
          {items.map(([to, icon, label, ct, hot]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `nav ${isActive || (to === '/' && loc.pathname.startsWith('/p/')) ? 'active' : ''}`}>
              <Icon name={icon} /><span>{label}</span>{ct ? <span className={`ct ${hot ? 'hot' : ''}`}>{ct}</span> : null}
            </NavLink>
          ))}
        </nav>
        <p className="sidefoot">Icons by <a href="https://koboyo.com/icons" target="_blank" rel="noopener">Koboyo</a>. Map data © OpenStreetMap.</p>
      </aside>

      <div className="main">
        <header className="topbar" ref={topbar}>
          <NavLink to="/" className="mbrand">
            <Logo /><b>Spotted</b><span className="tag t-out">London</span>
          </NavLink>
          <label className="search">
            {busy && q ? <span className="spin" aria-hidden="true" /> : <Icon name="i-search" />}
            <span className="sr">Search</span>
            <input type="search" value={q} onChange={e => onSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && q) onSearch(''); }}
              placeholder="Search pop-ups, hosts, areas" autoComplete="off" enterKeyHint="search" />
            {q ? <button type="button" className="clear" aria-label="Clear search" onClick={() => onSearch('')}><Icon name="i-x" /></button> : null}
          </label>
          <div className="me">
            {me ? (
              <NavLink to="/me" className="kpill" aria-label={`Your profile, ${me.karma} karma`}>
                <span className="avatar">{initials(me.name, me.email)}</span><span className="num">{me.karma}</span>
                <span className="d-only muted small">karma</span>
              </NavLink>
            ) : (
              <NavLink to={`/signin?return_to=${encodeURIComponent(loc.pathname + loc.search)}`} className="btn sm">Sign in</NavLink>
            )}
          </div>
          {busy ? <div className="busy" role="progressbar" aria-label="Loading" /> : null}
        </header>
        <main className="page"><Outlet /></main>
      </div>

      <nav className="tabbar" aria-label="Main">
        <Tab to="/" icon="i-list" label="Explore" end alsoActive={loc.pathname.startsWith('/p/')} />
        <Tab to="/map" icon="i-map" label="Map" warm={loadMap} />
        <NavLink to="/add" className={({ isActive }) => `tab add ${isActive ? 'active' : ''}`}><span className="plus"><Icon name="i-plus" /></span><span>Add</span></NavLink>
        <Tab to="/saved" icon="i-bookmark" label="Saved" badge={savedCount} />
        <Tab to="/me" icon="i-user" label="Me" badge={queueCount} alsoActive={loc.pathname === '/admin'} />
      </nav>

      {shownSheet ? <PopupSheet key={shownSheet} slug={shownSheet} leaving={sheetLeaving} /> : null}
    </div>
  );
}

/** Same mark as the favicon: a paper pin on an orange dot. */
export function Logo() {
  return (
    <span className="logo" aria-hidden="true">
      <svg viewBox="0 0 64 64"><path d="M32 12c-8.3 0-14.5 6-14.5 13.9C17.5 36 32 51 32 51s14.5-15 14.5-25.1C46.5 18 40.3 12 32 12zm0 19.2a5.4 5.4 0 1 1 0-10.8 5.4 5.4 0 0 1 0 10.8z" /></svg>
    </span>
  );
}

/** The map code is big, so start fetching it when a finger lands on the Map tab. */
const loadMap = () => { void import('../pages/MapPage'); };

/** On phones the top bar slides away while you scroll down and comes back when you scroll up. */
function useTucked() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    let last = window.scrollY, frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = ref.current, y = window.scrollY, d = y - last;
        if (!el || Math.abs(d) < 8) return;
        last = y;
        const typing = el.contains(document.activeElement);
        el.classList.toggle('tucked', isPhone() && d > 0 && y > 140 && !typing);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, []);
  return ref;
}

function Tab({ to, icon, label, badge, end, alsoActive, warm }: { to: string; icon: IconName; label: string; badge?: number; end?: boolean; alsoActive?: boolean; warm?: () => void }) {
  const loc = useLocation();
  // Tapping the tab you are already on scrolls back to the top and keeps your filters.
  const onClick = (e: MouseEvent) => {
    if (loc.pathname !== to) return;
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  };
  return (
    <NavLink to={to} end={end} onClick={onClick} onPointerDown={warm} className={({ isActive }) => `tab ${isActive || alsoActive ? 'active' : ''}`}>
      <span className="ti"><Icon name={icon} />{badge ? <span className="badge num">{badge}</span> : null}</span>
      <span>{label}</span>
    </NavLink>
  );
}
