import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useExit } from '../lib/motion';
import { Icon, type IconName } from './Icon';
import { Logo } from './Logo';
import { Ticker } from './PopupBits';

/** The menu that replaces the sidebar and the tab bar. Slides in from the left over everything. */
export function NavMenu({ open, onClose, savedCount, queueCount, isAdmin }: { open: boolean; onClose: () => void; savedCount: number; queueCount: number; isAdmin: boolean }) {
  const [shown, leaving] = useExit(open ? true : null, 280);
  const loc = useLocation();
  const box = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>('a')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!shown) return null;
  const home = loc.pathname === '/' || loc.pathname.startsWith('/p/');
  const items: [string, IconName, string, number?, boolean?][] = [
    ['/', 'i-map', 'Explore'], ['/add', 'i-plus', 'Add a pop-up'], ['/saved', 'i-bookmark', 'Saved', savedCount], ['/me', 'i-user', 'Me'],
  ];
  const admin: typeof items = [['/admin', 'i-inbox', 'Review queue', queueCount, true], ['/admin/agent', 'i-sparkle', 'Agents']];
  const link = ([to, icon, label, ct, hot]: (typeof items)[number], i: number) => (
    <NavLink key={to} to={to} end={to === '/' || to === '/admin'} viewTransition onClick={onClose} style={{ '--i': i } as React.CSSProperties}
      className={({ isActive }) => `mp-nav ${isActive || (to === '/' && home) ? 'active' : ''}`}>
      <Icon name={icon} /><span>{label}</span>{ct ? <span className={`ct ${hot ? 'hot' : ''}`}><Ticker value={ct} /></span> : null}
    </NavLink>
  );
  return (
    <>
      <div className={`mp-scrim ${leaving ? 'out' : ''}`} onClick={onClose} />
      <aside className={`mp-menu ${leaving ? 'out' : ''}`} role="dialog" aria-modal="true" aria-label="Menu" ref={box}>
        <div className="mp-menuhead">
          <span className="mp-brandrow"><Logo /><span className="brandtxt"><b>Spotted</b><small>London pop-ups, checked by locals</small></span></span>
          <button type="button" className="mp-x" aria-label="Close menu" onClick={onClose}><Icon name="i-x" /></button>
        </div>
        <nav aria-label="Main">
          {items.map(link)}
          {isAdmin ? <><div className="mp-navh">Admin</div>{admin.map((a, i) => link(a, i + items.length))}</> : null}
        </nav>
        <div className="mp-key" aria-label="Map key">
          <span className="mp-navh">Map key</span>
          <div><span className="tag t-ink"><Icon name="i-shield" />Verified</span><p>An admin confirmed it.</p></div>
          <div><span className="tag t-eng"><Icon name="i-checkc" />Community verified</span><p>Enough people voted or checked in.</p></div>
          <div><span className="tag t-src"><Icon name="i-check" />Source checked</span><p>A Spotted agent matched it to its source page. People have not confirmed it yet.</p></div>
          <div><span className="tag t-watch">Being checked</span><p>Not confirmed yet. Your vote helps.</p></div>
        </div>
        <p className="mp-foot">Icons by <a href="https://koboyo.com/icons" target="_blank" rel="noopener">Koboyo</a>. Map data © OpenStreetMap.</p>
      </aside>
    </>
  );
}
