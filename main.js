'use strict';

const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

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

const { app, BrowserWindow, dialog, ipcMain, shell, Menu, safeStorage } = electron;

/**
 * GPU drawing on Windows, with a software fallback only where it is needed.
 *
 * Some Windows GPU/driver combinations crash Chromium before Electron can
 * create the window or start Alpha's in-process API. Software compositing was
 * therefore forced on every Windows machine -- and on a large high-DPI screen
 * that made every animated frame cost about 130 ms in the browser's compositor,
 * which is the lag people felt when the navigation panel opened on hover.
 *
 * So the GPU is used by default, and software compositing is chosen when:
 *   - ALPHA_DISABLE_GPU=1 is set, or
 *   - the GPU process crashed on this machine before (remembered in
 *     gpu-state.json under the app's user data folder), or
 *   - the previous launch never got as far as showing its window, which is
 *     what the startup crash looked like.
 * Delete gpu-state.json to try the GPU again after a driver update.
 */
const GPU_STATE_FILE = path.join(app.getPath('userData'), 'gpu-state.json');

function readGpuState() {
  try {
    return JSON.parse(fs.readFileSync(GPU_STATE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeGpuState(state) {
  try {
    fs.mkdirSync(path.dirname(GPU_STATE_FILE), { recursive: true });
    fs.writeFileSync(GPU_STATE_FILE, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }));
  } catch {
    // Losing this record only means the next launch decides again.
  }
}

const previousGpuState = readGpuState();
const useSoftwareCompositing = process.platform === 'win32' && (
  process.env.ALPHA_DISABLE_GPU === '1' ||
  previousGpuState.mode === 'software' ||
  previousGpuState.launching === true
);

if (useSoftwareCompositing) {
  app.disableHardwareAcceleration();
  // Electron 33 can still spin up a GPU helper before the first window on
  // machines whose ANGLE/driver DLLs are unavailable. These switches make the
  // software-compositor choice explicit for the browser and GPU process.
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
} else if (process.platform === 'win32') {
  app.on('child-process-gone', (_event, details) => {
    if (details.type === 'GPU' && ['crashed', 'launch-failed', 'abnormal-exit', 'oom'].includes(details.reason)) {
      // Chromium falls back on its own for this session; remember it for the next.
      writeGpuState({ mode: 'software', reason: `GPU process ${details.reason}` });
    }
  });
}

/**
 * Record this launch's GPU decision -- only from the instance that owns the
 * window. A second launch that merely hands focus to the running app quits
 * before showing anything, and must not be mistaken for a crashed startup.
 */
function recordGpuLaunch() {
  if (process.platform !== 'win32') return;
  if (useSoftwareCompositing) {
    if (previousGpuState.mode !== 'software') {
      writeGpuState({
        mode: 'software',
        reason: process.env.ALPHA_DISABLE_GPU === '1' ? 'ALPHA_DISABLE_GPU' : 'previous launch did not finish starting'
      });
    }
    return;
  }
  // Cleared once the window is on screen. If this launch dies first, the next
  // one starts in software mode instead of crashing the same way.
  writeGpuState({ mode: previousGpuState.mode ?? 'hardware', launching: true });
}

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
 * daemon over HTTP exactly as it does in development. The desktop receives its
 * runtime address through the preload bridge; the web build keeps its
 * same-origin API configuration.
 */

const { HOST, PORT: BUILD_PORT } = require('./desktop-address.cjs');
const { createAppearance, SET_THEME_CHANNEL, BOOTSTRAP_THEME_CHANNEL } = require('./appearance.cjs');
const { LOCAL_TOKEN_CHANNEL, createLocalToken, isTrustedRendererSender } = require('./local-access.cjs');

let mainWindow = null;
let startupUpdateWindow = null;
let startupUpdateState = null;
let startupUpdateDecision = null;
let startupUpdateGateActive = false;
let appearance;
let previewSurface;
let previewService;
let focusWhenReady = false;
let PORT = BUILD_PORT;
const STARTUP_SESSION_TIMEOUT_MS = 15_000;
const STARTUP_UPDATE_CHECK_TIMEOUT_MS = 20_000;
const STARTUP_TIMEOUT_CODE = 'ALPHA_STARTUP_TIMEOUT';
const MAIN_WINDOW_HANDOFF_TIMEOUT_MS = 5_000;

function isPortableBuild() {
  return process.platform === 'win32' && Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
}

/**
 * Keep one process per Electron user profile; a duplicate launch simply brings
 * the existing window forward. The engine itself receives an OS-assigned
 * loopback port, so source runs and separately profiled test/install copies
 * can coexist without EADDRINUSE.
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();

const focusMainWindow = () => {
  const target = mainWindow || startupUpdateWindow;
  if (!target) {
    focusWhenReady = true;
    return;
  }
  if (target.isMinimized()) target.restore();
  if (!target.isVisible()) target.show();
  target.focus();
};

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  recordGpuLaunch();
  app.on('second-instance', focusMainWindow);
}

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

function waitForServerStart(server, timeoutMs = 20000) {
  if (server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Local engine did not bind a port within ${timeoutMs}ms`)), timeoutMs);
    const onListening = () => finish();
    const onError = err => finish(err);
    const finish = err => {
      clearTimeout(timer);
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
      if (err) reject(err);
      else resolve();
    };

    server.once('listening', onListening);
    server.once('error', onError);
  });
}

async function startBackend() {
  loadBuildConfig();
  addBundledGhToPath();

  /**
   * Tell the daemon it is an installed app rather than a checkout.
   *
   * It decides one thing with this: whether the machine's `gh` login may stand
   * in for a sign-in Alpha has not got. From source it may -- a developer has
   * `gh` set up and should not complete a device flow to run what they are
   * editing. Installed it must not, or the app opens straight onto the board as
   * whoever the terminal was signed in as, having asked nobody.
   */
  if (app.isPackaged) process.env.ALPHA_PACKAGED = '1';

  /**
   * A name for this launch's daemon, which it repeats back from /api/health.
   * `waitForBackend` opens the window only for a daemon that says it, so a
   * different process already on the port is refused, not used.
   */
  process.env.ALPHA_INSTANCE = INSTANCE;

  // Bind loopback and allow the file:// renderer through CORS. Both are set
  // before the server module is required, because it reads them at import time.
  process.env.HOST = HOST;
  // Let the OS reserve an available loopback port atomically. A fixed desktop
  // port collided with source runs and older installations; probing and then
  // closing a socket would leave a race before Express binds it.
  process.env.PORT = '0';
  process.env.CORS_ORIGIN = 'file://';

  /**
   * This launch's secret for the local engine.
   *
   * Loopback keeps other machines out, not other things on this one: a web
   * page can send requests to 127.0.0.1, and one rebound to it can read the
   * answers. The engine now refuses API calls and stream connections without
   * this token, and only this app's window is given it (see preload.js).
   *
   * Handed over as a global, never as an environment variable: the engine
   * runs in this process, and everything it spawns -- agents, verification,
   * MCP servers -- would inherit an environment variable, and with it the
   * whole API.
   */
  globalThis.__alphaLocalToken = LOCAL_TOKEN;

  /**
   * Encryption for the remembered GitHub accounts, handed to the daemon.
   *
   * The daemon keeps one token per remembered account so switching between
   * them does not go back to GitHub. `safeStorage` is Windows DPAPI here: only
   * this Windows user can open what it seals. The daemon also runs from source
   * with no Electron, so it takes this as an optional global rather than
   * importing Electron, and without it falls back to a user-only file.
   * Available only after `app` is ready, which it is by the time this runs.
   */
  globalThis.__alphaSecretSealer = {
    available: () => safeStorage.isEncryptionAvailable(),
    seal: plain => safeStorage.encryptString(plain).toString('base64'),
    open: sealed => safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  };

  const backend = require(path.join(__dirname, 'build', 'server', 'index.js'));
  previewService = require(path.join(__dirname, 'build', 'server', 'services', 'localPreviewService.js')).localPreviewService;
  if (!backend.server || typeof backend.server.listen !== 'function') {
    throw new Error('The local engine did not expose its listener to the desktop shell.');
  }
  await waitForServerStart(backend.server);

  const address = backend.server.address();
  if (!address || typeof address === 'string' || !address.port) {
    throw new Error('The local engine started without reporting its loopback port.');
  }
  PORT = address.port;
  process.env.ALPHA_DESKTOP_PORT = String(PORT);
}

const INSTANCE = crypto.randomUUID();
const LOCAL_TOKEN = createLocalToken();
const RENDERER_URL = pathToFileURL(path.join(__dirname, 'build', 'renderer', 'index.html')).href;
const STARTUP_UPDATE_FILE = path.join(__dirname, 'startup-update.html');
const STARTUP_UPDATE_URL = pathToFileURL(STARTUP_UPDATE_FILE).href;

/**
 * Resolve once *this app's* daemon answers, so the window never loads against
 * a dead backend -- or against someone else's.
 *
 * "Anything answering 200" was the old test, and a daemon run from source on
 * the same port passed it: the app opened as the terminal's `gh` account with
 * no sign-in, on the developer's own `.env`, where Sync failed with a project
 * manager's permission error. The health answer now has to carry INSTANCE.
 */
function waitForBackend(timeoutMs = 20000) {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(
        { host: HOST, port: PORT, path: '/api/health', timeout: 1500 },
        res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            if (res.statusCode !== 200) return retry();
            let instance;
            try {
              instance = JSON.parse(body).instance;
            } catch {
              return retry();
            }
            if (instance === INSTANCE) return resolve();
            // A healthy daemon that is not ours will not become ours by waiting.
            reject(new Error(
              `Another program is already using ${HOST}:${PORT} -- most likely Alpha running from ` +
              'source, or a copy of Alpha that did not close. Close it, then open Alpha again.'
            ));
          });
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

function setStartupUpdateState(state) {
  startupUpdateState = { ...state, version: app.getVersion() };
  if (!startupUpdateWindow || startupUpdateWindow.isDestroyed()) return;
  startupUpdateWindow.webContents.send('alpha:startup-update:state', startupUpdateState);
}

function destroyStartupUpdateWindow() {
  const window = startupUpdateWindow;
  startupUpdateWindow = null;
  if (window && !window.isDestroyed()) window.destroy();
}

function isTrustedStartupUpdateSender(event) {
  const window = startupUpdateWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
  // Only this window's top-level renderer may invoke startup actions. The
  // window itself also blocks navigation, so comparing serialized file URLs
  // here only risks rejecting a legitimate click due to Windows URL casing.
  return event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}

function createStartupUpdateWindow() {
  startupUpdateWindow = new BrowserWindow({
    width: 460,
    height: 390,
    minWidth: 460,
    minHeight: 390,
    maxWidth: 460,
    maxHeight: 390,
    center: true,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    title: 'Alpha',
    icon: path.join(__dirname, 'assets', 'alpha-mark.png'),
    backgroundColor: '#10131a',
    webPreferences: {
      preload: path.join(__dirname, 'startup-update-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  startupUpdateWindow.webContents.on('did-finish-load', () => {
    if (startupUpdateState && !startupUpdateWindow.isDestroyed()) {
      startupUpdateWindow.webContents.send('alpha:startup-update:state', startupUpdateState);
    }
  });
  startupUpdateWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  startupUpdateWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== STARTUP_UPDATE_URL) event.preventDefault();
  });
  startupUpdateWindow.once('ready-to-show', () => {
    if (!startupUpdateWindow || startupUpdateWindow.isDestroyed()) return;
    startupUpdateWindow.show();
    if (focusWhenReady) {
      focusWhenReady = false;
      startupUpdateWindow.focus();
    }
  });
  startupUpdateWindow.on('closed', () => { startupUpdateWindow = null; });
  startupUpdateWindow.loadFile(STARTUP_UPDATE_FILE);
  return startupUpdateWindow;
}

