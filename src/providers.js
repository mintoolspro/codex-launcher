'use strict';

const PRESETS = Object.freeze({
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'chat',
    modelsPath: '/models'
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    protocol: 'chat',
    modelsPath: '/models'
  }
});

function providerDefinitions(config = {}) {
  return Object.values(PRESETS).map((preset) => ({
    ...preset,
    ...(config.providers?.[preset.id] || {})
  }));
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL must use http or https');
  return url.toString().replace(/\/$/, '');
}

function normalizeModels(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.data || payload?.models || [];
  if (!Array.isArray(rows)) throw new Error('Provider returned an unsupported models payload');
  return rows.map((row) => {
    const id = String(row.id || row.slug || row.name || '').trim();
    if (!id) return null;
    const context = Number(row.context_length || row.context_window || row.top_provider?.context_length || 0) || null;
    return {
      id,
      displayName: String(row.name || row.display_name || id),
      description: String(row.description || ''),
      contextWindow: context,
      inputModalities: row.architecture?.input_modalities || row.input_modalities || ['text'],
      supportsTools: row.supported_parameters?.includes?.('tools') ?? true
    };
  }).filter(Boolean);
}

async function fetchModels(provider, apiKey, { signal } = {}) {
  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  const url = `${baseUrl}${provider.modelsPath || '/models'}`;
  const headers = { accept: 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetch(url, { headers, signal });
  const text = await response.text();
  if (!response.ok) throw new Error(`${provider.name} models request failed (${response.status}): ${text.slice(0, 300)}`);
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`${provider.name} returned invalid JSON`); }
  return normalizeModels(payload);
}

module.exports = { PRESETS, providerDefinitions, normalizeBaseUrl, normalizeModels, fetchModels };
