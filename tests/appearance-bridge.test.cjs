'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { SET_THEME_CHANNEL, THEME_CHANGED_CHANNEL, BOOTSTRAP_THEME_CHANNEL } = require('../appearance.cjs');

function bridge(argv, bootstrap = () => null) {
  const ipcRenderer = new EventEmitter();
  const calls = [];
  const syncCalls = [];
  ipcRenderer.sendSync = (...args) => { syncCalls.push(args); return bootstrap(...args); };
  ipcRenderer.invoke = async (...args) => { calls.push(args); return { themeId: args[1] }; };
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), {
    require: name => name === 'electron' ? {
      contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'alphaDesktop'); api = value; } }, ipcRenderer
    } : require(name === './appearance.cjs' ? '../appearance.cjs' : name),
    process: { argv, platform: 'win32', versions: {} }, URL
  });
  return { api, ipcRenderer, calls, syncCalls };
}

test('preload preserves existing capabilities and exposes the startup ID and narrow setter', async () => {
  const { api, calls } = bridge(['electron', '--alpha-theme=alpha-light', '--alpha-api-base=http://127.0.0.1:54321/api']);
  assert.equal(api.appearanceThemeId, 'alpha-light');
  assert.equal(api.apiBase, 'http://127.0.0.1:54321/api');
  for (const method of ['appVersion', 'localPreview', 'selectFolder', 'checkForUpdates']) assert.equal(typeof api[method], 'function');
  assert.deepEqual(await api.setAppearanceTheme('alpha-violet'), { themeId: 'alpha-violet' });
  assert.deepEqual(calls, [[SET_THEME_CHANNEL, 'alpha-violet']]);
});

test('preload appearance subscription hides IPC event and supports independent unsubscribe', () => {
  const { api, ipcRenderer } = bridge(['electron']);
  assert.equal(api.appearanceThemeId, undefined);
  const received = [];
  const stop = api.onAppearanceThemeChanged((...args) => received.push(args));
  const other = [];
  const stopOther = api.onAppearanceThemeChanged(id => other.push(id));
  ipcRenderer.emit(THEME_CHANGED_CHANNEL, { sender: 'must not cross bridge' }, 'alpha-light');
  ipcRenderer.emit(THEME_CHANGED_CHANNEL, {}, { color: '#ffffff' });
  assert.deepEqual(received, [['alpha-light']]);
  stop();
  stop();
  ipcRenderer.emit(THEME_CHANGED_CHANNEL, {}, 'alpha-violet');
  assert.deepEqual(received, [['alpha-light']]);
  assert.deepEqual(other, ['alpha-light', 'alpha-violet']);
  stopOther();
  assert.equal(ipcRenderer.listenerCount(THEME_CHANGED_CHANNEL), 0);
  assert.throws(() => api.onAppearanceThemeChanged(null), /listener must be a function/);
});

test('malformed startup arguments are never exposed as theme IDs', () => {
  for (const value of ['', '../file', '#FFFFFF', 'alpha light', 'a'.repeat(65)]) {
    assert.equal(bridge(['electron', '--alpha-theme=' + value]).api.appearanceThemeId, undefined);
  }
});

test('each preload execution reads latest cached ID before bridge exposure despite stale startup argument', () => {
  let current = 'alpha-violet';
  const argv = ['electron', '--alpha-theme=alpha-violet'];
  const first = bridge(argv, () => current);
  assert.equal(first.api.appearanceThemeId, 'alpha-violet');
  current = 'alpha-light';
  const reloaded = bridge(argv, () => current);
  assert.equal(reloaded.api.appearanceThemeId, 'alpha-light');
  assert.deepEqual(reloaded.syncCalls, [[BOOTSTRAP_THEME_CHANNEL]]);
  assert.deepEqual(reloaded.calls, []);
});

test('bootstrap unavailable or malformed falls back to validated startup argument', () => {
  const argv = ['electron', '--alpha-theme=alpha-violet'];
  for (const value of [null, undefined, {}, 'constructor', '../file']) {
    assert.equal(bridge(argv, () => value).api.appearanceThemeId, 'alpha-violet');
  }
  assert.equal(bridge(argv, () => { throw new Error('unavailable'); }).api.appearanceThemeId, 'alpha-violet');
});