function waitForStartupUpdateDecision(message, title = 'Couldn’t check for updates') {
  return new Promise(resolve => {
    startupUpdateDecision = resolve;
    setStartupUpdateState({
      phase: 'error',
      title,
      message,
      canRetry: true,
      canContinue: true
    });
  });
}

ipcMain.handle('alpha:startup-update:action', (event, action) => {
  if (!isTrustedStartupUpdateSender(event)) return false;
  if (action === 'quit') {
    startupUpdateDecision = null;
    updaterLog?.info('Quit requested from the startup updater.');
    // Remove the splash immediately; app.quit() may wait for the local preview
    // service to shut down before Electron exits.
    destroyStartupUpdateWindow();
    app.quit();
    return true;
  }
  if (!['retry', 'continue'].includes(action) || !startupUpdateDecision || startupUpdateState?.phase !== 'error') {
    return false;
  }

  const resolve = startupUpdateDecision;
  startupUpdateDecision = null;
  resolve(action);
  return true;
});

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
 * But every Alpha user has already signed in to GitHub -- that is how the board
 * and their role work at all -- so the update check reuses that token rather
 * than asking for a second credential. Nothing new to set up, no secret in the
 * package, and someone without access to the repository simply gets no updates
 * rather than an error they cannot act on.
 *
 * Which sign-in, though, is the part that has moved: it was the machine's `gh`
 * login, and is now Alpha's own where there is one. A teammate who signs in
 * inside the app and never touches the CLI still gets updates.
 *
 * The token is held in memory for the request and never written anywhere.
 */
