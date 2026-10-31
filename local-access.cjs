'use strict';

const crypto = require('node:crypto');

/**
 * The local engine's launch token: made in main, handed to the app's own
 * window over synchronous IPC, checked by the engine on every API call and
 * stream connection. See build/server/services/localAccess.js for the checks.
 */
const LOCAL_TOKEN_CHANNEL = 'alpha:local-token';

/** 256 random bits as hex: valid in a header and in a WebSocket subprotocol. */
function createLocalToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isLocalToken(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Whether an IPC message came from the packaged renderer in the main window.
 *
 * The sender must be that window's contents, the frame must be its main frame
 * (not an iframe a page might embed), and the frame must be showing the
 * renderer file itself. A navigated window, a preview view or any other
 * contents is refused.
 */
function isTrustedRendererSender(event, window, rendererUrl) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
  if (event.sender !== window.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== window.webContents.mainFrame) return false;
  try {
    const url = new URL(frame.url);
    url.hash = '';
    url.search = '';
    return url.href === rendererUrl;
  } catch {
    return false;
  }
}

module.exports = { LOCAL_TOKEN_CHANNEL, createLocalToken, isLocalToken, isTrustedRendererSender };
