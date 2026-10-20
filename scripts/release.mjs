/**
 * Build the app and publish it as a GitHub Release, in one command.
 *
 * The installed app checks for updates on launch and every six hours, reading
 * the releases of this repository. Until one exists it finds nothing, every
 * time, forever -- which is where this project has been: auto-update fully
 * wired and never able to fire.
 *
 * `electron-builder --publish always` does the upload, including `latest.yml`,
 * which is the file the updater actually reads to learn a newer version is
 * out. Attaching the installer by hand and forgetting that file is the usual
 * way a release looks published and updates nobody.
 *
 * The token comes from `gh`, the same login the rest of Alpha uses on a
 * desktop, so there is no second credential to keep anywhere.
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { publishReleaseNotes } from './releaseNotes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));

const say = (message) => console.log(message);
const die = (message) => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

/**
 * A desktop release must be able to reach the shared cloud API. `prepare.mjs`
 * deliberately allows source builds without it, but that would make a
 * published installer silently lose cloud relay features (including ticket
 * requests). Resolve the same inputs as the build without changing either
 * the shell environment or the developer's .env file.
 */
const backendEnvFile = path.resolve(desktop, '..', 'alpha-be-main', '.env');
const backendEnv = fs.existsSync(backendEnvFile)
  ? dotenv.parse(fs.readFileSync(backendEnvFile))
  : {};
const stagedConfigFile = path.join(desktop, 'build', 'app-config.json');
let stagedConfig = {};
if (fs.existsSync(stagedConfigFile)) {
  try {
    stagedConfig = JSON.parse(fs.readFileSync(stagedConfigFile, 'utf8'));
  } catch (err) {
    die(`Could not read staged app-config.json: ${err?.message ?? err}`);
  }
}
const cloudApi = (process.env.ALPHA_CLOUD_API || backendEnv.ALPHA_CLOUD_API || stagedConfig.ALPHA_CLOUD_API || '').trim();
if (!cloudApi) {
  die(
    'ALPHA_CLOUD_API is required for a desktop release. Set it in the release environment ' +
    'or alpha-be-main/.env. No source or hosted settings were changed.'
  );
}
try {
  const address = new URL(cloudApi);
  if (address.protocol !== 'https:' || !address.pathname.replace(/\/$/, '').endsWith('/api')
    || address.username || address.password || address.search || address.hash) {
    die('ALPHA_CLOUD_API must be an HTTPS API base URL ending in /api, without credentials or query parameters.');
  }
} catch {
  die('ALPHA_CLOUD_API must be a valid HTTPS API base URL ending in /api.');
}

/** The repository releases go to, from the same config electron-builder reads. */
const repo = (() => {
  const publish = pkg.build?.publish;
  const entry = Array.isArray(publish) ? publish[0] : publish;
  if (!entry || entry.provider !== 'github') {
    die('package.json build.publish is not a GitHub provider, so there is nowhere to publish to.');
  }
  // electron-builder infers owner/repo from the git remote when they are not
  // named, which is what this project relies on; resolve it the same way.
  if (entry.owner && entry.repo) return `${entry.owner}/${entry.repo}`;
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: desktop, windowsHide: true })
    .toString()
    .trim();
  const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/i);
  if (!match) die(`Could not tell which repository to publish to from "${remote}".`);
  return match[1];
})();

const token = (() => {
  try {
    return execFileSync('gh', ['auth', 'token'], { windowsHide: true }).toString().trim();
  } catch {
    return '';
  }
})();
if (!token) die('Not signed in to GitHub. Run `gh auth login`, then try again.');

/**
 * A version that is already released updates nobody: electron-updater offers
 * an update only when the release is *newer* than what is installed. Caught
 * here rather than after a twenty-minute build and a confusing 422 from the
 * upload.
 */
const tag = `v${pkg.version}`;
const existing = (() => {
  try {
    return JSON.parse(
      execFileSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'tagName,isDraft'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      }).toString()
    );
  } catch {
    return null;
  }
})();

if (existing && !existing.isDraft) {
  die(
    `${tag} is already released on ${repo}.\n` +
      `Raise "version" in alpha-desktop/package.json first -- an update is only offered for a higher version.`
  );
}

say(`Releasing ${tag} to ${repo}`);
say('Building the renderer, the daemon and the installer. This takes a few minutes.\n');

// A constant command line, with nothing interpolated into it; the shell is
// here only for `&&`.
execSync('npm run prepare:build && npx electron-builder --win --publish always', {
  cwd: desktop,
  stdio: 'inherit',
  env: { ...process.env, GH_TOKEN: token, ALPHA_ORCHESTRATION_ENABLED: '1' }
});

say(`\nPublished ${tag}.`);
say('Installed copies will offer it on their next check (on launch, and every six hours).');
say(`Release page: https://github.com/${repo}/releases/tag/${tag}`);

try {
  const count = await publishReleaseNotes({ desktop, version: pkg.version, tag, repo, token });
  say(`Release notes written, with ${count} checksum(s).`);
} catch (err) {
  // The release is published and working by now; notes are not worth failing
  // it over, and the reason is more useful than a stack trace.
  say(`The release is published, but its notes could not be written: ${err.message}`);
}
