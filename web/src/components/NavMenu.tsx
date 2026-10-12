import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useExit } from '../lib/motion';
import { useInstall } from '../lib/pwa';
import { Icon, type IconName } from './Icon';
import { Logo } from './Logo';
import { Ticker } from './PopupBits';

/** The menu that replaces the sidebar and the tab bar. Slides in from the left over everything. */
export function NavMenu({ open, onClose, savedCount, queueCount, isAdmin }: { open: boolean; onClose: () => void; savedCount: number; queueCount: number; isAdmin: boolean }) {
  const [shown, leaving] = useExit(open ? true : null, 280);
  const loc = useLocation();
  const box = useRef<HTMLElement>(null);
  const app = useInstall();

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
    ['/', 'i-map', 'Explore'], ['/add', 'i-plus', 'Add a pop-up'], ['/saved', 'i-bookmark', 'Saved', savedCount], ['/me', 'i-user', 'Me'], ['/connect', 'i-sparkle', 'Use with AI'],
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
        {app.state === 'prompt' ? (
          <button type="button" className="mp-install" onClick={() => { onClose(); app.install(); }}><Icon name="i-plus" /><span><b>Install the app</b><small>Opens full screen from your home screen</small></span></button>
        ) : app.state === 'ios' ? (
          <p className="mp-install ios"><Icon name="i-plus" /><span><b>Install the app</b><small>Tap Share in your browser, then Add to Home Screen.</small></span></p>
        ) : null}
        <div className="mp-key" aria-label="Map key">
          <span className="mp-navh">Map key</span>
          <p>The colour of a pin is its kind. Pick a kind in the chips to see its colour.</p>
          <div><span className="keypin verified_admin"><i><Icon name="i-check" /></i></span><p><b>Admin verified.</b> Thick ring and a dark tick.</p></div>
          <div><span className="keypin verified_community"><i><Icon name="i-check" /></i></span><p><b>Community verified.</b> A green tick. Enough people voted or checked in.</p></div>
          <div><span className="keypin checked"><i><Icon name="i-check" /></i></span><p><b>Source checked.</b> A green outlined tick. A Spotted agent matched it to its source page. People have not confirmed it yet.</p></div>
          <div><span className="keypin community" /><p><b>Being checked.</b> Dashed ring, no tick. Your vote helps.</p></div>
          <div><span className="keypin cluster">8</span><p><b>A number.</b> Several pop-ups close together. Tap it to zoom in.</p></div>
        </div>
        <p className="mp-foot">Icons by <a href="https://koboyo.com/icons" target="_blank" rel="noopener">Koboyo</a>. Map data © OpenStreetMap. <a href="/privacy">Privacy</a></p>
      </aside>
    </>
  );
}
