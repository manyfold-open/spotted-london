import type { Status } from './api';
import type { IconName } from '../components/Icon';
import { CATEGORIES, CATEGORY_LABELS, type Category } from '../../../src/shared/categories';
export * from './dates';

export const CATS: Record<Category, string> = CATEGORY_LABELS;
export const CAT_LIST: Category[] = [...CATEGORIES];
export const catIcon = (c: Category): IconName => `c-${c}`;

export const PUBLIC: Status[] = ['community', 'verified_community', 'verified_admin'];

export function meterClass(c: number) {
  return c < 0.4 ? 'low' : c < 0.75 ? 'mid' : '';
}

export function distance(m?: number) {
  if (m === undefined) return '';
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

export function initials(name: string | null | undefined, email?: string) {
  const src = (name || email || '?').trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Loose check, the server has the final say. */
export const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
