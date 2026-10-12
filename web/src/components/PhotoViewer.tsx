import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { Img } from './PopupBits';

export interface ViewerPhoto { id: string; url: string; credit?: string | null; credit_url?: string | null }

/**
 * The whole photo, as large as the screen allows. Opened from the pop-up sheet's cover or a gallery photo.
 * It is a portal on the body, so the sheet's drag-to-close does not see its touches, and it takes Escape
 * before the sheet does (capture on window), so Escape closes only this.
 */
export function PhotoViewer({ photos, start, onClose }: { photos: ViewerPhoto[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(Math.min(start, photos.length - 1));
  const many = photos.length > 1;
  const go = (d: number) => setI(n => (n + d + photos.length) % photos.length);
  const goRef = useRef(go); goRef.current = go;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const close = useRef<HTMLButtonElement>(null);
  const swiped = useRef(false);
  const from = useRef<number | null>(null);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      else if (e.key === 'ArrowLeft') goRef.current(-1);
      else if (e.key === 'ArrowRight') goRef.current(1);
      else return;
      e.stopPropagation(); e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); if (before?.isConnected) before.focus({ preventScroll: true }); };
  }, []);

  const p = photos[i];
  if (!p) return null;
  return createPortal(
    <div className="pv" role="dialog" aria-modal="true" aria-label="Photo"
      onPointerDown={e => { from.current = e.clientX; swiped.current = false; }}
      onPointerUp={e => {
        if (many && from.current !== null && Math.abs(e.clientX - from.current) > 50) { swiped.current = true; go(e.clientX < from.current ? 1 : -1); }
        from.current = null;
      }}
      onClick={e => { if (swiped.current) { swiped.current = false; return; } if (!(e.target as HTMLElement).closest('button, a')) onClose(); }}>
      <Img key={p.id} src={p.url} />
      <button ref={close} className="btn sm dclose" onClick={onClose} aria-label="Close"><Icon name="i-x" /><span className="d-only">Close</span></button>
      {many ? <>
        <button className="btn sm pv-nav prev" onClick={() => go(-1)} aria-label="Previous photo"><Icon name="i-left" /></button>
        <button className="btn sm pv-nav next" onClick={() => go(1)} aria-label="Next photo"><Icon name="i-left" /></button>
      </> : null}
      <p className="pv-cap small">
        {many ? <span className="num">{i + 1} / {photos.length}</span> : null}
        {p.credit ? <span>Photo: {p.credit_url ? <a href={p.credit_url} target="_blank" rel="noopener nofollow">{p.credit}</a> : p.credit}</span> : null}
      </p>
    </div>,
    document.body,
  );
}
