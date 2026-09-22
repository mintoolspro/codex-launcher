'use strict';

const { normalizeInputModalities } = require('./providers');

function namespacedModel(providerId, model) {
  return `${providerId}/${model.id}`;
}

function compactDisplayName(providerId, model) {
  const badges = { openrouter: 'OR', deepseek: 'DS' };
  const badge = badges[providerId] || providerId.slice(0, 3).toUpperCase();
  const original = String(model.displayName || model.id);
  const name = original.replace(/^[^:]{1,32}:\s*/, '').trim() || original;
  return `[${badge}] ${name}`;
}

function toCatalogModel(providerId, model, priority = 0) {
  const contextWindow = model.contextWindow || 128000;
  return {
    slug: namespacedModel(providerId, model),
    display_name: compactDisplayName(providerId, model),
    description: model.description || `Model served through ${providerId}`,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Faster responses' },
      { effort: 'medium', description: 'Balanced reasoning' },
      { effort: 'high', description: 'Deeper reasoning' }
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    base_instructions: 'You are Codex, a coding agent. Help the user modify, debug, test, and understand software projects.',
    supports_reasoning_summaries: false,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'tokens', limit: Math.min(10000, Math.floor(contextWindow * 0.1)) },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: Math.floor(contextWindow * 0.84),
    experimental_supported_tools: [],
    input_modalities: normalizeInputModalities(model.inputModalities || ['text']),
    supports_search_tool: false
  };
}

function buildCatalog(selectedModels) {
  return { models: selectedModels.map((entry, index) => toCatalogModel(entry.providerId, entry, index)) };
}

module.exports = { namespacedModel, compactDisplayName, toCatalogModel, buildCatalog };
