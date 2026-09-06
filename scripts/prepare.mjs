/**
 * Build the frontend and backend, then stage them under alpha-desktop/build/.
 *
 * electron-builder only packages what lives inside this directory, so the two
 * sibling projects are compiled in place and their outputs copied here. Keeping
 * this as an explicit step (rather than a postinstall hook) means a failed
 * frontend build stops the packaging run instead of shipping a stale renderer.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const root = path.resolve(desktop, '..');

const FE = path.join(root, 'alpha-fe-main');
const BE = path.join(root, 'alpha-be-main');
const OUT = path.join(desktop, 'build');

const run = (cmd, cwd) => {
  console.log(`\n> ${cmd}   (${path.basename(cwd)})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

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

// 2. Frontend — must be built with base './' so assets resolve under file://
run('npm run build', FE);
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
