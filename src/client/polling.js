/** A single cancellable loop; foreground/reconnect wakes it without overlapping reads. */
export function createPoller(read, { delay = () => 5000, document: doc = globalThis.document, window: win = globalThis.window } = {}) {
  let stopped = false, timer, pending = false, again = false;
  const schedule = () => {
    if (!stopped) { timer = setTimeout(run, doc?.visibilityState === 'hidden' ? Math.max(30000, delay()) : delay()); timer?.unref?.(); }
  };
  async function run() {
    clearTimeout(timer);
    if (stopped) return;
    if (pending) { again = true; return; }
    pending = true;
    try { await read(); } catch { /* The caller owns error presentation. Always retry. */ }
    finally { pending = false; if (!stopped) { if (again) { again = false; void run(); } else schedule(); } }
  }
  const wake = () => { if (doc?.visibilityState !== 'hidden') void run(); };
  doc?.addEventListener('visibilitychange', wake);
  win?.addEventListener('online', wake);
  return { start: run, refresh: run, stop() { stopped = true; clearTimeout(timer); doc?.removeEventListener('visibilitychange', wake); win?.removeEventListener('online', wake); } };
}
