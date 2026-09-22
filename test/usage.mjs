import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);const {getPaths}=require('../src/paths');const {UsageStore}=require('../src/usage');

test('usage accumulates, splits input/output, buckets by day, and sorts models',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-launcher-usage-'));let now=new Date('2026-09-20T12:00:00Z');const store=new UsageStore(getPaths(root),()=>now);
  store.record('openrouter/a',{prompt_tokens:10,completion_tokens:5,total_tokens:15});
  store.record('openrouter/b',{input_tokens:30,output_tokens:20,total_tokens:50});
  now=new Date('2026-09-21T12:00:00Z');store.record('openrouter/a',{input_tokens:3,output_tokens:2,total_tokens:5});
  const result=store.query(2);assert.equal(result.total.total,70);assert.equal(result.total.input,43);assert.equal(result.total.output,27);assert.equal(result.total.requests,3);assert.equal(result.models[0].model,'openrouter/b');assert.deepEqual(result.days.map(d=>d.total),[65,5]);
  store.reset();assert.equal(store.query(2).total.total,0);
});
