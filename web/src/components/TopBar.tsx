import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useIsFetching } from '@tanstack/react-query';
import { initials } from '../lib/format';
import { useMe } from '../lib/hooks';
import { isPhone } from '../lib/motion';
import { Icon } from './Icon';
import { Logo } from './Logo';
import { Ticker } from './PopupBits';

/**
 * The bar across the top of every page: menu, brand, search, your karma. On the home page it floats
 * over the map (`floating`); elsewhere it is a sticky bar that slips away while you scroll down on a phone.
 */
export function TopBar({ floating, menuOpen, onMenu, children }: { floating?: boolean; menuOpen: boolean; onMenu: () => void; children?: ReactNode }) {
  const { data: me } = useMe();
  const loc = useLocation();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  // A list is loading for new filters or a new search.
  const busy = useIsFetching({ predicate: q => q.queryKey[0] === 'popups' && q.state.data === undefined }) > 0;
  const bar = useTucked(!floating);

  // Search lives in ?q; typing on another page jumps to the home page.
  const [q, setQ] = useState(sp.get('q') ?? '');
  useEffect(() => { setQ(sp.get('q') ?? ''); }, [sp]);
  const onSearch = (v: string) => {
    setQ(v);
    const home = loc.pathname === '/';
    const next = new URLSearchParams(home ? sp : undefined);
    if (v) next.set('q', v); else next.delete('q');
    nav({ pathname: '/', search: next.toString() }, { replace: home });
  };

  return (
    <header className={`mp-bar ${floating ? 'floating' : ''}`} ref={bar}>
      <button type="button" id="mp-menubtn" className="mp-menubtn" aria-label="Menu" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={onMenu}><Icon name="i-menu" /></button>
      <NavLink to="/" className="mp-brand"><Logo /><b>Spotted</b></NavLink>
      <label className="search">
        {busy && q ? <span className="spin" aria-hidden="true" /> : <Icon name="i-search" />}
        <span className="sr">Search</span>
        <input type="search" value={q} onChange={e => onSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && q) onSearch(''); }}
          placeholder="Search pop-ups, hosts, areas" autoComplete="off" enterKeyHint="search" />
        {q ? <button type="button" className="clear" aria-label="Clear search" onClick={() => onSearch('')}><Icon name="i-x" /></button> : null}
      </label>
      {children}
      <NavLink to="/add" className="btn primary sm mp-add d-only"><Icon name="i-plus" />Add</NavLink>
      <div className="me">
        {me ? (
          <NavLink to="/me" className="kpill" aria-label={`Your profile, ${me.karma} karma`}>
            <span className="avatar">{initials(me.name, me.email)}</span><Ticker value={me.karma} />
            <span className="d-only muted small">karma</span>
          </NavLink>
        ) : (
          <NavLink to={`/signin?return_to=${encodeURIComponent(loc.pathname + loc.search)}`} className="btn sm">Sign in</NavLink>
        )}
      </div>
      {busy ? <div className="busy" role="progressbar" aria-label="Loading" /> : null}
    </header>
  );
}

/** On phones a sticky bar slides away while you scroll down and comes back when you scroll up. */
function useTucked(on: boolean) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!on) return;
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
  }, [on]);
  return ref;
}
