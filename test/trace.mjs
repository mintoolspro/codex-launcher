import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getPaths } = require('../src/paths');
const { TraceStore, sanitize } = require('../src/trace');

test('trace store redacts secrets and inline images, groups events, and resets', () => {
  const paths = getPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launcher-trace-')));
  const store = new TraceStore(paths);
  const trace = store.start({ requestedModel: 'openrouter/model' });
  store.event(trace, 'upstream.request', { payload: { authorization: 'Bearer secret', image_url: 'data:image/png;base64,abc' } });
  store.finish(trace, { status: 'ok' });
  const [group] = store.query();
  assert.equal(group.status, 'completed');
  assert.equal(group.events[1].payload.authorization, '[redacted]');
  assert.match(group.events[1].payload.image_url, /image data omitted/);
  store.reset();
  assert.deepEqual(store.query(), []);
});

test('OTLP JSON logs and spans become Codex trace events', () => {
  const paths = getPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launcher-otel-')));
  const store = new TraceStore(paths);
  store.ingestOtel({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ traceId: 'trace-a', spanId: 'span-a', body: { stringValue: 'codex.tool_result' }, attributes: [{ key: 'tool', value: { stringValue: 'shell' } }] }] }] }] }, 'logs');
  store.record({ source: 'codex', kind: 'auth', traceId: 'trace-old-noise' });
  store.ingestOtel({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 'trace-noise', spanId: 'span-noise', name: 'auth' }, { traceId: 'trace-b', spanId: 'span-b', name: 'codex.api_request', startTimeUnixNano: '1000000', endTimeUnixNano: '4000000' }] }] }] }, 'traces');
  const groups = store.query();
  assert.equal(groups.length, 2);
  assert.equal(groups.find((item) => item.traceId === 'trace-a').events[0].attributes.tool, 'shell');
  assert.equal(groups.find((item) => item.traceId === 'trace-b').events[0].durationMs, 3);
  assert.equal(groups.some((item) => item.traceId === 'trace-noise'), false);
  assert.equal(groups.some((item) => item.traceId === 'trace-old-noise'), false);
});

test('sanitize limits payload depth and long strings', () => {
  assert.match(sanitize({ password: 'x' }).password, /redacted/);
  assert.equal(sanitize({ tool_token_count: 12 }).tool_token_count, 12);
  assert.match(sanitize('x'.repeat(3000)), /omitted/);
});

test('gateway request traces are not displaced by noisy standalone telemetry', () => {
  const paths = getPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launcher-trace-priority-')));
  const store = new TraceStore(paths);
  const trace = store.start({ requestedModel: 'openrouter/model' });
  store.finish(trace, { status: 'ok' });
  for (let index = 0; index < 5; index++) store.record({ source: 'codex', kind: 'codex.event', traceId: `otel-${index}` });
  const [first] = store.query({ limit: 1 });
  assert.equal(first.traceId, trace.traceId);
});
