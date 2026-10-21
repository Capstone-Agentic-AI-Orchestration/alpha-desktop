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
const gh = (() => {
  const bundled = path.join(desktop, 'vendor', 'gh', 'gh.exe');
  return fs.existsSync(bundled) ? bundled : 'gh';
})();

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

/**
 * Releases must originate from a pushed release branch. electron-builder's
 * GitHub publisher creates a missing release tag without a target commit;
 * GitHub then defaults that tag to the repository's default branch. We create
 * and push the version tag from this branch after the package checks pass, so
 * a live-test release can never silently tag main.
 */
const git = (args) => execFileSync('git', args, { cwd: desktop, windowsHide: true }).toString().trim();
const branch = git(['branch', '--show-current']);
const requiredSourceBranch = process.env.ALPHA_RELEASE_SOURCE_BRANCH?.trim();
for (const source of [
  { name: 'frontend', cwd: path.resolve(desktop, '..', 'alpha-fe-main') },
  { name: 'backend', cwd: path.resolve(desktop, '..', 'alpha-be-main') }
]) {
  const sourceGit = (args) => execFileSync('git', args, { cwd: source.cwd, windowsHide: true }).toString().trim();
  let sourceBranch;
  let sourceCommit;
  let remoteCommit;
  try {
    sourceBranch = sourceGit(['branch', '--show-current']);
    sourceCommit = sourceGit(['rev-parse', 'HEAD']);
    const sourceChanges = sourceGit(['status', '--porcelain', '--untracked-files=all'])
      .split(/\r?\n/).filter(Boolean);
    const uncommittedBuildInputs = sourceChanges.filter(line => {
      const state = line.slice(0, 2);
      const file = line.slice(3).replace(/\\/g, '/');
      // The frontend workspace keeps generated design-audit reports here;
      // Vite builds only its configured source/public inputs, so retain them
      // locally without treating them as release source changes.
      return !(source.name === 'frontend' && state === '??' && file.startsWith('artifacts/ui-review/'));
    });
    if (uncommittedBuildInputs.length) {
      die(`Commit the ${source.name} source checkout before packaging. The release must use a reviewable source commit.`);
    }
    if (requiredSourceBranch && sourceBranch !== requiredSourceBranch) {
      die(`The ${source.name} source checkout is on ${sourceBranch || '(detached HEAD)'}, but this release requires ${requiredSourceBranch}.`);
    }
    const remoteLine = sourceGit(['ls-remote', '--heads', 'origin', `refs/heads/${sourceBranch}`]).split(/\s+/);
    remoteCommit = remoteLine[0] ?? '';
  } catch (error) {
    die(`Could not verify the ${source.name} source checkout and its pushed branch: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!sourceBranch || !remoteCommit || remoteCommit !== sourceCommit) {
    die(`Push the ${source.name} source branch at ${sourceCommit} before packaging. The release will not use an unpushed or detached source commit.`);
  }
  say(`Source ${source.name}: ${sourceBranch} @ ${sourceCommit}`);
}
const defaultBranch = (() => {
  try { return git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, ''); }
  catch { return ''; }
})();
if (!branch || ['main', 'master', defaultBranch].filter(Boolean).includes(branch) || !branch.startsWith('release/')) {
  die(`Run desktop releases from a dedicated release/... branch; the current branch is "${branch || '(detached HEAD)'}".`);
}
if (git(['status', '--porcelain'])) {
  die('Commit and push the release branch before packaging. The release tool will not publish uncommitted source changes.');
}
const headCommit = git(['rev-parse', 'HEAD']);
const remoteBranch = git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]).split(/\s+/)[0] ?? '';
if (!remoteBranch || remoteBranch !== headCommit) {
  die('Push this release branch to GitHub at its current commit before packaging. No release tag was created.');
}

const token = (() => {
  try {
    return execFileSync(gh, ['auth', 'token'], { windowsHide: true }).toString().trim();
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
const localTagCommit = (() => {
  try { return git(['rev-parse', `${tag}^{commit}`]); }
  catch { return ''; }
})();
const remoteTagLines = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
const remoteTagCommit = (() => {
  const lines = remoteTagLines.split(/\r?\n/).filter(Boolean);
  const peeled = lines.find(line => line.endsWith(`refs/tags/${tag}^{}`));
  const direct = lines.find(line => line.endsWith(`refs/tags/${tag}`));
  return (peeled ?? direct)?.split(/\s+/)[0] ?? '';
})();
if ((localTagCommit && localTagCommit !== headCommit) || (remoteTagCommit && remoteTagCommit !== headCommit)) {
  die(`${tag} already points to a different commit. Raise the version before publishing; no existing tag will be changed.`);
}
const existing = (() => {
  try {
    return JSON.parse(
      execFileSync(gh, ['release', 'view', tag, '--repo', repo, '--json', 'tagName,isDraft'], {
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

execSync('npm run prepare:build', {
  cwd: desktop,
  stdio: 'inherit',
  env: { ...process.env, GH_TOKEN: token, ALPHA_ORCHESTRATION_ENABLED: '1', ALPHA_REQUIRE_SUPABASE_VERIFY: '1' }
});

if (!localTagCommit) execFileSync('git', ['tag', '-a', tag, '-m', `Release ${tag}`], { cwd: desktop, windowsHide: true });
if (!remoteTagCommit) {
  execFileSync('git', ['push', 'origin', `refs/tags/${tag}`], { cwd: desktop, stdio: 'inherit', windowsHide: true });
}
say(`Release tag ${tag} points to ${branch} at ${headCommit}.`);

execSync('npx electron-builder --win --publish always', {
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
