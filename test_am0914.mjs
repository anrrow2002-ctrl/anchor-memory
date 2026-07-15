import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));

assert.equal(manifest.version, '0.9.16');
assert.match(source, /const EXTENSION_VERSION = '0.9.16'/);
assert.match(source, /function secondaryConfigured/);
assert.match(source, /String\(s\.secondaryModel \|\| ''\)\.trim\(\)/);
assert.match(source, /副API响应成功但没有可用正文/);
assert.match(source, /副API请求失败/);
assert.match(source, /finish_reason=/);
assert.match(source, /function parseSecondarySse/);
assert.match(source, /reasoning_content/);
assert.match(source, /chat_completion_source: 'custom'/);
assert.match(source, /chat_completion_source: 'openai'/);
assert.match(source, /custom_url: base/);
assert.match(source, /reverse_proxy: base/);
assert.match(source, /syncSecondaryInputsFromUi\(\{ clearModel: true \}\)/);
assert.match(source, /模型栏已清空/);
assert.match(html, /每次点击“拉取副API模型”都会先清空旧模型栏/);
assert.match(html, /id="am_fetch_secondary_models" type="button"/);

// Evaluate the actual response-parser helpers from index.js.
const parserStart = source.indexOf('function baseApiUrl(url)');
const parserEnd = source.indexOf('\nasync function callSecondary', parserStart);
assert.ok(parserStart >= 0 && parserEnd > parserStart);
const parserContext = {};
vm.createContext(parserContext);
vm.runInContext(`${source.slice(parserStart, parserEnd)}\nthis.api={baseApiUrl,extractSecondaryError,extractSecondaryFinishReason,extractSecondaryResponseText,parseSecondarySse};`, parserContext);
const api = parserContext.api;
assert.equal(api.baseApiUrl(' https://x.test/v1/chat/completions/ '), 'https://x.test/v1');
assert.equal(api.baseApiUrl('https://x.test/v1/responses'), 'https://x.test/v1');
assert.equal(api.extractSecondaryResponseText({ choices: [{ message: { content: 'A' } }] }), 'A');
assert.equal(api.extractSecondaryResponseText({ choices: [{ message: { content: [{ type: 'text', text: 'B' }] } }] }), 'B');
assert.equal(api.extractSecondaryResponseText({ data: 'C' }), 'C');
assert.equal(api.extractSecondaryResponseText({ response: { answer: 'D' } }), 'D');
assert.equal(api.extractSecondaryResponseText({ output: [{ content: [{ type: 'output_text', text: 'E' }] }] }), 'E');
assert.equal(api.extractSecondaryResponseText({ candidates: [{ content: { parts: [{ text: 'F' }] } }] }), 'F');
assert.equal(api.extractSecondaryResponseText({ choices: [{ message: { content: null, reasoning_content: 'G' } }] }), 'G');
assert.equal(api.extractSecondaryError({ error: { message: 'bad key' } }), 'bad key');
assert.equal(api.extractSecondaryFinishReason({ choices: [{ finish_reason: 'length' }] }), 'length');
const sse = api.parseSecondarySse('data: {"choices":[{"delta":{"content":"<God"}}]}\n\ndata: {"choices":[{"delta":{"content":"log>"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n');
assert.equal(sse.content, '<Godlog>');
assert.equal(sse.finishReason, 'stop');

// Evaluate actual model-list parsing and ensure provider/account names are not selected as models.
const modelStart = source.indexOf('function looksLikeEmbeddingModel');
const modelEnd = source.indexOf('\nasync function fetchModelsThroughSillyTavern', modelStart);
assert.ok(modelStart >= 0 && modelEnd > modelStart);
const modelContext = {};
vm.createContext(modelContext);
vm.runInContext(`${source.slice(modelStart, modelEnd)}\nthis.api={collectModelIds,looksLikeChatModel,looksLikeEmbeddingModel};`, modelContext);
const modelApi = modelContext.api;
assert.deepEqual([...modelApi.collectModelIds({ provider: { name: 'OpenAI' }, data: [{ id: 'gpt-test' }, { name: 'claude-test' }] })], ['gpt-test', 'claude-test']);
assert.deepEqual([...modelApi.collectModelIds({ response: { available_models: ['m1', { model: 'm2' }] } })], ['m1', 'm2']);
assert.deepEqual([...modelApi.collectModelIds({ model_names: ['m3', 'm4'] })], ['m3', 'm4']);
assert.equal(modelApi.looksLikeChatModel('text-embedding-3-large'), false);
assert.equal(modelApi.looksLikeChatModel('gpt-4.1-mini'), true);

// The mobile pull path must clear stale model state before any network call.
const fetchFnStart = source.indexOf('async function fetchSecondaryModels()');
const fetchFnEnd = source.indexOf('\nasync function fetchEmbeddingModels', fetchFnStart);
const fetchFn = source.slice(fetchFnStart, fetchFnEnd);
assert.ok(fetchFn.indexOf('syncSecondaryInputsFromUi({ clearModel: true })') < fetchFn.indexOf('fetchProviderModels('));
assert.match(fetchFn, /s\.secondaryModel = ''/);
assert.match(fetchFn, /renderModelOptions\('#am_secondary_model_options', \[\]\)/);

// Summary transport errors must not be mislabeled as format correction requests.
const summaryStart = source.indexOf('async function generateGodlogForRow');
const summaryEnd = source.indexOf('\nasync function processGodlogBacklog', summaryStart);
const summaryFn = source.slice(summaryStart, summaryEnd);
assert.match(summaryFn, /Only a real model answer with a format\/length defect gets a corrective rewrite/);
assert.match(summaryFn, /if \(!String\(body \|\| ''\)\.trim\(\)\) throw new Error/);
assert.match(summaryFn, /callSummaryWriter\(correctionPrompt, 1800\)/);

