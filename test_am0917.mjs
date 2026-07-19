import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const settingsHtml = fs.readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
const style = fs.readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));

assert.equal(manifest.version, '0.9.17');
assert.match(source, /const EXTENSION_VERSION = '0\.9\.17'/);
assert.match(source, /secondaryPresets: \[\]/);
assert.match(source, /activeSecondaryPresetId: ''/);
assert.match(source, /function loadSecondaryPreset/);
assert.match(source, /function saveSecondaryPreset/);
assert.match(source, /function deleteSecondaryPreset/);
assert.match(source, /secondaryConfigRevision: 0/);
assert.match(source, /function bumpSecondaryConfigRevision/);
assert.match(source, /ignored stale secondary model list after connection changed/);
assert.match(source, /requestRevision !== Number\(state\.secondaryConfigRevision/);
assert.match(source, /\['secondaryKey', 'embeddingKey', 'secondaryPresets', 'activeSecondaryPresetId', 'slots'\]/);

for (const id of [
  'am_secondary_preset_select',
  'am_secondary_preset_name',
  'am_save_secondary_preset',
  'am_update_secondary_preset',
  'am_delete_secondary_preset',
  'am_secondary_preset_status',
]) {
  assert.match(settingsHtml, new RegExp(`id="${id}"`));
}
assert.match(settingsHtml, /导出配置.*不会导出密钥或这些预设/);
assert.match(style, /\.am-preset-status\.am-preset-dirty/);
assert.match(style, /\.am-preset-actions/);

const start = source.indexOf('function normalizeSecondaryPresetName');
const end = source.indexOf('\nfunction updateSecondaryPresetStatus', start);
assert.ok(start >= 0 && end > start);
const context = {
  crypto: { randomUUID: () => 'uuid-test' },
};
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}\nthis.api={normalizeSecondaryPresetName,normalizeSecondaryPresetRecord,normalizeSecondaryPresetList,secondaryPresetSnapshot,secondaryPresetConfigEquals};`, context);
const api = context.api;

assert.equal(api.normalizeSecondaryPresetName('  Open\n Router  '), 'Open Router');
const normalized = api.normalizeSecondaryPresetRecord({
  name: ' Main ',
  url: ' https://api.example.com/v1 ',
  key: 'secret',
  model: ' model-a ',
  models: ['model-a', 'model-a', '', ' model-b '],
  createdAt: 10,
  updatedAt: 20,
});
assert.equal(normalized.name, 'Main');
assert.equal(normalized.url, 'https://api.example.com/v1');
assert.equal(normalized.model, 'model-a');
assert.deepEqual(Array.from(normalized.models), ['model-a', 'model-b']);

const list = api.normalizeSecondaryPresetList([
  { id: 'a', name: 'Main', url: 'u1', key: 'k1', model: 'm1', models: ['m1'] },
  { id: 'b', name: 'main', url: 'u2', key: 'k2', model: 'm2', models: ['m2'] },
  { id: 'c', name: 'Backup', url: 'u3', key: 'k3', model: 'm3', models: ['m3'] },
  { id: 'd', name: '', url: 'u4', key: 'k4' },
]);
assert.equal(list.length, 2);
assert.equal(list[0].name, 'Main');
assert.equal(list[1].name, 'Backup');

const snapshot = api.secondaryPresetSnapshot({
  secondaryUrl: ' u ', secondaryKey: 'k', secondaryModel: ' m ', secondaryModels: ['m', 'm', 'x'],
});
assert.equal(snapshot.url, 'u');
assert.equal(snapshot.model, 'm');
assert.deepEqual(Array.from(snapshot.models), ['m', 'x']);
assert.equal(api.secondaryPresetConfigEquals({ ...snapshot }, {
  secondaryUrl: 'u', secondaryKey: 'k', secondaryModel: 'm', secondaryModels: ['m', 'x'],
}), true);

console.log('Anchor Memory 0.9.17 secondary API preset tests passed.');

// Async race regression: a model list started under an old URL/key must not overwrite a preset
// selected before that request finishes.
const fetchStart = source.indexOf('async function fetchSecondaryModels()');
const fetchEnd = source.indexOf('\nasync function fetchEmbeddingModels()', fetchStart);
assert.ok(fetchStart >= 0 && fetchEnd > fetchStart);
let resolveModels;
const raceSettings = {
  secondaryUrl: 'https://old.example/v1', secondaryKey: 'old-key', secondaryModel: 'old-model', secondaryModels: ['old-model'],
};
const raceDom = new Map([
  ['#am_secondary_url', 'https://old.example/v1'],
  ['#am_secondary_key', 'old-key'],
  ['#am_secondary_model', 'old-model'],
]);
const raceContext = {
  console,
  state: { secondaryConfigRevision: 0 },
  syncSecondaryInputsFromUi: () => {
    raceSettings.secondaryModel = '';
    raceSettings.secondaryModels = [];
    raceDom.set('#am_secondary_model', '');
    raceContext.state.secondaryConfigRevision += 1;
    return raceSettings;
  },
  fetchProviderModels: () => new Promise(resolve => { resolveModels = resolve; }),
  selectFetchedModel: (_current, models) => models[0] || '',
  bumpSecondaryConfigRevision: () => ++raceContext.state.secondaryConfigRevision,
  saveSettingsDebounced: () => {},
  renderModelOptions: () => {},
  updateSecondaryPresetStatus: () => {},
  secondaryConfigured: () => true,
  queueMemoryJob: () => { raceContext.queued = true; },
  setButtonBusy: () => {},
  showStatus: () => {},
  updatePreview: () => {},
  toastr: { warning: () => {}, success: () => { raceContext.success = true; }, error: () => { raceContext.error = true; } },
  $: selector => ({ val(value) { if (arguments.length) { raceDom.set(selector, value); return this; } return raceDom.get(selector); } }),
};
vm.createContext(raceContext);
vm.runInContext(`${source.slice(fetchStart, fetchEnd)}\nthis.fetchSecondaryModels=fetchSecondaryModels;`, raceContext);
const pendingRace = raceContext.fetchSecondaryModels();
await new Promise(resolve => setTimeout(resolve, 0));
raceSettings.secondaryUrl = 'https://new.example/v1';
raceSettings.secondaryKey = 'new-key';
raceSettings.secondaryModel = 'new-model';
raceSettings.secondaryModels = ['new-model'];
raceDom.set('#am_secondary_model', 'new-model');
raceContext.state.secondaryConfigRevision += 1;
resolveModels(['old-returned-model']);
await pendingRace;
assert.equal(raceSettings.secondaryModel, 'new-model');
assert.deepEqual(raceSettings.secondaryModels, ['new-model']);
assert.equal(raceContext.success, undefined);
assert.equal(raceContext.error, undefined);

console.log('Anchor Memory 0.9.17 stale model-list race test passed.');
