import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));

assert.equal(manifest.version, '0.9.17');
assert.match(source, /const EXTENSION_VERSION = '0\.9\.17'/);
assert.match(source, /const DATA_VERSION = 12/);

// Timeout classification: never leak the internal abort token and classify every aborted signal.
assert.doesNotMatch(source, /controller\.abort\('secondary-timeout'\)/);
assert.doesNotMatch(source, /abort\('embedding-timeout'\)|abort\('model-list-timeout'\)/);
assert.match(source, /function isSecondaryAbort/);
assert.match(source, /AM_REQUEST_CANCELLED/);
assert.match(source, /插件已中止本次请求；已完成的数据和重建进度均保留/);
const abortStart = source.indexOf('function secondaryAbortReason');
const abortEnd = source.indexOf('\nasync function callSecondary', abortStart);
const abortContext = {};
vm.createContext(abortContext);
vm.runInContext(`${source.slice(abortStart, abortEnd)}\nthis.api={secondaryAbortReason,isSecondaryAbort};`, abortContext);
const c1 = new AbortController();
c1.abort('chat-changed');
assert.equal(abortContext.api.isSecondaryAbort(c1, 'chat-changed'), true);
assert.equal(abortContext.api.secondaryAbortReason(c1, 'ignored'), 'chat-changed');
const c2 = new AbortController();
assert.equal(abortContext.api.isSecondaryAbort(c2, { name: 'AbortError' }), true);
assert.equal(abortContext.api.isSecondaryAbort(c2, new Error('network down')), false);


// Simulate the mobile/WebKit timeout path: a raw abort reason must still become a friendly plugin timeout.
const secondaryStart = source.indexOf('function baseApiUrl');
const secondaryEnd = source.indexOf('\nasync function callWriter', secondaryStart);
const secondaryContext = {
  SECONDARY_REQUEST_TIMEOUT_MS: 120000,
  settings: () => ({ useSecondary: true, secondaryUrl: 'https://example.test/v1', secondaryKey: 'k', secondaryModel: 'm' }),
  state: {
    requests: {
      create: () => {
        const controller = new AbortController();
        return { controller, cleanup() {} };
      },
    },
  },
  setTimeout: callback => { callback(); return 1; },
  clearTimeout() {},
  fetch: async (_url, options) => { throw options.signal.reason || 'secondary-timeout'; },
  getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
};
vm.createContext(secondaryContext);
vm.runInContext(`${source.slice(secondaryStart, secondaryEnd)}\nthis.callSecondary=callSecondary;`, secondaryContext);
await assert.rejects(
  () => secondaryContext.callSecondary([{ role: 'user', content: 'x' }], 20, { timeoutMs: 15000, taskLabel: '测试任务' }),
  error => /测试任务超过15秒/.test(error.message) && !/副API请求失败：secondary-timeout/.test(error.message),
);

// Rebuilds are bounded chunks and preserve chronological coverage without a giant one-shot prompt.
const chunkStart = source.indexOf('function buildCodexRebuildChunks');
const chunkEnd = source.indexOf('\nfunction normalizeCodexRebuildCheckpoint', chunkStart);
const chunkContext = {
  CODEX_REBUILD_CHUNK_MAX_ROWS: 10,
  CODEX_REBUILD_CHUNK_MAX_CHARS: 9000,
  formatGodlogMaterials: entries => entries.map(entry => entry.godlog.body).join('\n'),
};
vm.createContext(chunkContext);
vm.runInContext(`${source.slice(chunkStart, chunkEnd)}\nthis.buildCodexRebuildChunks=buildCodexRebuildChunks;`, chunkContext);
const materials = Array.from({ length: 37 }, (_, index) => ({ row: { index, key: `k${index}` }, godlog: { body: `floor-${index}-` + 'x'.repeat(800) } }));
const chunks = chunkContext.buildCodexRebuildChunks(materials);
assert.ok(chunks.length >= 4);
assert.equal(JSON.stringify(Array.from(chunks).flatMap(chunk => Array.from(chunk).map(entry => entry.row.index))), JSON.stringify(materials.map(entry => entry.row.index)));
assert.ok(chunks.every(chunk => chunk.length <= 10));
assert.ok(chunks.every(chunk => chunk.length === 1 || chunkContext.formatGodlogMaterials(chunk).length <= 9000));

