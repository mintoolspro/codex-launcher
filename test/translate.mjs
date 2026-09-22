import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { responsesToChat } = require('../src/translate');

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
