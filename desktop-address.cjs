'use strict';

/**
 * Where the desktop's own daemon listens -- one definition for `main.js`, which
 * binds it, and `scripts/prepare.mjs`, which compiles it into the renderer.
 *
 * Not deployment configuration: every desktop talks to its own loopback
 * daemon. Loopback always, because this API spawns agents that run shell
 * commands and must never be reachable from another machine. PORT moves both
 * ends at once.
 */
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3001);

module.exports = {
  HOST,
  PORT,
  apiUrl: `http://${HOST}:${PORT}/api`,
  wsUrl: `ws://${HOST}:${PORT}`
};
