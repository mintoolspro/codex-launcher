'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readBody, json } = require('./gateway');
const { PRESETS, fetchModels, normalizeBaseUrl } = require('./providers');

function publicState(controller) {
  const config = controller.configStore.read();
  const providers = Object.values(PRESETS).map((preset) => ({
    ...preset,
    ...(config.providers?.[preset.id] || {}),
    hasKey: controller.secretStore.has(preset.id)
  }));
  return {
    providers,
    selectedModels: config.selectedModels || [],
    modelCache: config.modelCache || {},
    visionFallbackModel: config.visionFallbackModel || '',
    status: controller.status()
  };
}

function createPanelHandler(controller, uiDir = path.join(__dirname, '..', 'ui')) {
  return async function panel(req, res, url) {
    if (url.pathname === '/icon.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' });
      res.end(fs.readFileSync(path.join(uiDir, '..', 'assets', 'icon.png'))); return true;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(path.join(uiDir, 'index.html'))); return true;
    }
    if (!url.pathname.startsWith('/api/')) return false;
    if (req.method === 'GET' && url.pathname === '/api/state') { json(res, 200, publicState(controller)); return true; }
    if (req.method === 'GET' && url.pathname === '/api/usage') { json(res, 200, controller.usageStore.query(Number(url.searchParams.get('days')) || 7)); return true; }
    if (req.method === 'POST' && url.pathname === '/api/usage/reset') { controller.usageStore.reset(); json(res, 200, { ok: true }); return true; }
    if (req.method === 'GET' && url.pathname === '/api/traces') { json(res, 200, { traces: controller.traceStore.query({ limit: Number(url.searchParams.get('limit')) || 50 }) }); return true; }
    if (req.method === 'POST' && url.pathname === '/api/traces/reset') { controller.traceStore.reset(); json(res, 200, { ok: true }); return true; }
    if (req.method === 'POST' && url.pathname === '/api/launch') { json(res, 200, await controller.launch()); return true; }
    if (req.method === 'POST' && url.pathname === '/api/stop') { json(res, 200, controller.stop()); return true; }
    if (req.method === 'POST' && url.pathname === '/api/vision-fallback') {
      const raw = await readBody(req);
      const body = JSON.parse(raw.length ? raw.toString('utf8') : '{}');
      const model = typeof body.model === 'string' ? body.model : '';
      const config = controller.configStore.read();
      const selected = (config.selectedModels || []).find((entry) => `${entry.providerId}/${entry.id}` === model);
      if (model && (!selected || !selected.inputModalities?.includes('image'))) {
        json(res, 400, { error: 'Vision fallback must be a selected model that supports image input' }); return true;
      }
      controller.configStore.update((next) => { next.visionFallbackModel = model; return next; });
      json(res, 200, publicState(controller)); return true;
    }
    const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)(?:\/(models))?$/);
    if (req.method === 'POST' && providerMatch) {
      const id = providerMatch[1], preset = PRESETS[id];
      if (!preset) { json(res, 404, { error: 'Unknown provider' }); return true; }
      const raw = await readBody(req);
      const body = JSON.parse(raw.length ? raw.toString('utf8') : '{}');
      if (providerMatch[2] === 'models') {
        const config = controller.configStore.read();
        const provider = { ...preset, ...(config.providers?.[id] || {}) };
        const models = await fetchModels(provider, controller.secretStore.get(id));
        controller.configStore.update((next) => {
          next.modelCache ||= {}; next.modelCache[id] = { fetchedAt: new Date().toISOString(), models };
          next.selectedModels = (next.selectedModels || []).map((entry) => {
            if (entry.providerId !== id) return entry;
            const current = models.find((model) => model.id === entry.id);
            return current ? { providerId: id, ...current } : entry;
          });
          return next;
        });
        json(res, 200, { models }); return true;
      }
      controller.configStore.update((next) => {
        next.providers ||= {}; next.providers[id] = { baseUrl: normalizeBaseUrl(body.baseUrl || preset.baseUrl), protocol: preset.protocol };
        return next;
      });
      if (typeof body.apiKey === 'string' && body.apiKey) controller.secretStore.set(id, body.apiKey);
      if (body.clearKey) controller.secretStore.delete(id);
      json(res, 200, publicState(controller)); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/selection') {
      const raw = await readBody(req);
      const body = JSON.parse(raw.length ? raw.toString('utf8') : '{}');
      if (!Array.isArray(body.models)) { json(res, 400, { error: 'models must be an array' }); return true; }
      controller.configStore.update((next) => {
        next.selectedModels = body.models;
        if (next.visionFallbackModel && !body.models.some((entry) => `${entry.providerId}/${entry.id}` === next.visionFallbackModel && entry.inputModalities?.includes('image'))) next.visionFallbackModel = '';
        return next;
      });
      json(res, 200, publicState(controller)); return true;
    }
    json(res, 404, { error: 'Unknown API endpoint' }); return true;
  };
}

module.exports = { createPanelHandler, publicState };
