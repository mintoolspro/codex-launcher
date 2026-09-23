'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { getPaths, ensureDirectories } = require('./paths');

const MAX_STRING = 2000;
const SECRET_KEY = /authorization|api[-_]?key|bearer|secret$|password$|cookie$|(^|_)token$/i;
const IMAGE_DATA = /^data:image\//i;

function clip(value, max = MAX_STRING) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} chars omitted)`;
}

function sanitize(value, key = '', depth = 0) {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (depth > 7) return '[depth limit]';
  if (typeof value === 'string') return IMAGE_DATA.test(value) ? `[image data omitted: ${value.length} chars]` : clip(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, key, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) out[childKey] = sanitize(childValue, childKey, depth + 1);
  return out;
}

function attrValue(item) {
  if (!item || typeof item !== 'object') return item;
  for (const key of ['stringValue', 'boolValue', 'intValue', 'doubleValue', 'bytesValue']) if (item[key] != null) return item[key];
  if (item.arrayValue?.values) return item.arrayValue.values.map(attrValue);
  if (item.kvlistValue?.values) return Object.fromEntries(item.kvlistValue.values.map((entry) => [entry.key, attrValue(entry.value)]));
  return item;
}

function otelAttributes(items = []) {
  return Object.fromEntries(items.map((entry) => [entry.key, attrValue(entry.value)]));
}

function normalizeOtelId(value) {
  if (!value) return value;
  const text = String(value);
  if (/^[\da-f]{16,32}$/i.test(text)) return text.toLowerCase();
  try {
    const bytes = Buffer.from(text, 'base64');
    if (bytes.length === 8 || bytes.length === 16) return bytes.toString('hex');
  } catch {}
  return text;
}

function nanoDurationMs(start, end) {
  try {
    const delta = BigInt(end || 0) - BigInt(start || 0);
    return delta > 0n ? Number(delta / 1000000n) : undefined;
  } catch { return undefined; }
}

class TraceStore {
  constructor(paths = getPaths(), { maxBytes = 20 * 1024 * 1024 } = {}) {
    this.paths = ensureDirectories(paths);
    this.file = this.paths.traceFile;
    this.maxBytes = maxBytes;
  }
  id() { return crypto.randomUUID(); }
  record(event) {
    const row = sanitize({ id: this.id(), at: new Date().toISOString(), ...event });
    fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch {}
    this.#compact();
    return row;
  }
  start(fields = {}) {
    const traceId = fields.traceId || this.id();
    this.record({ source: 'gateway', kind: 'turn.started', status: 'running', ...fields, traceId });
    return { traceId, startedAt: Date.now(), firstByteAt: null };
  }
  event(trace, kind, fields = {}) {
    return this.record({ source: 'gateway', traceId: trace.traceId, kind, ...fields });
  }
  finish(trace, fields = {}) {
    return this.event(trace, fields.status === 'error' ? 'turn.failed' : 'turn.completed', {
      durationMs: Date.now() - trace.startedAt,
      ...fields
    });
  }
  ingestOtel(payload, signal = 'logs') {
    let count = 0;
    if (signal === 'logs') {
      for (const resource of payload.resourceLogs || []) for (const scope of resource.scopeLogs || []) for (const log of scope.logRecords || []) {
        const attrs = { ...otelAttributes(resource.resource?.attributes), ...otelAttributes(log.attributes) };
        this.record({ source: 'codex', kind: attrs['event.name'] || log.eventName || log.body?.stringValue || 'otel.log', traceId: normalizeOtelId(log.traceId) || attrs['conversation.id'] || attrs.conversation_id || this.id(), spanId: normalizeOtelId(log.spanId), severity: log.severityText, attributes: attrs, payload: attrValue(log.body) });
        count++;
      }
    } else {
      for (const resource of payload.resourceSpans || []) for (const scope of resource.scopeSpans || []) for (const span of scope.spans || []) {
        if (span.name === 'auth') continue;
        const attrs = { ...otelAttributes(resource.resource?.attributes), ...otelAttributes(span.attributes) };
        this.record({ source: 'codex', kind: span.name || 'otel.span', traceId: normalizeOtelId(span.traceId) || this.id(), spanId: normalizeOtelId(span.spanId), parentSpanId: normalizeOtelId(span.parentSpanId), durationMs: nanoDurationMs(span.startTimeUnixNano, span.endTimeUnixNano), status: span.status?.code === 2 ? 'error' : 'ok', attributes: attrs });
        count++;
      }
    }
    return count;
  }
  query({ limit = 50 } = {}) {
    const rows = this.#read();
    const groups = new Map();
    for (const row of rows) {
      if (row.source === 'codex' && row.kind === 'auth') continue;
      const traceId = row.traceId || row.id;
      if (!groups.has(traceId)) groups.set(traceId, { traceId, startedAt: row.at, endedAt: row.at, status: 'observed', events: [] });
      const group = groups.get(traceId);
      group.events.push(row);
      if (row.at < group.startedAt) group.startedAt = row.at;
      if (row.at > group.endedAt) group.endedAt = row.at;
      group.model ||= row.requestedModel || row.model || row.attributes?.model;
      group.providerId ||= row.providerId;
      if (row.kind === 'turn.failed' || row.status === 'error') group.status = 'error';
      else if (row.kind === 'turn.started' && group.status !== 'error') group.status = 'running';
      else if (row.kind === 'turn.completed' && group.status !== 'error') group.status = 'completed';
    }
    const count = Math.min(200, Math.max(1, limit));
    const ordered = [...groups.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const gateway = ordered.filter((group) => group.events.some((event) => event.source === 'gateway'));
    const telemetry = ordered.filter((group) => !group.events.some((event) => event.source === 'gateway'));
    return [...gateway.slice(0, count), ...telemetry.slice(0, Math.max(0, count - gateway.length))];
  }
  reset() { try { fs.unlinkSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  #read() {
    try { return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  #compact() {
    let stat;
    try { stat = fs.statSync(this.file); } catch { return; }
    if (stat.size <= this.maxBytes) return;
    const rows = this.#read();
    const keep = rows.slice(Math.floor(rows.length / 3));
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, keep.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}

module.exports = { TraceStore, sanitize, clip, otelAttributes, normalizeOtelId, nanoDurationMs };
