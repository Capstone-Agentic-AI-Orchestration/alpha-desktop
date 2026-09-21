/**
 * Build the frontend and backend, then stage them under alpha-desktop/build/.
 *
 * electron-builder only packages what lives inside this directory, so the two
 * sibling projects are compiled in place and their outputs copied here. Keeping
 * this as an explicit step (rather than a postinstall hook) means a failed
 * frontend build stops the packaging run instead of shipping a stale renderer.
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const root = path.resolve(desktop, '..');

const FE = path.join(root, 'alpha-fe-main');
const BE = path.join(root, 'alpha-be-main');
const OUT = path.join(desktop, 'build');

// The daemon address main.js binds, so the renderer is compiled to call it.
const { apiUrl, wsUrl } = createRequire(import.meta.url)('../desktop-address.cjs');

const run = (cmd, cwd, env = {}) => {
  console.log(`\n> ${cmd}   (${path.basename(cwd)})`);
  execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
};

/**
 * Deployment settings the installed app needs, and the only ones it may carry.
 *
 * An installer has no `.env`, and the daemon has no defaults for these any
 * more, so they are written into `build/app-config.json` at build time. An
 * allowlist rather than "everything in .env": this file ships inside the
 * installer, where anyone can read it, so it may only hold values that are
 * public already. SUPABASE_JWT_SECRET, GitHub secrets and private keys must
 * never be added here.
 */
const PUBLIC_SETTINGS = ['ALPHA_ORG', 'ALPHA_CLOUD_API', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];

const copyDir = (from, to) => {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
};

/**
 * 1. The backend's runtime dependencies must all be declared here.
 *
 * electron-builder packs the production dependencies of *this* package.json;
 * it never looks at the backend's. So `alpha-desktop/package.json` carries a
 * hand-copied duplicate of the backend's dependency list, and a duplicate
 * drifts — `@supabase/supabase-js` was added to the backend and never here, so
 * the packaged app required a module that was not inside it and died at
 * startup with "Alpha could not start".
 *
 * It survived a release because it only breaks on someone else's machine. Node
 * resolves a missing module by walking up the directory tree, and this
 * developer has a stray node_modules directly in their home folder with 533
 * packages in it — so an app installed anywhere under the home directory found
 * supabase there and started fine. Nobody else has that directory.
 *
 * Checked at build time because the failure is otherwise invisible until an
 * installer is on a stranger's machine. Types-only packages are skipped: they
 * are compiled away and never required at runtime.
 */
const beDeps = JSON.parse(fs.readFileSync(path.join(BE, 'package.json'), 'utf8')).dependencies ?? {};
const ownDeps = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).dependencies ?? {};

const missing = Object.keys(beDeps).filter(d => !d.startsWith('@types/') && !(d in ownDeps));
if (missing.length) {
  throw new Error(
    'alpha-desktop/package.json is missing backend runtime dependencies:\n' +
    missing.map(d => `  "${d}": "${beDeps[d]}"`).join('\n') +
    '\n\nAdd them to dependencies and run npm install, or the packaged app will ' +
    'fail to start with MODULE_NOT_FOUND.'
  );
}

// A version skew ships different code than the backend was tested against.
const skewed = Object.keys(beDeps)
  .filter(d => d in ownDeps && ownDeps[d] !== beDeps[d])
  .map(d => `  ${d}: backend ${beDeps[d]}, desktop ${ownDeps[d]}`);
if (skewed.length) {
  console.warn(`\nWarning — dependency versions differ from the backend:\n${skewed.join('\n')}`);
}

// 2. Frontend — must be built with base './' so assets resolve under file://.
//    Pointed at this desktop's own daemon. The environment outranks the
//    frontend's .env files in Vite, so a web-oriented .env.local cannot leak
//    a hosted address into the desktop renderer.
run('npm run build', FE, { VITE_API_URL: apiUrl, VITE_WS_URL: wsUrl });
const feDist = path.join(FE, 'dist');
if (!fs.existsSync(path.join(feDist, 'index.html'))) {
  throw new Error('Frontend build produced no index.html');
}

// 3. Backend — compiles to CommonJS, which the Electron main process requires
run('npm run build', BE);
const beDist = path.join(BE, 'dist');
if (!fs.existsSync(path.join(beDist, 'index.js'))) {
  throw new Error('Backend build produced no dist/index.js');
}

// 4. Stage both
fs.mkdirSync(OUT, { recursive: true });
copyDir(feDist, path.join(OUT, 'renderer'));
copyDir(beDist, path.join(OUT, 'server'));

const count = dir =>
  fs.readdirSync(dir, { recursive: true }).filter(f =>
    fs.statSync(path.join(dir, f)).isFile()
  ).length;

console.log(`\nstaged renderer: ${count(path.join(OUT, 'renderer'))} files`);
console.log(`staged server:   ${count(path.join(OUT, 'server'))} files`);

// 5. Deployment settings, from the build's environment, falling back to the
//    builder's own backend .env for a local `npm start`.
const localEnvFile = path.join(BE, '.env');
const localEnv = fs.existsSync(localEnvFile) ? dotenv.parse(fs.readFileSync(localEnvFile)) : {};

const appConfig = {};
for (const key of PUBLIC_SETTINGS) {
  const value = process.env[key] || localEnv[key];
  if (value) appConfig[key] = value;
}

if (!appConfig.ALPHA_ORG) {
  throw new Error(
    'ALPHA_ORG is not set, and the app would refuse to start without it. Set it ' +
      'in the build environment, or in alpha-be-main/.env for a local build.'
  );
}

fs.writeFileSync(path.join(OUT, 'app-config.json'), JSON.stringify(appConfig, null, 2) + '\n');
const unset = PUBLIC_SETTINGS.filter(key => !appConfig[key]);
console.log(`baked settings:  ${Object.keys(appConfig).join(', ')}`);
if (unset.length) console.log(`not set:         ${unset.join(', ')} (the app runs without cloud sync)`);
