'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { fixture, fakeWindow } = require('./appearance-fixture.cjs');
const { SET_THEME_CHANNEL, BOOTSTRAP_THEME_CHANNEL } = require('../appearance.cjs');

async function boot(f) {
  const app = new EventEmitter();
  const handlers = new Map(), listeners = new Map(), windows = [], errors = [];
  let startup, backendStarts = 0, quits = 0;
  app.getPath = () => f.userDataDir;
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => ({ then: callback => { startup = callback(); } });
  app.quit = () => quits++;
  app.isPackaged = false;
  app.commandLine = { appendSwitch() {} };
  const electron = {
    app, ipcMain: {
      handle: (channel, callback) => handlers.set(channel, callback),
      on: (channel, callback) => listeners.set(channel, callback)
    },
    Menu: { setApplicationMenu() {} },
    dialog: { showErrorBox: (...args) => errors.push(args) },
    BrowserWindow: function (options) {
      const window = fakeWindow(f.renderer);
      window.options = options;
      window.setMenuBarVisibility = () => {};
      window.webContents.setWindowOpenHandler = () => {};
      window.loadFile = file => { window.loaded = file; };
      windows.push(window);
      return window;
    }
  };
  const http = {
    get: (_options, callback) => {
      const request = new EventEmitter();
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        response.emit('data', JSON.stringify({ instance: 'test-instance' }));
        response.emit('end');
      });
      return request;
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), {
    __dirname: f.root, console, URL, Buffer, setTimeout, clearTimeout,
    process: { platform: 'win32', env: {}, exit: () => assert.fail('unexpected process exit') },
    require: name => {
      if (name === 'electron') return electron;
      if (name === 'node:http') return http;
      if (name === 'node:crypto') return { ...require(name), randomUUID: () => 'test-instance' };
      if (name === './desktop-address.cjs') return { HOST: '127.0.0.1', PORT: 4000 };
      if (name === './appearance.cjs') return require('../appearance.cjs');
      if (name === './local-preview-view.cjs') return { createPreviewSurface: () => ({ handle() {} }) };
      if (name === path.join(f.root, 'build', 'server', 'index.js')) {
        backendStarts++;
        return { server: { listening: true, listen() {}, address: () => ({ port: 54321 }) } };
      }
      if (name.endsWith(path.join('services', 'localPreviewService.js'))) return { localPreviewService: {} };
      return require(name);
    }
  });
  await startup;
  return { handlers, listeners, windows, errors, backendStarts, quits };
}

test('actual main startup wires persisted colors and matching preload argument before loadFile', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.preference, JSON.stringify({ version: 1, themeId: 'alpha-light' }));
  const result = await boot(f);
  assert.deepEqual(result.errors, []);
  assert.equal(result.backendStarts, 1);
  assert.equal(result.windows.length, 1);
  const window = result.windows[0];
  assert.equal(window.options.backgroundColor, '#FFFFFF');
  assert.equal(window.options.titleBarOverlay.color, '#F4F4F5');
  assert.equal(window.options.titleBarOverlay.symbolColor, '#18181B');
  assert.equal(window.options.webPreferences.additionalArguments.at(-1), '--alpha-theme=alpha-light');
  assert.equal(window.loaded, path.join(f.renderer, 'index.html'));
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  const setTheme = result.handlers.get(SET_THEME_CHANNEL);
  assert.deepEqual(setTheme({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, 'alpha-violet'), { themeId: 'alpha-violet' });
  assert.equal(window.backgrounds.at(-1), '#09090B');
  assert.throws(() => setTheme({ sender: window.webContents, senderFrame: {} }, 'alpha-light'), /Untrusted/);
});

test('actual main startup reports stale manifest and exits before backend or window creation', async t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.renderer, 'app.js'), '// stale');
  const result = await boot(f);
  assert.equal(result.backendStarts, 0);
  assert.equal(result.windows.length, 0);
  assert.equal(result.quits, 1);
  assert.match(result.errors[0][1], /Cannot verify packaged appearance manifest/);
});

test('appearance module is included in the electron-builder file allowlist', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.build.files.includes('appearance.cjs'));
  assert.ok(pkg.build.files.includes('build/**/*'));
});

test('main synchronous bootstrap returns cached ID before reload scripts and rejects invalid senders', async t => {
  const f = fixture(t);
  const result = await boot(f);
  const window = result.windows[0];
  const bootstrap = result.listeners.get(BOOTSTRAP_THEME_CHANNEL);
  const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  result.handlers.get(SET_THEME_CHANNEL)(sender, 'alpha-light');
  assert.equal(window.options.webPreferences.additionalArguments.at(-1), '--alpha-theme=alpha-violet');
  // Remove disk inputs after main initialized. Bootstrap must still return the
  // accepted nondefault ID, without touching persistence or manifest output.
  fs.rmSync(f.preference);
  fs.rmSync(path.join(f.renderer, 'theme-manifest.json'));
  let replies = 0;
  const event = { ...sender, set returnValue(value) {
    replies++;
    assert.equal(value, 'alpha-light');
  } };
  bootstrap(event);
  assert.equal(replies, 1);
  let reloadBridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), {
    process: { argv: ['electron', ...window.options.webPreferences.additionalArguments], platform: 'win32', versions: {} }, URL,
    require: name => name === 'electron' ? {
      contextBridge: { exposeInMainWorld: (_name, api) => { reloadBridge = api; } },
      ipcRenderer: {
        sendSync: channel => {
          const request = { ...sender };
          result.listeners.get(channel)(request);
          return request.returnValue;
        }
      }
    } : require(name === './appearance.cjs' ? '../appearance.cjs' : name)
  });
  // No did-finish-load notification has fired. The public initial property is
  // already current despite the original alpha-violet additionalArgument.
  assert.equal(reloadBridge.appearanceThemeId, 'alpha-light');
  const preview = fakeWindow(f.renderer);
  for (const invalid of [
    { sender: preview.webContents, senderFrame: preview.webContents.mainFrame },
    { sender: window.webContents, senderFrame: { url: window.webContents.mainFrame.url } },
    { sender: window.webContents, senderFrame: null }
  ]) {
    bootstrap(invalid);
    assert.equal(invalid.returnValue, null);
  }
  window.webContents.mainFrame.url = 'https://example.com/';
  const navigated = { ...sender };
  bootstrap(navigated);
  assert.equal(navigated.returnValue, null);
  window.destroyed = true;
  const closed = { ...sender };
  bootstrap(closed);
  assert.equal(closed.returnValue, null);
});