// Hidden floors and hidden summaries are separate: the raw-window plan does not consult Godlog status.
const recentStart = source.indexOf('function recentRawHistoryPlan');
const recentEnd = source.indexOf('\nasync function enforceAnchorHiddenState', recentStart);
const recentSource = source.slice(recentStart, recentEnd);
assert.doesNotMatch(recentSource, /godlog|summary|anchor/i);
const recentContext = {
  settings: () => ({ keepRecent: 3 }),
  cleanText: value => String(value || '').trim(),
  isNarrativeMessage: message => !!message && (!message.is_system || !!message.anchor_memory_meta?.hiddenByMemory),
  turnMessageIndicesForAssistant(chat, assistantIndex) {
    let start = assistantIndex;
    for (let i = assistantIndex - 1; i >= 0; i--) {
      const m = chat[i];
      if (!m || !this.isNarrativeMessage(m)) continue;
      if (!m.is_user) break;
      start = i;
    }
    const out = [];
    for (let i = start; i <= assistantIndex; i++) if (this.isNarrativeMessage(chat[i])) out.push(i);
    return out;
  },
};
// Avoid `this` ambiguity inside the extracted function's dependency.
recentContext.turnMessageIndicesForAssistant = (chat, assistantIndex) => {
  let start = assistantIndex;
  for (let i = assistantIndex - 1; i >= 0; i--) {
    const m = chat[i];
    if (!m || !recentContext.isNarrativeMessage(m)) continue;
    if (!m.is_user) break;
    start = i;
  }
  const out = [];
  for (let i = start; i <= assistantIndex; i++) if (recentContext.isNarrativeMessage(chat[i])) out.push(i);
  return out;
};
vm.createContext(recentContext);
vm.runInContext(`${recentSource}\nthis.recentRawHistoryPlan=recentRawHistoryPlan;`, recentContext);
const chat = [];
for (let n = 1; n <= 5; n++) {
  chat.push({ is_user: true, mes: `u${n}` });
  chat.push({ is_user: false, mes: `a${n}` });
}
// Simulate ST turning a plugin-hidden old narrative floor into a system message.
chat[1].is_system = true;
chat[1].anchor_memory_meta = { hiddenByMemory: true };
chat.push({ is_system: true, mes: 'genuine system' });
chat.push({ is_user: true, mes: 'new pending user' });
const plan = recentContext.recentRawHistoryPlan(chat, 3);
assert.deepEqual([...plan.keepAssistantIndices], [5, 7, 9]);
assert.deepEqual([...plan.hideIndices], [0, 1, 2, 3]);
assert.ok(plan.keepIndices.includes(11));
assert.ok(!plan.keepIndices.includes(10));


// Manual SillyTavern hides must not be mistaken for Anchor Memory ownership merely because a stable key exists.
const hideStart = source.indexOf('function memoryHideMeta');
const hideEnd = source.indexOf('function isNarrativeMessage', hideStart);
const hideContext = {};
vm.createContext(hideContext);
vm.runInContext(`${source.slice(hideStart, hideEnd)}\nthis.api={isMemoryManagedHidden,hasMemoryHideOwnership};`, hideContext);
assert.equal(hideContext.api.hasMemoryHideOwnership({ is_hidden: true, anchor_memory_meta: { stableMessageKey: 'x' } }), false);
assert.equal(hideContext.api.hasMemoryHideOwnership({ anchor_memory_meta: { hiddenByMemory: true } }), true);
assert.equal(hideContext.api.hasMemoryHideOwnership({ anchor_memory_meta: { wasHiddenBeforeAnchor: false } }), true);
assert.match(source, /const managed = hasMemoryHideOwnership\(message\)/);
assert.doesNotMatch(source, /const managed = isMemoryManagedHidden\(message\) \|\| \(!!message\.is_hidden && !!memoryHideMeta\(message\)\)/);
assert.match(source, /delete meta\.hiddenByMemory;[\s\S]*delete meta\.hiddenAnchorIds;/);

// Without a complete secondary API configuration, the background queue stays dormant instead of repeatedly failing.
assert.match(source, /function hasPendingMemoryWork\(\) \{\s*if \(!hasPersistentChatContext\(\) \|\| !secondaryConfigured\(\)\) return false;/s);

// Godlog XML is UI/metadata only and is actively removed from message bodies, including plugin-hidden rows.
assert.match(source, /function syncGodlogBlockToMessage\(row, _body\) \{\s*return removeGodlogBlockFromMessage\(row\);\s*\}/s);
assert.match(source, /message\.is_system && !isMemoryManagedHidden\(message\)/);
assert.match(source, /uiOnly: true/);
assert.match(source, /sanitizePromptReadyGodlogLeaks\(promptChat\)/);

// Archive transfer is one compact merge only; original-chat reload is blocked in both UI and action logic.
assert.match(source, /snapshot\.godlogs = \[\]/);
assert.match(source, /snapshot\.anchors = \[\]/);
assert.match(source, /snapshot\.merges = \[transferMerge\]/);
assert.match(source, /loaded\.godlogs = \[\]/);
assert.match(source, /loaded\.anchors = \[\]/);
assert.match(source, /原聊天禁止加载/);
assert.match(source, /if \(archiveMatchesCurrentChat\(archive,/);
assert.match(source, /精简转档副本覆盖原聊天/);

// Prompt history is pruned in both the generate interceptor and final chat-completion hook.
assert.match(source, /mode: 'generate-interceptor-history-hide'/);
assert.match(source, /mode: 'prompt-ready-history-hide'/);
assert.match(source, /prune: true/);
assert.match(source, /removeOutboundIndices/);

console.log('Anchor Memory staged-rebuild regression tests passed.');
