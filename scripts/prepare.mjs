/**
 * Build the frontend and backend, then stage them under alpha-desktop/build/.
 *
 * electron-builder only packages what lives inside this directory, so the two
 * sibling projects are compiled in place and their outputs copied here. Keeping
 * this as an explicit step (rather than a postinstall hook) means a failed
 * frontend build stops the packaging run instead of shipping a stale renderer.
 */
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const root = path.resolve(desktop, '..');

const FE = path.resolve(process.env.ALPHA_FE_DIR || path.join(root, 'alpha-fe-main'));
const BE = path.resolve(process.env.ALPHA_BE_DIR || path.join(root, 'alpha-be-main'));
const OUT = path.join(desktop, 'build');

// A fallback for the renderer. Packaged launches receive their actual
// OS-assigned engine address through the Electron preload bridge.
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
const PUBLIC_SETTINGS = [
  'ALPHA_ORG',
  'ALPHA_CLOUD_API',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  // Required for all desktop project builds.
  'ALPHA_ORCHESTRATION_ENABLED',
  // Recovery guards shared by packaged and source-run desktop builds.
  'ALPHA_ORCHESTRATION_TRANSPORT_RETRIES',
  'ALPHA_ORCHESTRATION_MAX_TOKENS',
  'ALPHA_ORCHESTRATION_MAX_COST_USD',
  'ALPHA_ORCHESTRATION_MAX_BUILD_AGE_HOURS',
  // The CI template repository and ref: a desktop scaffolds repositories too.
  'ALPHAORCH_WORKFLOW_REPO',
  'ALPHAORCH_WORKFLOW_REF'
];

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

// A stale sibling checkout can build and package successfully while silently
// omitting the current project workspace UI. Fail packaging before it ships.
const internalAppBundles = fs.readdirSync(path.join(feDist, 'assets'))
  .filter(file => /^InternalApp-.*\.js$/.test(file));
