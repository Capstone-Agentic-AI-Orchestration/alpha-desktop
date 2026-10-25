'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const SET_THEME_CHANNEL = 'alpha:set-appearance-theme';
const THEME_CHANGED_CHANNEL = 'alpha:appearance-theme-changed';
const BOOTSTRAP_THEME_CHANNEL = 'alpha:appearance-theme-bootstrap';
const MANIFEST_NAME = 'theme-manifest.json';
const RECEIPT_NAME = 'appearance-build.json';
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const validId = id => typeof id === 'string' && id.length <= 64 && ID.test(id)
  && !['constructor', 'prototype', '__proto__'].includes(id);

function validateManifest(value) {
  if (!exactKeys(value, ['schemaVersion', 'defaultId', 'themes']) || value.schemaVersion !== 1
      || value.defaultId !== 'alpha-violet' || !record(value.themes)
      || !Object.hasOwn(value.themes, value.defaultId)) {
    throw new Error('Invalid appearance manifest schema or defaultId (expected alpha-violet).');
  }
  const themes = Object.create(null);
  for (const [id, theme] of Object.entries(value.themes)) {
    if (!validId(id) || !exactKeys(theme, ['id', 'mode', 'canvas', 'shell', 'symbol'])
        || theme.id !== id || !['light', 'dark'].includes(theme.mode)
        || !['canvas', 'shell', 'symbol'].every(key => typeof theme[key] === 'string' && COLOR.test(theme[key]))) {
      throw new Error('Invalid appearance manifest theme ID, mode or color.');
    }
    themes[id] = Object.freeze({ ...theme });
  }
  return Object.freeze({ schemaVersion: 1, defaultId: value.defaultId, themes: Object.freeze(themes) });
}

function readManifest(file) {
  try {
    return validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    throw new Error(`Cannot load appearance manifest at ${file}: ${error.message}`);
  }
}

// The exact selected source must agree with its freshly generated Vite output.
function verifyFrontendManifest(frontendDir, rendererDir = path.join(frontendDir, 'dist')) {
  const source = path.join(frontendDir, 'public', MANIFEST_NAME);
  const output = path.join(rendererDir, MANIFEST_NAME);
  const manifest = readManifest(source);
  readManifest(output);
  if (!fs.readFileSync(source).equals(fs.readFileSync(output))) {
    throw new Error('Frontend appearance manifest output does not match the selected source public/theme-manifest.json.');
  }
  return manifest;
}

// Match electron-builder's map exclusion. Bind the manifest to every shipped
// renderer file, so mixing old staging with a new manifest cannot pass startup.
function rendererDigest(rendererDir) {
  const hash = createHash('sha256');
  const visit = (dir, relative = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file, name);
      else if (entry.isFile()) {
        if (entry.name.endsWith('.map')) continue;
        hash.update(name + '\0');
        hash.update(createHash('sha256').update(fs.readFileSync(file)).digest('hex') + '\n');
      } else throw new Error('Unsupported renderer output entry: ' + name);
    }
  };
  // A manifest alone is not a usable renderer build.
  if (!fs.statSync(path.join(rendererDir, 'index.html')).isFile()) throw new Error('Missing renderer index.html.');
  visit(rendererDir);
  return hash.digest('hex');
}

function writeAppearanceReceipt(buildDir) {
  const renderer = path.join(buildDir, 'renderer');
  readManifest(path.join(renderer, MANIFEST_NAME));
  fs.writeFileSync(path.join(buildDir, RECEIPT_NAME), JSON.stringify({
    version: 1, rendererSha256: rendererDigest(renderer)
  }) + '\n');
}

function loadAppearanceManifest(buildDir) {
  // No sibling checkout, working-directory, environment or palette fallback.
  const renderer = path.join(buildDir, 'renderer');
  const manifest = readManifest(path.join(renderer, MANIFEST_NAME));
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(path.join(buildDir, RECEIPT_NAME), 'utf8'));
    if (!exactKeys(receipt, ['version', 'rendererSha256']) || receipt.version !== 1
        || !/^[a-f0-9]{64}$/.test(receipt.rendererSha256)
        || receipt.rendererSha256 !== rendererDigest(renderer)) throw new Error('stale or invalid renderer receipt');
  } catch (error) {
    throw new Error('Cannot verify packaged appearance manifest; run prepare:build: ' + error.message);
  }
  return manifest;
}

