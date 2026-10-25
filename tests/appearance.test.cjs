'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateManifest, verifyFrontendManifest, loadAppearanceManifest, createAppearance, THEME_CHANGED_CHANNEL
} = require('../appearance.cjs');
const { manifest, fixture, fakeWindow } = require('./appearance-fixture.cjs');

test('valid manifest is immutable and rejects invalid schema, IDs, default, mode and colors', () => {
  assert.ok(Object.isFrozen(validateManifest(manifest()).themes['alpha-violet']));
  const invalid = [
    value => { value.schemaVersion = 2; },
    value => { value.defaultId = 'alpha-light'; },
    value => { delete value.themes['alpha-violet']; },
    value => { value.themes = []; },
    value => { value.extra = 'ignored?'; },
    value => { value.themes['../escape'] = value.themes['alpha-light']; },
    value => { value.themes.constructor = { ...value.themes['alpha-light'], id: 'constructor' }; },
    value => { value.themes['alpha-light'].id = 'mismatch'; },
    value => { value.themes['alpha-light'].mode = 'system'; },
    value => { value.themes['alpha-light'].canvas = '#fff'; },
    value => { value.themes['alpha-light'].shell = '#FFFFFFFF'; },
    value => { value.themes['alpha-light'].symbol = 'red; background:url(file:///secret)'; },
    value => { value.themes['alpha-light'].css = 'body{}'; }
  ];
  for (const mutate of invalid) {
    const value = manifest();
    mutate(value);
    assert.throws(() => validateManifest(value), /Invalid appearance manifest/);
  }
});

test('selected frontend public and dist manifests must both exist, validate and match exactly', t => {
  const f = fixture(t);
  assert.equal(verifyFrontendManifest(f.frontend).defaultId, 'alpha-violet');
  const output = path.join(f.frontend, 'dist', 'theme-manifest.json');
  const different = manifest();
  different.themes['alpha-light'].canvas = '#EEEEEE';
  fs.writeFileSync(output, JSON.stringify(different));
  assert.throws(() => verifyFrontendManifest(f.frontend), /does not match/);
  fs.writeFileSync(output, '{}');
  assert.throws(() => verifyFrontendManifest(f.frontend), /Invalid appearance manifest/);
  fs.rmSync(output);
  assert.throws(() => verifyFrontendManifest(f.frontend), /Cannot load appearance manifest/);
  fs.writeFileSync(output, JSON.stringify(manifest()));
  fs.rmSync(path.join(f.frontend, 'public', 'theme-manifest.json'));
  assert.throws(() => verifyFrontendManifest(f.frontend), /Cannot load appearance manifest/);
});

for (const [name, mutate] of [
  ['missing receipt', f => fs.rmSync(path.join(f.buildDir, 'appearance-build.json'))],
  ['corrupt receipt', f => fs.writeFileSync(path.join(f.buildDir, 'appearance-build.json'), 'broken')],
  ['invalid receipt', f => fs.writeFileSync(path.join(f.buildDir, 'appearance-build.json'), '{}')],
  ['missing manifest', f => fs.rmSync(path.join(f.renderer, 'theme-manifest.json'))],
  ['invalid manifest', f => fs.writeFileSync(path.join(f.renderer, 'theme-manifest.json'), '{}')],
  ['stale manifest', f => fs.appendFileSync(path.join(f.renderer, 'theme-manifest.json'), '\n')],
  ['stale index', f => fs.appendFileSync(path.join(f.renderer, 'index.html'), 'old')],
  ['stale bundle', f => fs.appendFileSync(path.join(f.renderer, 'app.js'), 'old')],
  ['missing index', f => fs.rmSync(path.join(f.renderer, 'index.html'))]
]) {
  test(`startup rejects ${name}`, t => {
    const f = fixture(t);
    mutate(f);
    assert.throws(() => loadAppearanceManifest(f.buildDir), /appearance manifest/);
  });
}

test('packaging map exclusion does not invalidate a valid receipt', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.renderer, 'app.js.map'), '{}');
  assert.equal(loadAppearanceManifest(f.buildDir).schemaVersion, 1);
});

test('missing and corrupt preferences default; valid saved selection controls early chrome and argument', t => {
  const f = fixture(t);
  for (const value of [undefined, '{bad json', 'null', '[]', '{}',
    JSON.stringify({ version: 2, themeId: 'alpha-light' }),
    JSON.stringify({ version: 1, themeId: 'removed-theme' }),
    JSON.stringify({ version: 1, themeId: 'constructor' }),
    JSON.stringify({ version: 1, themeId: { canvas: '#FFFFFF' } }),
    JSON.stringify({ version: 1, themeId: 'alpha-light', color: '#FFFFFF' })]) {
    if (value !== undefined) fs.writeFileSync(f.preference, value);
    const appearance = createAppearance({ ...f, platform: 'win32' });
    assert.equal(appearance.startupArgument(), '--alpha-theme=alpha-violet');
    assert.equal(appearance.windowOptions().backgroundColor, '#09090B');
  }
  fs.writeFileSync(f.preference, JSON.stringify({ version: 1, themeId: 'alpha-light' }));
  const appearance = createAppearance({ ...f, platform: 'win32' });
  assert.equal(appearance.startupArgument(), '--alpha-theme=alpha-light');
  assert.deepEqual(appearance.windowOptions(), {
    backgroundColor: '#FFFFFF', titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#F4F4F5', symbolColor: '#18181B', height: 40 }
  });
});

