import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { responsesToChat, chatToResponse, ChatSseTranslator } = require('../src/translate');
const { normalizeChatMessages, prepareChatMessages } = require('../src/gateway');

test('Responses image input becomes an OpenAI-compatible Chat image_url part', () => {
  const imageUrl = 'data:image/png;base64,abc123';
  const translated = responsesToChat({
    model: 'openrouter/vendor/model',
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Describe this image.' },
        { type: 'input_image', image_url: imageUrl, detail: 'high' }
      ]
    }]
  }, 'vendor/model');

  assert.deepEqual(translated.messages, [{
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this image.' },
      { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } }
    ]
  }]);
});

test('Responses developer messages become Chat system messages', () => {
  const translated = responsesToChat({
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: 'Follow project instructions.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }
    ]
  }, 'vendor/model');

  assert.deepEqual(translated.messages.map(({ role }) => role), ['system', 'user']);
});

test('gateway enforces supported roles at the upstream boundary', () => {
  assert.deepEqual(
    normalizeChatMessages([{ role: 'developer', content: 'a' }, { role: 'unexpected', content: 'b' }]),
    [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }]
  );
});

test('parallel Responses function calls become one assistant tool_calls message', () => {
  const translated = responsesToChat({
    input: [
      { type: 'function_call', call_id: 'call_view', name: 'view_image', arguments: '{"path":"a.png"}' },
      { type: 'function_call', call_id: 'call_exec', name: 'exec_command', arguments: '{"cmd":"file a.png"}' },
      { type: 'function_call_output', call_id: 'call_view', output: 'viewed image' },
      { type: 'function_call_output', call_id: 'call_exec', output: 'PNG image data' }
    ]
  }, 'vendor/model');

  assert.equal(translated.messages.length, 3);
  assert.equal(translated.messages[0].role, 'assistant');
  assert.deepEqual(translated.messages[0].tool_calls.map((call) => call.id), ['call_view', 'call_exec']);
  assert.deepEqual(translated.messages.slice(1).map((message) => message.tool_call_id), ['call_view', 'call_exec']);
});

test('DeepSeek tool-call history includes its required reasoning_content field', () => {
  const history = [{
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'view_image', arguments: '{}' } }]
  }];
  const messages = prepareChatMessages(history, 'deepseek');
  assert.equal(messages[0].reasoning_content, '');
  assert.equal('reasoning_content' in prepareChatMessages(history, 'openrouter')[0], false);
  assert.equal('reasoning_content' in prepareChatMessages([{ role: 'assistant', tool_calls: [] }], 'deepseek')[0], false);
  assert.equal(prepareChatMessages([{ role: 'assistant', content: 'done' }], 'deepseek', { hasTools: true })[0].reasoning_content, '');
});

test('reasoning and custom tool history survive the Responses to Chat bridge', () => {
  const translated = responsesToChat({
    tools: [{ type: 'custom', name: 'apply_patch' }],
    input: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'inspect first' }] },
      { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'Done' }
    ]
  }, 'model');
  assert.equal(translated.messages[0].reasoning_content, 'inspect first');
  assert.equal(translated.messages[0].tool_calls[0].function.arguments, '*** Begin Patch');
  assert.equal(translated.messages[1].tool_call_id, 'call_patch');
});

test('DeepSeek reasoning is represented in non-streaming and streaming Responses output', () => {
  const response = chatToResponse({ choices: [{ message: { reasoning_content: 'think', content: 'answer' } }] }, 'deepseek/model');
  assert.equal(response.output[0].type, 'reasoning');
  assert.equal(response.output[0].content[0].text, 'think');
  const translator = new ChatSseTranslator('deepseek/model');
  const text = translator.begin() + translator.push({ choices: [{ delta: { reasoning_content: 'thi' } }] }) + translator.push({ choices: [{ delta: { reasoning_content: 'nk', content: 'ok' } }] }) + translator.end().data;
  assert.match(text, /response.reasoning_text.delta/);
  assert.match(text, /"text":"think"/);
});
