import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const settingsHtml = fs.readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const readme = fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8');

assert.equal(manifest.version, '0.9.17');
assert.match(source, /const EXTENSION_VERSION = '0.9.17'/);
assert.match(source, /function archiveIsTransferReady/);
assert.match(source, /function archiveMatchesCurrentChat/);
assert.match(source, /function currentTransferCoverageCount/);
assert.match(source, /async function finalizeArchiveForTransfer/);
assert.match(source, /补齐摘要并全量合并/);
assert.match(source, /旧逐楼摘要与旧分段锚点不会带入新开场/);
assert.match(source, /loaded\.godlogs = \[\]/);
assert.match(source, /loaded\.anchors = \[\]/);
assert.match(source, /snapshot\.godlogs = \[\]/);
assert.match(source, /snapshot\.anchors = \[\]/);
assert.match(source, /if \(!archiveIsTransferReady\(archive\)\)/);
assert.match(source, /\.am-finalize-archive/);
assert.match(source, /finalizeArchiveForTransfer\(\$\(this\)\.data\('archive'\)\)/);
assert.doesNotMatch(source, /loaded\.godlogs\s*=\s*\(loaded\.godlogs/);
assert.match(settingsHtml, /保存当前快照/);
assert.match(settingsHtml, /新开场可从第1楼独立计数/);
assert.match(readme, /0\.9\.12/);

function transferReady(archive) {
  if (!archive || !archive.data) return false;
  if (archive.mode === 'full-merge') return (archive.data.merges || []).length === 1;
  return (archive.data.godlogs || []).length === 0
    && (archive.data.anchors || []).length === 0
    && (archive.data.merges || []).length === 1;
}

function transferMerge(merge, coverage) {
  const body = String(merge.body || '').replace(/^###\s*第\s*\d+\s*次全量合并锚点/m, '### 第 1 次全量合并锚点');
  return {
    ...merge,
    number: 1,
    body,
    sourceKeys: [],
    cycleSourceKeys: [],
    sourceAnchorIds: [],
    sourceGodlogIds: [],
    coverageCount: 0,
    archivedCoverageCount: coverage,
    archiveBase: true,
  };
}

function finalizeSnapshot(data, coverage) {
  const latest = data.merges.at(-1);
  assert.ok(latest, 'a final cumulative merge is required');
  return {
    ...data,
    godlogs: [],
    anchors: [],
    merges: [transferMerge(latest, coverage)],
  };
}

const rawArchive = {
  mode: 'snapshot',
  sourceStorageId: 'chat-old',
  data: {
    godlogs: Array.from({ length: 90 }, (_, index) => ({ floor: index, body: `g${index + 1}` })),
    anchors: Array.from({ length: 6 }, (_, index) => ({ number: index + 1 })),
    merges: [{ number: 1, body: '### 第 1 次全量合并锚点\n前75回合', coverageCount: 75 }],
  },
};
assert.equal(transferReady(rawArchive), false, 'raw snapshots must not be loaded into a new opening');

// Model the archive button after the remaining 15 turns have been merged into the old 75-turn base.
const afterFinalMerge = {
  ...rawArchive.data,
  merges: [
    rawArchive.data.merges[0],
    { number: 2, body: '### 第 2 次全量合并锚点\n前90回合累计历史', coverageCount: 90 },
  ],
};
const compact = finalizeSnapshot(afterFinalMerge, 90);
const readyArchive = { mode: 'full-merge', data: compact };
assert.equal(transferReady(readyArchive), true);
assert.equal(compact.godlogs.length, 0);
assert.equal(compact.anchors.length, 0);
assert.equal(compact.merges.length, 1);
assert.equal(compact.merges[0].archivedCoverageCount, 90);
assert.equal(compact.merges[0].coverageCount, 0, 'new chat merge cadence must restart independently');
assert.match(compact.merges[0].body, /^### 第 1 次全量合并锚点/);

// Loading the archive and creating the first new summary must yield exactly one floor 1 entry.
const loaded = JSON.parse(JSON.stringify(compact));
loaded.godlogs = [];
loaded.anchors = [];
loaded.godlogs.push({ floor: 0, number: 1, body: 'new opening first summary' });
assert.deepEqual(loaded.godlogs.map(item => item.floor + 1), [1]);
assert.equal(loaded.godlogs.filter(item => item.floor === 0).length, 1);

function matchesSource(archive, currentStorageId) {
  return !!archive?.sourceStorageId && archive.sourceStorageId === currentStorageId;
}
assert.equal(matchesSource(rawArchive, 'chat-old'), true);
assert.equal(matchesSource(rawArchive, 'chat-new'), false, 'missing summaries may only be repaired in the original chat');

function totalTransferCoverage(importedCoverage, currentTurns) {
  return Number(importedCoverage || 0) + Number(currentTurns || 0);
}
assert.equal(totalTransferCoverage(90, 15), 105, 'a second transfer must retain the inherited archive coverage');
assert.equal(totalTransferCoverage(0, 90), 90);

console.log('Anchor Memory 0.9.12 archive-final-merge tests passed.');
