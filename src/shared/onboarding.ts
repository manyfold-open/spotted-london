// First-visit cards on the map home, one at a time. Plain TS so a test can pin the order.
//
// The three cards used to decide for themselves whether to show. Now one decision picks which comes next:
// the welcome card first, then the location card, then the "pick what you like" swipe invite.

export type Step = 'welcome' | 'location' | 'taste';

/** The value kept in localStorage `spotted.welcome` once the welcome card has been dealt with. */
export const WELCOME_DONE = '1';

/**
 * Whether the welcome card is still due. Someone who has used the app before this card existed (they already
 * answered the location or the taste card) is treated as having seen it, so they are not greeted as new.
 */
export function welcomeDue(stored: string | null, returning: boolean): boolean {
  return stored !== WELCOME_DONE && !returning;
}

/** Which card shows now, or null for none. Each flag says only whether that card still has something to say. */
export function nextStep(due: { welcome: boolean; location: boolean; taste: boolean }): Step | null {
  if (due.welcome) return 'welcome';
  if (due.location) return 'location';
  if (due.taste) return 'taste';
  return null;
}
