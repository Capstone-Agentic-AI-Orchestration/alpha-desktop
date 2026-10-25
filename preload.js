'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { SET_THEME_CHANNEL, THEME_CHANGED_CHANNEL, BOOTSTRAP_THEME_CHANNEL } = require('./appearance.cjs');
const validThemeId = id => typeof id === 'string' && id.length <= 64
  && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) && !['constructor', 'prototype', '__proto__'].includes(id);
function initialAppearanceThemeId() {
  // additionalArguments survive reloads unchanged. Read main's current cached
  // selection synchronously before exposing the bridge or running page scripts.
  try {
    const current = ipcRenderer.sendSync(BOOTSTRAP_THEME_CHANNEL);
    if (validThemeId(current)) return current;
  } catch {
    // Retain the startup argument fallback when bootstrap is unavailable.
  }
  const startup = process.argv.find(argument => argument.startsWith('--alpha-theme='))?.slice('--alpha-theme='.length);
  return validThemeId(startup) ? startup : undefined;
}

function runtimeArgument(prefix) {
  const value = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length);
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    const expectedProtocol = prefix === '--alpha-api-base=' ? 'http:' : 'ws:';
    const expectedPath = prefix === '--alpha-api-base=' ? '/api' : '/';
    if (parsed.protocol !== expectedProtocol || parsed.hostname !== '127.0.0.1' ||
        parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== expectedPath) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Deliberately minimal.
 *
 * The renderer already reaches the backend over HTTP and WebSocket on
 * its own loopback port, exactly as it does in the browser. The runtime
 * addresses cross the bridge, and every other exposed capability is one the
 * one the renderer could not otherwise abuse — so the surface stays at the
 * bare identification the UI needs, and grows only when a feature genuinely
 * requires it (native dialogs, tray, auto-update).
 */
contextBridge.exposeInMainWorld('alphaDesktop', {
  isDesktop: true,
  platform: process.platform,
  apiBase: runtimeArgument('--alpha-api-base='),
  wsUrl: runtimeArgument('--alpha-ws-url='),
  appearanceThemeId: initialAppearanceThemeId(),
  setAppearanceTheme: id => ipcRenderer.invoke(SET_THEME_CHANNEL, id),
  onAppearanceThemeChanged: listener => {
    if (typeof listener !== 'function') throw new TypeError('Appearance listener must be a function.');
    const handler = (_event, id) => { if (typeof id === 'string') listener(id); };
    ipcRenderer.on(THEME_CHANGED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(THEME_CHANGED_CHANNEL, handler);
  },
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
  appVersion: () => ipcRenderer.invoke('alpha:app-version'),
  localPreview: (action, value) => ipcRenderer.invoke('alpha:local-preview', action, value),
  /**
   * The native "choose a folder" dialog, for cloning a project's repositories.
   *
   * The renderer can only ask; the person picks. It names no path, and gets back
   * only the folder chosen, or null when the dialog is cancelled. A browser
   * folder input could not do this: it reports files, so an empty folder, the
   * usual place to clone into, came back as nothing.
   */
  selectFolder: () => ipcRenderer.invoke('alpha:select-folder')
});
