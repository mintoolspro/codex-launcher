'use strict';

const fs = require('node:fs');
const { buildCatalog } = require('./catalog');
const { getPaths, ensureDirectories } = require('./paths');

function tomlString(value) { return JSON.stringify(String(value)); }

function generateFiles({ gatewayUrl, gatewayToken, selectedModels, visionFallbackModel = '', paths = getPaths() }) {
  ensureDirectories(paths);
  if (!selectedModels.length) throw new Error('Select at least one model before launching Codex');
  const defaultModel = `${selectedModels[0].providerId}/${selectedModels[0].id}`;
  const config = [
    `model = ${tomlString(defaultModel)}`,
    'model_provider = "codex_launcher"',
    `model_catalog_json = ${tomlString(paths.catalogFile)}`,
    '',
    '[model_providers.codex_launcher]',
    'name = "Codex Launcher Gateway"',
    `base_url = ${tomlString(gatewayUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    `http_headers = { Authorization = ${tomlString(`Bearer ${gatewayToken}`)} }`,
    'request_max_retries = 2',
    'stream_max_retries = 2',
    'stream_idle_timeout_ms = 300000',
    ''
  ].join('\n');
  fs.writeFileSync(paths.codexConfigFile, config, { mode: 0o600 });
  fs.writeFileSync(paths.catalogFile, `${JSON.stringify(buildCatalog(selectedModels, { advertiseImage: Boolean(visionFallbackModel) }), null, 2)}\n`, { mode: 0o600 });
  return { configFile: paths.codexConfigFile, catalogFile: paths.catalogFile, defaultModel };
}

module.exports = { generateFiles, tomlString };
