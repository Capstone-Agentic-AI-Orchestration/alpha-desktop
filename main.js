'use strict';

const electron = require('electron');
const fs = require('node:fs');
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
 * The renderer is the Vite build loaded from disk. It talks to the loopback
 * daemon over HTTP exactly as it does in development -- the address is compiled
 * in by `prepare.mjs` from `desktop-address.cjs` -- so no frontend code changes
 * between `npm run dev` and the packaged app.
 */

const { HOST, PORT } = require('./desktop-address.cjs');

let mainWindow = null;

/**
 * Deployment settings, baked in when the app was built.
 *
 * An installed app has no `.env`, and the daemon now refuses to start without
 * settings such as ALPHA_ORG rather than falling back to one organisation
 * written into the code. `scripts/prepare.mjs` writes this file from the
 * build's environment, restricted to public values; see PUBLIC_SETTINGS there.
 *
 * The environment still wins, so a developer can point one install elsewhere
 * without rebuilding it.
 */
function loadBuildConfig() {
  const file = path.join(__dirname, 'build', 'app-config.json');
  let values;
  try {
    values = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Nothing baked in. The daemon's own startup checks name what is missing.
    return;
  }
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined && typeof value === 'string') process.env[key] = value;
  }
}

/**
 * The GitHub CLI this installer carries, as a fallback.
 *
 * Every GitHub call the daemon makes -- identity, teams, the board, pushes --
 * spawns `gh`, and a teammate who installed only Alpha did not have it.
 * `prepare.mjs` bundles a pinned, checksum-verified copy into resources/gh.
 *
 * Appended to PATH, not prepended: a `gh` the developer installed themselves,
 * possibly newer, still answers first. Both keep the sign-in in the OS
 * keyring, so it does not matter which one runs.
 */
function addBundledGhToPath() {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'gh')
    : path.join(__dirname, 'vendor', 'gh');
  if (fs.existsSync(path.join(dir, 'gh.exe'))) {
    process.env.PATH = `${process.env.PATH || ''}${path.delimiter}${dir}`;
  }
}

function startBackend() {
  loadBuildConfig();
  addBundledGhToPath();

  // Bind loopback and allow the file:// renderer through CORS. Both are set
  // before the server module is required, because it reads them at import time.
  process.env.HOST = HOST;
  process.env.PORT = String(PORT);
  process.env.CORS_ORIGIN = ['file://', `http://${HOST}:${PORT}`].join(',');

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

/**
 * Keeping everyone on the same build.
 *
 * Alpha is distributed as an installer, so an update meant telling five people
 * a new one existed and hoping they ran it. Over a semester that is how a team
 * ends up debugging behaviour that was fixed three versions ago on one laptop
 * and not the others.
 *
 * ## The private-repository problem, and why gh solves it
 *
 * `alpha-desktop` is private, so downloading a release needs a token —
 * ordinarily a second credential for every person to obtain and configure,
 * which is exactly the friction automatic updates exist to remove.
 *
 * But every Alpha user has already run `gh auth login`; that is how the board
 * and their role work at all. `gh auth token` prints that token, so the update
 * check borrows the authentication they already have. Nothing new to set up,
 * no secret in the package, and someone without access to the repository
 * simply gets no updates rather than an error they cannot act on.
 *
 * The token is held in memory for the request and never written anywhere.
 */
function githubToken() {
  try {
    const { execFileSync } = require('node:child_process');
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return token || null;
  } catch {
    // No gh, not signed in, or no access. All mean "no updates", not "broken".
    return null;
  }
}

function startUpdateChecks(window) {
  // Never in development: electron-updater has no packaged app to compare
  // against and logs a confusing error every few hours.
  if (!app.isPackaged) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }

  const token = githubToken();
  if (!token) {
    console.log('Update check skipped: no GitHub token available from gh.');
    return;
  }
  process.env.GH_TOKEN = token;

  /**
   * Download automatically, install when the user is ready.
   *
   * Alpha spawns agent CLIs that write to a git checkout — restarting under one
   * would leave a half-finished run and a branch nobody expected. So the
   * download is silent and the restart is always the person's choice.
   */
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox(window, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Alpha update ready',
      message: `Alpha ${info.version} is ready to install.`,
      detail:
        'It will install when you next quit, or you can restart now. ' +
        'Your board, agents and history are unaffected — the database is migrated in place.'
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    // A failed check is not worth a dialog: the app works, it is just not the
    // newest. Logged so it is diagnosable, silent so it is not annoying.
    console.error('Update check failed:', err?.message || err);
  });

  autoUpdater.checkForUpdates().catch(() => {});
  // Every six hours, for the machine that stays open all week.
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
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

  // After the window exists, so an update dialog has a parent to attach to.
  startUpdateChecks(mainWindow);

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
