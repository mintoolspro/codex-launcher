'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { getPaths, ensureDirectories } = require('./paths');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function atomicJson(file, value, mode = 0o600) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temp, file);
  fs.chmodSync(file, mode);
}

class ConfigStore {
  constructor(paths = getPaths()) {
    this.paths = ensureDirectories(paths);
  }
  read() {
    return readJson(this.paths.configFile, { providers: {}, selectedModels: [], modelCache: {} });
  }
  write(next) {
    atomicJson(this.paths.configFile, next);
    return next;
  }
  update(mutator) {
    const next = mutator(structuredClone(this.read()));
    return this.write(next);
  }
}

class SecretStore {
  constructor(paths = getPaths(), service = 'pro.mintools.codex-launcher') {
    this.paths = ensureDirectories(paths);
    this.service = service;
  }
  #security(args) {
    return execFileSync('/usr/bin/security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  }
  #key() {
    let salt;
    try { salt = fs.readFileSync(this.paths.machineSaltFile); }
    catch {
      salt = crypto.randomBytes(32);
      fs.writeFileSync(this.paths.machineSaltFile, salt, { mode: 0o600 });
    }
    return crypto.scryptSync(`${os.hostname()}:${process.getuid?.() ?? 0}`, salt, 32);
  }
  #fallbackRead() {
    return readJson(this.paths.secretsFile, {});
  }
  #fallbackGet(id) {
    const record = this.#fallbackRead()[id];
    if (!record) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.#key(), Buffer.from(record.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8');
    } catch { return null; }
  }
  #fallbackSet(id, secret) {
    const all = this.#fallbackRead();
    if (!secret) delete all[id];
    else {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.#key(), iv);
      const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      all[id] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    }
    atomicJson(this.paths.secretsFile, all);
  }
  get(id) {
    if (process.platform === 'darwin') {
      try { return this.#security(['find-generic-password', '-s', this.service, '-a', id, '-w']); } catch {}
    }
    return this.#fallbackGet(id);
  }
  set(id, secret) {
    if (!secret) return this.delete(id);
    if (process.platform === 'darwin') {
      try {
        this.#security(['add-generic-password', '-U', '-s', this.service, '-a', id, '-w', secret]);
        this.#fallbackSet(id, null);
        return;
      } catch {}
    }
    this.#fallbackSet(id, secret);
  }
  delete(id) {
    if (process.platform === 'darwin') {
      try { this.#security(['delete-generic-password', '-s', this.service, '-a', id]); } catch {}
    }
    this.#fallbackSet(id, null);
  }
  has(id) { return Boolean(this.get(id)); }
}

module.exports = { ConfigStore, SecretStore, readJson, atomicJson };
