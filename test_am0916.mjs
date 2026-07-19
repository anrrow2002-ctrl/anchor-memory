import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));

assert.equal(manifest.version, '0.9.17');
assert.match(source, /const EXTENSION_VERSION = '0.9.17'/);
assert.match(source, /function secondaryResponseDiagnostics/);
assert.match(source, /function secondaryEmptyResponseHint/);
assert.match(source, /reasoning_details/);
assert.match(source, /thinking_content/);
assert.match(source, /completion_tokens=/);
assert.match(source, /message字段=/);

const parserStart = source.indexOf('function baseApiUrl(url)');
const parserEnd = source.indexOf('\nasync function callSecondary', parserStart);
assert.ok(parserStart >= 0 && parserEnd > parserStart);
const context = {};
vm.createContext(context);
vm.runInContext(`${source.slice(parserStart, parserEnd)}\nthis.api={extractSecondaryResponseText,secondaryResponseDiagnostics,secondaryEmptyResponseHint};`, context);
const api = context.api;

assert.equal(api.extractSecondaryResponseText({
  choices: [{ message: { content: null, reasoning_details: [{ type: 'reasoning.summary', summary: [{ type: 'summary_text', text: '<Godlog>A</Godlog>' }] }] }, finish_reason: 'stop' }],
}), '<Godlog>A</Godlog>');

assert.equal(api.extractSecondaryResponseText({
  choices: [{ message: { content: null, thinking: [{ text: '<Godlog>B</Godlog>' }] }, finish_reason: 'stop' }],
}), '<Godlog>B</Godlog>');

assert.equal(api.extractSecondaryResponseText({
  choices: [{ delta: { content: null, reasoning_content: '<Godlog>C</Godlog>' }, finish_reason: 'stop' }],
}), '<Godlog>C</Godlog>');

const stripped = {
  id: 'x', object: 'chat.completion', created: 1, model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
  usage: { completion_tokens: 320, completion_tokens_details: { reasoning_tokens: 320 } },
};
const diagnostics = api.secondaryResponseDiagnostics(stripped);
assert.match(diagnostics, /choice字段=/);
assert.match(diagnostics, /message字段=role\|content/);
assert.match(diagnostics, /content=null/);
assert.match(diagnostics, /completion_tokens=320/);
assert.match(diagnostics, /reasoning_tokens=320/);
assert.match(api.secondaryEmptyResponseHint(stripped), /推理token/);

const empty = {
  choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
  usage: { completion_tokens: 0 },
};
assert.match(api.secondaryEmptyResponseHint(empty), /生成token为0/);

const toolOnly = {
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: '1' }] }, finish_reason: 'stop' }],
};
assert.match(api.secondaryEmptyResponseHint(toolOnly), /只返回了tool_calls/);

console.log('Anchor Memory 0.9.17 secondary response compatibility and diagnostics tests passed.');
