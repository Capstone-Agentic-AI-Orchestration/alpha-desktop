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

// 1. Frontend — must be built with base './' so assets resolve under file://
run('npm run build', FE);
const feDist = path.join(FE, 'dist');
if (!fs.existsSync(path.join(feDist, 'index.html'))) {
  throw new Error('Frontend build produced no index.html');
}

// 2. Backend — compiles to CommonJS, which the Electron main process requires
run('npm run build', BE);
const beDist = path.join(BE, 'dist');
if (!fs.existsSync(path.join(beDist, 'index.js'))) {
  throw new Error('Backend build produced no dist/index.js');
}

// 3. Stage both
fs.mkdirSync(OUT, { recursive: true });
copyDir(feDist, path.join(OUT, 'renderer'));
copyDir(beDist, path.join(OUT, 'server'));

const count = dir =>
  fs.readdirSync(dir, { recursive: true }).filter(f =>
    fs.statSync(path.join(dir, f)).isFile()
  ).length;

console.log(`\nstaged renderer: ${count(path.join(OUT, 'renderer'))} files`);
console.log(`staged server:   ${count(path.join(OUT, 'server'))} files`);