function readPreference(file, manifest) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (exactKeys(value, ['version', 'themeId']) && value.version === 1
        && validId(value.themeId) && Object.hasOwn(manifest.themes, value.themeId)) return value.themeId;
  } catch {
    // Missing, corrupt or inaccessible preferences use the manifest default.
  }
  return manifest.defaultId;
}

function savePreference(file, themeId) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, themeId }) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    throw new Error('Could not save appearance preference: ' + error.message);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {
      // Cleanup must not hide the original write error (e.g. an inaccessible
      // profile directory). A uniquely named leftover cannot replace a save.
    }
  }
}

function createAppearance({ buildDir, userDataDir, platform = process.platform }) {
  const manifest = loadAppearanceManifest(buildDir);
  const preferenceFile = path.join(userDataDir, 'appearance.json');
  const rendererUrl = pathToFileURL(path.join(buildDir, 'renderer', 'index.html')).href;
  const windows = new Set();
  let themeId = readPreference(preferenceFile, manifest);
  const alive = window => !window.isDestroyed() && !window.webContents.isDestroyed();
  const trustedUrl = raw => {
    try {
      const url = new URL(raw);
      url.hash = '';
      url.search = '';
      return url.href === rendererUrl;
    } catch { return false; }
  };
  const overlay = theme => ({ color: theme.shell, symbolColor: theme.symbol, height: 40 });
  const apply = window => {
    const theme = manifest.themes[themeId];
    window.setBackgroundColor(theme.canvas);
    if (platform === 'win32') window.setTitleBarOverlay(overlay(theme));
  };
  const notify = window => {
    if (alive(window) && trustedUrl(window.webContents.mainFrame.url)) {
      window.webContents.send(THEME_CHANGED_CHANNEL, themeId);
    }
  };
  const assertTrustedSender = event => {
    const owner = [...windows].find(window => alive(window) && window.webContents === event.sender);
    if (!owner || !event.senderFrame || event.senderFrame !== owner.webContents.mainFrame
        || !trustedUrl(event.senderFrame.url)) throw new Error('Untrusted appearance sender.');
  };
  return {
    bootstrapThemeId(event) {
      assertTrustedSender(event);
      // This synchronous preload bootstrap must only read the cached selection.
      // No preference/manifest I/O or native window work may happen here.
      return themeId;
    },
    windowOptions() {
      const theme = manifest.themes[themeId];
      return {
        backgroundColor: theme.canvas,
        ...(platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: overlay(theme) } : {})
      };
    },
    startupArgument: () => `--alpha-theme=${themeId}`,
    addWindow(window) {
      windows.add(window);
      apply(window);
      // Supplemental notification; preload's synchronous bootstrap already
      // supplies the current ID before renderer scripts on initial load/reload.
      window.webContents.on('did-finish-load', () => notify(window));
      window.once('closed', () => windows.delete(window));
    },
    setTheme(event, id) {
      assertTrustedSender(event);
      if (!validId(id) || !Object.hasOwn(manifest.themes, id)) throw new Error('Invalid appearance theme ID.');
      // Synchronous main-process writes serialize requests. A failed write
      // rejects without changing the current theme, chrome or broadcasts.
      savePreference(preferenceFile, id);
      themeId = id;
      for (const window of windows) {
        if (!alive(window)) continue;
        apply(window);
        notify(window);
      }
      return { themeId };
    }
  };
}

module.exports = {
  SET_THEME_CHANNEL, THEME_CHANGED_CHANNEL, BOOTSTRAP_THEME_CHANNEL, validateManifest, verifyFrontendManifest,
  writeAppearanceReceipt, loadAppearanceManifest, createAppearance
};
