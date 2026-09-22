'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function getPaths(root = process.env.CODEX_LAUNCHER_HOME || path.join(os.homedir(), '.codex-launcher')) {
  const base = path.resolve(root);
  return {
    root: base,
    codexHome: path.join(base, 'codex'),
    desktopHome: path.join(base, 'desktop'),
    configFile: path.join(base, 'launcher.json'),
    secretsFile: path.join(base, 'secrets.enc.json'),
    machineSaltFile: path.join(base, '.machine-salt'),
    usageFile: path.join(base, 'usage.json'),
    traceFile: path.join(base, 'traces.jsonl'),
    catalogFile: path.join(base, 'codex', 'model_catalog.json'),
    codexConfigFile: path.join(base, 'codex', 'config.toml'),
    logDir: path.join(base, 'logs')
  };
}

function ensureDirectories(paths = getPaths()) {
  for (const dir of [paths.root, paths.codexHome, paths.desktopHome, paths.logDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
  return paths;
}

module.exports = { getPaths, ensureDirectories };
