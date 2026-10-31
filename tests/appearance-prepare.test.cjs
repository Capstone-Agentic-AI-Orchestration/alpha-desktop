'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { fixture, manifest } = require('./appearance-fixture.cjs');

for (const mode of ['missing', 'mismatch', 'malformed', 'valid', 'staged', 'unconfigured', 'private-jwt', 'private-key']) {
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
    fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ dependencies: {} }));
    fs.writeFileSync(path.join(backend, 'package.json'), JSON.stringify({
      scripts: { build: 'node fail.cjs' }, dependencies: {}
    }));
    fs.writeFileSync(path.join(backend, 'fail.cjs'), "console.error('BACKEND_TEST_BOUNDARY'); process.exit(3);");
    fs.writeFileSync(path.join(f.frontend, 'package.json'), JSON.stringify({ scripts: { build: 'node build.cjs' } }));
    const anonKey = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url') + '.test';
    const privateKey = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.test';
    const envUrl = 'https://build.example.test';
    fs.writeFileSync(path.join(backend, '.env'), 'SUPABASE_URL=https://backend.example.test\nSUPABASE_ANON_KEY=' + anonKey + '\nSUPABASE_JWT_SECRET=backend-private-canary\n');
    fs.writeFileSync(path.join(f.buildDir, 'app-config.json'), JSON.stringify({
      SUPABASE_URL: 'https://staged.example.test', SUPABASE_ANON_KEY: 'sb_publishable_staged-test'
    }));
    if (mode === 'staged' || mode === 'unconfigured') fs.unlinkSync(path.join(backend, '.env'));
    if (mode === 'unconfigured') fs.unlinkSync(path.join(f.buildDir, 'app-config.json'));
    const expectedUrl = mode === 'unconfigured' ? '' : mode === 'staged' ? 'https://staged.example.test' : envUrl;
    const expectedKey = mode === 'unconfigured' ? '' : mode === 'staged' ? 'sb_publishable_staged-test' : anonKey;
    const output = manifest();
    if (mode === 'mismatch') output.themes['alpha-light'].canvas = '#EEEEEE';
    const build = `
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      assert.equal(process.env.VITE_SUPABASE_URL, ${JSON.stringify(expectedUrl)});
      assert.equal(process.env.VITE_SUPABASE_ANON_KEY, ${JSON.stringify(expectedKey)});
      assert.equal(process.env.VITE_SUPABASE_JWT_SECRET, undefined);
      console.log('PUBLIC_CONFIG_CHECKED');
      fs.mkdirSync('dist/assets', { recursive: true });
      fs.writeFileSync('dist/index.html', '<html>Alpha</html>');
      fs.writeFileSync('dist/assets/InternalApp-test.js', 'projects.workspaceTab: Project sections');
      ${mode === 'missing' ? '' : `fs.writeFileSync('dist/theme-manifest.json', ${JSON.stringify(mode === 'malformed' ? '{}' : JSON.stringify(output))});`}
    `;
    fs.writeFileSync(path.join(f.frontend, 'build.cjs'), build);
    const result = spawnSync(process.execPath, [path.join(scripts, 'prepare.mjs')], {
      cwd: f.root,
      env: {
        ...process.env, ALPHA_FE_DIR: f.frontend, ALPHA_BE_DIR: backend,
        SUPABASE_URL: mode === 'staged' || mode === 'unconfigured' ? '' : envUrl,
        SUPABASE_ANON_KEY: mode === 'private-jwt' ? privateKey : mode === 'private-key' ? 'sb_secret_do-not-bundle' : mode === 'staged' || mode === 'unconfigured' ? '' : anonKey,
        VITE_SUPABASE_URL: 'https://wrong-renderer.example.test',
        VITE_SUPABASE_ANON_KEY: 'wrong-renderer-key'
      },
      encoding: 'utf8', windowsHide: true, timeout: 30_000
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    const log = result.stdout + result.stderr;
    if (mode === 'missing') assert.match(log, /Cannot load appearance manifest/);
    if (mode === 'mismatch') assert.match(log, /does not match the selected source/);
    if (mode === 'malformed') assert.match(log, /Invalid appearance manifest/);
    if (mode.startsWith('private-')) {
      assert.match(log, /Refusing to bundle a private or invalid key/);
      assert.doesNotMatch(log, /PUBLIC_CONFIG_CHECKED/);
    } else assert.match(log, /PUBLIC_CONFIG_CHECKED/);
    if (['valid', 'staged', 'unconfigured'].includes(mode)) assert.match(log, /BACKEND_TEST_BOUNDARY/);
    else assert.doesNotMatch(log, /BACKEND_TEST_BOUNDARY/);
    assert.equal(fs.existsSync(path.join(f.buildDir, 'appearance-build.json')), false);
  });
}
