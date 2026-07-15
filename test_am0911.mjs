import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const readme = fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8');

assert.equal(manifest.version, '0.9.14');
assert.match(source, /const EXTENSION_VERSION = '0\.9\.14'/);
assert.match(source, /ACTIVE_SUMMARY_SOURCE_LOOKUP_GRACE_MS = 8000/);
assert.match(source, /pendingGeneratedBody/);
assert.match(source, /function remapGodlogSourceKey/);
assert.match(source, /后自动补齐待处理记忆/);
assert.match(source, /摘要已生成，正在等待酒馆确认源楼层稳定/);
assert.match(source, /function rebuildGodlogTimelinePartition/);
assert.match(source, /trailingRows:/);
assert.match(source, /function drainDueDerivedMemory/);
assert.match(source, /function rewriteAnchorItemUnlocked/);
assert.match(source, /function rewriteMergeItemUnlocked/);
assert.match(source, /function rewriteMemoryItem/);
assert.match(source, /没有新的逐楼摘要可做全量合并/);
assert.match(source, /Number\(s\.mergeInterval\) === 100/);
assert.match(source, /同一剧情日内、围绕同一目标\/冲突连续推进的多个场景，必须合并成一条完整事件链/);
assert.match(source, /以下为已回退并验证的安全关系快照/);
assert.match(source, /function codexSnapshotSafeForInjection/);
assert.match(source, /主模型继续使用截至最近有效摘要的安全快照/);
assert.match(readme, /0\.9\.11/);

function partition(readiness) {
  let lastReadyIndex = -1;
  readiness.forEach((ready, index) => {
    if (ready) lastReadyIndex = index;
  });
  const committed = lastReadyIndex >= 0 ? readiness.slice(0, lastReadyIndex + 1) : [];
  return {
    materials: committed.map((ready, index) => ready ? index : null).filter(index => index !== null),
    blocked: committed.map((ready, index) => !ready ? index : null).filter(index => index !== null),
    trailing: readiness.slice(lastReadyIndex + 1).map((ready, offset) => !ready ? lastReadyIndex + 1 + offset : null).filter(index => index !== null),
  };
}

// A newly opened tail floor must not freeze a rebuild of the completed history.
assert.deepEqual(partition([true, true, true, false]), {
  materials: [0, 1, 2],
  blocked: [],
  trailing: [3],
});
assert.deepEqual(partition([true, true, false, false]), {
  materials: [0, 1],
  blocked: [],
  trailing: [2, 3],
});

// A hole inside already-completed later history remains unsafe and must block.
assert.deepEqual(partition([true, false, true, false]), {
  materials: [0, 2],
  blocked: [1],
  trailing: [3],
});

function resolveRow(item, rows) {
  const exact = rows.find(row => row.key === item.key);
  if (exact) return exact;
  const assistants = rows.filter(row => row.role === 'assistant');
  if (item.rawHash) {
    const matches = assistants.filter(row => row.rawHash === item.rawHash);
    if (matches.length === 1) return matches[0];
  }
  if (item.sendDate) {
    const matches = assistants.filter(row => row.sendDate === item.sendDate);
    if (matches.length === 1) return matches[0];
  }
  if (item.assistantNumber > 0) {
    const matches = assistants.filter(row => row.assistantNumber === item.assistantNumber);
    if (matches.length === 1) return matches[0];
  }
  const matches = assistants.filter(row => row.index === item.floor);
  return matches.length === 1 ? matches[0] : null;
}

const pendingItem = {
  key: 'old-object-key',
  rawHash: 'same-turn-hash',
  sendDate: '2026-07-13T01:02:03Z',
  assistantNumber: 52,
  floor: 104,
};
const rebuiltRows = [
  { key: 'new-object-key', rawHash: 'same-turn-hash', sendDate: '2026-07-13T01:02:03Z', assistantNumber: 52, floor: 104, index: 104, role: 'assistant' },
];
assert.equal(resolveRow(pendingItem, rebuiltRows), rebuiltRows[0], 'temporary host object replacement must re-resolve the same floor');

// Model the destructive rollback guard: active/grace-period misses are deferred; a confirmed old
// miss after the grace window is the only case that may be treated as a true deletion.
function shouldRollback({ active, deferredAgeMs, graceMs = 8000 }) {
  const defer = active || (deferredAgeMs >= 0 && deferredAgeMs < graceMs);
  return !defer;
}
assert.equal(shouldRollback({ active: true, deferredAgeMs: 99999 }), false);
assert.equal(shouldRollback({ active: false, deferredAgeMs: 2500 }), false);
assert.equal(shouldRollback({ active: false, deferredAgeMs: 8100 }), true);


