'use strict';

const electron = require('electron');
const path = require('node:path');
const http = require('node:http');

/**
 * Guard against ELECTRON_RUN_AS_NODE.
 *
 * When that variable is set, Electron runs the script as plain Node and
 * `require('electron')` returns a path string instead of the API — so `app` is
 * undefined and the app dies with a bare "Cannot read properties of undefined".
 * The window never appears and nothing is logged, which reads as a broken build.
 *
 * It is not exotic: Antigravity IDE's launcher exports it, so any app started
 * from that terminal inherits it. Fail with an explanation instead.
 */
if (!electron || typeof electron === 'string' || !electron.app) {
  console.error(
    '\nAlpha cannot start: ELECTRON_RUN_AS_NODE is set in this environment,\n' +
    'which forces Electron to run as plain Node.\n\n' +
    'Clear it and relaunch:\n' +
    '  PowerShell:  $env:ELECTRON_RUN_AS_NODE=""; .\\Alpha.exe\n' +
    '  cmd:         set ELECTRON_RUN_AS_NODE=&& Alpha.exe\n'
  );
  process.exit(1);
}

const { app, BrowserWindow, dialog, shell } = electron;

/**
 * Alpha desktop shell.
 *
 * The backend is NOT a separate process here. `alpha-be-main` compiles to
 * CommonJS, so the Electron main process requires it directly: the Express +
 * WebSocket server, SQLite and the CLI spawning all run in this process. That
 * is the same "main process IS the daemon" arrangement the plan describes —
 * one process, one lifecycle, nothing to orphan on quit.
 *
 * The renderer is the Vite build loaded from disk. It still talks to
 * http://127.0.0.1:3001 exactly as it does in development, so no frontend code
 * changes between `npm run dev` and the packaged app.
 */

const PORT = Number(process.env.PORT || 3001);
const HOST = '127.0.0.1';

let mainWindow = null;

function startBackend() {
  // Bind loopback and allow the file:// renderer through CORS. Both are set
  // before the server module is required, because it reads them at import time.
  process.env.HOST = HOST;
  process.env.PORT = String(PORT);
  process.env.CORS_ORIGIN = [
    'file://',
    `http://${HOST}:${PORT}`,
    'http://localhost:3000'
  ].join(',');

  require(path.join(__dirname, 'build', 'server', 'index.js'));
}

/** Resolve once the API answers, so the window never loads against a dead backend. */
function waitForBackend(timeoutMs = 20000) {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(
        { host: HOST, port: PORT, path: '/api/health', timeout: 1500 },
        res => {
          res.resume();
          if (res.statusCode === 200) return resolve();
          retry();
        }
      );
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };

    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Backend did not answer on ${HOST}:${PORT} within ${timeoutMs}ms`));
        return;
      }
      setTimeout(attempt, 300);
    };

    attempt();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0D0E10',
    show: false,
    title: 'Alpha',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Non-negotiable: the renderer displays model-generated text and tool
      // output. With nodeIntegration on, any injected string in that output
      // could reach child_process.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  /**
   * External links open in the real browser, never inside the app frame — and
   * only if they are actually web links.
   *
   * The scheme check is load-bearing, not defensive habit. This window renders
   * model-generated text and tool output, so a URL here can originate from an
   * LLM, a repo README, or a webhook payload. `shell.openExternal` hands the
   * string to the OS: on Windows a `file://` URL can launch a local
   * executable, and custom schemes reach whatever app claims them. Allowlist
   * http/https and drop everything else.
   */
  const openIfWebUrl = url => {
    try {
      const { protocol } = new URL(url);
      if (protocol === 'https:' || protocol === 'http:') {
        shell.openExternal(url);
        return;
      }
      console.warn(`Blocked external open of non-web URL: ${protocol}`);
    } catch {
      console.warn('Blocked external open of unparseable URL');
    }
  };

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openIfWebUrl(url);
    return { action: 'deny' };
  });

  // Same rule for top-frame navigation. Without this, a link that replaces the
  // window (rather than opening a new one) bypasses the handler above and could
  // navigate the app frame away from the packaged renderer.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow.webContents.getURL()) return;
    event.preventDefault();
    openIfWebUrl(url);
  });

  mainWindow.loadFile(path.join(__dirname, 'build', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    startBackend();
    await waitForBackend();
  } catch (err) {
    // Surface the reason instead of opening a window onto nothing.
    dialog.showErrorBox(
      'Alpha could not start',
      `The local engine failed to start.\n\n${err && err.message ? err.message : String(err)}`
    );
    app.quit();
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Quit on every platform: the backend lives in this process, so leaving it
  // running with no window would keep a hidden server (and any agent it
  // spawned) alive.
  app.quit();
});
