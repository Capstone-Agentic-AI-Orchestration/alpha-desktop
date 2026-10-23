'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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
