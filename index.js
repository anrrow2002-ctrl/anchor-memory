/**
 * Anchor Memory
 * Layered anchor summaries for long-form SillyTavern RP.
 *
 * Original implementation:
 * - chat metadata stores anchors, merges, and current codex sections;
 * - extension prompts inject memory without writing world-info entries;
 * - optional secondary API and embeddings are supported.
 */

import {
  createAbortRegistry,
  estimateTextTokens,
  clampTextByTokens,
  resolveAdaptiveMemoryBudget,
  fitMemorySections,
} from './core/runtime-controls.js';
import { rebuildTimelineState } from './core/time-engine.js';
import {
  entityKey,
  buildItemLedger,
  buildSceneLedger,
  diffRemovedEntityKeys,
} from './core/entity-ledger.js';
import {
  makeStableMessageKey,
  isCompletedSummary,
  summaryRevisionHash,
  lockCompletedSummaryToSavedSnapshot,
} from './core/summary-lifecycle.js';

/**
 * SillyTavern compatibility layer.
 *
 * IMPORTANT: Do not statically import named exports from SillyTavern internals here.
 * ST moves exports between releases; one missing named export prevents the entire
 * ES module from evaluating, which makes both the icon and panel disappear.
 * The official global context API is preferred, with dynamic legacy imports only
 * as a fallback for older builds.
 */
let $ = globalThis.jQuery || globalThis.$;
const toastr = globalThis.toastr;

const extension_prompt_types = Object.freeze({ NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 });
const extension_prompt_roles = Object.freeze({ SYSTEM: 0, USER: 1, ASSISTANT: 2 });

let legacyScriptModule = {};
let legacyExtensionsModule = {};
let legacyGroupModule = {};
let eventSource = null;
let event_types = {};
let fallbackExtensionSettings = {};
let warnedMissingPromptApi = false;

async function loadLegacyRuntimeFallbacks() {
  // Namespace imports never fail merely because one named export moved/vanished.
  // They are only needed on old ST builds that do not expose SillyTavern.getContext().
  if (globalThis.SillyTavern?.getContext) return;
  try { legacyScriptModule = await import('../../../../script.js'); } catch (err) {
    console.warn('[AnchorMemory] legacy script.js fallback unavailable', err);
  }
  try { legacyExtensionsModule = await import('../../../extensions.js'); } catch (err) {
    console.warn('[AnchorMemory] legacy extensions.js fallback unavailable', err);
  }
  try { legacyGroupModule = await import('../../../group-chats.js'); } catch (err) {
    console.warn('[AnchorMemory] legacy group-chats.js fallback unavailable', err);
  }
}

function getContext() {
  try {
    const ctx = globalThis.SillyTavern?.getContext?.();
    if (ctx && typeof ctx === 'object') return ctx;
  } catch (err) {
    console.warn('[AnchorMemory] SillyTavern.getContext failed', err);
  }
  try {
    const ctx = legacyExtensionsModule.getContext?.();
    if (ctx && typeof ctx === 'object') return ctx;
  } catch (err) {
    console.warn('[AnchorMemory] legacy getContext failed', err);
  }
  return {};
}

function refreshRuntimeBindings() {
  const ctx = getContext();
  eventSource = ctx.eventSource || legacyScriptModule.eventSource || eventSource;
  event_types = ctx.eventTypes || ctx.event_types || legacyScriptModule.event_types || event_types || {};
}

function extensionSettingsStore() {
  const ctx = getContext();
  const store = ctx.extensionSettings || legacyExtensionsModule.extension_settings;
  if (store && typeof store === 'object') return store;
  return fallbackExtensionSettings;
}

function getRequestHeaders(...args) {
  return getContext().getRequestHeaders?.(...args)
    ?? legacyScriptModule.getRequestHeaders?.(...args)
    ?? { 'Content-Type': 'application/json' };
}

function saveSettingsDebounced(...args) {
  return getContext().saveSettingsDebounced?.(...args)
    ?? legacyScriptModule.saveSettingsDebounced?.(...args);
}

function setExtensionPrompt(...args) {
  const fn = getContext().setExtensionPrompt || legacyScriptModule.setExtensionPrompt;
  if (typeof fn === 'function') return fn(...args);
  if (!warnedMissingPromptApi) {
    warnedMissingPromptApi = true;
    console.error('[AnchorMemory] setExtensionPrompt is unavailable; memory injection is disabled until ST finishes initializing.');
  }
  return undefined;
}

function updateMessageBlock(...args) {
  return getContext().updateMessageBlock?.(...args)
    ?? legacyScriptModule.updateMessageBlock?.(...args);
}

function saveMetadataDebounced(...args) {
  return getContext().saveMetadataDebounced?.(...args)
    ?? legacyExtensionsModule.saveMetadataDebounced?.(...args);
}
saveMetadataDebounced.flush = async () => {
  const ctx = getContext();
  if (typeof ctx.saveMetadata === 'function') return await ctx.saveMetadata();
  const legacy = legacyExtensionsModule.saveMetadataDebounced;
  if (typeof legacy?.flush === 'function') return await legacy.flush();
  return undefined;
};

function isGenerationActive() {
  const ctx = getContext();
  if (typeof ctx.isGenerating === 'function') return !!ctx.isGenerating();
  if (typeof legacyScriptModule.isGenerating === 'function') return !!legacyScriptModule.isGenerating();
  return !!legacyScriptModule.is_send_press;
}


const MODULE = 'anchor_memory';
const EXTENSION_VERSION = '0.9.5';
const DATA_KEY = 'anchorMemory';
const CORE_PROMPT_KEY = 'anchor_memory_core';
const RECALL_PROMPT_KEY = 'anchor_memory_recall';
const DATA_VERSION = 11;
const RELATIONSHIP_SCHEMA_VERSION = 2;
const RELATIONSHIP_CHECKPOINT_INTERVAL = 10;
const VECTOR_DB_NAME = 'anchor-memory-vectors';
const VECTOR_DB_VERSION = 1;
const VECTOR_STORE_NAME = 'vectors';
const MESSAGE_RENDER_MARGIN_PX = 1400;
const MESSAGE_RENDER_RECENT_COUNT = 16;
const SOURCE_HASH_SCHEMA_VERSION = 4;
const GODLOG_BLOCK_RE = /\s*(?:```[a-zA-Z0-9_-]*\s*)?<Godlog>[\s\S]*?<\/Godlog>(?:\s*```)?\s*/gi;
const GODLOG_ESCAPED_BLOCK_RE = /\s*&lt;Godlog&gt;[\s\S]*?&lt;\/Godlog&gt;\s*/gi;
const GODLOG_FIELD_XML_GROUP_RE = /\s*(?:(?:<|&lt;)(?:Nub|Title|Time|Pln|Per|Cond)(?:>|&gt;)[\s\S]*?(?:<|&lt;)\/(?:Nub|Title|Time|Pln|Per|Cond)(?:>|&gt;)\s*){3,}/gi;
const FENCED_CODE_BLOCK_RE = /\s*```[a-zA-Z0-9_-]*\s*[\s\S]*?```\s*/g;
const GODLOG_FIELD_NAMES = ['Nub', 'Title', 'Time', 'Pln', 'Per', 'Cond'];
const MISSING_GODLOG_WARNING_MIN_NEWER = 2;
const MISSING_GODLOG_WARNING_COOLDOWN = 90 * 1000;
// The newest assistant floor may be rendered several times while text, inline images, or
// extension-generated content is still being appended. Never summarize it until its source
// fingerprint has remained unchanged for this long.
const GODLOG_SOURCE_SETTLE_MS = 1800;
const GODLOG_POST_GENERATION_SETTLE_MS = 900;
const STREAM_TAIL_PROBE_MS = 240;
const PANEL_RENDER_DEBOUNCE_MS = 120;
const RELATIONSHIP_MEMORY_CHAR_BUDGET = 3600;
const ANCHOR_EVENT_MEMORY_CHAR_BUDGET = 11000;
const RECENT_FACTS_MEMORY_CHAR_BUDGET = 4800;
const DYNAMIC_RECALL_MEMORY_CHAR_BUDGET = 3200;

const DEFAULT_GODLOG_RULES = `你是长篇角色扮演的逐回合记忆记录员。你只总结“当前回合”：通常由紧邻的用户输入与随后的 AI 回复组成；若当前是首条 AI 开场楼，则只总结该 AI 回复。Godlog 仅供插件后台使用，禁止写入可见聊天正文，禁止使用 Markdown 代码块。

内容规则：
- 只记录当前回合新增、已经发生且能由原文确认的剧情事实。角色卡、世界书和上文摘要只用于确认姓名、身份、关系与语境，禁止把其中旧事件重新写进本楼。
- 全部使用第三人称。人物尽量写姓名或明确称谓，不使用“我、你、我们”等对话视角代词；性别不确定时用姓名，禁止猜测“他/她”。
- 按真实发生顺序梳理：起因或承接背景 → 具体动作与互动 → 冲突或转折 → 本回合结果及影响。不得打乱因果，不得只写氛围或空泛评价。
- 关键对话保留 1—3 句最能推动剧情、改变关系或揭示信息的原话，并明确注明说话人。没有关键对话时不要虚构。
- 心理变化只记录原文明示的内心活动，或能由明确动作、语气直接支持的转折；不得替角色补写动机、感情或未来决定。
- 回忆、梦境、假设、计划、转述、传闻必须明确标注其性质，不得当作当前现实中已经发生的事件。
- Time 必须填写剧情内时间。原文明示时严格沿用；可从紧邻上下文确定时可合理承接；否则写“未明”。禁止使用现实日期代替剧情时间。
- Pln 填写本回合主要发生地点；发生明确转场时按先后写“地点A → 地点B”；无法判断写“未明”。
- Per 只列本回合实际出现或被明确提及的人物姓名/称谓，去重后用中文逗号分隔；不要写人物介绍、关系说明或代词。
- Title 用 8—18 个汉字概括本回合最核心事件，不使用“本楼摘要、剧情推进、日常互动”等空标题。
- Cond 写 200—350 个汉字的高密度叙事摘要。必须让未在场的读者仅凭此段就能理解本回合发生了什么，同时禁止扩写、润色原文之外的细节、预测后续或评价角色。

输出必须严格为一个完整 XML 块。六个字段缺一不可，不要添加任何前言、解释、尾注、HTML 或代码块：
<Godlog>
<Nub>照抄任务中提供的轮次序号</Nub>
<Title>8—18字小标题</Title>
<Time>剧情内时间；无法判断写“未明”</Time>
<Pln>主要地点；转场用“地点A → 地点B”；无法判断写“未明”</Pln>
<Per>本回合出现或被明确提及的人物姓名/称谓，去重后用中文逗号分隔</Per>
<Cond>200—350字高密度叙事摘要</Cond>
</Godlog>`;

const DEFAULT_ANCHOR_RULES = `锚点规则：
- 本锚点只总结本批新增的逐楼摘要，不复述旧锚点，不附加人物表、物品表或场景表。
- 全部使用第三人称，只写已经发生的剧情，不预测、不评价。
- 每个事件必须保留：剧情内时间、地点、起因、人物、详细过程、重要物品、结果/影响。
- 关键原话必须保留，并明确注明“谁说了什么”。不得只写“双方交谈”“表达态度”等模糊概括。
- 不得遗漏用户未参与但已经发生的重要 NPC 事件、伏笔和关键道具。
- 时间无法判断写“未明”；禁止套用现实日期。
- 输出不得包含 HTML、代码块、人物动态表、人物库、物品表或任何额外章节。`;

const DEFAULT_CHARACTER_RULES = `人物动态演变规则：
- 只追踪以下白名单主角：{{tracked_chars}}。禁止把{{user}}写入人物纪要；{{user}}只能出现在关系描述或出场人物交集中。
- 单角色卡自动追踪当前{{char}}；群聊自动追踪当前群组成员；单卡多主角以“追踪角色名单”设置为准。
- 全部使用第三人称、全知视角；不确定性别时用角色姓名，禁止乱写“他/她”。
- 只记录已经发生的心理位移，不写预测、概率或作者点评。
- 角色卡、世界书和既有索引中的稳定身份不能被单楼情节覆盖；单楼只更新临时状态、触发事件和真实心理变化。
- 推荐结构：初始底色 / 触发冲击 / 心理挣扎 / 当前变化 / 一句话摘要。
- 只有执念、底线、信念、行为模式、关系处理方式发生真实变化时才更新；没有变化就照抄上一版。`;

const DEFAULT_PEOPLE_RULES = `出场人物数据库规则：
- 记录除追踪白名单{{tracked_chars}}以外的重要出场人物、NPC、配角，以及他们与{{tracked_chars}}、{{user}}和彼此之间的关系。
- 按首次出场或剧情重要性整理，不凭空添加未出现人物。
- 性别、人称、身份必须来自原文、角色卡或明确上下文；不确定时写“未明”，禁止瞎判。
- “首次出场/来源”只表示本索引第一次记录到该人物，不等于剧情内初次见面；除非原文明说，禁止写“初次见面/刚认识”。
- 稳定身份和既有关系优先跟随角色卡、世界书和已有索引；当前楼只补充本楼互动、状态或冲突，不能把已知身份改成“未明”。
- 固定字段：角色名 / 身份标签 / 当前状态与核心作用 / 与{{user}}的关系 / 与{{tracked_chars}}的关系。`;

const DEFAULT_ITEM_RULES = `物品、细节与内部梗规则：
- 记录会影响剧情、关系、伏笔、象征意义或反复出现的物品、细节、内部梗和关键原话。
- 普通日用品只有在改变关系、推动剧情或成为伏笔时才记录。
- 固定字段：物品/细节/内部梗 | 绑定人物 | 核心象征意义与影响。
- 输出的是完整当前表：已有条目本楼未提及时必须保留；只有原文明示其被销毁、永久失效且不再承担伏笔时才删除。
- 同一物品的简称、全称或轻微写法变化必须合并为同一行，禁止重复建项。
- 不写未发生的用途，不替模型预测未来。`;

const GODLOG_FORMAT_HELP = `<Godlog>
<Nub>照抄任务中提供的轮次序号</Nub>
<Title>8—18字小标题</Title>
<Time>剧情内时间；无法判断写“未明”</Time>
<Pln>主要地点；转场用“地点A → 地点B”；无法判断写“未明”</Pln>
<Per>本回合出现或被明确提及的人物姓名/称谓，去重后用中文逗号分隔</Per>
<Cond>200—350字高密度叙事摘要；按因果与时间顺序写清动作、转折、结果和关键原话，不得脑补</Cond>
</Godlog>`;

const DEFAULT_MERGE_RULES = `全量合并规则：
- 将上一次历史锚点与本周期全部新增记忆合并为一份新的累计历史锚点。
- 只输出“历史锚点简述”，按剧情时间顺序分条。
- 不得把跨度超过一个月的事件合并为单条；跨月必须拆分。
- 每条须保留完整因果链：起因 -> 核心冲突 -> 结果/影响。
- 关键转折、重要对话原话、道具与伏笔不得删除；关键对话必须注明说话人。
- 允许删除场景氛围描写、重复性日常互动、与主线无关的过渡内容。
- 全部使用第三人称，只写已经发生的剧情，不预测、不评价。
- 输出不得包含人物动态表、人物库、物品表、场景表、HTML 或代码块。`;

const ANCHOR_FORMAT_HELP = `### 第 X 次锚点记录

**本次新增锚点：**
* **[时间] - [事件名称]：** 地点；起因；人物；详细过程；重要物品；结果/影响；核心对话原话（必须注明谁说了什么）。`;

const MERGE_FORMAT_HELP = `### 第 X 次全量合并锚点

**历史锚点简述**
* **[时间段] - [事件名称]：** 起因 -> 核心冲突 -> 结果/影响。关键对话原话保留并注明说话人。`;

const DEFAULT_SETTINGS = {
  settingsVersion: EXTENSION_VERSION,
  enabled: true,
  anchorInterval: 15,
  mergeInterval: 100,
  keepRecent: 3,
  injectionDepth: 4,
  autoHide: true,
  useSecondary: false,
  secondaryUrl: '',
  secondaryKey: '',
  secondaryModel: '',
  secondaryModels: [],
  // Main-model memory is deterministic by default: cumulative merge + active 15-turn anchors + subsequent per-turn summaries.
  // Dynamic recall and state tables remain optional because they can duplicate or resurrect stale facts.
  useDynamicRecall: false,
  // Tracks whether the user explicitly changed this switch. 0.9.2 resets legacy implicit defaults to strict layering once.
  dynamicRecallExplicit: false,
  // Mentioned people are injected selectively; important items are a small current-state ledger.
  recallMentionedPeople: true,
  injectImportantItems: true,
  // Legacy compatibility only. New UI no longer uses the all-or-nothing codex switch.
  injectCodex: false,
  useEmbedding: false,
  embeddingUrl: '',
  embeddingKey: '',
  embeddingModel: 'BAAI/bge-m3',
  embeddingModels: [],
  embeddingDimensions: 256,
  embeddingDimensionsMode: 'auto',
  embeddingTopK: 4,
  adaptiveTokenBudget: true,
  memoryMaxTokens: 8000,
  memoryReserveTokens: 1400,
  skipFirstGodlog: false,
  godlogRules: DEFAULT_GODLOG_RULES,
  anchorRules: DEFAULT_ANCHOR_RULES,
  mergeRules: DEFAULT_MERGE_RULES,
  characterRules: DEFAULT_CHARACTER_RULES,
  peopleRules: DEFAULT_PEOPLE_RULES,
  itemRules: DEFAULT_ITEM_RULES,
  slots: {},
};

const state = {
  contextEpoch: 0,
  queueTimer: null,
  restoreTimer: null,
  mutationTimer: null,
  running: false,
  anchorPreparing: false,
  mergeRunning: false,
  summaryRunning: false,
  activeSummaryRowKey: '',
  codexRunning: false,
  lastRecall: '',
  lastRecentFacts: '',
  lastPromptInjection: '',
  lastRecallMeta: [],
  lastRecallQuery: null,
  lastRecentFactsMeta: [],
  selectedMemoryId: '',
  selectedGodlogId: '',
  godlogPage: 0,
  godlogPageSize: 80,
  selectedRecallMessageKey: '',
  lastInjectionRefs: [],
  jobTimer: null,
  jobRunning: false,
  codexTimer: null,
  jobSources: new Set(),
  lastMissingGodlogWarningSignature: '',
  lastMissingGodlogWarningAt: 0,
  settleTimer: null, // legacy alias; per-row timers live in settleTimers
  settleTimers: new Map(),
  latestRowKey: '',
  latestRowHash: '',
  latestRowChangedAt: 0,
  generationEndedAt: 0,
  generationLifecycleActive: false,
  generationStartedAt: 0,
  rowRevisionState: new Map(),
  chatRowsCache: new Map(),
  chatCacheRef: null,
  chatCacheLength: -1,
  chatCacheTailSignature: '',
  godlogIndexData: null,
  godlogIndexArray: null,
  godlogIndexLength: -1,
  godlogByKey: new Map(),
  visibleRenderTimer: null,
  lazyRenderBound: false,
  streamProbeTimer: null,
  lastStreamTokenAt: 0,
  panelRenderTimer: null,
  panelRenderAll: false,
  panelRenderTargets: new Set(),
  panelRenderAttempt: 0,
  messageKeySaveTimer: null,
  metadataFlushTimer: null,
  metadataFlushPromise: null,
  pendingInjectionContent: '',
  vectorDbPromise: null,
  vectorCache: new Map(),
  vectorMigrationStorageIds: new Set(),
  recallPrefetchKey: '',
  recallPrefetchPromise: null,
  recallPrefetchResult: null,
  recallPrefetchAt: 0,
  // The chat metadata object is normalized once per loaded chat. Most hot paths only need a stable
  // reference and must not re-run migrations, relationship-history repair and coverage rebuilds.
  memoryMetadataRef: null,
  memoryDataRef: null,
  memoryDataReady: false,
  // Keyword tokenization of historical Godlogs is immutable until that source record changes.
  // Cache by ID + body hash so prompt-time recall does not split every old summary again.
  recallTermCache: new Map(),
  requests: createAbortRegistry(),
  lastContextSize: 0,
  lastMemoryBudget: null,
  vectorStorageUnavailable: false,
};

function settings() {
  const extension_settings = extensionSettingsStore();
  if (!extension_settings[MODULE]) {
    extension_settings[MODULE] = { ...DEFAULT_SETTINGS };
  }
  const s = extension_settings[MODULE];
  const previousSettingsVersion = String(s.settingsVersion || '');
  const hadDynamicRecallExplicit = Object.prototype.hasOwnProperty.call(s, 'dynamicRecallExplicit');
  let changed = false;
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (s[key] === undefined) {
      s[key] = value;
      changed = true;
    }
  }
  if (looksLikeLegacyGodlogRules(s.godlogRules)) {
    s.godlogRules = DEFAULT_GODLOG_RULES;
    changed = true;
  }
  if (/只写在AI回复楼下|写在AI回复楼下|```xml|Markdown\s*代码块|代码块包裹/i.test(String(s.godlogRules || ''))) {
    s.godlogRules = DEFAULT_GODLOG_RULES;
    changed = true;
  }
  // Upgrade the stock 0.7.1 Godlog prompt, but leave genuinely customized prompts untouched.
  if (/200-350字文学摘要，必须包含剧情推进、动作、关键对话原话、心理转折；需要仔细梳理清楚本回合的详细经过/.test(String(s.godlogRules || ''))) {
    s.godlogRules = DEFAULT_GODLOG_RULES;
    changed = true;
  }
  if (s.skipFirstGodlog !== false) {
    s.skipFirstGodlog = false;
    changed = true;
  }
  if (s.settingsVersion !== DEFAULT_SETTINGS.settingsVersion) {
    // 0.9.1 shipped keyword dynamic recall as an implicit default. 0.9.2 restores strict layered
    // input by default. Only an explicit user choice made after this migration keeps it enabled.
    if (!hadDynamicRecallExplicit && previousSettingsVersion && previousSettingsVersion !== EXTENSION_VERSION) {
      s.useDynamicRecall = false;
      s.dynamicRecallExplicit = false;
    }
    // v0.6 anchors embedded relationship/person/item tables in every 15-turn summary and merge.
    // Migrate only prompts that clearly match that legacy structure; preserve unrelated custom prompts.
    if (/人物纪要|出场人物库|重要道具、梗/.test(String(s.anchorRules || ''))) {
      s.anchorRules = DEFAULT_ANCHOR_RULES;
    }
    if (/人物纪要|出场人物库|本次新增锚点.*详细/.test(String(s.mergeRules || ''))) {
      s.mergeRules = DEFAULT_MERGE_RULES;
    }
    // Preserve user choices across upgrades. v0.7.6 replaces the old all-or-nothing
    // codex injection with selective people recall + a separate item ledger.
    if (s.recallMentionedPeople === undefined) s.recallMentionedPeople = true;
    if (s.injectImportantItems === undefined) s.injectImportantItems = true;
    s.injectCodex = false;
    s.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
    changed = true;
  }
  if (changed) saveSettingsDebounced();
  return s;
}

function saveSetting(key, value) {
  settings()[key] = value;
  saveSettingsDebounced();
}

function defaultData() {
  return {
    version: DATA_VERSION,
    godlogs: [],
    anchors: [],
    merges: [],
    messageGodlogs: {},
    messageRecalls: {},
    // Per-chat tracked protagonists. Empty means automatic resolution from the current single card
    // or active group members. Multi-protagonist single cards can set an explicit list in the UI.
    trackedCharacters: [],
    codex: {
      relationship: '',
      characterMemo: '',
      peopleIndex: '',
      itemIndex: '',
      sceneIndex: '',
      currentTime: '',
      currentPlace: '',
    },
    timeline: {
      currentRaw: '未明',
      currentSourceKey: '',
      currentFloor: -1,
      warnings: [],
      history: [],
      manualOverride: null,
      updatedAt: 0,
    },
    entities: {
      items: { byKey: {}, order: [], updatedAt: 0 },
      scenes: { byKey: {}, order: [], updatedAt: 0 },
      itemTombstones: {},
      sceneTombstones: {},
    },
    // Fixed-schema relationship table. Users control the row names; the background AI may only
    // update the three relationship-state columns for those existing rows.
    relationshipTable: {
      schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
      rows: [],
      history: [],
      updatedAt: 0,
      lastGoodFloor: -1,
      lastGoodKey: '',
    },
    // Last known-good index snapshot. Rebuilds are transactional: the active codex is never
    // erased before a replacement has been generated and validated successfully.
    codexBackup: null,
    // Vector payloads live in IndexedDB. Chat metadata keeps only compact signatures/IDs.
    vectorRefs: {},
    // Legacy compatibility only; v0.8 migrates these records to IndexedDB and clears this object.
    vectors: {},
    processing: {
      storageId: '',
      anchoredKeys: {},
      mergedKeys: {},
      codexKeys: {},
      codexDirty: false,
      codexDirtyReason: '',
      codexDirtyAt: 0,
      codexLastGoodAt: 0,
      codexRebuildFailures: 0,
      relationshipDirty: false,
      relationshipDirtyReason: '',
      relationshipDirtyAt: 0,
      relationshipLastGoodAt: 0,
      relationshipRebuildFailures: 0,
      sourceHashSchema: SOURCE_HASH_SCHEMA_VERSION,
      lastAnchorFloor: -1,
      lastMergeFloor: -1,
      godlogCount: 0,
      anchorCount: 0,
      mergeCount: 0,
      busy: false,
      summaryBusy: false,
      mergeBusy: false,
      codexBusy: false,
      queuePending: false,
      queueRunning: false,
      queueSources: [],
      pendingPromptInjection: null,
      lastError: '',
    },
  };
}


function clonePlainObject(value, fallback = {}) {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch {
    return JSON.parse(JSON.stringify(fallback));
  }
}

function relationshipDefaultRow() {
  return {
    id: 'am_relationship_char',
    name: '{{char}}',
    locked: true,
    past: '',
    development: '',
    current: '',
    createdAt: Date.now(),
    updatedAt: 0,
  };
}

function relationshipRowId(seed = '') {
  return `am_relationship_${Date.now()}_${stableHash(`${seed}_${Math.random()}`).slice(0, 7)}`;
}

function cleanRelationshipCell(value, maxChars = 600) {
  return clampText(cleanText(String(value || ''))
    .replace(/\|/g, '／')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim(), maxChars)
    .replace(/\n\.\.\.\[trimmed\]$/i, '…');
}

function relationshipNameKey(value) {
  return normalizeEntityMatchText(renderMacros(String(value || '')));
}

function normalizeRelationshipTable(value, legacyMarkdown = '') {
  const source = value && typeof value === 'object' ? value : {};
  const rows = [];
  const seenIds = new Set();
  const seenNames = new Set();
  const rawRows = Array.isArray(source.rows) ? source.rows : [];

  for (let index = 0; index < rawRows.length; index++) {
    const raw = rawRows[index] || {};
    const name = cleanRelationshipCell(raw.name || raw.character || raw['名称'] || '', 120);
    if (!name) continue;
    const nameKey = relationshipNameKey(name);
    if (!nameKey || seenNames.has(nameKey)) continue;
    let id = cleanRelationshipCell(raw.id || '', 120) || relationshipRowId(`${name}_${index}`);
    while (seenIds.has(id)) id = relationshipRowId(`${name}_${index}_${id}`);
    seenIds.add(id);
    seenNames.add(nameKey);
    rows.push({
      id,
      name,
      locked: raw.locked === true,
      past: cleanRelationshipCell(raw.past ?? raw['过去'] ?? '', 520),
      development: cleanRelationshipCell(raw.development ?? raw['发展'] ?? '', 720),
      current: cleanRelationshipCell(raw.current ?? raw['当前'] ?? '', 520),
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || 0,
    });
  }

  let legacyFallback = '';
  if (rows.length === 0 && legacyMarkdown) {
    const parsedLegacyRows = parseMarkdownTable(legacyMarkdown);
    for (const raw of parsedLegacyRows) {
      const name = cleanRelationshipCell(raw['名称'] || raw['角色名'] || '', 120);
      if (!name) continue;
      const nameKey = relationshipNameKey(name);
      if (!nameKey || seenNames.has(nameKey)) continue;
      seenNames.add(nameKey);
      rows.push({
        id: relationshipRowId(name),
        name,
        locked: false,
        past: cleanRelationshipCell(raw['过去'] || '', 520),
        development: cleanRelationshipCell(raw['发展'] || '', 720),
        current: cleanRelationshipCell(raw['当前'] || '', 520),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    if (parsedLegacyRows.length === 0 && usefulCodexValue(legacyMarkdown)) {
      legacyFallback = cleanRelationshipCell(legacyMarkdown, 520);
    }
  }

  const charKey = relationshipNameKey('{{char}}');
  let charRow = rows.find(row => row.id === 'am_relationship_char' || relationshipNameKey(row.name) === charKey)
    || rows.find(row => row.locked);
  if (!charRow) {
    charRow = relationshipDefaultRow();
    rows.unshift(charRow);
  } else {
    charRow.locked = true;
    // Store the primary card row as a macro so switching/restoring a chat always resolves to the
    // current SillyTavern character name rather than a stale literal copied from another chat.
    charRow.name = '{{char}}';
    const currentIndex = rows.indexOf(charRow);
    if (currentIndex > 0) {
      rows.splice(currentIndex, 1);
      rows.unshift(charRow);
    }
  }
  for (const row of rows.slice(1)) row.locked = false;
  if (legacyFallback && !usefulCodexValue(charRow.current)) {
    charRow.current = legacyFallback;
    charRow.updatedAt = Date.now();
  }

  const validIds = new Set(rows.map(row => row.id));
  const cleanStateMap = rawMap => {
    const result = {};
    const sourceMap = rawMap && typeof rawMap === 'object' ? rawMap : {};
    for (const [id, state] of Object.entries(sourceMap)) {
      if (!validIds.has(id)) continue;
      result[id] = {
        past: cleanRelationshipCell(state?.past || '', 520),
        development: cleanRelationshipCell(state?.development || '', 720),
        current: cleanRelationshipCell(state?.current || '', 520),
      };
    }
    return result;
  };
  let history = (Array.isArray(source.history) ? source.history : [])
    .map(item => {
      const kind = item?.kind === 'delta' ? 'delta' : 'checkpoint';
      const states = kind === 'checkpoint' ? cleanStateMap(item?.states) : {};
      const changes = kind === 'delta' ? cleanStateMap(item?.changes) : {};
      return {
        kind,
        sourceKey: String(item?.sourceKey || ''),
        sourceHash: String(item?.sourceHash || ''),
        floor: Number.isFinite(Number(item?.floor)) ? Number(item.floor) : -1,
        assistantNumber: Number.isFinite(Number(item?.assistantNumber)) ? Number(item.assistantNumber) : 0,
        savedAt: Number(item?.savedAt) || 0,
        ...(kind === 'checkpoint' ? { states } : { changes }),
      };
    })
    .filter(item => item.floor >= 0 && Object.keys(item.kind === 'checkpoint' ? item.states : item.changes).length > 0)
    .sort((a, b) => a.floor - b.floor || a.savedAt - b.savedAt);
  if (history.length > 1000) {
    const targetStart = history.length - 1000;
    let checkpointStart = targetStart;
    for (let index = targetStart; index >= 0; index--) {
      if (history[index]?.kind === 'checkpoint') {
        checkpointStart = index;
        break;
      }
    }
    history = history.slice(checkpointStart);
  }

  return {
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
    rows,
    history,
    updatedAt: Number(source.updatedAt) || 0,
    lastGoodFloor: Number.isFinite(Number(source.lastGoodFloor)) ? Number(source.lastGoodFloor) : -1,
    lastGoodKey: String(source.lastGoodKey || ''),
  };
}

function relationshipTableMarkdown(value, resolved = true) {
  const table = normalizeRelationshipTable(value);
  const lines = [
    '| 名称 | 过去 | 发展 | 当前 |',
    '| :--- | :--- | :--- | :--- |',
  ];
  for (const row of table.rows) {
    const name = resolved ? renderMacros(row.name) : row.name;
    lines.push(`| ${cleanRelationshipCell(name, 120) || '未命名'} | ${cleanRelationshipCell(row.past, 520) || '未明'} | ${cleanRelationshipCell(row.development, 720) || '未明'} | ${cleanRelationshipCell(row.current, 520) || '未明'} |`);
  }
  return lines.join('\n');
}

function relationshipHasContent(value) {
  const table = normalizeRelationshipTable(value);
  return table.rows.some(row => [row.past, row.development, row.current]
    .some(cell => usefulCodexValue(cell)));
}

function relationshipSchemaOnly(value) {
  const table = normalizeRelationshipTable(value);
  return {
    ...table,
    rows: table.rows.map(row => ({ ...row, past: '', development: '', current: '', updatedAt: 0 })),
    history: [],
    updatedAt: 0,
    lastGoodFloor: -1,
    lastGoodKey: '',
  };
}

function relationshipSnapshotStates(value) {
  const table = normalizeRelationshipTable(value);
  const states = {};
  for (const row of table.rows) {
    states[row.id] = {
      past: row.past || '',
      development: row.development || '',
      current: row.current || '',
    };
  }
  return states;
}

function relationshipStateAtFloor(value, targetFloor = Number.MAX_SAFE_INTEGER) {
  const table = normalizeRelationshipTable(value);
  const floor = Number.isFinite(Number(targetFloor)) ? Number(targetFloor) : Number.MAX_SAFE_INTEGER;
  const states = {};
  for (const entry of table.history || []) {
    if (entry.floor > floor) break;
    if (entry.kind === 'checkpoint') {
      for (const id of Object.keys(states)) delete states[id];
      Object.assign(states, clonePlainObject(entry.states || {}));
      continue;
    }
    for (const [id, next] of Object.entries(entry.changes || {})) {
      states[id] = clonePlainObject(next, { past: '', development: '', current: '' });
    }
  }
  return states;
}

function relationshipStateEquals(a, b) {
  return String(a?.past || '') === String(b?.past || '')
    && String(a?.development || '') === String(b?.development || '')
    && String(a?.current || '') === String(b?.current || '');
}

function recordRelationshipSnapshot(data, row = null) {
  if (!data?.relationshipTable || !row || !Number.isInteger(Number(row.index))) return false;
  const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  const currentStates = relationshipSnapshotStates(table);
  const previousStates = relationshipStateAtFloor(table, Number(row.index) - 1);
  const changes = {};
  for (const [id, next] of Object.entries(currentStates)) {
    if (!relationshipStateEquals(previousStates[id], next)) changes[id] = next;
  }

  table.history = (table.history || []).filter(item => item.sourceKey !== String(row.key || '') && item.floor !== Number(row.index));
  const hasCheckpoint = table.history.some(item => item.kind === 'checkpoint');
  const assistantNumber = Number(row.assistantNumber || 0);
  const makeCheckpoint = !hasCheckpoint
    || assistantNumber <= 1
    || (assistantNumber > 0 && assistantNumber % RELATIONSHIP_CHECKPOINT_INTERVAL === 0);
  if (makeCheckpoint || Object.keys(changes).length > 0) {
    table.history.push({
      kind: makeCheckpoint ? 'checkpoint' : 'delta',
      sourceKey: String(row.key || ''),
      sourceHash: String(row.rawHash || ''),
      floor: Number(row.index),
      assistantNumber,
      savedAt: Date.now(),
      ...(makeCheckpoint ? { states: currentStates } : { changes }),
    });
    table.history.sort((a, b) => a.floor - b.floor || a.savedAt - b.savedAt);
    if (table.history.length > 1000) {
      const targetStart = table.history.length - 1000;
      let checkpointStart = targetStart;
      for (let index = targetStart; index >= 0; index--) {
        if (table.history[index]?.kind === 'checkpoint') {
          checkpointStart = index;
          break;
        }
      }
      table.history = table.history.slice(checkpointStart);
    }
  }
  table.lastGoodFloor = Number(row.index);
  table.lastGoodKey = String(row.key || '');
  table.updatedAt = Date.now();
  data.relationshipTable = table;
  data.codex.relationship = relationshipTableMarkdown(table, false);
  return makeCheckpoint || Object.keys(changes).length > 0;
}

function rollbackRelationshipToFloor(data, targetFloor, reason = '剧情楼层回滚') {
  if (!data) return false;
  // Keep one pre-rollback safety copy. Subsequent deleted floors in the same sync pass must not
  // overwrite it with progressively older states.
  if (!data.processing?.relationshipDirty && !data.processing?.codexDirty) {
    snapshotCodex(data, `${reason}前备份`);
  }
  const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  const floor = Number.isFinite(Number(targetFloor)) ? Number(targetFloor) : -1;
  const candidates = (table.history || [])
    .filter(item => item.floor <= floor)
    .sort((a, b) => b.floor - a.floor || b.savedAt - a.savedAt);
  const snapshot = candidates[0] || null;
  const states = relationshipStateAtFloor(table, floor);
  let changed = false;
  table.rows = table.rows.map(row => {
    const state = states[row.id];
    const next = {
      ...row,
      past: state?.past || '',
      development: state?.development || '',
      current: state?.current || '',
      updatedAt: snapshot?.savedAt || 0,
    };
    if (next.past !== row.past || next.development !== row.development || next.current !== row.current) changed = true;
    return next;
  });
  table.history = (table.history || []).filter(item => item.floor <= floor);
  table.lastGoodFloor = snapshot?.floor ?? -1;
  table.lastGoodKey = snapshot?.sourceKey || '';
  table.updatedAt = Date.now();
  data.relationshipTable = table;
  data.codex.relationship = relationshipTableMarkdown(table, false);
  markRelationshipDirty(data, `${reason}；关系表已回退到第 ${Math.max(0, floor + 1)} 楼之前的最近快照，等待按当前有效剧情复核`);
  return changed || true;
}

function markRelationshipDirty(data, reason = '人物关系来源发生变化') {
  if (!data) return false;
  if (!data.processing || typeof data.processing !== 'object') data.processing = { ...defaultData().processing };
  const nextReason = String(reason || '人物关系来源发生变化');
  const changed = !data.processing.relationshipDirty || data.processing.relationshipDirtyReason !== nextReason;
  data.processing.relationshipDirty = true;
  data.processing.relationshipDirtyReason = nextReason;
  data.processing.relationshipDirtyAt = Date.now();
  return changed;
}

function clearRelationshipDirty(data) {
  if (!data?.processing) return;
  data.processing.relationshipDirty = false;
  data.processing.relationshipDirtyReason = '';
  data.processing.relationshipDirtyAt = 0;
  data.processing.relationshipLastGoodAt = Date.now();
  data.processing.relationshipRebuildFailures = 0;
}

function relationshipSection(markdown) {
  return sectionFrom(markdown, '人物关系');
}

function applyRelationshipPatch(data, markdown, row = null, options = {}) {
  if (!data) return { found: false, matched: 0, changed: false, complete: false };
  const section = relationshipSection(markdown);
  if (!section) return { found: false, matched: 0, changed: false, complete: false };
  const incoming = parseMarkdownTable(section);
  // Work on a detached candidate. An incomplete model response must never partially overwrite the
  // active fixed table.
  const table = normalizeRelationshipTable(
    clonePlainObject(data.relationshipTable),
    data.codex?.relationship || '',
  );
  const byName = new Map();
  for (const fixed of table.rows) {
    const key = relationshipNameKey(fixed.name);
    if (key) byName.set(key, fixed);
  }
  const matchedIds = new Set();
  let unexpected = 0;
  let changed = false;
  for (const raw of incoming) {
    const name = raw['名称'] || raw['角色名'] || raw['人物'] || '';
    const fixed = byName.get(relationshipNameKey(name));
    if (!fixed || matchedIds.has(fixed.id)) {
      unexpected++;
      continue;
    }
    matchedIds.add(fixed.id);
    const nextValues = {
      past: cleanRelationshipCell(raw['过去'] || raw['初始'] || '', 520),
      development: cleanRelationshipCell(raw['发展'] || raw['过程'] || '', 720),
      current: cleanRelationshipCell(raw['当前'] || raw['现状'] || '', 520),
    };
    let rowChanged = false;
    for (const key of ['past', 'development', 'current']) {
      const next = nextValues[key];
      if (!next || /^(?:无变化|不变)$/i.test(next)) continue;
      if (options.preserveKnownOnUnknown && !usefulCodexValue(next) && usefulCodexValue(fixed[key])) continue;
      if (fixed[key] !== next) {
        fixed[key] = next;
        changed = true;
        rowChanged = true;
      }
    }
    if (rowChanged) fixed.updatedAt = Date.now();
  }
  const matched = matchedIds.size;
  const complete = matched === table.rows.length && unexpected === 0;
  if (options.requireComplete && !complete) {
    return { found: true, matched, unexpected, changed: false, complete: false };
  }
  table.updatedAt = Date.now();
  data.relationshipTable = table;
  if (!data.codex || typeof data.codex !== 'object') data.codex = { ...defaultData().codex };
  data.codex.relationship = relationshipTableMarkdown(table, false);
  if (matched > 0 && options.clearDirty !== false) clearRelationshipDirty(data);
  if (row && (changed || options.recordEvenIfUnchanged)) recordRelationshipSnapshot(data, row);
  return { found: true, matched, unexpected, changed, complete };
}

function commitRelationshipReplacement(data, candidate, row = null) {
  const fixed = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  const nextCandidate = normalizeRelationshipTable(candidate);
  const incomingByName = new Map(nextCandidate.rows.map(item => [relationshipNameKey(item.name), item]));
  let matched = 0;
  fixed.rows = fixed.rows.map(rowItem => {
    const incoming = incomingByName.get(relationshipNameKey(rowItem.name));
    if (!incoming) return { ...rowItem, past: '', development: '', current: '', updatedAt: 0 };
    matched++;
    return {
      ...rowItem,
      past: cleanRelationshipCell(incoming.past, 520),
      development: cleanRelationshipCell(incoming.development, 720),
      current: cleanRelationshipCell(incoming.current, 520),
      updatedAt: Date.now(),
    };
  });
  if (matched !== fixed.rows.length) throw new Error('人物关系表未完整返回固定名单中的全部角色，旧关系表已保留');
  fixed.history = [];
  fixed.updatedAt = Date.now();
  data.relationshipTable = fixed;
  data.codex.relationship = relationshipTableMarkdown(fixed, false);
  clearRelationshipDirty(data);
  if (row) recordRelationshipSnapshot(data, row);
  return true;
}

function normalizedCodex(value) {
  const next = { ...defaultData().codex };
  if (value && typeof value === 'object') {
    for (const key of Object.keys(next)) {
      if (value[key] !== undefined && value[key] !== null) next[key] = String(value[key]);
    }
  }
  return next;
}

function codexHasContent(value) {
  const codex = normalizedCodex(value);
  // `relationship` mirrors the separate fixed relationship table for backward compatibility.
  // Its header-only Markdown must not make an otherwise empty codex look populated.
  return Object.entries(codex)
    .filter(([key]) => key !== 'relationship')
    .some(([, entry]) => String(entry || '').trim().length > 0);
}

function codexSignature(value, relationshipTable = null) {
  const normalizedRelationship = relationshipTable ? normalizeRelationshipTable(relationshipTable) : null;
  if (normalizedRelationship) normalizedRelationship.history = [];
  return stableHash(JSON.stringify({
    codex: normalizedCodex(value),
    relationshipTable: normalizedRelationship,
  }));
}

function snapshotCodex(data, reason = '状态索引变更前备份') {
  if (!data || (!codexHasContent(data.codex) && !relationshipHasContent(data.relationshipTable))) return false;
  const signature = codexSignature(data.codex, data.relationshipTable);
  if (data.codexBackup?.signature === signature) return false;
  data.codexBackup = {
    savedAt: Date.now(),
    reason: String(reason || '状态索引变更前备份'),
    signature,
    codex: clonePlainObject(normalizedCodex(data.codex)),
    relationshipTable: (() => { const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || ''); table.history = []; return clonePlainObject(table); })(),
    codexKeys: clonePlainObject(data.processing?.codexKeys || {}),
    lastCodexFloor: Number(data.processing?.lastCodexFloor ?? -1),
  };
  return true;
}

function markCodexDirty(data, reason = '剧情来源发生变化', clearKeys = true) {
  if (!data) return false;
  // A relationship rollback already stored the pre-change snapshot. Do not replace it with
  // the rolled-back state when the wider codex is marked dirty immediately afterwards.
  if (!data.processing?.relationshipDirty) snapshotCodex(data, reason);
  if (!data.processing || typeof data.processing !== 'object') data.processing = { ...defaultData().processing };
  const changed = !data.processing.codexDirty
    || data.processing.codexDirtyReason !== String(reason || '')
    || (clearKeys && Object.keys(data.processing.codexKeys || {}).length > 0);
  data.processing.codexDirty = true;
  data.processing.codexDirtyReason = String(reason || '剧情来源发生变化');
  data.processing.codexDirtyAt = Date.now();
  if (clearKeys) data.processing.codexKeys = {};
  // IMPORTANT: Never clear data.codex here. It remains the visible last-known-good snapshot until
  // a complete replacement is generated and validated. Dirty codex data is excluded from prompt
  // injection, so preserving it cannot leak stale facts to the main model.
  return changed;
}

function validateCodexCandidate(candidate, sourceText = '') {
  const codex = normalizedCodex(candidate);
  const substantive = ['characterMemo', 'peopleIndex', 'itemIndex', 'sceneIndex']
    .filter(key => usefulCodexSection(codex[key])).length;
  const hasClock = !!(usefulCodexValue(codex.currentTime) || usefulCodexValue(codex.currentPlace));
  if (substantive === 0 && !hasClock) return false;
  // A model occasionally echoes only headings or an empty table. Require at least one parsed row
  // when the source contains table sections, unless time/place is the only available fact.
  if (substantive > 0) {
    const rows = ['characterMemo', 'peopleIndex', 'itemIndex', 'sceneIndex']
      .flatMap(key => parseMarkdownTable(codex[key] || ''));
    if (rows.length === 0 && !hasClock) return false;
  }
  return String(sourceText || '').trim().length > 0;
}

function commitCodexReplacement(data, candidate, materials = [], reason = '人物索引安全重建') {
  const next = normalizedCodex(candidate);
  if (!validateCodexCandidate(next, JSON.stringify(next))) {
    throw new Error('副API返回的状态索引为空或格式不完整，已保留原索引');
  }
  snapshotCodex(data, reason);
  data.codex = next;
  syncEntityLedgers(data);
  refreshTimelineFromGodlogs(data);
  data.processing.codexKeys = {};
  for (const material of materials || []) {
    const row = material?.row || material;
    const godlog = material?.godlog || null;
    const revisionHash = summaryRevisionHash(godlog, row);
    if (row?.key && revisionHash) data.processing.codexKeys[row.key] = revisionHash;
  }
  data.processing.codexDirty = false;
  data.processing.codexDirtyReason = '';
  data.processing.codexDirtyAt = 0;
  data.processing.codexLastGoodAt = Date.now();
  data.processing.codexRebuildFailures = 0;
  return true;
}

function restoreCodexBackup(data, notify = true) {
  const backup = data?.codexBackup;
  if (!backup?.codex || (!codexHasContent(backup.codex) && !relationshipHasContent(backup.relationshipTable))) {
    if (notify) toastr?.warning?.('当前聊天没有可恢复的人物关系/人物/物品/场景索引备份。', 'Anchor Memory');
    return false;
  }
  if (codexHasContent(data.codex) || relationshipHasContent(data.relationshipTable)) snapshotCodex(data, '恢复备份前保存当前索引');
  data.codex = normalizedCodex(backup.codex);
  if (backup.relationshipTable) data.relationshipTable = normalizeRelationshipTable(backup.relationshipTable, data.codex.relationship || '');
  else data.relationshipTable = normalizeRelationshipTable(data.relationshipTable, data.codex.relationship || '');
  data.codex.relationship = relationshipTableMarkdown(data.relationshipTable, false);
  data.processing.codexKeys = clonePlainObject(backup.codexKeys || {});
  data.processing.lastCodexFloor = Number(backup.lastCodexFloor ?? -1);
  data.processing.codexDirty = false;
  data.processing.codexDirtyReason = '';
  data.processing.codexDirtyAt = 0;
  data.processing.codexLastGoodAt = Date.now();
  data.processing.codexRebuildFailures = 0;
  clearRelationshipDirty(data);
  syncEntityLedgers(data);
  refreshTimelineFromGodlogs(data);
  saveMemory(true);
  updatePreview();
  if (notify) toastr?.success?.('已恢复上一次人物关系/人物/物品/场景索引备份。', 'Anchor Memory');
  return true;
}

function memoryData() {
  const ctx = getContext();
  if (!ctx.chatMetadata) return defaultData();
  if (!ctx.chatMetadata[DATA_KEY]) ctx.chatMetadata[DATA_KEY] = defaultData();
  const data = ctx.chatMetadata[DATA_KEY];
  if (state.memoryDataReady
      && state.memoryMetadataRef === ctx.chatMetadata
      && state.memoryDataRef === data
      && Number(data.version) === DATA_VERSION) {
    return data;
  }
  const priorDataVersion = Number(data.version) || 0;
  const priorSourceHashSchema = Number(data.processing?.sourceHashSchema || 0);
  let migrationTouched = priorDataVersion !== DATA_VERSION;

  if (!Array.isArray(data.godlogs)) { data.godlogs = []; migrationTouched = true; }
  if (!Array.isArray(data.anchors)) { data.anchors = []; migrationTouched = true; }
  if (!Array.isArray(data.merges)) { data.merges = []; migrationTouched = true; }
  if (!data.messageGodlogs || typeof data.messageGodlogs !== 'object') data.messageGodlogs = {};
  if (!data.messageRecalls || typeof data.messageRecalls !== 'object') data.messageRecalls = {};
  const normalizedTrackedCharacters = uniqueTrackedNames(Array.isArray(data.trackedCharacters) ? data.trackedCharacters : []);
  if (!Array.isArray(data.trackedCharacters)
      || JSON.stringify(normalizedTrackedCharacters) !== JSON.stringify(data.trackedCharacters)) {
    data.trackedCharacters = normalizedTrackedCharacters;
    migrationTouched = true;
  }
  // v0.8 migration: historical prompt records retain IDs, counts and a short preview only.
  // Full injected bodies are highly repetitive and made every metadata save progressively larger.
  for (const record of Object.values(data.messageRecalls)) {
    if (!record || typeof record !== 'object') continue;
    if (typeof record.content === 'string') {
      if (!record.contentHash) record.contentHash = stableHash(record.content);
      if (!record.contentPreview) record.contentPreview = compactInjectionPreview(record.content);
      if (!record.injectedChars) record.injectedChars = record.content.length;
      delete record.content;
      migrationTouched = true;
    }
  }
  if (!data.codex || typeof data.codex !== 'object') { data.codex = { ...defaultData().codex }; migrationTouched = true; }
  data.codex = normalizedCodex(data.codex);
  // Upgrade old tables in place and enforce the protagonist/NPC boundary on existing chats. This
  // removes previously leaked player rows immediately instead of waiting for another AI rewrite.
  const resolvedTrackedCharacters = trackedCharacterNames(data);
  if (data.codex.characterMemo && resolvedTrackedCharacters.length > 0) {
    const normalizedCharacterMemo = sanitizeCharacterMemoSection(data, data.codex.characterMemo);
    if (normalizedCharacterMemo && normalizedCharacterMemo !== data.codex.characterMemo) {
      data.codex.characterMemo = normalizedCharacterMemo;
      migrationTouched = true;
    }
  }
  if (data.codex.peopleIndex && resolvedTrackedCharacters.length > 0) {
    const normalizedPeopleIndex = sanitizePeopleIndexSection(data, data.codex.peopleIndex);
    if (normalizedPeopleIndex !== data.codex.peopleIndex) {
      data.codex.peopleIndex = normalizedPeopleIndex;
      migrationTouched = true;
    }
  }
  if (data.codex.itemIndex) {
    const normalizedItemIndex = sanitizeItemIndexSection(data, data.codex.itemIndex);
    if (normalizedItemIndex !== data.codex.itemIndex) {
      data.codex.itemIndex = normalizedItemIndex;
      migrationTouched = true;
    }
  }
  if (data.codex.sceneIndex) {
    const normalizedSceneIndex = sanitizeSceneIndexSection(data, data.codex.sceneIndex);
    if (normalizedSceneIndex !== data.codex.sceneIndex) {
      data.codex.sceneIndex = normalizedSceneIndex;
      migrationTouched = true;
    }
  }
  const hadEntities = !!(data.entities && data.entities.items && data.entities.scenes);
  const hadTimeline = !!(data.timeline && Array.isArray(data.timeline.history));
  ensureEntityState(data);
  ensureTimelineState(data);
  syncEntityLedgers(data);
  refreshTimelineFromGodlogs(data);
  if (!hadEntities || !hadTimeline) migrationTouched = true;
  const hadRelationshipTable = !!(data.relationshipTable && typeof data.relationshipTable === 'object' && Array.isArray(data.relationshipTable.rows));
  data.relationshipTable = normalizeRelationshipTable(data.relationshipTable, data.codex.relationship || '');
  data.codex.relationship = relationshipTableMarkdown(data.relationshipTable, false);
  if (!hadRelationshipTable) migrationTouched = true;
  if (data.codexBackup !== null && (!data.codexBackup || typeof data.codexBackup !== 'object')) {
    data.codexBackup = null;
    migrationTouched = true;
  }
  if (data.codexBackup?.codex) data.codexBackup.codex = normalizedCodex(data.codexBackup.codex);
  if (data.codexBackup?.relationshipTable) data.codexBackup.relationshipTable = normalizeRelationshipTable(data.codexBackup.relationshipTable, data.codexBackup.codex?.relationship || '');
  if (!data.vectorRefs || typeof data.vectorRefs !== 'object') { data.vectorRefs = {}; migrationTouched = true; }
  if (!data.vectors || typeof data.vectors !== 'object') data.vectors = {};
  if (!data.processing || typeof data.processing !== 'object') data.processing = { ...defaultData().processing };
  const processingDefaults = defaultData().processing;
  for (const [key, value] of Object.entries(processingDefaults)) {
    if (data.processing[key] === undefined) {
      data.processing[key] = Array.isArray(value) ? [...value]
        : value && typeof value === 'object' ? { ...value }
          : value;
    }
  }
  if (data.processing.pendingPromptInjection?.content) {
    const content = String(data.processing.pendingPromptInjection.content || '');
    data.processing.pendingPromptInjection.contentHash ||= stableHash(content);
    data.processing.pendingPromptInjection.contentPreview ||= compactInjectionPreview(content);
    data.processing.pendingPromptInjection.injectedChars ||= content.length;
    delete data.processing.pendingPromptInjection.content;
    migrationTouched = true;
  }
  if (!data.processing.anchoredKeys) data.processing.anchoredKeys = {};
  if (!data.processing.mergedKeys) data.processing.mergedKeys = {};
  if (!data.processing.codexKeys) data.processing.codexKeys = {};
  if (!Array.isArray(data.processing.queueSources)) data.processing.queueSources = [];
  if (!data.processing.storageId) {
    ensureVectorStorageId(data);
    migrationTouched = true;
  }
  scheduleLegacyVectorMigration(data);
  if (!hadRelationshipTable && (data.godlogs || []).some(item => item.status === 'ready' && item.body)) {
    data.processing.relationshipDirty = true;
    data.processing.relationshipDirtyReason = '升级后首次建立固定人物关系表，等待根据现有剧情自动回填';
    data.processing.relationshipDirtyAt = Date.now();
  }

  // Upgrades may change text cleaning/fingerprint details. A schema migration must rebase source
  // fingerprints in place rather than treating every historical floor as edited and destroying
  // all dependent state. Real edits after the migration are still detected normally.
  if (priorSourceHashSchema !== SOURCE_HASH_SCHEMA_VERSION && hasPersistentChatContext()) {
    const rows = chatRows(true);
    const byKey = new Map(rows.map(row => [row.key, row]));
    const keyRemap = new Map();
    for (const item of data.godlogs || []) {
      let row = byKey.get(item.key);
      if (!row && Number.isInteger(Number(item.floor))) {
        const candidate = rows.find(entry => entry.index === Number(item.floor) && entry.role === 'assistant');
        const compatibleName = !item.name || !candidate?.name || item.name === candidate.name;
        const compatibleDate = !item.sendDate || !candidate?.sendDate || item.sendDate === candidate.sendDate;
        if (candidate && compatibleName && compatibleDate) row = candidate;
      }
      if (!row) continue;
      if (item.key !== row.key) keyRemap.set(item.key, row.key);
      item.key = row.key;
      item.floor = row.index;
      item.name = row.name;
      item.sendDate = row.sendDate;
      item.rawHash = row.rawHash;
    }
    const remapKeys = values => [...new Set((values || []).map(key => keyRemap.get(key) || key).filter(Boolean))];
    for (const anchor of data.anchors || []) {
      anchor.sourceKeys = remapKeys(anchor.sourceKeys);
      anchor.coveredKeys = remapKeys(anchor.coveredKeys);
    }
    for (const merge of data.merges || []) {
      merge.sourceKeys = remapKeys(merge.sourceKeys);
      merge.cycleSourceKeys = remapKeys(merge.cycleSourceKeys);
    }
    const remapObject = source => {
      const target = {};
      for (const [key, value] of Object.entries(source || {})) target[keyRemap.get(key) || key] = value;
      return target;
    };
    data.messageGodlogs = remapObject(data.messageGodlogs);
    data.messageRecalls = remapObject(data.messageRecalls);
    data.processing.codexKeys = remapObject(data.processing.codexKeys);
    const remappedRelationship = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
    remappedRelationship.history = (remappedRelationship.history || []).map(item => ({
      ...item,
      sourceKey: keyRemap.get(item.sourceKey) || item.sourceKey,
    }));
    remappedRelationship.lastGoodKey = keyRemap.get(remappedRelationship.lastGoodKey) || remappedRelationship.lastGoodKey;
    data.relationshipTable = remappedRelationship;
    data.codex.relationship = relationshipTableMarkdown(remappedRelationship, false);
    const migratedGodlogsByKey = new Map((data.godlogs || []).map(item => [item.key, item]));
    for (const row of rows) {
      if (!data.processing.codexKeys[row.key]) continue;
      data.processing.codexKeys[row.key] = summaryRevisionHash(migratedGodlogsByKey.get(row.key), row);
    }
    data.processing.sourceHashSchema = SOURCE_HASH_SCHEMA_VERSION;
    migrationTouched = true;
  }

  // Repair already-damaged 0.7.6/0.7.7 states when a backup exists. If no backup exists but valid
  // Godlogs remain, mark the empty index for a safe background rebuild instead of silently leaving
  // the panels blank forever.
  if (!codexHasContent(data.codex) && !relationshipHasContent(data.relationshipTable)
      && data.codexBackup?.codex
      && (codexHasContent(data.codexBackup.codex) || relationshipHasContent(data.codexBackup.relationshipTable))) {
    data.codex = normalizedCodex(data.codexBackup.codex);
    if (data.codexBackup.relationshipTable) {
      data.relationshipTable = normalizeRelationshipTable(data.codexBackup.relationshipTable, data.codex.relationship || '');
      data.codex.relationship = relationshipTableMarkdown(data.relationshipTable, false);
      if (relationshipHasContent(data.relationshipTable)) clearRelationshipDirty(data);
    }
    data.processing.codexKeys = clonePlainObject(data.codexBackup.codexKeys || {});
    data.processing.codexDirty = false;
    data.processing.codexDirtyReason = '';
    data.processing.codexDirtyAt = 0;
    migrationTouched = true;
  } else if (!codexHasContent(data.codex)
    && (data.godlogs || []).some(item => item?.status === 'ready' && item?.body)
    && priorDataVersion < DATA_VERSION) {
    data.processing.codexDirty = true;
    data.processing.codexDirtyReason = '升级时检测到状态索引为空，等待安全重建';
    data.processing.codexDirtyAt = Date.now();
    migrationTouched = true;
  }

  // Remove previously invalidated records from the active arrays. Older builds kept them in-place
  // and latestAnchor/latestMerge could accidentally inject them after a reroll.
  const preFilterAnchorCount = data.anchors.length;
  const preFilterMergeCount = data.merges.length;
  data.anchors = data.anchors.filter(item => item && !item.stale && item.active !== false);
  data.merges = data.merges.filter(item => item && !item.stale && item.active !== false);
  if (data.anchors.length !== preFilterAnchorCount || data.merges.length !== preFilterMergeCount) migrationTouched = true;

  const godlogById = new Map(data.godlogs.map(item => [item.id, item]));
  for (const anchor of data.anchors) {
    if (!Array.isArray(anchor.sourceKeys) || anchor.sourceKeys.length === 0) {
      anchor.sourceKeys = (anchor.sourceGodlogIds || [])
        .map(id => godlogById.get(id)?.key)
        .filter(Boolean);
      migrationTouched = true;
    }
    if (!Array.isArray(anchor.sourceGodlogIds)) { anchor.sourceGodlogIds = []; migrationTouched = true; }
    if (!Array.isArray(anchor.coveredKeys)) { anchor.coveredKeys = [...anchor.sourceKeys]; migrationTouched = true; }
  }

  // v0.6 merges only stored sourceAnchorIds. Convert them to cumulative sourceKeys so a single
  // changed floor can invalidate every dependent merge deterministically.
  const anchorById = new Map(data.anchors.map(item => [item.id, item]));
  let cumulative = [];
  for (const merge of data.merges) {
    let keys = Array.isArray(merge.sourceKeys) ? merge.sourceKeys.filter(Boolean) : [];
    if (keys.length === 0) {
      const fromAnchors = (merge.sourceAnchorIds || [])
        .flatMap(id => anchorById.get(id)?.sourceKeys || []);
      const fromGodlogs = (merge.sourceGodlogIds || [])
        .map(id => godlogById.get(id)?.key)
        .filter(Boolean);
      keys = [...cumulative, ...fromAnchors, ...fromGodlogs];
    }
    const normalizedKeys = [...new Set(keys)];
    if (JSON.stringify(merge.sourceKeys || []) !== JSON.stringify(normalizedKeys)) migrationTouched = true;
    merge.sourceKeys = normalizedKeys;
    cumulative = merge.sourceKeys;
  }

  // Repair legacy anchors that straddled a 100-turn boundary (for example 91-105).
  // The merged portion already belongs to the cumulative history anchor, while the tail must be
  // released and regrouped from clean post-boundary summaries.
  if (cumulative.length > 0) {
    const mergedSet = new Set(cumulative);
    const before = data.anchors.length;
    data.anchors = data.anchors.filter(anchor => {
      const keys = anchor.sourceKeys || [];
      const overlap = keys.filter(key => mergedSet.has(key)).length;
      if (overlap > 0 && overlap < keys.length) {
        removeStoredVector(data, anchor.id);
        return false;
      }
      return true;
    });
    if (data.anchors.length !== before) migrationTouched = true;
  }

  data.processing.godlogCount = Math.max(0, ...data.godlogs.map(item => Number(item.number) || 0));
  if (renumberDerivedMemory(data)) migrationTouched = true;
  if (data.processing.busy && !state.running) { data.processing.busy = false; migrationTouched = true; }
  if (data.processing.summaryBusy && !state.summaryRunning) { data.processing.summaryBusy = false; migrationTouched = true; }
  if (data.processing.mergeBusy && !state.mergeRunning) { data.processing.mergeBusy = false; migrationTouched = true; }
  if (data.processing.codexBusy && !state.codexRunning) { data.processing.codexBusy = false; migrationTouched = true; }
  if (data.processing.queueRunning && !state.jobRunning) { data.processing.queueRunning = false; migrationTouched = true; }
  data.version = DATA_VERSION;
  refreshCoverageMaps(data);
  state.memoryMetadataRef = ctx.chatMetadata;
  state.memoryDataRef = data;
  state.memoryDataReady = true;
  if (migrationTouched) saveMemory(true);
  return data;
}

function hasPersistentChatContext() {
  const ctx = getContext();
  return !!(ctx && Array.isArray(ctx.chat) && ctx.chatMetadata && typeof ctx.chatMetadata === 'object');
}


function captureChatContextToken(data = null) {
  const ctx = getContext();
  return {
    chatRef: ctx?.chat || null,
    metadataRef: ctx?.chatMetadata || null,
    storageId: String(data?.processing?.storageId || ''),
  };
}

function isSameChatContext(token) {
  if (!token) return false;
  const ctx = getContext();
  if (ctx?.chat !== token.chatRef || ctx?.chatMetadata !== token.metadataRef) return false;
  if (!token.storageId) return true;
  const currentStorageId = String(ctx?.chatMetadata?.[DATA_KEY]?.processing?.storageId || '');
  return !currentStorageId || currentStorageId === token.storageId;
}

async function flushMemoryNow() {
  if (!hasPersistentChatContext()) return false;
  if (state.metadataFlushTimer) {
    clearTimeout(state.metadataFlushTimer);
    state.metadataFlushTimer = null;
  }
  if (state.metadataFlushPromise) return state.metadataFlushPromise;
  state.metadataFlushPromise = Promise.resolve()
    .then(async () => {
      if (typeof saveMetadataDebounced.flush === 'function') {
        await saveMetadataDebounced.flush();
      } else {
        saveMetadataDebounced();
      }
      return true;
    })
    .catch(err => {
      console.warn('[AnchorMemory] metadata flush failed:', err);
      return false;
    })
    .finally(() => {
      state.metadataFlushPromise = null;
    });
  return state.metadataFlushPromise;
}

function requestMetadataFlush(delay = 900) {
  if (!hasPersistentChatContext()) return false;
  if (state.metadataFlushTimer) clearTimeout(state.metadataFlushTimer);
  state.metadataFlushTimer = setTimeout(() => {
    state.metadataFlushTimer = null;
    flushMemoryNow();
  }, Math.max(120, Number(delay) || 900));
  return true;
}

function saveMemory(immediate = false) {
  // SillyTavern serializes chat metadata together with the chat save. Keep ordinary updates on its
  // built-in debounce, and coalesce "immediate" requests from multi-step memory jobs into one flush.
  if (!hasPersistentChatContext()) return false;
  saveMetadataDebounced();
  if (immediate) requestMetadataFlush();
  return true;
}

function currentCharacterName() {
  return (getContext().name2 || 'character').trim() || 'character';
}

function cleanTrackedCharacterName(value) {
  return cleanRelationshipCell(String(value || '')
    .replace(/^[-*•\d.、\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim(), 120);
}

function uniqueTrackedNames(values, userName = getContext().name1 || '') {
  const result = [];
  const seen = new Set();
  const userKey = normalizeEntityMatchText(userName);
  for (const value of values || []) {
    const name = cleanTrackedCharacterName(value);
    const key = normalizeEntityMatchText(name);
    if (!name || !key || key === userKey || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function parseTrackedCharacterInput(value) {
  return uniqueTrackedNames(String(value || '')
    .split(/[\n,，、;；/]+/)
    .map(item => item.trim())
    .filter(Boolean));
}

function characterRecordName(record) {
  return cleanTrackedCharacterName(
    record?.name
    || record?.data?.name
    || record?.character_name
    || record?.display_name
    || '',
  );
}

function characterRecordAvatar(record) {
  return String(record?.avatar || record?.data?.avatar || record?.filename || '').trim();
}

function characterCollections(ctx = getContext()) {
  return [ctx.characters, globalThis.characters, globalThis.SillyTavern?.characters]
    .filter(Boolean);
}

function allCharacterRecords(ctx = getContext()) {
  const result = [];
  const seen = new Set();
  for (const collection of characterCollections(ctx)) {
    const values = Array.isArray(collection) ? collection : Object.values(collection || {});
    for (const record of values) {
      if (!record || typeof record !== 'object' || seen.has(record)) continue;
      seen.add(record);
      result.push(record);
    }
  }
  return result;
}

function groupCollections(ctx = getContext()) {
  return [
    ctx.groups,
    ctx.groupChats,
    legacyGroupModule.groups,
    globalThis.groups,
    globalThis.SillyTavern?.groups,
  ].filter(Boolean);
}

function activeGroupRecord(ctx = getContext()) {
  const groupId = String(ctx.groupId ?? ctx.group_id ?? globalThis.selected_group ?? '').trim();
  if (!groupId) return null;
  for (const collection of groupCollections(ctx)) {
    const values = Array.isArray(collection) ? collection : Object.values(collection || {});
    const match = values.find(group => String(group?.id ?? group?.groupId ?? group?.group_id ?? '') === groupId);
    if (match) return match;
  }
  return ctx.group || ctx.currentGroup || null;
}

function resolveGroupMemberName(member, records) {
  if (member && typeof member === 'object') {
    const direct = characterRecordName(member);
    if (direct) return direct;
    member = member.id ?? member.chid ?? member.avatar ?? member.filename ?? '';
  }
  const numeric = Number(member);
  if (Number.isInteger(numeric) && records[numeric]) {
    const name = characterRecordName(records[numeric]);
    if (name) return name;
  }
  const raw = String(member || '').trim();
  if (!raw) return '';
  const rawKey = normalizeEntityMatchText(raw.replace(/\.[a-z0-9]+$/i, ''));
  for (const record of records) {
    const name = characterRecordName(record);
    const avatar = characterRecordAvatar(record);
    if (normalizeEntityMatchText(name) === rawKey
      || normalizeEntityMatchText(avatar) === normalizeEntityMatchText(raw)
      || normalizeEntityMatchText(avatar.replace(/\.[a-z0-9]+$/i, '')) === rawKey) return name;
  }
  return cleanTrackedCharacterName(raw.replace(/\.[a-z0-9]+$/i, ''));
}

function automaticTrackedCharacterNames(ctx = getContext()) {
  const names = [];
  const records = allCharacterRecords(ctx);
  const group = activeGroupRecord(ctx);
  if (group) {
    const members = group.members || group.memberIds || group.characters || group.chars || [];
    for (const member of Array.isArray(members) ? members : Object.values(members || {})) {
      const name = resolveGroupMemberName(member, records);
      if (name) names.push(name);
    }
  }
  const singleName = cleanTrackedCharacterName(ctx.name2 || '');
  if (names.length === 0 && singleName) names.push(singleName);
  return uniqueTrackedNames(names, ctx.name1 || '');
}

function trackedCharacterNames(data = null, ctx = getContext()) {
  const explicit = Array.isArray(data?.trackedCharacters)
    ? uniqueTrackedNames(data.trackedCharacters, ctx.name1 || '')
    : [];
  // Explicit per-chat names are authoritative for a multi-protagonist single card. In a real group
  // chat, active group members are also included so newly enabled speakers are never silently lost.
  const automatic = automaticTrackedCharacterNames(ctx);
  return uniqueTrackedNames(activeGroupRecord(ctx) ? [...explicit, ...automatic] : (explicit.length ? explicit : automatic), ctx.name1 || '');
}

function trackedCharacterLabel(data = null, ctx = getContext()) {
  const names = trackedCharacterNames(data, ctx);
  return names.length ? names.join('、') : (ctx.name2 || '{{char}}');
}

function trackedCharacterKeys(data = null, ctx = getContext()) {
  return new Set(trackedCharacterNames(data, ctx).map(normalizeEntityMatchText).filter(Boolean));
}

function isTrackedCharacterName(value, data = null, ctx = getContext()) {
  const key = normalizeEntityMatchText(value);
  if (!key) return false;
  return trackedCharacterKeys(data, ctx).has(key);
}

function renderMemoryRules(text, data = null, ctx = getContext()) {
  const tracked = trackedCharacterLabel(data, ctx);
  return renderMacros(String(text || ''), ctx)
    .replace(/\{\{\s*tracked_chars?\s*\}\}/gi, tracked)
    .replace(/\{\{\s*trackedCharacters\s*\}\}/gi, tracked);
}

function uniqueCompactLines(lines, limit = 24) {
  const seen = new Set();
  const result = [];
  for (const line of lines || []) {
    const text = cleanText(line).replace(/\s+/g, ' ').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function objectValueAtPath(source, path) {
  let value = source;
  for (const part of path) {
    if (!value || typeof value !== 'object') return '';
    try {
      value = value[part];
    } catch {
      return '';
    }
  }
  return value;
}

function stringifyCanonValue(value, limit = 1200, seen = new WeakSet(), depth = 0) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return clampText(cleanText(value).replace(/\s+/g, ' ').trim(), limit);
  if (depth > 3) return '';
  if (Array.isArray(value)) {
    if (seen.has(value)) return '';
    seen.add(value);
    return clampText(value.slice(0, 12).map(item => stringifyCanonValue(item, Math.floor(limit / 2), seen, depth + 1)).filter(Boolean).join('；'), limit);
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '';
    seen.add(value);
    const parts = [];
    for (const key of ['name', 'comment', 'key', 'keys', 'content', 'text', 'entry', 'description']) {
      let child;
      try {
        child = value[key];
      } catch {
        continue;
      }
      if (child === undefined) continue;
      const text = stringifyCanonValue(child, Math.floor(limit / 2), seen, depth + 1);
      if (text) parts.push(text);
    }
    return clampText(parts.join('；'), limit);
  }
  return String(value).trim();
}

function characterCardCandidates(ctx = getContext()) {
  const candidates = [];
  const charName = ctx.name2 || currentCharacterName();
  const ids = [ctx.characterId, ctx.character_id, ctx.chid, ctx.this_chid, window.this_chid]
    .map(value => Number(value))
    .filter(Number.isInteger);
  for (const list of [ctx.characters, window.characters]) {
    if (Array.isArray(list)) {
      for (const id of ids) if (list[id]) candidates.push(list[id]);
      candidates.push(...list.filter(item => item?.name === charName || item?.data?.name === charName));
    } else if (list && typeof list === 'object') {
      if (list[charName]) candidates.push(list[charName]);
      candidates.push(...Object.values(list).filter(item => item?.name === charName || item?.data?.name === charName));
    }
  }
  candidates.push(ctx.character, ctx.char, ctx.currentCharacter, ctx.thisCharacter, window.character, window.char, window.thisCharacter);
  return candidates.filter(Boolean);
}

function collectCharacterCanon(ctx = getContext()) {
  const rows = [];
  const fields = [
    ['name'],
    ['data', 'name'],
    ['description'],
    ['data', 'description'],
    ['personality'],
    ['data', 'personality'],
    ['scenario'],
    ['data', 'scenario'],
    ['creatorcomment'],
    ['data', 'creator_notes'],
    ['system_prompt'],
    ['data', 'system_prompt'],
    ['post_history_instructions'],
    ['data', 'post_history_instructions'],
    ['first_mes'],
    ['data', 'first_mes'],
    ['mes_example'],
    ['data', 'mes_example'],
  ];
  for (const card of characterCardCandidates(ctx)) {
    for (const path of fields) {
      const value = objectValueAtPath(card, path);
      const text = stringifyCanonValue(value, 1200);
      if (text) rows.push(`${path.join('.')}: ${text}`);
    }
    const book = card.character_book || card.data?.character_book;
    const entries = Array.isArray(book?.entries) ? book.entries : [];
    for (const entry of entries) {
      if (entry?.disable === true || entry?.enabled === false) continue;
      const text = stringifyCanonValue(entry, 1000);
      if (text) rows.push(`character_book: ${text}`);
    }
  }
  return uniqueCompactLines(rows, 18);
}

function looksLikeWorldInfoEntry(value) {
  if (!value || typeof value !== 'object') return false;
  return typeof value.content === 'string'
    || typeof value.comment === 'string'
    || typeof value.entry === 'string'
    || typeof value.text === 'string'
    || typeof value.key === 'string'
    || Array.isArray(value.keys);
}

function collectWorldInfoEntries(source, maxEntries = 120) {
  if (!source || typeof source !== 'object') return [];
  const entries = [];
  const queue = [source];
  const seen = new WeakSet();
  let inspected = 0;

  while (queue.length > 0 && entries.length < maxEntries && inspected < 1000) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    inspected++;

    if (looksLikeWorldInfoEntry(current)) {
      entries.push(current);
      continue;
    }

    if (Array.isArray(current)) {
      for (const item of current.slice(0, 240)) {
        if (item && typeof item === 'object') queue.push(item);
      }
      continue;
    }

    if (current instanceof Map) {
      for (const item of [...current.values()].slice(0, 240)) {
        if (item && typeof item === 'object') queue.push(item);
      }
      continue;
    }

    for (const key of ['entries', 'world_info', 'worldInfo', 'data', 'books', 'global', 'chat', 'character']) {
      let child;
      try {
        child = current[key];
      } catch {
        continue;
      }
      if (child && typeof child === 'object') queue.push(child);
    }

    let values = [];
    try {
      values = Object.values(current).filter(item => item && typeof item === 'object').slice(0, 120);
    } catch {
      values = [];
    }
    for (const item of values) queue.push(item);
  }

  return entries;
}

function collectWorldCanon(row, godlog = null, ctx = getContext()) {
  const query = [
    ctx.name1,
    ctx.name2,
    row?.name,
    row?.turnText,
    row?.text,
    safeGodlogMemoryText(godlog?.body || ''),
  ].filter(Boolean).join('\n');
  const terms = keywordSet(query);
  const sources = [
    ctx.worldInfo,
    ctx.world_info,
    ctx.worldInfoEntries,
    ctx.globalWorldInfo,
    ctx.chatMetadata?.worldInfo,
    ctx.chatMetadata?.world_info,
    window.worldInfo,
    window.world_info,
    window.worldInfoEntries,
    window.globalWorldInfo,
  ];
  const rows = [];
  for (const source of sources) {
    let entries = [];
    try {
      entries = collectWorldInfoEntries(source);
    } catch (err) {
      console.warn('[AnchorMemory] world info scan skipped', err);
      continue;
    }
    for (const entry of entries) {
      if (!entry || entry.disable === true || entry.enabled === false) continue;
      const text = stringifyCanonValue(entry, 1200);
      if (!text) continue;
      const own = keywordSet(text);
      let score = 0;
      for (const term of terms) if (own.has(term) || text.toLowerCase().includes(term)) score++;
      if (score > 0 || entry.constant === true) rows.push({ score, text });
    }
  }
  return uniqueCompactLines(rows.sort((a, b) => b.score - a.score).map(item => item.text), 18);
}

function collectRecentOriginalContext(row, limit = 8) {
  const chat = getContext().chat || [];
  const end = Number.isInteger(row?.index) ? row.index : chat.length;
  return chat
    .slice(Math.max(0, end - limit), end)
    .filter(message => message && !message.is_system && !message.is_hidden && message.mes)
    .map((message, offset) => {
      const floor = Math.max(0, end - limit) + offset + 1;
      const role = message.is_user ? '用户' : 'AI';
      return `第${floor}楼 ${role} ${message.name || '未命名'}：${clampText(cleanText(message.mes), 500)}`;
    })
    .filter(Boolean);
}

function buildCanonContextBlock(data, row, godlog = null, maxChars = 7200) {
  const ctx = getContext();
  const parts = [];
  let characterCanon = [];
  try {
    characterCanon = collectCharacterCanon(ctx);
  } catch (err) {
    console.warn('[AnchorMemory] character canon scan skipped', err);
  }
  if (characterCanon.length) parts.push(`## 角色卡与角色书硬设定\n${characterCanon.join('\n')}`);
  let worldCanon = [];
  try {
    worldCanon = collectWorldCanon(row, godlog, ctx);
  } catch (err) {
    console.warn('[AnchorMemory] world canon scan skipped', err);
  }
  if (worldCanon.length) parts.push(`## 世界书/设定书相关条目\n${worldCanon.join('\n')}`);
  const recentOriginal = collectRecentOriginalContext(row, 8);
  if (recentOriginal.length) parts.push(`## 当前楼之前的近几条原文\n${recentOriginal.join('\n')}`);
  if (data?.codex?.peopleIndex) parts.push(`## 已有人物关系事实\n${safeCodexText(data.codex.peopleIndex, 1800)}`);
  if (!data?.processing?.relationshipDirty && relationshipHasContent(data?.relationshipTable)) {
    parts.push(`## 固定人物与${renderMacros('{{user}}')}的关系表\n${safeCodexText(relationshipTableMarkdown(data.relationshipTable, true), 2200)}`);
  }
  if (!parts.length) return '（未读取到角色卡、世界书或上文硬设定；不确定身份和关系时必须写“未明/沿用既有设定”，不要猜。）';
  return clampText(parts.join('\n\n'), maxChars);
}

function showStatus(text) {
  $('#am_status').text(text || '');
}

function looksLikeLegacyGodlogRules(value) {
  const text = String(value || '');
  if (!text.trim()) return false;
  if (/<Nub>[\s\S]*?<\/Nub>/i.test(text) && /<Cond>[\s\S]*?<\/Cond>/i.test(text)) return false;
  return /(?:^|\n)\s*Nub\s*[:：]/i.test(text)
    || /(?:^|\n)\s*Cond\s*[:：]\s*200-?300/i.test(text)
    || /当前这一楼|逐楼记忆记录员/.test(text);
}

function hasGodlogXmlFields(text) {
  const value = String(text || '');
  const hasCond = /(?:<|&lt;)Cond(?:>|&gt;)[\s\S]*?(?:<|&lt;)\/Cond(?:>|&gt;)/i.test(value);
  const hasHeader = /(?:<|&lt;)(?:Nub|Title|Time|Pln|Per)(?:>|&gt;)[\s\S]*?(?:<|&lt;)\/(?:Nub|Title|Time|Pln|Per)(?:>|&gt;)/i.test(value);
  return hasCond && hasHeader;
}

function hasGodlogColonFields(text) {
  const value = String(text || '');
  return /(?:^|\n)\s*Nub\s*[:：]/i.test(value)
    && /(?:^|\n)\s*Cond\s*[:：]/i.test(value)
    && /(?:^|\n)\s*(?:Title|Time|Pln|Per)\s*[:：]/i.test(value);
}

function looksLikeGodlogLeakText(text) {
  const value = String(text || '');
  return /(?:<|&lt;)\/?Godlog(?:>|&gt;)/i.test(value)
    || hasGodlogColonFields(value)
    || hasGodlogXmlFields(value);
}

function stripGodlogFenceBlocks(text) {
  return String(text || '').replace(FENCED_CODE_BLOCK_RE, block => (
    looksLikeGodlogLeakText(block) ? '' : block
  ));
}

function cleanText(text) {
  return stripGodlogBlocks(text)
    .replace(GODLOG_BLOCK_RE, '')
    .replace(GODLOG_ESCAPED_BLOCK_RE, '')
    .replace(GODLOG_FIELD_XML_GROUP_RE, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .trim();
}


function normalizeAnchorBody(text, number) {
  let value = cleanText(stripGodlogFenceBlocks(String(text || '')))
    .replace(/<[^>]+>/g, '')
    .trim();
  const markerIndex = value.search(/\*\*本次新增锚点[：:]?\*\*/i);
  if (markerIndex >= 0) value = value.slice(markerIndex).replace(/^\*\*本次新增锚点[：:]?\*\*\s*/i, '');
  value = value
    .replace(/^###\s*第\s*\d+\s*次锚点记录\s*/im, '')
    .replace(/\n(?:#{1,6}|\*\*【)[\s\S]*$/m, '')
    .replace(/^\|.*\|\s*$/gm, '')
    .trim();
  return `### 第 ${number} 次锚点记录\n\n**本次新增锚点：**\n${value}`.trim();
}

function normalizeMergeBody(text, number) {
  let value = cleanText(stripGodlogFenceBlocks(String(text || '')))
    .replace(/<[^>]+>/g, '')
    .trim();
  const markerIndex = value.search(/\*\*历史锚点简述\*\*/i);
  if (markerIndex >= 0) value = value.slice(markerIndex).replace(/^\*\*历史锚点简述\*\*\s*/i, '');
  value = value
    .replace(/^###\s*第\s*\d+\s*次全量合并锚点\s*/im, '')
    .replace(/\n(?:#{1,6}|\*\*【)[\s\S]*$/m, '')
    .replace(/^\|.*\|\s*$/gm, '')
    .trim();
  return `### 第 ${number} 次全量合并锚点\n\n**历史锚点简述**\n${value}`.trim();
}

function stripGodlogBlocks(text) {
  return stripGodlogFenceBlocks(text)
    .replace(GODLOG_BLOCK_RE, '')
    .replace(GODLOG_ESCAPED_BLOCK_RE, '')
    .replace(GODLOG_FIELD_XML_GROUP_RE, '')
    .trim();
}

function sanitizeMainPromptMemoryText(text) {
  return renderMacros(stripGodlogBlocks(text)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/Anchor Memory｜旧楼层索引摘要/gi, '剧情资料｜旧楼摘要')
    .replace(/Anchor Memory｜旧楼层正文已隐藏/gi, '剧情资料｜旧楼正文已隐藏')
    .replace(/Anchor Memory｜旧用户输入已隐藏/gi, '剧情资料｜旧用户输入已隐藏')
    .replace(/\bAnchor Memory\b/gi, '剧情资料')
    .replace(/&lt;\/?(?:Godlog|Nub|Title|Time|Pln|Per|Cond)&gt;/gi, ' ')
    .replace(/<\/?(?:Godlog|Nub|Title|Time|Pln|Per|Cond)>/gi, ' ')
    .replace(/\bGodlog\b/gi, '逐楼摘要')
    .replace(/(?:^|\n)\s*(?:Nub|Title|Time|Pln|Per|Cond)\s*[:：]\s*/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

function sanitizeOutboundGodlogText(text) {
  if (typeof text !== 'string' || !looksLikeGodlogLeakText(text)) return text;
  return sanitizeMainPromptMemoryText(text);
}

function sanitizeOutboundMessageGodlogLeak(message) {
  if (!message) return false;
  let changed = false;
  if (typeof message.mes === 'string') {
    const next = sanitizeOutboundGodlogText(message.mes);
    if (next !== message.mes) {
      message.mes = next;
      changed = true;
    }
  }
  if (typeof message.content === 'string') {
    const next = sanitizeOutboundGodlogText(message.content);
    if (next !== message.content) {
      message.content = next;
      changed = true;
    }
  } else if (Array.isArray(message.content)) {
    const nextContent = message.content.map(part => {
      if (typeof part === 'string') {
        const next = sanitizeOutboundGodlogText(part);
        if (next !== part) changed = true;
        return next;
      }
      if (part && typeof part.text === 'string') {
        const next = sanitizeOutboundGodlogText(part.text);
        if (next !== part.text) {
          changed = true;
          return { ...part, text: next };
        }
      }
      return part;
    });
    if (changed) message.content = nextContent;
  }
  return changed;
}

function sanitizePromptReadyGodlogLeaks(promptChat) {
  if (!Array.isArray(promptChat)) return 0;
  let changed = 0;
  for (const message of promptChat) {
    if (sanitizeOutboundMessageGodlogLeak(message)) changed++;
  }
  return changed;
}

function hasGodlogFenceBlock(text) {
  return (String(text || '').match(FENCED_CODE_BLOCK_RE) || [])
    .some(block => looksLikeGodlogLeakText(block));
}

function hasGodlogBlock(text) {
  const value = String(text || '');
  return /<Godlog>[\s\S]*?<\/Godlog>/i.test(value)
    || /&lt;Godlog&gt;[\s\S]*?&lt;\/Godlog&gt;/i.test(value)
    || hasGodlogFenceBlock(value)
    || hasGodlogXmlFields(value);
}

function stripGodlogFromMessageRecord(message) {
  if (!message) return false;
  let changed = false;
  if (hasGodlogBlock(message.mes)) {
    message.mes = stripGodlogBlocks(message.mes);
    changed = true;
  }
  if (Array.isArray(message.swipes)) {
    for (let index = 0; index < message.swipes.length; index++) {
      if (!hasGodlogBlock(message.swipes[index])) continue;
      message.swipes[index] = stripGodlogBlocks(message.swipes[index]);
      changed = true;
    }
  }
  return changed;
}

function cleanupUserGodlogBlocks() {
  const chat = getContext().chat || [];
  let changed = false;
  for (let index = 0; index < chat.length; index++) {
    const message = chat[index];
    if (!message?.is_user) continue;
    const rowChanged = stripGodlogFromMessageRecord(message);
    if (rowChanged) refreshMessageBlock(index);
    changed = rowChanged || changed;
  }
  if (changed) saveChatNow();
  return changed;
}

function normalizeGodlogBlock(body) {
  const text = String(body || '').trim();
  if (!text) return '';
  const match = text.match(/<Godlog>[\s\S]*?<\/Godlog>/i);
  if (match) {
    const block = match[0].trim();
    if (/<Nub>[\s\S]*?<\/Nub>/i.test(block)) return block;
    const converted = normalizeLegacyGodlogFields(block);
    return converted || block;
  }
  const converted = normalizeLegacyGodlogFields(text);
  if (converted) return converted;
  return `<Godlog>\n${text}\n</Godlog>`;
}

function legacyGodlogFieldValue(text, field) {
  const fieldPattern = GODLOG_FIELD_NAMES.join('|');
  const pattern = new RegExp(`(?:^|\\n)\\s*${field}\\s*[:：]\\s*([\\s\\S]*?)(?=\\n\\s*(?:${fieldPattern})\\s*[:：]|$)`, 'i');
  const match = String(text || '').match(pattern);
  return match ? match[1].trim() : '';
}

function normalizeLegacyGodlogFields(text) {
  const inner = String(text || '')
    .replace(/^\s*<Godlog>\s*/i, '')
    .replace(/\s*<\/Godlog>\s*$/i, '')
    .trim();
  if (!/(?:^|\n)\s*Nub\s*[:：]/i.test(inner)) return '';
  const values = GODLOG_FIELD_NAMES.map(field => [field, legacyGodlogFieldValue(inner, field)]);
  if (values.filter(([, value]) => value).length < 3) return '';
  return `<Godlog>\n${values.map(([field, value]) => `<${field}>${value || '未明'}</${field}>`).join('\n')}\n</Godlog>`;
}

function replaceGodlogField(block, tag, value) {
  const text = normalizeGodlogBlock(block);
  const safeValue = String(value || '').trim();
  if (!text || !safeValue) return text;
  const pattern = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'i');
  if (pattern.test(text)) return text.replace(pattern, `<${tag}>${safeValue}</${tag}>`);
  return text.replace(/<\/Godlog>\s*$/i, `<${tag}>${safeValue}</${tag}>\n</Godlog>`);
}

function plainGodlogText(body) {
  const block = normalizeGodlogBlock(body);
  if (!block) return '';
  const fields = GODLOG_FIELD_NAMES.map(tag => {
    const match = block.match(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'i'));
    if (!match) return '';
    const value = match[0].replace(new RegExp(`^<${tag}>|<\\/${tag}>$`, 'gi'), '').trim();
    return value ? `${tag}: ${value}` : '';
  }).filter(Boolean);
  if (fields.length > 0) return fields.join('\n');
  return block.replace(/<\/?Godlog>/gi, '').replace(/<\/?[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function safeGodlogMemoryText(body) {
  const title = godlogFieldValue(body, 'Title');
  const time = godlogFieldValue(body, 'Time');
  const place = godlogFieldValue(body, 'Pln');
  const people = godlogFieldValue(body, 'Per');
  const content = godlogFieldValue(body, 'Cond') || plainGodlogText(body);
  const parts = [];
  if (title) parts.push(`事件：${title}`);
  if (time || place) parts.push(`时地：${[time, place].filter(Boolean).join(' / ')}`);
  if (people) parts.push(`人物：${people}`);
  if (content) parts.push(`经过：${content}`);
  return sanitizeMainPromptMemoryText(parts.join('\n'));
}

function safePromptMemoryText(kind, item, limit = 1800) {
  if (!item) return '';
  const text = kind === 'godlog'
    ? safeGodlogMemoryText(item.body || '')
    : cleanText(item.body || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/^\s*>?\s*(?:\uD83D\uDCD6\s*)?(?:场景|剧情|逐楼)?摘要\s*[：:·].*$/gm, '')
      .replace(/^\s*[-*]?\s*(?:场景|剧情|逐楼)?摘要\s*[：:·].*$/gm, '')
      .trim();
  return clampText(sanitizeMainPromptMemoryText(text), limit);
}

function safeCodexText(text, limit = 2200) {
  return clampText(sanitizeMainPromptMemoryText(cleanText(text)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*>?\s*(?:\uD83D\uDCD6\s*)?(?:场景|剧情|逐楼)?摘要\s*[：:·].*$/gm, '')
    .replace(/^\s*[-*]?\s*(?:场景|剧情|逐楼)?摘要\s*[：:·].*$/gm, '')
    .trim()), limit);
}

function stableHash(input) {
  let hash = 2166136261;
  const text = String(input || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function scheduleMessageKeySave() {
  if (state.messageKeySaveTimer) return;
  state.messageKeySaveTimer = setTimeout(() => {
    state.messageKeySaveTimer = null;
    saveChatNow();
  }, 800);
}

function persistentMessageIdentity(message) {
  return message?.send_date
    || message?.extra?.message_id
    || message?.message_id
    || message?.extra?.id
    || message?.id
    || message?.created_at
    || '';
}

function stableFallbackMessageKey(message, index) {
  if (!message || typeof message !== 'object') return '';
  try {
    if (!message.anchor_memory_meta || typeof message.anchor_memory_meta !== 'object') {
      message.anchor_memory_meta = {};
    }
    const meta = message.anchor_memory_meta;
    if (!meta.stableMessageKey) {
      // Always adopt a plugin-owned key, even when SillyTavern currently exposes send_date/id.
      // Those host fields may be attached or normalized after generation; preferring them made the
      // same floor suddenly look like a different row after prompt-injection metadata was saved.
      meta.stableMessageKey = makeStableMessageKey({
        persistentIdentity: persistentMessageIdentity(message),
        role: messageRole(message),
        index,
        uuid: globalThis.crypto?.randomUUID?.() || '',
      });
      scheduleMessageKeySave();
    }
    return String(meta.stableMessageKey || '');
  } catch {
    return '';
  }
}

function messageKey(message, index) {
  // A floor has one plugin-owned identity for its whole lifetime. Host IDs, send_date, prompt
  // injection bookkeeping, hidden flags and later render metadata must never re-key a completed
  // summary. Actual content revisions are tracked separately by rawHash.
  return stableFallbackMessageKey(message, index)
    || `legacy:${index}:${messageRole(message)}:${stableHash(message?.name || '')}`;
}

function memoryHideMeta(message) {
  const meta = message?.anchor_memory_meta;
  return meta && typeof meta === 'object' ? meta : null;
}

function isMemoryManagedHidden(message) {
  const meta = memoryHideMeta(message);
  return !!(
    meta?.hiddenByMemory
    || (Array.isArray(meta?.hiddenAnchorIds) && meta.hiddenAnchorIds.length > 0)
  );
}

function isNarrativeMessage(message) {
  // SillyTavern's official hide implementation may mark a hidden chat message as `is_system`.
  // Messages hidden by this extension remain narrative source material and must still be visible to
  // the memory indexer, while genuine system messages must never become role-play floors.
  return !!message && (!message.is_system || isMemoryManagedHidden(message));
}

function messageRole(message) {
  if (message?.is_user) return 'user';
  if (message?.is_system && !isMemoryManagedHidden(message)) return 'system';
  return 'assistant';
}

function turnTextForAssistant(chat, index) {
  const parts = [];
  let start = index;
  for (let i = index - 1; i >= 0; i--) {
    const message = chat[i];
    if (!message || !isNarrativeMessage(message)) continue;
    if (!message.is_user) break;
    start = i;
  }
  for (let i = start; i <= index; i++) {
    const message = chat[i];
    if (!message || !isNarrativeMessage(message) || !message.mes) continue;
    const text = cleanText(message.mes);
    if (!text) continue;
    const role = message.is_user ? '用户输入' : 'AI回复';
    // Hidden state is deliberately ignored here. Hiding is only a prompt/UI policy and must never
    // change the source fingerprint, otherwise refreshes invalidate perfectly valid summaries.
    parts.push(`【${role}｜第${i + 1}楼｜${message.name || '未命名'}】
${text}`);
  }
  return parts.join('\n\n');
}

function invalidateMemoryDataCache() {
  state.memoryMetadataRef = null;
  state.memoryDataRef = null;
  state.memoryDataReady = false;
  state.recallTermCache.clear();
}

function invalidateRuntimeCaches(reason = '') {
  state.chatRowsCache.clear();
  state.chatCacheRef = null;
  state.chatCacheLength = -1;
  state.chatCacheTailSignature = '';
  state.godlogIndexData = null;
  state.godlogIndexArray = null;
  state.godlogIndexLength = -1;
  state.godlogByKey = new Map();
  if (reason) console.debug?.('[AnchorMemory] runtime cache invalidated:', reason);
}

function chatTailSignature(chat) {
  const last = chat?.[chat.length - 1];
  if (!last) return `${chat?.length || 0}:empty`;
  const text = String(last.mes || '');
  return [
    chat.length,
    last.send_date || last.message_id || last.id || '',
    text.length,
    stableHash(text),
    last.is_hidden ? 1 : 0,
    last.is_user ? 1 : 0,
    isMemoryManagedHidden(last) ? 1 : 0,
  ].join(':');
}

function ensureChatRowsCacheFresh(chat) {
  const signature = chatTailSignature(chat);
  if (state.chatCacheRef !== chat
      || state.chatCacheLength !== chat.length
      || state.chatCacheTailSignature !== signature) {
    state.chatRowsCache.clear();
    state.chatCacheRef = chat;
    state.chatCacheLength = chat.length;
    state.chatCacheTailSignature = signature;
  }
}

function chatRows(includeHidden = false, includeUser = false) {
  const chat = getContext().chat || [];
  ensureChatRowsCacheFresh(chat);
  const cacheKey = `${includeHidden ? 1 : 0}:${includeUser ? 1 : 0}`;
  const cached = state.chatRowsCache.get(cacheKey);
  if (cached) return cached;

  const rows = [];
  let assistantNumber = 0;
  for (let index = 0; index < chat.length; index++) {
    const message = chat[index];
    if (!message || !isNarrativeMessage(message) || !message.mes) continue;
    const role = messageRole(message);
    // Count every narrative assistant floor before display filtering so the Nub value remains stable
    // even when old messages are hidden by SillyTavern or Anchor Memory.
    if (role === 'assistant') assistantNumber++;
    if (!includeHidden && (message.is_hidden || isMemoryManagedHidden(message))) continue;
    if (!includeUser && message.is_user) continue;
    const text = cleanText(message.mes);
    if (!text) continue;
    const turnText = message.is_user ? text : turnTextForAssistant(chat, index);
    rows.push({
      index,
      key: messageKey(message, index),
      role,
      name: message.name || '',
      text,
      turnText,
      rawHash: stableHash(turnText || text),
      sendDate: message.send_date || '',
      assistantNumber: message.is_user ? 0 : assistantNumber,
    });
  }
  state.chatRowsCache.set(cacheKey, rows);
  return rows;
}

function godlogIndex(data) {
  const list = data?.godlogs || [];
  if (state.godlogIndexData !== data
      || state.godlogIndexArray !== list
      || state.godlogIndexLength !== list.length) {
    state.godlogIndexData = data;
    state.godlogIndexArray = list;
    state.godlogIndexLength = list.length;
    state.godlogByKey = new Map();
    for (const item of list) {
      if (item && !item.archived && item.key) state.godlogByKey.set(item.key, item);
    }
  }
  return state.godlogByKey;
}

function godlogForRow(data, row) {
  if (!row?.key) return null;
  return godlogIndex(data).get(row.key) || null;
}

function godlogNumberForRow(row) {
  if (!row) return 0;
  return Math.max(0, Number(row.assistantNumber) || 0);
}

function syncGodlogNumber(item, row) {
  if (!item || !row) return false;
  const number = godlogNumberForRow(row);
  if (!number) return false;
  let changed = false;
  if (Number(item.number) !== number) {
    item.number = number;
    changed = true;
  }
  if (item.body) {
    const nextBody = replaceGodlogField(item.body, 'Nub', String(number));
    if (nextBody !== item.body) {
      item.body = nextBody;
      changed = true;
    }
  }
  return changed;
}

function syncGodlogCount(data) {
  const numbers = (data.godlogs || [])
    .filter(item => !item.archived && Number.isFinite(Number(item.number)))
    .map(item => Number(item.number));
  data.processing.godlogCount = numbers.length ? Math.max(...numbers) : 0;
}

function isGodlogReady(item, row = null) {
  // Completed summaries are durable snapshots. A later prompt injection, render refresh, tool
  // payload, swipe metadata update or even a deliberate text edit must not silently turn the card
  // into “missing” and start a background rewrite. The user explicitly chooses when to replace it
  // through “重跑本楼摘要” or by editing/saving the summary.
  if (!isCompletedSummary(item)) return false;
  if (row && item.archived) return false;
  return true;
}


function isGodlogMissingOrStale(data, row) {
  const item = godlogForRow(data, row);
  if (!item) return true;
  if (item.status === 'failed') {
    const s = settings();
    return !!(s.useSecondary && s.secondaryUrl && s.secondaryKey && (item.retryCount || 0) < 3);
  }
  if (item.status === 'orphaned') return false;
  return !isGodlogReady(item, row);
}

function upsertGodlog(data, row, patch = {}) {
  let item = godlogForRow(data, row);
  const number = godlogNumberForRow(row) || data.processing.godlogCount + 1;
  if (!item) {
    item = {
      id: `am_godlog_${Date.now()}_${row.index}_${stableHash(row.key).slice(0, 6)}`,
      kind: 'godlog',
      number,
      floor: row.index,
      key: row.key,
      role: row.role,
      name: row.name,
      sendDate: row.sendDate,
      rawHash: row.rawHash,
      body: '',
      status: 'pending',
      retryCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: '',
    };
    data.godlogs.push(item);
  }
  Object.assign(item, {
    number,
    floor: row.index,
    role: row.role,
    name: row.name,
    sendDate: row.sendDate,
    rawHash: row.rawHash,
    updatedAt: Date.now(),
  }, patch);
  if (item.body) item.body = replaceGodlogField(item.body, 'Nub', String(item.number));
  syncGodlogCount(data);
  return item;
}

function validGodlogMaterials(data) {
  return chatRows(true)
    .filter(row => row.role === 'assistant')
    .map(row => ({ row, godlog: godlogForRow(data, row), mode: 'godlog' }))
    .filter(({ row, godlog }) => isGodlogReady(godlog, row));
}

function blockedRebuildGodlogRows(data) {
  return chatRows(true)
    .filter(row => row.role === 'assistant')
    .filter(row => !isGodlogReady(godlogForRow(data, row), row));
}

function anchorMaterialForRow(data, row) {
  const godlog = godlogForRow(data, row);
  return isGodlogReady(godlog, row) ? { row, godlog, mode: 'godlog' } : null;
}

function pendingAnchorMaterials(data) {
  refreshCoverageMaps(data);
  const anchored = data.processing.anchoredKeys || {};
  const merged = data.processing.mergedKeys || {};
  const materials = [];
  // Only a chronological ready prefix may become an anchor. Never skip a missing floor and never
  // use raw正文 as a silent fallback, otherwise the 15-summary boundary becomes non-deterministic.
  for (const row of chatRows(true).filter(item => item.role === 'assistant')) {
    if (merged[row.key] || anchored[row.key]) continue;
    const material = anchorMaterialForRow(data, row);
    if (!material) break;
    materials.push(material);
  }
  return materials;
}

function readyGodlogMemoryItems(data) {
  return (data?.godlogs || [])
    .filter(item => item?.status === 'ready' && item.body && !item.stale);
}

function pendingRows(data) {
  refreshCoverageMaps(data);
  return chatRows(true)
    .filter(row => row.role === 'assistant')
    .filter(row => !data.processing.mergedKeys[row.key] && !data.processing.anchoredKeys[row.key]);
}

function pendingGodlogRows(data) {
  return chatRows(true)
    .filter(row => row.role === 'assistant')
    .filter(row => isGodlogMissingOrStale(data, row));
}

function hasPendingMemoryWork() {
  if (!hasPersistentChatContext()) return false;
  const data = memoryData();
  const anchorInterval = Math.max(1, Number(settings().anchorInterval) || 15);
  const mergeInterval = Math.max(1, Number(settings().mergeInterval) || 100);
  return pendingGodlogRows(data).length > 0
    || pendingAnchorMaterials(data).length >= anchorInterval
    || mergeCycleMaterials(data).length >= mergeInterval
    || !!data.processing?.codexDirty
    || !!data.processing?.relationshipDirty
    || pendingCodexRows(data).length > 0;
}

function pendingCodexRows(data) {
  if (data.processing?.codexDirty) return [];
  if (!settings().useSecondary || !settings().secondaryUrl || !settings().secondaryKey) return [];
  const codexKeys = data.processing?.codexKeys || {};
  return chatRows(true)
    .filter(row => row.role === 'assistant')
    .map(row => ({ row, godlog: godlogForRow(data, row) }))
    .filter(({ row, godlog }) => isGodlogReady(godlog, row) && codexKeys[row.key] !== summaryRevisionHash(godlog, row));
}

function missingGodlogRepairRows(data) {
  return chatRows(true)
    .filter(row => row.role === 'assistant')
    .filter(row => !isGodlogReady(godlogForRow(data, row), row));
}

function missingGodlogDiagnostics(data) {
  const rows = chatRows(true).filter(row => row.role === 'assistant');
  return rows
    .map((row, index) => {
      const item = godlogForRow(data, row);
      if (isGodlogReady(item, row)) return null;
      const newerAssistantCount = rows.length - index - 1;
      const hardFailed = item?.status === 'failed' || (item?.retryCount || 0) >= 3;
      const hasError = !!item?.error;
      const late = newerAssistantCount >= MISSING_GODLOG_WARNING_MIN_NEWER;
      if (!hardFailed && !hasError && !late) return null;
      return { row, item, newerAssistantCount, status: item?.status || 'missing' };
    })
    .filter(Boolean);
}

function newerAssistantCountForRow(row) {
  if (!row) return 0;
  return chatRows(true).filter(candidate => candidate.role === 'assistant' && candidate.index > row.index).length;
}

function missingGodlogUiStatus(row, data = memoryData()) {
  const item = row ? godlogForRow(data, row) : null;
  if (item?.status) return item.status;
  const hasSecondary = !!(settings().useSecondary && settings().secondaryUrl && settings().secondaryKey);
  if (!hasSecondary) return 'missing';
  return newerAssistantCountForRow(row) >= MISSING_GODLOG_WARNING_MIN_NEWER ? 'missing' : 'pending';
}

function missingGodlogUiText(row, data = memoryData()) {
  const status = missingGodlogUiStatus(row, data);
  if (status === 'pending') return '正文已完成，逐楼摘要正在后台生成或排队。';
  if (!settings().useSecondary || !settings().secondaryUrl || !settings().secondaryKey) return '尚未生成逐楼摘要；配置副API后可自动补写。';
  return '这楼已经落后仍无有效摘要；点“自动补写缺失摘要”会调用模型补写。';
}

function syntheticGodlogId(row) {
  return `am_missing_godlog_${stableHash(row?.key || row?.index || '')}`;
}

function rowFromSyntheticGodlogId(id) {
  const value = String(id || '');
  if (!value.startsWith('am_missing_godlog_')) return null;
  return chatRows(false).find(row => syntheticGodlogId(row) === value) || null;
}

function godlogListEntries(data) {
  const stored = (data.godlogs || []).map(item => ({ item, synthetic: false }));
  const storedKeys = new Set(stored.map(({ item }) => item.key));
  const missing = missingGodlogRepairRows(data)
    .filter(row => !storedKeys.has(row.key))
    .map(row => ({
      synthetic: true,
      row,
      item: {
        id: syntheticGodlogId(row),
        number: godlogNumberForRow(row),
        floor: row.index,
        key: row.key,
        role: row.role,
        name: row.name,
        sendDate: row.sendDate,
        rawHash: row.rawHash,
        body: '',
        status: missingGodlogUiStatus(row, data),
        error: missingGodlogUiText(row, data),
      },
    }));
  return [...stored, ...missing];
}

function maybeWarnMissingGodlogs(data = memoryData()) {
  if (!settings().enabled) return;
  const issues = missingGodlogDiagnostics(data);
  if (issues.length === 0) {
    state.lastMissingGodlogWarningSignature = '';
    return;
  }

  const signature = issues
    .map(({ row, item, status }) => `${row.key}:${row.rawHash}:${status}:${item?.retryCount || 0}:${item?.error || ''}`)
    .join('|');
  const now = Date.now();
  if (
    signature === state.lastMissingGodlogWarningSignature
    && now - state.lastMissingGodlogWarningAt < MISSING_GODLOG_WARNING_COOLDOWN
  ) {
    return;
  }

  state.lastMissingGodlogWarningSignature = signature;
  state.lastMissingGodlogWarningAt = now;

  const floors = issues.slice(0, 4).map(({ row }) => `第 ${row.index + 1} 楼`).join('、');
  const suffix = issues.length > 4 ? `等 ${issues.length} 楼` : '';
  const canRetry = !!(settings().useSecondary && settings().secondaryUrl && settings().secondaryKey);
  const retryText = canRetry
    ? '插件会继续自动重试；点这里打开“逐楼摘要”，也可以点“自动补写缺失摘要”立即重跑。'
    : '先补全副API；点这里打开“逐楼摘要”，配置后点“自动补写缺失摘要”即可自动重跑。';
  const currentSettings = settings();
  const message = `${floors}${suffix} 没有生成逐楼摘要。${retryText}在摘要补齐前，该楼不会进入每 ${currentSettings.anchorInterval} 个有效AI回合的分段锚点或每 ${currentSettings.mergeInterval} 个有效AI回合的累计合并；若它已超过最近原文窗口，主模型只会看到“摘要缺失”状态，不会重新收到完整旧正文。`;

  console.warn('[AnchorMemory] missing Godlog rows detected:', issues.map(({ row, item }) => ({
    floor: row.index + 1,
    status: item?.status || 'missing',
    error: item?.error || '',
  })));
  if (toastr?.warning) {
    toastr.warning(message, 'Anchor Memory', {
      timeOut: 14000,
      extendedTimeOut: 8000,
      onclick: () => {
        openWorkbench();
        activateTab('summaries');
      },
    });
  } else {
    showStatus(message);
  }
}

function formatGodlogMaterials(materials) {
  return (materials || [])
    .map(item => {
      const { row, godlog } = item || {};
      if (!row || !godlog?.body) return '';
      const label = `#${row.index} ${row.sendDate ? `[${row.sendDate}] ` : ''}${row.name || '未命名'}`;
      return `${label}
${godlog.body}`;
    })
    .filter(Boolean)
    .join('\n\n---\n\n');
}

function anchorSourcePosition(anchor, rowIndex = null) {
  const positions = (anchor?.sourceKeys || [])
    .map(key => rowIndex?.get(key))
    .filter(Number.isFinite);
  if (positions.length) return Math.min(...positions);
  const floors = (anchor?.sourceFloors || []).filter(Number.isFinite);
  return floors.length ? Math.min(...floors) : Number.MAX_SAFE_INTEGER;
}

function activeAnchors(data) {
  const rowIndex = new Map(chatRows(true).map(row => [row.key, row.index]));
  return (data?.anchors || [])
    .filter(item => item && !item.stale && item.active !== false)
    .sort((a, b) => anchorSourcePosition(a, rowIndex) - anchorSourcePosition(b, rowIndex) || (a.createdAt || 0) - (b.createdAt || 0));
}

function renumberDerivedMemory(data) {
  if (!data) return false;
  let changed = false;
  const sortedAnchors = activeAnchors(data);
  if (sortedAnchors.length === (data.anchors || []).length) data.anchors = sortedAnchors;
  data.anchors.forEach((anchor, index) => {
    const number = index + 1;
    if (Number(anchor.number) !== number) {
      anchor.number = number;
      anchor.body = String(anchor.body || '').replace(/^###\s*第\s*\d+\s*次锚点记录/m, `### 第 ${number} 次锚点记录`);
      changed = true;
    }
  });
  data.merges.sort((a, b) => (Number(a.coverageCount) || Number(a.floorAt) || 0) - (Number(b.coverageCount) || Number(b.floorAt) || 0) || (a.createdAt || 0) - (b.createdAt || 0));
  data.merges.forEach((merge, index) => {
    const number = index + 1;
    if (Number(merge.number) !== number) {
      merge.number = number;
      merge.body = String(merge.body || '').replace(/^###\s*第\s*\d+\s*次全量合并锚点/m, `### 第 ${number} 次全量合并锚点`);
      changed = true;
    }
  });
  data.processing.anchorCount = data.anchors.length;
  data.processing.mergeCount = data.merges.length;
  return changed;
}

function activeMerges(data) {
  return (data?.merges || []).filter(item => item && !item.stale && item.active !== false);
}

function latestAnchor(data) {
  const list = activeAnchors(data);
  return list[list.length - 1] || null;
}

function latestMerge(data) {
  const list = activeMerges(data);
  return list[list.length - 1] || null;
}

function latestMergeKeySet(data) {
  return new Set(latestMerge(data)?.sourceKeys || []);
}

function activeAnchorsAfterMerge(data) {
  const merged = latestMergeKeySet(data);
  return activeAnchors(data).filter(anchor => {
    const keys = anchor.sourceKeys || [];
    return keys.length > 0 && keys.some(key => !merged.has(key));
  });
}

function mergeCycleMaterials(data) {
  const merged = latestMergeKeySet(data);
  const result = [];
  for (const row of chatRows(true).filter(item => item.role === 'assistant')) {
    if (merged.has(row.key)) continue;
    const godlog = godlogForRow(data, row);
    if (!isGodlogReady(godlog, row)) break;
    result.push({ row, godlog, mode: 'godlog' });
  }
  return result;
}

function clampText(text, maxChars) {
  const value = String(text || '').trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[trimmed]`;
}

function clampTextHeadTail(text, maxChars, headRatio = 0.34) {
  const value = String(text || '').trim();
  const limit = Math.max(200, Number(maxChars) || 0);
  if (value.length <= limit) return value;
  const marker = '\n...[中段因上下文预算省略；保留开端与最近剧情]...\n';
  const available = Math.max(1, limit - marker.length);
  const head = Math.max(1, Math.floor(available * Math.min(0.75, Math.max(0.15, headRatio))));
  const tail = Math.max(1, available - head);
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`;
}

function buildRebuildTimelineSource(data, materials, maxChars = 42000) {
  const full = formatGodlogMaterials(materials || []);
  const limit = Math.max(4000, Number(maxChars) || 42000);
  if (full.length <= limit) return full;

  // For very long chats, keep the cumulative/15-turn compressed spine plus both the opening and
  // latest detailed Godlogs. The latest raw-window turns must be present here as summaries as well;
  // buildCoreInjection() intentionally omits them for normal prompt injection and is therefore not
  // suitable as a rebuild source by itself.
  const compact = [];
  const merge = latestMerge(data);
  if (merge?.body) compact.push(`## 累计历史锚点\n${safePromptMemoryText('merge', merge, 14000)}`);
  for (const anchor of activeAnchorsAfterMerge(data)) {
    if (anchor?.body) compact.push(`## 第 ${anchor.number} 次锚点\n${safePromptMemoryText('anchor', anchor, 6500)}`);
  }
  const compactText = compact.join('\n\n');
  if (!compactText) return clampTextHeadTail(full, limit, 0.3);
  const compactBudget = Math.min(17000, Math.floor(limit * 0.42));
  const detailBudget = Math.max(3000, limit - compactBudget - 80);
  return [
    clampTextHeadTail(compactText, compactBudget, 0.3),
    `## 开端与最近逐楼摘要\n${clampTextHeadTail(full, detailBudget, 0.3)}`,
  ].filter(Boolean).join('\n\n');
}

function renderMacros(text, ctx = getContext()) {
  const charName = String(ctx?.name2 || '{{char}}');
  const userName = String(ctx?.name1 || '{{user}}');
  return String(text || '')
    .replace(/\{\{\s*char\s*\}\}/gi, charName)
    .replace(/\{\{\s*user\s*\}\}/gi, userName);
}

function renderTemplate(text) {
  return renderMacros(text);
}

function sectionFrom(markdown, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\*\\*【[^】]*${escaped}[^】]*】\\*\\*([\\s\\S]*?)(?=\\n\\*\\*【|$)`, 'i');
  const match = String(markdown || '').match(pattern);
  return match ? match[0].trim() : '';
}

function valueAfterLabel(markdown, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(markdown || '').match(new RegExp(`\\*\\*${escaped}[:：]\\*\\*\\s*([^\\n]+)`));
  return match ? match[1].trim() : '';
}



function usefulCodexValue(value) {
  const text = cleanText(value).trim();
  if (!text) return '';
  if (/^(?:未明|暂无|无|无变化|不变|未记录)[。.]?$/i.test(text)) return '';
  return text;
}

function usefulCodexSection(section) {
  const text = String(section || '').trim();
  if (!text) return '';
  const body = text
    .replace(/^\s*\*\*【[^】]+】\*\*\s*/i, '')
    .trim();
  if (!body || /^(?:暂无|无|无变化|不变|未记录)[。.]?$/i.test(body)) return '';
  if (parseMarkdownTable(text).length === 0 && /^(?:\|.*\|\s*)+$/m.test(body)) return '';
  return text;
}

function markdownTableOnly(headers, rows) {
  const safeCell = value => cleanText(String(value ?? ''))
    .replace(/\|/g, '／')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const header = `| ${headers.join(' | ')} |`;
  const divider = `| ${headers.map(() => ':---').join(' | ')} |`;
  const body = (rows || []).map(row => `| ${headers.map(key => safeCell(row?.[key] || '')).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

function markdownTableSection(title, headers, rows) {
  return [`**【${title}】**`, markdownTableOnly(headers, rows)].join('\n');
}

function entityNameMatches(left, right) {
  const a = normalizeEntityMatchText(left);
  const b = normalizeEntityMatchText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  return min >= 3 && (a.includes(b) || b.includes(a));
}

function tableRowName(row) {
  return row?.['角色名'] || row?.['人物'] || row?.['名称'] || row?.['姓名'] || '';
}

function sanitizeCharacterMemoSection(data, incomingSection) {
  const headers = ['角色名', '身份/标签', '原始楼层', '触发事件', '心态转变', '当前变化'];
  const tracked = trackedCharacterNames(data);
  const userName = getContext().name1 || '';
  const currentRows = parseMarkdownTable(data?.codex?.characterMemo || '');
  const incomingRows = parseMarkdownTable(incomingSection || '');
  const findRow = (rows, name) => rows.find(row => entityNameMatches(tableRowName(row), name));
  const result = [];
  for (const name of tracked) {
    let row = findRow(incomingRows, name) || findRow(currentRows, name);
    if (row && entityNameMatches(tableRowName(row), userName)) row = null;
    result.push({
      '角色名': name,
      '身份/标签': row?.['身份/标签'] || row?.['身份标签'] || '未明',
      '原始楼层': row?.['原始楼层'] || row?.['首次/来源'] || '未明',
      '触发事件': row?.['触发事件'] || '暂无明确变化',
      '心态转变': row?.['心态转变'] || '暂无明确变化',
      '当前变化': row?.['当前变化'] || '暂无明确变化',
    });
  }
  if (result.length === 0) return '';
  return markdownTableSection('人物纪要', headers, result);
}

function firstTableValue(row, exactKeys = [], includes = []) {
  for (const key of exactKeys) {
    if (row?.[key]) return row[key];
  }
  const entries = Object.entries(row || {});
  for (const needle of includes) {
    const match = entries.find(([key, value]) => value && String(key).includes(needle));
    if (match) return match[1];
  }
  return '';
}

function sanitizePeopleIndexSection(data, incomingSection) {
  const ctx = getContext();
  const userName = ctx.name1 || '{{user}}';
  const trackedLabel = trackedCharacterLabel(data, ctx);
  const headers = ['角色名', '身份/标签', '当前状态与核心作用', `与${userName}的关系`, `与${trackedLabel}的关系`];
  const tracked = trackedCharacterNames(data, ctx);
  const keepNpcRow = row => {
    const name = tableRowName(row);
    if (!name || entityNameMatches(name, userName)) return false;
    return !tracked.some(charName => entityNameMatches(name, charName));
  };
  let rows = parseMarkdownTable(incomingSection || '').filter(keepNpcRow);
  if (rows.length === 0) rows = parseMarkdownTable(data?.codex?.peopleIndex || '').filter(keepNpcRow);
  if (rows.length === 0) return '';
  const normalized = rows.map(row => ({
    '角色名': tableRowName(row),
    '身份/标签': firstTableValue(row, ['身份/标签', '身份标签', '身份'], ['身份']) || '未明',
    '当前状态与核心作用': firstTableValue(row, ['当前状态与核心作用', '当前状态', '核心作用'], ['当前状态', '核心作用']) || '未明',
    [headers[3]]: firstTableValue(row,
      [headers[3], `与${userName}的关系和交集`, '与{{user}}的关系', '与{{user}}的关系和交集', '与用户的关系', '与用户的关系和交集'],
      [`与${userName}`, '与{{user}}', '与用户']) || '未明',
    [headers[4]]: firstTableValue(row,
      [headers[4], `与${ctx.name2 || '{{char}}'}的关系`, '与{{char}}的关系', '与主角的关系'],
      [`与${trackedLabel}`, `与${ctx.name2 || '{{char}}'}`, '与{{char}}', '与主角']) || '未明',
  }));
  return markdownTableSection('出场人物库', headers, normalized);
}

function sanitizeItemIndexSection(data, incomingSection) {
  const headers = ['物品/细节/内部梗', '绑定人物', '核心象征意义与影响'];
  let rows = parseMarkdownTable(incomingSection || '');
  if (rows.length === 0) rows = parseMarkdownTable(data?.codex?.itemIndex || '');
  if (rows.length === 0) return '';
  const tombstones = data?.entities?.itemTombstones || {};
  const normalized = rows.map(row => ({
    '物品/细节/内部梗': firstTableValue(row, ['物品/细节/内部梗', '物品', '细节', '内部梗'], ['物品', '细节', '内部梗']),
    '绑定人物': firstTableValue(row, ['绑定人物', '相关人物', '持有者'], ['绑定', '人物', '持有']) || '未明',
    '核心象征意义与影响': firstTableValue(row, ['核心象征意义与影响', '象征意义与影响', '核心意义', '影响'], ['象征', '意义', '影响']) || '未明',
  })).filter(row => row['物品/细节/内部梗'] && !tombstones[entityKey(row['物品/细节/内部梗'])]);
  return normalized.length ? markdownTableSection('重要道具、梗与核心细节', headers, normalized) : '';
}

function sanitizeSceneIndexSection(data, incomingSection) {
  const headers = ['场景/地点', '时间', '人物', '已发生事实'];
  let rows = parseMarkdownTable(incomingSection || '');
  if (rows.length === 0) rows = parseMarkdownTable(data?.codex?.sceneIndex || '');
  if (rows.length === 0) return '';
  const tombstones = data?.entities?.sceneTombstones || {};
  const normalized = rows.map(row => ({
    '场景/地点': firstTableValue(row, ['场景/地点', '场景', '地点', '名称'], ['场景', '地点']),
    '时间': firstTableValue(row, ['时间', '剧情时间'], ['时间']) || '未明',
    '人物': firstTableValue(row, ['人物', '出场人物'], ['人物']) || '未明',
    '已发生事实': firstTableValue(row, ['已发生事实', '事实', '事件'], ['事实', '事件']) || '未明',
  })).filter(row => row['场景/地点'] && !tombstones[entityKey(row['场景/地点'])]);
  return normalized.length ? markdownTableSection('场景记录', headers, normalized) : '';
}

function ensureEntityState(data) {
  if (!data.entities || typeof data.entities !== 'object') data.entities = {};
  if (!data.entities.items || typeof data.entities.items !== 'object') data.entities.items = { byKey: {}, order: [], updatedAt: 0 };
  if (!data.entities.scenes || typeof data.entities.scenes !== 'object') data.entities.scenes = { byKey: {}, order: [], updatedAt: 0 };
  if (!data.entities.itemTombstones || typeof data.entities.itemTombstones !== 'object') data.entities.itemTombstones = {};
  if (!data.entities.sceneTombstones || typeof data.entities.sceneTombstones !== 'object') data.entities.sceneTombstones = {};
  return data.entities;
}

function syncEntityLedgers(data, options = {}) {
  const entities = ensureEntityState(data);
  const itemRows = parseMarkdownTable(data.codex?.itemIndex || '').map(row => ({
    name: firstTableValue(row, ['物品/细节/内部梗', '物品', '细节', '内部梗'], ['物品', '细节', '内部梗']),
    boundTo: firstTableValue(row, ['绑定人物', '相关人物', '持有者'], ['绑定', '人物', '持有']),
    meaning: firstTableValue(row, ['核心象征意义与影响', '象征意义与影响', '核心意义', '影响'], ['象征', '意义', '影响']),
  })).filter(row => row.name);
  const sceneRows = parseMarkdownTable(data.codex?.sceneIndex || '').map(row => ({
    name: firstTableValue(row, ['场景/地点', '场景', '地点', '名称'], ['场景', '地点']),
    time: firstTableValue(row, ['时间', '剧情时间'], ['时间']),
    people: firstTableValue(row, ['人物', '出场人物'], ['人物']),
    facts: firstTableValue(row, ['已发生事实', '事实', '事件'], ['事实', '事件']),
  })).filter(row => row.name);

  if (options.manualItems) {
    for (const row of itemRows) delete entities.itemTombstones[entityKey(row.name)];
  }
  if (options.manualScenes) {
    for (const row of sceneRows) delete entities.sceneTombstones[entityKey(row.name)];
  }
  entities.items = buildItemLedger(itemRows, entities.items, entities.itemTombstones);
  entities.scenes = buildSceneLedger(sceneRows, entities.scenes, entities.sceneTombstones);
  return entities;
}

function markManualEntityDeletions(data, kind, beforeMarkdown, afterMarkdown) {
  const entities = ensureEntityState(data);
  const beforeRows = parseMarkdownTable(beforeMarkdown || '');
  const afterRows = parseMarkdownTable(afterMarkdown || '');
  const selector = kind === 'items'
    ? row => firstTableValue(row, ['物品/细节/内部梗', '物品', '细节', '内部梗'], ['物品', '细节', '内部梗'])
    : row => firstTableValue(row, ['场景/地点', '场景', '地点', '名称'], ['场景', '地点']);
  const removed = diffRemovedEntityKeys(beforeRows, afterRows, selector);
  const tombstones = kind === 'items' ? entities.itemTombstones : entities.sceneTombstones;
  for (const key of removed) tombstones[key] = { at: Date.now(), reason: '用户手动删除，禁止被旧摘要自动复活' };
  return removed.length;
}

function ensureTimelineState(data) {
  if (!data.timeline || typeof data.timeline !== 'object') data.timeline = clonePlainObject(defaultData().timeline);
  if (!Array.isArray(data.timeline.warnings)) data.timeline.warnings = [];
  if (!Array.isArray(data.timeline.history)) data.timeline.history = [];
  return data.timeline;
}

function refreshTimelineFromGodlogs(data) {
  const timeline = ensureTimelineState(data);
  const manual = timeline.manualOverride && typeof timeline.manualOverride === 'object' ? timeline.manualOverride : null;
  const minimumFloor = manual && Number.isFinite(Number(manual.floor)) ? Number(manual.floor) : -1;
  const entries = (data.godlogs || [])
    .filter(item => item && item.status === 'ready' && !item.stale && !item.archived && item.body)
    .filter(item => Number(item.floor ?? -1) > minimumFloor)
    .sort((a, b) => Number(a.floor ?? -1) - Number(b.floor ?? -1))
    .map(item => ({
      key: item.key || '',
      floor: Number(item.floor ?? -1),
      time: godlogFieldValue(item.body, 'Time'),
      title: godlogFieldValue(item.body, 'Title'),
      body: godlogFieldValue(item.body, 'Cond'),
    }));
  const next = rebuildTimelineState(entries, manual ? {
    currentTime: manual.currentTime || '',
    sourceKey: manual.sourceKey || '',
    floor: minimumFloor,
  } : {});
  next.manualOverride = manual;
  data.timeline = next;
  if (next.currentRaw && next.currentRaw !== '未明') data.codex.currentTime = next.currentRaw;

  if (manual?.currentPlace) {
    data.codex.currentPlace = manual.currentPlace;
  } else {
    const latestPlace = [...(data.godlogs || [])]
      .filter(item => item && item.status === 'ready' && !item.stale && !item.archived && item.body)
      .sort((a, b) => Number(b.floor ?? -1) - Number(a.floor ?? -1))
      .map(item => godlogFieldValue(item.body, 'Pln'))
      .find(value => usefulCodexValue(value));
    if (latestPlace) data.codex.currentPlace = latestPlace;
  }
  return next;
}

function refreshCodexFromPatch(data, markdown) {
  let changed = false;
  const patch = String(markdown || '').trim();
  if (!patch) return false;

  const currentTime = usefulCodexValue(valueAfterLabel(patch, '当前时间'));
  const currentPlace = usefulCodexValue(valueAfterLabel(patch, '当前地点'));
  const rawCharacterMemo = usefulCodexSection(sectionFrom(patch, '人物纪要') || sectionFrom(patch, '角色成长'));
  const rawPeopleIndex = usefulCodexSection(sectionFrom(patch, '出场人物库') || sectionFrom(patch, '人物库'));
  const characterMemo = sanitizeCharacterMemoSection(data, rawCharacterMemo);
  const peopleIndex = sanitizePeopleIndexSection(data, rawPeopleIndex);
  const itemIndex = sanitizeItemIndexSection(data, usefulCodexSection(sectionFrom(patch, '重要道具') || sectionFrom(patch, '核心细节')));
  const sceneIndex = sanitizeSceneIndexSection(data, usefulCodexSection(sectionFrom(patch, '场景记录') || sectionFrom(patch, '场景')));

  const assign = (key, value) => {
    if (!value || data.codex[key] === value) return;
    data.codex[key] = value;
    changed = true;
  };

  assign('currentTime', currentTime);
  assign('currentPlace', currentPlace);
  assign('characterMemo', characterMemo);
  assign('peopleIndex', peopleIndex);
  assign('itemIndex', itemIndex);
  assign('sceneIndex', sceneIndex);
  syncEntityLedgers(data);
  refreshTimelineFromGodlogs(data);
  return changed;
}


function hasMarkdownTableSkeleton(section) {
  const lines = String(section || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('|') && line.endsWith('|'));
  if (lines.length < 2) return false;
  const separatorCells = lines[1].split('|').slice(1, -1).map(cell => cell.trim());
  return separatorCells.length > 0 && separatorCells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function validateCodexPatchStructure(data, markdown) {
  const patch = String(markdown || '').trim();
  if (patch.length < 220) throw new Error('状态索引返回内容过短，疑似被截断；旧索引已保留');
  if (/```/.test(patch)) throw new Error('状态索引返回了代码块，格式不符合要求；旧索引已保留');
  if (!/\*\*当前时间[:：]\*\*\s*[^\n]+/.test(patch)) throw new Error('状态索引缺少“当前时间”字段；旧索引已保留');
  if (!/\*\*当前地点[:：]\*\*\s*[^\n]+/.test(patch)) throw new Error('状态索引缺少“当前地点”字段；旧索引已保留');

  const sections = [
    ['人物关系', relationshipSection(patch)],
    ['人物纪要', sectionFrom(patch, '人物纪要') || sectionFrom(patch, '角色成长')],
    ['出场人物库', sectionFrom(patch, '出场人物库') || sectionFrom(patch, '人物库')],
    ['重要道具', sectionFrom(patch, '重要道具') || sectionFrom(patch, '核心细节')],
    ['场景记录', sectionFrom(patch, '场景记录') || sectionFrom(patch, '场景')],
  ];
  for (const [label, section] of sections) {
    if (!section) throw new Error(`状态索引缺少“${label}”分区；旧索引已保留`);
    if (!hasMarkdownTableSkeleton(section)) throw new Error(`状态索引的“${label}”表格不完整；旧索引已保留`);
  }

  const expectedRows = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '').rows.length;
  if (parseMarkdownTable(relationshipSection(patch)).length < expectedRows) {
    throw new Error('人物关系表缺少固定名单中的角色，疑似输出被截断；旧索引已保留');
  }
  return true;
}

function baseApiUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions\/?$/i, '')
    .replace(/\/embeddings\/?$/i, '')
    .replace(/\/models\/?$/i, '');
}

async function callSecondary(messages, maxTokens = 2400) {
  const s = settings();
  const base = baseApiUrl(s.secondaryUrl);

  const requestOnce = async (requestMessages, tokenBudget) => {
    const request = state.requests.create('secondary');
    const controller = request.controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { controller.abort('secondary-timeout'); } catch { controller.abort(); }
    }, 120 * 1000);
    let response;
    try {
      response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          chat_completion_source: 'openai',
          reverse_proxy: base,
          proxy_password: s.secondaryKey,
          model: s.secondaryModel || undefined,
          messages: requestMessages,
          temperature: 0.25,
          max_tokens: tokenBudget,
          stream: false,
        }),
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        if (timedOut) throw new Error('副API请求超过120秒，已自动中止并释放摘要队列');
        throw new Error('副API请求已因切换聊天、刷新页面或取消任务而中止；结果不会写入任何聊天');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      request.cleanup();
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Secondary API ${response.status}: ${errText.slice(0, 180)}`);
    }
    const raw = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { content: raw.trim(), finishReason: '' };
    }
    return {
      content: (parsed.choices?.[0]?.message?.content || parsed.content || '').trim(),
      finishReason: String(
        parsed.choices?.[0]?.finish_reason
        || parsed.finish_reason
        || parsed.stop_reason
        || '',
      ).toLowerCase(),
    };
  };

  const truncatedReasons = new Set(['length', 'max_tokens', 'max_output_tokens', 'token_limit']);
  let result = await requestOnce(messages, maxTokens);
  if (truncatedReasons.has(result.finishReason)) {
    const retryBudget = Math.min(12000, Math.max(maxTokens + 1200, Math.ceil(maxTokens * 1.5)));
    const retryMessages = messages.map((message, index) => (
      index === 0 && message?.role === 'system'
        ? {
            ...message,
            content: `${message.content}
The previous attempt was cut off by the output-token limit. Regenerate the complete result from the beginning, keep every required field/section, and compress wording enough to finish within the budget.`,
          }
        : message
    ));
    result = await requestOnce(retryMessages, retryBudget);
    if (truncatedReasons.has(result.finishReason)) {
      throw new Error(`副API连续两次因输出上限被截断（${maxTokens} → ${retryBudget} tokens）；本次结果未保存，将保留任务等待重跑`);
    }
  }
  return result.content;
}

async function callWriter(prompt, maxTokens = 3200) {
  const s = settings();
  if (s.useSecondary && s.secondaryUrl && s.secondaryKey) {
    return callSecondary([
      { role: 'system', content: 'You are a precise narrative memory archivist. Output only the requested Markdown.' },
      { role: 'user', content: prompt },
    ], maxTokens);
  }
  throw new Error('锚点/合并后台整理需要先配置并启用副API；为避免把记忆整理提示词发送给主模型，本版本不再使用主模型静默整理。');
}

async function callSummaryWriter(prompt, maxTokens = 1000) {
  const s = settings();
  if (!s.useSecondary || !s.secondaryUrl || !s.secondaryKey) {
    throw new Error('逐楼摘要需要先配置并启用副API');
  }
  return callSecondary([
    { role: 'system', content: 'You are a precise Godlog narrative summarizer. Return only the requested XML fields for the background task. Never use Markdown code fences and never write content intended for the visible chat reply.' },
    { role: 'user', content: prompt },
  ], maxTokens);
}

function buildGodlogPrompt(data, row, item = null) {
  const previous = validGodlogMaterials(data)
    .filter(item => item.row.index < row.index)
    .slice(-3)
    .map(({ godlog }) => godlog.body)
    .join('\n\n---\n\n') || '（暂无上一楼摘要）';
  const hasUserInput = /【用户输入｜/.test(row.turnText || '');
  const openingInstruction = hasUserInput
    ? '当前回合包含用户输入与随后的AI回复。'
    : '当前回合没有用户输入，这是首条AI开场楼或单独AI楼；必须直接总结这条AI回复里的开场设定、已发生动作、地点、人物状态和可确认信息，不要因为缺少用户输入而输出空内容。';
  const canon = buildCanonContextBlock(data, row, null, 5200);

  return `${renderTemplate(settings().godlogRules || DEFAULT_GODLOG_RULES)}

请只为当前回合写 Godlog。通常当前回合 = 用户输入 + 随后的AI回复；如果没有用户输入，则当前回合 = 这条AI开场/AI回复本身。Godlog 只返回给本次后台摘要任务，插件会单独渲染静态摘要卡；不要把 Godlog 写回 AI 回复正文，不要使用 Markdown 代码块，不要总结其他回合，不要输出HTML标签。

身份与关系判定边界：
- 角色卡、角色书、世界书是稳定身份和既有关系的最高依据；当前楼只记录“这一楼发生了什么”。
- 不要因为某人做了医疗行为就改写职业，不要因为本楼出现某人就写“初次见面”。
- 如果设定里已有身份/关系，沿用设定；如果设定和本楼冲突，把本楼当作临时表象或冲突线索，不要直接覆盖稳定身份。

## 当前回合判定
${openingInstruction}

## 角色卡/世界书/上文硬依据
${canon}

## 上三楼摘要（仅供对齐剧情，不要复述）
${clampText(previous, 2200)}

## 当前已知剧情定位（只作线索；原文冲突时以原文为准）
时间：${data.codex.currentTime || '未明'}
地点：${data.codex.currentPlace || '未明'}

## 当前楼层标识
Nub: ${item?.number || godlogNumberForRow(row) || data.processing.godlogCount + 1}
Role: ${row.role}
Name: ${row.name || '未命名'}
SendDate: ${row.sendDate || '未记录'}

## 当前回合原文（唯一剧情事实来源）
${row.turnText || row.text}`;
}

function buildCodexPatchPrompt(data, row, godlog) {
  const ctx = getContext();
  const charName = trackedCharacterLabel(data, ctx);
  const trackedNames = trackedCharacterNames(data, ctx);
  const userName = ctx.name1 || '{{user}}';
  const floor = row.index + 1;
  const currentFacts = safeGodlogMemoryText(godlog.body || '');
  const canon = buildCanonContextBlock(data, row, godlog, 7600);

  return `你是长篇角色扮演的后台记忆索引员。你只更新插件内部索引，不写聊天正文，不和玩家对话。

任务：根据“角色卡/世界书/上文硬依据”、“当前楼层事实”和“已有索引”，输出更新后的完整索引。只记录已经发生的内容，不预测，不评价模型表现，不写代码块，不输出 XML/HTML。

本聊天人物纪要追踪白名单：${trackedNames.join('、') || charName}
玩家名（绝对禁止写入人物纪要）：${userName}

${renderMemoryRules(settings().characterRules || DEFAULT_CHARACTER_RULES, data, ctx)}

${renderMemoryRules(settings().peopleRules || DEFAULT_PEOPLE_RULES, data, ctx)}

${renderMemoryRules(settings().itemRules || DEFAULT_ITEM_RULES, data, ctx)}

事实优先级：
1. 角色卡、角色书、世界书、已有索引里的稳定身份与既有关系优先级最高。
2. 当前楼层事实只用于更新本楼发生的事件、情绪变化、临时状态和新交集。
3. 如果当前楼层没有明确说“第一次见面/初次见面/刚认识”，禁止写初次见面；只能写“本索引首次记录于第 ${floor} 楼”或“本楼同场出现/本楼互动”。
4. 禁止从职业动作反推稳定身份。例如会治疗、在医院、被称 doctor，不等于身份一定是医生；若角色卡写 ${charName} 是总裁/家族成员/其他身份，必须沿用角色卡。
5. 禁止把介绍句的关系主体写反。比如“${charName} 介绍 ${userName} 是朋友”只能说明 ${charName} 对家人这样介绍 ${userName}，不能写成母亲主动认定或两人初见。
6. 如果角色卡/世界书已经明确写出某角色的职业或身份，就必须沿用该身份；任何已知身份都不能被“未明”覆盖。

规则：
- 【人物关系】是固定名单表。名称列与行数由用户控制，必须逐字保留当前提供的名称和顺序；禁止新增、删除、改名或交换行。每一行都表示“该名称对应人物 ↔ ${userName}”的关系。
- “过去”用一句话概括最初可确认的关系状态；一旦形成就保持稳定，除非当前有效剧情证明早期状态需要纠正。
- “发展”用一句话概括从过去到当前的主要推进过程，只写已经发生的关键节点，不罗列流水账。
- “当前”用一句话概括此刻最核心的关系、矛盾、依赖或拉扯状态。当前楼没有关系变化时，原样保留该行三列。
- 人物纪要只允许出现白名单中的角色：${trackedNames.join('、') || charName}。一人一行，禁止出现 ${userName}，禁止出现NPC或配角。即使模型认为玩家也发生了成长，也必须放弃该行。
- 如果本楼没有白名单角色的真实心理/关系/行为模式变化，保留该角色上一版，不得用 ${userName} 或其他人物补位。
- 出场人物库只记录白名单主角与 ${userName} 之外的重要NPC、配角；白名单主角和玩家不得出现在该表中。如果当前楼出现或明确提及了新人，要立刻入库，但身份/关系必须先查硬依据。
- 物品与核心细节只记录会推动剧情、关系、伏笔或反复出现的内容；已有条目未在本楼出现时必须保留，禁止因本楼未提及而丢失。
- 场景记录按地点合并：同一地点只保留一行并更新其最近确认时间与事实；已有地点未在本楼出现时保留，禁止重复建项。
- 场景记录只写当前已经确认的时间、地点、人物状态与发生事实。
- 表格必须至少保留表头和一行内容；未知写“未明”，不要留空。

输出必须严格包含以下结构：

**【人物关系】**
| 名称 | 过去 | 发展 | 当前 |
| :--- | :--- | :--- | :--- |
${relationshipTableMarkdown(data.relationshipTable, true).split('\n').slice(2).join('\n')}

**当前时间：** 剧情内时间；无法判断写“未明”
**当前地点：** 地点；无法判断写“未明”

**【人物纪要】**
| 角色名 | 身份/标签 | 原始楼层 | 触发事件 | 心态转变 | 当前变化 |
| :--- | :--- | :--- | :--- | :--- | :--- |

**【出场人物库】**
| 角色名 | 身份/标签 | 当前状态与核心作用 | 与${userName}的关系 | 与${charName}的关系 |
| :--- | :--- | :--- | :--- | :--- |

**【重要道具、梗与核心细节】**
| 物品/细节/内部梗 | 绑定人物 | 核心象征意义与影响 |
| :--- | :--- | :--- |

**【场景记录】**
| 场景/地点 | 时间 | 人物 | 已发生事实 |
| :--- | :--- | :--- | :--- |

## 角色卡/世界书/上文硬依据
${canon}

## 固定人物关系表（只允许更新三列，名称列和行数不可改）
${relationshipTableMarkdown(data.relationshipTable, true)}

## 已有人物纪要
${data.codex.characterMemo || '（暂无）'}

## 已有出场人物库
${data.codex.peopleIndex || '（暂无）'}

## 已有物品与核心细节
${data.codex.itemIndex || '（暂无）'}

## 已有场景记录
${data.codex.sceneIndex || '（暂无）'}

## 当前楼层事实
第 ${floor} 楼 / ${row.name || '未命名'}
${currentFacts || cleanText(row.turnText || row.text)}`;
}

async function updateCodexFromGodlog(data, row, godlog, force = false) {
  if (!data || !row || !godlog || godlog.status !== 'ready' || !godlog.body) return false;
  const s = settings();
  if (!s.useSecondary || !s.secondaryUrl || !s.secondaryKey) return false;
  if (data.processing?.codexDirty && !force) {
    scheduleCodexBacklog();
    return false;
  }
  if (!data.processing.codexKeys) data.processing.codexKeys = {};
  const revisionHash = summaryRevisionHash(godlog, row);
  if (!force && data.processing.codexKeys[row.key] === revisionHash) return false;
  const contextToken = captureChatContextToken(data);

  try {
    const patch = await callSecondary([
      { role: 'system', content: 'You update private roleplay memory indexes for a background task. Output only the requested Markdown tables. Never write visible chat content.' },
      { role: 'user', content: buildCodexPatchPrompt(data, row, godlog) },
    ], 3000);
    if (!isSameChatContext(contextToken)) return false;
    validateCodexPatchStructure(data, patch);

    // Build the whole update on a detached candidate. No active index/table is modified until every
    // required section and every fixed relationship row has passed validation.
    const relationshipWasDirty = !!data.processing?.relationshipDirty;
    const candidate = {
      codex: normalizedCodex(clonePlainObject(data.codex)),
      relationshipTable: normalizeRelationshipTable(
        clonePlainObject(data.relationshipTable),
        data.codex?.relationship || '',
      ),
      processing: {
        ...data.processing,
        codexKeys: { ...(data.processing.codexKeys || {}) },
      },
    };

    const changed = refreshCodexFromPatch(candidate, patch);
    let relationResult = { found: false, matched: 0, unexpected: 0, changed: false, complete: false };
    // A dirty relationship table is rebuilt from the complete surviving timeline by its dedicated
    // job. Incremental rows may still update the other indexes, but must not clear that dirty flag.
    if (!relationshipWasDirty) {
      relationResult = applyRelationshipPatch(candidate, patch, row, {
        recordEvenIfUnchanged: false,
        requireComplete: true,
        preserveKnownOnUnknown: true,
      });
      if (!relationResult.complete) {
        throw new Error('人物关系表包含缺行、额外行或重复行；旧索引与旧关系表已完整保留');
      }
    }

    snapshotCodex(data, '逐楼状态索引提交前备份');
    data.codex = candidate.codex;
    syncEntityLedgers(data);
    refreshTimelineFromGodlogs(data);
    if (!relationshipWasDirty) {
      data.relationshipTable = candidate.relationshipTable;
      data.processing.relationshipDirty = candidate.processing.relationshipDirty;
      data.processing.relationshipDirtyReason = candidate.processing.relationshipDirtyReason;
      data.processing.relationshipDirtyAt = candidate.processing.relationshipDirtyAt;
      data.processing.relationshipLastGoodAt = candidate.processing.relationshipLastGoodAt;
      data.processing.relationshipRebuildFailures = candidate.processing.relationshipRebuildFailures;
    }
    data.processing.codexKeys[row.key] = revisionHash;
    data.processing.codexDirty = false;
    data.processing.codexDirtyReason = '';
    data.processing.codexDirtyAt = 0;
    data.processing.codexLastGoodAt = Date.now();
    data.processing.codexRebuildFailures = 0;
    data.processing.lastError = '';
    if (godlog.floor !== undefined) {
      data.processing.lastCodexFloor = Math.max(Number(data.processing.lastCodexFloor || -1), Number(godlog.floor));
    }
    saveMemory(true);
    if (data.processing?.relationshipDirty || data.processing?.codexDirty) scheduleCodexBacklog(4);
    return changed || relationResult.changed;
  } catch (err) {
    if (!isSameChatContext(contextToken)) return false;
    console.warn('[AnchorMemory] codex patch failed', err);
    data.processing.lastError = `状态索引未提交：${err.message}`;
    markCodexDirty(data, `增量状态索引未提交：${err.message}`, false);
    markRelationshipDirty(data, `增量人物关系未提交：${err.message}`);
    saveMemory();
    scheduleCodexBacklog(4);
    return false;
  }
}

async function processCodexBacklog(limit = 4) {
  if (state.codexRunning) return false;
  const data = memoryData();
  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  const rows = pendingCodexRows(data).slice(0, limit);
  if (rows.length === 0) return true;

  state.codexRunning = true;
  data.processing.codexBusy = true;
  saveMemory();

  let completed = 0;
  try {
    for (const { row, godlog } of rows) {
      if (!isSameChatContext(contextToken)) return false;
      const before = data.processing?.codexKeys?.[row.key] || '';
      await updateCodexFromGodlog(data, row, godlog);
      if (!isSameChatContext(contextToken)) return false;
      const revisionHash = summaryRevisionHash(godlog, row);
      if (data.processing?.codexKeys?.[row.key] === revisionHash && before !== revisionHash) completed++;
    }
    return true;
  } finally {
    if (state.contextEpoch === operationEpoch) state.codexRunning = false;
    if (!isSameChatContext(contextToken)) return;
    data.processing.codexBusy = false;
    saveMemory();
    updatePreview();
    if (data.processing?.codexDirty
      || data.processing?.relationshipDirty
      || (completed > 0 && pendingCodexRows(data).length > 0)) {
      scheduleCodexBacklog(limit);
    }
  }
}

async function rebuildCodexFromGodlogs(confirmFirst = true) {
  const s = settings();
  if (!s.useSecondary || !s.secondaryUrl || !s.secondaryKey) {
    if (confirmFirst) toastr?.warning?.('请先配置并启用副API，人物索引重建需要后台模型。', 'Anchor Memory');
    return false;
  }
  if (state.codexRunning || state.summaryRunning || state.running) {
    if (confirmFirst) toastr?.warning?.('后台记忆任务正在运行，稍后再重建人物索引。', 'Anchor Memory');
    return false;
  }
  const data = memoryData();
  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  const blockedRows = blockedRebuildGodlogRows(data);
  if (blockedRows.length > 0) {
    const preview = blockedRows.slice(0, 5).map(row => `第${row.index + 1}楼`).join('、');
    markCodexDirty(data, `等待 ${blockedRows.length} 楼逐楼摘要完成后再安全重建`, false);
    markRelationshipDirty(data, `等待 ${blockedRows.length} 楼逐楼摘要完成后再按完整时间线重建`);
    saveMemory(true);
    if (confirmFirst) toastr?.warning?.(`${preview}${blockedRows.length > 5 ? '等' : ''}尚无有效逐楼摘要。为避免遗漏关系发展，暂不覆盖现有索引。`, 'Anchor Memory');
    return false;
  }
  const materials = validGodlogMaterials(data).sort((a, b) => a.row.index - b.row.index);
  if (materials.length === 0) {
    // Never erase a previously valid codex merely because summaries are temporarily unavailable.
    // This can happen during chat restore, upgrade migration, or while a changed floor is waiting
    // to be re-summarized.
    markCodexDirty(data, '当前没有可用于重建的有效逐楼摘要', false);
    saveMemory(true);
    if (confirmFirst) toastr?.warning?.('当前没有有效逐楼摘要；原人物/物品/场景索引已保留，未执行清空。', 'Anchor Memory');
    return false;
  }
  if (confirmFirst && !confirm(`将根据当前有效记忆一次性重建人物/物品/场景索引，共 ${materials.length} 条逐楼摘要。继续？`)) return false;

  state.codexRunning = true;
  data.processing.codexBusy = true;
  saveMemory();
  showStatus('正在一次性重建人物索引');

  try {
    const source = buildRebuildTimelineSource(data, materials, 42000);
    const ctx = getContext();
    const charName = trackedCharacterLabel(data, ctx);
    const trackedNames = trackedCharacterNames(data, ctx);
    const userName = ctx.name1 || '{{user}}';
    const fixedRelationship = relationshipTableMarkdown(relationshipSchemaOnly(data.relationshipTable), true);
    const prompt = `你是长篇角色扮演的后台状态索引员。根据当前仍然有效的剧情记忆，重建一份“当前状态快照”。只记录已经发生且仍有效的事实，不预测，不输出代码块或HTML。\n\n人物纪要追踪白名单只有：${trackedNames.join('、') || charName}。人物纪要必须一人一行，绝对禁止出现玩家 ${userName}；出场人物库则绝对禁止出现白名单主角和玩家。\n\n${renderMemoryRules(settings().characterRules || DEFAULT_CHARACTER_RULES, data, ctx)}\n\n${renderMemoryRules(settings().peopleRules || DEFAULT_PEOPLE_RULES, data, ctx)}\n\n${renderMemoryRules(settings().itemRules || DEFAULT_ITEM_RULES, data, ctx)}\n\n【人物关系】是用户定义的固定名单：只允许填写“过去/发展/当前”三列，必须保留名称列、行数和顺序，不得新增、删除或改名。每一行均表示该人物与${userName}的关系。\n\n输出严格包含：\n\n**【人物关系】**\n${fixedRelationship}\n\n**当前时间：** 剧情内时间；无法判断写“未明”\n**当前地点：** 地点；无法判断写“未明”\n\n**【人物纪要】**\n| 角色名 | 身份/标签 | 原始楼层 | 触发事件 | 心态转变 | 当前变化 |\n| :--- | :--- | :--- | :--- | :--- | :--- |\n\n**【出场人物库】**\n| 角色名 | 身份/标签 | 当前状态与核心作用 | 与${userName}的关系 | 与${charName}的关系 |\n| :--- | :--- | :--- | :--- | :--- |\n\n**【重要道具、梗与核心细节】**\n| 物品/细节/内部梗 | 绑定人物 | 核心象征意义与影响 |\n| :--- | :--- | :--- |\n\n**【场景记录】**\n| 场景/地点 | 时间 | 人物 | 已发生事实 |\n| :--- | :--- | :--- | :--- |\n\n## 当前有效剧情记忆\n${source}`;
    const patch = await callSecondary([
      { role: 'system', content: 'Rebuild a private roleplay state index from valid memory. Output only the requested Markdown structure.' },
      { role: 'user', content: prompt },
    ], 4200);
    if (!isSameChatContext(contextToken)) return false;
    validateCodexPatchStructure(data, patch);

    const candidateHolder = {
      codex: { ...defaultData().codex },
      relationshipTable: relationshipSchemaOnly(data.relationshipTable),
      trackedCharacters: [...(data.trackedCharacters || [])],
      processing: { ...defaultData().processing },
    };
    refreshCodexFromPatch(candidateHolder, patch);
    const relationResult = applyRelationshipPatch(candidateHolder, patch, null, { clearDirty: false, requireComplete: true });
    if (!relationResult.complete || relationResult.matched !== normalizeRelationshipTable(data.relationshipTable).rows.length) {
      throw new Error('副API没有严格返回固定人物关系表，或包含额外/重复行；原关系表未被替换');
    }
    if (!validateCodexCandidate(candidateHolder.codex, patch)) {
      throw new Error('副API返回的状态索引为空、被截断或格式不完整，原索引未被替换');
    }
    commitCodexReplacement(data, candidateHolder.codex, materials, '完整重建成功前备份');
    commitRelationshipReplacement(data, candidateHolder.relationshipTable, materials[materials.length - 1]?.row || null);
    data.processing.lastCodexFloor = materials[materials.length - 1]?.row?.index ?? -1;
    saveMemory(true);
    updatePreview();
    if (confirmFirst) toastr?.success?.('人物/物品/场景索引已按当前有效记忆重建', 'Anchor Memory');
    return true;
  } catch (err) {
    if (!isSameChatContext(contextToken)) return false;
    data.processing.lastError = err.message;
    data.processing.codexRebuildFailures = Number(data.processing.codexRebuildFailures || 0) + 1;
    markCodexDirty(data, `索引重建失败：${err.message}`, false);
    saveMemory();
    if (confirmFirst) toastr?.error?.(`人物索引重建失败：${err.message}`, 'Anchor Memory');
    return false;
  } finally {
    if (state.contextEpoch === operationEpoch) state.codexRunning = false;
    if (!isSameChatContext(contextToken)) return;
    data.processing.codexBusy = false;
    saveMemory(true);
    showStatus(statusText(memoryData()));
  }
}

async function rebuildRelationshipFromGodlogs(confirmFirst = true) {
  const s = settings();
  if (!s.useSecondary || !s.secondaryUrl || !s.secondaryKey) {
    if (confirmFirst) toastr?.warning?.('请先配置并启用副API，人物关系表需要后台模型填写。', 'Anchor Memory');
    return false;
  }
  if (state.codexRunning || state.summaryRunning || state.running) {
    if (confirmFirst) toastr?.warning?.('后台记忆任务正在运行，稍后再重建人物关系表。', 'Anchor Memory');
    return false;
  }
  const data = memoryData();
  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  const blockedRows = blockedRebuildGodlogRows(data);
  if (blockedRows.length > 0) {
    const preview = blockedRows.slice(0, 5).map(row => `第${row.index + 1}楼`).join('、');
    markRelationshipDirty(data, `等待 ${blockedRows.length} 楼逐楼摘要完成后再按完整时间线重建`);
    saveMemory(true);
    if (confirmFirst) toastr?.warning?.(`${preview}${blockedRows.length > 5 ? '等' : ''}尚无有效逐楼摘要。固定名单和最后安全关系不会被覆盖。`, 'Anchor Memory');
    return false;
  }
  const materials = validGodlogMaterials(data).sort((a, b) => a.row.index - b.row.index);
  if (materials.length === 0) {
    markRelationshipDirty(data, '当前没有可用于重建人物关系的有效逐楼摘要');
    saveMemory(true);
    if (confirmFirst) toastr?.warning?.('当前没有有效逐楼摘要；固定名单已保留，关系内容未被覆盖。', 'Anchor Memory');
    return false;
  }
  if (confirmFirst && !confirm(`将按当前有效剧情重建固定人物关系表，共 ${materials.length} 条逐楼摘要。继续？`)) return false;

  state.codexRunning = true;
  data.processing.codexBusy = true;
  saveMemory();
  showStatus('正在按当前楼层重建人物关系表');
  try {
    const latestRow = materials[materials.length - 1]?.row || null;
    const canon = buildCanonContextBlock(data, latestRow, materials[materials.length - 1]?.godlog || null, 7600);
    const source = buildRebuildTimelineSource(data, materials, 38000);
    const fixed = relationshipTableMarkdown(relationshipSchemaOnly(data.relationshipTable), true);
    const userName = renderMacros('{{user}}');
    const prompt = `你是长篇角色扮演的后台人物关系追踪员。请根据当前仍然有效的剧情记忆，重建固定关系表。\n\n硬规则：\n1. 每一行表示“名称中的人物 ↔ ${userName}”的关系。\n2. 名称列、行数和顺序由用户固定，必须逐字保留；禁止新增、删除、改名、合并或交换行。\n3. 过去：一句话概括最初可确认的关系状态。\n4. 发展：一句话概括关系推进中的关键变化。\n5. 当前：一句话概括目前最核心的关系与拉扯状态。\n6. 只写已经发生且有依据的内容，不预测；无法确认写“未明”。\n7. 只输出指定Markdown表，不输出解释、代码块或其他章节。\n\n**【人物关系】**\n${fixed}\n\n## 角色卡/世界书/上文硬依据\n${canon}\n\n## 当前有效逐楼剧情记忆\n${source}`;
    const patch = await callSecondary([
      { role: 'system', content: 'Fill a fixed private roleplay relationship table. Never add, remove, or rename rows. Output only the requested Markdown table.' },
      { role: 'user', content: prompt },
    ], 2400);
    if (!isSameChatContext(contextToken)) return false;
    const candidate = {
      codex: { ...defaultData().codex },
      relationshipTable: relationshipSchemaOnly(data.relationshipTable),
      processing: { ...defaultData().processing },
    };
    const result = applyRelationshipPatch(candidate, patch, null, { clearDirty: false, requireComplete: true });
    const expected = normalizeRelationshipTable(data.relationshipTable).rows.length;
    if (!result.complete || result.matched !== expected) throw new Error(`关系表返回不完整或含额外/重复行：固定 ${expected} 行，成功匹配 ${result.matched} 行`);
    snapshotCodex(data, '人物关系表重建成功前备份');
    commitRelationshipReplacement(data, candidate.relationshipTable, latestRow);
    saveMemory(true);
    await injectMemory().catch(console.warn);
    updatePreview();
    if (confirmFirst) toastr?.success?.('人物关系表已按当前有效楼层动态重建', 'Anchor Memory');
    return true;
  } catch (err) {
    if (!isSameChatContext(contextToken)) return false;
    data.processing.lastError = err.message;
    data.processing.relationshipRebuildFailures = Number(data.processing.relationshipRebuildFailures || 0) + 1;
    markRelationshipDirty(data, `人物关系重建失败：${err.message}`);
    saveMemory(true);
    if (confirmFirst) toastr?.error?.(`人物关系重建失败：${err.message}`, 'Anchor Memory');
    return false;
  } finally {
    if (state.contextEpoch === operationEpoch) state.codexRunning = false;
    if (!isSameChatContext(contextToken)) return;
    data.processing.codexBusy = false;
    saveMemory(true);
    showStatus(statusText(memoryData()));
  }
}

function scheduleCodexBacklog(limit = 4) {
  if (!settings().useSecondary || !settings().secondaryUrl || !settings().secondaryKey) return;
  if (state.codexTimer) clearTimeout(state.codexTimer);
  state.codexTimer = setTimeout(() => {
    state.codexTimer = null;
    const data = memoryData();
    const task = data.processing?.codexDirty
      ? rebuildCodexFromGodlogs(false)
      : data.processing?.relationshipDirty
        ? rebuildRelationshipFromGodlogs(false)
        : processCodexBacklog(limit);
    Promise.resolve(task).catch(err => console.warn('[AnchorMemory] codex task failed', err));
  }, 900);
}

function buildAnchorPrompt(data, materials) {
  const s = settings();
  const next = data.processing.anchorCount + 1;
  const rows = materials.map(item => item.row);
  const start = rows[0]?.assistantNumber || rows[0]?.index + 1 || 0;
  const end = rows[rows.length - 1]?.assistantNumber || rows[rows.length - 1]?.index + 1 || 0;

  return `你是长篇角色扮演的后台锚点整理员。请只把下面这一批新增逐楼摘要压缩成一个独立锚点。

${renderTemplate(s.anchorRules || DEFAULT_ANCHOR_RULES)}

输出必须严格采用以下结构，不要添加其他章节：

### 第 ${next} 次锚点记录

**本次新增锚点：**
* **[时间] - [事件名称]：** 地点；起因；人物；详细过程；重要物品；结果/影响；核心对话原话（必须注明谁说了什么）。

本批对应 AI 回合：第 ${start}-${end} 回合。

## 本批新增逐楼摘要
${formatGodlogMaterials(materials)}`;
}

function buildMergePrompt(data, plan, force = false) {
  const s = settings();
  const next = data.processing.mergeCount + 1;
  const previousMerge = latestMerge(data)?.body || '（暂无上一次历史锚点，这是第一次全量合并）';
  const blocks = (plan?.blocks || []).map((block, index) => {
    const label = block.kind === 'anchor'
      ? `${Math.max(1, Number(settings().anchorInterval) || 15)}回合锚点：第${block.item?.number || index + 1}次`
      : `逐楼摘要：第${block.row?.assistantNumber || block.row?.index + 1 || index + 1}回合`;
    const body = block.kind === 'anchor'
      ? safePromptMemoryText('anchor', block.item, 6500)
      : safePromptMemoryText('godlog', block.item, 1400);
    return `### ${label}\n${body}`;
  }).join('\n\n---\n\n');

  return `你是长篇角色扮演的后台历史压缩员。请把“上一次历史锚点”和“本周期新增记忆”合并为一份新的累计历史锚点。

${renderTemplate(s.mergeRules || DEFAULT_MERGE_RULES)}

输出必须严格采用以下结构，不要添加其他章节：

### 第 ${next} 次全量合并锚点

**历史锚点简述**
* **[时间段] - [事件名称]：** 起因 -> 核心冲突 -> 结果/影响。关键对话原话保留并注明说话人。

## 上一次历史锚点
${clampText(previousMerge, 14000)}

## 本周期新增记忆（${plan?.sourceKeys?.length || 0}个AI回合${force ? '，手动合并' : ''}）
${clampText(blocks, 26000)}`;
}

function recentNarrativeQuery(chat = getContext().chat || [], limit = 6) {
  return (Array.isArray(chat) ? chat : [])
    .filter(message => message && isNarrativeMessage(message))
    .map(message => outboundMessageText(message))
    .filter(Boolean)
    .slice(-Math.max(1, Number(limit) || 6))
    .join('\n');
}

function normalizeEntityMatchText(text) {
  return String(text || '')
    .toLocaleLowerCase()
    .replace(/[`*_~<>\[\]{}()（）【】「」『』“”‘’'"，。！？、；：:;,.!?/\\|\s-]+/g, '');
}

function entityTokensFromCell(cell) {
  const raw = String(cell || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~]/g, ' ')
    .trim();
  const candidates = new Set([raw]);
  for (const part of raw.split(/[／/、,，;；|()（）【】\[\]：:·•]+/)) {
    if (part.trim()) candidates.add(part.trim());
  }
  for (const part of raw.split(/\s+/)) {
    if (part.trim()) candidates.add(part.trim());
  }
  return [...candidates]
    .map(value => normalizeEntityMatchText(value))
    .filter(value => {
      if (!value || /^(?:未明|暂无|无|未知|角色名|人物)$/.test(value)) return false;
      return /^[a-z0-9]+$/i.test(value) ? value.length >= 3 : value.length >= 2;
    });
}

function selectMentionedTableRows(markdown, query, headerCandidates = [], maxRows = 12) {
  const tableLines = String(markdown || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('|') && line.endsWith('|'));
  if (tableLines.length < 3) return '';
  const headers = tableLines[0].split('|').slice(1, -1).map(cell => cell.trim());
  let keyIndex = headerCandidates
    .map(name => headers.findIndex(header => header === name || header.includes(name)))
    .find(index => index >= 0);
  if (!Number.isInteger(keyIndex) || keyIndex < 0) keyIndex = 0;

  const normalizedQuery = normalizeEntityMatchText(query);
  if (!normalizedQuery) return '';
  const matched = [];
  for (const line of tableLines.slice(2)) {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    const tokens = entityTokensFromCell(cells[keyIndex] || '');
    if (tokens.some(token => normalizedQuery.includes(token))) matched.push(line);
    if (matched.length >= Math.max(1, Number(maxRows) || 12)) break;
  }
  if (matched.length === 0) return '';
  return [tableLines[0], tableLines[1], ...matched].join('\n');
}

function tableWithLimitedRows(markdown, maxRows = 12) {
  const lines = String(markdown || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const tableLines = lines.filter(line => line.startsWith('|') && line.endsWith('|'));
  if (tableLines.length < 3) return '';
  return [...tableLines.slice(0, 2), ...tableLines.slice(2, 2 + Math.max(1, Number(maxRows) || 12))].join('\n');
}

function relationshipInjectionBlock(data) {
  if (data.processing?.relationshipDirty) {
    return '（人物关系表正在按当前有效剧情安全重建，本次不注入可能过期的旧关系）';
  }
  const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  const rows = table.rows.filter(row => row.past || row.development || row.current);
  if (rows.length === 0) return '（暂无已确认的人物关系变化）';
  const content = rows.map(row => [
    `### ${renderMacros(row.name)}`,
    `过去：${renderMacros(row.past || '未明')}`,
    `发展：${renderMacros(row.development || '未明')}`,
    `当前：${renderMacros(row.current || '未明')}`,
  ].join('\n')).join('\n\n');
  return clampTextHeadTail(content, RELATIONSHIP_MEMORY_CHAR_BUDGET, 0.34);
}

function anchorEventInjectionBlock(data) {
  const parts = [];
  const anchorInterval = Math.max(1, Number(settings().anchorInterval) || 15);
  const mergeInterval = Math.max(1, Number(settings().mergeInterval) || 100);
  const merge = latestMerge(data);
  parts.push(`**1. 历史锚点简述（累计每 ${mergeInterval} 个有效AI回合）：**`);
  parts.push(merge
    ? safePromptMemoryText('merge', merge, 7600)
    : `（尚未达到 ${mergeInterval} 个有效AI回合，暂无累计历史锚点）`);
  parts.push(`**2. 本次新增锚点（每 ${anchorInterval} 个有效AI回合）：**`);
  const anchors = activeAnchorsAfterMerge(data);
  if (anchors.length === 0) parts.push(`（暂无尚未并入累计历史的 ${anchorInterval} 回合锚点）`);
  else {
    for (const anchor of anchors) {
      // normalizeAnchorBody() already includes the numbered heading. Do not add a second duplicate heading.
      parts.push(safePromptMemoryText('anchor', anchor, 2600));
    }
  }
  return clampTextHeadTail(parts.join('\n\n'), ANCHOR_EVENT_MEMORY_CHAR_BUDGET, 0.3);
}

function matchedPeopleInjectionBlock(data, chat) {
  if (!settings().recallMentionedPeople || data.processing?.codexDirty) return '（人物索引未启用或正在安全重建）';
  const query = recentNarrativeQuery(chat, 6);
  const matched = selectMentionedTableRows(data.codex.peopleIndex, query, ['角色名', '人物'], 12);
  return matched || '（本轮上下文未匹配到需要补充的出场人物）';
}

function importantItemsInjectionBlock(data, chat) {
  if (!settings().injectImportantItems || data.processing?.codexDirty || !data.codex.itemIndex) {
    return '（暂无需要持续带入的重要道具、梗或核心细节）';
  }
  const query = recentNarrativeQuery(chat, 6);
  const matched = selectMentionedTableRows(data.codex.itemIndex, query, ['物品/细节/内部梗', '物品', '细节'], 12);
  // The item ledger already contains only plot-relevant items. Prefer current matches, but retain a
  // bounded ledger fallback so an unmentioned but continuously carried key item is not forgotten.
  return matched || tableWithLimitedRows(data.codex.itemIndex, 10) || '（暂无）';
}

function buildCoreInjection(data, chat = getContext().chat || []) {
  const trackedLabel = trackedCharacterLabel(data);
  const characterMemo = data.processing?.codexDirty
    ? '（人物动态索引正在安全重建，本次不注入可能过期的旧表）'
    : (sanitizeCharacterMemoSection(data, data.codex.characterMemo) || '（暂无明确核心转变）');
  return [
    '锚点记录',
    '使用边界：以下均为已经发生的剧情记忆。直接延续当前正文，不复述资料标题，不写整理说明；若与最近正文冲突，以最近正文为准。',
    '【一. 人物关系】',
    relationshipInjectionBlock(data),
    '【二. 锚点事件】',
    anchorEventInjectionBlock(data),
    `【三. ${trackedLabel} 动态演变（核心转变）】`,
    safeCodexText(characterMemo, 2800),
    '【四. 匹配到的出场人物库】',
    safeCodexText(matchedPeopleInjectionBlock(data, chat), 1800),
    '【五. 重要道具、梗与核心细节】',
    safeCodexText(importantItemsInjectionBlock(data, chat), 1800),
  ].join('\n\n');
}

function buildRecentFactsInjection(data, rows = chatRows(true)) {
  state.lastRecentFactsMeta = [];
  refreshCoverageMaps(data);
  const recentRawKeys = new Set(rows
    .filter(row => row.role === 'assistant')
    .slice(-Math.max(1, Number(settings().keepRecent) || 3))
    .map(row => row.key));
  const coveredKeys = new Set([
    ...Object.keys(data.processing?.mergedKeys || {}),
    ...Object.keys(data.processing?.anchoredKeys || {}),
  ]);
  const entries = rows
    .filter(row => row.role === 'assistant')
    .filter(row => !recentRawKeys.has(row.key) && !coveredKeys.has(row.key))
    .map(row => ({ row, godlog: godlogForRow(data, row) }))
    .filter(({ row, godlog }) => isGodlogReady(godlog, row))
    .map(({ row, godlog }) => ({ row, godlog, text: safePromptMemoryText('godlog', godlog, 1000) }))
    .filter(entry => entry.text);
  if (entries.length === 0) return '';
  state.lastRecentFactsMeta = entries.map(({ row, godlog }) => injectionRef('godlog', godlog, {
    floor: row.index,
    key: row.key,
    method: 'unanchored-summary',
    title: godlogFieldValue(godlog.body || '', 'Title'),
  }));
  const parts = [`### 逐楼摘要（尚未进入每 ${Math.max(1, Number(settings().anchorInterval) || 15)} 回合锚点）`];
  for (const { row, text } of entries) {
    parts.push(`#### 第 ${row.assistantNumber || row.index + 1} 个AI回合`);
    parts.push(text);
  }
  return clampTextHeadTail(parts.join('\n\n'), RECENT_FACTS_MEMORY_CHAR_BUDGET, 0.28);
}

const RECALL_STOP_TERMS = new Set([
  '这个', '那个', '然后', '已经', '还是', '因为', '所以', '但是', '自己', '对方', '他们', '她们', '我们', '你们',
  '一个', '没有', '不是', '就是', '可以', '需要', '当前', '本楼', '剧情', '回复', '用户', '角色', '人物',
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'was', 'were', 'are', 'you', 'your', 'user', 'assistant',
]);

function keywordSet(text, maxTerms = 600) {
  const value = String(text || '').toLocaleLowerCase();
  const termLimit = Math.max(32, Math.min(1200, Number(maxTerms) || 600));
  const result = new Set();
  const add = token => {
    const value = String(token || '').trim();
    if (!value || RECALL_STOP_TERMS.has(value) || result.size >= termLimit) return;
    result.add(value);
  };

  for (const token of value.match(/[a-z0-9_]{3,}/g) || []) add(token);
  for (const sequence of value.match(/[\u3400-\u9fff]{2,}/g) || []) {
    if (sequence.length <= 16) add(sequence);
    const maxGram = Math.min(4, sequence.length);
    for (let width = 2; width <= maxGram; width++) {
      for (let index = 0; index <= sequence.length - width; index++) {
        const gram = sequence.slice(index, index + width);
        if (/^[的是了在和与及也都而或把被就又还很]+$/.test(gram)) continue;
        add(gram);
        if (result.size >= termLimit) return result;
      }
    }
  }
  return result;
}

function recallMaxCount() {
  return Math.max(1, Math.min(12, Number(settings().embeddingTopK) || 4));
}

function recallMinCount() {
  // Backward-compatible metadata name. Recall is no longer forced to return irrelevant minimum hits.
  return recallMaxCount();
}

function recallCandidateLimit() {
  return Math.max(12, Math.min(40, recallMaxCount() * 7));
}

function recallTokenBudget() {
  return Math.max(2200, Math.min(7200, 1400 + recallMaxCount() * 850));
}

function recallHitText(hit, limit = null) {
  return safePromptMemoryText(hit.kind, hit.item, limit || (hit.kind === 'merge' ? 2800 : 1800));
}

function adaptiveRecallThreshold(candidates, method) {
  const topScore = Number(candidates?.[0]?.score || 0);
  if (!topScore) return Number.POSITIVE_INFINITY;
  if (method === 'embedding') return Math.max(0.28, topScore * 0.82);
  return Math.max(1.5, topScore * 0.45);
}

function selectAdaptiveRecallHits(candidates) {
  const maxCount = recallMaxCount();
  const budget = recallTokenBudget();
  const method = candidates?.[0]?.method || 'keyword';
  const threshold = adaptiveRecallThreshold(candidates, method);
  const selected = [];
  let usedTokens = 0;

  for (const hit of candidates || []) {
    const score = Number(hit.score || 0);
    if (score < threshold || selected.length >= maxCount) continue;
    const text = recallHitText(hit);
    const cost = estimateTokens(`${hit.kind} ${hit.item?.number || ''}\n${text}`);
    if (usedTokens + cost > budget) continue;
    selected.push({
      ...hit,
      recallReason: method === 'embedding' ? '语义相关度达标' : '关键词相关度达标',
      recallTokens: cost,
    });
    usedTokens += cost;
  }

  return { selected, budget, usedTokens, threshold, minCount: 0, maxCount, candidateCount: (candidates || []).length };
}

function keywordRecall(data, query, limit = recallCandidateLimit()) {
  const rankedTerms = [...keywordSet(query, 360)]
    .sort((a, b) => {
      const aLatin = /^[a-z0-9_]+$/i.test(a) ? 1 : 0;
      const bLatin = /^[a-z0-9_]+$/i.test(b) ? 1 : 0;
      return bLatin - aLatin || b.length - a.length;
    })
    .slice(0, 180);
  const terms = new Set(rankedTerms);
  if (terms.size === 0) return [];
  const liveCacheKeys = new Set();
  const candidates = readyGodlogMemoryItems(data)
    .map(item => {
      const text = safeGodlogMemoryText(item.body || '');
      const cacheKey = `${item.id || item.key || item.number}:${stableHash(text)}`;
      liveCacheKeys.add(cacheKey);
      let cached = state.recallTermCache.get(cacheKey);
      if (!cached || cached instanceof Set) {
        cached = {
          terms: cached instanceof Set ? cached : keywordSet(text),
          normalized: normalizeEntityMatchText(text),
        };
        state.recallTermCache.set(cacheKey, cached);
      }
      return { kind: 'godlog', item, text, own: cached.terms, normalized: cached.normalized };
    });
  if (state.recallTermCache.size > Math.max(64, liveCacheKeys.size * 2)) {
    for (const cacheKey of state.recallTermCache.keys()) {
      if (!liveCacheKeys.has(cacheKey)) state.recallTermCache.delete(cacheKey);
    }
  }
  // Down-weight phrases that appear in nearly every summary. Without a light IDF term, generic
  // role-play wording such as “随后/关系/当前” can outrank the actual person, place or object named
  // by the latest user message when a chat contains hundreds of Godlogs.
  const documentFrequency = new Map([...terms].map(term => [term, 0]));
  for (const candidate of candidates) {
    for (const term of terms) {
      if (candidate.own.has(term)) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }
  const documentCount = Math.max(1, candidates.length);
  return candidates
    .map(candidate => {
      let score = 0;
      for (const term of terms) {
        const frequency = documentFrequency.get(term) || 0;
        const prevalence = frequency / documentCount;
        if (candidate.own.has(term)) {
          if (prevalence > 0.65 && term.length <= 3) continue;
          const base = term.length >= 4 ? 3.5 : term.length === 3 ? 2.5 : 1.5;
          const idf = Math.log((documentCount + 1) / (frequency + 1)) + 0.3;
          score += base * idf;
        } else if (term.length >= 4 && candidate.normalized.includes(term)) {
          score += 0.55;
        }
      }
      const { own: _own, normalized: _normalized, ...result } = candidate;
      return { ...result, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score
      || Number(b.item?.floor ?? b.item?.number ?? 0) - Number(a.item?.floor ?? a.item?.number ?? 0))
    .slice(0, limit);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / (Math.sqrt(aa) * Math.sqrt(bb)) : 0;
}

function embeddingConfigured() {
  const s = settings();
  const url = s.embeddingUrl || s.secondaryUrl;
  const key = s.embeddingKey || s.secondaryKey;
  return s.useEmbedding && url && key && !state.vectorStorageUnavailable;
}

function modelSupportsDimensions(model) {
  const id = String(model || '');
  return /text-embedding-3/i.test(id) || /Qwen\/Qwen3-Embedding-/i.test(id);
}

function embeddingRequestBody(texts) {
  const s = settings();
  const body = {
    model: s.embeddingModel,
    input: texts,
  };
  const mode = s.embeddingDimensionsMode || 'auto';
  const dimensions = Number(s.embeddingDimensions) || 0;
  if (dimensions > 0 && (mode === 'always' || (mode === 'auto' && modelSupportsDimensions(s.embeddingModel)))) {
    body.dimensions = dimensions;
  }
  return body;
}

function embeddingSignature() {
  const s = settings();
  const body = embeddingRequestBody(['signature']);
  return stableHash(JSON.stringify({
    url: baseApiUrl(s.embeddingUrl || s.secondaryUrl),
    model: body.model || '',
    dimensions: body.dimensions || '',
    mode: s.embeddingDimensionsMode || 'auto',
  }));
}

async function embedTexts(texts) {
  const s = settings();
  const base = baseApiUrl(s.embeddingUrl || s.secondaryUrl);
  const key = s.embeddingKey || s.secondaryKey;
  const request = state.requests.create('embedding');
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try { request.controller.abort('embedding-timeout'); } catch { request.controller.abort(); }
  }, 45 * 1000);
  try {
    const response = await fetch(`${base}/embeddings`, {
      method: 'POST',
      signal: request.controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(embeddingRequestBody(texts)),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Embedding API ${response.status}: ${errText.slice(0, 180)}`);
    }
    const json = await response.json();
    return (json.data || []).map(item => item.embedding);
  } catch (err) {
    if (err?.name === 'AbortError') {
      if (timedOut) throw new Error('Embedding 请求超过45秒，已取消并回退关键词召回');
      throw new Error('Embedding 请求已因聊天上下文变化而取消');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    request.cleanup();
  }
}

function looksLikeEmbeddingModel(id) {
  return /(embedding|embed|bge|gte|e5|bce|jina|m3)/i.test(String(id || ''));
}

function looksLikeChatModel(id) {
  return !looksLikeEmbeddingModel(id) && !/(rerank|stable-diffusion|image|video|tts|whisper)/i.test(String(id || ''));
}

async function fetchProviderModels(url, key, subType = '') {
  const base = baseApiUrl(url);
  if (!base || !key) throw new Error('请先填写 API 地址和密钥');
  const urls = [];
  if (subType) urls.push({ endpoint: `${base}/models?sub_type=${encodeURIComponent(subType)}`, filteredByProvider: true });
  urls.push({ endpoint: `${base}/models`, filteredByProvider: false });

  let lastError = '';
  for (const { endpoint, filteredByProvider } of urls) {
    try {
      const request = state.requests.create('models');
      const response = await fetch(endpoint, {
        method: 'GET',
        signal: request.controller.signal,
        headers: { Authorization: `Bearer ${key}` },
      }).finally(request.cleanup);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        lastError = `${response.status}: ${text.slice(0, 160)}`;
        continue;
      }
      const json = await response.json();
      const ids = (json.data || [])
        .map(item => item.id || item.name || item.model)
        .filter(Boolean)
        .map(String);
      if (filteredByProvider && ids.length > 0) return ids;
      if (filteredByProvider) continue;
      if (subType === 'embedding') return ids.filter(looksLikeEmbeddingModel);
      if (subType === 'chat') return ids.filter(looksLikeChatModel);
      return ids;
    } catch (err) {
      lastError = err.message;
    }
  }
  throw new Error(lastError || '模型列表为空或接口不支持拉取');
}

function renderModelOptions(selector, models) {
  const container = $(selector);
  if (!container.length) return;
  container.empty();
  for (const model of models || []) {
    container.append(`<option value="${escapeHtml(model)}"></option>`);
  }
}

function ensureVectorStorageId(data) {
  if (!data?.processing) return '';
  if (!data.processing.storageId) {
    const uuid = globalThis.crypto?.randomUUID?.();
    data.processing.storageId = uuid || `am-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return data.processing.storageId;
}

function vectorCacheKey(data, id) {
  return `${ensureVectorStorageId(data)}:${String(id || '')}`;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function idbTransactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

async function openVectorDb() {
  if (!globalThis.indexedDB) return null;
  if (state.vectorDbPromise) return state.vectorDbPromise;
  state.vectorDbPromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(VECTOR_DB_NAME, VECTOR_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(VECTOR_STORE_NAME)
        ? request.transaction.objectStore(VECTOR_STORE_NAME)
        : db.createObjectStore(VECTOR_STORE_NAME, { keyPath: 'key' });
      if (!store.indexNames.contains('storageId')) store.createIndex('storageId', 'storageId', { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开向量 IndexedDB'));
  }).catch(err => {
    console.warn('[AnchorMemory] IndexedDB unavailable; semantic vectors are disabled and keyword recall remains available.', err);
    state.vectorStorageUnavailable = true;
    state.vectorDbPromise = null;
    return null;
  });
  return state.vectorDbPromise;
}

async function putStoredVector(data, id, record) {
  if (!data || !id || !record?.vector) return false;
  const storageId = ensureVectorStorageId(data);
  const key = `${storageId}:${id}`;
  const stored = { ...record, key, storageId, id: String(id) };
  const db = await openVectorDb();
  if (!db) {
    // Never place large float arrays back into chat metadata. Long chats would otherwise become
    // progressively larger and slower to save. Dynamic recall transparently falls back to keywords.
    delete data.vectors?.[id];
    delete data.vectorRefs?.[id];
    state.vectorStorageUnavailable = true;
    return false;
  }
  const tx = db.transaction(VECTOR_STORE_NAME, 'readwrite');
  tx.objectStore(VECTOR_STORE_NAME).put(stored);
  await idbTransactionDone(tx);
  state.vectorCache.set(key, stored);
  data.vectorRefs[id] = {
    signature: record.signature || '',
    dimensions: record.dimensions || record.vector.length,
    model: record.model || '',
    updatedAt: record.updatedAt || Date.now(),
  };
  delete data.vectors[id];
  return true;
}

async function getStoredVector(data, id) {
  if (!data || !id) return null;
  const key = vectorCacheKey(data, id);
  if (state.vectorCache.has(key)) return state.vectorCache.get(key);
  const db = await openVectorDb();
  if (!db) return null;
  const tx = db.transaction(VECTOR_STORE_NAME, 'readonly');
  const record = await idbRequest(tx.objectStore(VECTOR_STORE_NAME).get(key));
  if (record) state.vectorCache.set(key, record);
  return record || null;
}

async function listStoredVectors(data) {
  if (!data) return [];
  const storageId = ensureVectorStorageId(data);
  const db = await openVectorDb();
  if (!db) return [];
  const tx = db.transaction(VECTOR_STORE_NAME, 'readonly');
  const records = await idbRequest(tx.objectStore(VECTOR_STORE_NAME).index('storageId').getAll(storageId));
  for (const record of records || []) state.vectorCache.set(record.key, record);
  return records || [];
}

function removeStoredVector(data, id) {
  if (!data || !id) return false;
  const storageId = ensureVectorStorageId(data);
  const key = `${storageId}:${id}`;
  const existed = !!(data.vectorRefs?.[id] || data.vectors?.[id] || state.vectorCache.has(key));
  delete data.vectorRefs?.[id];
  delete data.vectors?.[id];
  state.vectorCache.delete(key);
  openVectorDb().then(db => {
    if (!db) return;
    const tx = db.transaction(VECTOR_STORE_NAME, 'readwrite');
    tx.objectStore(VECTOR_STORE_NAME).delete(key);
  }).catch(err => console.warn('[AnchorMemory] vector delete failed:', err));
  return existed;
}

async function clearStoredVectors(data) {
  if (!data) return;
  const storageId = ensureVectorStorageId(data);
  const db = await openVectorDb();
  if (db) {
    const tx = db.transaction(VECTOR_STORE_NAME, 'readwrite');
    const store = tx.objectStore(VECTOR_STORE_NAME);
    const keys = await idbRequest(store.index('storageId').getAllKeys(storageId));
    for (const key of keys || []) store.delete(key);
    await idbTransactionDone(tx);
  }
  for (const key of [...state.vectorCache.keys()]) {
    if (key.startsWith(`${storageId}:`)) state.vectorCache.delete(key);
  }
  data.vectorRefs = {};
  data.vectors = {};
}

function scheduleLegacyVectorMigration(data) {
  if (!data || Object.keys(data.vectors || {}).length === 0) return;
  const storageId = ensureVectorStorageId(data);
  if (state.vectorMigrationStorageIds.has(storageId)) return;
  state.vectorMigrationStorageIds.add(storageId);
  setTimeout(async () => {
    try {
      const entries = Object.entries(data.vectors || {});
      for (const [id, record] of entries) {
        if (record?.vector) await putStoredVector(data, id, record);
      }
      // v0.9.3 never retains vectors in chat metadata. If IndexedDB is unavailable, discard the
      // legacy payloads and keep keyword recall; users can rebuild vectors after storage recovers.
      data.vectors = {};
      if (state.vectorStorageUnavailable) data.vectorRefs = {};
      saveMemory(true);
    } catch (err) {
      console.warn('[AnchorMemory] legacy vector migration failed:', err);
    }
  }, 0);
}

async function embedMemoryItem(data, id, text) {
  const sourceText = String(text || '').trim();
  if (!embeddingConfigured() || !sourceText) return;
  try {
    const [vector] = await embedTexts([sourceText]);
    if (vector) {
      await putStoredVector(data, id, {
        vector,
        signature: embeddingSignature(),
        dimensions: vector.length,
        model: settings().embeddingModel,
        updatedAt: Date.now(),
      });
      saveMemory();
    }
  } catch (err) {
    console.warn('[AnchorMemory] embedding failed', err);
  }
}

async function ensureMemoryItemEmbedded(data, id, text) {
  if (!embeddingConfigured() || !id) return;
  const current = data.vectorRefs?.[id] || data.vectors?.[id];
  if (current?.signature === embeddingSignature()) return;
  await embedMemoryItem(data, id, text);
}

async function vectorRecall(data, query, limit = recallCandidateLimit()) {
  if (!embeddingConfigured()) return null;
  const [queryVector] = await embedTexts([query]);
  const signature = embeddingSignature();
  const byId = new Map();
  for (const godlog of readyGodlogMemoryItems(data)) byId.set(godlog.id, { kind: 'godlog', item: godlog, text: safeGodlogMemoryText(godlog.body || '') });

  const records = await listStoredVectors(data);
  if (state.vectorStorageUnavailable) throw new Error('向量 IndexedDB 不可用，改用关键词召回');
  const results = records
    .map(record => {
      const id = record.id || String(record.key || '').split(':').pop();
      if (record.signature !== signature) return null;
      const source = byId.get(id);
      if (!source || !Array.isArray(record.vector)) return null;
      return { ...source, score: cosine(queryVector, record.vector), method: 'embedding' };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return results;
}

function buildRecallQuery(chat = getContext().chat || []) {
  const visible = (chat || []).filter(message => message && !message.is_system && !message.is_hidden);
  const lastUser = [...visible].reverse().find(message => message.is_user);
  const recent = visible.slice(-6)
    .map(message => `${message.is_user ? '用户' : 'AI'} ${message.name || '未命名'}：${cleanText(message.mes || message.content || '')}`)
    .filter(line => cleanText(line))
    .join('\n');
  const terms = [...keywordSet(`${lastUser?.mes || ''}\n${recent}`)].slice(0, 36).join(' ');
  const query = [
    lastUser ? `最新用户输入：${cleanText(lastUser.mes || lastUser.content || '')}` : '',
    recent ? `最近上下文：\n${recent}` : '',
    terms ? `检索关键词：${terms}` : '',
  ].filter(Boolean).join('\n\n');
  return {
    query,
    source: lastUser ? '最新用户输入 + 最近6条可见上下文' : '最近6条可见上下文',
    lastUser: lastUser ? cleanText(lastUser.mes || lastUser.content || '') : '',
    terms,
  };
}

function recallQueryCacheKey(recallQuery) {
  return stableHash(`${embeddingConfigured() ? embeddingSignature() : 'keyword'}\n${recallQuery?.query || ''}`);
}

function clearRecallPrefetch() {
  state.recallPrefetchKey = '';
  state.recallPrefetchPromise = null;
  state.recallPrefetchResult = null;
  state.recallPrefetchAt = 0;
}

async function prepareDynamicRecall(chat = getContext().chat || []) {
  if (!settings().useDynamicRecall || !hasPersistentChatContext()) {
    clearRecallPrefetch();
    return null;
  }
  const recallQuery = buildRecallQuery(chat);
  if (!recallQuery.query.trim()) {
    clearRecallPrefetch();
    return null;
  }
  const key = recallQueryCacheKey(recallQuery);
  if (state.recallPrefetchKey === key && (state.recallPrefetchPromise || state.recallPrefetchResult)) {
    return state.recallPrefetchPromise || state.recallPrefetchResult;
  }
  state.recallPrefetchKey = key;
  state.recallPrefetchResult = null;
  state.recallPrefetchAt = Date.now();
  if (!embeddingConfigured()) {
    const result = keywordRecall(memoryData(), recallQuery.query, recallCandidateLimit())
      .map(hit => ({ ...hit, method: 'keyword' }));
    state.recallPrefetchResult = result;
    state.recallPrefetchPromise = null;
    return result;
  }
  const promise = vectorRecall(memoryData(), recallQuery.query, recallCandidateLimit())
    .then(result => {
      if (state.recallPrefetchKey === key) state.recallPrefetchResult = result || [];
      return result || [];
    })
    .catch(err => {
      console.warn('[AnchorMemory] vector recall prefetch failed; prompt will use keyword fallback', err);
      const fallback = keywordRecall(memoryData(), recallQuery.query, recallCandidateLimit())
        .map(hit => ({ ...hit, method: 'keyword' }));
      if (state.recallPrefetchKey === key) state.recallPrefetchResult = fallback;
      return fallback;
    })
    .finally(() => {
      if (state.recallPrefetchKey === key) state.recallPrefetchPromise = null;
    });
  state.recallPrefetchPromise = promise;
  return promise;
}

function dynamicRecall(data, chat, rows = chatRows(true)) {
  state.lastRecallMeta = [];
  state.lastRecallQuery = null;
  const recallQuery = buildRecallQuery(chat);
  const key = recallQueryCacheKey(recallQuery);
  state.lastRecallQuery = {
    source: recallQuery.source,
    preview: clampText(recallQuery.query, 1200),
    minCount: 0,
    maxCount: recallMaxCount(),
    candidateLimit: recallCandidateLimit(),
    budget: recallTokenBudget(),
    mode: embeddingConfigured() ? 'embedding-prefetch' : 'keyword',
  };
  if (!recallQuery.query.trim()) return '';

  // Never wait for a network embedding call in CHAT_COMPLETION_PROMPT_READY. A user-message event
  // prefetches vectors in the background; if it has not finished, keyword recall is used instantly.
  let recalled = state.recallPrefetchKey === key && Array.isArray(state.recallPrefetchResult)
    ? state.recallPrefetchResult
    : null;
  if (!recalled || recalled.length === 0) {
    recalled = keywordRecall(data, recallQuery.query, recallCandidateLimit())
      .map(hit => ({ ...hit, method: 'keyword' }));
    state.lastRecallQuery.mode = state.recallPrefetchKey === key && state.recallPrefetchPromise
      ? 'keyword-fallback-while-vector-prefetching'
      : 'keyword';
  } else {
    state.lastRecallQuery.mode = recalled[0]?.method || 'embedding';
  }

  const recentRawKeys = new Set(rows
    .filter(row => row.role === 'assistant')
    .slice(-Math.max(1, Number(settings().keepRecent) || 3))
    .map(row => row.key));
  const deterministicIds = new Set((state.lastRecentFactsMeta || []).map(ref => ref.id).filter(Boolean));
  recalled = recalled.filter(hit => hit.kind === 'godlog'
    && !deterministicIds.has(hit.item?.id)
    && !recentRawKeys.has(hit.item?.key));

  const adaptive = selectAdaptiveRecallHits(recalled);
  if (state.lastRecallQuery) {
    Object.assign(state.lastRecallQuery, {
      selectedCount: adaptive.selected.length,
      candidateCount: adaptive.candidateCount,
      usedTokens: adaptive.usedTokens,
      threshold: adaptive.threshold,
      budget: adaptive.budget,
    });
  }
  recalled = adaptive.selected;
  if (!recalled.length) return '';

  state.lastRecallMeta = recalled.map(hit => ({
    id: hit.item.id,
    number: hit.item.number,
    floor: hit.item.floor ?? null,
    kind: 'godlog',
    title: godlogFieldValue(hit.item.body || '', 'Title'),
    method: hit.method || 'keyword',
    score: Number(hit.score || 0),
    querySource: recallQuery.source,
    recallReason: hit.recallReason || '',
    recallTokens: hit.recallTokens || 0,
  }));

  const parts = ['### 动态召回（与当前输入相关的旧楼细节）'];
  for (const hit of recalled) {
    const floor = hit.item.floor !== undefined ? hit.item.floor + 1 : hit.item.number || '?';
    const title = godlogFieldValue(hit.item.body || '', 'Title');
    parts.push(`#### 第 ${floor} 楼${title ? `｜${title}` : ''}`);
    parts.push(safePromptMemoryText('godlog', hit.item, 1200));
  }
  return clampTextHeadTail(parts.join('\n\n'), DYNAMIC_RECALL_MEMORY_CHAR_BUDGET, 0.25);
}

function hasCoreInjectionContent(data) {
  return !!(
    latestMerge(data)
    || activeAnchorsAfterMerge(data).length
    || (!data?.processing?.codexDirty && (
      (settings().recallMentionedPeople && (data?.codex?.characterMemo || data?.codex?.peopleIndex))
      || (settings().injectImportantItems && data?.codex?.itemIndex)
    ))
  );
}

function injectionRef(kind, item, extra = {}) {
  if (!item) return null;
  return {
    kind,
    id: item.id || '',
    number: item.number || 0,
    floor: extra.floor ?? item.floor ?? item.floorAt ?? null,
    title: extra.title || (kind === 'godlog' ? godlogFieldValue(item.body || '', 'Title') : '') || item.title || '',
    method: extra.method || '',
  };
}

function uniqueInjectionRefs(refs) {
  const seen = new Set();
  const result = [];
  for (const ref of refs || []) {
    if (!ref?.id) continue;
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function promptReadyInjectionRefs(data) {
  const refs = [];
  refs.push(injectionRef('merge', latestMerge(data)));
  for (const anchor of activeAnchorsAfterMerge(data)) refs.push(injectionRef('anchor', anchor));
  for (const ref of state.lastRecentFactsMeta || []) refs.push(ref);
  if (settings().useDynamicRecall) {
    for (const hit of state.lastRecallMeta || []) {
      refs.push({
        kind: hit.kind,
        id: hit.id,
        number: hit.number || 0,
        floor: hit.floor ?? (hit.kind === 'godlog' && hit.number ? hit.number - 1 : null),
        method: hit.method || 'keyword',
        score: Number(hit.score || 0),
        recallReason: hit.recallReason || '',
        recallTokens: hit.recallTokens || 0,
      });
    }
  }
  return uniqueInjectionRefs(refs);
}

function estimateKeptNarrativeTokens(chat = getContext().chat || []) {
  const plan = recentRawHistoryPlan(chat, Math.max(1, Number(settings().keepRecent) || 3));
  return plan.keepIndices.reduce((sum, index) => {
    const message = chat[index];
    if (!message) return sum;
    return sum + estimateTokens(`${message.is_user ? 'user' : 'assistant'}:${message.name || ''}\n${message.mes || message.content || ''}`);
  }, 0);
}

function currentMemoryTokenBudget(chat = getContext().chat || []) {
  const s = settings();
  const maxMemoryTokens = Math.max(1200, Number(s.memoryMaxTokens) || 8000);
  const reserveTokens = Math.max(600, Number(s.memoryReserveTokens) || 1400);
  if (!s.adaptiveTokenBudget) return maxMemoryTokens;
  return resolveAdaptiveMemoryBudget({
    contextSize: state.lastContextSize,
    promptTokens: estimateKeptNarrativeTokens(chat),
    maxMemoryTokens,
    reserveTokens,
    minimumMemoryTokens: Math.min(1600, maxMemoryTokens),
  });
}

async function buildPromptReadyInjection(chat = getContext().chat || []) {
  const data = memoryData();
  const rows = chatRows(true);
  const trackedLabel = trackedCharacterLabel(data);
  const characterMemo = data.processing?.codexDirty
    ? '（人物动态索引正在安全重建，本次不注入可能过期的旧表）'
    : (sanitizeCharacterMemoSection(data, data.codex.characterMemo) || '（暂无明确核心转变）');

  const recentFacts = buildRecentFactsInjection(data, rows);
  state.lastRecentFacts = recentFacts;
  state.lastRecall = '';
  state.lastRecallMeta = [];
  if (!settings().useDynamicRecall) state.lastRecallQuery = null;
  const recall = settings().useDynamicRecall ? dynamicRecall(data, chat, rows) : '';
  state.lastRecall = recall;
  const detailParts = [recentFacts, recall].filter(part => String(part || '').trim());
  const recallEnabled = !!settings().useDynamicRecall;
  const sectionSix = [
    recallEnabled ? '【六. 未锚定逐楼摘要与可选动态召回】' : '【六. 未锚定逐楼摘要】',
    detailParts.length
      ? detailParts.join('\n\n')
      : (recallEnabled
        ? '（当前没有需要补充的未锚定逐楼摘要或相关旧楼召回）'
        : '（当前没有需要补充的未锚定逐楼摘要；动态召回处于关闭状态）'),
  ].join('\n\n');

  const timeline = refreshTimelineFromGodlogs(data);
  const timeCue = `当前剧情定位：时间 ${data.codex.currentTime || '未明'}；地点 ${data.codex.currentPlace || '未明'}。${timeline.warnings?.length ? ` 时间连续性存在 ${timeline.warnings.length} 条待核对提示，最近正文优先。` : ''}`;
  const sections = [
    {
      id: 'relationship', minTokens: 320, maxTokens: 1500, weight: 1.2, headRatio: 0.45,
      text: [
        '锚点记录',
        '使用边界：以下均为已经发生的剧情记忆。直接延续当前正文，不复述资料标题，不写整理说明；若与最近正文冲突，以最近正文为准。',
        timeCue,
        '【一. 人物关系】',
        relationshipInjectionBlock(data),
      ].join('\n\n'),
    },
    { id: 'anchors', minTokens: 1100, maxTokens: 4300, weight: 3.8, headRatio: 0.28, text: `【二. 锚点事件】\n\n${anchorEventInjectionBlock(data)}` },
    { id: 'character', minTokens: 260, maxTokens: 1050, weight: 1.1, headRatio: 0.38, text: `【三. ${trackedLabel} 动态演变（核心转变）】\n\n${safeCodexText(characterMemo, 3200)}` },
    { id: 'people', minTokens: 180, maxTokens: 850, weight: 0.8, headRatio: 0.45, text: `【四. 匹配到的出场人物库】\n\n${safeCodexText(matchedPeopleInjectionBlock(data, chat), 2200)}` },
    { id: 'items', minTokens: 180, maxTokens: 900, weight: 0.9, headRatio: 0.45, text: `【五. 重要道具、梗与核心细节】\n\n${safeCodexText(importantItemsInjectionBlock(data, chat), 2400)}` },
    { id: 'recent', minTokens: 360, maxTokens: 1700, weight: 1.35, headRatio: 0.3, text: sectionSix },
  ];

  const budget = currentMemoryTokenBudget(chat);
  const fitted = fitMemorySections(sections, budget);
  const bounded = sanitizeMainPromptMemoryText(fitted.text);
  state.lastMemoryBudget = {
    budgetTokens: budget,
    usedTokens: estimateTokens(bounded),
    contextSize: state.lastContextSize || 0,
    keptNarrativeTokens: estimateKeptNarrativeTokens(chat),
    allocations: fitted.allocations,
    at: Date.now(),
  };
  state.lastPromptInjection = bounded;
  return bounded;
}

function compactInjectionPreview(content, maxChars = 480) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function rememberPromptInjectionForNextMessage(data, chat, content) {
  const refs = promptReadyInjectionRefs(data);
  const fullContent = String(content || '');
  state.lastInjectionRefs = refs;
  // The full prompt is only needed until the next AI message is adopted. Keeping a cumulative
  // copy on every floor made chat metadata grow quadratically because most memory text repeats.
  state.pendingInjectionContent = fullContent;
  const targetIndex = Array.isArray(chat) ? chat.length : (getContext().chat || []).length;
  data.processing.pendingPromptInjection = {
    targetIndex,
    refs,
    recallQuery: state.lastRecallQuery ? { ...state.lastRecallQuery } : null,
    contentHash: stableHash(fullContent),
    contentPreview: compactInjectionPreview(fullContent),
    injectedChars: fullContent.length,
    at: Date.now(),
  };
  return data.processing.pendingPromptInjection;
}

function adoptPendingPromptInjection(data, row) {
  if (!data || !row?.key) return false;
  const pending = data.processing?.pendingPromptInjection;
  if (!pending || Number(pending.targetIndex) !== Number(row.index)) return false;
  const transientContent = String(state.pendingInjectionContent || '');
  data.messageRecalls[row.key] = {
    key: row.key,
    floor: row.index,
    name: row.name || '',
    refs: Array.isArray(pending.refs) ? pending.refs : [],
    recallQuery: pending.recallQuery || null,
    contentHash: pending.contentHash || stableHash(transientContent || pending.content || ''),
    contentPreview: pending.contentPreview || compactInjectionPreview(transientContent || pending.content || ''),
    injectedChars: pending.injectedChars || transientContent.length || String(pending.content || '').length,
    at: pending.at || Date.now(),
  };
  state.pendingInjectionContent = '';
  data.processing.pendingPromptInjection = null;
  saveMemory();
  return true;
}

function messageRecallRecord(data, row) {
  if (!data || !row?.key) return null;
  adoptPendingPromptInjection(data, row);
  return data.messageRecalls?.[row.key] || null;
}

function rememberMessageGodlogCard(data, row, item, status) {
  if (!data || !row?.key) return false;
  const next = {
    key: row.key,
    floor: row.index,
    name: row.name || '',
    godlogId: item?.id || syntheticGodlogId(row),
    status: status || item?.status || 'missing',
    updatedAt: item?.updatedAt || Date.now(),
    uiOnly: true,
  };
  const prev = data.messageGodlogs?.[row.key];
  if (JSON.stringify(prev || null) === JSON.stringify(next)) return false;
  data.messageGodlogs[row.key] = next;
  return true;
}

function pruneMessageUiIndexes(data, rows = chatRows(true)) {
  if (!data) return false;
  const liveKeys = new Set((rows || []).map(row => row.key).filter(Boolean));
  let changed = false;
  for (const key of Object.keys(data.messageGodlogs || {})) {
    if (liveKeys.has(key)) continue;
    delete data.messageGodlogs[key];
    changed = true;
  }
  for (const key of Object.keys(data.messageRecalls || {})) {
    if (liveKeys.has(key)) continue;
    delete data.messageRecalls[key];
    changed = true;
  }
  const pending = data.processing?.pendingPromptInjection;
  const chatLength = (getContext().chat || []).length;
  if (pending && Number(pending.targetIndex) > chatLength + 1) {
    data.processing.pendingPromptInjection = null;
    changed = true;
  }
  return changed;
}

function normalizedInjectionDepth(value = settings().injectionDepth) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 4;
}

function resolvePromptInsertIndex(promptChat, depth = 4) {
  if (!Array.isArray(promptChat) || promptChat.length === 0) return 0;
  const position = Math.max(0, Number(depth) || 0);
  if (position === 0) {
    for (let index = promptChat.length - 1; index >= 0; index--) {
      if (promptChat[index]?.role === 'user' || promptChat[index]?.role === 'assistant') return index + 1;
    }
    return promptChat.length;
  }

  let turns = 0;
  for (let index = promptChat.length - 1; index >= 0; index--) {
    if (promptChat[index]?.role !== 'user' && promptChat[index]?.role !== 'assistant') continue;
    turns++;
    if (turns >= position) return index;
  }
  return 0;
}

function isAnchorMemoryPromptMessage(message) {
  const content = typeof message?.content === 'string' ? message.content : '';
  return message?.role === 'system'
    && /^锚点记录(?:\r?\n|$)/.test(content)
    && content.includes('【一. 人物关系】')
    && content.includes('【二. 锚点事件】')
    && content.includes('【六.');
}

function removeExistingAnchorMemoryPrompt(promptChat) {
  if (!Array.isArray(promptChat)) return 0;
  let removed = 0;
  for (let index = promptChat.length - 1; index >= 0; index--) {
    if (!isAnchorMemoryPromptMessage(promptChat[index])) continue;
    promptChat.splice(index, 1);
    removed++;
  }
  return removed;
}

function resolvePromptReadyPayload(eventData, secondArg = false) {
  // SillyTavern and prompt-inspection extensions expose the final message list through several
  // payload shapes. Resolve the actual array instead of silently skipping pruning on a new shape.
  const candidates = [
    eventData,
    eventData?.detail,
    eventData?.data,
    eventData?.request,
    eventData?.payload,
    eventData?.chatCompletion,
    eventData?.completion,
    eventData?.prompt,
  ];
  let promptChat = null;
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      promptChat = candidate;
      break;
    }
    for (const key of ['chat', 'messages', 'prompt']) {
      if (Array.isArray(candidate?.[key])) {
        promptChat = candidate[key];
        break;
      }
    }
    if (promptChat) break;
  }
  const dryRun = !!(
    secondArg === true
    || secondArg?.dryRun
    || secondArg?.isDryRun
    || eventData?.dryRun
    || eventData?.isDryRun
    || eventData?.detail?.dryRun
    || eventData?.detail?.isDryRun
  );
  return { promptChat, dryRun };
}

async function injectMemoryIntoPromptReady(eventData, secondArg = false) {
  const reportedContextSize = Number(eventData?.contextSize ?? eventData?.maxContext ?? eventData?.detail?.contextSize ?? 0);
  if (reportedContextSize > 0) state.lastContextSize = reportedContextSize;
  const s = settings();
  const { promptChat, dryRun } = resolvePromptReadyPayload(eventData, secondArg);
  // Prompt Inspector / Prompt List uses a dry run. The old code returned here, so the inspector
  // always displayed full old chatHistory bodies even when real generations were compressed.
  // Apply the same deterministic pruning in dry runs, but do not persist injection bookkeeping.
  if (!s.enabled || !Array.isArray(promptChat)) return;
  try {
    const contextChat = getContext().chat || [];
    const replacementStats = applyGodlogContextReplacement(promptChat, {
      mode: 'prompt-ready-history-hide',
      save: false,
      prune: true,
    });
    const sanitizedLeaks = sanitizePromptReadyGodlogLeaks(promptChat);
    removeExistingAnchorMemoryPrompt(promptChat);
    const content = await buildPromptReadyInjection(contextChat);
    let promptRecord = null;
    if (String(content || '').trim()) {
      const insertIndex = resolvePromptInsertIndex(promptChat, normalizedInjectionDepth(s.injectionDepth));
      promptChat.splice(insertIndex, 0, { role: 'system', content });
      sanitizePromptReadyGodlogLeaks(promptChat);
      if (!dryRun) {
        promptRecord = rememberPromptInjectionForNextMessage(memoryData(), contextChat, content);
      }
    }
    if (!dryRun) {
      const data = memoryData();
      data.processing.lastContextReplacement = {
        ...replacementStats,
        at: Date.now(),
        missing: Math.max(Number(replacementStats?.missing || 0), pendingGodlogRows(data).length),
        keepRecent: Math.max(1, Number(s.keepRecent) || 3),
        mode: 'prompt-ready-history-hide',
        sanitizedLeaks,
        injectedChars: String(content || '').length,
        injectedTokens: estimateTokens(content || ''),
        memoryBudgetTokens: state.lastMemoryBudget?.budgetTokens || 0,
        injectedItems: promptRecord?.refs?.length || 0,
        targetMessageIndex: promptRecord?.targetIndex ?? null,
      };
      saveMemory();
    }
  } catch (err) {
    console.error('[AnchorMemory] prompt-ready injection failed', err);
  }
}

function usesChatCompletionPromptReady() {
  // Do not import `main_api`: it is not exported by every SillyTavern build.
  // The event itself is the compatibility signal; unsupported backends simply never emit it.
  return !!event_types?.CHAT_COMPLETION_PROMPT_READY;
}

async function injectMemory(chat = getContext().chat || []) {
  const s = settings();
  const data = memoryData();
  if (!s.enabled) {
    setExtensionPrompt(CORE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
    setExtensionPrompt(RECALL_PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0);
    state.lastRecentFactsMeta = [];
    state.lastRecentFacts = '';
    state.lastRecall = '';
    state.lastRecallMeta = [];
    return;
  }

  if (usesChatCompletionPromptReady()) {
    setExtensionPrompt(CORE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
    setExtensionPrompt(RECALL_PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0);
    state.lastRecentFactsMeta = [];
    state.lastRecentFacts = '';
    state.lastRecall = '';
    state.lastRecallMeta = [];
    return;
  }

  const memoryPrompt = await buildPromptReadyInjection(chat);
  setExtensionPrompt(
    CORE_PROMPT_KEY,
    memoryPrompt,
    extension_prompt_types.IN_CHAT,
    normalizedInjectionDepth(s.injectionDepth),
    false,
    extension_prompt_roles.SYSTEM,
  );
  // Use one deterministic block so the six sections keep the same order on every backend.
  setExtensionPrompt(RECALL_PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0);
}

function markAnchorsStaleByKey(data, key, reason) {
  if (!data || !key) return { anchors: 0, merges: 0 };
  const removedAnchorIds = new Set();
  const removedAnchorKeys = new Set();
  const keptAnchors = [];
  for (const anchor of data.anchors || []) {
    if ((anchor.sourceKeys || []).includes(key)) {
      removedAnchorIds.add(anchor.id);
      for (const sourceKey of anchor.sourceKeys || []) removedAnchorKeys.add(sourceKey);
      removeStoredVector(data, anchor.id);
    } else {
      keptAnchors.push(anchor);
    }
  }
  data.anchors = keptAnchors;

  let cascade = false;
  let removedMerges = 0;
  const keptMerges = [];
  for (const merge of data.merges || []) {
    const touchesKey = (merge.sourceKeys || []).includes(key);
    const touchesAnchor = (merge.sourceAnchorIds || []).some(id => removedAnchorIds.has(id));
    // A merge is cumulative. Once one earlier merge is invalidated, every later merge is derived
    // from it and must be discarded as well.
    if (cascade || touchesKey || touchesAnchor) {
      cascade = true;
      removedMerges++;
      removeStoredVector(data, merge.id);
    } else {
      keptMerges.push(merge);
    }
  }
  data.merges = keptMerges;

  if (removedAnchorIds.size || removedMerges) {
    data.processing.lastError = reason || '源楼层已变动，相关锚点已回滚';
  }
  renumberDerivedMemory(data);
  refreshCoverageMaps(data);
  return { anchors: removedAnchorIds.size, merges: removedMerges, releasedKeys: [...removedAnchorKeys] };
}

function refreshCoverageMaps(data = memoryData()) {
  const mergedKeys = {};
  const merge = latestMerge(data);
  for (const key of merge?.sourceKeys || []) mergedKeys[key] = true;

  const anchoredKeys = {};
  for (const anchor of activeAnchors(data)) {
    for (const key of anchor.sourceKeys || []) {
      if (!mergedKeys[key]) anchoredKeys[key] = true;
    }
  }
  data.processing.mergedKeys = mergedKeys;
  data.processing.anchoredKeys = anchoredKeys;
  return { mergedKeys, anchoredKeys };
}

function refreshAnchoredKeys(data = memoryData()) {
  return refreshCoverageMaps(data).anchoredKeys;
}

function pruneVectorIndex(data = memoryData()) {
  if (!data) return 0;
  const validIds = new Set([
    ...readyGodlogMemoryItems(data).map(item => item.id),
    ...(data.anchors || []).map(item => item.id),
    ...(data.merges || []).map(item => item.id),
  ]);
  let removed = 0;
  const ids = new Set([...Object.keys(data.vectorRefs || {}), ...Object.keys(data.vectors || {})]);
  for (const id of ids) {
    if (!validIds.has(id) && removeStoredVector(data, id)) removed++;
  }
  return removed;
}

function forgetGodlogItem(data, item, reason = '源楼层已变动', includeUser = false) {
  if (!data || !item) return false;
  removeGodlogBlockFromMessage(currentRowForGodlog(item, includeUser));
  markAnchorsStaleByKey(data, item.key, reason);
  removeStoredVector(data, item.id);
  delete data.processing?.codexKeys?.[item.key];
  delete data.messageGodlogs?.[item.key];
  delete data.messageRecalls?.[item.key];
  if (data.processing?.pendingPromptInjection?.targetKey === item.key) {
    data.processing.pendingPromptInjection = null;
  }
  // Incremental tables are cumulative and cannot subtract a deleted/rerolled fact. Roll the fixed
  // relationship table back to its nearest earlier snapshot, then rebuild every derived index from
  // the surviving timeline instead of leaving ghost people/items/relationships behind.
  rollbackRelationshipToFloor(data, Number(item.floor ?? -1) - 1, reason || '源楼层已变动');
  markCodexDirty(data, reason || '源楼层已变动');

  if (state.selectedGodlogId === item.id) {
    state.selectedGodlogId = '';
    $('#am_godlog_detail').val('');
  }
  const index = (data.godlogs || []).findIndex(entry => entry.id === item.id);
  if (index >= 0) data.godlogs.splice(index, 1);
  refreshCoverageMaps(data);
  return index >= 0;
}

function preserveCompletedGodlogOnSourceChange(data, item, row, reason = '楼层在摘要完成后发生了变化') {
  if (!data || !item || !row) return false;
  const changed = lockCompletedSummaryToSavedSnapshot(item, row, reason);
  if (!changed) return false;
  rememberMessageGodlogCard(data, row, item, 'ready');
  refreshCoverageMaps(data);
  return true;
}

function markGodlogForSourceRefresh(data, item, row, reason = '源楼层内容已更新') {
  if (!data || !item || !row) return false;
  noteRowRevision(row, true);
  const wasCurrent = item.rawHash === row.rawHash && item.status === 'stale' && item.stale;
  if (wasCurrent) return false;

  // Keep the last completed body visible as a temporary card, but immediately revoke it from
  // anchors, embeddings, codex, and prompt injection because it no longer matches the source.
  markAnchorsStaleByKey(data, item.key, reason);
  removeStoredVector(data, item.id);
  delete data.processing?.codexKeys?.[item.key];
  delete data.messageRecalls?.[item.key];
  if (data.processing?.pendingPromptInjection?.targetKey === item.key) {
    data.processing.pendingPromptInjection = null;
  }
  rollbackRelationshipToFloor(data, Number(row.index ?? item.floor ?? -1) - 1, reason || '源楼层已变动');
  markCodexDirty(data, reason || '源楼层已变动');

  const hasOldBody = !!String(item.body || '').trim();
  Object.assign(item, {
    floor: row.index,
    role: row.role,
    name: row.name,
    sendDate: row.sendDate,
    previousRawHash: item.rawHash || item.previousRawHash || '',
    rawHash: row.rawHash,
    status: hasOldBody ? 'stale' : 'pending',
    stale: hasOldBody,
    staleSince: Date.now(),
    error: hasOldBody
      ? '楼层内容仍在更新；旧摘要暂时保留，正文稳定后会自动刷新。'
      : '楼层内容仍在更新；正文稳定后才会生成摘要。',
    updatedAt: item.updatedAt || Date.now(),
  });
  rememberMessageGodlogCard(data, row, item, hasOldBody ? 'stale' : 'pending');
  refreshCoverageMaps(data);
  return true;
}

function syncGodlogsWithChat(reason = '聊天变动') {
  if (!hasPersistentChatContext()) return false;
  const data = memoryData();
  let changed = removeAllGodlogBlocksFromChat();
  const rows = chatRows(true);
  const byKey = new Map(rows.map(row => [row.key, row]));

  for (const item of [...(data.godlogs || [])]) {
    if (item.archived) continue;
    const row = byKey.get(item.key);
    if (!row || row.role !== 'assistant') {
      changed = forgetGodlogItem(data, item, !row ? '源楼层已删除或重生成' : '用户楼不保留逐楼摘要', true) || changed;
      continue;
    }

    if (item.floor !== row.index || item.name !== row.name || item.sendDate !== row.sendDate) {
      item.floor = row.index;
      item.name = row.name;
      item.sendDate = row.sendDate;
      item.updatedAt = Date.now();
      changed = true;
    }

    if (item.rawHash && item.rawHash !== row.rawHash) {
      changed = isCompletedSummary(item)
        ? preserveCompletedGodlogOnSourceChange(data, item, row, reason || '楼层在摘要完成后发生了变化') || changed
        : markGodlogForSourceRefresh(data, item, row, reason || '源楼层已编辑或重生成') || changed;
      continue;
    }

    if (item.sourceMismatch || item.currentRawHash || item.sourceMismatchReason) {
      changed = preserveCompletedGodlogOnSourceChange(data, item, row, '') || changed;
    }

    if (syncGodlogNumber(item, row)) {
      item.updatedAt = Date.now();
      removeStoredVector(data, item.id);
      changed = true;
    }
  }

  syncGodlogCount(data);
  refreshTimelineFromGodlogs(data);
  refreshCoverageMaps(data);
  if (pruneVectorIndex(data) > 0) changed = true;
  if (pruneMessageUiIndexes(data, rows)) changed = true;
  if (changed) saveMemory(true);
  scheduleCodexBacklog(4);
  enforceAnchorHiddenState(data).catch(err => console.warn('[AnchorMemory] reconcile hidden state failed:', err));
  scheduleGodlogPanelRender();
  return changed;
}

function saveChatNow() {
  try {
    const ctx = getContext();
    const result = typeof ctx.saveChat === 'function'
      ? ctx.saveChat()
      : (ctx.groupId && typeof legacyGroupModule.saveGroupChat === 'function'
        ? legacyGroupModule.saveGroupChat(ctx.groupId, true)
        : undefined);
    if (result && typeof result.catch === 'function') {
      result.catch(err => console.warn('[AnchorMemory] saveChat failed:', err));
    }
    return result;
  } catch (err) {
    console.warn('[AnchorMemory] saveChat failed:', err);
  }
  return null;
}

function refreshMessageBlock(rowOrIndex) {
  const index = typeof rowOrIndex === 'number' ? rowOrIndex : rowOrIndex?.index;
  if (!Number.isInteger(index)) return false;
  const chat = getContext().chat || [];
  const message = chat[index];
  if (!message || !$(`#chat .mes[mesid="${index}"]`).length) return false;
  try {
    updateMessageBlock(index, message, { rerenderMessage: true });
    return true;
  } catch (err) {
    console.warn('[AnchorMemory] message block refresh failed:', err);
    return false;
  }
}

function syncGodlogBlockToMessage(row, _body) {
  return removeGodlogBlockFromMessage(row);
}

function removeGodlogBlockFromMessage(row) {
  if (!row) return false;
  const chat = getContext().chat || [];
  const message = chat[row.index];
  if (!message || message.is_system || !stripGodlogFromMessageRecord(message)) return false;

  refreshMessageBlock(row);
  saveChatNow();
  return true;
}

function removeAllGodlogBlocksFromChat() {
  const chat = getContext().chat || [];
  let changed = false;
  for (let index = 0; index < chat.length; index++) {
    const message = chat[index];
    if (!message || message.is_system) continue;
    const rowChanged = stripGodlogFromMessageRecord(message);
    if (rowChanged) refreshMessageBlock(index);
    changed = rowChanged || changed;
  }
  if (changed) saveChatNow();
  return changed;
}

function contiguousRanges(indices) {
  const valid = [...new Set((indices || []).filter(Number.isInteger))].sort((a, b) => a - b);
  if (valid.length === 0) return [];
  const ranges = [];
  let start = valid[0];
  let prev = valid[0];
  for (let i = 1; i < valid.length; i++) {
    const current = valid[i];
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    ranges.push([start, prev]);
    start = current;
    prev = current;
  }
  ranges.push([start, prev]);
  return ranges;
}

function anchorHiddenMeta(message) {
  if (!message.anchor_memory_meta) message.anchor_memory_meta = {};
  if (!Array.isArray(message.anchor_memory_meta.hiddenAnchorIds)) {
    message.anchor_memory_meta.hiddenAnchorIds = [];
  }
  return message.anchor_memory_meta;
}

async function setMessagesHiddenByAnchor(indices, hidden, anchorId = '') {
  const chat = getContext().chat || [];
  const unique = [...new Set((indices || [])
    .filter(index => Number.isInteger(index) && index >= 0 && index < chat.length && !!chat[index]))]
    .sort((a, b) => a - b);
  if (unique.length === 0) return false;

  const actionIndices = [];
  for (const index of unique) {
    const message = chat[index];
    // Never take ownership of a genuine SillyTavern system/hidden message. We only unhide records
    // carrying our own metadata, including records hidden by older Anchor Memory versions.
    if (hidden && message.is_system && !isMemoryManagedHidden(message)) continue;
    if (!hidden && !isMemoryManagedHidden(message) && !message.is_hidden) continue;

    const meta = anchorHiddenMeta(message);
    if (hidden) {
      if (!meta.hiddenAnchorIds.includes(anchorId)) meta.hiddenAnchorIds.push(anchorId);
      if (meta.wasHiddenBeforeAnchor === undefined) meta.wasHiddenBeforeAnchor = !!message.is_hidden;
      if (meta.wasSystemBeforeAnchor === undefined) meta.wasSystemBeforeAnchor = !!message.is_system;
      meta.hiddenByMemory = true;
      actionIndices.push(index);
    } else {
      meta.hiddenAnchorIds = anchorId === '*' ? [] : meta.hiddenAnchorIds.filter(id => id !== anchorId);
      if (meta.hiddenAnchorIds.length === 0) actionIndices.push(index);
    }
  }
  if (actionIndices.length === 0) return false;

  let officialHideSucceeded = false;
  try {
    // Dynamic import avoids a fatal module-load error on ST versions that do not export this helper.
    const chatsModule = await import('../../../chats.js');
    const officialHide = chatsModule?.hideChatMessageRange;
    if (typeof officialHide === 'function') {
      for (const [start, end] of contiguousRanges(actionIndices)) {
        // SillyTavern uses `false` for hide and `true` for unhide.
        await officialHide(start, end, !hidden);
      }
      officialHideSucceeded = true;
    }
  } catch (err) {
    console.warn('[AnchorMemory] official hide API unavailable; using fallback:', err);
  }

  if (!officialHideSucceeded) {
    try {
      const slashModule = await import('/scripts/slash-commands.js');
      const exec = slashModule.executeSlashCommandsWithOptions;
      if (typeof exec === 'function') {
        const command = hidden ? '/hide' : '/unhide';
        for (const [start, end] of contiguousRanges(actionIndices)) {
          const range = start === end ? `${start}` : `${start}-${end}`;
          await exec(`${command} ${range}`);
        }
      }
    } catch (err) {
      console.warn('[AnchorMemory] /hide fallback failed; using direct flags:', err);
    }
  }

  for (const index of actionIndices) {
    const message = chat[index];
    const meta = anchorHiddenMeta(message);
    if (hidden || meta.hiddenAnchorIds.length > 0) {
      meta.hiddenByMemory = true;
      message.is_hidden = true;
    } else {
      meta.hiddenByMemory = false;
      message.is_hidden = meta.wasHiddenBeforeAnchor === true;
      message.is_system = meta.wasSystemBeforeAnchor === true;
      delete meta.wasHiddenBeforeAnchor;
      delete meta.wasSystemBeforeAnchor;
    }

    const element = $(`#chat .mes[mesid="${index}"], .mes[mesid="${index}"]`);
    if (message.is_hidden || isMemoryManagedHidden(message)) element.attr('is_hidden', 'true');
    else element.removeAttr('is_hidden');
    if (message.is_system) element.attr('is_system', 'true');
    else element.removeAttr('is_system');
  }

  // Hidden-state changes can affect chatRows(false) even when the chat length and tail message are
  // unchanged. Without this invalidation, old visible-row caches survived until another unrelated
  // event and the message panels/counts could disagree with the actual prompt window.
  invalidateRuntimeCaches(hidden ? 'old messages hidden by memory window' : 'memory-hidden messages restored');
  await Promise.resolve(saveChatNow());
  return true;
}

function turnMessageIndicesForAssistant(chat, assistantIndex) {
  const assistant = chat?.[assistantIndex];
  if (!Array.isArray(chat) || !assistant || assistant.is_user || !isNarrativeMessage(assistant)) return [];
  let start = assistantIndex;
  for (let index = assistantIndex - 1; index >= 0; index--) {
    const message = chat[index];
    if (!message || !isNarrativeMessage(message)) continue;
    if (!message.is_user) break;
    start = index;
  }
  const indices = [];
  for (let index = start; index <= assistantIndex; index++) {
    const message = chat[index];
    if (!message || !isNarrativeMessage(message)) continue;
    indices.push(index);
  }
  return indices;
}

function coveredRowsForAnchorRows(rows) {
  const chat = getContext().chat || [];
  const byIndex = new Map();
  for (const row of rows || []) {
    for (const index of turnMessageIndicesForAssistant(chat, row.index)) {
      const message = chat[index];
      if (!message) continue;
      byIndex.set(index, {
        index,
        key: messageKey(message, index),
        role: messageRole(message),
        name: message.name || '',
        sendDate: message.send_date || '',
      });
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function indicesForCoveredAnchor(anchor) {
  const chat = getContext().chat || [];
  const indices = new Set();
  const keys = new Set(anchor?.coveredKeys || []);
  if (keys.size > 0) {
    for (let index = 0; index < chat.length; index++) {
      const message = chat[index];
      if (!message) continue;
      if (keys.has(messageKey(message, index))) indices.add(index);
    }
    return [...indices].sort((a, b) => a - b);
  }
  const sourceKeys = new Set(anchor?.sourceKeys || []);
  if (sourceKeys.size > 0) {
    for (let index = 0; index < chat.length; index++) {
      const message = chat[index];
      if (!message) continue;
      if (!sourceKeys.has(messageKey(message, index))) continue;
      for (const coveredIndex of turnMessageIndicesForAssistant(chat, index)) indices.add(coveredIndex);
    }
    return [...indices].sort((a, b) => a - b);
  }
  if (!Array.isArray(anchor?.coveredFloors) && Array.isArray(anchor?.sourceFloors)) {
    for (const sourceFloor of anchor.sourceFloors) {
      for (const coveredIndex of turnMessageIndicesForAssistant(chat, sourceFloor)) indices.add(coveredIndex);
    }
    return [...indices].sort((a, b) => a - b);
  }
  for (const index of anchor?.coveredFloors || []) {
    if (Number.isInteger(index) && index >= 0 && index < chat.length && chat[index]) indices.add(index);
  }
  return [...indices].sort((a, b) => a - b);
}

async function setAnchorCoveredMessagesHidden(anchor, hidden = true) {
  if (!anchor) return false;
  return setMessagesHiddenByAnchor(indicesForCoveredAnchor(anchor), hidden, anchor.id);
}

function recentRawHistoryPlan(chat = getContext().chat || [], keepRecent = Math.max(1, Number(settings().keepRecent) || 3)) {
  const safeChat = Array.isArray(chat) ? chat : [];
  const assistantIndices = [];
  for (let index = 0; index < safeChat.length; index++) {
    const message = safeChat[index];
    if (!message || !isNarrativeMessage(message) || message.is_user || !cleanText(message.mes || '')) continue;
    assistantIndices.push(index);
  }

  const keepCount = Math.max(1, Number(keepRecent) || 3);
  const keepAssistantIndices = assistantIndices.slice(-keepCount);
  const keepIndices = new Set();
  for (const assistantIndex of keepAssistantIndices) {
    for (const index of turnMessageIndicesForAssistant(safeChat, assistantIndex)) keepIndices.add(index);
  }

  // While a new reply is being requested, the newest user input has no assistant partner yet.
  // It must remain in the prompt together with any other narrative rows after the latest AI floor.
  const lastAssistantIndex = assistantIndices.length ? assistantIndices[assistantIndices.length - 1] : -1;
  for (let index = lastAssistantIndex + 1; index < safeChat.length; index++) {
    const message = safeChat[index];
    if (message && isNarrativeMessage(message)) keepIndices.add(index);
  }

  const hideIndices = [];
  for (let index = 0; index < safeChat.length; index++) {
    const message = safeChat[index];
    if (!message || !isNarrativeMessage(message) || keepIndices.has(index)) continue;
    hideIndices.push(index);
  }

  return {
    keepRecent: keepCount,
    assistantIndices,
    keepAssistantIndices,
    keepIndices: [...keepIndices].sort((a, b) => a - b),
    hideIndices,
  };
}

async function enforceAnchorHiddenState(data = memoryData()) {
  const chat = getContext().chat || [];
  if (!Array.isArray(chat) || chat.length === 0) return false;

  // “保留最近 N 个 AI 正文”是独立的硬窗口，不再依赖摘要是否成功、是否进入15回合锚点。
  // 摘要失败只能造成记忆缺口，不能让第四轮及以前的完整正文重新泄漏到 chat history。
  const plan = recentRawHistoryPlan(chat);
  const desiredHidden = new Set(
    settings().enabled && settings().autoHide ? plan.hideIndices : [],
  );

  const toHide = [];
  const toUnhide = [];
  for (let index = 0; index < chat.length; index++) {
    const message = chat[index];
    if (!message) continue;
    const managed = isMemoryManagedHidden(message) || (!!message.is_hidden && !!memoryHideMeta(message));
    if (desiredHidden.has(index)) {
      if (!managed || !message.is_hidden) toHide.push(index);
    } else if (managed) {
      toUnhide.push(index);
    }
  }

  let changed = false;
  if (toHide.length > 0) changed = await setMessagesHiddenByAnchor(toHide, true, 'recent-window') || changed;
  if (toUnhide.length > 0) changed = await setMessagesHiddenByAnchor(toUnhide, false, '*') || changed;
  return changed;
}

function currentRowForGodlog(item, includeUser = false) {
  if (!item) return null;
  const rows = chatRows(true, includeUser);
  return rows.find(row => row.key === item.key)
    || rows.find(row => row.index === item.floor && (!item.sendDate || row.sendDate === item.sendDate))
    || null;
}

function syncLatestGodlogPositionFields(data) {
  const latest = [...(data.godlogs || [])]
    .filter(item => !item.archived && item.status === 'ready' && !item.stale && item.body)
    .sort((a, b) => (b.floor ?? -1) - (a.floor ?? -1) || (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (!latest) return false;

  let nextBody = latest.body;
  if (data.codex.currentTime) nextBody = replaceGodlogField(nextBody, 'Time', data.codex.currentTime);
  if (data.codex.currentPlace) nextBody = replaceGodlogField(nextBody, 'Pln', data.codex.currentPlace);
  if (nextBody === latest.body) return false;

  latest.body = nextBody;
  latest.editedAt = Date.now();
  latest.updatedAt = Date.now();
  removeStoredVector(data, latest.id);
  syncGodlogBlockToMessage(currentRowForGodlog(latest), latest.body);
  return true;
}

async function generateGodlogForRow(row, force = false) {
  if (!hasPersistentChatContext()) return false;
  if (!row || row.role !== 'assistant') {
    if (row?.role === 'user') removeGodlogBlockFromMessage(row);
    return false;
  }
  const data = memoryData();
  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  const existing = godlogForRow(data, row);
  const replacingCompleted = !!(force && isCompletedSummary(existing));

  if (!force && isGodlogReady(existing, row)) {
    if (syncGodlogNumber(existing, row)) {
      removeStoredVector(data, existing.id);
      saveMemory();
    }
    syncGodlogBlockToMessage(row, existing.body);
    refreshTimelineFromGodlogs(data);
    await updateCodexFromGodlog(data, row, existing);
    if (!isSameChatContext(contextToken)) return false;
    await ensureMemoryItemEmbedded(data, existing.id, safeGodlogMemoryText(existing.body || ''));
    return true;
  }
  if (!force && existing?.status === 'failed') {
    const s = settings();
    const canRetry = !!(s.useSecondary && s.secondaryUrl && s.secondaryKey && (existing.retryCount || 0) < 3);
    if (!canRetry) return false;
  }

  if (!isRowSettledForGodlog(row)) {
    const latest = latestAssistantRow();
    const isLatest = !!latest && latest.key === row.key;
    const visibleGenerationActive = isLatest && isGenerationActive();
    // Manual rerun may break a stale lifecycle latch, but the old completed summary remains active
    // until a replacement has actually passed validation and is ready to commit.
    if (force && !visibleGenerationActive) {
      state.generationLifecycleActive = false;
      cancelSettleTimer(row);
    } else {
      scheduleMemoryAfterSettle('当前楼正文稳定后写摘要', row);
      return false;
    }
  }

  const sourceHash = row.rawHash;
  state.activeSummaryRowKey = row.key;
  const item = replacingCompleted
    ? existing
    : upsertGodlog(data, row, force
      ? { status: 'pending', stale: !!existing?.body, error: '正在重新生成；成功前不会替换已有摘要。' }
      : { status: 'pending', error: '' });

  if (replacingCompleted) {
    item.rerunPending = true;
    item.rerunError = '';
    item.rerunStartedAt = Date.now();
  }
  saveMemory();
  showStatus(`正在写逐楼摘要：第 ${row.index + 1} 楼`);

  try {
    let body = normalizeGodlogBlock(await callSummaryWriter(buildGodlogPrompt(data, row, item), 1200));
    if (!isSameChatContext(contextToken)) return false;
    body = replaceGodlogField(body, 'Nub', String(item.number || godlogNumberForRow(row) || 1));
    if (!body || body.trim().length < 30) throw new Error('摘要内容为空或过短');

    // Never commit against a source revision different from the one sent to the writer. For a
    // manual rerun, keep the old ready snapshot untouched instead of demoting it to missing/stale.
    const latestRow = currentRowForGodlog(item);
    if (!latestRow || latestRow.rawHash !== sourceHash) {
      if (replacingCompleted) {
        item.rerunPending = false;
        item.rerunError = latestRow
          ? '重跑期间楼层内容继续变化；旧摘要仍然保留，请在正文稳定后手动重跑。'
          : '重跑期间源楼层被删除；旧摘要记录仍保留在摘要页。';
        item.rerunFinishedAt = Date.now();
        if (latestRow) preserveCompletedGodlogOnSourceChange(data, item, latestRow, '重跑期间楼层内容发生变化');
        saveMemory(true);
        scheduleGodlogPanelRender();
        return false;
      }
      if (latestRow) markGodlogForSourceRefresh(data, item, latestRow, '摘要生成期间楼层内容继续变化');
      else forgetGodlogItem(data, item, '摘要生成期间源楼层被删除');
      saveMemory(true);
      scheduleMemoryAfterSettle('楼层变化后重新写摘要', latestRow || null);
      scheduleGodlogPanelRender();
      return false;
    }

    // Replacement is transactional: dependent memories are revoked only after the new summary is
    // complete and validated. A failed rerun therefore never destroys the last good snapshot.
    if (force && existing) {
      markAnchorsStaleByKey(data, row.key, '逐楼摘要被手动重跑');
      delete data.messageRecalls?.[row.key];
      rollbackRelationshipToFloor(data, Number(row.index) - 1, '逐楼摘要被手动重跑');
      markCodexDirty(data, '逐楼摘要被手动重跑');
    }

    Object.assign(item, {
      number: godlogNumberForRow(row) || item.number,
      floor: row.index,
      key: row.key,
      role: row.role,
      name: row.name,
      sendDate: row.sendDate,
      body,
      rawHash: sourceHash,
      status: 'ready',
      stale: false,
      staleSince: 0,
      previousRawHash: '',
      error: '',
      retryCount: 0,
      currentRawHash: '',
      sourceMismatch: false,
      sourceMismatchReason: '',
      sourceMismatchAt: 0,
      rerunPending: false,
      rerunError: '',
      rerunFinishedAt: Date.now(),
      updatedAt: Date.now(),
    });
    syncGodlogBlockToMessage(row, item.body);
    refreshCoverageMaps(data);
    refreshTimelineFromGodlogs(data);
    data.processing.lastError = '';
    saveMemory(true);
    await enforceAnchorHiddenState(data);
    if (!isSameChatContext(contextToken)) return false;
    await updateCodexFromGodlog(data, row, item);
    if (!isSameChatContext(contextToken)) return false;
    await embedMemoryItem(data, item.id, safeGodlogMemoryText(item.body || ''));
    saveMemory(true);
    if (force && existing) queueMemoryJob('逐楼摘要已手动重跑', 120);
    return true;
  } catch (err) {
    if (!isSameChatContext(contextToken)) return false;
    if (replacingCompleted) {
      item.rerunPending = false;
      item.rerunError = err.message;
      item.rerunFinishedAt = Date.now();
      data.processing.lastError = `摘要重跑失败，旧摘要已保留：${err.message}`;
      saveMemory();
      return false;
    }
    const retryCount = (item.retryCount || 0) + 1;
    Object.assign(item, {
      status: retryCount >= 3 || /副API/.test(err.message) ? 'failed' : 'pending',
      stale: !!item.body,
      retryCount,
      error: err.message,
      updatedAt: Date.now(),
    });
    data.processing.lastError = err.message;
    saveMemory();
    return false;
  } finally {
    if (state.contextEpoch === operationEpoch && state.activeSummaryRowKey === row.key) state.activeSummaryRowKey = '';
    if (isSameChatContext(contextToken)) scheduleGodlogPanelRender(row.index);
  }
}

async function processGodlogBacklog(limit = 4) {
  if (!hasPersistentChatContext()) return false;
  if (state.summaryRunning) return false;
  const data = memoryData();
  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  const pending = pendingGodlogRows(data);
  const rows = pending.filter(row => isRowSettledForGodlog(row)).slice(0, limit);
  const unsettledRows = pending.filter(row => !isRowSettledForGodlog(row)).slice(0, 8);
  for (const unsettled of unsettledRows) {
    scheduleMemoryAfterSettle('等待该楼正文稳定后写摘要', unsettled);
  }
  if (rows.length === 0) return pending.length === 0;

  state.summaryRunning = true;
  data.processing.summaryBusy = true;
  data.processing.lastError = '';
  saveMemory();

  try {
    let okCount = 0;
    for (const row of rows) {
      if (!isSameChatContext(contextToken)) return false;
      const ok = await generateGodlogForRow(row, false);
      if (!isSameChatContext(contextToken)) return false;
      if (ok) okCount++;
      if (!ok && (!settings().useSecondary || !settings().secondaryUrl || !settings().secondaryKey)) break;
    }
    return okCount === rows.length;
  } finally {
    if (state.contextEpoch === operationEpoch) state.summaryRunning = false;
    if (!isSameChatContext(contextToken)) return;
    data.processing.summaryBusy = false;
    saveMemory();
    updatePreview();
  }
}

async function repairMissingGodlogs(limit = Number.MAX_SAFE_INTEGER) {
  if (state.summaryRunning) {
    toastr?.warning?.('逐楼摘要正在生成，稍后再试', 'Anchor Memory');
    return false;
  }
  const data = memoryData();
  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  const rows = missingGodlogRepairRows(data).slice(0, limit);
  if (rows.length === 0) {
    toastr?.info?.('没有缺失的逐楼摘要', 'Anchor Memory');
    return true;
  }

  state.summaryRunning = true;
  data.processing.summaryBusy = true;
  data.processing.lastError = '';
  saveMemory();

  try {
    let okCount = 0;
    for (const row of rows) {
      if (!isSameChatContext(contextToken)) return false;
      const ok = await generateGodlogForRow(row, true);
      if (!isSameChatContext(contextToken)) return false;
      if (ok) okCount++;
      if (!ok && (!settings().useSecondary || !settings().secondaryUrl || !settings().secondaryKey)) break;
    }
    if (okCount === rows.length) {
      toastr?.success?.(`已自动补写 ${okCount} 楼逐楼摘要`, 'Anchor Memory');
    } else {
      toastr?.warning?.(`已补写 ${okCount}/${rows.length} 楼；未完成的楼层会阻塞后续锚点边界。超过最近正文窗口后，主模型只会收到摘要缺失提示，不会回退发送完整旧正文`, 'Anchor Memory');
    }
    return okCount === rows.length;
  } finally {
    if (state.contextEpoch === operationEpoch) state.summaryRunning = false;
    if (!isSameChatContext(contextToken)) return;
    data.processing.summaryBusy = false;
    saveMemory();
    updatePreview();
  }
}

function outboundMessageText(message) {
  if (!message) return '';
  if (typeof message.mes === 'string') return cleanText(message.mes);
  if (typeof message.content === 'string') return cleanText(message.content);
  if (Array.isArray(message.content)) {
    return cleanText(message.content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('\n'));
  }
  return '';
}

function normalizePromptBody(text) {
  return cleanText(text).replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function promptBodyPattern(text) {
  const source = cleanText(text).trim();
  if (source.length < 12) return null;
  const tokens = source.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return new RegExp(tokens.map(escapeRegExp).join('\\s+'), 'g');
}

function replaceOutboundMessageText(outbound, index, text, backups = null) {
  if (!Array.isArray(outbound) || index < 0 || index >= outbound.length || !outbound[index]) return false;
  if (backups && !backups.has(index)) backups.set(index, outbound[index]);
  const original = outbound[index];
  const next = { ...original, anchor_memory_context_replacement: true };
  if (typeof original.mes === 'string' || !('content' in original)) {
    next.mes = text;
  } else if (typeof original.content === 'string') {
    next.content = text;
  } else if (Array.isArray(original.content)) {
    next.content = [{ type: 'text', text }];
  } else {
    next.content = text;
  }
  outbound[index] = next;
  return true;
}

function replaceTextFragment(value, originalText, replacement) {
  if (typeof value !== 'string') return { changed: false, value };
  const cleanOriginal = cleanText(originalText);
  if (!cleanOriginal) return { changed: false, value };
  if (value.includes(cleanOriginal)) {
    return { changed: true, value: value.split(cleanOriginal).join(replacement) };
  }
  const pattern = promptBodyPattern(cleanOriginal);
  if (pattern && pattern.test(value)) {
    pattern.lastIndex = 0;
    return { changed: true, value: value.replace(pattern, replacement) };
  }
  return { changed: false, value };
}

function replaceOutboundMessageFragment(outbound, index, originalText, replacement, backups = null) {
  if (!Array.isArray(outbound) || index < 0 || index >= outbound.length || !outbound[index]) return false;
  const original = outbound[index];
  const next = { ...original, anchor_memory_context_replacement: true };
  let changed = false;
  if (typeof original.mes === 'string' || !('content' in original)) {
    const result = replaceTextFragment(String(original.mes || ''), originalText, replacement);
    changed = result.changed;
    next.mes = result.value;
  } else if (typeof original.content === 'string') {
    const result = replaceTextFragment(original.content, originalText, replacement);
    changed = result.changed;
    next.content = result.value;
  } else if (Array.isArray(original.content)) {
    next.content = original.content.map(part => {
      if (typeof part === 'string') {
        const result = replaceTextFragment(part, originalText, replacement);
        changed = changed || result.changed;
        return result.value;
      }
      if (part && typeof part.text === 'string') {
        const result = replaceTextFragment(part.text, originalText, replacement);
        changed = changed || result.changed;
        return { ...part, text: result.value };
      }
      return part;
    });
  }
  if (!changed) return false;
  if (backups && !backups.has(index)) backups.set(index, original);
  outbound[index] = next;
  return true;
}

function outboundRoleMatchesContext(outboundMessage, contextMessage) {
  if (!outboundMessage?.role || !contextMessage) return true;
  const expected = contextMessage.is_user ? 'user' : 'assistant';
  return outboundMessage.role === expected;
}

function findOutboundIndexForContextMessage(outbound, contextChat, contextIndex, used = new Set()) {
  if (!Array.isArray(outbound)) return -1;
  const original = contextChat?.[contextIndex];
  const originalText = cleanText(original?.mes || '');
  if (!originalText) return -1;
  const normalizedOriginal = normalizePromptBody(originalText);
  const direct = outbound[contextIndex];
  if (
    direct
    && !used.has(contextIndex)
    && outboundRoleMatchesContext(direct, original)
    && normalizePromptBody(outboundMessageText(direct)) === normalizedOriginal
  ) {
    return contextIndex;
  }
  for (let index = 0; index < outbound.length; index++) {
    if (used.has(index)) continue;
    if (!outboundRoleMatchesContext(outbound[index], original)) continue;
    const outboundText = outboundMessageText(outbound[index]);
    const normalizedOutbound = normalizePromptBody(outboundText);
    if (normalizedOutbound === normalizedOriginal) return index;
    if (normalizedOriginal.length >= 30 && normalizedOutbound.includes(normalizedOriginal)) return index;
  }
  return -1;
}

function hideOutboundContextMessage(outbound, contextChat, contextIndex, replacement, used = new Set(), backups = null) {
  const outboundIndex = findOutboundIndexForContextMessage(outbound, contextChat, contextIndex, used);
  if (outboundIndex >= 0) {
    if (replaceOutboundMessageText(outbound, outboundIndex, replacement, backups)) {
      used.add(outboundIndex);
      return 'whole-message';
    }
  }

  const original = contextChat?.[contextIndex];
  const originalText = cleanText(original?.mes || '');
  if (!originalText) return '';
  for (let index = 0; index < outbound.length; index++) {
    if (!outboundRoleMatchesContext(outbound[index], original)) continue;
    if (replaceOutboundMessageFragment(outbound, index, originalText, replacement, backups)) {
      return 'body-fragment';
    }
  }
  return '';
}

function buildOutboundSearchCache(outbound = []) {
  const entries = [];
  const exactByRole = new Map();
  const exactAnyRole = new Map();
  for (let index = 0; index < outbound.length; index++) {
    const message = outbound[index];
    const normalized = normalizePromptBody(outboundMessageText(message));
    const role = String(message?.role || '');
    const entry = { index, role, normalized };
    entries.push(entry);
    if (!normalized) continue;
    const roleKey = `${role}\u0000${normalized}`;
    if (!exactByRole.has(roleKey)) exactByRole.set(roleKey, []);
    exactByRole.get(roleKey).push(index);
    if (!exactAnyRole.has(normalized)) exactAnyRole.set(normalized, []);
    exactAnyRole.get(normalized).push(index);
  }
  return { entries, exactByRole, exactAnyRole };
}

function stripOutboundContextMessage(outbound, contextChat, contextIndex, used = new Set(), removals = new Set(), backups = null, searchCache = null) {
  if (!Array.isArray(outbound)) return '';
  const original = contextChat?.[contextIndex];
  const originalText = cleanText(original?.mes || '');
  if (!originalText) return '';
  const normalizedOriginal = normalizePromptBody(originalText);
  const cache = searchCache || buildOutboundSearchCache(outbound);
  const expectedRole = original?.is_user ? 'user' : 'assistant';

  // Remove every dedicated duplicate of this chatHistory item. Normalize each outbound item once
  // per request instead of once per old floor; the old path became quadratic on long chats.
  let exactMatches = 0;
  const exactCandidates = cache.exactByRole.get(`${expectedRole}\u0000${normalizedOriginal}`) || [];
  for (const index of exactCandidates) {
    if (used.has(index)) continue;
    if (backups && !backups.has(index)) backups.set(index, outbound[index]);
    removals.add(index);
    used.add(index);
    exactMatches++;
  }
  if (exactMatches > 0) return 'whole-message';

  // Wrapped prompt items are rarer. Narrow fallback scans using already-normalized text and a short
  // source prefix, then run the expensive regex replacement only on plausible candidates.
  const prefix = normalizedOriginal.slice(0, Math.min(48, normalizedOriginal.length));
  const roleCandidates = cache.entries.filter(entry => (
    (!entry.role || entry.role === expectedRole)
    && (!prefix || entry.normalized.includes(prefix))
  ));
  let fragments = 0;
  for (const entry of roleCandidates) {
    if (replaceOutboundMessageFragment(outbound, entry.index, originalText, '', backups)) fragments++;
  }
  if (fragments > 0) return 'body-fragment';

  // Last compatibility fallback for templates that rewrite roles. Keep it prefix-filtered so an
  // absent historical floor does not rescan every prompt item.
  const anyRoleCandidates = cache.entries.filter(entry => !prefix || entry.normalized.includes(prefix));
  for (const entry of anyRoleCandidates) {
    if (replaceOutboundMessageFragment(outbound, entry.index, originalText, '', backups)) fragments++;
  }
  return fragments > 0 ? 'body-fragment-any-role' : '';
}

function removeOutboundIndices(outbound, removals) {
  if (!Array.isArray(outbound) || !removals?.size) return 0;
  const indices = [...removals]
    .filter(index => Number.isInteger(index) && index >= 0 && index < outbound.length)
    .sort((a, b) => b - a);
  for (const index of indices) outbound.splice(index, 1);
  return indices.length;
}

function hiddenAssistantTurnText(row, godlog) {
  if (isGodlogReady(godlog, row)) {
    return `【剧情资料｜旧楼摘要｜第 ${row.index + 1} 楼】\n${safePromptMemoryText('godlog', godlog, 1300)}`;
  }
  return `【剧情资料｜旧楼正文已隐藏｜第 ${row.index + 1} 楼】\n这一楼已超过最近原文保留窗口，正文未发送给主模型；逐楼摘要尚未生成。请不要凭空补写这一楼细节。`;
}

function hiddenUserTurnText(assistantRow) {
  return `【剧情资料｜旧用户输入已隐藏】\n该输入已由第 ${assistantRow.index + 1} 楼摘要覆盖，原文未发送给主模型。`;
}

function applyGodlogContextReplacement(outboundChat = [], options = {}) {
  const s = settings();
  const keepRecent = Math.max(1, Number(s.keepRecent) || 3);
  const emptyStats = {
    at: Date.now(), replaced: 0, covered: 0, hiddenBodies: 0, removedMessages: 0,
    fragmentHidden: 0, unmatched: 0, missing: 0, keepRecent, rawKept: 0,
    mode: options.mode || 'history-hide',
  };
  if (!s.enabled || !Array.isArray(outboundChat)) return emptyStats;

  const data = memoryData();
  refreshCoverageMaps(data);
  const contextChat = getContext().chat || [];
  const strictPlan = recentRawHistoryPlan(contextChat, keepRecent);
  if (strictPlan.hideIndices.length === 0) {
    const stats = { ...emptyStats, rawKept: strictPlan.keepAssistantIndices.length };
    if (options.save !== false) {
      data.processing.lastContextReplacement = stats;
      saveMemory();
    }
    return stats;
  }

  // Work only on message indices that can actually enter this request. Older builds scanned every
  // assistant floor and then repeatedly searched the outbound array, which became quadratic.
  const assistantRows = chatRows(true).filter(row => row.role === 'assistant');
  const assistantByIndex = new Map(assistantRows.map(row => [row.index, row]));
  const godlogs = godlogIndex(data);
  const coveredKeys = new Set([
    ...Object.keys(data.processing?.mergedKeys || {}),
    ...Object.keys(data.processing?.anchoredKeys || {}),
  ]);
  const usedOutbound = new Set();
  const backups = outboundChat === contextChat ? new Map() : null;
  const removals = new Set();
  const outboundSearchCache = buildOutboundSearchCache(outboundChat);
  const prune = options.prune !== false && outboundChat !== contextChat;
  const touchedAssistantKeys = new Set();
  const missingAssistantKeys = new Set();
  let covered = 0;
  let hiddenBodies = 0;
  let fragmentHidden = 0;
  let unmatched = 0;

  for (const contextIndex of strictPlan.hideIndices) {
    const contextMessage = contextChat[contextIndex];
    if (!contextMessage) continue;
    const row = assistantByIndex.get(contextIndex);
    const godlog = row ? godlogs.get(row.key) : null;
    if (row) {
      touchedAssistantKeys.add(row.key);
      if (!coveredKeys.has(row.key) && !isGodlogReady(godlog, row)) missingAssistantKeys.add(row.key);
    }

    let method = '';
    if (prune) {
      method = stripOutboundContextMessage(
        outboundChat,
        contextChat,
        contextIndex,
        usedOutbound,
        removals,
        backups,
        outboundSearchCache,
      );
    } else {
      const replacement = row
        ? hiddenAssistantTurnText(row, godlog)
        : '【剧情资料｜旧用户输入已隐藏】\n该输入已超过最近正文保留窗口，原文未发送给主模型。';
      method = hideOutboundContextMessage(
        outboundChat,
        contextChat,
        contextIndex,
        replacement,
        usedOutbound,
        backups,
      );
    }

    if (!method) {
      unmatched++;
      continue;
    }
    covered++;
    hiddenBodies++;
    if (method.includes('fragment')) fragmentHidden++;
  }

  const removedMessages = prune ? removeOutboundIndices(outboundChat, removals) : 0;
  restoreTemporaryContextReplacement(outboundChat, backups);
  const stats = {
    at: Date.now(),
    replaced: touchedAssistantKeys.size,
    covered,
    hiddenBodies,
    removedMessages,
    fragmentHidden,
    unmatched,
    missing: missingAssistantKeys.size,
    keepRecent,
    rawKept: strictPlan.keepAssistantIndices.length,
    mode: options.mode || 'history-hide',
  };
  if (options.save !== false) {
    data.processing.lastContextReplacement = stats;
    saveMemory();
  }
  return stats;
}

function restoreTemporaryContextReplacement(outbound, backups) {
  if (!Array.isArray(outbound) || !backups?.size) return;
  setTimeout(() => {
    for (const [index, original] of backups.entries()) {
      if (outbound[index]?.anchor_memory_context_replacement) outbound[index] = original;
    }
  }, 0);
}

async function createAnchorUnlocked(force = false, customMaterials = null) {
  if (!hasPersistentChatContext()) return false;
  const s = settings();
  let data = memoryData();
  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  if (data.processing.busy || state.running) return false;
  if (!customMaterials) {
    await processGodlogBacklog(force ? Number(s.anchorInterval) || 15 : 4);
    if (!isSameChatContext(contextToken)) return false;
    data = memoryData();
    // A 100-turn boundary has priority over a 15-turn anchor. This prevents a 91-105 anchor
    // from straddling the 100-turn merge and being injected twice.
    if (!force && mergeCycleMaterials(data).length >= Math.max(1, Number(s.mergeInterval) || 100)) {
      await maybeMerge(false, true);
      if (!isSameChatContext(contextToken)) return false;
      data = memoryData();
    }
  }
  const interval = Math.max(1, Number(s.anchorInterval) || 15);
  const available = customMaterials || pendingAnchorMaterials(data);
  const materials = available.slice(0, interval);
  if (!force && materials.length < interval) return false;
  if (materials.length === 0) {
    if (force) toastr?.info?.('没有连续且已完成的未锚定摘要', 'Anchor Memory');
    return false;
  }
  if (!force && materials.some(item => !isGodlogReady(item.godlog, item.row))) return false;

  state.running = true;
  data.processing.busy = true;
  data.processing.lastError = '';
  saveMemory();
  showStatus(`正在生成锚点：${materials.length} 份逐楼摘要`);

  try {
    const number = data.processing.anchorCount + 1;
    const body = normalizeAnchorBody(await callWriter(buildAnchorPrompt(data, materials), 4200), number);
    if (!isSameChatContext(contextToken)) return false;
    if (!body || body.trim().length < 60) throw new Error('锚点内容为空或过短');
    const rows = materials.map(item => item.row);
    const sourceFloors = rows.map(row => row.index);
    const sourceKeys = rows.map(row => row.key);
    const sourceGodlogIds = materials.map(item => item.godlog?.id).filter(Boolean);
    const coveredRows = coveredRowsForAnchorRows(rows);
    const id = `am_anchor_${Date.now()}_${stableHash(body).slice(0, 6)}`;
    const anchor = {
      id,
      number,
      kind: 'anchor15',
      body: body.trim(),
      sourceFloors,
      sourceKeys,
      sourceGodlogIds,
      coveredFloors: coveredRows.map(row => row.index),
      coveredKeys: coveredRows.map(row => row.key),
      createdAt: Date.now(),
    };
    data.anchors.push(anchor);
    renumberDerivedMemory(data);
    anchor.number = data.anchors.indexOf(anchor) + 1;
    data.processing.anchorCount = data.anchors.length;
    data.processing.lastAnchorFloor = Math.max(...sourceFloors);
    refreshCoverageMaps(data);
    saveMemory(true);
    try { await enforceAnchorHiddenState(data); } catch (err) { console.warn('[AnchorMemory] anchor hide reconciliation failed', err); }
    if (!isSameChatContext(contextToken)) return false;
    await embedMemoryItem(data, id, anchor.body);
    if (!isSameChatContext(contextToken)) return false;
    await maybeMerge(false, true);
    if (!isSameChatContext(contextToken)) return false;
    safeUpdatePreview('锚点完成后刷新');
    toastr?.success?.(`第 ${number} 次锚点完成`, 'Anchor Memory');
    return true;
  } catch (err) {
    if (!isSameChatContext(contextToken)) return false;
    data.processing.lastError = err.message;
    saveMemory();
    toastr?.error?.(`锚点失败：${err.message}`, 'Anchor Memory');
    return false;
  } finally {
    if (state.contextEpoch === operationEpoch) state.running = false;
    if (!isSameChatContext(contextToken)) return;
    data.processing.busy = false;
    saveMemory(true);
    showStatus(statusText(data));
  }
}



async function createAnchor(force = false, customMaterials = null) {
  if (state.anchorPreparing || state.mergeRunning) {
    if (force) toastr?.warning?.('已有锚点或累计合并任务正在运行，请勿重复点击', 'Anchor Memory');
    return false;
  }
  const operationEpoch = state.contextEpoch;
  state.anchorPreparing = true;
  try {
    return await createAnchorUnlocked(force, customMaterials);
  } finally {
    if (state.contextEpoch === operationEpoch) state.anchorPreparing = false;
  }
}


async function maybeMergeUnlocked(force = false) {
  if (!hasPersistentChatContext()) return false;
  if (state.running && force) {
    toastr?.warning?.('锚点任务正在运行，稍后再合并', 'Anchor Memory');
    return false;
  }
  const s = settings();
  const data = memoryData();
  const contextToken = captureChatContextToken(data);
  const interval = Math.max(1, Number(s.mergeInterval) || 100);
  const cycle = mergeCycleMaterials(data);
  if (!force && cycle.length < interval) return false;
  const materials = force ? cycle : cycle.slice(0, interval);
  if (materials.length === 0) {
    if (force) toastr?.info?.('没有可合并的新摘要', 'Anchor Memory');
    return false;
  }

  const sourceKeys = materials.map(item => item.row.key);
  const sourceKeySet = new Set(sourceKeys);
  const rowOrder = new Map(materials.map((item, index) => [item.row.key, index]));
  const represented = new Set();
  const blocks = [];
  for (const anchor of activeAnchorsAfterMerge(data)) {
    const keys = anchor.sourceKeys || [];
    if (!keys.length || !keys.every(key => sourceKeySet.has(key))) continue;
    keys.forEach(key => represented.add(key));
    blocks.push({
      kind: 'anchor',
      item: anchor,
      order: Math.min(...keys.map(key => rowOrder.get(key) ?? Number.MAX_SAFE_INTEGER)),
    });
  }
  for (const material of materials) {
    if (represented.has(material.row.key)) continue;
    blocks.push({ kind: 'godlog', item: material.godlog, row: material.row, order: rowOrder.get(material.row.key) || 0 });
  }
  blocks.sort((a, b) => a.order - b.order);
  const plan = { materials, sourceKeys, blocks };

  showStatus(`正在全量合并：${materials.length} 个AI回合`);
  try {
    const mergeNumber = data.processing.mergeCount + 1;
    const body = normalizeMergeBody(await callWriter(buildMergePrompt(data, plan, force), 6200), mergeNumber);
    if (!isSameChatContext(contextToken)) return false;
    if (!body || body.trim().length < 120) throw new Error('合并内容为空或过短');

    const previous = latestMerge(data);
    const cumulativeKeys = [...new Set([...(previous?.sourceKeys || []), ...sourceKeys])];
    const number = mergeNumber;
    const id = `am_merge_${Date.now()}_${stableHash(body).slice(0, 6)}`;
    const merge = {
      id,
      number,
      kind: 'merge100',
      body: body.trim(),
      sourceKeys: cumulativeKeys,
      cycleSourceKeys: sourceKeys,
      sourceAnchorIds: blocks.filter(block => block.kind === 'anchor').map(block => block.item.id),
      sourceGodlogIds: blocks.filter(block => block.kind === 'godlog').map(block => block.item.id),
      previousMergeId: previous?.id || '',
      coverageCount: cumulativeKeys.length,
      createdAt: Date.now(),
      floorAt: materials[materials.length - 1]?.row?.index ?? data.processing.lastMergeFloor,
    };
    // Remove any legacy/delayed anchor that crosses this 100-turn boundary. Its unmerged tail
    // will be regrouped into a clean 15-turn anchor after the merge.
    const crossingIds = new Set(activeAnchorsAfterMerge(data)
      .filter(anchor => {
        const keys = anchor.sourceKeys || [];
        const inside = keys.filter(key => sourceKeySet.has(key)).length;
        return inside > 0 && inside < keys.length;
      })
      .map(anchor => anchor.id));
    if (crossingIds.size) {
      data.anchors = data.anchors.filter(anchor => {
        if (!crossingIds.has(anchor.id)) return true;
        removeStoredVector(data, anchor.id);
        return false;
      });
    }

    for (const block of blocks) {
      if (block.kind === 'anchor' && block.item) block.item.compactedIntoMergeId = id;
    }
    data.merges.push(merge);
    renumberDerivedMemory(data);
    merge.number = data.merges.indexOf(merge) + 1;
    data.processing.mergeCount = data.merges.length;
    data.processing.lastMergeFloor = merge.floorAt;
    refreshCoverageMaps(data);
    saveMemory(true);
    try { await enforceAnchorHiddenState(data); } catch (err) { console.warn('[AnchorMemory] merge hide reconciliation failed', err); }
    if (!isSameChatContext(contextToken)) return false;
    await embedMemoryItem(data, id, merge.body);
    safeUpdatePreview('全量合并后刷新');
    toastr?.success?.(`第 ${number} 次全量合并完成（累计 ${cumulativeKeys.length} 个AI回合）`, 'Anchor Memory');
    return true;
  } catch (err) {
    if (!isSameChatContext(contextToken)) return false;
    data.processing.lastError = err.message;
    saveMemory();
    toastr?.error?.(`合并失败：${err.message}`, 'Anchor Memory');
    return false;
  } finally {
    if (isSameChatContext(contextToken)) showStatus(statusText(data));
  }
}

async function maybeMerge(force = false, allowDuringAnchor = false) {
  if (state.mergeRunning || ((state.anchorPreparing || state.running) && !allowDuringAnchor)) {
    if (force) toastr?.warning?.('已有锚点或累计合并任务正在运行，请勿重复点击', 'Anchor Memory');
    return false;
  }
  const operationEpoch = state.contextEpoch;
  state.mergeRunning = true;
  const data = hasPersistentChatContext() ? memoryData() : null;
  const contextToken = data ? captureChatContextToken(data) : null;
  if (data?.processing) {
    data.processing.mergeBusy = true;
    saveMemory();
  }
  try {
    return await maybeMergeUnlocked(force);
  } finally {
    if (state.contextEpoch === operationEpoch) state.mergeRunning = false;
    if (data?.processing && isSameChatContext(contextToken)) {
      data.processing.mergeBusy = false;
      saveMemory(true);
    }
  }
}

async function batchInitializeHistory() {
  const s = settings();
  const data = memoryData();
  if (state.running || state.summaryRunning || data.processing.busy) {
    toastr?.warning?.('已有记忆任务正在运行', 'Anchor Memory');
    return;
  }
  const total = pendingGodlogRows(data).length;
  if (total === 0 && pendingAnchorMaterials(data).length === 0 && mergeCycleMaterials(data).length < Number(s.mergeInterval)) {
    toastr?.info?.('没有需要初始化的历史楼层', 'Anchor Memory');
    return;
  }
  if (!confirm(`将补写逐楼摘要，并严格按每 ${s.anchorInterval} 个AI回合生成锚点、每 ${s.mergeInterval} 个AI回合生成累计历史锚点。继续？`)) return;

  await processGodlogBacklog(Number.MAX_SAFE_INTEGER);
  const anchorInterval = Math.max(1, Number(s.anchorInterval) || 15);
  const mergeInterval = Math.max(1, Number(s.mergeInterval) || 100);
  let anchorsMade = 0;
  let mergesMade = 0;

  while (true) {
    const fresh = memoryData();
    if (mergeCycleMaterials(fresh).length >= mergeInterval) {
      if (!await maybeMerge(false)) break;
      mergesMade++;
      continue;
    }
    if (pendingAnchorMaterials(fresh).length >= anchorInterval) {
      if (!await createAnchor(false)) break;
      anchorsMade++;
      continue;
    }
    break;
  }

  updatePreview();
  toastr?.success?.(`历史初始化完成：新增 ${anchorsMade} 个分段锚点、${mergesMade} 个累计历史合并`, 'Anchor Memory');
}

function latestAssistantTailProbe() {
  const chat = getContext().chat || [];
  for (let index = chat.length - 1; index >= 0; index--) {
    const message = chat[index];
    if (!message || !isNarrativeMessage(message) || message.is_user || !message.mes) continue;
    const text = cleanText(message.mes);
    if (!text) continue;
    const turnText = turnTextForAssistant(chat, index);
    return {
      index,
      key: messageKey(message, index),
      role: 'assistant',
      name: message.name || '',
      text,
      turnText,
      rawHash: stableHash(turnText || text),
      sendDate: message.send_date || '',
      assistantNumber: 0,
    };
  }
  return null;
}

function latestAssistantRow() {
  const rows = chatRows(true);
  for (let index = rows.length - 1; index >= 0; index--) {
    if (rows[index].role === 'assistant') return rows[index];
  }
  return null;
}

function noteRowRevision(row, forceTimestamp = false) {
  if (!row?.key) return null;
  const previous = state.rowRevisionState.get(row.key);
  if (forceTimestamp || !previous || previous.hash !== row.rawHash) {
    const next = { hash: row.rawHash, changedAt: Date.now() };
    state.rowRevisionState.set(row.key, next);
    return next;
  }
  return previous;
}

function observeLatestAssistantRow(forceTimestamp = false) {
  const row = latestAssistantRow();
  if (!row) {
    state.latestRowKey = '';
    state.latestRowHash = '';
    state.latestRowChangedAt = 0;
    return null;
  }
  const revision = noteRowRevision(row, forceTimestamp);
  if (forceTimestamp || state.latestRowKey !== row.key || state.latestRowHash !== row.rawHash) {
    state.latestRowKey = row.key;
    state.latestRowHash = row.rawHash;
    state.latestRowChangedAt = revision?.changedAt || Date.now();
  } else if (!state.latestRowChangedAt) {
    state.latestRowChangedAt = revision?.changedAt || Date.now();
  }
  return row;
}

function isLatestAssistantRow(row) {
  if (!row?.key) return false;
  const latest = latestAssistantRow();
  return !!latest && latest.key === row.key;
}

function generationIsActiveForGodlog(row = null) {
  const latestOnly = row ? isLatestAssistantRow(row) : true;
  if (!latestOnly) return false;
  if (isGenerationActive()) return true;
  // Lifecycle events are only a short fallback. A missed end event must never block the queue for
  // minutes, and background/quiet API streaming must not masquerade as the visible AI generation.
  if (state.generationLifecycleActive && Date.now() - state.generationStartedAt < 30 * 1000) return true;
  if (state.generationLifecycleActive) state.generationLifecycleActive = false;
  return false;
}

function rowSettleDelay(row) {
  if (!row) return 0;
  const latest = observeLatestAssistantRow(false);
  const isLatest = !!latest && latest.key === row.key;
  if (isLatest && generationIsActiveForGodlog(row)) return GODLOG_SOURCE_SETTLE_MS;

  const revision = state.rowRevisionState.get(row.key);
  // Every row has its own revision clock. A newer visible generation must not keep an older edited
  // floor in “waiting for stability” forever.
  const changedAt = revision?.hash === row.rawHash ? revision.changedAt : 0;
  const now = Date.now();
  const sourceDelay = changedAt
    ? Math.max(0, GODLOG_SOURCE_SETTLE_MS - (now - changedAt))
    : 0;
  const generationDelay = isLatest && state.generationEndedAt
    ? Math.max(0, GODLOG_POST_GENERATION_SETTLE_MS - (now - state.generationEndedAt))
    : 0;
  return Math.max(sourceDelay, generationDelay);
}

function isRowSettledForGodlog(row) {
  if (!row) return true;
  return rowSettleDelay(row) <= 0 && !generationIsActiveForGodlog(row);
}

function settleTimerKey(row = null) {
  return row?.key ? `row:${row.key}` : 'latest';
}

function cancelSettleTimer(row = null) {
  const key = settleTimerKey(row);
  const timer = state.settleTimers.get(key);
  if (timer) clearTimeout(timer);
  state.settleTimers.delete(key);
}

function clearAllSettleTimers() {
  for (const timer of state.settleTimers.values()) clearTimeout(timer);
  state.settleTimers.clear();
  if (state.settleTimer) clearTimeout(state.settleTimer);
  state.settleTimer = null;
}

function rowByStableKey(key) {
  if (!key) return latestAssistantRow();
  return chatRows(true).find(row => row.role === 'assistant' && row.key === key) || null;
}

function scheduleMemoryAfterSettle(source = '等待当前楼正文稳定', row = null) {
  const target = row || latestAssistantRow();
  const targetKey = target?.key || '';
  const timerKey = settleTimerKey(target);
  cancelSettleTimer(target);
  const delay = Math.max(250, rowSettleDelay(target) || GODLOG_SOURCE_SETTLE_MS);
  const timer = setTimeout(() => {
    state.settleTimers.delete(timerKey);
    const current = rowByStableKey(targetKey);
    if (targetKey && !current) {
      queueMemoryJob(`${source}（源楼已删除）`, 0);
      return;
    }
    const observed = current || latestAssistantRow();
    if (observed && !isRowSettledForGodlog(observed)) {
      scheduleMemoryAfterSettle(source, observed);
      return;
    }
    queueMemoryJob(source, 0);
  }, delay + 60);
  state.settleTimers.set(timerKey, timer);
}

async function reconcileStrictRecentWindow(source = '发送前同步最近正文窗口') {
  if (!settings().enabled || !hasPersistentChatContext()) return false;
  try {
    const changed = await enforceAnchorHiddenState(memoryData());
    if (changed) {
      const plan = recentRawHistoryPlan();
      console.info(`[AnchorMemory] ${source}: 仅保留最近 ${plan.keepRecent} 个AI正文，隐藏旧消息 ${plan.hideIndices.length} 条`);
    }
    return changed;
  } catch (err) {
    console.warn('[AnchorMemory] strict recent-window reconciliation failed', err);
    return false;
  }
}

function onUserMessageRendered() {
  prepareDynamicRecall().catch(err => console.warn('[AnchorMemory] recall prefetch failed', err));
  // This event proves the previous AI floor is no longer streaming. It is an additional Horae-style
  // completion signal, while GENERATION_ENDED/STOPPED and source-hash settling remain authoritative.
  const previousAssistant = observeLatestAssistantRow(false);
  if (previousAssistant) scheduleMemoryAfterSettle('用户已发送下一条消息，处理上一AI楼', previousAssistant);
  reconcileStrictRecentWindow('用户消息写入后').catch(console.warn);
}

function onGenerationAfterCommands() {
  // Run before SillyTavern assembles the final prompt so hidden flags affect every backend, not only
  // Chat Completion payloads that emit CHAT_COMPLETION_PROMPT_READY.
  reconcileStrictRecentWindow('正式构造请求前').catch(console.warn);
}

function onGenerationStarted() {
  state.generationLifecycleActive = true;
  state.generationStartedAt = Date.now();
  // Do not cancel timers belonging to older edited floors. Their summaries are independent from
  // the newly starting visible generation.
  observeLatestAssistantRow(true);
}

function onGenerationFinished(source = '生成结束') {
  state.generationLifecycleActive = false;
  state.generationEndedAt = Date.now();
  if (state.streamProbeTimer) clearTimeout(state.streamProbeTimer);
  state.streamProbeTimer = null;
  invalidateRuntimeCaches('generation finished');
  const row = observeLatestAssistantRow(true);
  scheduleMemoryAfterSettle(source, row);
  scheduleGodlogPanelRender();
}

async function runMemoryJobQueue() {
  if (!hasPersistentChatContext()) return false;
  if (state.jobRunning) return false;
  const data = memoryData();
  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  state.jobRunning = true;
  data.processing.queueRunning = true;
  data.processing.queuePending = false;
  saveMemory();

  try {
    do {
      if (!isSameChatContext(contextToken)) return false;
      const sources = [...state.jobSources];
      state.jobSources.clear();
      data.processing.queueSources = sources;
      data.processing.queuePending = false;
      saveMemory();

      const pendingRowsNow = pendingGodlogRows(data);
      const hasSettledHistoricalWork = pendingRowsNow.some(row => isRowSettledForGodlog(row));
      if (generationIsActiveForGodlog(latestAssistantRow()) && !hasSettledHistoricalWork) {
        scheduleMemoryAfterSettle('发送完成后处理');
        break;
      }

      syncGodlogsWithChat(sources.join(' / ') || '队列同步');
      await createAnchor(false);
      if (!isSameChatContext(contextToken)) return false;
      // The merge threshold is independent from the segmented-anchor threshold.
      await maybeMerge(false);
    } while (state.jobSources.size > 0 && isSameChatContext(contextToken));
    return true;
  } catch (err) {
    if (!isSameChatContext(contextToken)) return false;
    data.processing.lastError = err.message || String(err);
    saveMemory();
    console.warn('[AnchorMemory] queued job failed', err);
    return false;
  } finally {
    if (state.contextEpoch === operationEpoch) state.jobRunning = false;
    if (!isSameChatContext(contextToken)) return;
    data.processing.queueRunning = false;
    data.processing.queuePending = state.jobSources.size > 0;
    saveMemory(true);
    updatePreview();
    if (state.jobSources.size > 0) queueMemoryJob('队列续跑');
  }
}

function queueMemoryJob(source = '消息已变动', delay = 900) {
  if (!settings().enabled || !hasPersistentChatContext()) return;
  if (!hasPendingMemoryWork()) return;
  state.jobSources.add(source);
  const data = memoryData();
  data.processing.queuePending = true;
  data.processing.queueSources = [...state.jobSources];
  saveMemory();
  if (state.jobTimer) clearTimeout(state.jobTimer);
  state.jobTimer = setTimeout(() => {
    state.jobTimer = null;
    runMemoryJobQueue();
  }, delay);
}

function scheduleAnchorCheck() {
  // Render events can fire repeatedly while a floor is still streaming or while inline image
  // metadata is being appended. Record the newest fingerprint now, revoke an already-outdated
  // summary immediately, then wait for the source to settle before requesting a replacement.
  const latest = observeLatestAssistantRow(false);
  if (latest) {
    const data = memoryData();
    const item = godlogForRow(data, latest);
    if (item?.rawHash && item.rawHash !== latest.rawHash) {
      syncGodlogsWithChat('当前楼正文仍在更新');
      scheduleGodlogPanelRender(latest.index);
    }
  }
  if (state.queueTimer) clearTimeout(state.queueTimer);
  state.queueTimer = setTimeout(() => {
    state.queueTimer = null;
    if (!hasPendingMemoryWork()) return;
    if (latest && !isRowSettledForGodlog(latest)) {
      scheduleMemoryAfterSettle('新AI楼正文稳定后处理', latest);
      return;
    }
    queueMemoryJob('新AI消息');
  }, 120);
}

function registerEventHandlers(names, handler, mode = 'on') {
  if (!eventSource || typeof eventSource.on !== 'function') {
    console.warn('[AnchorMemory] event bus is not ready; event handlers were not registered yet.');
    return;
  }
  const seen = new Set();
  for (const name of names) {
    const type = event_types?.[name];
    if (!type || seen.has(type)) continue;
    seen.add(type);
    if (mode === 'makeLast' && typeof eventSource.makeLast === 'function') {
      eventSource.makeLast(type, handler);
    } else {
      eventSource.on(type, handler);
    }
  }
}

function statusText(data = memoryData()) {
  const s = settings();
  const assistantRows = chatRows(true).filter(row => row.role === 'assistant');
  const currentAiTurn = assistantRows.length;
  const readyGodlogs = (data.godlogs || []).filter(item => item.status === 'ready').length;
  const pendingSummaries = pendingGodlogRows(data).length;
  const pendingCodex = pendingCodexRows(data).length;
  const relationshipPending = !!data.processing?.relationshipDirty;
  const continuousReady = pendingAnchorMaterials(data).length;
  const coveredKeys = new Set([
    ...Object.keys(data.processing?.mergedKeys || {}),
    ...Object.keys(data.processing?.anchoredKeys || {}),
  ]);
  const anchorInterval = Math.max(1, Number(s.anchorInterval) || 15);
  const mergeInterval = Math.max(1, Number(s.mergeInterval) || 100);
  const nextAnchorAt = coveredKeys.size + anchorInterval;
  const anchorRemaining = Math.max(0, nextAnchorAt - currentAiTurn);
  const mergedCount = new Set(latestMerge(data)?.sourceKeys || []).size;
  const nextMergeAt = mergedCount + mergeInterval;
  const mergeRemaining = Math.max(0, nextMergeAt - currentAiTurn);
  const anchorProgress = anchorRemaining > 0
    ? `下一锚点 AI回合 ${nextAnchorAt}（还差 ${anchorRemaining} 个AI回复）`
    : continuousReady >= anchorInterval
      ? `锚点已达阈值，等待后台生成`
      : `锚点已达阈值，但被首条缺失/过期摘要阻塞`;
  const mergeProgress = mergeRemaining > 0
    ? `下一合并 AI回合 ${nextMergeAt}（还差 ${mergeRemaining} 个AI回复）`
    : `全量合并已达阈值，等待后台生成`;
  const lastError = data.processing.lastError ? ` | 最近错误: ${data.processing.lastError}` : '';
  const queue = data.processing.queueRunning ? ' | 队列运行中' : data.processing.queuePending ? ' | 队列待处理' : '';
  const codex = pendingCodex ? `，待人物索引 ${pendingCodex} 楼` : '';
  const relationship = relationshipPending ? '，人物关系待重建' : '';
  return `${currentCharacterName()}：当前 AI回合 ${currentAiTurn}；${anchorProgress}；${mergeProgress}。摘要 ${readyGodlogs} 条，连续待锚定 ${continuousReady} 条，待摘要 ${pendingSummaries} 楼${codex}${relationship}${queue}${lastError}`;
}

function currentVectorCount(data = memoryData()) {
  const refs = Object.values(data.vectorRefs || {});
  if (!embeddingConfigured()) return refs.length || Object.keys(data.vectors || {}).length;
  const signature = embeddingSignature();
  return refs.filter(record => record.signature === signature).length
    || Object.values(data.vectors || {}).filter(record => record.signature === signature).length;
}

function estimateTokens(text) {
  return estimateTextTokens(text);
}

function estimateMemoryTokens(data = memoryData()) {
  const injection = state.lastPromptInjection || buildCoreInjection(data);
  return estimateTokens(injection);
}

function updatePreview() {
  const data = memoryData();
  showStatus(statusText(data));
  // The workbench contains several full lists, Markdown-table parsers and health scans. Rebuilding
  // all of them while the drawer is closed wastes the main thread after every message/job.
  if (!$('#anchor_memory_workbench').hasClass('open')) {
    scheduleGodlogPanelRender();
    try {
      maybeWarnMissingGodlogs(data);
    } catch (err) {
      console.warn('[AnchorMemory] missing Godlog warning failed', err);
    }
    return;
  }
  const merge = latestMerge(data);
  const anchor = latestAnchor(data);
  const readyGodlogs = (data.godlogs || []).filter(item => item.status === 'ready').length;
  const failedGodlogs = (data.godlogs || []).filter(item => ['failed', 'stale', 'orphaned'].includes(item.status)).length;
  $('#am_stat_anchors').text(activeAnchorsAfterMerge(data).length);
  $('#am_stat_merges').text(activeMerges(data).length);
  $('#am_stat_godlogs').text(readyGodlogs);
  $('#am_stat_pending_summaries').text(pendingGodlogRows(data).length);
  $('#am_stat_pending').text(pendingAnchorMaterials(data).length);
  $('#am_stat_godlog_issues').text(failedGodlogs);
  $('#am_stat_vectors').text(currentVectorCount(data));
  $('#am_stat_tokens').text(estimateMemoryTokens(data));
  const replacement = data.processing.lastContextReplacement;
  $('#am_context_window').text(replacement
    ? (replacement.mode === 'prompt-ready-history-hide'
      ? `最终请求：保留最近 ${replacement.rawKept || replacement.keepRecent || settings().keepRecent} 个AI回合原文；移除旧正文 ${replacement.hiddenBodies || replacement.covered || 0} 条；注入记忆 ${replacement.injectedTokens || estimateTokens(state.lastPromptInjection || '')} Token（预算 ${replacement.memoryBudgetTokens || state.lastMemoryBudget?.budgetTokens || settings().memoryMaxTokens}，${replacement.injectedChars || 0} 字符）/ ${replacement.injectedItems || 0} 个来源；缺摘要 ${replacement.missing || 0} 楼（不会回退发送完整旧正文）`
      : replacement.mode === 'prompt-ready'
        ? `生成前注入记忆 ${replacement.injectedTokens || estimateTokens(state.lastPromptInjection || '')} Token（预算 ${replacement.memoryBudgetTokens || state.lastMemoryBudget?.budgetTokens || settings().memoryMaxTokens}，${replacement.injectedChars || 0} 字符）/ ${replacement.injectedItems || 0} 个来源 / 缺摘要 ${replacement.missing || 0} 楼`
        : replacement.mode === 'history-hide'
          ? `请求裁剪：保留最近 ${replacement.rawKept || replacement.keepRecent || settings().keepRecent} 个AI回合原文；移除旧正文 ${replacement.hiddenBodies || replacement.covered || 0} 条；缺摘要 ${replacement.missing || 0} 楼`
        : replacement.mode === 'history-compress'
          ? `保留最近 ${replacement.rawKept || replacement.keepRecent || settings().keepRecent} 楼AI原文 / 已隐藏旧回合 ${replacement.replaced || 0} 个 / 旧回合缺摘要 ${replacement.missing || 0} 个`
        : `静态提示注入 / 待摘要 ${replacement.missing || 0} 楼`)
    : `保留最近 ${settings().keepRecent} 楼AI原文 / 等待下次生成时统计`);
  $('#am_current_time').text(renderMacros(data.codex.currentTime || '未明'));
  $('#am_current_place').text(renderMacros(data.codex.currentPlace || '未明'));
  const timelineWarnings = data.timeline?.warnings || [];
  $('#am_timeline_health').text(timelineWarnings.length
    ? `检测到 ${timelineWarnings.length} 条时间连续性提示：${timelineWarnings[timelineWarnings.length - 1]?.message || '请核对最近摘要。'} 当前现实时间仍保持为“${data.codex.currentTime || '未明'}”。`
    : '时间连续性正常：回忆、梦境和转述不会覆盖当前现实时间；手动修正后，后续楼层从修正基线继续推进。')
    .toggleClass('am-warning-text', timelineWarnings.length > 0);
  const autoTracked = automaticTrackedCharacterNames();
  const effectiveTracked = trackedCharacterNames(data);
  $('#am_tracked_characters').val((data.trackedCharacters || []).join('\n'));
  $('#am_tracked_characters_status').text((data.trackedCharacters || []).length
    ? `当前使用手动名单：${effectiveTracked.join('、')}`
    : `当前自动识别：${autoTracked.join('、') || '未识别到角色，请手动填写'}`);
  $('#am_character_memo_title').text(`角色成长纪要（只追踪 ${effectiveTracked.join('、') || renderMacros('{{char}}')}）`);
  const codexStatus = data.processing?.codexDirty
    ? `索引待重建：旧数据已安全保留，不会在重建成功前被覆盖。${data.processing.codexDirtyReason ? ` 原因：${data.processing.codexDirtyReason}` : ''}`
    : `索引已持久化${data.processing?.codexLastGoodAt ? `，最近更新：${new Date(data.processing.codexLastGoodAt).toLocaleString()}` : ''}`;
  $('#am_codex_status').text(codexStatus)
    .toggleClass('am-warning-text', !!data.processing?.codexDirty);
  $('#am_restore_codex_backup').prop('disabled', !data.codexBackup?.codex
    || (!codexHasContent(data.codexBackup.codex) && !relationshipHasContent(data.codexBackup.relationshipTable)));
  $('#am_current_time_edit').val(data.codex.currentTime || '');
  $('#am_current_place_edit').val(data.codex.currentPlace || '');
  $('#am_core_preview').val('正在生成六段记忆拼接预览……');
  const previewContextToken = captureChatContextToken(data);
  buildPromptReadyInjection(getContext().chat || []).then(content => {
    if (isSameChatContext(previewContextToken) && $('#anchor_memory_workbench').hasClass('open')) {
      $('#am_core_preview').val(content || '暂无可注入记忆。');
      $('#am_stat_tokens').text(estimateMemoryTokens(data));
    }
  }).catch(err => {
    if (isSameChatContext(previewContextToken)) $('#am_core_preview').val(`拼接预览失败：${err.message || err}`);
  });
  const selectedRecall = state.selectedRecallMessageKey ? data.messageRecalls?.[state.selectedRecallMessageKey] : null;
  if (selectedRecall) {
    $('#am_recall_preview_title').text('历史楼层生成前注入记录（不是当前动态召回）');
    $('#am_recall_preview_note').show();
    $('#am_clear_recall_selection').show();
    $('#am_recall_preview').val(formatMessageRecallDetail(selectedRecall, data));
  } else {
    $('#am_recall_preview_title').text(settings().useDynamicRecall
      ? '第六段：未锚定摘要 + 可选旧楼召回（当前）'
      : '第六段：未锚定摘要（动态召回已关闭）');
    $('#am_recall_preview_note').hide();
    $('#am_clear_recall_selection').hide();
    $('#am_recall_preview').val([state.lastRecentFacts, state.lastRecall].filter(Boolean).join('\n\n')
      || (settings().useDynamicRecall ? '当前没有可补充内容。' : '当前没有未锚定摘要；额外旧楼动态召回已关闭。'));
  }
  $('#am_character_memo_edit').val(data.codex.characterMemo || '');
  $('#am_people_edit').val(data.codex.peopleIndex || '');
  $('#am_items_edit').val(data.codex.itemIndex || '');
  $('#am_scenes_edit').val(data.codex.sceneIndex || '');
  $('#am_timeline_detail').val(anchor?.body || merge?.body || '暂无锚点。');
  renderGodlogList();
  renderTimelineList();
  renderTableCards('#am_character_cards', data.codex.characterMemo, '暂无角色成长纪要。', ['角色名']);
  renderTableCards('#am_people_cards', data.codex.peopleIndex, '暂无出场人物库。', ['角色名']);
  renderTableCards('#am_item_cards', data.codex.itemIndex, '暂无重要道具、内部梗与核心细节。', ['物品/细节/内部梗', '物品']);
  renderTableCards('#am_scene_cards', data.codex.sceneIndex, '暂无场景记录。', ['场景/地点', '场景']);
  renderRelationshipEditor(data);
  $('[data-am-macro-template]').each(function () {
    const template = String($(this).attr('data-am-macro-template') || '');
    if (template) $(this).text(renderMacros(template));
  });
  renderArchiveCards();
  renderHealth();
  renderRecallHits();
  renderGodlogPanels();
  try {
    maybeWarnMissingGodlogs(data);
  } catch (err) {
    console.warn('[AnchorMemory] missing Godlog warning failed', err);
  }
}

function safeUpdatePreview(reason = '刷新面板') {
  try {
    updatePreview();
    return true;
  } catch (err) {
    console.error(`[AnchorMemory] ${reason} failed`, err);
    showStatus(`Anchor Memory 面板刷新失败：${err.message || err}`);
    toastr?.error?.(`面板刷新失败：${err.message || err}`, 'Anchor Memory');
    return false;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseMarkdownTable(markdown) {
  const lines = String(markdown || '').split('\n').map(line => line.trim()).filter(Boolean);
  const tableLines = lines.filter(line => line.startsWith('|') && line.endsWith('|'));
  if (tableLines.length < 3) return [];
  const headers = tableLines[0].split('|').slice(1, -1).map(cell => cell.trim());
  return tableLines.slice(2).map(line => {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.every(cell => !cell)) return null;
    const row = {};
    headers.forEach((header, index) => { row[header] = cells[index] || ''; });
    return row;
  }).filter(Boolean);
}

function renderTableCards(containerSelector, markdown, emptyText, titleKeys = []) {
  const container = $(containerSelector);
  if (!container.length) return;
  const rows = parseMarkdownTable(markdown);
  container.empty();
  if (rows.length === 0) {
    container.append(`<div class="am-card"><div class="am-card-body">${escapeHtml(emptyText)}</div></div>`);
    return;
  }
  for (const row of rows) {
    const entries = Object.entries(row);
    const titleEntry = entries.find(([key]) => titleKeys.includes(key)) || entries[0];
    const title = renderMacros(titleEntry?.[1] || titleEntry?.[0] || '未命名');
    const body = entries
      .filter(([key]) => key !== titleEntry?.[0])
      .map(([key, value]) => `<div><span class="am-pill">${escapeHtml(renderMacros(key))}</span> ${escapeHtml(renderMacros(value || '未记录'))}</div>`)
      .join('');
    container.append(`
      <div class="am-card">
        <div class="am-card-title"><span>${escapeHtml(title)}</span></div>
        <div class="am-card-body">${body}</div>
      </div>
    `);
  }
}

function godlogStatusLabel(status, item = null) {
  if (status === 'archived') return '归档';
  if (status === 'ready') {
    if (item?.key && state.activeSummaryRowKey === item.key) return '重跑中';
    return item?.sourceMismatch || item?.rerunError ? '已保存' : '已完成';
  }
  if (status === 'missing') return '待自动补写';
  if (status === 'failed') return '待补写';
  if (status === 'stale') return '待刷新';
  if (status === 'orphaned') return '孤儿';
  if (status === 'pending') {
    return item?.key && state.activeSummaryRowKey === item.key ? '生成中' : '排队中';
  }
  return '待处理';
}

function renderGodlogList() {
  const data = memoryData();
  const query = ($('#am_godlog_search').val() || '').trim().toLowerCase();
  const container = $('#am_godlog_list');
  if (!container.length) return;
  const entries = godlogListEntries(data)
    .sort((a, b) => (a.item.floor ?? 0) - (b.item.floor ?? 0))
    .filter(({ item }) => {
      const haystack = `${item.floor} ${item.name} ${item.status} ${item.body} ${item.error}`.toLowerCase();
      return !query || haystack.includes(query);
    });

  container.empty();
  if (entries.length === 0) {
    state.godlogPage = 0;
    container.append('<div class="am-card"><div class="am-card-body">暂无逐楼摘要。配置副API后，聊天落地会自动补写。</div></div>');
    return;
  }

  const pageSize = Math.max(20, Number(state.godlogPageSize) || 80);
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  state.godlogPage = Math.min(Math.max(0, Number(state.godlogPage) || 0), pageCount - 1);
  const pageEntries = entries.slice(state.godlogPage * pageSize, (state.godlogPage + 1) * pageSize);
  container.append(`
    <div class="am-card am-godlog-pager">
      <div class="am-card-actions">
        <button class="am-godlog-prev" type="button" ${state.godlogPage <= 0 ? 'disabled' : ''}>上一页</button>
        <span>第 ${state.godlogPage + 1}/${pageCount} 页 · 共 ${entries.length} 条 · 每页 ${pageSize} 条</span>
        <button class="am-godlog-next" type="button" ${state.godlogPage >= pageCount - 1 ? 'disabled' : ''}>下一页</button>
      </div>
    </div>
  `);

  for (const { item, synthetic } of pageEntries) {
    const displayText = item.body ? plainGodlogText(item.body) : (item.error || '等待生成。');
    const excerpt = displayText.slice(0, 260);
    const status = item.archived ? 'archived' : (item.status === 'failed' ? 'failed' : (item.stale ? 'stale' : (item.status || 'pending')));
    const actions = item.archived
      ? ''
      : `<div class="am-card-actions"><button class="am-rerun-godlog" data-godlog-id="${escapeHtml(item.id)}">重跑本楼摘要</button></div>`;
    container.append(`
      <div class="am-card am-godlog-card am-status-${escapeHtml(status)}${synthetic ? ' am-godlog-missing' : ''}" data-godlog-id="${escapeHtml(item.id)}">
        <div class="am-card-title">
          <span>第 ${escapeHtml((item.floor ?? 0) + 1)} 楼 · ${escapeHtml(item.name || '未知')}</span>
          <span class="am-pill">${escapeHtml(godlogStatusLabel(status, item))}</span>
        </div>
        <div class="am-card-meta">Nub ${escapeHtml(item.number || '')} · ${item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '未生成'}</div>
        <div class="am-card-body">${escapeHtml(excerpt)}${displayText.length > excerpt.length ? '...' : ''}</div>
        ${actions}
      </div>
    `);
  }
}

function godlogFieldValue(body, tag) {
  const block = normalizeGodlogBlock(body);
  const match = block.match(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'i'));
  if (!match) return '';
  return match[0].replace(new RegExp(`^<${tag}>|<\\/${tag}>$`, 'gi'), '').trim();
}

function messageGodlogSummary(item, row) {
  if (!item) return missingGodlogUiStatus(row) === 'pending' ? '正在生成逐楼摘要' : '待自动补写逐楼摘要';
  if (item.status === 'failed') return item.error || '摘要生成失败，等待补写';
  if (item.status === 'stale') return item.error || '楼层内容已更新，等待自动刷新摘要';
  if (item.status === 'pending' && item.body) return item.error || '正在刷新摘要，旧摘要暂时保留';
  if (item.status === 'ready') {
    return godlogFieldValue(item.body, 'Title')
      || godlogFieldValue(item.body, 'Cond').slice(0, 80)
      || `第 ${row.index + 1} 楼摘要已完成`;
  }
  return item.error || '摘要正在等待生成';
}

function messageGodlogBody(item, row) {
  if (!item) return missingGodlogUiText(row);
  if (item.body) {
    const notices = [];
    if (item.status === 'stale' || item.stale) {
      notices.push('【旧摘要暂存；当前楼稳定后将自动更新】');
    } else {
      if (item.rerunPending || (item.key && state.activeSummaryRowKey === item.key)) {
        notices.push('【正在手动重跑；旧摘要继续生效，只有新摘要成功后才会替换。】');
      }
      if (item.rerunError) {
        notices.push(`【上次手动重跑失败：${item.rerunError}；旧摘要仍然保留。】`);
      }
      if (item.sourceMismatch) {
        notices.push('【摘要已保存并锁定；该楼后来发生了注入、渲染或正文变化，插件不会自动重跑。如需按当前正文更新，请手动点“重跑本楼摘要”。】');
      }
    }
    const prefix = notices.length > 0 ? `${notices.join('\n')}\n` : '';
    return `${prefix}${plainGodlogText(item.body)}`;
  }
  if (item.status === 'pending') return item.error || '正文已完成，逐楼摘要正在后台生成或排队。';
  return item.error || '等待生成。';
}

function sanitizeLeakedGodlogDom(messageEl) {
  const mesText = messageEl?.querySelector?.('.mes_text');
  if (!mesText) return false;
  let changed = false;

  mesText.querySelectorAll('godlog').forEach(element => {
    element.remove();
    changed = true;
  });

  mesText.querySelectorAll('pre, code, details, .code-block, .mes_code, .markdown-code-block').forEach(element => {
    const text = element.textContent || '';
    const attrText = Array.from(element.attributes || []).map(attr => attr.value).join('\n');
    if (!looksLikeGodlogLeakText(`${text}\n${attrText}`)) return;
    const removable = element.closest('details, pre, .code-block, .mes_code, .markdown-code-block') || element;
    removable.remove();
    changed = true;
  });

  const walker = document.createTreeWalker(mesText, NodeFilter.SHOW_TEXT, null, false);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  for (const textNode of nodes) {
    const next = stripGodlogBlocks(textNode.textContent || '');
    if (next === textNode.textContent) continue;
    textNode.textContent = next;
    changed = true;
  }
  if (changed) mesText.normalize();
  return changed;
}

function memoryRefLabel(ref, data = memoryData()) {
  const kind = ref?.kind === 'merge' ? '全量合并'
    : ref?.kind === 'anchor' ? `${Math.max(1, Number(settings().anchorInterval) || 15)}回合锚点`
      : ref?.kind === 'godlog' ? '前情片段'
        : '记忆';
  const source = ref?.id
    ? [...(data.godlogs || []), ...(data.anchors || []), ...(data.merges || [])].find(item => item.id === ref.id)
    : null;
  const title = ref?.title || (ref?.kind === 'godlog' ? godlogFieldValue(source?.body || '', 'Title') : '') || '';
  const number = ref?.kind === 'godlog'
    ? (source?.floor !== undefined ? `第 ${source.floor + 1} 楼` : (ref.number ? `第 ${ref.number} 条` : ''))
    : (source?.number || ref?.number ? `第 ${source?.number || ref.number} 次` : '');
  return [kind, number, title].filter(Boolean).join(' · ');
}

function memoryRefBody(ref, data = memoryData()) {
  const source = ref?.id
    ? [...(data.godlogs || []), ...(data.anchors || []), ...(data.merges || [])].find(item => item.id === ref.id)
    : null;
  if (!source) return '';
  return safePromptMemoryText(ref.kind, source, ref.kind === 'merge' ? 3000 : 1800);
}

function formatMessageRecallDetail(record, data = memoryData()) {
  if (!record) return '这楼还没有生成前注入记录。';
  const lines = [
    '【历史记录提示】这是该楼当时生成前实际收到的记忆快照，不会因后来新建锚点而回溯改写，也不代表下一次生成仍会注入同样内容。',
    '',
    `第 ${Number(record.floor ?? 0) + 1} 楼生成前注入记录`,
    `注入字符：${record.injectedChars || 0}`,
    `记录时间：${record.at ? new Date(record.at).toLocaleString() : '未记录'}`,
    '',
  ];
  if (record.recallQuery) {
    lines.push(
      `召回来源：${record.recallQuery.source || '最近上下文'}`,
      `召回方式：${record.recallQuery.mode || 'keyword'} / 最低 ${record.recallQuery.minCount || record.recallQuery.topK || 3} 条 / 实际 ${record.recallQuery.selectedCount || 0} 条`,
      '',
    );
  }
  const refs = Array.isArray(record.refs) ? record.refs : [];
  if (refs.length === 0) {
    lines.push('本次只有基础记忆或剧情定位，没有可列出的具体锚点或前情条目。');
  } else {
    for (const ref of refs) lines.push(`- ${memoryRefLabel(ref, data)}`);
  }
  if (record.contentPreview) {
    lines.push('', '--- 当时注入内容预览（已去重压缩） ---', record.contentPreview);
  }
  if (refs.length > 0) {
    lines.push('', '--- 当前可用的命中内容展开 ---');
    for (const ref of refs) {
      lines.push(`\n【${memoryRefLabel(ref, data)}】`);
      lines.push(memoryRefBody(ref, data) || '该来源已被合并、回滚或删除，当前没有可展开正文。');
    }
  }
  lines.push('', `内容签名：${record.contentHash || '旧记录未保存签名'}`);
  return lines.join('\n');
}

function messageRenderContext() {
  const rows = chatRows(false).filter(row => row.role === 'assistant');
  return {
    data: memoryData(),
    rows,
    rowsByIndex: new Map(rows.map(row => [row.index, row])),
  };
}

function visibleAssistantMessageIndices(rows = chatRows(false).filter(row => row.role === 'assistant')) {
  const selected = new Set(rows.slice(-MESSAGE_RENDER_RECENT_COUNT).map(row => row.index));
  const chatElement = document.querySelector('#chat');
  if (!chatElement) return selected;
  const chatRect = chatElement.getBoundingClientRect?.();
  const viewportTop = (chatRect?.top ?? 0) - MESSAGE_RENDER_MARGIN_PX;
  const viewportBottom = (chatRect?.bottom
    ?? (globalThis.innerHeight || document.documentElement?.clientHeight || 900)) + MESSAGE_RENDER_MARGIN_PX;
  for (const element of chatElement.querySelectorAll('.mes[mesid]')) {
    const index = Number(element.getAttribute('mesid'));
    if (!Number.isInteger(index)) continue;
    const rect = element.getBoundingClientRect?.();
    if (!rect || rect.bottom < viewportTop || rect.top > viewportBottom) continue;
    selected.add(index);
  }
  return selected;
}

function messageBadgeSignature(record, refs) {
  return stableHash(JSON.stringify({
    contentHash: record?.contentHash || '',
    injectedChars: record?.injectedChars || 0,
    refs: (refs || []).map(ref => [ref.kind || '', ref.id || '', ref.key || '', ref.number || 0]),
  }));
}

function renderInjectionBadgeForIndex(messageIndex, prepared = null) {
  const index = Number(messageIndex);
  if (!Number.isInteger(index)) return false;
  const messageEl = document.querySelector(`#chat .mes[mesid="${index}"]`);
  if (!messageEl) return false;

  const context = prepared || messageRenderContext();
  const row = context.rowsByIndex?.get(index) || context.rows?.find(item => item.index === index);
  const existing = messageEl.querySelector('.am-message-memory-badge');
  if (!row || row.role !== 'assistant') {
    existing?.remove();
    return false;
  }
  const data = context.data || memoryData();
  const record = messageRecallRecord(data, row);
  const refs = Array.isArray(record?.refs) ? record.refs : [];
  if (!record || (refs.length === 0 && !record.injectedChars)) {
    existing?.remove();
    return false;
  }

  const signature = messageBadgeSignature(record, refs);
  if (existing?.dataset?.renderSignature === signature
      && existing.dataset.messageKey === row.key) return true;

  existing?.remove();
  const title = formatMessageRecallDetail(record, data);
  const anchor = messageEl.querySelector('.mes_block .ch_name') || messageEl.querySelector('.ch_name') || messageEl;
  anchor.insertAdjacentHTML('afterend', `
    <button class="am-message-memory-badge" type="button" data-message-key="${escapeHtml(row.key)}" data-render-signature="${escapeHtml(signature)}" title="${escapeHtml(title)}">
      a${escapeHtml(refs.length || '')}
    </button>
  `);
  return true;
}

function renderInjectionBadges(indices = null, prepared = null) {
  const context = prepared || messageRenderContext();
  const targets = indices || visibleAssistantMessageIndices(context.rows);
  for (const index of targets) renderInjectionBadgeForIndex(index, context);
}

function panelRenderSignature(row, item, status, summary, body) {
  return stableHash(JSON.stringify({
    key: row?.key || '',
    rawHash: row?.rawHash || '',
    id: item?.id || '',
    status,
    stale: !!item?.stale,
    sourceMismatch: !!item?.sourceMismatch,
    currentRawHash: item?.currentRawHash || '',
    rerunPending: !!item?.rerunPending,
    rerunError: item?.rerunError || '',
    number: item?.number || 0,
    updatedAt: item?.updatedAt || 0,
    summary,
    bodyHash: stableHash(body || ''),
  }));
}

function renderGodlogPanelForIndex(messageIndex, prepared = null) {
  const index = Number(messageIndex);
  if (!Number.isInteger(index)) return false;
  const chat = getContext().chat || [];
  const message = chat[index];
  if (!message || message.is_user || message.is_system) return false;
  if (stripGodlogFromMessageRecord(message)) {
    invalidateRuntimeCaches('removed leaked Godlog block');
    refreshMessageBlock(index);
    saveChatNow();
    scheduleGodlogPanelRender(index, 1);
    return true;
  }

  const messageEl = document.querySelector(`#chat .mes[mesid="${index}"]`);
  if (!messageEl) return false;
  sanitizeLeakedGodlogDom(messageEl);

  const context = prepared || messageRenderContext();
  const row = context.rowsByIndex?.get(index) || context.rows?.find(item => item.index === index);
  if (!row) return false;

  const data = context.data || memoryData();
  const item = godlogForRow(data, row);
  const status = item?.archived ? 'archived' : (item?.status === 'failed' ? 'failed' : (item?.stale ? 'stale' : (item?.status || 'missing')));
  const id = item?.id || syntheticGodlogId(row);
  const summary = messageGodlogSummary(item, row);
  const body = messageGodlogBody(item, row);
  const signature = panelRenderSignature(row, item, status, summary, body);
  const existingPanel = messageEl.querySelector('.am-message-godlog-panel');
  if (existingPanel?.dataset?.renderSignature === signature) {
    renderInjectionBadgeForIndex(index, context);
    return true;
  }

  const wasOpen = !!existingPanel?.classList.contains('open');
  existingPanel?.remove();
  const updatedAt = item?.updatedAt ? new Date(item.updatedAt).toLocaleString() : '未生成';
  const mesText = messageEl.querySelector('.mes_text') || messageEl;
  if (rememberMessageGodlogCard(data, row, item, status)) saveMemory();

  mesText.insertAdjacentHTML('afterend', `
    <div class="am-message-godlog-panel am-status-${escapeHtml(status)}${wasOpen ? ' open' : ''}" data-godlog-id="${escapeHtml(id)}" data-message-index="${escapeHtml(index)}" data-render-signature="${escapeHtml(signature)}">
      <button class="am-message-godlog-toggle" type="button" title="展开逐楼摘要">
        <span class="am-message-godlog-mark">a</span>
        <span class="am-message-godlog-floor">第 ${escapeHtml(index + 1)} 楼</span>
        <span class="am-message-godlog-status">${escapeHtml(godlogStatusLabel(status, item))}</span>
        <span class="am-message-godlog-summary">${escapeHtml(summary)}</span>
      </button>
      <div class="am-message-godlog-body"${wasOpen ? '' : ' hidden'}>
        <div class="am-message-godlog-meta">Nub ${escapeHtml(item?.number || godlogNumberForRow(row) || '')} · ${escapeHtml(updatedAt)}</div>
        <div class="am-message-godlog-text">${escapeHtml(body)}</div>
        <div class="am-message-godlog-actions">
          <button class="am-message-godlog-open" type="button">打开摘要页</button>
          <button class="am-message-godlog-rerun" type="button">重跑本楼摘要</button>
        </div>
      </div>
    </div>
  `);
  renderInjectionBadgeForIndex(index, context);
  return true;
}

function removeOffscreenMessageDecorations(targets) {
  const keep = targets instanceof Set ? targets : new Set(targets || []);
  const chatElement = document.querySelector('#chat');
  if (!chatElement) return;
  for (const panel of chatElement.querySelectorAll('.am-message-godlog-panel[data-message-index]')) {
    const index = Number(panel.getAttribute('data-message-index'));
    if (!keep.has(index)) panel.remove();
  }
  for (const badge of chatElement.querySelectorAll('.am-message-memory-badge')) {
    const host = badge.closest('.mes[mesid]');
    const index = Number(host?.getAttribute('mesid'));
    if (!keep.has(index)) badge.remove();
  }
}

function renderGodlogPanels() {
  const context = messageRenderContext();
  const targets = visibleAssistantMessageIndices(context.rows);
  removeOffscreenMessageDecorations(targets);
  let rendered = 0;
  let expected = 0;
  for (const index of targets) {
    if (!context.rowsByIndex.has(index)) continue;
    expected++;
    if (renderGodlogPanelForIndex(index, context)) rendered++;
  }
  return { expected, rendered };
}

function scheduleGodlogPanelRender(messageId = '', attempt = 0) {
  const index = typeof eventMessageIndex === 'function' ? eventMessageIndex(messageId) : Number(messageId);
  if (Number.isInteger(index)) state.panelRenderTargets.add(index);
  else state.panelRenderAll = true;
  state.panelRenderAttempt = Math.max(state.panelRenderAttempt, Number(attempt) || 0);
  if (state.panelRenderTimer) return;

  const delay = state.panelRenderAttempt > 0 ? 300 : PANEL_RENDER_DEBOUNCE_MS;
  state.panelRenderTimer = setTimeout(() => {
    state.panelRenderTimer = null;
    const renderAll = state.panelRenderAll;
    const targets = [...state.panelRenderTargets];
    const currentAttempt = state.panelRenderAttempt;
    state.panelRenderAll = false;
    state.panelRenderTargets.clear();
    state.panelRenderAttempt = 0;

    let expected = 0;
    let rendered = 0;
    if (renderAll || targets.length !== 1) {
      ({ expected, rendered } = renderGodlogPanels());
    } else {
      const targetIndex = targets[0];
      const chat = getContext().chat || [];
      const message = chat[targetIndex];
      expected = message && !message.is_user && !message.is_system ? 1 : 0;
      const context = messageRenderContext();
      rendered = renderGodlogPanelForIndex(targetIndex, context) ? 1 : 0;
    }
    if (expected > rendered && currentAttempt < 8) {
      scheduleGodlogPanelRender(renderAll ? '' : targets[0] ?? '', currentAttempt + 1);
    }
  }, delay);
}

function bindLazyMessageRendering() {
  if (state.lazyRenderBound) return;
  const chat = document.querySelector('#chat');
  if (!chat) {
    setTimeout(bindLazyMessageRendering, 500);
    return;
  }
  state.lazyRenderBound = true;
  chat.addEventListener('scroll', () => {
    if (state.visibleRenderTimer) cancelAnimationFrame(state.visibleRenderTimer);
    state.visibleRenderTimer = requestAnimationFrame(() => {
      state.visibleRenderTimer = null;
      scheduleGodlogPanelRender();
    });
  }, { passive: true });
}

function showGodlogInWorkbench(id) {
  const syntheticRow = rowFromSyntheticGodlogId(id);
  const data = memoryData();
  const item = (data.godlogs || []).find(entry => entry.id === id);
  state.selectedGodlogId = id;
  openWorkbench();
  activateTab('summaries');
  renderGodlogList();
  $('#am_godlog_detail').val(item?.body || item?.error || (syntheticRow ? messageGodlogBody(null, syntheticRow) : ''));
}

async function rerunGodlogFromPanel(id) {
  const syntheticRow = rowFromSyntheticGodlogId(id);
  const data = memoryData();
  const item = (data.godlogs || []).find(entry => entry.id === id);
  const row = syntheticRow || currentRowForGodlog(item);
  if (!row) {
    toastr?.warning?.('找不到对应楼层，可能已删除或切换了 swipe', 'Anchor Memory');
    return;
  }
  state.selectedGodlogId = id;
  const ok = await generateGodlogForRow(row, true);
  const current = godlogForRow(memoryData(), row);
  updatePreview();
  renderGodlogPanelForIndex(row.index);
  if (ok) toastr?.success?.(`第 ${row.index + 1} 楼摘要已重新生成`, 'Anchor Memory');
  else if (isGenerationActive() && isLatestAssistantRow(row)) toastr?.warning?.('当前楼仍在由主模型生成，已排队到生成结束后重跑。', 'Anchor Memory');
  else toastr?.error?.(`本楼摘要未完成：${current?.rerunError || current?.error || '请检查副API配置或控制台错误'}`, 'Anchor Memory');
}

function renderMemoryCards(container, items, emptyText) {
  if (!container.length) return;
  container.empty();
  if (items.length === 0) {
    container.append(`<div class="am-card"><div class="am-card-body">${escapeHtml(emptyText)}</div></div>`);
    return;
  }
  const assistantRowsByKey = new Map(chatRows(true)
    .filter(row => row.role === 'assistant')
    .map(row => [row.key, row]));
  for (const { type, item } of items) {
    const fullBody = cleanText(item.body);
    const previewLimit = 600;
    const excerpt = fullBody.slice(0, previewLimit);
    const previewOnly = fullBody.length > excerpt.length;
    const sourceRows = (item.sourceKeys || []).map(key => assistantRowsByKey.get(key)).filter(Boolean);
    const firstAi = sourceRows[0]?.assistantNumber;
    const lastAi = sourceRows[sourceRows.length - 1]?.assistantNumber;
    const messageRange = item.sourceFloors?.length
      ? `聊天楼层 ${Number(item.sourceFloors[0]) + 1}-${Number(item.sourceFloors[item.sourceFloors.length - 1]) + 1}`
      : (item.floorAt !== undefined ? `到聊天楼层 ${Number(item.floorAt) + 1}` : '');
    const aiRange = firstAi && lastAi
      ? `AI回合 ${firstAi}-${lastAi}`
      : (item.coverageCount ? `累计 ${item.coverageCount} 个AI回合` : '');
    const range = [aiRange, messageRange].filter(Boolean).join(' · ');
    container.append(`
      <div class="am-card am-memory-card" data-memory-id="${escapeHtml(item.id)}">
        <div class="am-card-title">
          <span>${escapeHtml(type)} · 第 ${escapeHtml(item.number)} 次</span>
          <span class="am-pill">${escapeHtml(item.stale ? '可能过期' : range)}</span>
        </div>
        <div class="am-card-meta">${new Date(item.createdAt).toLocaleString()}${previewOnly ? ' · 卡片仅预览，点击后在下方查看全文' : ''}</div>
        <div class="am-card-body">${escapeHtml(excerpt)}${previewOnly ? '\n\n【预览到此；存储正文未截断】' : ''}</div>
      </div>
    `);
  }
}

function renderTimelineList() {
  const data = memoryData();
  const query = ($('#am_timeline_search').val() || '').trim().toLowerCase();
  const matches = item => !query || String(item.body || '').toLowerCase().includes(query);
  const newAnchors = activeAnchorsAfterMerge(data)
    .filter(matches)
    .map(item => ({ type: '新锚点', item }))
    .sort((a, b) => b.item.createdAt - a.item.createdAt);
  const oldAnchors = data.merges
    .filter(matches)
    .map(item => ({ type: '旧锚点', item }))
    .sort((a, b) => b.item.createdAt - a.item.createdAt);

  renderMemoryCards($('#am_new_anchor_list'), newAnchors, '暂无新锚点。攒满有效摘要后会自动生成。');
  renderMemoryCards($('#am_old_anchor_list'), oldAnchors, '暂无旧锚点。攒满合并间隔后会自动生成。');
  $('#am_timeline_list').empty();
}

function renderArchiveCards() {
  const s = settings();
  const charName = currentCharacterName();
  const archives = s.slots?.[charName] || {};
  const container = $('#am_archive_cards');
  if (!container.length) return;
  container.empty();
  const names = Object.keys(archives).sort();
  if (names.length === 0) {
    container.append('<div class="am-card"><div class="am-card-body">当前角色暂无记忆档案。保存一次后，新开场白就能加载这份记忆。</div></div>');
    return;
  }
  for (const name of names) {
    const archive = archives[name];
    const d = archive.data || {};
    container.append(`
      <div class="am-card">
        <div class="am-card-title"><span>${escapeHtml(name)}</span><span class="am-pill">${escapeHtml(charName)}</span></div>
        <div class="am-card-meta">更新于 ${new Date(archive.updatedAt || Date.now()).toLocaleString()}</div>
        <div class="am-card-body">摘要 ${d.godlogs?.length || 0} 条，锚点 ${d.anchors?.length || 0} 个，全量合并 ${d.merges?.length || 0} 个，向量 ${Object.keys(d.vectorRefs || d.vectors || {}).length} 条。</div>
        <div class="am-card-actions">
          <button class="am-load-archive" data-archive="${escapeHtml(name)}">加载到当前聊天</button>
          <button class="am-delete-archive" data-archive="${escapeHtml(name)}">删除</button>
        </div>
      </div>
    `);
  }
}

function renderHealth() {
  const s = settings();
  const data = memoryData();
  const issues = [];
  if (!s.useSecondary || !s.secondaryUrl || !s.secondaryKey) issues.push('未完整配置副API：逐楼摘要、锚点和合并不会自动完成；本版本不会把后台记忆整理提示词发送给主模型。');
  if (s.useEmbedding && !embeddingConfigured()) issues.push('已启用Embedding，但向量API地址/密钥不完整。');
  if (s.useEmbedding && state.vectorStorageUnavailable) issues.push('当前浏览器无法使用 IndexedDB：语义向量已自动停用，插件只使用关键词召回；不会把向量浮点数组写入聊天元数据。');
  if ((data.timeline?.warnings || []).length > 0) issues.push(`剧情时间连续性有 ${(data.timeline.warnings || []).length} 条待核对提示；回忆/梦境不会覆盖当前现实时间。最近一条：${data.timeline.warnings.at(-1)?.message || '请检查场景页'}`);
  if (s.useEmbedding) {
    const expected = data.godlogs.filter(item => item.status === 'ready').length + data.anchors.length + data.merges.length;
    const signature = embeddingConfigured() ? embeddingSignature() : '';
    const actual = Object.values(data.vectorRefs || {}).filter(record => record.signature === signature).length;
    if (actual < expected) issues.push(`当前模型的向量索引不完整：${actual}/${expected}，建议点“重建向量”。`);
  }
  const liveKeys = new Set(chatRows(true).map(row => row.key));
  const orphanKeys = Object.keys(data.processing.anchoredKeys || {}).filter(key => !liveKeys.has(key));
  if (orphanKeys.length > 0) issues.push(`检测到 ${orphanKeys.length} 条锚定标记对应的原楼层已不存在；这通常来自删楼，可导出备份后重置当前记忆或手动整理。`);
  const failedGodlogs = (data.godlogs || []).filter(item => item.status === 'failed');
  const staleGodlogs = (data.godlogs || []).filter(item => item.status === 'stale');
  const staleAnchors = (data.anchors || []).filter(item => item.stale);
  const missingDiagnostics = missingGodlogDiagnostics(data);
  const missingFloors = missingDiagnostics.slice(0, 5).map(({ row }) => `第${row.index + 1}楼`).join('、');
  if (failedGodlogs.length > 0) issues.push(`有 ${failedGodlogs.length} 条逐楼摘要待自动补写，可到“逐楼摘要”页点“自动补写缺失摘要”或重跑单楼。`);
  if (staleGodlogs.length > 0) issues.push(`有 ${staleGodlogs.length} 条逐楼摘要已过期，通常来自编辑、swipe 或 regenerate。`);
  if (staleAnchors.length > 0) issues.push(`检测到 ${staleAnchors.length} 个旧版过期锚点；重新载入聊天后会自动清理。`);
  if (pendingGodlogRows(data).length > 0) issues.push(`还有 ${pendingGodlogRows(data).length} 楼缺少有效逐楼摘要；配置副API后可自动补写。`);
  if (missingDiagnostics.length > 0) issues.push(`${missingFloors}${missingDiagnostics.length > 5 ? `等 ${missingDiagnostics.length} 楼` : ''}已经落后仍无有效摘要；插件会弹窗提示，并可在“逐楼摘要”页自动补写。`);
  if (pendingAnchorMaterials(data).length >= Number(s.anchorInterval)) issues.push('有效摘要已达到锚点间隔，可以生成锚点。');
  const tokenEstimate = estimateMemoryTokens(data);
  const configuredBudget = Math.max(1200, Number(s.memoryMaxTokens) || 8000);
  if (tokenEstimate > configuredBudget) issues.push(`记忆注入估算约 ${tokenEstimate} Token，超过配置上限 ${configuredBudget}；发送前会自动按优先级裁剪。`);
  if (data.anchors.length === 0) issues.push('暂无锚点。聊满间隔后会自动生成，也可以手动点“生成锚点”。');
  if (data.processing?.codexDirty) {
    issues.push(`人物/物品/场景索引需要重建，但最后一次有效数据仍被保留，重建成功前不会覆盖。${data.processing.codexDirtyReason ? `原因：${data.processing.codexDirtyReason}` : ''}`);
  }
  if (data.processing?.relationshipDirty) {
    issues.push(`固定人物关系表需要按当前有效楼层重建。${data.processing.relationshipDirtyReason ? `原因：${data.processing.relationshipDirtyReason}` : ''}`);
  }
  if (!codexHasContent(data.codex)) issues.push('暂无人物/物品/场景索引。若逐楼摘要仍在，可配置副API后安全重建；重建失败不会再清空已有数据。');
  if (data.codexBackup?.codex && (codexHasContent(data.codexBackup.codex) || relationshipHasContent(data.codexBackup.relationshipTable))) issues.push('检测到一份人物关系/人物/物品/场景索引安全备份，可在“人物动态”页手动恢复。');

  const container = $('#am_health_list');
  if (!container.length) return;
  container.empty();
  if (issues.length === 0) {
    container.append('<div class="am-card"><div class="am-card-title">状态良好</div><div class="am-card-body">当前没有明显配置或记忆断层。</div></div>');
    return;
  }
  for (const issue of issues) {
    container.append(`<div class="am-card"><div class="am-card-body">${escapeHtml(issue)}</div></div>`);
  }
}

function repairHealth() {
  const data = memoryData();
  syncGodlogsWithChat('记忆体检同步');
  const liveKeys = new Set(chatRows(true).map(row => row.key));
  let removedAnchoredKeys = 0;
  for (const key of Object.keys(data.processing.anchoredKeys || {})) {
    if (!liveKeys.has(key)) {
      delete data.processing.anchoredKeys[key];
      removedAnchoredKeys++;
    }
  }
  const removedVectors = pruneVectorIndex(data);
  saveMemory();
  updatePreview();
  return { removedAnchoredKeys, removedVectors };
}

function renderRecallHits() {
  const data = memoryData();
  const container = $('#am_recall_hits');
  if (!container.length) return;
  container.empty();
  if (state.lastRecallQuery && !state.selectedRecallMessageKey) {
    container.append(`
        <div class="am-card">
          <div class="am-card-title"><span>召回查询来源</span><span class="am-pill">${escapeHtml(state.lastRecallQuery.mode || 'keyword')}</span></div>
        <div class="am-card-meta">最低 ${escapeHtml(state.lastRecallQuery.minCount || 3)} 条 · 实际 ${escapeHtml(state.lastRecallQuery.selectedCount || 0)} 条 · 候选 ${escapeHtml(state.lastRecallQuery.candidateCount || 0)} 条 · ${escapeHtml(state.lastRecallQuery.source || '最近上下文')}</div>
        <div class="am-card-body">${escapeHtml(state.lastRecallQuery.preview || '暂无查询内容。')}</div>
      </div>
    `);
  }
  const selectedRecord = state.selectedRecallMessageKey ? data.messageRecalls?.[state.selectedRecallMessageKey] : null;
  if (selectedRecord) {
    const refs = Array.isArray(selectedRecord.refs) ? selectedRecord.refs : [];
    if (refs.length === 0) {
      container.append('<div class="am-card"><div class="am-card-body">这楼有生成前注入记录，但没有可列出的具体锚点或前情片段。</div></div>');
      return;
    }
    for (const ref of refs) {
      const label = ref.kind === 'merge' ? '全量合并' : ref.kind === 'godlog' ? '前情片段' : `${Math.max(1, Number(settings().anchorInterval) || 15)}回合锚点`;
      const meta = ref.method
        ? `${ref.method}${ref.score ? ` · ${Number(ref.score).toFixed(3)}` : ''}${ref.recallReason ? ` · ${ref.recallReason}` : ''}`
        : '静态注入';
      const body = memoryRefBody(ref, data);
      container.append(`
        <div class="am-card">
          <div class="am-card-title"><span>${escapeHtml(label)}</span><span class="am-pill">${escapeHtml(meta)}</span></div>
          <div class="am-card-meta">${escapeHtml(memoryRefLabel(ref, data))}</div>
          <div class="am-card-body">${escapeHtml(body || '没有可展开的正文。')}</div>
        </div>
      `);
    }
    return;
  }
  if (!state.lastRecallMeta.length) {
    container.append('<div class="am-card"><div class="am-card-body">暂无召回命中。</div></div>');
    return;
  }
  for (const hit of state.lastRecallMeta) {
    const label = hit.kind === 'merge' ? '全量合并' : hit.kind === 'godlog' ? '前情片段' : `${Math.max(1, Number(settings().anchorInterval) || 15)}回合锚点`;
    const body = memoryRefBody(hit, data);
    const position = hit.kind === 'godlog'
      ? `第 ${Number.isInteger(hit.floor) ? hit.floor + 1 : hit.number} 楼`
      : `第 ${hit.number} 次`;
    container.append(`
      <div class="am-card">
        <div class="am-card-title"><span>${escapeHtml(label)} · ${escapeHtml(position)}</span><span class="am-pill">${escapeHtml(hit.method)}</span></div>
        <div class="am-card-meta">相关度：${hit.score.toFixed(3)}${hit.recallReason ? ` · ${escapeHtml(hit.recallReason)}` : ''}${hit.recallTokens ? ` · 约${escapeHtml(hit.recallTokens)} token` : ''}</div>
        <div class="am-card-body">${escapeHtml(body || '没有可展开的正文。')}</div>
      </div>
    `);
  }
}

function findGodlogItem(id) {
  const data = memoryData();
  const item = (data.godlogs || []).find(entry => entry.id === id);
  return item ? { data, item } : null;
}

async function saveSelectedGodlog() {
  const found = findGodlogItem(state.selectedGodlogId);
  if (!found) {
    if (rowFromSyntheticGodlogId(state.selectedGodlogId)) {
      toastr?.warning?.('这楼还没有摘要记录，请点“重跑本楼摘要”或“自动补写缺失摘要”。', 'Anchor Memory');
      return;
    }
    toastr?.warning?.('请先选择一条逐楼摘要', 'Anchor Memory');
    return;
  }
  let body = normalizeGodlogBlock($('#am_godlog_detail').val());
  if (!body) {
    toastr?.warning?.('摘要内容不能为空', 'Anchor Memory');
    return;
  }
  const row = currentRowForGodlog(found.item);
  if (row) body = replaceGodlogField(body, 'Nub', String(godlogNumberForRow(row) || found.item.number || 1));
  const changedBody = body !== found.item.body;

  if (!changedBody) {
    if (row) preserveCompletedGodlogOnSourceChange(found.data, found.item, row, '楼层在摘要保存后发生了变化');
    saveMemory();
    updatePreview();
    scheduleGodlogPanelRender(row?.index ?? found.item.floor);
    toastr?.info?.('摘要内容没有改动，继续保留原保存版本；不会因为点“保存”而重新绑定当前正文。', 'Anchor Memory');
    return;
  }

  markAnchorsStaleByKey(found.data, found.item.key, '逐楼摘要被手动修改');
  delete found.data.messageRecalls?.[found.item.key];
  rollbackRelationshipToFloor(found.data, Math.max(-1, Number(found.item.floor || 0) - 1), '逐楼摘要被手动修改');
  markCodexDirty(found.data, '逐楼摘要被手动修改');

  Object.assign(found.item, {
    body,
    status: 'ready',
    stale: false,
    staleSince: 0,
    previousRawHash: '',
    currentRawHash: '',
    sourceMismatch: false,
    sourceMismatchReason: '',
    sourceMismatchAt: 0,
    rerunPending: false,
    rerunError: '',
    retryCount: 0,
    error: '',
    editedAt: Date.now(),
    updatedAt: Date.now(),
  });
  if (row) {
    Object.assign(found.item, {
      number: godlogNumberForRow(row) || found.item.number,
      floor: row.index,
      key: row.key,
      role: row.role,
      name: row.name,
      sendDate: row.sendDate,
      rawHash: row.rawHash,
    });
  }
  removeStoredVector(found.data, found.item.id);
  refreshCoverageMaps(found.data);
  saveMemory(true);
  await enforceAnchorHiddenState(found.data);
  scheduleCodexBacklog();
  await embedMemoryItem(found.data, found.item.id, safeGodlogMemoryText(found.item.body || ''));
  queueMemoryJob('逐楼摘要已修改', 120);
  updatePreview();
  toastr?.success?.('逐楼摘要已保存；依赖的锚点已按需回滚', 'Anchor Memory');
}

async function rerunSelectedGodlog() {
  const syntheticRow = rowFromSyntheticGodlogId(state.selectedGodlogId);
  if (syntheticRow) {
    const ok = await generateGodlogForRow(syntheticRow, true);
    const current = godlogForRow(memoryData(), syntheticRow);
    $('#am_godlog_detail').val(current?.body || current?.error || '');
    updatePreview();
    if (ok) toastr?.success?.(`第 ${syntheticRow.index + 1} 楼摘要已生成`, 'Anchor Memory');
    else if (isGenerationActive() && isLatestAssistantRow(syntheticRow)) toastr?.warning?.('当前楼仍在由主模型生成，已排队到生成结束后重跑。', 'Anchor Memory');
    else toastr?.error?.(`本楼摘要未完成：${current?.rerunError || current?.error || '请检查副API配置或控制台错误'}`, 'Anchor Memory');
    return;
  }
  const found = findGodlogItem(state.selectedGodlogId);
  if (!found) {
    toastr?.warning?.('请先选择一条逐楼摘要', 'Anchor Memory');
    return;
  }
  if (found.item.archived) {
    toastr?.warning?.('归档摘要没有当前楼层原文，不能重跑；可以手动编辑后保存。', 'Anchor Memory');
    return;
  }
  const row = chatRows(false).find(item => item.key === found.item.key);
  if (!row) {
    forgetGodlogItem(found.data, found.item, '原楼层已删除，无法重跑');
    saveMemory();
    updatePreview();
    toastr?.warning?.('原楼层已删除，已清理对应摘要', 'Anchor Memory');
    return;
  }
  const ok = await generateGodlogForRow(row, true);
  const current = godlogForRow(memoryData(), row);
  $('#am_godlog_detail').val(current?.body || current?.error || '');
  updatePreview();
  if (ok) toastr?.success?.(`第 ${row.index + 1} 楼摘要已重新生成`, 'Anchor Memory');
  else if (isGenerationActive() && isLatestAssistantRow(row)) toastr?.warning?.('当前楼仍在由主模型生成，已排队到生成结束后重跑。', 'Anchor Memory');
  else toastr?.error?.(`本楼摘要未完成：${current?.rerunError || current?.error || '请检查副API配置或控制台错误'}`, 'Anchor Memory');
}

function deleteSelectedGodlog() {
  const found = findGodlogItem(state.selectedGodlogId);
  if (!found) {
    if (rowFromSyntheticGodlogId(state.selectedGodlogId)) {
      toastr?.warning?.('这楼还没有摘要记录，不需要删除；可直接自动补写。', 'Anchor Memory');
      return;
    }
    toastr?.warning?.('请先选择一条逐楼摘要', 'Anchor Memory');
    return;
  }
  if (!confirm('删除选中的逐楼摘要？依赖它的锚点和全量合并也会回滚，并在下次任务中重建。')) return;
  forgetGodlogItem(found.data, found.item, '逐楼摘要被手动删除');
  state.selectedGodlogId = '';
  $('#am_godlog_detail').val('');
  saveMemory(true);
  enforceAnchorHiddenState(found.data).catch(console.warn);
  queueMemoryJob('逐楼摘要已删除', 120);
  updatePreview();
  toastr?.success?.('逐楼摘要及其派生记忆已回滚', 'Anchor Memory');
}

function findMemoryItem(id) {
  const data = memoryData();
  const anchor = data.anchors.find(item => item.id === id);
  if (anchor) return { data, item: anchor, list: data.anchors, kind: 'anchor' };
  const merge = data.merges.find(item => item.id === id);
  if (merge) return { data, item: merge, list: data.merges, kind: 'merge' };
  return null;
}

async function saveSelectedMemory() {
  const found = findMemoryItem(state.selectedMemoryId);
  if (!found) {
    toastr?.warning?.('请先在时间线选择一条锚点或合并', 'Anchor Memory');
    return;
  }
  const body = $('#am_timeline_detail').val().trim();
  if (!body) {
    toastr?.warning?.('内容不能为空', 'Anchor Memory');
    return;
  }
  if (body === found.item.body) return;

  if (found.kind === 'anchor') {
    const keys = new Set(found.item.sourceKeys || []);
    let cascade = false;
    found.data.merges = found.data.merges.filter(merge => {
      const touches = (merge.sourceKeys || []).some(key => keys.has(key));
      if (cascade || touches) {
        cascade = true;
        removeStoredVector(found.data, merge.id);
        return false;
      }
      return true;
    });
  } else {
    const index = found.data.merges.findIndex(item => item.id === found.item.id);
    for (const merge of found.data.merges.slice(index + 1)) removeStoredVector(found.data, merge.id);
    found.data.merges = found.data.merges.slice(0, index + 1);
  }

  found.item.body = body;
  found.item.editedAt = Date.now();
  removeStoredVector(found.data, found.item.id);
  markCodexDirty(found.data, found.kind === 'anchor' ? '锚点被修改或删除' : '累计历史锚点被修改或删除');
  renumberDerivedMemory(found.data);
  refreshCoverageMaps(found.data);
  saveMemory(true);
  await enforceAnchorHiddenState(found.data);
  scheduleCodexBacklog();
  await embedMemoryItem(found.data, found.item.id, body);
  updatePreview();
  toastr?.success?.('记忆已保存；依赖它的后续合并已回滚', 'Anchor Memory');
}

async function deleteSelectedMemory() {
  const found = findMemoryItem(state.selectedMemoryId);
  if (!found) {
    toastr?.warning?.('请先在时间线选择一条锚点或合并', 'Anchor Memory');
    return;
  }
  if (!confirm('删除选中的锚点/合并？依赖它的后续合并会一起回滚。')) return;

  if (found.kind === 'anchor') {
    const keys = new Set(found.item.sourceKeys || []);
    found.data.anchors = found.data.anchors.filter(item => item.id !== found.item.id);
    let cascade = false;
    found.data.merges = found.data.merges.filter(merge => {
      const touches = (merge.sourceKeys || []).some(key => keys.has(key));
      if (cascade || touches) {
        cascade = true;
        removeStoredVector(found.data, merge.id);
        return false;
      }
      return true;
    });
  } else {
    const index = found.data.merges.findIndex(item => item.id === found.item.id);
    for (const merge of found.data.merges.slice(index)) removeStoredVector(found.data, merge.id);
    found.data.merges = found.data.merges.slice(0, Math.max(0, index));
  }

  removeStoredVector(found.data, found.item.id);
  markCodexDirty(found.data, found.kind === 'anchor' ? '锚点被修改或删除' : '累计历史锚点被修改或删除');
  renumberDerivedMemory(found.data);
  refreshCoverageMaps(found.data);
  state.selectedMemoryId = '';
  saveMemory(true);
  await enforceAnchorHiddenState(found.data);
  scheduleCodexBacklog();
  queueMemoryJob('派生记忆已删除', 120);
  updatePreview();
  toastr?.success?.('选中记忆及其依赖已回滚', 'Anchor Memory');
}

function compactArchiveSnapshot(data) {
  const snapshot = JSON.parse(JSON.stringify(data || defaultData()));
  snapshot.messageGodlogs = {};
  snapshot.messageRecalls = {};
  snapshot.vectorRefs = {};
  snapshot.vectors = {};
  snapshot.relationshipTable = normalizeRelationshipTable(snapshot.relationshipTable, snapshot.codex?.relationship || '');
  snapshot.relationshipTable.history = [];
  if (snapshot.codexBackup?.relationshipTable) snapshot.codexBackup.relationshipTable.history = [];
  snapshot.processing = {
    ...defaultData().processing,
    ...(snapshot.processing || {}),
    storageId: '',
    pendingPromptInjection: null,
    queueSources: [],
    busy: false,
    summaryBusy: false,
    codexBusy: false,
    queuePending: false,
    queueRunning: false,
  };
  return snapshot;
}

function saveArchive() {
  const s = settings();
  const charName = currentCharacterName();
  const archiveName = ($('#am_archive_name').val() || '主线').trim();
  if (!s.slots[charName]) s.slots[charName] = {};
  s.slots[charName][archiveName] = {
    updatedAt: Date.now(),
    data: compactArchiveSnapshot(memoryData()),
  };
  saveSettingsDebounced();
  renderArchiveCards();
  toastr?.success?.(`已保存记忆档案：${charName} / ${archiveName}`, 'Anchor Memory');
}

function portableArchiveData(data) {
  const loaded = JSON.parse(JSON.stringify(data || defaultData()));
  loaded.godlogs = (loaded.godlogs || []).map(item => ({
    ...item,
    archived: true,
    status: item.status === 'ready' ? 'ready' : item.status,
  }));
  loaded.processing = {
    ...defaultData().processing,
    ...(loaded.processing || {}),
    anchoredKeys: {},
    lastAnchorFloor: -1,
    lastMergeFloor: -1,
    pendingPromptInjection: null,
    busy: false,
    summaryBusy: false,
    lastContextReplacement: null,
    lastError: '',
  };
  loaded.messageGodlogs = {};
  loaded.messageRecalls = {};
  loaded.vectorRefs = {};
  loaded.vectors = {};
  loaded.processing.storageId = '';
  loaded.relationshipTable = normalizeRelationshipTable(loaded.relationshipTable, loaded.codex?.relationship || '');
  loaded.relationshipTable.history = [];
  loaded.processing.godlogCount = loaded.godlogs.length;
  return loaded;
}

async function loadArchive(archiveName = '') {
  const s = settings();
  const charName = currentCharacterName();
  archiveName = archiveName || $('#am_archive_name').val().trim();
  const archive = s.slots?.[charName]?.[archiveName];
  if (!archiveName || !archive) {
    toastr?.warning?.(`找不到 ${charName} 的这个记忆档案`, 'Anchor Memory');
    return;
  }
  const ctx = getContext();
  if (!ctx.chatMetadata) ctx.chatMetadata = {};
  ctx.chatMetadata[DATA_KEY] = portableArchiveData(archive.data);
  const data = memoryData();
  saveMemory(true);
  await enforceAnchorHiddenState(data);
  await injectMemory();
  updatePreview();
  toastr?.success?.(`已加载记忆档案：${charName} / ${archiveName}`, 'Anchor Memory');
}

function deleteArchive(archiveName = '') {
  const s = settings();
  const charName = currentCharacterName();
  archiveName = archiveName || $('#am_archive_name').val().trim();
  if (!archiveName || !s.slots?.[charName]?.[archiveName]) return;
  if (!confirm(`删除记忆档案「${charName} / ${archiveName}」？`)) return;
  delete s.slots[charName][archiveName];
  saveSettingsDebounced();
  renderArchiveCards();
  toastr?.success?.('记忆档案已删除', 'Anchor Memory');
}

async function rebuildVectors() {
  const data = memoryData();
  if (!embeddingConfigured()) {
    toastr?.warning?.('请先配置副API并启用Embedding', 'Anchor Memory');
    return;
  }
  await clearStoredVectors(data);
  saveMemory();
  showStatus('正在重建向量...');
  for (const godlog of data.godlogs || []) {
    if (godlog.status === 'ready') await embedMemoryItem(data, godlog.id, safeGodlogMemoryText(godlog.body || ''));
  }
  for (const anchor of data.anchors) await embedMemoryItem(data, anchor.id, anchor.body);
  for (const merge of data.merges) await embedMemoryItem(data, merge.id, merge.body);
  toastr?.success?.('向量重建完成', 'Anchor Memory');
  updatePreview();
}

function selectFetchedModel(current, models) {
  const value = String(current || '').trim();
  if (!Array.isArray(models) || models.length === 0) return value;
  return models.includes(value) ? value : models[0];
}

async function fetchSecondaryModels() {
  const s = settings();
  if (!s.secondaryUrl || !s.secondaryKey) {
    toastr?.warning?.('请先填写副API地址和密钥', 'Anchor Memory');
    return;
  }
  try {
    showStatus('正在拉取副API模型...');
    const models = await fetchProviderModels(s.secondaryUrl, s.secondaryKey, 'chat');
    s.secondaryModels = models;
    s.secondaryModel = selectFetchedModel(s.secondaryModel, models);
    saveSettingsDebounced();
    renderModelOptions('#am_secondary_model_options', models);
    $('#am_secondary_model').val(s.secondaryModel);
    toastr?.success?.(`已拉取 ${models.length} 个副API模型`, 'Anchor Memory');
  } catch (err) {
    toastr?.error?.(`模型拉取失败：${err.message}`, 'Anchor Memory');
  } finally {
    updatePreview();
  }
}

async function fetchEmbeddingModels() {
  const s = settings();
  const url = s.embeddingUrl || s.secondaryUrl;
  const key = s.embeddingKey || s.secondaryKey;
  if (!url || !key) {
    toastr?.warning?.('请先填写Embedding API地址和密钥', 'Anchor Memory');
    return;
  }
  try {
    showStatus('正在拉取Embedding模型...');
    const models = await fetchProviderModels(url, key, 'embedding');
    s.embeddingModels = models;
    s.embeddingModel = selectFetchedModel(s.embeddingModel, models);
    saveSettingsDebounced();
    renderModelOptions('#am_embedding_model_options', models);
    $('#am_embedding_model').val(s.embeddingModel);
    toastr?.success?.(`已拉取 ${models.length} 个Embedding模型`, 'Anchor Memory');
  } catch (err) {
    toastr?.error?.(`模型拉取失败：${err.message}`, 'Anchor Memory');
  } finally {
    updatePreview();
  }
}

function applySiliconFlowEmbeddingPreset() {
  const s = settings();
  s.useEmbedding = true;
  s.embeddingUrl = 'https://api.siliconflow.cn/v1';
  if (!s.embeddingKey && s.secondaryKey) s.embeddingKey = s.secondaryKey;
  s.embeddingModel = s.embeddingModel || 'BAAI/bge-m3';
  if (!s.embeddingModel || /text-embedding-3/i.test(s.embeddingModel)) s.embeddingModel = 'BAAI/bge-m3';
  s.embeddingDimensionsMode = 'never';
  saveSettingsDebounced();
  loadUi();
  toastr?.success?.('已套用硅基流动向量配置：默认不发送 dimensions', 'Anchor Memory');
}

async function testEmbedding() {
  if (!embeddingConfigured()) {
    toastr?.warning?.('请先启用Embedding，并填写Embedding API或副API', 'Anchor Memory');
    return;
  }
  try {
    showStatus('正在测试向量接口...');
    const [vector] = await embedTexts(['锚点记忆测试']);
    const hasDimensions = Object.prototype.hasOwnProperty.call(embeddingRequestBody(['test']), 'dimensions');
    toastr?.success?.(`向量接口可用，返回 ${vector?.length || 0} 维；dimensions ${hasDimensions ? '已发送' : '未发送'}`, 'Anchor Memory');
  } catch (err) {
    toastr?.error?.(`向量测试失败：${err.message}`, 'Anchor Memory');
  } finally {
    updatePreview();
  }
}

async function testSecondary() {
  const s = settings();
  if (!s.useSecondary || !s.secondaryUrl || !s.secondaryKey) {
    toastr?.warning?.('请先启用副API并填写地址/密钥', 'Anchor Memory');
    return;
  }
  try {
    showStatus('正在测试副API...');
    const text = await callSecondary([
      { role: 'system', content: '你是连接测试助手。' },
      { role: 'user', content: '请只回复：连接成功' },
    ], 50);
    toastr?.success?.(`副API可用：${text.slice(0, 80)}`, 'Anchor Memory');
  } catch (err) {
    toastr?.error?.(`副API测试失败：${err.message}`, 'Anchor Memory');
  } finally {
    updatePreview();
  }
}

function renderRelationshipEditor(data = memoryData()) {
  const container = $('#am_relationship_rows');
  if (!container.length) return;
  const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  container.empty();
  for (const row of table.rows) {
    const displayName = renderMacros(row.name);
    container.append(`
      <tr data-relationship-id="${escapeHtml(row.id)}">
        <td>
          ${row.locked
            ? `<div class="am-relationship-locked-name"><b>${escapeHtml(displayName)}</b><small>自动绑定主角色</small></div>`
            : `<input class="text_pole am-relationship-name" type="text" value="${escapeHtml(row.name)}" aria-label="关系人物名称" />`}
        </td>
        <td>${escapeHtml(renderMacros(row.past || '未明'))}</td>
        <td>${escapeHtml(renderMacros(row.development || '未明'))}</td>
        <td>${escapeHtml(renderMacros(row.current || '未明'))}</td>
        <td>${row.locked ? '<span class="am-pill">固定</span>' : '<button type="button" class="am-delete-relationship-row">删除</button>'}</td>
      </tr>
    `);
  }
  const status = data.processing?.relationshipDirty
    ? `关系表待重建：${data.processing.relationshipDirtyReason || '固定名单或剧情来源已变化'}。固定行不会丢失，重建成功前不会注入旧关系。`
    : `关系表已持久化，共 ${table.rows.length} 行${table.lastGoodFloor >= 0 ? `；最近有效快照到第 ${table.lastGoodFloor + 1} 楼` : ''}。`;
  $('#am_relationship_status').text(status)
    .toggleClass('am-warning-text', !!data.processing?.relationshipDirty);
}

function addRelationshipRow() {
  const data = memoryData();
  const input = $('#am_relationship_new_name');
  const name = cleanRelationshipCell(input.val(), 120);
  if (!name) {
    toastr?.warning?.('请先填写要追踪的人物名称。', 'Anchor Memory');
    return false;
  }
  const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  const key = relationshipNameKey(name);
  if (!key || table.rows.some(row => relationshipNameKey(row.name) === key)) {
    toastr?.warning?.('该人物已在固定关系表中，不能重复添加。', 'Anchor Memory');
    return false;
  }
  snapshotCodex(data, '新增固定人物关系行前备份');
  table.rows.push({
    id: relationshipRowId(name),
    name,
    locked: false,
    past: '',
    development: '',
    current: '',
    createdAt: Date.now(),
    updatedAt: 0,
  });
  table.history = [];
  data.relationshipTable = table;
  data.codex.relationship = relationshipTableMarkdown(table, false);
  markRelationshipDirty(data, `新增固定关系人物“${renderMacros(name)}”，等待根据当前有效剧情回填`);
  saveMemory(true);
  input.val('');
  scheduleCodexBacklog(4);
  updatePreview();
  return true;
}

function saveRelationshipNames() {
  const data = memoryData();
  const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  const byId = new Map(table.rows.map(row => [row.id, row]));
  const proposed = [];
  let invalid = '';
  $('#am_relationship_rows tr').each(function () {
    const id = String($(this).data('relationship-id') || '');
    const row = byId.get(id);
    if (!row) return;
    const name = row.locked ? '{{char}}' : cleanRelationshipCell($(this).find('.am-relationship-name').val(), 120);
    if (!name && !invalid) invalid = '人物名称不能为空。';
    proposed.push({ row, name });
  });
  if (invalid) {
    toastr?.warning?.(invalid, 'Anchor Memory');
    return false;
  }
  const seen = new Set();
  for (const item of proposed) {
    const key = relationshipNameKey(item.name);
    if (!key || seen.has(key)) {
      toastr?.warning?.('固定关系表中存在重名人物，请修改后再保存。', 'Anchor Memory');
      return false;
    }
    seen.add(key);
  }
  const schemaChanged = proposed.some(({ row, name }) => row.name !== name);
  if (schemaChanged) snapshotCodex(data, '修改固定人物关系名单前备份');
  for (const { row, name } of proposed) {
    if (row.name === name) continue;
    row.name = name;
    row.past = '';
    row.development = '';
    row.current = '';
    row.updatedAt = 0;
  }
  if (schemaChanged) {
    table.history = [];
    markRelationshipDirty(data, '固定人物关系名单被改名，等待根据当前有效剧情重新回填');
  }
  data.relationshipTable = table;
  data.codex.relationship = relationshipTableMarkdown(table, false);
  saveMemory(true);
  if (schemaChanged) scheduleCodexBacklog(4);
  updatePreview();
  toastr?.success?.('固定人物关系名单已保存', 'Anchor Memory');
  return true;
}

function deleteRelationshipRow(id) {
  const data = memoryData();
  const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  const row = table.rows.find(item => item.id === id);
  if (!row || row.locked) return false;
  if (!confirm(`从固定人物关系表删除“${renderMacros(row.name)}”？只删除该关系行，不删除人物库。`)) return false;
  snapshotCodex(data, '删除固定人物关系行前备份');
  table.rows = table.rows.filter(item => item.id !== id);
  for (const snapshot of table.history || []) delete snapshot.states?.[id];
  data.relationshipTable = table;
  data.codex.relationship = relationshipTableMarkdown(table, false);
  saveMemory(true);
  injectMemory().catch(console.warn);
  updatePreview();
  toastr?.success?.('关系行已删除', 'Anchor Memory');
  return true;
}

async function saveTrackedCharacterSettings() {
  const data = memoryData();
  const next = parseTrackedCharacterInput($('#am_tracked_characters').val());
  const before = JSON.stringify(data.trackedCharacters || []);
  data.trackedCharacters = next;
  // Apply the whitelist immediately so a previously leaked {{user}} row disappears before the
  // background rebuild. The last known valid values for retained protagonists are preserved.
  data.codex.characterMemo = sanitizeCharacterMemoSection(data, data.codex.characterMemo);
  data.codex.peopleIndex = sanitizePeopleIndexSection(data, data.codex.peopleIndex);
  if (before !== JSON.stringify(next)) markCodexDirty(data, '人物纪要追踪名单已变化，需要按当前有效剧情安全重建');
  saveMemory(true);
  updatePreview();
  await injectMemory().catch(console.warn);
  const s = settings();
  if (s.useSecondary && s.secondaryUrl && s.secondaryKey) {
    const rebuilt = await rebuildCodexFromGodlogs(false);
    if (rebuilt) toastr?.success?.(`已保存追踪名单：${trackedCharacterLabel(memoryData())}`, 'Anchor Memory');
    else toastr?.warning?.('追踪名单已保存；索引仍在等待安全重建。', 'Anchor Memory');
  } else {
    toastr?.warning?.(`追踪名单已保存：${trackedCharacterLabel(data)}。配置副API后请点“安全重建人物/物品/场景索引”。`, 'Anchor Memory');
  }
}

function saveCharacterEdits() {
  const data = memoryData();
  data.codex.characterMemo = sanitizeCharacterMemoSection(data, $('#am_character_memo_edit').val().trim());
  data.codex.peopleIndex = sanitizePeopleIndexSection(data, $('#am_people_edit').val().trim());
  saveMemory();
  updatePreview();
  toastr?.success?.('人物记忆已保存，并已按追踪白名单过滤', 'Anchor Memory');
}

function saveItemEdits() {
  const data = memoryData();
  const before = data.codex.itemIndex || '';
  const rawInput = $('#am_items_edit').val().trim();
  const entities = ensureEntityState(data);
  for (const row of parseMarkdownTable(rawInput)) {
    const name = firstTableValue(row, ['物品/细节/内部梗', '物品', '细节', '内部梗'], ['物品', '细节', '内部梗']);
    if (name) delete entities.itemTombstones[entityKey(name)];
  }
  const candidate = sanitizeItemIndexSection(data, rawInput);
  markManualEntityDeletions(data, 'items', before, candidate);
  data.codex.itemIndex = sanitizeItemIndexSection(data, candidate);
  syncEntityLedgers(data, { manualItems: true });
  saveMemory(true);
  injectMemory().catch(err => console.warn('[AnchorMemory] inject after item edit failed', err));
  updatePreview();
  toastr?.success?.('物品/梗/伏笔已保存；手动删除项已建立防复活标记', 'Anchor Memory');
}

function saveSceneEdits() {
  const data = memoryData();
  const before = data.codex.sceneIndex || '';
  const rawInput = $('#am_scenes_edit').val().trim();
  const entities = ensureEntityState(data);
  for (const row of parseMarkdownTable(rawInput)) {
    const name = firstTableValue(row, ['场景/地点', '场景', '地点', '名称'], ['场景', '地点']);
    if (name) delete entities.sceneTombstones[entityKey(name)];
  }
  const candidate = sanitizeSceneIndexSection(data, rawInput);
  markManualEntityDeletions(data, 'scenes', before, candidate);
  data.codex.sceneIndex = sanitizeSceneIndexSection(data, candidate);
  const currentTime = $('#am_current_time_edit').val().trim();
  const currentPlace = $('#am_current_place_edit').val().trim();
  const latestFloor = Math.max(-1, ...(data.godlogs || []).map(item => Number(item.floor ?? -1)));
  data.timeline = ensureTimelineState(data);
  data.timeline.manualOverride = (currentTime || currentPlace) ? {
    currentTime: currentTime || data.codex.currentTime || '未明',
    currentPlace: currentPlace || data.codex.currentPlace || '未明',
    floor: latestFloor,
    sourceKey: '',
    at: Date.now(),
  } : null;
  if (currentTime) data.codex.currentTime = currentTime;
  if (currentPlace) data.codex.currentPlace = currentPlace;
  syncEntityLedgers(data, { manualScenes: true });
  refreshTimelineFromGodlogs(data);
  syncLatestGodlogPositionFields(data);
  saveMemory(true);
  injectMemory().catch(err => console.warn('[AnchorMemory] inject after scene edit failed', err));
  updatePreview();
  toastr?.success?.('场景记录与剧情时间基线已保存；后续楼层会从该基线继续推进', 'Anchor Memory');
}

function exportData() {
  $('#am_json_box').val(JSON.stringify(memoryData(), null, 2));
  toastr?.success?.('当前记忆已导出到文本框', 'Anchor Memory');
}

function exportConfig() {
  const s = settings();
  const safeConfig = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (['secondaryKey', 'embeddingKey', 'slots'].includes(key)) continue;
    safeConfig[key] = s[key];
  }
  $('#am_json_box').val(JSON.stringify({
    type: 'anchor-memory-config',
    version: DATA_VERSION,
    exportedAt: Date.now(),
    settings: safeConfig,
  }, null, 2));
  toastr?.success?.('配置已导出，不包含API密钥和记忆档案', 'Anchor Memory');
}

function importConfig() {
  try {
    const imported = JSON.parse($('#am_json_box').val() || '{}');
    const incoming = imported.settings || imported;
    const s = settings();
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (['secondaryKey', 'embeddingKey', 'slots'].includes(key)) continue;
      if (incoming[key] !== undefined) s[key] = incoming[key];
    }
    saveSettingsDebounced();
    loadUi();
    toastr?.success?.('配置已导入，原API密钥和记忆档案已保留', 'Anchor Memory');
  } catch (err) {
    toastr?.error?.(`配置导入失败：${err.message}`, 'Anchor Memory');
  }
}

async function importData() {
  try {
    const imported = JSON.parse($('#am_json_box').val() || '{}');
    const current = hasPersistentChatContext() ? memoryData() : null;
    if (current && (codexHasContent(current.codex) || relationshipHasContent(current.relationshipTable)) && !imported.codexBackup) {
      imported.codexBackup = {
        savedAt: Date.now(),
        reason: '导入新记忆JSON前自动备份',
        signature: codexSignature(current.codex, current.relationshipTable),
        codex: clonePlainObject(current.codex),
        relationshipTable: clonePlainObject(normalizeRelationshipTable(current.relationshipTable, current.codex?.relationship || '')),
        codexKeys: clonePlainObject(current.processing?.codexKeys || {}),
        lastCodexFloor: Number(current.processing?.lastCodexFloor ?? -1),
      };
    }
    // Exported JSON intentionally omits the heavy IndexedDB vectors. Do not carry dangling
    // references/storage namespaces into an imported chat; embeddings can be rebuilt on demand.
    imported.vectorRefs = {};
    if (!imported.vectors || typeof imported.vectors !== 'object') imported.vectors = {};
    imported.processing = { ...(imported.processing || {}), storageId: '' };
    const ctx = getContext();
    if (!ctx.chatMetadata) ctx.chatMetadata = {};
    ctx.chatMetadata[DATA_KEY] = {
      ...defaultData(),
      ...imported,
      processing: { ...defaultData().processing, ...(imported.processing || {}), busy: false, summaryBusy: false, codexBusy: false, queueRunning: false },
    };
    const data = memoryData();
    saveMemory(true);
    await enforceAnchorHiddenState(data);
    await injectMemory();
    updatePreview();
    toastr?.success?.('记忆JSON已导入并完成一致性校验', 'Anchor Memory');
  } catch (err) {
    toastr?.error?.(`导入失败：${err.message}`, 'Anchor Memory');
  }
}

async function resetCurrentMemory() {
  if (!confirm('清空当前聊天的锚点记忆？记忆档案不会被删除。')) return;
  const ctx = getContext();
  removeAllGodlogBlocksFromChat();
  if (!ctx.chatMetadata) ctx.chatMetadata = {};
  ctx.chatMetadata[DATA_KEY] = defaultData();
  const data = memoryData();
  saveMemory(true);
  await enforceAnchorHiddenState(data);
  setExtensionPrompt(CORE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
  setExtensionPrompt(RECALL_PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0);
  state.lastRecall = '';
  state.lastRecallMeta = [];
  updatePreview();
  toastr?.success?.('当前聊天锚点记忆已清空，插件隐藏状态已还原', 'Anchor Memory');
}

function promptPreset(name) {
  if (name === 'strict') {
    return {
      godlog: `${DEFAULT_GODLOG_RULES}
补充要求：关键原话优先保真，无法确认的细节写“未明”，不要自行补完。`,
      anchor: `${DEFAULT_ANCHOR_RULES}
- 原话保真优先级最高；无法确认的台词不得伪造。
- 每条事件必须写明“谁因为什么采取行动，导致什么后果”。
- 对敏感、尴尬、冲突内容不美化、不回避，只做客观记录。`,
      merge: `${DEFAULT_MERGE_RULES}
- 合并时优先保留关键原话、承诺、冲突、破壁事件、道具伏笔。
- 不得为了压缩而删除角色弧光的转折点。`,
      character: DEFAULT_CHARACTER_RULES,
      people: DEFAULT_PEOPLE_RULES,
      item: DEFAULT_ITEM_RULES,
    };
  }
  if (name === 'compact') {
    return {
      godlog: `${DEFAULT_GODLOG_RULES}
补充要求：Cond 控制在200字左右，只保留会影响因果链、心理转折或后续伏笔的细节。`,
      anchor: `${DEFAULT_ANCHOR_RULES}
- 在不丢失因果和原话的前提下压缩措辞。
- 日常动作只在影响关系、伏笔或角色变化时记录。`,
      merge: `${DEFAULT_MERGE_RULES}
- 历史事件尽量短句化，新增事件保留必要细节。
- 表格用短语，不写长段散文。`,
      character: `${DEFAULT_CHARACTER_RULES}
- 一句话摘要必须短，不超过80字。`,
      people: `${DEFAULT_PEOPLE_RULES}
- 表格单元格尽量用短句。`,
      item: `${DEFAULT_ITEM_RULES}
- 只保留关键物品、核心细节和会反复出现的梗。`,
    };
  }
  return {
    godlog: DEFAULT_GODLOG_RULES,
    anchor: DEFAULT_ANCHOR_RULES,
    merge: DEFAULT_MERGE_RULES,
    character: DEFAULT_CHARACTER_RULES,
    people: DEFAULT_PEOPLE_RULES,
    item: DEFAULT_ITEM_RULES,
  };
}

function installExtensionSettingsEntry() {
  if (!$ || $('#anchor_memory_settings_entry').length) return true;
  const host = $('#extensions_settings2, #extensions_settings').first();
  if (!host.length) {
    setTimeout(installExtensionSettingsEntry, 500);
    return false;
  }

  const entry = $(`
    <div id="anchor_memory_settings_entry" class="anchor-memory-extension-entry inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>Anchor Memory 锚点书</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="am-extension-entry-row">
          <span>逐楼摘要、分段锚点与累计历史合并（间隔均可配置）</span>
          <button id="am_open_workbench_from_extensions" type="button" class="menu_button">打开面板</button>
        </div>
        <small id="am_extension_load_status">插件已加载 · ${EXTENSION_VERSION}</small>
      </div>
    </div>
  `);
  host.append(entry);
  entry.find('.inline-drawer-toggle').on('click', function () {
    entry.find('.inline-drawer-content').first().slideToggle?.(200);
    entry.find('.inline-drawer-icon').toggleClass('down up');
  });
  entry.find('#am_open_workbench_from_extensions').on('click', () => {
    if (!openWorkbench()) {
      toastr?.warning?.('面板模板尚未加载，请稍后再试。', 'Anchor Memory');
    }
  });
  return true;
}

let workbenchViewportEventsBound = false;
let workbenchViewportRaf = 0;

function syncWorkbenchViewport() {
  const shell = document.getElementById('anchor_memory_workbench');
  if (!shell) return;
  const viewport = window.visualViewport;
  const width = Math.max(240, Math.round(viewport?.width || window.innerWidth || document.documentElement.clientWidth || 0));
  const height = Math.max(240, Math.round(viewport?.height || window.innerHeight || document.documentElement.clientHeight || 0));
  const offsetTop = Math.max(0, Math.round(viewport?.offsetTop || 0));
  const offsetLeft = Math.max(0, Math.round(viewport?.offsetLeft || 0));
  shell.style.setProperty('--am-vv-width', `${width}px`);
  shell.style.setProperty('--am-vv-height', `${height}px`);
  shell.style.setProperty('--am-vv-top', `${offsetTop}px`);
  shell.style.setProperty('--am-vv-left', `${offsetLeft}px`);
}

function scheduleWorkbenchViewportSync() {
  if (workbenchViewportRaf) cancelAnimationFrame(workbenchViewportRaf);
  workbenchViewportRaf = requestAnimationFrame(() => {
    workbenchViewportRaf = 0;
    if ($('#anchor_memory_workbench').hasClass('open')) syncWorkbenchViewport();
  });
}

function bindWorkbenchViewportEvents() {
  if (workbenchViewportEventsBound) return;
  workbenchViewportEventsBound = true;
  window.addEventListener('resize', scheduleWorkbenchViewportSync, { passive: true });
  window.addEventListener('orientationchange', scheduleWorkbenchViewportSync, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleWorkbenchViewportSync, { passive: true });
  window.visualViewport?.addEventListener('scroll', scheduleWorkbenchViewportSync, { passive: true });
}

function openWorkbench() {
  const shell = $('#anchor_memory_workbench');
  if (!shell.length) return false;
  bindWorkbenchViewportEvents();
  syncWorkbenchViewport();
  shell.addClass('open').attr('aria-hidden', 'false');
  $('body').addClass('am-workbench-open');
  const content = shell.find('.am-workbench-content').get(0);
  if (content) content.scrollTop = 0;
  scheduleWorkbenchViewportSync();
  updatePreview();
  return true;
}

function closeWorkbench() {
  $('#anchor_memory_workbench').removeClass('open').attr('aria-hidden', 'true');
  $('body').removeClass('am-workbench-open');
}

// Recovery hook: `anchorMemoryOpen()` can be called from the browser console even if a theme
// changes the navigation layout and hides the normal launcher.
window.anchorMemoryOpen = openWorkbench;


function installPublicApi() {
  const readonlySnapshot = () => {
    const data = memoryData();
    return clonePlainObject({
      version: EXTENSION_VERSION,
      dataVersion: DATA_VERSION,
      godlogs: data.godlogs || [],
      anchors: activeAnchors(data),
      merges: activeMerges(data),
      relationshipTable: normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || ''),
      codex: data.codex || {},
      timeline: data.timeline || {},
      entities: data.entities || {},
      processing: {
        codexDirty: !!data.processing?.codexDirty,
        relationshipDirty: !!data.processing?.relationshipDirty,
        pendingGodlogs: pendingGodlogRows(data).length,
        pendingAnchors: pendingAnchorMaterials(data).length,
        lastError: data.processing?.lastError || '',
      },
    });
  };
  globalThis.AnchorMemory = Object.freeze({
    version: EXTENSION_VERSION,
    open: openWorkbench,
    getStatus: () => statusText(memoryData()),
    getSnapshot: readonlySnapshot,
    getPromptPreview: async () => buildPromptReadyInjection(getContext().chat || []),
    getMemoryBudget: () => clonePlainObject(state.lastMemoryBudget || {}),
    getTimelineWarnings: () => clonePlainObject(memoryData().timeline?.warnings || []),
    cancelBackgroundRequests: () => state.requests.abortAll('public-api-cancel'),
  });
}

function navInsertionTarget() {
  const extensionDrawer = $('#extensions-settings-button').first();
  if (extensionDrawer.length) return { mode: 'after', element: extensionDrawer };

  const extensionAnchor = $('#extensionsMenu, #extensionsMenuButton').filter(':visible').first();
  if (extensionAnchor.length) return { mode: 'after', element: extensionAnchor };

  const container = $('#top-settings-holder').filter(':visible').first();
  if (container.length) return { mode: 'append', element: container };

  const hiddenExtensionAnchor = $('#extensionsMenu, #extensionsMenuButton').first();
  if (hiddenExtensionAnchor.length) return { mode: 'after', element: hiddenExtensionAnchor };

  return null;
}

function installNavbarEntry(attempt = 0) {
  if ($('#anchor_memory_nav_button').length) return true;
  const target = navInsertionTarget();
  if (!target) {
    if (attempt < 30) setTimeout(() => installNavbarEntry(attempt + 1), 500);
    else console.warn('[AnchorMemory] navbar container not found; workbench entry was not installed');
    return false;
  }

  const button = $(`
    <div id="anchor_memory_nav_button" class="am-navbar-button menu_button interactable" title="锚点书" tabindex="0" role="button" aria-label="打开锚点书">
      <span class="am-navbar-letter" aria-hidden="true">a</span>
    </div>
  `);
  button.on('click', openWorkbench);
  button.on('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openWorkbench();
    }
  });

  if (target.mode === 'after') target.element.after(button);
  else target.element.append(button);
  return true;
}

function loadUi() {
  const s = settings();
  $('#am_enabled').prop('checked', !!s.enabled);
  $('#am_anchor_interval').val(s.anchorInterval);
  $('#am_merge_interval').val(s.mergeInterval);
  $('#am_keep_recent').val(s.keepRecent);
  $('#am_injection_depth').val(s.injectionDepth);
  $('#am_adaptive_token_budget').prop('checked', !!s.adaptiveTokenBudget);
  $('#am_memory_max_tokens').val(s.memoryMaxTokens);
  $('#am_memory_reserve_tokens').val(s.memoryReserveTokens);
  $('#am_auto_hide').prop('checked', !!s.autoHide);
  $('#am_use_dynamic_recall').prop('checked', !!s.useDynamicRecall);
  $('#am_recall_mentioned_people').prop('checked', !!s.recallMentionedPeople);
  $('#am_inject_important_items').prop('checked', !!s.injectImportantItems);
  $('#am_use_secondary').prop('checked', !!s.useSecondary);
  $('#am_secondary_url').val(s.secondaryUrl);
  $('#am_secondary_key').val(s.secondaryKey);
  $('#am_secondary_model').val(s.secondaryModel);
  renderModelOptions('#am_secondary_model_options', s.secondaryModels || []);
  $('#am_use_embedding').prop('checked', !!s.useEmbedding);
  $('#am_embedding_url').val(s.embeddingUrl);
  $('#am_embedding_key').val(s.embeddingKey);
  $('#am_embedding_model').val(s.embeddingModel);
  renderModelOptions('#am_embedding_model_options', s.embeddingModels || []);
  $('#am_embedding_dimensions').val(s.embeddingDimensions);
  $('#am_embedding_dimensions_mode').val(s.embeddingDimensionsMode || 'auto');
  $('#am_embedding_top_k').val(s.embeddingTopK);
  $('#am_godlog_rules').val(s.godlogRules || DEFAULT_GODLOG_RULES);
  $('#am_anchor_rules').val(s.anchorRules || DEFAULT_ANCHOR_RULES);
  $('#am_merge_rules').val(s.mergeRules || DEFAULT_MERGE_RULES);
  $('#am_character_rules').val(s.characterRules || DEFAULT_CHARACTER_RULES);
  $('#am_people_rules').val(s.peopleRules || DEFAULT_PEOPLE_RULES);
  $('#am_item_rules').val(s.itemRules || DEFAULT_ITEM_RULES);
  $('#am_godlog_format').val(renderTemplate(GODLOG_FORMAT_HELP));
  $('#am_anchor_format').val(renderTemplate(ANCHOR_FORMAT_HELP));
  $('#am_merge_format').val(renderTemplate(MERGE_FORMAT_HELP));
  $('#am_secondary_fields').show();
  $('#am_embedding_fields').show();
  safeUpdatePreview('加载面板');
}

function activateTab(tab) {
  $('.anchor-memory-settings .am-tab').removeClass('active');
  $(`.anchor-memory-settings .am-tab[data-tab="${tab}"]`).addClass('active');
  $('.anchor-memory-settings .am-tab-panel').removeClass('active');
  $(`.anchor-memory-settings .am-tab-panel[data-panel="${tab}"]`).addClass('active');
}

function bindUi() {
  $('.anchor-memory-settings .am-tab').on('click', function () {
    activateTab($(this).data('tab'));
  });

  $('#am_enabled').on('change', function () {
    saveSetting('enabled', this.checked);
    reconcileStrictRecentWindow('插件启用状态已变化').catch(console.warn);
    injectMemory().catch(console.warn);
  });
  $('#am_anchor_interval').on('change', function () { saveSetting('anchorInterval', Math.max(5, Number(this.value) || 15)); });
  $('#am_merge_interval').on('change', function () { saveSetting('mergeInterval', Math.max(30, Number(this.value) || 100)); });
  $('#am_keep_recent').on('change', function () {
    saveSetting('keepRecent', Math.max(1, Number(this.value) || 3));
    reconcileStrictRecentWindow('保留轮数设置已变化').catch(console.warn);
  });
  $('#am_injection_depth').on('change', function () { saveSetting('injectionDepth', normalizedInjectionDepth(this.value)); });
  $('#am_adaptive_token_budget').on('change', function () { saveSetting('adaptiveTokenBudget', this.checked); injectMemory().catch(console.warn); });
  $('#am_memory_max_tokens').on('change', function () { saveSetting('memoryMaxTokens', Math.max(1200, Math.min(32000, Number(this.value) || 8000))); injectMemory().catch(console.warn); });
  $('#am_memory_reserve_tokens').on('change', function () { saveSetting('memoryReserveTokens', Math.max(600, Math.min(16000, Number(this.value) || 1400))); injectMemory().catch(console.warn); });
  $('#am_auto_hide').on('change', function () { saveSetting('autoHide', this.checked); reconcileStrictRecentWindow('自动隐藏设置已变化').catch(console.warn); });
  $('#am_use_dynamic_recall').on('change', function () {
    saveSetting('useDynamicRecall', this.checked);
    saveSetting('dynamicRecallExplicit', true);
    clearRecallPrefetch();
    prepareDynamicRecall().catch(console.warn);
    injectMemory().catch(console.warn);
  });
  $('#am_recall_mentioned_people').on('change', function () { saveSetting('recallMentionedPeople', this.checked); injectMemory().catch(console.warn); });
  $('#am_inject_important_items').on('change', function () { saveSetting('injectImportantItems', this.checked); injectMemory().catch(console.warn); });
  $('#am_use_secondary').on('change', function () {
    saveSetting('useSecondary', this.checked);
  });
  $('#am_secondary_url').on('change', function () { saveSetting('secondaryUrl', this.value.trim()); });
  $('#am_secondary_key').on('change', function () { saveSetting('secondaryKey', this.value.trim()); });
  $('#am_secondary_model').on('change', function () { saveSetting('secondaryModel', this.value.trim()); });
  $('#am_fetch_secondary_models').on('click', fetchSecondaryModels);
  $('#am_use_embedding').on('change', function () {
    saveSetting('useEmbedding', this.checked);
    clearRecallPrefetch();
    prepareDynamicRecall().catch(console.warn);
  });
  $('#am_embedding_url').on('change', function () { saveSetting('embeddingUrl', this.value.trim()); });
  $('#am_embedding_key').on('change', function () { saveSetting('embeddingKey', this.value.trim()); });
  $('#am_embedding_model').on('change', function () { saveSetting('embeddingModel', this.value.trim()); clearRecallPrefetch(); });
  $('#am_embedding_dimensions').on('change', function () { saveSetting('embeddingDimensions', Math.max(64, Number(this.value) || 256)); });
  $('#am_embedding_dimensions_mode').on('change', function () { saveSetting('embeddingDimensionsMode', this.value || 'auto'); });
  $('#am_embedding_top_k').on('change', function () { saveSetting('embeddingTopK', Math.max(1, Number(this.value) || 3)); });
  $('#am_fetch_embedding_models').on('click', fetchEmbeddingModels);
  $('#am_apply_siliconflow_embedding').on('click', applySiliconFlowEmbeddingPreset);
  $('#am_force_anchor').on('click', () => createAnchor(true));
  $('#am_force_merge').on('click', () => maybeMerge(true));
  $('#am_batch_init').on('click', batchInitializeHistory);
  $('#am_health_check').on('click', () => {
    const result = repairHealth();
    toastr?.info?.(`体检完成：清理孤儿锚定标记 ${result.removedAnchoredKeys} 条，孤儿向量 ${result.removedVectors} 条`, 'Anchor Memory');
  });
  $('#am_open_api_settings').on('click', () => activateTab('settings'));
  $('#am_refresh_view').on('click', updatePreview);
  $('#am_godlog_search').on('input', () => { state.godlogPage = 0; renderGodlogList(); });
  $('#am_godlog_list').on('click', '.am-godlog-prev', function () {
    state.godlogPage = Math.max(0, state.godlogPage - 1);
    renderGodlogList();
  });
  $('#am_godlog_list').on('click', '.am-godlog-next', function () {
    state.godlogPage += 1;
    renderGodlogList();
  });
  $('#am_godlog_list').on('click', '.am-godlog-card', function () {
    const id = $(this).data('godlog-id');
    state.selectedGodlogId = id;
    const item = (memoryData().godlogs || []).find(entry => entry.id === id);
    const syntheticRow = rowFromSyntheticGodlogId(id);
    $('#am_godlog_detail').val(item?.body || item?.error || (syntheticRow ? `第 ${syntheticRow.index + 1} 楼尚未生成逐楼摘要。请点“重跑本楼摘要”或“自动补写缺失摘要”，插件会调用模型自动补写。` : ''));
  });
  $('#am_godlog_list').on('click', '.am-rerun-godlog', async function (event) {
    event.stopPropagation();
    state.selectedGodlogId = $(this).data('godlog-id');
    await rerunSelectedGodlog();
  });
  $('#am_save_selected_godlog').on('click', saveSelectedGodlog);
  $('#am_rerun_selected_godlog').on('click', rerunSelectedGodlog);
  $('#am_delete_selected_godlog').on('click', deleteSelectedGodlog);
  $('#am_generate_missing_godlogs').on('click', async () => {
    await repairMissingGodlogs(Number.MAX_SAFE_INTEGER);
    updatePreview();
  });
  $('#am_timeline_search').on('input', renderTimelineList);
  $('#am_clear_recall_selection').on('click', () => {
    state.selectedRecallMessageKey = '';
    updatePreview();
  });
  $('#am_new_anchor_list, #am_old_anchor_list, #am_timeline_list').on('click', '.am-memory-card', function () {
    const id = $(this).data('memory-id');
    state.selectedMemoryId = id;
    const data = memoryData();
    const item = [...data.anchors, ...data.merges].find(entry => entry.id === id);
    $('#am_timeline_detail').val(item?.body || '');
  });
  $('#am_save_selected_memory').on('click', saveSelectedMemory);
  $('#am_delete_selected_memory').on('click', deleteSelectedMemory);
  $('#am_rebuild_codex').on('click', rebuildCodexFromGodlogs);
  $('#am_restore_codex_backup').on('click', () => restoreCodexBackup(memoryData(), true));
  $('#am_add_relationship_row').on('click', addRelationshipRow);
  $('#am_save_relationship_rows').on('click', saveRelationshipNames);
  $('#am_rebuild_relationship').on('click', rebuildRelationshipFromGodlogs);
  $('#am_relationship_new_name').on('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addRelationshipRow();
    }
  });
  $('#am_relationship_rows').on('click', '.am-delete-relationship-row', function () {
    deleteRelationshipRow(String($(this).closest('tr').data('relationship-id') || ''));
  });
  $('#am_rebuild_vectors').on('click', rebuildVectors);
  $('#am_test_embedding').on('click', testEmbedding);
  $('#am_test_secondary').on('click', testSecondary);
  $('#am_save_archive').on('click', saveArchive);
  $('#am_archive_cards').on('click', '.am-load-archive', function () { loadArchive($(this).data('archive')); });
  $('#am_archive_cards').on('click', '.am-delete-archive', function () { deleteArchive($(this).data('archive')); });
  $('#am_save_tracked_characters').on('click', saveTrackedCharacterSettings);
  $('#am_save_character_edits').on('click', saveCharacterEdits);
  $('#am_save_item_edits').on('click', saveItemEdits);
  $('#am_save_scene_edits').on('click', saveSceneEdits);
  $('#am_export_data').on('click', exportData);
  $('#am_import_data').on('click', importData);
  $('#am_export_config').on('click', exportConfig);
  $('#am_import_config').on('click', importConfig);
  $('#am_reset_memory').on('click', resetCurrentMemory);
  $('#am_save_prompts').on('click', () => {
    saveSetting('godlogRules', $('#am_godlog_rules').val().trim() || DEFAULT_GODLOG_RULES);
    saveSetting('anchorRules', $('#am_anchor_rules').val().trim() || DEFAULT_ANCHOR_RULES);
    saveSetting('mergeRules', $('#am_merge_rules').val().trim() || DEFAULT_MERGE_RULES);
    saveSetting('characterRules', $('#am_character_rules').val().trim() || DEFAULT_CHARACTER_RULES);
    saveSetting('peopleRules', $('#am_people_rules').val().trim() || DEFAULT_PEOPLE_RULES);
    saveSetting('itemRules', $('#am_item_rules').val().trim() || DEFAULT_ITEM_RULES);
    toastr?.success?.('提示词规则已保存', 'Anchor Memory');
  });
  $('#am_apply_prompt_preset').on('click', () => {
    const preset = promptPreset($('#am_prompt_preset').val());
    $('#am_godlog_rules').val(preset.godlog);
    $('#am_anchor_rules').val(preset.anchor);
    $('#am_merge_rules').val(preset.merge);
    $('#am_character_rules').val(preset.character);
    $('#am_people_rules').val(preset.people);
    $('#am_item_rules').val(preset.item);
    toastr?.info?.('预设已填入，确认后点“保存提示词”', 'Anchor Memory');
  });
  $('#am_reset_prompts').on('click', () => {
    saveSetting('godlogRules', DEFAULT_GODLOG_RULES);
    saveSetting('anchorRules', DEFAULT_ANCHOR_RULES);
    saveSetting('mergeRules', DEFAULT_MERGE_RULES);
    saveSetting('characterRules', DEFAULT_CHARACTER_RULES);
    saveSetting('peopleRules', DEFAULT_PEOPLE_RULES);
    saveSetting('itemRules', DEFAULT_ITEM_RULES);
    $('#am_godlog_rules').val(DEFAULT_GODLOG_RULES);
    $('#am_anchor_rules').val(DEFAULT_ANCHOR_RULES);
    $('#am_merge_rules').val(DEFAULT_MERGE_RULES);
    $('#am_character_rules').val(DEFAULT_CHARACTER_RULES);
    $('#am_people_rules').val(DEFAULT_PEOPLE_RULES);
    $('#am_item_rules').val(DEFAULT_ITEM_RULES);
    toastr?.success?.('已恢复默认提示词规则', 'Anchor Memory');
  });
  $('#am_close_workbench').on('click', closeWorkbench);
  $('#anchor_memory_workbench').on('click', '[data-am-close="1"]', closeWorkbench);
  $(document).on('keydown.anchorMemoryWorkbench', event => {
    if (event.key === 'Escape' && $('#anchor_memory_workbench').hasClass('open')) closeWorkbench();
  });

  $(document)
    .off('click.anchorMemoryGodlogPanel')
    .on('click.anchorMemoryGodlogPanel', '.am-message-godlog-toggle', function () {
      const panel = $(this).closest('.am-message-godlog-panel');
      const body = panel.find('.am-message-godlog-body').first();
      const hidden = body.prop('hidden');
      body.prop('hidden', !hidden);
      panel.toggleClass('open', hidden);
    })
    .on('click.anchorMemoryGodlogPanel', '.am-message-godlog-open', function (event) {
      event.stopPropagation();
      const id = $(this).closest('.am-message-godlog-panel').data('godlog-id');
      showGodlogInWorkbench(String(id || ''));
    })
    .on('click.anchorMemoryGodlogPanel', '.am-message-godlog-rerun', async function (event) {
      event.stopPropagation();
      const id = $(this).closest('.am-message-godlog-panel').data('godlog-id');
      await rerunGodlogFromPanel(String(id || ''));
    })
    .on('click.anchorMemoryGodlogPanel', '.am-message-memory-badge', function (event) {
      event.stopPropagation();
      showRecallRecordInWorkbench(String($(this).data('message-key') || ''));
    });
}

function restoreCurrentChatState(reason = '切换聊天') {
  if (!hasPersistentChatContext()) return false;
  syncGodlogsWithChat(reason);
  safeUpdatePreview(reason);
  installNavbarEntry();
  scheduleGodlogPanelRender();
  injectMemory().catch(err => console.warn('[AnchorMemory] inject failed', err));
  return true;
}

function scheduleRestoreCurrentChatState(reason = '切换聊天', attempts = 20) {
  if (state.restoreTimer) clearTimeout(state.restoreTimer);
  const tryRestore = remaining => {
    state.restoreTimer = null;
    if (restoreCurrentChatState(reason)) return;
    if (remaining <= 1) {
      console.warn('[AnchorMemory] chat metadata was not ready; waiting for next CHAT_CHANGED event');
      return;
    }
    state.restoreTimer = setTimeout(() => tryRestore(remaining - 1), 100);
  };
  tryRestore(attempts);
}

function eventMessageIndex(payload) {
  const value = typeof payload === 'object' && payload !== null
    ? (payload.messageId ?? payload.message_id ?? payload.mesid ?? payload.index ?? payload.id)
    : payload;
  const index = Number(value);
  return Number.isInteger(index) ? index : null;
}

function onStreamTokenReceived() {
  // STREAM_TOKEN_RECEIVED fires once per streamed token. The old implementation cleared the whole
  // chat cache and rebuilt every historical row for every token, making cost grow with chat length.
  // Keep this path tail-only and throttled; full reconciliation still runs on MESSAGE_RECEIVED /
  // GENERATION_ENDED, where it belongs.
  if (!isGenerationActive() && !state.generationLifecycleActive) return;
  const now = Date.now();
  const wasActive = state.generationLifecycleActive;
  state.generationLifecycleActive = true;
  state.lastStreamTokenAt = now;
  state.latestRowChangedAt = now;
  if (!wasActive) state.generationStartedAt = now;
  if (state.latestRowKey) cancelSettleTimer({ key: state.latestRowKey });
  if (state.streamProbeTimer) return;

  state.streamProbeTimer = setTimeout(() => {
    state.streamProbeTimer = null;
    const latest = latestAssistantTailProbe();
    if (!latest) return;
    const revision = noteRowRevision(latest, false);
    state.latestRowKey = latest.key;
    state.latestRowHash = latest.rawHash;
    state.latestRowChangedAt = Math.max(state.lastStreamTokenAt || 0, revision?.changedAt || 0, Date.now());
    cancelSettleTimer(latest);
  }, STREAM_TAIL_PROBE_MS);
}

function onMessageReceived() {
  if (state.streamProbeTimer) clearTimeout(state.streamProbeTimer);
  state.streamProbeTimer = null;
  invalidateRuntimeCaches('message received');
  observeLatestAssistantRow(true);
  scheduleMemoryAfterSettle('AI消息完整写入后处理');
}

function onLatestMessageRendered(payload) {
  const index = eventMessageIndex(payload);
  if (index === null) return;
  const latest = latestAssistantRow();
  if (!latest || latest.index !== index) return;
  const previousHash = state.latestRowHash;
  observeLatestAssistantRow(false);
  const data = memoryData();
  const item = godlogForRow(data, latest);
  if ((previousHash && previousHash !== latest.rawHash) || (item?.rawHash && item.rawHash !== latest.rawHash)) {
    onChatMutated('当前楼渲染内容已更新');
    return;
  }
  scheduleAnchorCheck();
}

function onChatChanged() {
  state.requests.abortAll('chat-changed');
  state.contextEpoch += 1;
  state.running = false;
  state.anchorPreparing = false;
  state.mergeRunning = false;
  state.summaryRunning = false;
  state.codexRunning = false;
  state.jobRunning = false;
  state.activeSummaryRowKey = '';
  invalidateMemoryDataCache();
  invalidateRuntimeCaches('chat changed');
  if (state.queueTimer) clearTimeout(state.queueTimer);
  if (state.jobTimer) clearTimeout(state.jobTimer);
  if (state.restoreTimer) clearTimeout(state.restoreTimer);
  if (state.mutationTimer) clearTimeout(state.mutationTimer);
  if (state.streamProbeTimer) clearTimeout(state.streamProbeTimer);
  if (state.panelRenderTimer) clearTimeout(state.panelRenderTimer);
  if (state.messageKeySaveTimer) clearTimeout(state.messageKeySaveTimer);
  if (state.visibleRenderTimer) cancelAnimationFrame(state.visibleRenderTimer);
  clearAllSettleTimers();
  state.queueTimer = null;
  state.jobTimer = null;
  state.restoreTimer = null;
  state.mutationTimer = null;
  state.streamProbeTimer = null;
  state.panelRenderTimer = null;
  state.messageKeySaveTimer = null;
  state.visibleRenderTimer = null;
  state.panelRenderAll = false;
  state.panelRenderTargets.clear();
  state.panelRenderAttempt = 0;
  state.latestRowKey = '';
  state.latestRowHash = '';
  state.latestRowChangedAt = 0;
  state.generationLifecycleActive = false;
  state.generationStartedAt = 0;
  state.generationEndedAt = 0;
  state.rowRevisionState.clear();
  state.jobSources.clear();
  state.selectedRecallMessageKey = '';
  state.lastInjectionRefs = [];
  state.pendingInjectionContent = '';
  state.vectorCache.clear();
  clearRecallPrefetch();
  setExtensionPrompt(CORE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
  setExtensionPrompt(RECALL_PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0);
  state.lastRecall = '';
  state.lastRecentFacts = '';
  state.lastPromptInjection = '';

  // CHAT_CHANGED can be emitted before chatMetadata is fully restored.
  // Defer one task so we read the persisted object instead of creating and
  // mutating a throw-away default object.
  scheduleRestoreCurrentChatState('切换聊天');
}

function onChatMutated(reason) {
  invalidateRuntimeCaches(reason || 'chat mutated');
  // Swipe/edit/delete events can fire before SillyTavern has committed the new message object.
  // Debounce to the next settled state so the old summary is removed from metadata and UI reliably.
  if (state.mutationTimer) clearTimeout(state.mutationTimer);
  state.mutationTimer = setTimeout(() => {
    state.mutationTimer = null;
    observeLatestAssistantRow(false);
    syncGodlogsWithChat(reason);
    const latest = latestAssistantRow();
    if (latest && !isRowSettledForGodlog(latest)) scheduleMemoryAfterSettle(reason, latest);
    else queueMemoryJob(reason, 120);
    updatePreview();
    scheduleGodlogPanelRender();
  }, 120);
}

window.anchorMemory_onGenerate = async (chat, contextSize, abort, type) => {
  if (type === 'quiet') return;
  if (Number.isFinite(Number(contextSize)) && Number(contextSize) > 0) state.lastContextSize = Number(contextSize);
  // This interceptor is the last backend-independent guard before prompt construction.
  await reconcileStrictRecentWindow('generate interceptor');
  await injectMemory(chat || []);
  if (Array.isArray(chat)) {
    const contextChat = getContext().chat || [];
    // Always apply the cap here as well. CHAT_COMPLETION_PROMPT_READY is a second final-array guard,
    // not a reason to skip text-completion or backend-specific generation paths.
    applyGodlogContextReplacement(chat, {
      mode: 'generate-interceptor-history-hide',
      prune: chat !== contextChat,
    });
  }
};

async function bootstrapAnchorMemory() {
  $ = globalThis.jQuery || globalThis.$ || $;
  if (globalThis.__anchorMemoryBootstrapped) return;
  globalThis.__anchorMemoryBootstrapped = true;

  await loadLegacyRuntimeFallbacks();
  refreshRuntimeBindings();

  if (!$) {
    globalThis.__anchorMemoryBootstrapped = false;
    console.error('[AnchorMemory] jQuery is not ready; retrying initialization.');
    setTimeout(bootstrapAnchorMemory, 500);
    return;
  }

  installExtensionSettingsEntry();
  const settingsUrl = new URL('./settings.html', import.meta.url);
  // Put the launcher on screen before loading the workbench template. A missing/slow template
  // must not make the entire extension look absent.
  try {
    installNavbarEntry();
  } catch (err) {
    console.error('[AnchorMemory] early navbar install failed', err);
  }
  try {
    const response = await fetch(settingsUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status} while loading settings.html`);
    const html = await response.text();
    if (!$('#anchor_memory_workbench').length) $('body').append(html);
  } catch (err) {
    console.warn('[AnchorMemory] failed to load settings', err);
  }

  try {
    loadUi();
  } catch (err) {
    console.error('[AnchorMemory] loadUi failed', err);
  }
  try {
    bindUi();
  } catch (err) {
    console.error('[AnchorMemory] bindUi failed', err);
  }
  bindLazyMessageRendering();
  installPublicApi();
  installNavbarEntry();
  installExtensionSettingsEntry();
  try {
    scheduleRestoreCurrentChatState('插件启动同步');
  } catch (err) {
    console.error('[AnchorMemory] startup sync failed', err);
  }

  registerEventHandlers(['CHAT_CHANGED'], onChatChanged);
  // Anchor summaries are created for assistant turns. Do not listen to the
  // generic MESSAGE_RENDERED event: it fires for every historical floor on a
  // refresh and was the main cause of false regeneration jobs.
  registerEventHandlers(['USER_MESSAGE_RENDERED'], onUserMessageRendered);
  registerEventHandlers(['GENERATION_AFTER_COMMANDS'], onGenerationAfterCommands);
  registerEventHandlers(['GENERATION_STARTED'], onGenerationStarted);
  registerEventHandlers(['STREAM_TOKEN_RECEIVED'], onStreamTokenReceived);
  registerEventHandlers(['MESSAGE_RECEIVED'], onMessageReceived);
  registerEventHandlers(['GENERATION_ENDED'], () => onGenerationFinished('AI生成结束'));
  registerEventHandlers(['GENERATION_STOPPED'], () => onGenerationFinished('AI生成停止'));
  registerEventHandlers(['CHARACTER_MESSAGE_RENDERED'], scheduleAnchorCheck, 'makeLast');
  registerEventHandlers(['MESSAGE_RENDERED'], onLatestMessageRendered);
  registerEventHandlers(['CHAT_COMPLETION_PROMPT_READY'], injectMemoryIntoPromptReady);
  registerEventHandlers(['CHARACTER_MESSAGE_RENDERED', 'MESSAGE_RENDERED'], scheduleGodlogPanelRender);
  registerEventHandlers(['MESSAGE_DELETED'], () => onChatMutated('楼层已删除'));
  registerEventHandlers(['MESSAGE_UPDATED', 'MESSAGE_EDITED'], () => onChatMutated('楼层已编辑'));
  registerEventHandlers(['MESSAGE_SWIPED'], messageId => {
    onChatMutated('楼层已切换swipe');
    scheduleGodlogPanelRender(messageId);
  });
  registerEventHandlers(['TOOL_CALLS_RENDERED'], () => onChatMutated('工具调用内容已写入当前楼'));

  if (hasPersistentChatContext()) {
    injectMemory().catch(err => console.warn('[AnchorMemory] initial inject failed', err));
  }
  scheduleGodlogPanelRender();
  window.addEventListener('pagehide', () => { state.requests.abortAll('pagehide'); saveMetadataDebounced(); flushMemoryNow(); }, { once: false });
  console.info('[AnchorMemory] loaded', EXTENSION_VERSION);
}

export async function onActivate() {
  await bootstrapAnchorMemory();
}

function scheduleBootstrap() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapAnchorMemory, { once: true });
  } else {
    queueMicrotask(bootstrapAnchorMemory);
  }
}

scheduleBootstrap();
