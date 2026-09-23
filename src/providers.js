'use strict';

const PRESETS = Object.freeze({
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'responses',
    fallbackProtocol: 'chat',
    modelsPath: '/models'
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    protocol: 'responses',
    fallbackProtocol: 'chat',
    modelsPath: '/models'
  }
});

const REASONING_DESCRIPTIONS = Object.freeze({
  none: 'Reasoning disabled',
  minimal: 'Minimal reasoning',
  low: 'Faster reasoning',
  medium: 'Balanced reasoning',
  high: 'Deeper reasoning',
  xhigh: 'Extended reasoning',
  max: 'Maximum reasoning'
});

const DEEPSEEK_PRICING_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/';
const DEEPSEEK_PRICING = Object.freeze({
  'deepseek-flash': deepseekPricing(0.15, 0.30, 0.60, 1.20, 0.003, 0.006),
  'deepseek-v4-flash': deepseekPricing(0.15, 0.30, 0.60, 1.20, 0.003, 0.006),
  'deepseek-v4-flash-vision-exp': deepseekPricing(0.15, 0.30, 0.60, 1.20, 0.003, 0.006),
  'deepseek-v4-pro': deepseekPricing(0.66, 1.32, 1.98, 3.96, 0.022, 0.044)
});

function band(min, max = min) { return { min: Number(min), max: Number(max) }; }

function deepseekPricing(inputOffPeak, inputPeak, outputOffPeak, outputPeak, cacheOffPeak, cachePeak) {
  return {
    currency: 'USD', unit: 'million_tokens',
    input: band(inputOffPeak, inputPeak), output: band(outputOffPeak, outputPeak), cacheRead: band(cacheOffPeak, cachePeak),
    schedule: 'deepseek_weekday_utc', source: DEEPSEEK_PRICING_SOURCE
  };
}

function perTokenBand(value) {
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? band(price * 1_000_000) : null;
}

function normalizePricing(value, fallback = null) {
  if (!value || typeof value !== 'object') return fallback;
  const input = perTokenBand(value.prompt ?? value.input);
  const output = perTokenBand(value.completion ?? value.output);
  if (!input && !output) return fallback;
  return {
    currency: 'USD', unit: 'million_tokens', input, output,
    cacheRead: perTokenBand(value.input_cache_read ?? value.cache_read),
    cacheWrite: perTokenBand(value.input_cache_write ?? value.cache_write),
    source: 'provider_models_api'
  };
}

function pricingRates(pricing, at = new Date()) {
  if (!pricing) return null;
  let side = 'max';
  if (pricing.schedule === 'deepseek_weekday_utc') {
    const date = at instanceof Date ? at : new Date(at);
    const day = date.getUTCDay(), hour = date.getUTCHours();
    const peak = day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
    side = peak ? 'max' : 'min';
  }
  const pick = (entry) => entry ? Number(entry[side] ?? entry.max ?? entry.min ?? 0) : 0;
  return { input: pick(pricing.input), output: pick(pricing.output), cacheRead: pick(pricing.cacheRead), cacheWrite: pick(pricing.cacheWrite) };
}

function modelPricing(config = {}, qualifiedModel = '') {
  const slash = qualifiedModel.indexOf('/');
  if (slash <= 0) return null;
  const providerId = qualifiedModel.slice(0, slash), id = qualifiedModel.slice(slash + 1);
  const model = (config.selectedModels || []).find((entry) => entry.providerId === providerId && entry.id === id)
    || config.modelCache?.[providerId]?.models?.find((entry) => entry.id === id);
  return model?.pricing || providerModelProfile(providerId, id).pricing || null;
}

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

