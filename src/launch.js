'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

function discoverDesktopApp(override = process.env.CODEX_DESKTOP_APP) {
  const candidates = [override, '/Applications/ChatGPT.app', '/Applications/Codex.app', path.join(os.homedir(), 'Applications/ChatGPT.app'), path.join(os.homedir(), 'Applications/Codex.app')].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'Contents', 'Info.plist'))) || null;
}

function launchDesktop({ appPath = discoverDesktopApp(), codexHome, desktopHome }) {
  if (process.platform !== 'darwin') throw new Error('Codex Launcher currently supports macOS only');
  if (!appPath) throw new Error('Codex Desktop was not found. Install it in /Applications or set CODEX_DESKTOP_APP.');
  const args = ['-n', '--env', `CODEX_HOME=${codexHome}`, '--env', `CODEX_ELECTRON_USER_DATA_PATH=${desktopHome}`, appPath, '--args', `--user-data-dir=${desktopHome}`];
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', args, { timeout: 60000 }, (error) => error ? reject(error) : resolve({ appPath }));
  });
}

function findDesktopPids(desktopHome) {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', `user-data-dir=${desktopHome}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/).filter(Boolean).map(Number).filter((pid) => pid !== process.pid);
  } catch { return []; }
}

function stopDesktop(desktopHome) {
  const pids = findDesktopPids(desktopHome);
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  return pids;
}

module.exports = { discoverDesktopApp, launchDesktop, findDesktopPids, stopDesktop };
