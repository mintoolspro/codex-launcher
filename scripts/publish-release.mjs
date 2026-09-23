#!/usr/bin/env node
// Publish a built macOS artifact as a GitHub Release.
//
//   npm run pack                       # dist/Codex Launcher-<version>-arm64-mac.zip
//   npm run release                    # publishes the version in package.json
//   npm run release -- 0.3.0           # publish an explicit version
//   npm run release -- --dry-run       # validate assets, no network calls
//
// Authentication: the GitHub CLI when it is installed and signed in, otherwise
// GH_TOKEN (a token with "Contents: Read and write" on the repository).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const version = args.find((arg) => !arg.startsWith('-')) || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const repo = process.env.REPO || 'mintoolspro/codex-launcher';
const tag = `v${version}`;
const title = `Codex Launcher ${tag}`;
const zipPath = path.join(root, 'dist', `Codex Launcher-${version}-arm64-mac.zip`);
const blockmapPath = `${zipPath}.blockmap`;
const notesPath = path.join(root, 'dist', `RELEASE-${tag}.md`);

function fail(message) { console.error(message); process.exit(1); }
const mb = (file) => `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`;

if (!fs.existsSync(zipPath)) fail(`Missing ${zipPath}\nBuild it first: npm run pack`);
if (!fs.existsSync(notesPath)) fail(`Missing ${notesPath}\nWrite the release notes there first.`);
const hasTag = spawnSync('git', ['-C', root, 'rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status === 0;
if (!hasTag) fail(`Tag ${tag} does not exist yet.\n  git tag -a ${tag} -m "${title}" && git push origin ${tag}`);

const assets = [[zipPath, `Codex-Launcher-${version}-arm64-mac.zip`, 'application/zip']];
if (fs.existsSync(blockmapPath)) assets.push([blockmapPath, `Codex-Launcher-${version}-arm64-mac.zip.blockmap`, 'application/octet-stream']);
const notes = fs.readFileSync(notesPath, 'utf8');

console.log(`Release ${tag} → ${repo}`);
console.log(`  notes:  ${path.relative(root, notesPath)} (${notes.length} bytes)`);
for (const [file, name] of assets) console.log(`  asset:  ${name} (${mb(file)})`);
if (dryRun) { console.log('Dry run — nothing published.'); process.exit(0); }

const ghReady = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
if (ghReady) {
  console.log('Publishing with the GitHub CLI…');
  const result = spawnSync('gh', ['release', 'create', tag, ...assets.map(([file]) => file), '--repo', repo, '--title', title, '--notes-file', notesPath], { stdio: 'inherit' });
  if (result.status !== 0) fail('gh release create failed.');
  console.log(`Released: https://github.com/${repo}/releases/tag/${tag}`);
  process.exit(0);
}

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  fail([
    'No GitHub credentials found.',
    '  Option A: brew install gh && gh auth login',
    `  Option B: GH_TOKEN=<token> npm run release -- ${version}`,
    'The token needs "Contents: Read and write" on the repository.'
  ].join('\n'));
}

const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'codex-launcher-release' };
const created = await fetch(`https://api.github.com/repos/${repo}/releases`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ tag_name: tag, name: title, body: notes, draft: false, prerelease: false })
});
const release = await created.json().catch(() => ({}));
if (!created.ok) fail(`Could not create the release (HTTP ${created.status}): ${release.message || JSON.stringify(release)}`);
console.log(`Created release #${release.id}.`);

for (const [file, name, type] of assets) {
  console.log(`Uploading ${name} (${mb(file)})…`);
  const uploaded = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': type, 'content-length': String(fs.statSync(file).size) },
    body: fs.createReadStream(file),
    duplex: 'half'
  });
  if (!uploaded.ok) fail(`Upload of ${name} failed (HTTP ${uploaded.status}): ${await uploaded.text()}`);
}

console.log(`Released: https://github.com/${repo}/releases/tag/${tag}`);
