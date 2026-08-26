'use strict';

/**
 * Deterministic virtual clock for tests. No real setTimeout/wall-clock time
 * is ever used, so tests are fast and never flaky on timing.
 */
function createFakeClock() {
  let nextId = 1;
  const timers = new Map();
  let now = 0;

  return {
    now: () => now,
    pendingCount: () => timers.size,
    scheduleTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, dueAt: now + ms });
      return id;
    },
    clearTimeoutFn: (id) => {
      timers.delete(id);
    },
    // Advances virtual time by ms and synchronously (well, async-safely)
    // fires every timer whose due time has passed, in due-time order.
    // Awaits any promises returned by fired callbacks before resolving.
    advance: async (ms) => {
      now += ms;
      // Loop: firing a timer can itself schedule a new timer that is
      // already due (e.g. armWaitTimer called synchronously inside the
      // idle-timer callback with waitMs <= 0 in a pathological test) --
      // guard with a max-iterations safety valve rather than looping forever.
      for (let guard = 0; guard < 1000; guard += 1) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.dueAt <= now)
          .sort((a, b) => a[1].dueAt - b[1].dueAt);
        if (due.length === 0) break;
        for (const [id, t] of due) {
          if (timers.has(id)) {
            timers.delete(id);
            // eslint-disable-next-line no-await-in-loop
            await Promise.resolve(t.fn());
          }
        }
      }
    },
  };
}

module.exports = { createFakeClock };
