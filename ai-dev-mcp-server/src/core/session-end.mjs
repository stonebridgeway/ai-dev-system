/**
 * When a stdio session is over: its client closed stdin, and everything it
 * asked for is answered. Until then the session keeps what it runs; after it,
 * the model's worker thread is all that would keep the process alive — in
 * Docker, the container, for good.
 *
 * Nothing is cut short: `onEnd` runs only between calls, and the process then
 * exits on its own once the last answer is written.
 */

/**
 * @param {() => void} onEnd - Called each time the session is found over: it may be called more than once.
 * @returns {{ track: <T>(work: () => Promise<T>) => Promise<T>, inputEnded: () => void }}
 */
export function createSessionEnd(onEnd) {
  let inFlight = 0;
  let ended = false;
  // A call read before the end may not have started yet: look again once the
  // turn of the event loop is over, not at once.
  const settle = () => {
    if (ended && inFlight === 0) setImmediate(() => {
      if (inFlight === 0) onEnd();
    });
  };
  return {
    async track(work) {
      inFlight += 1;
      try {
        return await work();
      } finally {
        inFlight -= 1;
        settle();
      }
    },
    inputEnded() {
      ended = true;
      settle();
    }
  };
}
