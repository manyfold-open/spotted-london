import { describe, expect, it } from 'vitest';
import { nextStep, welcomeDue, WELCOME_DONE } from '../src/shared/onboarding';

describe('welcomeDue', () => {
  it('is due for someone who has never seen it', () => {
    expect(welcomeDue(null, false)).toBe(true);
  });
  it('is not due once dealt with', () => {
    expect(welcomeDue(WELCOME_DONE, false)).toBe(false);
  });
  it('is not due for someone who used the app before the card existed', () => {
    expect(welcomeDue(null, true)).toBe(false);
  });
  it('ignores a value it does not know', () => {
    expect(welcomeDue('banana', false)).toBe(true);
  });
});

describe('nextStep', () => {
  it('shows nothing when nothing is due', () => {
    expect(nextStep({ welcome: false, location: false, taste: false })).toBeNull();
  });
  it('asks the Google Analytics question before anything else, where it is owed', () => {
    expect(nextStep({ consent: true, welcome: true, location: true, taste: true })).toBe('consent');
    expect(nextStep({ consent: false, welcome: true, location: true, taste: true })).toBe('welcome');
  });
  it('puts the welcome card ahead of the other two', () => {
    expect(nextStep({ welcome: true, location: true, taste: true })).toBe('welcome');
  });
  it('puts the location card ahead of the taste card', () => {
    expect(nextStep({ welcome: false, location: true, taste: true })).toBe('location');
  });
  it('falls through to the taste card', () => {
    expect(nextStep({ welcome: false, location: false, taste: true })).toBe('taste');
  });
});