test('trusted theme changes persist atomically and synchronize registered Alpha windows only', t => {
  const f = fixture(t);
  const appearance = createAppearance({ ...f, platform: 'win32' });
  const first = fakeWindow(f.renderer), second = fakeWindow(f.renderer), preview = fakeWindow(f.renderer);
  appearance.addWindow(first);
  appearance.addWindow(second);
  const result = appearance.setTheme({ sender: first.webContents, senderFrame: first.webContents.mainFrame }, 'alpha-light');
  assert.deepEqual(result, { themeId: 'alpha-light' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.preference)), { version: 1, themeId: 'alpha-light' });
  assert.deepEqual(fs.readdirSync(f.userDataDir), ['appearance.json']);
  for (const window of [first, second]) {
    assert.equal(window.backgrounds.at(-1), '#FFFFFF');
    assert.deepEqual(window.overlays.at(-1), { color: '#F4F4F5', symbolColor: '#18181B', height: 40 });
    assert.deepEqual(window.messages, [[THEME_CHANGED_CHANNEL, 'alpha-light']]);
  }
  assert.deepEqual(preview.messages, []);
  second.webContents.emit('did-finish-load');
  assert.equal(second.messages.length, 2);
  assert.equal(createAppearance({ ...f }).startupArgument(), '--alpha-theme=alpha-light');
  second.emit('closed');
  appearance.setTheme({ sender: first.webContents, senderFrame: first.webContents.mainFrame }, 'alpha-violet');
  assert.equal(second.messages.length, 2);
});

test('preview, foreign window, subframe, missing frame and navigated main frame cannot set appearance', t => {
  const f = fixture(t);
  const appearance = createAppearance({ ...f, platform: 'win32' });
  const main = fakeWindow(f.renderer), preview = fakeWindow(f.renderer);
  appearance.addWindow(main);
  for (const event of [
    { sender: preview.webContents, senderFrame: preview.webContents.mainFrame },
    { sender: main.webContents, senderFrame: { url: main.webContents.mainFrame.url } },
    { sender: main.webContents, senderFrame: null },
    { sender: main.webContents }
  ]) assert.throws(() => appearance.setTheme(event, 'alpha-light'), /Untrusted appearance sender/);
  for (const url of ['https://example.com/', 'file:///elsewhere/index.html', 'about:blank']) {
    main.webContents.mainFrame.url = url;
    assert.throws(() => appearance.setTheme({ sender: main.webContents, senderFrame: main.webContents.mainFrame }, 'alpha-light'), /Untrusted/);
  }
  assert.equal(fs.existsSync(f.preference), false);
  assert.deepEqual(main.messages, []);
});

test('only an allowlisted string ID can be persisted or applied', t => {
  const f = fixture(t);
  const appearance = createAppearance({ ...f, platform: 'win32' });
  const main = fakeWindow(f.renderer);
  appearance.addWindow(main);
  const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  for (const id of [null, {}, { themeId: 'alpha-light' }, ['alpha-light'], 1, '', '#FFFFFF', '../escape', 'unknown', 'constructor', '__proto__', 'alpha-light;']) {
    assert.throws(() => appearance.setTheme(event, id), /Invalid appearance theme ID/);
  }
  assert.equal(fs.existsSync(f.preference), false);
  assert.equal(main.backgrounds.length, 1);
});

test('persistence output errors leave current state, chrome and broadcasts unchanged and clean temporary files', t => {
  const f = fixture(t);
  // A directory at the destination reliably makes the final atomic rename fail,
  // even when the tests run as an administrator on Windows.
  fs.mkdirSync(f.preference);
  const appearance = createAppearance({ ...f, platform: 'win32' });
  const main = fakeWindow(f.renderer);
  appearance.addWindow(main);
  assert.throws(() => appearance.setTheme({ sender: main.webContents, senderFrame: main.webContents.mainFrame }, 'alpha-light'), /Could not save appearance preference/);
  assert.equal(appearance.startupArgument(), '--alpha-theme=alpha-violet');
  assert.equal(main.backgrounds.length, 1);
  assert.deepEqual(main.messages, []);
  assert.deepEqual(fs.readdirSync(f.userDataDir), ['appearance.json']);
});

test('other platforms change canvas without enabling an unsupported title bar overlay', t => {
  const f = fixture(t);
  const appearance = createAppearance({ ...f, platform: 'darwin' });
  const main = fakeWindow(f.renderer);
  appearance.addWindow(main);
  assert.deepEqual(appearance.windowOptions(), { backgroundColor: '#09090B' });
  appearance.setTheme({ sender: main.webContents, senderFrame: main.webContents.mainFrame }, 'alpha-light');
  assert.deepEqual(main.overlays, []);
  assert.equal(main.backgrounds.at(-1), '#FFFFFF');
});

test('unusable profile directory rejects saves without a cleanup error masking the cause', t => {
  const f = fixture(t);
  const blocked = path.join(f.root, 'profile-file');
  fs.writeFileSync(blocked, 'not a directory');
  const appearance = createAppearance({ ...f, userDataDir: blocked, platform: 'win32' });
  const main = fakeWindow(f.renderer);
  appearance.addWindow(main);
  assert.throws(() => appearance.setTheme({ sender: main.webContents, senderFrame: main.webContents.mainFrame }, 'alpha-light'), /Could not save appearance preference/);
  assert.equal(appearance.startupArgument(), '--alpha-theme=alpha-violet');
  assert.deepEqual(main.messages, []);
});
