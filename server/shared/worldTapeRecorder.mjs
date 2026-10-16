/**
 * The world tape's recorder (owner request 2026-10-13, "use all feeds"):
 * polls each ticked feed's adapter at its own cadence (never faster than the
 * app already asks), one poll in flight per feed, backing off on errors,
 * and writes what it gets through the tape store. Pausing stops the polls
 * (one in flight finishes) and writes the gap; a feed at the cap or its
 * quota stops and says so.
 */

const BACKOFF_MAX_MS = 30 * 60_000;

/**
 * @param {object} options
 * @param {object} options.store createTapeStore()
 * @param {Map<string, object>} options.adapters By feed id.
 * @param {(adapter: object) => object} options.contextFor The poll context
 *   (tool services, fetch, …) for an adapter.
 */
export function createRecorder({
  store,
  adapters,
  contextFor = () => ({}),
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  log = () => {},
}) {
  const feeds = new Map(); // id → runtime
  let state = 'off'; // off | running | paused
  let since = now();

  const runtime = (id) => {
    if (!feeds.has(id))
      feeds.set(id, {
        id,
        state: 'off',
        timer: null,
        inFlight: false,
        failures: 0,
        lastAt: null,
        error: null,
        private: {},
        controller: null,
      });
    return feeds.get(id);
  };

  // PAUSE, STOP and an unticked feed cut the poll in flight short.
  const halt = (f) => {
    if (f.timer) timers.clearTimeout(f.timer);
    f.timer = null;
    f.controller?.abort();
  };
  // A poll that finishes after a pause, a stop or an untick leaves the
  // feed's state as that left it.
  const live = (f) => state === 'running' && f.state !== 'off';

  const schedule = (f, delay) => {
    if (f.timer) timers.clearTimeout(f.timer);
    f.timer = timers.setTimeout(() => poll(f), Math.max(0, delay));
    f.timer?.unref?.();
  };

  const poll = async (f) => {
    f.timer = null;
    if (state !== 'running' || f.state === 'off' || f.inFlight) return;
    const adapter = adapters.get(f.id);
    if (!adapter?.poll) return;
    f.inFlight = true;
    const controller = new AbortController();
    f.controller = controller;
    try {
      const why = store.room(f.id);
      if (why) {
        f.state = 'quota';
        f.error = why === 'cap' ? 'STORAGE CAP REACHED' : 'FEED QUOTA REACHED';
        return;
      }
      const ctx = {
        ...contextFor(adapter),
        now,
        state: f.private,
        log,
        signal: controller.signal,
      };
      const got = (await adapter.poll(ctx)) || {};
      const meta = { class: adapter.class, licence: adapter.licence };
      let ok = true;
      for (const file of got.files || []) {
        const written = store.writeFile(
          f.id,
          file.name,
          file.bytes,
          file.record,
          meta,
        );
        if (!written.ok) ok = false;
      }
      if (got.records?.length) {
        const written = store.append(f.id, got.records, meta);
        if (!written.ok) ok = false;
      }
      if (!ok) {
        f.state = 'quota';
        f.error = 'STORAGE CAP REACHED';
        return;
      }
      if (got.records?.length || got.files?.length) f.lastAt = now();
      else if (!controller.signal.aborted) store.heartbeat?.(f.id);
      f.failures = 0;
      f.error = null;
      if (live(f)) f.state = 'recording';
    } catch (error) {
      // Cut short by a pause, a stop or an untick: not a failure.
      if (controller.signal.aborted) return;
      f.failures += 1;
      f.error = String(error?.message || error).slice(0, 160);
      if (live(f)) f.state = 'error';
      log(`${f.id}: ${f.error}`);
    } finally {
      f.inFlight = false;
      if (f.controller === controller) f.controller = null;
      if (live(f) && f.state !== 'quota') {
        const cadence = adapter?.cadenceMs || 60_000;
        // A poll cut short and started again (CONTINUE, a re-tick) runs now.
        schedule(
          f,
          controller.signal.aborted
            ? 0
            : f.failures
              ? Math.min(BACKOFF_MAX_MS, cadence * 2 ** Math.min(6, f.failures))
              : cadence,
        );
      }
    }
  };

  const activeIds = () =>
    [...feeds.values()].filter((f) => f.state !== 'off').map((f) => f.id);

  return {
    /** The ticked feeds: the recordable ones start; the rest stop. */
    setFeeds(ids) {
      const want = new Set(ids.filter((id) => adapters.get(id)?.poll));
      for (const f of feeds.values())
        if (!want.has(f.id) && f.state !== 'off') {
          f.state = 'off';
          halt(f);
        }
      for (const id of want) {
        const f = runtime(id);
        if (f.state === 'off') {
          f.state = state === 'running' ? 'waiting' : 'paused';
          f.failures = 0;
          f.error = null;
          if (state === 'running') schedule(f, 0);
        }
      }
    },
    start() {
      if (state === 'running') return;
      if (state === 'paused') store.gap(since, now(), 'paused', activeIds());
      state = 'running';
      since = now();
      for (const f of feeds.values())
        if (f.state !== 'off') {
          f.state = 'waiting';
          schedule(f, 0);
        }
    },
    pause() {
      if (state !== 'running') return;
      state = 'paused';
      since = now();
      for (const f of feeds.values()) {
        halt(f);
        if (f.state !== 'off') f.state = 'paused';
      }
    },
    resume() {
      this.start();
    },
    stop(reason = 'stopped') {
      const was = state;
      state = 'off';
      for (const f of feeds.values()) {
        halt(f);
        if (f.state !== 'off') f.state = 'paused';
      }
      if (was === 'paused') store.gap(since, now(), 'paused', activeIds());
      since = now();
      return reason;
    },
    /** A restart: the time the server was down is a gap. */
    restarted(from) {
      if (from) store.gap(from, now(), 'restart', activeIds());
    },
    get state() {
      return state;
    },
    status() {
      const usage = store.usage().byFeed;
      return [...feeds.values()].map((f) => {
        const u = usage[f.id] || {};
        return {
          id: f.id,
          state: f.state,
          records: u.records || 0,
          bytes: u.bytes || 0,
          recordsToday: u.recordsToday || 0,
          bytesToday: u.bytesToday || 0,
          lastAt: f.lastAt,
          error: f.error,
        };
      });
    },
    /** Run one poll now (tests). */
    pollNow(id) {
      return poll(runtime(id));
    },
  };
}
