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

const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const html = fs.readFileSync(new URL('./settings.html', import.meta.url), 'utf8');

assert.equal(manifest.version, '0.9.3');
assert.match(source, /const EXTENSION_VERSION = '0\.9\.3'/);
assert.match(source, /const DATA_VERSION = 10/);
assert.match(source, /useDynamicRecall: false/);
assert.match(source, /adaptiveTokenBudget: true/);
assert.match(source, /memoryMaxTokens: 8000/);
assert.match(source, /memoryReserveTokens: 1400/);

// Deliberately excluded scope: no arbitrary pairwise relationship network and no clothing/emotion/task ledger.
assert.doesNotMatch(source, /relationshipGraph|pairwiseRelationship|服装状态账本|情绪状态账本|待办状态账本/);
assert.match(source, /每一行都表示“该名称对应人物 ↔ \$\{userName\}”的关系/);

// Remote SiliconFlow/OpenAI-compatible embeddings remain supported; no local model worker was added.
assert.match(source, /https:\/\/api\.siliconflow\.cn\/v1/);
assert.doesNotMatch(source, /new Worker\([^)]*embedding|transformers\.js|onnxruntime/i);

// Request lifecycle is cancellable across chat switches and page hide.
assert.match(source, /requests: createAbortRegistry\(\)/);
assert.match(source, /state\.requests\.abortAll\('chat-changed'\)/);
assert.match(source, /state\.requests\.abortAll\('pagehide'\)/);

// IndexedDB failure must never push large float arrays back into chat metadata.
assert.match(source, /semantic vectors are disabled and keyword recall remains available/);
assert.match(source, /Never place large float arrays back into chat metadata/);
assert.doesNotMatch(source, /data\.vectors\[id\] = record/);

// Token-aware six-section fitting and UI controls.
assert.match(source, /fitMemorySections\(sections, budget\)/);
assert.match(source, /resolveAdaptiveMemoryBudget/);
assert.match(html, /根据本次上下文长度自动收缩记忆块/);
assert.match(html, /锚点记忆最多 Token/);
const headings = [
  '【一. 人物关系】', '【二. 锚点事件】', '动态演变（核心转变）】',
  '【四. 匹配到的出场人物库】', '【五. 重要道具、梗与核心细节】', '【六.',
];
let last = -1;
for (const heading of headings) {
  const position = source.indexOf(heading);
  assert.ok(position > last, `missing/out-of-order memory section: ${heading}`);
  last = position;
}

// Time continuity, structured item/scene shadow indexes, and public read-only API.
assert.match(source, /refreshTimelineFromGodlogs/);
assert.match(source, /itemTombstones/);
assert.match(source, /sceneTombstones/);
assert.match(source, /globalThis\.AnchorMemory = Object\.freeze/);

// UI IDs remain unique and all tabs have panels.
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'settings.html contains duplicate IDs');
const tabs = [...html.matchAll(/class="am-tab(?: active)?" data-tab="([^"]+)"/g)].map(match => match[1]);
const panels = [...html.matchAll(/class="am-tab-panel(?: active)?" data-panel="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual([...tabs].sort(), [...panels].sort());

// Abort registry behavior.
const registry = createAbortRegistry();
const first = registry.create('secondary');
const second = registry.create('embedding');
assert.equal(registry.count(), 2);
assert.equal(registry.abortScope('secondary'), 1);
assert.equal(first.controller.signal.aborted, true);
assert.equal(second.controller.signal.aborted, false);
assert.equal(registry.abortAll(), 1);
assert.equal(registry.count(), 0);

// Token fitting never exceeds the requested budget by more than estimator rounding.
const fitted = fitMemorySections([
  { id: 'a', text: `【一】\n${'人物关系。'.repeat(500)}`, minTokens: 200, maxTokens: 1200, weight: 1 },
  { id: 'b', text: `【二】\n${'历史锚点事件。'.repeat(1200)}`, minTokens: 600, maxTokens: 3000, weight: 4 },
  { id: 'c', text: `【六】\n${'近期摘要。'.repeat(600)}`, minTokens: 200, maxTokens: 900, weight: 1 },
], 2400);
assert.ok(fitted.usedTokens <= 2420, `token fit overflowed: ${fitted.usedTokens}`);
assert.ok(fitted.text.includes('【一】') && fitted.text.includes('【二】') && fitted.text.includes('【六】'));
assert.equal(resolveAdaptiveMemoryBudget({ contextSize: 8192, promptTokens: 5000, maxMemoryTokens: 8000, reserveTokens: 1400 }), 1792);
assert.equal(resolveAdaptiveMemoryBudget({ contextSize: 4096, promptTokens: 3800, maxMemoryTokens: 8000, reserveTokens: 1400 }), 0);
assert.ok(estimateTextTokens('中文 test 123') > 0);

// Time engine: normal advance, explicit next day, flashback, and suspicious backward clock.
assert.equal(compareNarrativeTimes('上午10:00', '下午15:00', '').order, 'forward');
assert.equal(compareNarrativeTimes('深夜23:00', '次日清晨7:00', '次日清晨').order, 'forward');
assert.equal(compareNarrativeTimes('下午15:00', '上午10:00', '回忆起上午的争执').order, 'flashback');
assert.equal(compareNarrativeTimes('下午15:00', '上午10:00', '两人继续交谈').order, 'backward');
const timeline = rebuildTimelineState([
  { key: '1', floor: 1, time: '上午10:00', body: '现实发生' },
  { key: '2', floor: 2, time: '上午9:00', body: '回忆昨日的会面' },
  { key: '3', floor: 3, time: '下午15:00', body: '回到现实' },
]);
assert.equal(timeline.currentRaw, '下午15:00');
assert.equal(timeline.warnings.length, 0);
const datedTimeline = rebuildTimelineState([
  { key: 'd1', floor: 1, time: '2025年3月15日 23:00', body: '深夜' },
  { key: 'd2', floor: 2, time: '次日清晨7:00', body: '次日清晨继续' },
]);
assert.match(datedTimeline.currentRaw, /2025年3月16日/);

// Stable entity keys and tombstone filtering.
const tombstone = { [entityKey('银色钥匙')]: { at: Date.now() } };
const items = buildItemLedger([
  { name: '银色钥匙', boundTo: '甲', meaning: '旧伏笔' },
  { name: '红绳', boundTo: '乙', meaning: '承诺' },
], {}, tombstone);
assert.deepEqual(items.order, [entityKey('红绳')]);
const scenes = buildSceneLedger([{ name: '公寓客厅', time: '深夜', people: '甲、乙', facts: '争执结束' }]);
assert.equal(scenes.byKey[entityKey('公寓客厅')].facts, '争执结束');

// 5,000-record pure-core stress check should remain linear and comfortably fast in Node.
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

console.log(`Anchor Memory 0.9.3 regression checks passed (${elapsed.toFixed(1)}ms entity stress).`);