function githubToken() {
  /**
   * Connected Accounts moved Alpha's credential into the protected profile
   * vault. The old file below is migrated and removed when the daemon starts,
   * so looking for it here made a valid in-app sign-in look like no sign-in at
   * all. The backend is in this same Electron process; read the active,
   * authenticated session from its shared module instead of exposing the
   * token through the renderer or a local HTTP endpoint.
   */
  try {
    const auth = require(path.join(__dirname, 'build', 'server', 'services', 'alphaGitHubToken.js'));
    if (auth.isSessionAuthenticated()) {
      const token = auth.storedToken();
      if (token) return token;
    }
  } catch {
    // The backend may not have started yet. Keep the legacy/CLI fallbacks.
  }

  /**
   * Compatibility with the older credential layout. The backend migrates this
   * file into its protected account vault during startup; keep the fallback in
   * case the backend module is unavailable while checking an update.
   */
  try {
    const home = process.env.ALPHA_HOME || path.join(require('node:os').homedir(), '.alpha');
    const stored = JSON.parse(fs.readFileSync(path.join(home, 'github-credential.json'), 'utf8'));
    if (stored && stored.token) return stored.token;
  } catch {
    // Not signed in to Alpha yet, or the file is unreadable. Try the CLI.
  }

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

/**
 * The updater once initialized, so the startup gate and manual check can share
 * the same instance. It remains null in development builds.
 */
let updater = null;
let updaterLog = null;

/**
 * Where releases are read from. Must match package.json build.publish, which
 * also writes app-update.yml (tests/local-access.test.cjs checks they agree).
 */
const RELEASE_FEED = Object.freeze({
  provider: 'github',
  owner: 'Capstone-Agentic-AI-Orchestration',
  repo: 'alpha-desktop',
  private: true,
  releaseType: 'release'
});

/**
 * Point electron-updater at the private releases with the current GitHub token,
 * and say whether there was one. Shared by the scheduled checks and the manual
 * one, so a sign-in that happened since launch counts for both.
 *
 * The token goes to the updater directly. It used to be written to
 * process.env.GH_TOKEN, which the engine in this same process then passed to
 * every child it spawned: a project's npm install during verification could
 * read the person's GitHub token from its environment. setFeedURL replaces only
 * the release source; the cache folder and publisher still come from
 * app-update.yml.
 */
function applyGitHubToken(autoUpdater) {
  const token = githubToken();
  if (!token) return false;
  autoUpdater.setFeedURL({ ...RELEASE_FEED, token });
  return true;
}

function withStartupTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = STARTUP_TIMEOUT_CODE;
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

async function waitForRememberedGitHubSession() {
  try {
    const auth = require(path.join(__dirname, 'build', 'server', 'services', 'alphaGitHubToken.js'));
    await withStartupTimeout(
      auth.sessionReady?.(),
      STARTUP_SESSION_TIMEOUT_MS,
      'Restoring the remembered GitHub sign-in took too long.'
    );
    return true;
  } catch (err) {
    if (err?.code === STARTUP_TIMEOUT_CODE) return false;
    // The update flow below will show a retry/continue choice if no token is available.
    return true;
  }
}

function initializeUpdater() {
  // Never in development: electron-updater has no packaged app to compare.
  // Portable executables cannot be replaced by electron-updater's NSIS installer.
  if (!app.isPackaged || isPortableBuild()) return null;
  if (updater) return updater;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('Could not load the update service:', err?.message || err);
    return null;
  }

  updaterLog = require('electron-log');
  updaterLog.transports.file.level = 'info';
  autoUpdater.logger = updaterLog;
  // Checks made while Alpha is open report availability without downloading or
  // restarting. The startup gate owns the blocking download/install flow.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('download-progress', progress => {
    if (!startupUpdateGateActive) return;
    setStartupUpdateState({
      phase: 'downloading',
      title: `Updating Alpha to ${startupUpdateState?.targetVersion || 'the latest version'}`,
      message: 'Downloading and verifying the update before opening your workspace.',
      progress: Number.isFinite(progress.percent) ? progress.percent : 0,
      canRetry: false,
      canContinue: false
    });
  });

  autoUpdater.on('update-downloaded', info => {
    updaterLog.info(
      startupUpdateGateActive
        ? `Alpha ${info.version} startup update is ready to install.`
        : `Alpha ${info.version} update is staged for the next launch.`
    );
  });

  autoUpdater.on('error', err => {
    updaterLog.error('Update check failed:', err?.message || err);
  });

  updater = autoUpdater;
  return updater;
}