function normalizeModels(payload, providerId = '') {
  const rows = Array.isArray(payload) ? payload : payload?.data || payload?.models || [];
  if (!Array.isArray(rows)) throw new Error('Provider returned an unsupported models payload');
  return rows.map((row) => {
    const id = String(row.id || row.slug || row.name || '').trim();
    if (!id) return null;
    const context = Number(row.context_length || row.context_window || row.top_provider?.context_length || 0) || null;
    const parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters : [];
    const profile = providerModelProfile(providerId, id);
    return {
      id,
      displayName: String(row.name || row.display_name || id),
      description: String(row.description || ''),
      contextWindow: context,
      inputModalities: normalizeInputModalities(profile.inputModalities || row.architecture?.input_modalities || row.input_modalities || ['text']),
      outputModalities: normalizeOutputModalities(row.architecture?.output_modalities || row.output_modalities || ['text']),
      supportsTools: profile.supportsTools ?? (parameters.length ? parameters.includes('tools') : true),
      supportsReasoning: profile.supportsReasoning ?? parameters.some((item) => item === 'reasoning' || item === 'include_reasoning'),
      reasoningLevels: profile.reasoningLevels || reasoningLevelsFor(providerId, parameters),
      defaultReasoningLevel: profile.defaultReasoningLevel || defaultReasoningLevel(providerId, parameters),
      supportedParameters: parameters,
      pricing: normalizePricing(row.pricing, profile.pricing)
    };
  }).filter(Boolean);
}

function providerModelProfile(providerId, modelId) {
  if (providerId !== 'deepseek') return {};
  const pricing = DEEPSEEK_PRICING[modelId] || null;
  if (modelId === 'deepseek-flash' || modelId === 'deepseek-v4-pro' || modelId === 'deepseek-v4-flash-vision-exp') {
    const inputModalities = modelId === 'deepseek-v4-pro' ? ['text'] : ['text', 'image'];
    return { inputModalities, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'high', 'max'], defaultReasoningLevel: 'high', pricing };
  }
  return { supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'high', 'max'], defaultReasoningLevel: 'high', pricing };
}

function reasoningLevelsFor(providerId, supportedParameters = []) {
  if (providerId === 'deepseek') return ['low', 'high', 'max'];
  const configurable = supportedParameters.some((item) => ['reasoning', 'reasoning_effort', 'include_reasoning'].includes(item));
  return configurable ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] : [];
}

function defaultReasoningLevel(providerId, supportedParameters = []) {
  const levels = reasoningLevelsFor(providerId, supportedParameters);
  if (!levels.length) return null;
  return providerId === 'deepseek' ? 'high' : 'medium';
}

function reasoningLevelEntries(model = {}) {
  const levels = Array.isArray(model.reasoningLevels) ? model.reasoningLevels : [];
  return levels.map((effort) => ({ effort, description: REASONING_DESCRIPTIONS[effort] || `${effort} reasoning` }));
}

function mapReasoningEffort(providerId, effort) {
  if (!effort) return effort;
  if (providerId !== 'deepseek') return effort;
  if (effort === 'none') return 'none';
  if (effort === 'minimal' || effort === 'low') return 'low';
  if (effort === 'max' || effort === 'ultra') return 'max';
  return 'high';
}

function normalizeInputModalities(value) {
  const supported = new Set(['text', 'image', 'audio']);
  const values = Array.isArray(value) ? value : [value];
  const normalized = [...new Set(values.map((item) => String(item).toLowerCase()).filter((item) => supported.has(item)))];
  return normalized.length ? normalized : ['text'];
}

function normalizeOutputModalities(value) {
  const supported = new Set(['text', 'image', 'audio']);
  const values = Array.isArray(value) ? value : [value];
  const normalized = [...new Set(values.map((item) => String(item).toLowerCase()).filter((item) => supported.has(item)))];
  return normalized.length ? normalized : ['text'];
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
  return normalizeModels(payload, provider.id);
}

module.exports = { PRESETS, REASONING_DESCRIPTIONS, DEEPSEEK_PRICING, providerDefinitions, providerModelProfile, reasoningLevelsFor, defaultReasoningLevel, reasoningLevelEntries, mapReasoningEffort, normalizeBaseUrl, normalizeInputModalities, normalizeOutputModalities, normalizePricing, pricingRates, modelPricing, normalizeModels, fetchModels };
