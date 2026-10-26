'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { fixture, manifest } = require('./appearance-fixture.cjs');

for (const mode of ['missing', 'mismatch', 'malformed', 'valid']) {
  test(`isolated prepare checks selected frontend output (${mode}) and invalidates old staging`, t => {
    const f = fixture(t);
    const scripts = path.join(f.root, 'scripts');
    const backend = path.join(f.root, 'backend');
    fs.mkdirSync(scripts);
    fs.mkdirSync(backend);
    const desktop = path.resolve(__dirname, '..');
    // Bind the existing dotenv dependency by URL in the isolated script copy;
    // every build input/output and subprocess remains under this test's scratch.
    const prepare = fs.readFileSync(path.join(desktop, 'scripts', 'prepare.mjs'), 'utf8')
      .replace("from 'dotenv'", `from '${pathToFileURL(require.resolve('dotenv')).href}'`);
    fs.writeFileSync(path.join(scripts, 'prepare.mjs'), prepare);
    for (const file of ['appearance.cjs', 'desktop-address.cjs']) {
      fs.copyFileSync(path.join(desktop, file), path.join(f.root, file));
    }
    fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ version: '2.0.67', dependencies: {} }));
    fs.writeFileSync(path.join(backend, 'package.json'), JSON.stringify({
      scripts: { build: 'node fail.cjs' }, dependencies: {}
    }));
    fs.writeFileSync(path.join(backend, 'fail.cjs'), "console.error('BACKEND_TEST_BOUNDARY'); process.exit(3);");
    fs.writeFileSync(path.join(f.frontend, 'package.json'), JSON.stringify({ scripts: { build: 'node build.cjs' } }));
    const output = manifest();
    if (mode === 'mismatch') output.themes['alpha-light'].canvas = '#EEEEEE';
    const build = `
      const fs = require('node:fs');
      fs.mkdirSync('dist/assets', { recursive: true });
      fs.writeFileSync('dist/index.html', '<html>Alpha</html>');
      fs.writeFileSync('dist/assets/InternalApp-test.js', 'projects.workspaceTab: Project sections');
      console.log('ALPHA_CLIENT_VERSION=' + process.env.VITE_ALPHA_CLIENT_VERSION);
      ${mode === 'missing' ? '' : `fs.writeFileSync('dist/theme-manifest.json', ${JSON.stringify(mode === 'malformed' ? '{}' : JSON.stringify(output))});`}
    `;
    fs.writeFileSync(path.join(f.frontend, 'build.cjs'), build);
    const result = spawnSync(process.execPath, [path.join(scripts, 'prepare.mjs')], {
      cwd: f.root,
      env: { ...process.env, ALPHA_FE_DIR: f.frontend, ALPHA_BE_DIR: backend },
      encoding: 'utf8', windowsHide: true, timeout: 30_000
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    const log = result.stdout + result.stderr;
    assert.match(log, /ALPHA_CLIENT_VERSION=2\.0\.67/);
    if (mode === 'missing') assert.match(log, /Cannot load appearance manifest/);
    if (mode === 'mismatch') assert.match(log, /does not match the selected source/);
    if (mode === 'malformed') assert.match(log, /Invalid appearance manifest/);
    if (mode === 'valid') assert.match(log, /BACKEND_TEST_BOUNDARY/);
    else assert.doesNotMatch(log, /BACKEND_TEST_BOUNDARY/);
    assert.equal(fs.existsSync(path.join(f.buildDir, 'appearance-build.json')), false);
  });
}