async function runStartupUpdateGate() {
  if (!app.isPackaged || isPortableBuild()) return { continueToApp: true, checked: false };
  startupUpdateGateActive = true;
  while (true) {
    setStartupUpdateState({
      phase: 'starting',
      title: 'Checking for updates',
      message: 'Restoring your GitHub sign-in so Alpha can read its private releases.',
      progress: 0,
      canRetry: false,
      canContinue: false
    });

    const sessionReady = await waitForRememberedGitHubSession();
    if (!sessionReady) {
      const action = await waitForStartupUpdateDecision(
        'Restoring your GitHub sign-in is taking longer than expected. Retry the check or open Alpha without checking.',
        'GitHub sign-in timed out'
      );
      if (action === 'retry') continue;
      startupUpdateGateActive = false;
      return { continueToApp: true, checked: false };
    }

    const autoUpdater = initializeUpdater();
    if (!autoUpdater) {
      const action = await waitForStartupUpdateDecision(
        'Alpha’s update service could not start. You can retry or open Alpha without checking.'
      );
      if (action === 'retry') continue;
      startupUpdateGateActive = false;
      return { continueToApp: true, checked: false };
    }

    if (!applyGitHubToken(autoUpdater)) {
      const action = await waitForStartupUpdateDecision(
        'Connect to GitHub in Alpha to check its private release feed. You can also open Alpha now.',
        'GitHub sign-in needed'
      );
      if (action === 'retry') continue;
      startupUpdateGateActive = false;
      return { continueToApp: true, checked: false };
    }

    setStartupUpdateState({
      phase: 'checking',
      title: 'Checking for updates',
      message: 'Looking for the latest Alpha release before opening your workspace.',
      progress: 0,
      canRetry: false,
      canContinue: false
    });

    // Keep auto-download disabled while checking; the launch gate explicitly
    // starts the download so its progress remains visible before the workspace.
    autoUpdater.autoDownload = false;

    try {
      const result = await withStartupTimeout(
        autoUpdater.checkForUpdates(),
        STARTUP_UPDATE_CHECK_TIMEOUT_MS,
        'The Alpha release service did not respond in time.'
      );
      if (!result) throw new Error('The update service did not return a release status.');

      if (!result.isUpdateAvailable) {
        setStartupUpdateState({
          phase: 'current',
          title: 'You’re up to date',
          message: 'Opening Alpha…',
          progress: 100,
          canRetry: false,
          canContinue: false
        });
        await new Promise(resolve => setTimeout(resolve, 500));
        startupUpdateGateActive = false;
        return { continueToApp: true, checked: true };
      }

      const targetVersion = result.updateInfo?.version || result.versionInfo?.version || 'the latest version';
      startupUpdateState = { ...(startupUpdateState || {}), targetVersion };
      setStartupUpdateState({
        phase: 'downloading',
        title: `Updating Alpha to ${targetVersion}`,
        message: 'Downloading and verifying the update before opening your workspace.',
        progress: 0,
        canRetry: false,
        canContinue: false,
        targetVersion
      });
      const download = result.downloadPromise || autoUpdater.downloadUpdate();
      await download;

      setStartupUpdateState({
        phase: 'installing',
        title: 'Finishing the update',
        message: 'Alpha will restart automatically when the update is ready.',
        progress: 100,
        canRetry: false,
        canContinue: false,
        targetVersion
      });
      await new Promise(resolve => setTimeout(resolve, 650));
      updaterLog?.info(`Installing startup update ${targetVersion} silently.`);
      autoUpdater.quitAndInstall(true, true);
      return { continueToApp: false, restarting: true, checked: true };
    } catch (err) {
      updaterLog?.error('Startup update check failed:', err?.message || err);
      const timedOut = err?.code === STARTUP_TIMEOUT_CODE;
      const action = await waitForStartupUpdateDecision(
        timedOut
          ? 'The release check is taking longer than expected. Retry or open Alpha without checking.'
          : 'Alpha couldn’t reach or download its latest release. Check your connection, retry, or open Alpha anyway.',
        timedOut ? 'Update check timed out' : 'Couldn’t check for updates'
      );
      if (action === 'retry') continue;
      startupUpdateGateActive = false;
      return { continueToApp: true, checked: false };
    }
  }
}

