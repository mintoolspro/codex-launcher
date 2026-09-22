'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { PRESETS, normalizeBaseUrl } = require('./providers');
const { responsesToChat, chatToResponse, ChatSseTranslator } = require('./translate');
const { UsageStore } = require('./usage');

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readBody(req, limit = 10 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function splitModel(model) {
  const slash = String(model || '').indexOf('/');
  if (slash <= 0 || slash === model.length - 1) throw Object.assign(new Error('Model must use providerId/model namespace'), { status: 400 });
  return { providerId: model.slice(0, slash), upstreamModel: model.slice(slash + 1) };
}

function upstreamHeaders(key, req) {
  const headers = { 'content-type': 'application/json', accept: req.headers.accept || 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

function normalizeChatMessages(messages = []) {
  const supported = new Set(['system', 'user', 'assistant', 'tool']);
  return messages.map((message) => ({
    ...message,
    role: message.role === 'developer' ? 'system' : (supported.has(message.role) ? message.role : 'user')
  }));
}

function prepareChatMessages(messages, providerId) {
  const normalized = normalizeChatMessages(messages);
  if (providerId !== 'deepseek') return normalized;
  return normalized.map((message) => message.role === 'assistant' && message.tool_calls?.length
    ? { ...message, reasoning_content: message.reasoning_content || '' }
    : message);
}

function modelName(entry) {
  return entry ? `${entry.providerId}/${entry.id}` : '';
}

function hasImageInput(body) {
  return Array.isArray(body?.input) && body.input.some((item) =>
    Array.isArray(item?.content) && item.content.some((part) => part?.type === 'input_image' || part?.type === 'image_url')
  );
}

function supportsInput(config, model, modality) {
  const selected = (config.selectedModels || []).find((entry) => modelName(entry) === model);
  return Boolean(selected?.inputModalities?.includes(modality));
}

function withVisionDescription(body, description, fallbackModel) {
  const input = Array.isArray(body.input) ? body.input.map((item) => {
    if (!Array.isArray(item?.content)) return item;
    return {
      ...item,
      content: item.content.filter((part) => part?.type !== 'input_image' && part?.type !== 'image_url')
    };
  }) : body.input;
  const note = {
    role: 'developer',
    content: [{
      type: 'input_text',
      text: `A vision fallback model (${fallbackModel}) analyzed the attached image(s). Use this analysis as visual context:\n\n${description}`
    }]
  };
  return { ...body, input: [note, ...(input || [])] };
}

function responseText(payload) {
  return (payload?.output || []).flatMap((item) => item.content || [])
    .filter((part) => part?.type === 'output_text')
    .map((part) => part.text || '')
    .join('\n')
    .trim();
}

class Gateway {
  constructor({ configStore, secretStore, usageStore = new UsageStore(), panelHandler = null, token = crypto.randomBytes(24).toString('base64url') }) {
    this.configStore = configStore;
    this.secretStore = secretStore;
    this.usageStore = usageStore;
    this.panelHandler = panelHandler;
    this.token = token;
    this.server = null;
    this.port = null;
  }
  get url() { return this.port ? `http://127.0.0.1:${this.port}/v1` : null; }
  async start(port = 0) {
    if (this.server) return this;
    this.server = http.createServer((req, res) => this.#handle(req, res).catch((error) => {
      if (!res.headersSent) json(res, error.status || 500, { error: { message: error.message, type: 'launcher_error' } });
      else res.destroy(error);
    }));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    return this;
  }
  async close() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null; this.port = null;
  }
  async #handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') return json(res, 200, { ok: true, port: this.port });
    if (!url.pathname.startsWith('/v1/')) {
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${this.port}`) return json(res, 403, { error: { message: 'Cross-origin control request denied' } });
      if (this.panelHandler && await this.panelHandler(req, res, url)) return;
      return json(res, 404, { error: { message: 'Not found' } });
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) return json(res, 401, { error: { message: 'Invalid gateway token' } });
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      const selected = this.configStore.read().selectedModels || [];
      return json(res, 200, { object: 'list', data: selected.map((m) => ({ id: `${m.providerId}/${m.id}`, object: 'model', owned_by: m.providerId })) });
    }
    if (url.pathname !== '/v1/responses' || req.method !== 'POST') return json(res, 404, { error: { message: 'Unsupported gateway endpoint' } });
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
    const requestedModel = body.model;
    const { providerId, upstreamModel } = splitModel(requestedModel);
    const config = this.configStore.read();
    const provider = { ...PRESETS[providerId], ...(config.providers?.[providerId] || {}) };
    if (!provider.id) throw Object.assign(new Error(`Unknown provider: ${providerId}`), { status: 400 });
    const key = this.secretStore.get(providerId);
    if (!key) throw Object.assign(new Error(`No API key configured for ${provider.name}`), { status: 401 });
    let routedBody = body;
    if (hasImageInput(body) && !supportsInput(config, requestedModel, 'image')) {
      const fallbackModel = config.visionFallbackModel;
      if (!fallbackModel) throw Object.assign(new Error(`Model ${requestedModel} does not support images. Choose a vision fallback model in Codex Launcher.`), { status: 422 });
      if (!supportsInput(config, fallbackModel, 'image')) throw Object.assign(new Error(`Configured vision fallback ${fallbackModel} is unavailable or does not support images.`), { status: 422 });
      const description = await this.#describeImages(req, body, config, fallbackModel);
      routedBody = withVisionDescription(body, description, fallbackModel);
    }
    if (provider.protocol === 'responses') return this.#native(req, res, routedBody, provider, key, upstreamModel, requestedModel);
    return this.#chat(req, res, routedBody, provider, key, upstreamModel, requestedModel);
  }
  async #describeImages(req, body, config, fallbackModel) {
    const { providerId, upstreamModel } = splitModel(fallbackModel);
    const provider = { ...PRESETS[providerId], ...(config.providers?.[providerId] || {}) };
    if (!provider.id) throw Object.assign(new Error(`Unknown vision fallback provider: ${providerId}`), { status: 422 });
    const key = this.secretStore.get(providerId);
    if (!key) throw Object.assign(new Error(`No API key configured for vision fallback provider ${provider.name}`), { status: 401 });
    const visionBody = {
      ...body,
      model: fallbackModel,
      instructions: 'Analyze every attached image accurately. Return a self-contained visual description relevant to the user request. Do not call tools.',
      tools: [],
      tool_choice: undefined,
      stream: false,
      max_output_tokens: 1024
    };
    let payload;
    if (provider.protocol === 'responses') {
      const upstreamBody = { ...visionBody, model: upstreamModel };
      const response = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/responses`, { method: 'POST', headers: upstreamHeaders(key, req), body: JSON.stringify(upstreamBody) });
      if (!response.ok) throw await this.#upstreamFailure(response, `Vision fallback ${fallbackModel}`);
      payload = await response.json();
      if (payload.usage) this.usageStore.record(fallbackModel, payload.usage);
    } else {
      const translated = responsesToChat(visionBody, upstreamModel);
      translated.messages = prepareChatMessages(translated.messages, provider.id);
      const response = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/chat/completions`, { method: 'POST', headers: upstreamHeaders(key, req), body: JSON.stringify(translated) });
      if (!response.ok) throw await this.#upstreamFailure(response, `Vision fallback ${fallbackModel}`);
      const upstream = await response.json();
      payload = chatToResponse(upstream, fallbackModel);
      this.usageStore.record(fallbackModel, payload.usage);
    }
    const description = responseText(payload);
    if (!description) throw Object.assign(new Error(`Vision fallback ${fallbackModel} returned no image description.`), { status: 502 });
    return description;
  }
  async #native(req, res, body, provider, key, upstreamModel, requestedModel) {
    const upstreamBody = { ...body, model: upstreamModel };
    const response = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/responses`, { method: 'POST', headers: upstreamHeaders(key, req), body: JSON.stringify(upstreamBody) });
    if (!response.ok) return this.#proxyError(res, response);
    if (!body.stream) {
      const data = await response.json();
      if (data.usage) this.usageStore.record(requestedModel, data.usage);
      data.model = requestedModel;
      return json(res, response.status, data);
    }
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const decoder = new TextDecoder(); let pending = ''; let finalUsage = null;
    for await (const chunk of response.body) {
      res.write(Buffer.from(chunk));
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
        try { const event = JSON.parse(line.slice(6)); finalUsage = event.response?.usage || event.usage || finalUsage; } catch {}
      }
    }
    if (finalUsage) this.usageStore.record(requestedModel, finalUsage);
    res.end();
  }
  async #chat(req, res, body, provider, key, upstreamModel, requestedModel) {
    const translated = responsesToChat(body, upstreamModel);
    translated.messages = prepareChatMessages(translated.messages, provider.id);
    const response = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/chat/completions`, { method: 'POST', headers: upstreamHeaders(key, req), body: JSON.stringify(translated) });
    if (!response.ok) return this.#proxyError(res, response);
    if (!body.stream) {
      const upstream = await response.json();
      const result = chatToResponse(upstream, requestedModel);
      this.usageStore.record(requestedModel, result.usage);
      return json(res, 200, result);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const translator = new ChatSseTranslator(requestedModel);
    res.write(translator.begin());
    const decoder = new TextDecoder(); let pending = '';
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { res.write(translator.push(JSON.parse(data))); } catch {}
      }
    }
    const done = translator.end();
    this.usageStore.record(requestedModel, done.usage);
    res.end(done.data);
  }
  async #proxyError(res, response) {
    const text = await response.text();
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json' });
    res.end(text);
  }
  async #upstreamFailure(response, label) {
    const text = await response.text();
    let detail = text.slice(0, 500);
    try { detail = JSON.parse(text).error?.message || detail; } catch {}
    return Object.assign(new Error(`${label} failed (${response.status}): ${detail}`), { status: 502 });
  }
}

module.exports = { Gateway, readBody, splitModel, normalizeChatMessages, prepareChatMessages, modelName, hasImageInput, supportsInput, withVisionDescription, responseText, json };
