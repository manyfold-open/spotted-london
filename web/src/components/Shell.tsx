import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, type Popup } from '../lib/api';
import { initials } from '../lib/format';
import { useMe, useToast } from '../lib/hooks';
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
          <span className="logo"><Icon name="i-pin" size={20} /></span>
          <span><b>Spotted</b><span>London pop-ups, checked by locals</span></span>
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
        <header className="topbar">
          <NavLink to="/" className="mbrand">
            <span className="logo"><Icon name="i-pin" size={17} /></span><b>Spotted</b><span className="tag t-out">London</span>
          </NavLink>
          <label className="search">
            <Icon name="i-search" />
            <span className="sr">Search</span>
            <input type="search" value={q} onChange={e => onSearch(e.target.value)} placeholder="Search pop-ups, hosts, areas" autoComplete="off" />
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
        </header>
        <main className="page"><Outlet /></main>
      </div>

      <nav className="tabbar" aria-label="Main">
        <Tab to="/" icon="i-list" label="Explore" end alsoActive={loc.pathname.startsWith('/p/')} />
        <Tab to="/map" icon="i-map" label="Map" />
        <NavLink to="/add" className={({ isActive }) => `tab add ${isActive ? 'active' : ''}`}><span className="plus"><Icon name="i-plus" /></span><span>Add</span></NavLink>
        <Tab to="/saved" icon="i-bookmark" label="Saved" badge={savedCount} />
        <Tab to="/me" icon="i-user" label="Me" badge={queueCount} alsoActive={loc.pathname === '/admin'} />
      </nav>

      {sheet ? <PopupSheet slug={sheet} /> : null}
    </div>
  );
}

function Tab({ to, icon, label, badge, end, alsoActive }: { to: string; icon: IconName; label: string; badge?: number; end?: boolean; alsoActive?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `tab ${isActive || alsoActive ? 'active' : ''}`}>
      <span className="ti"><Icon name={icon} />{badge ? <span className="badge num">{badge}</span> : null}</span>
      <span>{label}</span>
    </NavLink>
  );
}
