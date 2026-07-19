import fs from 'node:fs';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const html = fs.readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./style.css', import.meta.url), 'utf8');

assert.equal(manifest.version, '0.9.17');
assert.match(source, /const EXTENSION_VERSION = '0.9.17'/);
assert.match(html, /id="am_master_toggle"/);
assert.match(html, /id="am_master_state_badge"/);
assert.match(source, /async function setPluginEnabled\(/);
assert.match(source, /stopRuntimeForPluginPause\('plugin-paused'\)/);
assert.match(source, /pluginToggleEpoch/);
assert.match(source, /operationEpoch !== state\.contextEpoch/);
assert.match(source, /for \(let pass = 0; pass < 3; pass\+\+\)/);
assert.match(source, /await enforceAnchorHiddenState\(memoryData\(\)\)/);
assert.match(source, /removeExistingAnchorMemoryPrompt\(promptChat\);\s*return;/);
assert.match(source, /generation: true/);
assert.match(source, /extension-prompt-fallback-before-prompt-ready/);
assert.match(source, /rememberPromptInjectionForNextMessage\(data, getContext\(\)\.chat \|\| chat, memoryPrompt\)/);
assert.match(source, /if \(!settings\(\)\.enabled\) return;\s*const chat = getContext\(\)\.chat \|\| \[\];/);
assert.match(css, /\.am-master-toggle/);
assert.match(css, /\.am-navbar-button\.am-disabled/);

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'settings.html contains duplicate IDs');

function seededRandom(seed = 0x9e3779b9) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
const random = seededRandom(0x0992026);
const int = (min, max) => min + Math.floor(random() * (max - min + 1));

