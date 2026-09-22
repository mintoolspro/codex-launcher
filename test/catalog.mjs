import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeModels, mapReasoningEffort } = require('../src/providers');
const { buildCatalog, compactDisplayName } = require('../src/catalog');

test('catalog uses compact provider badges and removes redundant vendor prefixes', () => {
  assert.equal(
    compactDisplayName('openrouter', { displayName: 'DeepSeek: DeepSeek V4 Pro 0813' }),
    '[OR] DeepSeek V4 Pro 0813'
  );
  assert.equal(
    compactDisplayName('deepseek', { displayName: 'DeepSeek-V4-Pro' }),
    '[DS] DeepSeek-V4-Pro'
  );
});

test('catalog removes provider modalities unsupported by Codex Desktop', () => {
  const [model] = normalizeModels({
    data: [{
      id: 'vendor/omni',
      architecture: { input_modalities: ['text', 'image', 'video', 'file'] }
    }]
  });

  assert.deepEqual(model.inputModalities, ['text', 'image']);
  assert.deepEqual(
    buildCatalog([{ ...model, providerId: 'openrouter' }]).models[0].input_modalities,
    ['text', 'image']
  );
});

test('catalog falls back to text when a provider reports only unknown modalities', () => {
  const catalog = buildCatalog([{ providerId: 'openrouter', id: 'vendor/video', inputModalities: ['video'] }]);
  assert.deepEqual(catalog.models[0].input_modalities, ['text']);
});

test('catalog advertises image input for text models when gateway fallback is enabled', () => {
  const catalog = buildCatalog(
    [{ providerId: 'deepseek', id: 'text-model', inputModalities: ['text'] }],
    { advertiseImage: true }
  );
  assert.deepEqual(catalog.models[0].input_modalities, ['text', 'image']);
});

test('catalog exposes only provider-supported reasoning efforts', () => {
  const deepseek = normalizeModels({ data: [{ id: 'deepseek-v4-pro' }] }, 'deepseek')[0];
  const openrouter = normalizeModels({ data: [{ id: 'vendor/reasoner', supported_parameters: ['tools', 'reasoning'] }] }, 'openrouter')[0];
  const plain = normalizeModels({ data: [{ id: 'vendor/plain', supported_parameters: ['tools'] }] }, 'openrouter')[0];
  const catalog = buildCatalog([
    { ...deepseek, providerId: 'deepseek' },
    { ...openrouter, providerId: 'openrouter' },
    { ...plain, providerId: 'openrouter' }
  ]).models;

  assert.deepEqual(catalog[0].supported_reasoning_levels.map((item) => item.effort), ['low', 'high', 'max']);
  assert.equal(catalog[0].default_reasoning_level, 'high');
  assert.deepEqual(catalog[1].supported_reasoning_levels.map((item) => item.effort), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(catalog[2].supported_reasoning_levels, []);
  assert.equal(mapReasoningEffort('deepseek', 'medium'), 'high');
  assert.equal(mapReasoningEffort('deepseek', 'ultra'), 'max');
});
