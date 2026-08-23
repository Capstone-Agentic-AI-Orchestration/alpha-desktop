'use strict';

const { contextBridge } = require('electron');

/**
 * Deliberately minimal.
 *
 * The renderer already reaches the backend over HTTP and WebSocket on
 * 127.0.0.1:3001, exactly as it does in the browser, so nothing needs to cross
 * the context bridge to make the app work. Every capability exposed here is
 * one the renderer could not otherwise abuse — so the surface stays at the
 * bare identification the UI needs, and grows only when a feature genuinely
 * requires it (native dialogs, tray, auto-update).
 */
contextBridge.exposeInMainWorld('alphaDesktop', {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }
});
