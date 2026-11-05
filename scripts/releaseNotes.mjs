/**
 * The text on a release page, because the download ends in a security dialog.
 *
 * Alpha carries no code-signing signature, so the first thing anyone sees after
 * clicking Download is Windows announcing that it "protected your PC" -- beside
 * an empty release page, which reads as confirmation that something is wrong.
 * It is not: SmartScreen warns about every binary it has no publisher for. The
 * page people are already looking at is the cheapest place to say so, and a
 * certificate -- the only thing that removes the dialog -- is a yearly cost.
 *
 * The checksums are the part that is actually verifiable. Lacking a signature,
 * they are what lets someone confirm the installer they hold is the one this
 * build produced, byte for byte.
 *
 * Separate from release.mjs so it can be run against a release that already
 * exists, rather than only ever on the way out of a twenty-minute build.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledGh = path.resolve(here, '..', 'vendor', 'gh', 'gh.exe');
const gh = fs.existsSync(bundledGh) ? bundledGh : 'gh';

const sha256 = async (file) => {
  const hash = createHash('sha256');
  // Streamed rather than read whole: these run to ~93MB each.
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
};

/** The built installers for this version, newest build first is irrelevant -- name order is stable. */
export function artifactsFor(releaseDir, version) {
  return fs
    .readdirSync(releaseDir)
    .filter(name => name.endsWith('.exe') && name.includes(version))
    .sort();
}

export async function buildNotes(releaseDir, version) {
  const artifacts = artifactsFor(releaseDir, version);
  if (!artifacts.length) throw new Error(`no .exe artifacts for ${version} in ${releaseDir}`);

  const sums = [];
  for (const name of artifacts) {
    sums.push('| `' + name + '` | `' + (await sha256(path.join(releaseDir, name))) + '` |');
  }

  // The installer, not the portable build: it is what the page tells people to
  // take, and the only one the updater can replace later.
  const installer = artifacts.find(name => !/portable/i.test(name)) ?? artifacts[0];

  return [
    '## Install',
    '',
    'Download **' + installer + '** below and run it.',
    '',
    'Windows will show **"Windows protected your PC"**. Alpha carries no',
    'code-signing signature, so SmartScreen has no publisher to attribute the',
    'file to. It is not a report that anything is wrong with the file. Click',
    '**More info**, then **Run anyway**.',
    '',
    'The portable build needs no installation, but it does not update itself.',
    '',
    '## Required updates',
    '',
    'Starting with this version, installed copies check for updates before the',
    'workspace opens. If a newer release exists, Alpha requires it to be',
    'downloaded and installed before you can continue. Choose **Download and',
    'install**; Alpha restarts when the update is ready.',
    '',
    'The portable build cannot update itself. Download the latest setup',
    'installer from this release page to move a portable user to the latest',
    'version.',
    '',
    '## Verify what you downloaded',
    '',
    '```powershell',
    'Get-FileHash ' + installer + ' -Algorithm SHA256',
    '```',
    '',
    'It should match the line for that file below.',
    '',
    '| File | SHA-256 |',
    '| :--- | :--- |',
    ...sums,
    ''
  ].join('\n');
}

/**
 * Put those notes on the release. Returns how many files were checksummed.
 *
 * `gh` rather than a fetch: it is already how this script authenticates, and a
 * release edit is not worth a second way of talking to GitHub.
 */
export async function publishReleaseNotes({ desktop, version, tag, repo, token }) {
  const releaseDir = path.join(desktop, 'release');
  const notes = await buildNotes(releaseDir, version);

  const notesFile = path.join(releaseDir, 'release-notes.md');
  fs.writeFileSync(notesFile, notes);
  execFileSync(gh, ['release', 'edit', tag, '--repo', repo, '--notes-file', notesFile], {
    windowsHide: true,
    env: { ...process.env, GH_TOKEN: token }
  });

  return artifactsFor(releaseDir, version).length;
}
