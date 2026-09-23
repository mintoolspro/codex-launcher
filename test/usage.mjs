import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);const {getPaths}=require('../src/paths');const {UsageStore}=require('../src/usage');const {normalizeModels,providerModelProfile,pricingRates}=require('../src/providers');

test('usage accumulates, splits input/output, buckets by day, and sorts models',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-launcher-usage-'));let now=new Date('2026-09-20T12:00:00Z');const store=new UsageStore(getPaths(root),()=>now);
  store.record('openrouter/a',{prompt_tokens:10,completion_tokens:5,total_tokens:15});
  store.record('openrouter/b',{input_tokens:30,output_tokens:20,total_tokens:50});
  now=new Date('2026-09-21T12:00:00Z');store.record('openrouter/a',{input_tokens:3,output_tokens:2,total_tokens:5});
  const result=store.query(2);assert.equal(result.total.total,70);assert.equal(result.total.input,43);assert.equal(result.total.output,27);assert.equal(result.total.requests,3);assert.equal(result.models[0].model,'openrouter/b');assert.deepEqual(result.days.map(d=>d.total),[65,5]);
  store.reset();assert.equal(store.query(2).total.total,0);
});

test('usage estimates model, daily, and total cost while accounting for cached input',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-launcher-cost-'));let now=new Date('2026-09-20T12:00:00Z');
  const pricing={currency:'USD',unit:'million_tokens',input:{min:1,max:1},output:{min:2,max:2},cacheRead:{min:.25,max:.25}};
  const store=new UsageStore(getPaths(root),()=>now,()=>pricing);
  store.record('openrouter/a',{prompt_tokens:10,completion_tokens:5,prompt_tokens_details:{cached_tokens:4}});
  const result=store.query(1);assert.equal(result.models[0].costUsd,17/1_000_000);assert.equal(result.days[0].costUsd,17/1_000_000);assert.equal(result.total.costUsd,17/1_000_000);
});

test('provider pricing normalizes OpenRouter per-token rates and DeepSeek schedules',()=>{
  const [model]=normalizeModels({data:[{id:'vendor/model',pricing:{prompt:'0.0000015',completion:'0.000004'}}]},'openrouter');
  assert.deepEqual(model.pricing.input,{min:1.5,max:1.5});assert.deepEqual(model.pricing.output,{min:4,max:4});
  const deepseek=providerModelProfile('deepseek','deepseek-flash').pricing;
  assert.deepEqual(pricingRates(deepseek,new Date('2026-09-21T02:00:00Z')),{input:.30,output:1.20,cacheRead:.006,cacheWrite:0});
  assert.deepEqual(pricingRates(deepseek,new Date('2026-09-21T05:00:00Z')),{input:.15,output:.60,cacheRead:.003,cacheWrite:0});
});