/**
 * Which version this is, for a UI that wants to say so.
 *
 * The renderer cannot read package.json: it is served over HTTP from the
 * daemon in both builds, and in the packaged app that file is inside the asar.
 * Settings displayed a hard-coded "2.0.0" instead, which was wrong the moment
 * 2.0.1 shipped and would have stayed wrong forever.
 */
ipcMain.handle('alpha:app-version', () => app.getVersion());
/**
 * The engine's launch token, for this app's own window and nothing else.
 *
 * Synchronous so preload has it before any page script runs. Always answered,
 * so a refused sender is not left blocked; a frame that is not the packaged
 * renderer in the main window -- a preview, a navigated page -- gets null.
 */
ipcMain.on(LOCAL_TOKEN_CHANNEL, event => {
  let token = null;
  try {
    if (isTrustedRendererSender(event, mainWindow, RENDERER_URL)) token = LOCAL_TOKEN;
  } catch {
    // Destroyed or navigating contents get nothing.
  }
  event.returnValue = token;
});
ipcMain.on(BOOTSTRAP_THEME_CHANNEL, event => {
  // Always answer synchronous IPC, including rejection, to avoid blocking the
  // preload. Only a trusted Alpha main frame receives the cached ID.
  let themeId = null;
  try {
    if (appearance) themeId = appearance.bootstrapThemeId(event);
  } catch {
    // Untrusted/closed/navigated contents receive no appearance state.
  }
  event.returnValue = themeId;
});
ipcMain.handle(SET_THEME_CHANNEL, (event, themeId) => {
  if (!appearance) throw new Error('Appearance is unavailable.');
  return appearance.setTheme(event, themeId);
});
ipcMain.handle('alpha:local-preview', (event, action, value) => {
  if (!previewSurface) throw new Error('Local preview surface is unavailable.');
  return previewSurface.handle(event, action, value);
});

