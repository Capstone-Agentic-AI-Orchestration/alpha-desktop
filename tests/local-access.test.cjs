'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createLocalToken, isLocalToken, isTrustedRendererSender } = require('../local-access.cjs');

const RENDERER = 'file:///C:/Program%20Files/Alpha/resources/app.asar/build/renderer/index.html';

function windowWith(url) {
  const mainFrame = { url };
  const webContents = { mainFrame, isDestroyed: () => false };
  return { webContents, isDestroyed: () => false };
}

test('tokens are 256-bit hex and differ per launch', () => {
  const a = createLocalToken();
  const b = createLocalToken();
  assert.ok(isLocalToken(a));
  assert.notEqual(a, b);
  for (const bad of [undefined, null, '', 'abc', 'G'.repeat(64), 'a'.repeat(63)]) assert.equal(isLocalToken(bad), false);
});

test('only the renderer main frame in the main window is trusted', () => {
  const window = windowWith(RENDERER + '#/board');
  const ok = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  assert.equal(isTrustedRendererSender(ok, window, RENDERER), true);

  // A subframe of the same window.
  assert.equal(isTrustedRendererSender({ sender: window.webContents, senderFrame: { url: RENDERER } }, window, RENDERER), false);
  // Another contents, such as a preview view.
  assert.equal(isTrustedRendererSender({ sender: {}, senderFrame: window.webContents.mainFrame }, window, RENDERER), false);
  // The window navigated somewhere else.
  const navigated = windowWith('https://evil.example/');
  assert.equal(isTrustedRendererSender({ sender: navigated.webContents, senderFrame: navigated.webContents.mainFrame }, navigated, RENDERER), false);
  // No window yet, or a destroyed one.
  assert.equal(isTrustedRendererSender(ok, null, RENDERER), false);
  assert.equal(isTrustedRendererSender(ok, { ...window, isDestroyed: () => true }, RENDERER), false);
});

test('main.js keeps the GitHub token out of the environment and matches the publish config', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /process\.env\.(GH_TOKEN|GITHUB_TOKEN)\s*=/);
  assert.doesNotMatch(main, /process\.env\.ALPHA_LOCAL_TOKEN\s*=/);
  assert.doesNotMatch(main, /--alpha-local-token/);

  const { publish } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).build;
  const feed = main.match(/const RELEASE_FEED = Object\.freeze\((\{[\s\S]*?\})\);/);
  assert.ok(feed, 'RELEASE_FEED not found');
  const parsed = Function(`return (${feed[1]});`)();
  assert.deepEqual(parsed, publish);
});

test('the module ships with the app', () => {
  const { files } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).build;
  assert.ok(files.includes('local-access.cjs'));
});
