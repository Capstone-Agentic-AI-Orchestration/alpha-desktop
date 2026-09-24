'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Deliberately minimal.
 *
 * The renderer already reaches the backend over HTTP and WebSocket on
 * its own loopback port (desktop-address.cjs), exactly as it does in the browser, so nothing needs to cross
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
  },
  /**
   * One of the capabilities this file was always going to grow for.
   *
   * It takes no arguments and returns only what happened, so the renderer can
   * ask for a check and cannot direct one: it names no repository, no version
   * and no URL. Main decides all of that from what was baked into the build.
   */
  checkForUpdates: () => ipcRenderer.invoke('alpha:check-for-updates'),
  appVersion: () => ipcRenderer.invoke('alpha:app-version')
});
