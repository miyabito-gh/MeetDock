export const FOCUS_SYNC_COOLDOWN_MS = 2_000;

export function createFocusSync({ sync, canSync = () => true, now = () => Date.now(), requestId = () => crypto.randomUUID() }) {
  if (typeof sync !== 'function' || typeof canSync !== 'function' || typeof now !== 'function' || typeof requestId !== 'function') {
    throw new TypeError('invalid focus sync ports');
  }
  let lastAutomaticSync = -Infinity;
  return () => {
    if (!canSync()) return false;
    const current = now();
    if (!Number.isFinite(current) || current - lastAutomaticSync < FOCUS_SYNC_COOLDOWN_MS) return false;
    lastAutomaticSync = current;
    sync(requestId(), false);
    return true;
  };
}
