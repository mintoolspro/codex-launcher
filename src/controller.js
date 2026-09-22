'use strict';

const crypto = require('node:crypto');
const { ConfigStore, SecretStore } = require('./store');
const { UsageStore } = require('./usage');
const { TraceStore } = require('./trace');
const { Gateway } = require('./gateway');
const { generateFiles } = require('./generate');
const { getPaths, ensureDirectories } = require('./paths');
const { launchDesktop, findDesktopPids, stopDesktop, discoverDesktopApp } = require('./launch');
const { PRESETS, providerModelProfile, reasoningLevelsFor, defaultReasoningLevel } = require('./providers');

class Controller {
  constructor({ paths = getPaths() } = {}) {
    this.paths = ensureDirectories(paths);
    this.configStore = new ConfigStore(this.paths);
    this.secretStore = new SecretStore(this.paths);
    this.usageStore = new UsageStore(this.paths);
    this.traceStore = new TraceStore(this.paths);
    this.gateway = null;
    this.panelHandler = null;
    this.gatewayToken = crypto.randomBytes(24).toString('base64url');
  }
  setPanelHandler(handler) { this.panelHandler = handler; if (this.gateway) this.gateway.panelHandler = handler; }
  async start() {
    this.#migrateConfig();
    if (!this.gateway) this.gateway = new Gateway({ configStore: this.configStore, secretStore: this.secretStore, usageStore: this.usageStore, traceStore: this.traceStore, panelHandler: this.panelHandler, token: this.gatewayToken });
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
  #migrateConfig() {
    const current = this.configStore.read();
    if ((current.schemaVersion || 0) >= 4) return;
    this.configStore.update((next) => {
      next.schemaVersion = 4;
      next.providers ||= {};
      for (const [id, preset] of Object.entries(PRESETS)) {
        next.providers[id] ||= {};
        next.providers[id].protocol = preset.protocol;
      }
      next.selectedModels = (next.selectedModels || []).map((entry) => {
        const cached = next.modelCache?.[entry.providerId]?.models?.find((model) => model.id === entry.id) || {};
        const profile = providerModelProfile(entry.providerId, entry.id);
        const parameters = cached.supportedParameters || entry.supportedParameters || [];
        const reasoningLevels = profile.reasoningLevels || cached.reasoningLevels || reasoningLevelsFor(entry.providerId, parameters);
        const preferred = entry.defaultReasoningLevel;
        return {
          ...entry,
          ...cached,
          ...profile,
          reasoningLevels,
          defaultReasoningLevel: reasoningLevels.includes(preferred) ? preferred : (profile.defaultReasoningLevel || cached.defaultReasoningLevel || defaultReasoningLevel(entry.providerId, parameters))
        };
      });
      return next;
    });
  }
}

module.exports = { Controller };