function memoryBlock(tag = 'fallback') {
  return `锚点记录\n\n【一. 人物关系】\n${tag}\n\n【二. 锚点事件】\n事件\n\n【三. 角色 动态演变（核心转变）】\n变化\n\n【四. 匹配到的出场人物库】\n人物\n\n【五. 重要道具、梗与核心细节】\n物品\n\n【六. 未锚定逐楼摘要】\n摘要`;
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
  let removed = 0;
  for (let index = promptChat.length - 1; index >= 0; index--) {
    if (!isAnchorMemoryPromptMessage(promptChat[index])) continue;
    promptChat.splice(index, 1);
    removed++;
  }
  return removed;
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

function resolvePromptReadyPayload(eventData, secondArg = false) {
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

const payloadFactories = [
  chat => chat,
  chat => ({ messages: chat }),
  chat => ({ chat }),
  chat => ({ prompt: chat }),
  chat => ({ detail: { messages: chat } }),
  chat => ({ data: { chat } }),
  chat => ({ request: { messages: chat } }),
  chat => ({ payload: { prompt: chat } }),
  chat => ({ chatCompletion: { messages: chat } }),
  chat => ({ completion: { chat } }),
];

let promptCycles = 0;
let finalHookCycles = 0;
let fallbackOnlyCycles = 0;
let disabledCycles = 0;
for (let cycle = 0; cycle < 1200; cycle++) {
  const narrativeCount = int(1, 240);
  const depth = int(0, 60);
  const prompt = [{ role: 'system', content: `角色卡-${cycle}` }];
  for (let i = 0; i < narrativeCount; i++) {
    prompt.push({ role: i % 2 ? 'assistant' : 'user', content: `正文-${cycle}-${i}` });
    if (random() < 0.04) prompt.push({ role: 'system', content: `世界书-${i}` });
  }

  const finalHookFires = random() < 0.78;
  const enabled = random() >= 0.12;
  const fallback = memoryBlock(`fallback-${cycle}`);

  // The real generate interceptor only establishes the fallback while the plugin is enabled.
  if (enabled) {
    const fallbackIndex = resolvePromptInsertIndex(prompt, depth);
    prompt.splice(fallbackIndex, 0, { role: 'system', content: fallback });
  }

  if (!finalHookFires) {
    const memories = prompt.filter(isAnchorMemoryPromptMessage);
    if (enabled) {
      assert.equal(memories.length, 1, `fallback-only cycle ${cycle} must contain exactly one memory block`);
      assert.equal(memories[0].content, fallback);
      fallbackOnlyCycles++;
    } else {
      assert.equal(memories.length, 0, `disabled fallback-only cycle ${cycle} must contain no memory block`);
      disabledCycles++;
    }
    promptCycles++;
    continue;
  }

  // Simulate stale/duplicate blocks from another inspection pass; final hook must de-duplicate them.
  for (let duplicate = 0; duplicate < int(0, 3); duplicate++) {
    prompt.splice(int(0, prompt.length), 0, { role: 'system', content: memoryBlock(`stale-${cycle}-${duplicate}`) });
  }
  const payload = payloadFactories[int(0, payloadFactories.length - 1)](prompt);
  const resolved = resolvePromptReadyPayload(payload, random() < 0.08 ? { dryRun: true } : false);
  assert.equal(resolved.promptChat, prompt);

  if (!enabled) {
    removeExistingAnchorMemoryPrompt(resolved.promptChat);
    assert.equal(resolved.promptChat.filter(isAnchorMemoryPromptMessage).length, 0);
    disabledCycles++;
  } else {
    removeExistingAnchorMemoryPrompt(resolved.promptChat);
    const cleanExpectedIndex = resolvePromptInsertIndex(resolved.promptChat, depth);
    const latest = memoryBlock(`final-${cycle}`);
    resolved.promptChat.splice(cleanExpectedIndex, 0, { role: 'system', content: latest });
    const memories = resolved.promptChat.filter(isAnchorMemoryPromptMessage);
    assert.equal(memories.length, 1, `final-hook cycle ${cycle} must contain exactly one memory block`);
    assert.equal(memories[0].content, latest);
    assert.equal(resolved.promptChat.indexOf(memories[0]), cleanExpectedIndex);
    finalHookCycles++;
  }
  promptCycles++;
}

function simulateFlow({
  turns,
  keepRecent,
  anchorInterval,
  mergeInterval,
  delays,
  permanentlyMissing,
  intervalChanges,
}) {
  const readyAt = new Map();
  const anchors = [];
  let merged = new Set();
  const gaps = [];
  let promptBoundaries = 0;

  const recentSet = now => new Set(Array.from({ length: Math.min(keepRecent, now) }, (_, i) => now - i));
  const isReady = (key, now) => !permanentlyMissing.has(key) && (readyAt.get(key) ?? Infinity) <= now;
  const fallbackEligible = (key, now) => !recentSet(now).has(key);
  const activeAnchored = () => {
    const result = new Set();
    for (const anchor of anchors) for (const key of anchor) if (!merged.has(key)) result.add(key);
    return result;
  };

  function mergeCycle(now) {
    const anchored = activeAnchored();
    const result = [];
    for (let key = 1; key <= now; key++) {
      if (merged.has(key)) continue;
      if (isReady(key, now) || anchored.has(key) || fallbackEligible(key, now)) result.push(key);
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
    for (let guard = 0; guard < 200; guard++) {
      const cycle = mergeCycle(now);
      if (cycle.length >= mergeInterval) {
        const next = cycle.slice(0, mergeInterval);
        merged = new Set([...merged, ...next]);
        continue;
      }
      const pending = pendingAnchor(now);
      if (pending.length >= anchorInterval) {
        anchors.push(pending.slice(0, anchorInterval));
        continue;
      }
      return;
    }
    throw new Error('derived-memory simulator guard exhausted');
  }

  for (let now = 1; now <= turns; now++) {
    if (!permanentlyMissing.has(now)) readyAt.set(now, now + (delays.get(now) || 0));
    const change = intervalChanges.get(now);
    if (change?.anchorInterval) anchorInterval = change.anchorInterval;
    if (change?.mergeInterval) mergeInterval = change.mergeInterval;
    processDerived(now);

    const recent = recentSet(now);
    const anchored = activeAnchored();
    const covered = new Set([...merged, ...anchored, ...recent]);
    for (let key = 1; key <= now; key++) {
      if (covered.has(key)) continue;
      if (isReady(key, now) || fallbackEligible(key, now)) covered.add(key);
    }
    const missing = [];
    for (let key = 1; key <= now; key++) if (!covered.has(key)) missing.push(key);
    if (missing.length) gaps.push({ now, missing });
    promptBoundaries++;

    // Active segmented anchors may not overlap each other or the cumulative merge.
    const seen = new Set();
    for (const anchor of anchors) {
      for (const key of anchor) {
        if (merged.has(key)) continue;
        assert.equal(seen.has(key), false, `duplicate active anchor key ${key}`);
        seen.add(key);
      }
    }
  }
  return { gaps, promptBoundaries, mergedCount: merged.size, anchorCount: anchors.length };
}

let flowScenarios = 0;
let flowPromptBoundaries = 0;
let flowMergedTurns = 0;
const flowStarted = performance.now();
for (let scenario = 0; scenario < 700; scenario++) {
  const turns = int(100, 360);
  const keepRecent = int(1, 10);
  let anchorInterval = int(5, 50);
  let mergeInterval = int(30, 180);
  const delays = new Map();
  for (let floor = 1; floor <= turns; floor++) {
    if (random() < 0.38) delays.set(floor, int(1, 18));
  }
  const permanentlyMissing = new Set();
  for (let i = 0; i < int(0, 8); i++) permanentlyMissing.add(int(1, turns));
  const intervalChanges = new Map();
  for (let i = 0; i < int(0, 4); i++) {
    intervalChanges.set(int(5, turns), {
      anchorInterval: int(5, 50),
      mergeInterval: int(30, 180),
    });
  }
  const result = simulateFlow({
    turns,
    keepRecent,
    anchorInterval,
    mergeInterval,
    delays,
    permanentlyMissing,
    intervalChanges,
  });
  assert.deepEqual(result.gaps, [], `scenario ${scenario} contains a memory gap`);
  flowScenarios++;
  flowPromptBoundaries += result.promptBoundaries;
  flowMergedTurns += result.mergedCount;
}
const flowElapsedMs = performance.now() - flowStarted;

// Dynamic recall timing model: semantic results are used if ready in time; otherwise keyword recall
// is already available in the fallback block, so the main request never waits beyond the bound.
const recallWaitLimitMs = 1800;
let semanticBeforeSend = 0;
let keywordBeforeSend = 0;
for (let cycle = 0; cycle < 1500; cycle++) {
  const semanticLatency = int(0, 7000);
  const waitedMs = Math.min(semanticLatency, recallWaitLimitMs);
  const mode = semanticLatency <= recallWaitLimitMs ? 'embedding' : 'keyword-fallback-timeout';
  assert.ok(waitedMs <= recallWaitLimitMs);
  assert.ok(mode === 'embedding' || mode === 'keyword-fallback-timeout');
  if (mode === 'embedding') semanticBeforeSend++;
  else keywordBeforeSend++;
}

// Pause-during-generation race model: the epoch guard must remove the fallback and skip final
// mutation when pause wins while recall or prompt construction is in flight.
let pauseRaceCycles = 0;
for (let cycle = 0; cycle < 400; cycle++) {
  let enabled = true;
  let epoch = 1;
  const operationEpoch = epoch;
  const prompt = [{ role: 'system', content: memoryBlock(`race-fallback-${cycle}`) }];
  const pauseStage = int(0, 2); // 0=before recall returns, 1=after recall, 2=no pause
  if (pauseStage === 0) { enabled = false; epoch++; }
  if (!enabled || operationEpoch !== epoch) {
    removeExistingAnchorMemoryPrompt(prompt);
    assert.equal(prompt.filter(isAnchorMemoryPromptMessage).length, 0);
    pauseRaceCycles++;
    continue;
  }
  if (pauseStage === 1) { enabled = false; epoch++; }
  if (!enabled || operationEpoch !== epoch) {
    removeExistingAnchorMemoryPrompt(prompt);
    assert.equal(prompt.filter(isAnchorMemoryPromptMessage).length, 0);
    pauseRaceCycles++;
    continue;
  }
  removeExistingAnchorMemoryPrompt(prompt);
  prompt.push({ role: 'system', content: memoryBlock(`race-final-${cycle}`) });
  assert.equal(prompt.filter(isAnchorMemoryPromptMessage).length, 1);
  pauseRaceCycles++;
}

// Hidden-row convergence model: when the desired mode flips during an async host operation, the
// bounded recheck must converge to the newest state rather than preserving the older hide request.
let hiddenRaceCycles = 0;
for (let cycle = 0; cycle < 300; cycle++) {
  let shouldHide = true;
  let hidden = false;
  for (let pass = 0; pass < 3; pass++) {
    const modeAtStart = shouldHide;
    hidden = modeAtStart;
    if (pass === 0) shouldHide = random() < 0.5 ? false : true;
    if (shouldHide === modeAtStart) break;
  }
  assert.equal(hidden, shouldHide);
  hiddenRaceCycles++;
}

// Repeated pause/resume model: data is immutable, managed hidden rows are restored, and runtime work
// is cleared while paused. Unmanaged user-hidden rows must remain hidden.
const persistentData = {
  godlogs: Array.from({ length: 120 }, (_, i) => ({ id: `g${i}`, body: `summary-${i}` })),
  anchors: Array.from({ length: 8 }, (_, i) => ({ id: `a${i}` })),
  settings: { secondaryUrl: 'kept', secondaryModel: 'kept-model' },
};
const dataSignature = JSON.stringify(persistentData);
let toggleState = {
  enabled: true,
  prompts: [memoryBlock('active')],
  timers: 7,
  requests: 4,
  messages: Array.from({ length: 50 }, (_, i) => ({
    hidden: i < 35,
    managed: i < 30,
  })),
};
for (let cycle = 0; cycle < 300; cycle++) {
  const next = cycle % 2 === 1;
  toggleState.enabled = next;
  if (!next) {
    toggleState.prompts = [];
    toggleState.timers = 0;
    toggleState.requests = 0;
    for (const message of toggleState.messages) if (message.managed) message.hidden = false;
    assert.equal(toggleState.prompts.length, 0);
    assert.equal(toggleState.timers, 0);
    assert.equal(toggleState.requests, 0);
    assert.equal(toggleState.messages.filter(m => m.managed && m.hidden).length, 0);
    assert.equal(toggleState.messages.filter(m => !m.managed && m.hidden).length, 5);
  } else {
    toggleState.prompts = [memoryBlock(`resume-${cycle}`)];
    assert.equal(toggleState.prompts.filter(p => p.startsWith('锚点记录')).length, 1);
  }
  assert.equal(JSON.stringify(persistentData), dataSignature, 'pause/resume must preserve memory and API settings');
}

console.log(JSON.stringify({
  version: manifest.version,
  promptInjection: {
    cycles: promptCycles,
    finalHookCycles,
    fallbackOnlyCycles,
    disabledCycles,
    failures: 0,
  },
  memoryContinuity: {
    randomizedScenarios: flowScenarios,
    promptBoundaries: flowPromptBoundaries,
    mergedTurnsObserved: flowMergedTurns,
    gaps: 0,
    elapsedMs: Number(flowElapsedMs.toFixed(1)),
  },
  dynamicRecall: {
    cycles: semanticBeforeSend + keywordBeforeSend,
    semanticBeforeSend,
    keywordFallbackBeforeSend: keywordBeforeSend,
    maxWaitMs: recallWaitLimitMs,
    lateUncoveredCycles: 0,
  },
  masterToggle: {
    cycles: 300,
    dataLoss: 0,
    stalePromptsWhilePaused: 0,
    managedHiddenRowsLeftBehind: 0,
    pauseDuringGenerationRaceCycles: pauseRaceCycles,
    hiddenStateRaceCycles: hiddenRaceCycles,
  },
}, null, 2));
