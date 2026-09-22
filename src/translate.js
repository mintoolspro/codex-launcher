'use strict';

const crypto = require('node:crypto');

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part.text || part.input_text || part.output_text || '').join('');
}

function chatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return textContent(content);
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part });
      continue;
    }
    if (part?.type === 'input_image' || part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (url) parts.push({ type: 'image_url', image_url: { url, ...(part.detail ? { detail: part.detail } : {}) } });
      continue;
    }
    const text = part?.text ?? part?.input_text ?? part?.output_text;
    if (text != null) parts.push({ type: 'text', text: String(text) });
  }
  return parts;
}

function responsesToChat(body, upstreamModel) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: textContent(body.instructions) });
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : (body.input || []);
  for (const item of input) {
    if (item.type === 'function_call') {
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: item.arguments || '' } }] });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: textContent(item.output) });
    } else {
      messages.push({ role: item.role || 'user', content: chatContent(item.content ?? item) });
    }
  }
  const tools = (body.tools || []).filter((tool) => tool.type === 'function').map((tool) => ({
    type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters || {} }
  }));
  const result = {
    model: upstreamModel,
    messages,
    stream: Boolean(body.stream)
  };
  if (tools.length) result.tools = tools;
  if (body.tool_choice) result.tool_choice = body.tool_choice;
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.max_output_tokens != null) result.max_tokens = body.max_output_tokens;
  if (body.stream) result.stream_options = { include_usage: true };
  return result;
}

function chatUsage(usage = {}) {
  const input = usage.prompt_tokens || 0, output = usage.completion_tokens || 0;
  return { input_tokens: input, output_tokens: output, total_tokens: usage.total_tokens || input + output };
}

function chatToResponse(payload, requestedModel) {
  const choice = payload.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  if (message.content) output.push({ id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: message.content, annotations: [] }] });
  for (const call of message.tool_calls || []) output.push({ id: `fc_${crypto.randomUUID()}`, type: 'function_call', status: 'completed', call_id: call.id, name: call.function?.name, arguments: call.function?.arguments || '' });
  return {
    id: payload.id || `resp_${crypto.randomUUID()}`,
    object: 'response', created_at: payload.created || Math.floor(Date.now() / 1000), status: 'completed',
    model: requestedModel, output, usage: chatUsage(payload.usage)
  };
}

class ChatSseTranslator {
  constructor(model) {
    this.model = model;
    this.responseId = `resp_${crypto.randomUUID()}`;
    this.sequence = 0;
    this.textIndex = null;
    this.text = '';
    this.calls = new Map();
    this.usage = chatUsage();
    this.created = Math.floor(Date.now() / 1000);
  }
  event(type, data) { return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...data })}\n\n`; }
  begin() {
    return this.event('response.created', { response: { id: this.responseId, object: 'response', created_at: this.created, status: 'in_progress', model: this.model, output: [] } });
  }
  push(chunk) {
    if (chunk.usage) this.usage = chatUsage(chunk.usage);
    const delta = chunk.choices?.[0]?.delta || {};
    let out = '';
    if (delta.content) {
      if (this.textIndex == null) {
        this.textIndex = 0;
        const item = { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
        this.textItem = item;
        out += this.event('response.output_item.added', { output_index: 0, item });
        out += this.event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      this.text += delta.content;
      out += this.event('response.output_text.delta', { item_id: this.textItem.id, output_index: 0, content_index: 0, delta: delta.content });
    }
    for (const update of delta.tool_calls || []) {
      const key = update.index ?? this.calls.size;
      let call = this.calls.get(key);
      if (!call) {
        const outputIndex = (this.textIndex == null ? 0 : 1) + this.calls.size;
        call = { id: `fc_${crypto.randomUUID()}`, type: 'function_call', status: 'in_progress', call_id: update.id || `call_${crypto.randomUUID()}`, name: update.function?.name || '', arguments: '', outputIndex };
        this.calls.set(key, call);
        out += this.event('response.output_item.added', { output_index: outputIndex, item: { id: call.id, type: call.type, status: call.status, call_id: call.call_id, name: call.name, arguments: '' } });
      }
      if (update.id) call.call_id = update.id;
      if (update.function?.name) call.name += update.function.name;
      if (update.function?.arguments) {
        call.arguments += update.function.arguments;
        out += this.event('response.function_call_arguments.delta', { item_id: call.id, output_index: call.outputIndex, delta: update.function.arguments });
      }
    }
    return out;
  }
  end() {
    let out = '';
    const output = [];
    if (this.textIndex != null) {
      const item = { ...this.textItem, status: 'completed', content: [{ type: 'output_text', text: this.text, annotations: [] }] };
      output.push(item);
      out += this.event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: this.text });
      out += this.event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
      out += this.event('response.output_item.done', { output_index: 0, item });
    }
    for (const call of this.calls.values()) {
      const item = { id: call.id, type: call.type, status: 'completed', call_id: call.call_id, name: call.name, arguments: call.arguments };
      output.push(item);
      out += this.event('response.function_call_arguments.done', { item_id: call.id, output_index: call.outputIndex, arguments: call.arguments });
      out += this.event('response.output_item.done', { output_index: call.outputIndex, item });
    }
    const response = { id: this.responseId, object: 'response', created_at: this.created, status: 'completed', model: this.model, output, usage: this.usage };
    out += this.event('response.completed', { response });
    out += 'data: [DONE]\n\n';
    return { data: out, response, usage: this.usage };
  }
}

module.exports = { textContent, chatContent, responsesToChat, chatToResponse, chatUsage, ChatSseTranslator };
