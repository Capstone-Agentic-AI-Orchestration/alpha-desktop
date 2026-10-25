'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { writeAppearanceReceipt } = require('../appearance.cjs');

function manifest() {
  return {
    schemaVersion: 1, defaultId: 'alpha-violet', themes: {
      'alpha-violet': { id: 'alpha-violet', mode: 'dark', canvas: '#09090B', shell: '#0D0D11', symbol: '#A1A1AA' },
      'alpha-light': { id: 'alpha-light', mode: 'light', canvas: '#FFFFFF', shell: '#F4F4F5', symbol: '#18181B' }
    }
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-appearance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buildDir = path.join(root, 'build');
  const renderer = path.join(buildDir, 'renderer');
  const frontend = path.join(root, 'frontend');
  const userDataDir = path.join(root, 'profile');
  const json = JSON.stringify(manifest());
  for (const dir of [renderer, path.join(frontend, 'public'), path.join(frontend, 'dist'), userDataDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(renderer, 'index.html'), '<html>Alpha</html>');
  fs.writeFileSync(path.join(renderer, 'app.js'), '// renderer');
  for (const dir of [renderer, path.join(frontend, 'public'), path.join(frontend, 'dist')]) {
    fs.writeFileSync(path.join(dir, 'theme-manifest.json'), json);
  }
  writeAppearanceReceipt(buildDir);
  return { root, buildDir, renderer, frontend, userDataDir, preference: path.join(userDataDir, 'appearance.json') };
}

function fakeWindow(renderer) {
  const window = new EventEmitter();
  window.destroyed = false;
  window.isDestroyed = () => window.destroyed;
  window.backgrounds = [];
  window.overlays = [];
  window.messages = [];
  window.setBackgroundColor = color => window.backgrounds.push(color);
  window.setTitleBarOverlay = value => window.overlays.push(value);
  const contents = new EventEmitter();
  contents.mainFrame = { url: pathToFileURL(path.join(renderer, 'index.html')).href + '#/settings' };
  contents.isDestroyed = () => window.destroyed;
  contents.send = (...args) => window.messages.push(args);
  window.webContents = contents;
  return window;
}

module.exports = { manifest, fixture, fakeWindow };
