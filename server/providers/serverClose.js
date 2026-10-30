// God's Eye View Canada: one 'close' listener per HTTP server for the fork's
// own providers. Each used to add its own, and with upstream's a dev server
// carried 11, one past Node's default limit, so every start printed a
// "possible EventEmitter memory leak" warning for one-time shutdown hooks.

/** @type {WeakMap<object, Array<() => void>>} */
const hooksByServer = new WeakMap();

/**
 * Run `dispose` when the dev server's HTTP server closes. Vite builds a new
 * server for an in-process restart, so each server runs only its own hooks.
 * A server without one (middleware mode, a test harness) has none to run.
 * @param {{ httpServer?: { once?: Function } | null }} server
 * @param {() => void} dispose
 */
export function onServerClose(server, dispose) {
  const httpServer = server?.httpServer;
  if (typeof httpServer?.once !== 'function') return;
  let hooks = hooksByServer.get(httpServer);
  if (!hooks) {
    hooks = [];
    hooksByServer.set(httpServer, hooks);
    httpServer.once('close', () => {
      for (const hook of hooks.splice(0)) {
        try {
          hook();
        } catch (error) {
          console.warn(
            '[server] a shutdown hook failed:',
            error?.message || error,
          );
        }
      }
    });
  }
  hooks.push(dispose);
}
