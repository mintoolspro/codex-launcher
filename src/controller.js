'use strict';

const crypto = require('node:crypto');
const { ConfigStore, SecretStore } = require('./store');
const { UsageStore } = require('./usage');
const { Gateway } = require('./gateway');
const { generateFiles } = require('./generate');
const { getPaths, ensureDirectories } = require('./paths');
const { launchDesktop, findDesktopPids, stopDesktop, discoverDesktopApp } = require('./launch');

class Controller {
  constructor({ paths = getPaths() } = {}) {
    this.paths = ensureDirectories(paths);
    this.configStore = new ConfigStore(this.paths);
    this.secretStore = new SecretStore(this.paths);
    this.usageStore = new UsageStore(this.paths);
    this.gateway = null;
    this.panelHandler = null;
    this.gatewayToken = crypto.randomBytes(24).toString('base64url');
  }
  setPanelHandler(handler) { this.panelHandler = handler; if (this.gateway) this.gateway.panelHandler = handler; }
  async start() {
    if (!this.gateway) this.gateway = new Gateway({ configStore: this.configStore, secretStore: this.secretStore, usageStore: this.usageStore, panelHandler: this.panelHandler, token: this.gatewayToken });
    await this.gateway.start(0);
    return this.status();
  }
  async launch() {
    await this.start();
    const config = this.configStore.read();
    const selectedModels = config.selectedModels || [];
    generateFiles({ gatewayUrl: this.gateway.url, gatewayToken: this.gatewayToken, selectedModels, visionFallbackModel: config.visionFallbackModel, paths: this.paths });
    await launchDesktop({ codexHome: this.paths.codexHome, desktopHome: this.paths.desktopHome });
    await new Promise((resolve) => setTimeout(resolve, 800));
    return this.status();
  }
  stop() { stopDesktop(this.paths.desktopHome); return this.status(); }
  status() {
    const selected = this.configStore.read().selectedModels || [];
    const pids = findDesktopPids(this.paths.desktopHome);
    return { gatewayRunning: Boolean(this.gateway?.port), gatewayUrl: this.gateway?.url || null, port: this.gateway?.port || null, appRunning: pids.length > 0, pids, selectedModels: selected.length, desktopApp: discoverDesktopApp() };
  }
  async close() { this.stop(); await this.gateway?.close(); }
}

module.exports = { Controller };