if (internalAppBundles.length !== 1) {
  throw new Error(`Expected one built Alpha renderer bundle, found ${internalAppBundles.length}`);
}
const rendererBundle = fs.readFileSync(path.join(feDist, 'assets', internalAppBundles[0]), 'utf8');
if (!rendererBundle.includes('projects.workspaceTab:')
  || !rendererBundle.includes('Project sections')
  || rendererBundle.includes('Open repository & pipeline')) {
  throw new Error(
    'The frontend build is missing the project workspace tabs. Refresh alpha-fe-main to the merged desktop UI before packaging.'
  );
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

// 5. Deployment settings. Explicit build environment values win, then the
//    builder's backend .env, then the current staged public settings. Keeping
//    that fallback lets a local app start reuse its existing configuration.
const localEnvFile = path.join(BE, '.env');
const localEnv = fs.existsSync(localEnvFile) ? dotenv.parse(fs.readFileSync(localEnvFile)) : {};
const stagedConfigFile = path.join(OUT, 'app-config.json');
let stagedConfig = {};
if (fs.existsSync(stagedConfigFile)) {
  try {
    stagedConfig = JSON.parse(fs.readFileSync(stagedConfigFile, 'utf8'));
  } catch (err) {
    throw new Error('Could not read existing staged app-config.json: ' + (err?.message ?? err));
  }
}

const appConfig = {};
for (const key of PUBLIC_SETTINGS) {
  const value = process.env[key] || localEnv[key] || stagedConfig[key] ||
    (key === 'ALPHA_ORCHESTRATION_ENABLED' ? '1' : undefined);
  if (value) appConfig[key] = value;
}

if (!appConfig.ALPHA_ORG) {
  throw new Error(
    'ALPHA_ORG is not set, and the app would refuse to start without it. Set it ' +
      'in the build environment, or in the selected backend .env for a local build.'
  );
}

/**
 * 5a. The Supabase key has to be one the project accepts.
 *
 * These settings come from whoever runs the build, so a stale or mistyped key
 * in one person's .env reached every installed desktop through auto-update:
 * v2.0.11 shipped a key Supabase refused, and every Sync failed with "Could
 * not read the team board: Invalid API key". One request to the project's
 * auth settings -- public, and answered only for a valid key -- turns that
 * into a failed build on the builder's machine.
 *
 * A refusal stops the build. Not reaching Supabase at all only warns, so an
 * offline source build still works; do not publish one of those.
 */
const requireVerifiedSupabase = process.env.ALPHA_REQUIRE_SUPABASE_VERIFY === '1';
if (requireVerifiedSupabase && (!appConfig.SUPABASE_URL || !appConfig.SUPABASE_ANON_KEY)) {
  throw new Error('A desktop release needs both SUPABASE_URL and SUPABASE_ANON_KEY so the team board can be verified.');
}
if (appConfig.SUPABASE_URL && appConfig.SUPABASE_ANON_KEY) {
  const probe = new URL('/auth/v1/settings', appConfig.SUPABASE_URL);
  let status;
  let probeError;
  try {
    const res = await fetch(probe, {
      headers: { apikey: appConfig.SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(15_000)
    });
    status = res.status;
  } catch (err) {
    probeError = err;
    console.warn(
      `\nWarning — could not reach ${probe.origin} to check SUPABASE_ANON_KEY (${err?.message ?? err}).\n` +
      'The key is unverified. Do not publish this build.'
    );
  }
  if (status === 401 || status === 403) {
    throw new Error(
      `Supabase refused SUPABASE_ANON_KEY for ${probe.origin} (HTTP ${status}). Every installed app ` +
      'would fail Sync with "Invalid API key". Copy the current anon key from Supabase -> Project ' +
      'Settings -> API into the build environment or alpha-be-main/.env, and check SUPABASE_URL ' +
      'names the same project.'
    );
  }
  if (status !== undefined && status !== 200) {
    console.warn(`\nWarning — ${probe.origin} answered HTTP ${status} when checking SUPABASE_ANON_KEY.`);
  }
  if (requireVerifiedSupabase && status !== 200) {
    throw new Error(
      `The release build could not verify SUPABASE_ANON_KEY${status === undefined ? ` because ${probeError?.message ?? 'the Supabase check did not complete'}` : ` (HTTP ${status})`}. ` +
      'The live-test installer was not published.'
    );
  }
  if (status === 200) console.log('supabase key:    accepted by the project');
}

fs.writeFileSync(path.join(OUT, 'app-config.json'), JSON.stringify(appConfig, null, 2) + '\n');
const unset = PUBLIC_SETTINGS.filter(key => !appConfig[key]);
console.log(`baked settings:  ${Object.keys(appConfig).join(', ')}`);
if (unset.length) console.log(`not set:         ${unset.join(', ')} (the app runs without cloud sync)`);
if (!appConfig.ALPHAORCH_WORKFLOW_REPO || !appConfig.ALPHAORCH_WORKFLOW_REF) {
  console.warn(
    'scaffolding: ALPHAORCH_WORKFLOW_REPO / ALPHAORCH_WORKFLOW_REF are not both set; the installed app ' +
    'will refuse to create repositories until they are, because it would have no CI templates to give them.'
  );
}
if (!appConfig.ALPHA_CLOUD_API) {
  console.warn(
    'profile sign-in: ALPHA_CLOUD_API is not set; the installed app cannot target a remembered ' +
    'GitHub profile and will ask for a hosted API configuration instead of silently using the browser account.'
  );
}

/**
 * 5b. The staged daemon, started the way an installed app starts it.
 *
 * Twice now the installed app has broken where every test passed, because
 * the tests run on the developer's Node and the app runs on Electron's:
 *
 *  - supabase-js was missing from this package's dependencies, and resolved
 *    anyway on the builder's machine through a stray node_modules higher up;
 *  - supabase-js needed a global WebSocket, which Electron 33's Node 20 does
 *    not have, so the team board client never started in any installed copy
 *    -- no board, no realtime, developers refused Sync -- and nothing said so.
 *
 * So before packaging, the staged server is loaded by Electron's own binary
 * as Node, with the settings an installed app gets, and the team board
 * client has to come up. No mocks: the real modules, the real client, the
 * real runtime. A failure stops the release instead of reaching everyone.
 */
{
  const electronBinary = createRequire(import.meta.url)('electron');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-runtime-check-'));
  const server = path.join(OUT, 'server').replace(/\\/g, '/');
  const probe = `
    const { supabaseService } = require('${server}/services/supabaseService.js');
    require('${server}/controllers/dataController.js');
    require('${server}/controllers/workspaceController.js');
    const wanted = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
    const on = supabaseService.sharesBoard();
    const { ALPHA_ORCHESTRATION_ENABLED } = require('${server}/config/env.js');
    console.log(JSON.stringify({ node: process.versions.node, wanted, on, orchestratorEnabled: ALPHA_ORCHESTRATION_ENABLED,
      problem: typeof supabaseService.connectionProblem === 'function' ? supabaseService.connectionProblem() : null }));
    process.exit(wanted && !on ? 2 : !ALPHA_ORCHESTRATION_ENABLED ? 3 : 0);
  `;
  let out = '';
  try {
    out = execFileSync(electronBinary, ['-e', probe], {
      env: { ...process.env, ...appConfig, ELECTRON_RUN_AS_NODE: '1', ALPHA_PACKAGED: '1', ALPHA_HOME: scratch },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (err) {
    const detail = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    throw new Error(
      "The staged daemon does not start on Electron's Node, so the installed app would be broken:\n\n" +
        (detail || err.message)
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const result = JSON.parse(out.trim().split('\n').pop());
  console.log(`runtime check:   Electron Node ${result.node}, team board ${result.wanted ? (result.on ? 'connects' : 'FAILS') : 'not configured'}, orchestrator ${result.orchestratorEnabled ? 'enabled' : 'FAILS'}`);
}

/**
 * 6. The GitHub CLI, bundled.
 *
 * Identity, teams, the board and every push go through `gh`, and a teammate
 * who installed only Alpha did not have it -- so their first screen was a
 * terminal command to install a tool. The installer now carries it
 * (`extraResources` -> resources/gh) and main.js adds it to PATH.
 *
 * Pinned in package.json (`alphaVendor.gh`) by version AND sha256, and checked
 * before anything is extracted: a binary shipped to every developer's machine
 * must be exactly the one that was reviewed, not whatever the URL serves on
 * build day. Cached in vendor/ so only a version bump downloads again.
 *
 * gh is MIT-licensed; redistributing it means shipping its licence too.
 */
const { gh: ghPin } = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).alphaVendor ?? {};
if (!ghPin?.version || !ghPin?.sha256) {
  throw new Error('package.json alphaVendor.gh must pin both "version" and "sha256".');
}

const GH_DIR = path.join(desktop, 'vendor', 'gh');
const ghStamp = path.join(GH_DIR, 'VERSION');
const ghCached =
  fs.existsSync(path.join(GH_DIR, 'gh.exe')) &&
  fs.existsSync(ghStamp) &&
  fs.readFileSync(ghStamp, 'utf8').trim() === ghPin.version;

if (ghCached) {
  console.log(`bundled gh:      ${ghPin.version} (cached)`);
} else {
  const zipName = `gh_${ghPin.version}_windows_amd64.zip`;
  const url = `https://github.com/cli/cli/releases/download/v${ghPin.version}/${zipName}`;
  console.log(`\n> fetching ${url}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download gh ${ghPin.version}: HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());

  const actual = createHash('sha256').update(zip).digest('hex');
  if (actual !== ghPin.sha256) {
    throw new Error(
      `gh ${ghPin.version} failed its checksum: expected ${ghPin.sha256}, got ${actual}. ` +
        'Refusing to bundle it.'
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-gh-'));
  try {
    const zipPath = path.join(tmp, zipName);
    fs.writeFileSync(zipPath, zip);
    // Windows 10+ ships bsdtar, which reads zip archives; no extra dependency.
    // By absolute path, so a `tar` earlier on PATH cannot stand in for it
    // while this handles a downloaded archive.
    const systemTar = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
      : 'tar';
    execFileSync(systemTar, ['-xf', zipPath, '-C', tmp]);

    const find = (dir, name) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === name) return full;
        if (entry.isDirectory()) {
          const hit = find(full, name);
          if (hit) return hit;
        }
      }
      return undefined;
    };

    const ghExe = find(tmp, 'gh.exe');
    const license = find(tmp, 'license');
    if (!ghExe) throw new Error(`gh ${ghPin.version} archive contained no gh.exe`);

    fs.rmSync(GH_DIR, { recursive: true, force: true });
    fs.mkdirSync(GH_DIR, { recursive: true });
    fs.copyFileSync(ghExe, path.join(GH_DIR, 'gh.exe'));
    if (license) fs.copyFileSync(license, path.join(GH_DIR, 'LICENSE'));
    fs.writeFileSync(ghStamp, `${ghPin.version}\n`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`bundled gh:      ${ghPin.version} (sha256 verified)`);
}
