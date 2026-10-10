import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { takeGate } from './gate';
import { dropLocalSaves, localSaveIds } from './local-saves';
import { MY_STATE_KEY } from './cache';
import { useErrorToast, useMe, useToast } from './hooks';

/** Moves pop-ups saved on this device to the account, five at a time. Returns how many moved. A network failure leaves that one on the device. */
async function moveLocalSaves(ids: string[]): Promise<number> {
  let moved = 0;
  for (let i = 0; i < ids.length; i += 5) {
    const done: string[] = [];
    await Promise.all(ids.slice(i, i + 5).map(async id => {
      try { await api(`/popups/${encodeURIComponent(id)}/save`, { method: 'PUT', json: {} }); done.push(id); moved++; }
      catch (e) { if (e instanceof ApiError && e.status === 404) done.push(id); } // it ended or was removed: nothing to keep
    }));
    dropLocalSaves(done);
  }
  return moved;
}

let running = false;

/**
 * Runs once when someone is signed in: finishes what the sign-in sheet was for (a vote), or says they can go ahead,
 * and moves what they saved on this device into their account. Mounted in Shell.
 */
export function useAfterSignIn() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const id = me?.id;
  useEffect(() => {
    if (!id || running) return;
    const gate = takeGate();
    const ids = localSaveIds();
    if (!gate && !ids.length) return;
    running = true;
    void (async () => {
      try {
        const moved = ids.length ? await moveLocalSaves(ids) : 0;
        const saves = moved ? `${moved} saved pop-up${moved === 1 ? '' : 's'} moved to your account.` : '';
        let voted = false;
        if (gate?.intent) {
          try {
            await api(`/popups/${encodeURIComponent(gate.intent.id)}/vote`, { method: 'PUT', json: { kind: 'quality', value: gate.intent.value } });
            voted = true;
            toast('Signed in. Your vote is counted.', 'i-check');
          } catch (e) { onError(e); }
        } else if (gate) {
          toast(`Signed in. You can ${gate.then ?? 'go ahead'} now.`, 'i-check');
        }
        if (saves) toast(gate ? saves : `Signed in. ${saves}`, 'i-bookmark');
        if (moved || voted) {
          void qc.invalidateQueries({ queryKey: ['saves'] });
          void qc.invalidateQueries({ queryKey: MY_STATE_KEY });
          void qc.invalidateQueries({ queryKey: ['popup'] }); // an open sheet shows the vote and the bookmark
          if (voted) void qc.invalidateQueries({ queryKey: ['popups'] });
        }
      } finally { running = false; }
    })();
  }, [id, qc, toast, onError]);
}
