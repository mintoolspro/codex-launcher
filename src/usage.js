'use strict';

const { getPaths, ensureDirectories } = require('./paths');
const { readJson, atomicJson } = require('./store');
const { pricingRates } = require('./providers');

function dayKey(date = new Date()) { return date.toISOString().slice(0, 10); }
function blank() { return { input: 0, output: 0, total: 0, cachedInput: 0, requests: 0, costUsd: 0, pricedInput: 0, pricedOutput: 0, lastUsedAt: null }; }
function usageNumbers(usage = {}) {
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  const details = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const cachedInput = Math.min(input, Number(details.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0) || 0);
  return { input, output, cachedInput, total: Number(usage.total_tokens ?? input + output) || input + output };
}

function estimateCost(values, pricing, at = new Date()) {
  const rates = pricingRates(pricing, at);
  if (!rates) return 0;
  const cached = Math.min(values.input || 0, values.cachedInput || 0);
  const uncached = Math.max(0, (values.input || 0) - cached);
  return (uncached * rates.input + cached * (rates.cacheRead || rates.input) + (values.output || 0) * rates.output) / 1_000_000;
}

class UsageStore {
  constructor(paths = getPaths(), now = () => new Date(), pricingResolver = () => null) {
    this.paths = ensureDirectories(paths);
    this.now = now;
    this.pricingResolver = pricingResolver;
  }
  read() { return readJson(this.paths.usageFile, { models: {}, days: {} }); }
  record(model, usage) {
    const values = usageNumbers(usage);
    const at = this.now();
    const data = this.read();
    const modelRow = data.models[model] ||= blank();
    const dayRow = data.days[dayKey(at)] ||= blank();
    const costUsd = estimateCost(values, this.pricingResolver(model), at);
    for (const row of [modelRow, dayRow]) {
      row.input += values.input; row.output += values.output; row.total += values.total; row.cachedInput = (row.cachedInput || 0) + values.cachedInput; row.requests += 1;
      row.costUsd = (row.costUsd || 0) + costUsd; row.pricedInput = (row.pricedInput || 0) + values.input; row.pricedOutput = (row.pricedOutput || 0) + values.output;
      row.lastUsedAt = at.toISOString();
    }
    atomicJson(this.paths.usageFile, data);
    return values;
  }
  query(days = 30) {
    const data = this.read();
    const models = Object.entries(data.models).map(([model, row]) => {
      const pricing = this.pricingResolver(model);
      const unpriced = { input: Math.max(0, row.input - (row.pricedInput || 0)), output: Math.max(0, row.output - (row.pricedOutput || 0)), cachedInput: 0 };
      const backfillInputCost = estimateCost({ input: unpriced.input, output: 0, cachedInput: 0 }, pricing, this.now());
      const backfillOutputCost = estimateCost({ input: 0, output: unpriced.output, cachedInput: 0 }, pricing, this.now());
      return { model, ...row, pricing, priceAvailable: Boolean(pricing), backfillInputCost, backfillOutputCost, costUsd: (row.costUsd || 0) + backfillInputCost + backfillOutputCost };
    }).sort((a, b) => b.total - a.total);
    const total = models.reduce((sum, row) => ({ input: sum.input + row.input, output: sum.output + row.output, total: sum.total + row.total, cachedInput: sum.cachedInput + (row.cachedInput || 0), requests: sum.requests + row.requests, costUsd: sum.costUsd + row.costUsd }), blank());
    const dates = [];
    const cursor = this.now();
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(cursor); date.setUTCDate(cursor.getUTCDate() - i);
      const key = dayKey(date), row = data.days[key] || blank();
      dates.push({ date: key, ...row });
    }
    const allDays = Object.values(data.days);
    const historicalInput = allDays.reduce((sum, row) => sum + Math.max(0, row.input - (row.pricedInput || 0)), 0);
    const historicalOutput = allDays.reduce((sum, row) => sum + Math.max(0, row.output - (row.pricedOutput || 0)), 0);
    const inputRate = historicalInput ? models.reduce((sum, row) => sum + row.backfillInputCost, 0) / historicalInput : 0;
    const outputRate = historicalOutput ? models.reduce((sum, row) => sum + row.backfillOutputCost, 0) / historicalOutput : 0;
    for (const row of dates) row.costUsd = (row.costUsd || 0) + Math.max(0, row.input - (row.pricedInput || 0)) * inputRate + Math.max(0, row.output - (row.pricedOutput || 0)) * outputRate;
    total.costCoverage = total.total ? models.reduce((sum, row) => sum + (row.priceAvailable ? row.total : 0), 0) / total.total : 1;
    for (const row of models) { delete row.backfillInputCost; delete row.backfillOutputCost; }
    return { total, models, days: dates };
  }
  reset() { atomicJson(this.paths.usageFile, { models: {}, days: {} }); }
}

module.exports = { UsageStore, dayKey, usageNumbers, estimateCost };
