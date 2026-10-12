import { useCallback, useState } from 'react';
import { WELCOME_DONE, welcomeDue } from '../../../src/shared/onboarding';

// Whether the welcome card on the home page has been dealt with. It lives on this device (localStorage
// `spotted.welcome`) and is never sent anywhere. A blocked or full store only means it can show again next visit.

const KEY = 'spotted.welcome';
const read = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };
const write = () => { try { localStorage.setItem(KEY, WELCOME_DONE); } catch { /* private window: it stays closed for this visit */ } };

/** `returning` is true for someone who already answered the location or taste card, so they are not greeted as new. */
export function useWelcome(returning: boolean) {
  const [done, setDone] = useState(false);
  const due = !done && welcomeDue(read(), returning);
  const finish = useCallback(() => { write(); setDone(true); }, []);
  return { due, finish };
}