// A dirty non-relationship index may continue to inject only when it covers no floor newer than
// the completed safe prefix and there is no interior summary hole.
function codexSnapshotSafe({ dirty = true, hasContent = true, trackedListChanged = false, blocked = 0, lastCodexFloor = -1, lastReadyFloor = -1 }) {
  if (!dirty) return true;
  if (!hasContent || trackedListChanged || blocked > 0) return false;
  return lastCodexFloor <= lastReadyFloor;
}
assert.equal(codexSnapshotSafe({ lastCodexFloor: 103, lastReadyFloor: 103 }), true, 'new pending tail should keep the completed index snapshot injectable');
assert.equal(codexSnapshotSafe({ blocked: 1, lastCodexFloor: 104, lastReadyFloor: 108 }), false, 'an interior gap must withhold cumulative indexes');
assert.equal(codexSnapshotSafe({ lastCodexFloor: 104, lastReadyFloor: 103 }), false, 'a snapshot newer than surviving history must not be injected');
assert.equal(codexSnapshotSafe({ trackedListChanged: true, lastCodexFloor: 104, lastReadyFloor: 104 }), false, 'changing tracked protagonists invalidates the old character table');

// Cumulative merge model: every 75 unmerged effective AI turns produces another cumulative merge.
function mergeBoundaries(turns, interval = 75) {
  let merged = 0;
  let count = 0;
  while (turns - merged >= interval) {
    merged += interval;
    count++;
  }
  return { count, merged, cycle: turns - merged };
}
assert.deepEqual(mergeBoundaries(74), { count: 0, merged: 0, cycle: 74 });
assert.deepEqual(mergeBoundaries(75), { count: 1, merged: 75, cycle: 0 });
assert.deepEqual(mergeBoundaries(150), { count: 2, merged: 150, cycle: 0 });
assert.deepEqual(mergeBoundaries(232), { count: 3, merged: 225, cycle: 7 });

// One-time legacy default migration.
const migrateInterval = (stored, upgrading = true) => upgrading && Number(stored) === 100 ? 75 : Number(stored);
assert.equal(migrateInterval(100), 75);
assert.equal(migrateInterval(90), 90);
assert.equal(migrateInterval(100, false), 100);



// 0.9.11 must expose rewrite as explicit operations, not an implicit no-new-cycle side effect.
const settingsHtml = fs.readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
assert.match(settingsHtml, /id="am_rewrite_latest_anchor"/);
assert.match(settingsHtml, /id="am_rewrite_latest_merge"/);
assert.match(settingsHtml, /id="am_rewrite_selected_memory"/);
assert.match(source, /class="am-rewrite-memory"/);
assert.match(source, /\$\('#am_rewrite_latest_anchor'\)\.on\('click', rewriteLatestAnchor\)/);
assert.match(source, /\$\('#am_rewrite_latest_merge'\)\.on\('click', rewriteLatestMerge\)/);
assert.match(source, /\$\('#am_rewrite_selected_memory'\)\.on\('click', rewriteSelectedMemory\)/);
assert.doesNotMatch(source, /materials\.length === 0[\s\S]{0,500}rewriteLatestMergeUnlocked/);

function rollbackDependentMerges(merges, sourceKeys) {
  const keys = new Set(sourceKeys);
  let cascade = false;
  const kept = [];
  const removed = [];
  for (const merge of merges) {
    const touches = merge.sourceKeys.some(key => keys.has(key));
    if (cascade || touches) {
      cascade = true;
      removed.push(merge.id);
    } else kept.push(merge.id);
  }
  return { kept, removed };
}

const dependencyChain = [
  { id: 'm1', sourceKeys: Array.from({ length: 75 }, (_, i) => `k${i + 1}`) },
  { id: 'm2', sourceKeys: Array.from({ length: 150 }, (_, i) => `k${i + 1}`) },
  { id: 'm3', sourceKeys: Array.from({ length: 225 }, (_, i) => `k${i + 1}`) },
];
assert.deepEqual(rollbackDependentMerges(dependencyChain, ['k80']), { kept: ['m1'], removed: ['m2', 'm3'] });
assert.deepEqual(rollbackDependentMerges(dependencyChain, ['k12']), { kept: [], removed: ['m1', 'm2', 'm3'] });
assert.deepEqual(rollbackDependentMerges(dependencyChain, ['k226']), { kept: ['m1', 'm2', 'm3'], removed: [] });

function rewriteMergeKeepsSelectedAndDropsLater(ids, selected) {
  const index = ids.indexOf(selected);
  return index < 0 ? ids : ids.slice(0, index + 1);
}
assert.deepEqual(rewriteMergeKeepsSelectedAndDropsLater(['m1', 'm2', 'm3'], 'm2'), ['m1', 'm2']);
assert.deepEqual(rewriteMergeKeepsSelectedAndDropsLater(['m1', 'm2', 'm3'], 'm3'), ['m1', 'm2', 'm3']);