const rebuildStart = source.indexOf('async function rebuildCodexFromGodlogs');
const rebuildEnd = source.indexOf('\nasync function rebuildRelationshipFromGodlogs', rebuildStart);
const rebuildBody = source.slice(rebuildStart, rebuildEnd);
assert.match(rebuildBody, /buildCodexRebuildChunks\(materials\)/);
assert.match(rebuildBody, /codexRebuildCheckpoint/);
assert.match(rebuildBody, /cursor: index \+ 1/);
assert.match(rebuildBody, /下次从未完成分段继续/);
assert.doesNotMatch(rebuildBody, /buildRebuildTimelineSource\(/);
assert.doesNotMatch(rebuildBody, /42000/);

// Relationship rebuilds must use the same chunked transaction instead of another giant request.
const relationStart = source.indexOf('async function rebuildRelationshipFromGodlogs');
const relationEnd = source.indexOf('\nfunction scheduleCodexBacklog', relationStart);
const relationBody = source.slice(relationStart, relationEnd);
assert.match(relationBody, /return rebuildCodexFromGodlogs\(confirmFirst\)/);
assert.doesNotMatch(relationBody, /callSecondary|buildRebuildTimelineSource/);

// Automatic retry has persisted backoff and stops after three no-progress failures.
const scheduleStart = source.indexOf('function scheduleCodexBacklog');
const scheduleEnd = source.indexOf('\nfunction buildAnchorPrompt', scheduleStart);
const scheduleBody = source.slice(scheduleStart, scheduleEnd);
assert.match(scheduleBody, /if \(state\.codexTimer\) return/);
assert.match(scheduleBody, /failures >= 3/);
assert.match(scheduleBody, /codexRetryAt/);
assert.doesNotMatch(scheduleBody, /clearTimeout\(state\.codexTimer\)/);

// A historical source edit invalidates cumulative tables even after its new summary becomes ready.
const safeStart = source.indexOf('function codexSnapshotSafeForInjection');
const safeEnd = source.indexOf('\nfunction injectionCodex', safeStart);
const safeContext = {
  codexHasContent: () => true,
  rebuildGodlogTimelinePartition: data => data.partition,
};
vm.createContext(safeContext);
vm.runInContext(`${source.slice(safeStart, safeEnd)}\nthis.safe=codexSnapshotSafeForInjection;`, safeContext);
const base = {
  codex: { characterMemo: 'x' },
  processing: { codexDirty: true, codexDirtyReason: '', lastCodexFloor: 5, codexUnsafeFromFloor: null },
  partition: { blockedRows: [], materials: [{ row: { index: 9 } }] },
};
assert.equal(safeContext.safe(base), true, 'new trailing work may reuse an older safe snapshot');
assert.equal(safeContext.safe({ ...base, processing: { ...base.processing, codexUnsafeFromFloor: 3 } }), false, 'edited indexed history must be withheld');
assert.equal(safeContext.safe({ ...base, processing: { ...base.processing, codexUnsafeFromFloor: 6 } }), true, 'a floor newer than the snapshot does not contaminate it');

assert.match(source, /markCodexDirty\(data, '逐楼摘要被手动重跑', true, false, Number\(latestRow\.index\)\)/);
assert.match(source, /markCodexDirty\(found\.data, '逐楼摘要被手动修改', true, false, Number\(row\?\.index \?\? found\.item\.floor \?\? -1\)\)/);
assert.match(source, /旧版人物索引整段重建超过120秒并被插件中止/);
const compactStart = source.indexOf('function compactArchiveSnapshot');
const compactEnd = source.indexOf('\nfunction saveArchive', compactStart);
const compactBody = source.slice(compactStart, compactEnd);
assert.match(compactBody, /codexRetryAt: 0/);
assert.match(compactBody, /codexRebuildCheckpoint: null/);
assert.match(compactBody, /codexUnsafeFromFloor: null/);
assert.match(source, /codexUnsafeFromFloor = null/);

console.log('Anchor Memory timeout, staged rebuild, retry and safe-snapshot tests passed.');
