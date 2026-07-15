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

assert.equal(manifest.version, '0.9.14');
assert.match(source, /const EXTENSION_VERSION = '0\.9\.14'/);
assert.match(source, /const DATA_VERSION = 11/);
assert.match(source, /const SOURCE_HASH_SCHEMA_VERSION = 4/);

// Mobile/fullscreen and normal toast behavior remain intact.
assert.match(css, /max-width: 1024px/);
assert.match(css, /--am-vv-height/);
assert.match(css, /body\.am-workbench-open/);
assert.match(source, /window\.visualViewport/);
const warningFunction = source.match(/function maybeWarnMissingGodlogs\([\s\S]*?\n}\n\nfunction rawFallbackTextForRow/)?.[0] || '';
assert.ok(warningFunction);
assert.doesNotMatch(warningFunction, /onclick\s*:/);
assert.match(warningFunction, /tapToDismiss:\s*true/);
assert.match(warningFunction, /受限保底原文/);

// 0.9.8 gap guard: old missing summaries are represented before send and cannot freeze all later anchors.
assert.match(source, /function rawFallbackEligible/);
assert.match(source, /function rawFallbackTextForRow/);
assert.match(source, /mode: 'raw-fallback'/);
assert.match(source, /摘要失败楼层的临时保底原文/);
assert.match(source, /RECENT_READY_SUMMARY_TOTAL_CHAR_BUDGET = 3300/);
assert.match(source, /MISSING_RAW_FALLBACK_TOTAL_CHAR_BUDGET = 900/);
assert.match(source, /function compactGodlogMemoryText/);
assert.match(source, /id: 'recent', minTokens: 1400, maxTokens: 3000, weight: 3\.6/);
assert.match(source, /MISSING_RAW_FALLBACK_ANCHOR_TOTAL_CHAR_BUDGET = 18000/);
assert.match(source, /rawFallbackKeys: materials\.filter/);
assert.match(source, /rawFallbackKeys: blocks\.filter/);
assert.match(source, /item\.mode !== 'raw-fallback'/);
assert.match(source, /anchorCovered\.has\(row\.key\) \|\| rawFallbackEligible/);