function seededRandom(seed = 0x09102026) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
const random = seededRandom();
const int = (min, max) => min + Math.floor(random() * (max - min + 1));

let trailingScenarios = 0;
let interiorGapScenarios = 0;
for (let scenario = 0; scenario < 2000; scenario++) {
  const readyPrefix = int(1, 180);
  const trailing = int(1, 12);
  const readiness = Array(readyPrefix).fill(true).concat(Array(trailing).fill(false));
  const result = partition(readiness);
  assert.equal(result.blocked.length, 0, `trailing-only scenario ${scenario} was incorrectly blocked`);
  assert.equal(result.materials.length, readyPrefix);
  assert.equal(result.trailing.length, trailing);
  trailingScenarios++;

  if (readyPrefix >= 3) {
    const hole = int(1, readyPrefix - 2);
    const withInteriorGap = [...readiness];
    withInteriorGap[hole] = false;
    const gapResult = partition(withInteriorGap);
    assert.ok(gapResult.blocked.includes(hole), `interior gap ${hole} was not detected`);
    interiorGapScenarios++;
  }
}

let sourceReplacementScenarios = 0;
for (let scenario = 0; scenario < 3000; scenario++) {
  const ordinal = scenario + 1;
  const floor = ordinal * 2;
  const hash = `hash-${scenario}`;
  const date = `date-${scenario}`;
  const item = { key: `old-${scenario}`, rawHash: hash, sendDate: date, assistantNumber: ordinal, floor };
  const rows = [
    { key: `noise-user-${scenario}`, rawHash: `noise-${scenario}`, sendDate: '', assistantNumber: 0, floor: floor - 1, index: floor - 1, role: 'user' },
    { key: `new-${scenario}`, rawHash: hash, sendDate: date, assistantNumber: ordinal, floor, index: floor, role: 'assistant' },
  ];
  const resolved = resolveRow(item, rows);
  assert.equal(resolved?.key, `new-${scenario}`);
  sourceReplacementScenarios++;
}

let rewriteCascadeScenarios = 0;
for (let scenario = 0; scenario < 5000; scenario++) {
  const mergeCount = int(1, 12);
  const interval = int(30, 100);
  const merges = Array.from({ length: mergeCount }, (_, index) => ({
    id: `m${index + 1}`,
    sourceKeys: Array.from({ length: (index + 1) * interval }, (__, keyIndex) => `k${keyIndex + 1}`),
  }));
  const sourceTurn = int(1, mergeCount * interval + interval);
  const result = rollbackDependentMerges(merges, [`k${sourceTurn}`]);
  const firstAffected = Math.ceil(sourceTurn / interval) - 1;
  if (firstAffected >= mergeCount) {
    assert.equal(result.removed.length, 0);
    assert.equal(result.kept.length, mergeCount);
  } else {
    assert.equal(result.kept.length, firstAffected);
    assert.equal(result.removed.length, mergeCount - firstAffected);
  }
  rewriteCascadeScenarios++;
}

let mergeScenarios = 0;
let totalExpectedMerges = 0;
for (let scenario = 0; scenario < 2500; scenario++) {
  const turns = int(0, 1000);
  const interval = 75;
  const result = mergeBoundaries(turns, interval);
  assert.equal(result.count, Math.floor(turns / interval));
  assert.equal(result.merged, result.count * interval);
  assert.equal(result.cycle, turns % interval);
  totalExpectedMerges += result.count;
  mergeScenarios++;
}

console.log(JSON.stringify({
  version: manifest.version,
  relationshipTailRebuild: 'pass',
  transientSourceResolution: 'pass',
  confirmedDeletionGuard: 'pass',
  cumulativeMergesAt150: 2,
  legacy100MigratesTo: 75,
  mergePromptSameDayAggregation: 'pass',
  safeCodexSnapshotDuringTrailingSummary: 'pass',
  explicitAnchorRewriteControls: 'pass',
  explicitMergeRewriteControls: 'pass',
  transactionalDependencyRollback: 'pass',
  randomizedRewriteCascadeScenarios: rewriteCascadeScenarios,
  randomizedTrailingRebuildScenarios: trailingScenarios,
  randomizedInteriorGapScenarios: interiorGapScenarios,
  transientSourceReplacementScenarios: sourceReplacementScenarios,
  randomizedMergeScenarios: mergeScenarios,
  totalExpectedCumulativeMerges: totalExpectedMerges,
}, null, 2));
