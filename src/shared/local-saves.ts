// Pop-ups saved while signed out: what is kept and how it is read. Plain functions with no imports, so the Worker
// tests and the web app (web/src/lib/local-saves.ts, which stores it on the device) run the same code.

/** Most pop-ups kept. Past it the oldest one goes, so saving never fails. */
export const LOCAL_SAVES_MAX = 200;

export interface LocalSave { id: string; at: number }

/** Reads the stored text. Anything odd gives fewer or no saves, never an error. */
export function parseSaves(raw: string | null): LocalSave[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as { v?: number; saves?: unknown };
    if (v?.v !== 1 || !Array.isArray(v.saves)) return [];
    const seen = new Set<string>();
    const out: LocalSave[] = [];
    for (const s of v.saves) {
      const { id, at } = (s ?? {}) as Partial<LocalSave>;
      if (typeof id !== 'string' || !id || id.length > 64 || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 });
    }
    return out.slice(-LOCAL_SAVES_MAX);
  } catch { return []; }
}

/** The list after saving or unsaving one pop-up, as a new array. Saving twice changes nothing. */
export function withSave(list: readonly LocalSave[], id: string, on: boolean, now: number): LocalSave[] {
  const rest = list.filter(s => s.id !== id);
  if (!on) return rest;
  if (rest.length !== list.length) return [...list];
  return [...rest, { id, at: now }].slice(-LOCAL_SAVES_MAX);
}