// Existing interval/recall/summary-lock guarantees remain intact.
assert.match(source, /const DEFAULT_ANCHOR_INTERVAL = 15/);
assert.match(source, /const DEFAULT_MERGE_INTERVAL = 75/);
assert.match(source, /resolveDynamicRecallBeforeSend\(contextChat, DYNAMIC_RECALL_PROMPT_WAIT_MS\)/);
assert.match(source, /stage: 'injected-before-send'/);
assert.match(source, /isCompletedSummary\(item\)[\s\S]*preserveCompletedGodlogOnSourceChange/);
assert.match(source, /旧摘要继续生效，只有新摘要成功后才会替换/);
assert.match(source, /useDynamicRecall: false/);
assert.match(source, /adaptiveTokenBudget: true/);
assert.match(source, /memoryMaxTokens: 8000/);

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'settings.html contains duplicate IDs');
const tabs = [...html.matchAll(/class="am-tab(?: active)?" data-tab="([^"]+)"/g)].map(match => match[1]);
const panels = [...html.matchAll(/class="am-tab-panel(?: active)?" data-panel="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual([...tabs].sort(), [...panels].sort());

// Pure flow simulator mirrors the key-coverage rules and checks every prompt boundary.
function simulateFlow({
  turns = 90,
  keepRecent = 3,
  anchorInterval = 15,
  mergeInterval = 75,
  summaryDelay = 0,
  permanentlyMissing = new Set(),
  intervalChanges = new Map(),
  enableRawFallback = true,
} = {}) {
  const readyAt = new Map();
  const anchors = [];
  let merged = new Set();
  const gaps = [];
  const snapshots = [];

  const activeAnchored = () => {
    const set = new Set();
    for (const anchor of anchors) {
      for (const key of anchor.keys) if (!merged.has(key)) set.add(key);
    }
    return set;
  };
  const recentSet = current => new Set(Array.from({ length: Math.min(keepRecent, current) }, (_, i) => current - i));
  const isReady = (key, now) => !permanentlyMissing.has(key) && (readyAt.get(key) ?? Infinity) <= now;
  const fallbackEligible = (key, now) => enableRawFallback && !recentSet(now).has(key);

  function mergeCycle(now) {
    const anchorCovered = activeAnchored();
    const result = [];
    for (let key = 1; key <= now; key++) {
      if (merged.has(key)) continue;
      if (isReady(key, now) || anchorCovered.has(key) || fallbackEligible(key, now)) result.push(key);
      else break;
    }
    return result;
  }

  function pendingAnchor(now) {
    const anchored = activeAnchored();
    const result = [];
    for (let key = 1; key <= now; key++) {
      if (merged.has(key) || anchored.has(key)) continue;
      if (isReady(key, now) || fallbackEligible(key, now)) result.push(key);
      else break;
    }
    return result;
  }

  function processDerived(now) {
    // Merge boundary wins over a new segment, exactly as createAnchorUnlocked does.
    for (let guard = 0; guard < 20; guard++) {
      const cycle = mergeCycle(now);
      if (cycle.length >= mergeInterval) {
        const next = cycle.slice(0, mergeInterval);
        merged = new Set([...merged, ...next]);
        continue;
      }
      const pending = pendingAnchor(now);
      if (pending.length >= anchorInterval) {
        const keys = pending.slice(0, anchorInterval);
        anchors.push({ keys, rawFallbackKeys: keys.filter(key => !isReady(key, now)) });
        continue;
      }
      break;
    }
  }

  function promptCoverage(now) {
    const recent = recentSet(now);
    const anchored = activeAnchored();
    const covered = new Set([...merged, ...anchored, ...recent]);
    for (let key = 1; key <= now; key++) {
      if (covered.has(key)) continue;
      if (isReady(key, now)) covered.add(key); // unanchored Godlog section
      else if (fallbackEligible(key, now)) covered.add(key); // 0.9.8 emergency raw section
    }
    return covered;
  }

  for (let now = 1; now <= turns; now++) {
    if (!permanentlyMissing.has(now)) readyAt.set(now, now + summaryDelay);
    const change = intervalChanges.get(now);
    if (change?.anchorInterval) anchorInterval = change.anchorInterval;
    if (change?.mergeInterval) mergeInterval = change.mergeInterval;
    processDerived(now);
    const coverage = promptCoverage(now);
    const missing = [];
    for (let key = 1; key <= now; key++) if (!coverage.has(key)) missing.push(key);
    if (missing.length) gaps.push({ now, missing });
    if ([3, 4, 14, 15, 16, 39, 42, 45, 74, 75, 76, turns].includes(now)) {
      snapshots.push({
        now,
        merged: merged.size,
        anchors: anchors.map(item => item.keys.length),
        rawFallbackKeys: anchors.flatMap(item => item.rawFallbackKeys),
        gaps: missing,
      });
    }
  }
  return { gaps, snapshots, anchors, mergedCount: merged.size };
}

const normal = simulateFlow({ turns: 90 });
assert.deepEqual(normal.gaps, [], 'normal 1-90 flow must have no uncovered turn');
assert.equal(normal.mergedCount, 75);

const delayed = simulateFlow({ turns: 45, summaryDelay: 4 });
assert.deepEqual(delayed.gaps, [], 'four-turn summary delay must be bridged after leaving raw window');
assert.ok(delayed.anchors.some(anchor => anchor.rawFallbackKeys.length > 0));

const permanent39 = simulateFlow({ turns: 90, permanentlyMissing: new Set([39]) });
assert.deepEqual(permanent39.gaps, [], 'one permanently missing Godlog must not create a cascading memory gap');
assert.ok(permanent39.anchors.some(anchor => anchor.rawFallbackKeys.includes(39)));
assert.equal(permanent39.mergedCount, 75, '75-turn cumulative merge must still complete');

const intervalChange = simulateFlow({
  turns: 90,
  permanentlyMissing: new Set([39]),
  intervalChanges: new Map([[39, { anchorInterval: 10 }]]),
});
assert.deepEqual(intervalChange.gaps, [], '15→10 interval edit with a missing floor must remain continuous');
assert.equal(intervalChange.mergedCount, 75);

const legacy = simulateFlow({ turns: 60, permanentlyMissing: new Set([39]), enableRawFallback: false });
assert.equal(legacy.gaps[0]?.now, 42, '0.9.7 behavior first loses floor 39 when it exits the 3-turn raw window');
assert.deepEqual(legacy.gaps[0]?.missing, [39]);

// Token-pressure check: 0.9.7 could render eleven 300-char Godlogs before the first anchor into a
// 1700-token section, forcing head/tail clipping. 0.9.8 gives every pending turn a bounded compact line.
const legacyPreAnchorText = Array.from({ length: 11 }, (_, i) => `第${i + 1}回合：${'剧情事实'.repeat(75)}`).join('\n\n');
assert.ok(estimateTextTokens(legacyPreAnchorText) > 1700);
const compactPerTurn = Math.floor(3300 / 14);
const compactPreAnchorText = Array.from({ length: 14 }, (_, i) => `第${i + 1}回合：[未明] 事件标题：${'剧情事实'.repeat(60)}`.slice(0, compactPerTurn)).join('\n\n');
assert.ok(estimateTextTokens(compactPreAnchorText) <= 3000, 'all fourteen pre-anchor turns must fit the raised recent-section ceiling');

// Core utility regression checks.
const originalKey = makeStableMessageKey({ persistentIdentity: '2026-07-11T20:00:00+08:00', role: 'assistant', index: 41 });
assert.equal(makeStableMessageKey({ storedKey: originalKey, persistentIdentity: 'changed', role: 'assistant', index: 41 }), originalKey);
const item = {
  status: 'ready', stale: false,
  body: '<Godlog><Nub>21</Nub><Title>旧摘要</Title><Time>未明</Time><Pln>未明</Pln><Per>甲</Per><Cond>已经生成并保存的摘要。</Cond></Godlog>',
  rawHash: 'source-v1', floor: 40, role: 'assistant', name: '甲', sendDate: 'old-date', updatedAt: 123,
};
const row = { index: 40, role: 'assistant', name: '甲', sendDate: 'new-date', rawHash: 'source-v2' };
assert.equal(isCompletedSummary(item), true);
assert.equal(lockCompletedSummaryToSavedSnapshot(item, row, 'host refresh', 999), true);
assert.equal(summaryRevisionHash(item, row), 'source-v1');

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

const manyItems = Array.from({ length: 5000 }, (_, index) => ({ name: `物品${index}`, boundTo: `人物${index % 30}`, meaning: `事件${index}` }));
const started = performance.now();
const ledger = buildItemLedger(manyItems);
const elapsed = performance.now() - started;
assert.equal(ledger.order.length, 5000);
assert.ok(elapsed < 1500, `5,000-item ledger build too slow: ${elapsed.toFixed(1)}ms`);

console.log(JSON.stringify({
  normal90: { gaps: normal.gaps.length, merged: normal.mergedCount },
  delayed4: { gaps: delayed.gaps.length, fallbackAnchors: delayed.anchors.filter(a => a.rawFallbackKeys.length).length },
  missing39: { gaps: permanent39.gaps.length, merged: permanent39.mergedCount, fallbackKeys: permanent39.anchors.flatMap(a => a.rawFallbackKeys) },
  interval15to10: { gaps: intervalChange.gaps.length, merged: intervalChange.mergedCount },
  legacy097: { firstGapAt: legacy.gaps[0]?.now, missing: legacy.gaps[0]?.missing },
  entityStressMs: Number(elapsed.toFixed(1)),
}, null, 2));
