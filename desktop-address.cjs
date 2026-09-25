'use strict';

/**
 * The build-time fallback address for the desktop renderer. `prepare.mjs`
 * compiles it into the assets for older preloads; current Electron launches
 * pass the daemon's OS-assigned loopback address through `preload.js` instead.
 *
 * Not deployment configuration: every desktop talks to its own loopback
 * daemon. Loopback always, because this API spawns agents that run shell
 * commands and must never be reachable from another machine. PORT moves both
 * ends at once.
 */
const HOST = '127.0.0.1';

/**
 * Retained as a harmless fallback for a renderer opened without the new bridge.
 * The running desktop does not bind this fixed port.
 */
const PORT = Number(process.env.ALPHA_DESKTOP_PORT || 43117);

module.exports = {
  HOST,
  PORT,
  apiUrl: `http://${HOST}:${PORT}/api`,
  wsUrl: `ws://${HOST}:${PORT}`
};
