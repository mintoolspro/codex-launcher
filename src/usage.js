'use strict';

const { getPaths, ensureDirectories } = require('./paths');
const { readJson, atomicJson } = require('./store');

function dayKey(date = new Date()) { return date.toISOString().slice(0, 10); }
function blank() { return { input: 0, output: 0, total: 0, requests: 0, lastUsedAt: null }; }
function usageNumbers(usage = {}) {
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  return { input, output, total: Number(usage.total_tokens ?? input + output) || input + output };
}

class UsageStore {
  constructor(paths = getPaths(), now = () => new Date()) {
    this.paths = ensureDirectories(paths);
    this.now = now;
  }
  read() { return readJson(this.paths.usageFile, { models: {}, days: {} }); }
  record(model, usage) {
    const values = usageNumbers(usage);
    const at = this.now();
    const data = this.read();
    const modelRow = data.models[model] ||= blank();
    const dayRow = data.days[dayKey(at)] ||= blank();
    for (const row of [modelRow, dayRow]) {
      row.input += values.input; row.output += values.output; row.total += values.total; row.requests += 1;
      row.lastUsedAt = at.toISOString();
    }
    atomicJson(this.paths.usageFile, data);
    return values;
  }
  query(days = 30) {
    const data = this.read();
    const models = Object.entries(data.models).map(([model, row]) => ({ model, ...row })).sort((a, b) => b.total - a.total);
    const total = models.reduce((sum, row) => ({ input: sum.input + row.input, output: sum.output + row.output, total: sum.total + row.total, requests: sum.requests + row.requests }), blank());
    const dates = [];
    const cursor = this.now();
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(cursor); date.setUTCDate(cursor.getUTCDate() - i);
      const key = dayKey(date); dates.push({ date: key, ...(data.days[key] || blank()) });
    }
    return { total, models, days: dates };
  }
  reset() { atomicJson(this.paths.usageFile, { models: {}, days: {} }); }
}

module.exports = { UsageStore, dayKey, usageNumbers };
