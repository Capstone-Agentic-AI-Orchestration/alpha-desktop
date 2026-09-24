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

/**
 * Not 3001: that is where `npm run dev` puts the daemon, and most people who
 * install Alpha also work on it. Sharing the port meant the installed app's
 * own daemon could not bind, the source daemon answered its health check
 * instead, and the window opened onto that -- signed in as the terminal's
 * `gh`, reading the developer's `.env`, with no team board. A port of its own
 * lets both run; `waitForBackend` in main.js refuses a stranger either way.
 */
const PORT = Number(process.env.ALPHA_DESKTOP_PORT || 43117);

module.exports = {
  HOST,
  PORT,
  apiUrl: `http://${HOST}:${PORT}/api`,
  wsUrl: `ws://${HOST}:${PORT}`
};
