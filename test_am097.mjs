import fs from 'node:fs';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  createAbortRegistry,
  estimateTextTokens,
  fitMemorySections,
  resolveAdaptiveMemoryBudget,
} from './core/runtime-controls.js';
import { compareNarrativeTimes, rebuildTimelineState } from './core/time-engine.js';
import { buildItemLedger, buildSceneLedger, entityKey } from './core/entity-ledger.js';
import {
  makeStableMessageKey,
  isCompletedSummary,
  summaryRevisionHash,
  lockCompletedSummaryToSavedSnapshot,
} from './core/summary-lifecycle.js';

const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const html = fs.readFileSync(new URL('./settings.html', import.meta.url), 'utf8');

const css = fs.readFileSync(new URL('./style.css', import.meta.url), 'utf8');
assert.match(css, /max-width: 1024px/);
assert.match(css, /--am-vv-height/);
assert.match(css, /body\.am-workbench-open/);
assert.match(css, /height: 100% !important/);
assert.match(css, /overflow-x: auto/);
assert.match(source, /window\.visualViewport/);
assert.match(source, /syncWorkbenchViewport/);
assert.match(source, /\$\('body'\)\.addClass\('am-workbench-open'\)/);
assert.match(source, /content\.scrollTop = 0/);

assert.equal(manifest.version, '0.9.7');
assert.match(source, /const EXTENSION_VERSION = '0\.9\.7'/);
assert.match(source, /const DATA_VERSION = 11/);
assert.match(source, /const SOURCE_HASH_SCHEMA_VERSION = 4/);

// 0.9.7: warning toasts follow SillyTavern's normal tap-to-dismiss behavior.
const warningFunction = source.match(/function maybeWarnMissingGodlogs\([\s\S]*?\n}\n\nfunction formatGodlogMaterials/)?.[0] || '';
assert.ok(warningFunction, 'missing-Godlog warning function must exist');
assert.doesNotMatch(warningFunction, /onclick\s*:/);
assert.match(warningFunction, /closeButton:\s*true/);
assert.match(warningFunction, /tapToDismiss:\s*true/);
assert.doesNotMatch(warningFunction, /点这里打开/);

// New installs use a clean 15/75 hierarchy, while runtime edits are normalized and deferred safely.
assert.match(source, /const DEFAULT_ANCHOR_INTERVAL = 15/);
assert.match(source, /const DEFAULT_MERGE_INTERVAL = 75/);
assert.match(source, /anchorInterval:\s*DEFAULT_ANCHOR_INTERVAL/);
assert.match(source, /mergeInterval:\s*DEFAULT_MERGE_INTERVAL/);
assert.doesNotMatch(source, /mergeInterval:\s*100/);
assert.match(source, /function applyIntervalSettingChange/);
assert.match(source, /state\.pendingIntervalRecheck = true/);
assert.match(source, /function flushDeferredIntervalRecheck/);
assert.match(source, /anchorIntervalAtStart/);
assert.match(source, /mergeIntervalAtStart/);
assert.match(source, /intervalUsed:\s*interval/);
assert.match(source, /batchSize:\s*materials\.length/);
assert.match(source, /cycleSize:\s*sourceKeys\.length/);
assert.match(html, /默认 15 \/ 75 可整批衔接/);
assert.match(html, /新值从下一批尚未处理的逐楼摘要开始生效/);


// Dynamic recall must resolve before the request is released, and previews must not mutate the
// record of what was actually injected into the current generation.
assert.match(source, /const DYNAMIC_RECALL_PROMPT_WAIT_MS = 1800/);
assert.match(source, /resolveDynamicRecallBeforeSend\(contextChat, DYNAMIC_RECALL_PROMPT_WAIT_MS\)/);
assert.match(source, /markDynamicRecallInjected\('chat-completion-prompt-ready', content\)/);
assert.match(source, /stage: 'injected-before-send'/);
assert.match(source, /usedForCurrentPrompt: true/);
assert.match(source, /buildPromptReadyInjection\(getContext\(\)\.chat \|\| \[\], \{ commit: false \}\)/);
assert.match(source, /getPromptPreview: async \(\) => buildPromptReadyInjection\(getContext\(\)\.chat \|\| \[\], \{ commit: false \}\)/);
assert.match(source, /后到的语义结果未用于本轮/);
assert.match(source, /Horae follows the same ordering/);

// Completed summaries are durable snapshots: automatic reconciliation must preserve them.
assert.match(source, /isCompletedSummary\(item\)[\s\S]*preserveCompletedGodlogOnSourceChange/);
assert.match(source, /摘要已保存并锁定/);
assert.match(source, /重跑本楼摘要/);
assert.doesNotMatch(source, /if \(row && item\.rawHash && item\.rawHash !== row\.rawHash\) return false/);
assert.match(source, /codexKeys\[row\.key\] !== summaryRevisionHash\(godlog, row\)/);
assert.match(source, /Replacement is transactional/);
assert.match(source, /旧摘要继续生效，只有新摘要成功后才会替换/);

const originalKey = makeStableMessageKey({
  persistentIdentity: '2026-07-11T20:00:00+08:00',
  role: 'assistant',
  index: 41,
});
const sameKeyAfterHostMetadataChange = makeStableMessageKey({
  storedKey: originalKey,
  persistentIdentity: 'later-normalized-message-id',
  role: 'assistant',
  index: 41,
});
assert.equal(sameKeyAfterHostMetadataChange, originalKey, 'host metadata changes must not re-key the floor');