/** The native folder picker behind alphaDesktop.selectFolder: the chosen folder, or null if cancelled. */
ipcMain.handle('alpha:select-folder', async event => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: 'Choose a folder',
    buttonLabel: 'Choose folder',
    properties: ['openDirectory', 'createDirectory', 'promptToCreate']
  };
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
});

/** Settings can check availability on demand; installation remains launch-only. */
ipcMain.handle('alpha:check-for-updates', async () => {
  if (!app.isPackaged) {
    return { status: 'unsupported', reason: 'Updates apply to the installed app, not one run from source.' };
  }
  if (isPortableBuild()) {
    return { status: 'unsupported', reason: 'Portable Alpha copies need to be downloaded again to update; automatic installation is supported by the installer build.' };
  }
  if (!updater) {
    return { status: 'unsupported', reason: 'Updates need the app to have started its update checks. Restart Alpha.' };
  }
  // Releases are in a private repository: without a sign-in there is nothing to
  // read them with, and saying so beats reporting "up to date".
  if (!applyGitHubToken(updater)) {
    return { status: 'unsupported', reason: 'Sign in to GitHub in Connected Accounts, so Alpha can read its own releases.' };
  }
  // Settings is an optional availability check, not a second update flow.
  // Leave downloading and installation to the next launch's visible gate.
  updater.autoDownload = false;
  try {
    const result = await updater.checkForUpdates();
    return result?.isUpdateAvailable
      ? { status: 'available', version: result.updateInfo?.version }
      : { status: 'current', version: app.getVersion() };
  } catch (err) {
    return { status: 'error', message: err?.message ? String(err.message) : String(err) };
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    // The renderer owns the product navigation. Keep Electron's native menu
    // hidden so Windows does not add a second File/Edit/View/Window/Help bar
    // above the Alpha workspace.
    autoHideMenuBar: true,
    title: 'Alpha',
    /**
     * No native title bar on Windows.
     *
     * It only repeated the page title ("Alpha — AI work, orchestrated") above
     * a workspace that already has its own toolbar. Windows still draws the
     * minimize, maximize and close buttons over the top-right corner, in the
     * workspace colour; the renderer leaves room for them and marks its
     * toolbar as the area that moves the window (see App.tsx, index.css).
     */
    ...appearance.windowOptions(),
    // Windows takes the taskbar icon from the packaged .exe, so this matters
    // when running from source -- without it a developer's window is the
    // default Electron circle while everyone else's is the product.
    icon: path.join(__dirname, 'assets', 'alpha-mark.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The engine gets an OS-assigned port at launch. Pass that address to the
      // isolated renderer rather than baking a shared port into the installer.
      additionalArguments: [
        `--alpha-api-base=http://${HOST}:${PORT}/api`,
        `--alpha-ws-url=ws://${HOST}:${PORT}`,
        appearance.startupArgument()
      ],
      // Non-negotiable: the renderer displays model-generated text and tool
      // output. With nodeIntegration on, any injected string in that output
      // could reach child_process.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  appearance.addWindow(mainWindow);
  mainWindow.setMenuBarVisibility(false);
  previewSurface = require('./local-preview-view.cjs').createPreviewSurface({ electron, window: mainWindow, service: previewService });
  // Keep the window named "Alpha" for the taskbar and Alt+Tab, rather than
  // adopting the web page's longer <title>.
  mainWindow.on('page-title-updated', event => event.preventDefault());

  let mainWindowRevealed = false;
  let mainWindowRevealTimer = null;
  const revealMainWindow = () => {
    if (mainWindowRevealed || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindowRevealed = true;
    if (mainWindowRevealTimer) clearTimeout(mainWindowRevealTimer);
    mainWindow.show();
    // The updater window is a non-closable, frameless splash. Destroy it
    // explicitly so it cannot remain above Alpha after the workspace appears.
    destroyStartupUpdateWindow();
    if (process.platform === 'win32' && !useSoftwareCompositing && readGpuState().mode !== 'software') {
      writeGpuState({ mode: 'hardware', launching: false });
    }
    if (focusWhenReady) {
      focusWhenReady = false;
      mainWindow.focus();
    }
  };

  // A heavy renderer can delay Electron's first-paint ready-to-show event. Once
  // the document has loaded, show the workspace and retire the update splash;
  // ready-to-show remains the preferred earlier handoff when it fires first.
  mainWindow.once('ready-to-show', revealMainWindow);
  mainWindow.webContents.once('did-finish-load', revealMainWindow);
  mainWindowRevealTimer = setTimeout(() => {
    updaterLog?.warn('Workspace handoff timed out; showing Alpha and closing the startup updater.');
    revealMainWindow();
  }, MAIN_WINDOW_HANDOFF_TIMEOUT_MS);
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (isMainFrame) {
      console.error(`Alpha workspace failed to load (${errorCode}): ${errorDescription}`);
    }
  });

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
  mainWindow.on('closed', () => {
    if (mainWindowRevealTimer) clearTimeout(mainWindowRevealTimer);
    mainWindow = null;
    // Never leave a stale startup updater behind if Alpha closes during handoff.
    destroyStartupUpdateWindow();
  });
}

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    try {
      // Electron creates a default application menu when none is supplied. Alpha
      // is a focused workspace app, so remove that Windows menu before creating
      // the first window instead of leaving an empty native chrome strip.
      Menu.setApplicationMenu(null);
      if (app.isPackaged && !isPortableBuild()) {
        setStartupUpdateState({
          phase: 'starting',
          title: 'Preparing Alpha',
          message: 'Starting local services before checking for updates.',
          progress: 0,
          canRetry: false,
          canContinue: false
        });
        createStartupUpdateWindow();
      }
      appearance = createAppearance({
        buildDir: path.join(__dirname, 'build'),
        userDataDir: app.getPath('userData')
      });
      await startBackend();
      await waitForBackend();

      const updateGate = await runStartupUpdateGate();
      if (!updateGate.continueToApp) return;
    } catch (err) {
      // Surface the reason instead of opening a window onto nothing.
      destroyStartupUpdateWindow();
      dialog.showErrorBox(
        'Alpha could not start',
        `Alpha startup failed.\n\n${err && err.message ? err.message : String(err)}`
      );
      app.quit();
      return;
    }

    createWindow();

    // The startup gate is the automatic update check. Settings can perform an
    // optional availability check, but there are no scheduled background checks.

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  // Quit on every platform: the backend lives in this process, so leaving it
  // running with no window would keep a hidden server (and any agent it
  // spawned) alive.
  app.quit();
});

let previewShutdown = false;
app.on('before-quit', event => {
  if (!previewService || previewShutdown) return;
  event.preventDefault();
  previewShutdown = true;
  previewSurface?.detach();
  previewService.shutdown().catch(error => console.error('Preview shutdown:', error.message)).finally(() => app.quit());
});