const item = {
  status: 'ready',
  stale: false,
  body: '<Godlog><Nub>21</Nub><Title>旧摘要</Title><Time>未明</Time><Pln>未明</Pln><Per>甲</Per><Cond>已经生成并保存的摘要。</Cond></Godlog>',
  rawHash: 'source-v1',
  floor: 40,
  role: 'assistant',
  name: '甲',
  sendDate: 'old-date',
  updatedAt: 123,
};
const row = {
  index: 40,
  role: 'assistant',
  name: '甲',
  sendDate: 'normalized-date',
  rawHash: 'source-v2',
};
assert.equal(isCompletedSummary(item), true);
assert.equal(lockCompletedSummaryToSavedSnapshot(item, row, '提示词注入后宿主重新渲染', 999), true);
assert.equal(item.status, 'ready');
assert.equal(item.stale, false);
assert.equal(item.body.includes('已经生成并保存的摘要'), true);
assert.equal(item.rawHash, 'source-v1', 'saved summary keeps the source revision it summarized');
assert.equal(item.currentRawHash, 'source-v2');
assert.equal(item.sourceMismatch, true);
assert.equal(summaryRevisionHash(item, row), 'source-v1', 'codex/anchors follow the saved summary revision, not later host changes');

const restoredRow = { ...row, rawHash: 'source-v1' };
assert.equal(lockCompletedSummaryToSavedSnapshot(item, restoredRow, '', 1000), true);
assert.equal(item.sourceMismatch, false);
assert.equal(item.currentRawHash, '');

const pending = { status: 'pending', stale: false, body: '', rawHash: 'a' };
assert.equal(lockCompletedSummaryToSavedSnapshot(pending, row, 'change'), false, 'unfinished summaries may still follow normal retry logic');

// Existing 0.9.3 core guarantees remain intact.
assert.match(source, /useDynamicRecall: false/);
assert.match(source, /adaptiveTokenBudget: true/);
assert.match(source, /memoryMaxTokens: 8000/);
assert.match(source, /requests: createAbortRegistry\(\)/);
assert.match(source, /state\.requests\.abortAll\('chat-changed'\)/);
assert.match(source, /semantic vectors are disabled and keyword recall remains available/);
assert.match(source, /fitMemorySections\(sections, budget\)/);
assert.match(source, /itemTombstones/);
assert.match(source, /sceneTombstones/);
assert.match(source, /globalThis\.AnchorMemory = Object\.freeze/);

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'settings.html contains duplicate IDs');
const tabs = [...html.matchAll(/class="am-tab(?: active)?" data-tab="([^"]+)"/g)].map(match => match[1]);
const panels = [...html.matchAll(/class="am-tab-panel(?: active)?" data-panel="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual([...tabs].sort(), [...panels].sort());

const registry = createAbortRegistry();
const first = registry.create('secondary');
const second = registry.create('embedding');
assert.equal(registry.abortScope('secondary'), 1);
assert.equal(first.controller.signal.aborted, true);
assert.equal(second.controller.signal.aborted, false);
assert.equal(registry.abortAll(), 1);

const fitted = fitMemorySections([
  { id: 'a', text: `【一】\n${'人物关系。'.repeat(500)}`, minTokens: 200, maxTokens: 1200, weight: 1 },
  { id: 'b', text: `【二】\n${'历史锚点事件。'.repeat(1200)}`, minTokens: 600, maxTokens: 3000, weight: 4 },
  { id: 'c', text: `【六】\n${'近期摘要。'.repeat(600)}`, minTokens: 200, maxTokens: 900, weight: 1 },
], 2400);
assert.ok(fitted.usedTokens <= 2420);
assert.equal(resolveAdaptiveMemoryBudget({ contextSize: 8192, promptTokens: 5000, maxMemoryTokens: 8000, reserveTokens: 1400 }), 1792);
assert.ok(estimateTextTokens('中文 test 123') > 0);

assert.equal(compareNarrativeTimes('上午10:00', '下午15:00', '').order, 'forward');
const timeline = rebuildTimelineState([
  { key: '1', floor: 1, time: '上午10:00', body: '现实发生' },
  { key: '2', floor: 2, time: '上午9:00', body: '回忆昨日的会面' },
  { key: '3', floor: 3, time: '下午15:00', body: '回到现实' },
]);
assert.equal(timeline.currentRaw, '下午15:00');

const tombstone = { [entityKey('银色钥匙')]: { at: Date.now() } };
const items = buildItemLedger([
  { name: '银色钥匙', boundTo: '甲', meaning: '旧伏笔' },
  { name: '红绳', boundTo: '乙', meaning: '承诺' },
], {}, tombstone);
assert.deepEqual(items.order, [entityKey('红绳')]);
const scenes = buildSceneLedger([{ name: '公寓客厅', time: '深夜', people: '甲、乙', facts: '争执结束' }]);
assert.equal(scenes.byKey[entityKey('公寓客厅')].facts, '争执结束');

const manyItems = Array.from({ length: 5000 }, (_, index) => ({
  name: `物品${index}`,
  boundTo: `人物${index % 30}`,
  meaning: `事件${index}`,
}));
const started = performance.now();
const ledger = buildItemLedger(manyItems);
const elapsed = performance.now() - started;
assert.equal(ledger.order.length, 5000);
assert.ok(elapsed < 1500, `5,000-item ledger build too slow: ${elapsed.toFixed(1)}ms`);

console.log(`Anchor Memory 0.9.7 interval/toast regression checks passed (${elapsed.toFixed(1)}ms entity stress).`);
