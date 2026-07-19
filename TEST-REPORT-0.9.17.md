# Anchor Memory 0.9.17 Test Report

## Build checks

- `node --check index.js`: passed.
- `manifest.json` version and runtime version: `0.9.17`.
- Chat memory data version: unchanged at `12`.
- `settings.html`: 134 unique element IDs; no duplicate IDs.

## Preset-specific tests

- Preset name cleanup and length limit.
- Invalid/unnamed preset removal.
- Case-insensitive duplicate-name removal.
- URL/model trimming.
- Model-list de-duplication and 500-model cap.
- Global preset count cap of 50.
- Create/update/delete handlers and UI controls present.
- URL, key, selected model, and model list are restored by preset switching.
- Generic config export/import excludes `secondaryKey`, `secondaryPresets`, and `activeSecondaryPresetId`.
- Loaded preset dirty-state indicator is present.
- Mobile preset actions use a one-column layout.

## Async race test

A delayed model-list request was started using an old URL/key. Before it resolved, the simulated user switched to a new preset. The old request then returned successfully. Result:

- New preset URL/key/model remained unchanged.
- Old model list was ignored.
- No false success or error toast was emitted for the stale request.
- No current model field was cleared.

## Historical regression suite

The complete bundled test suite from 0.9.2 through 0.9.17 was rerun.

- 90-turn memory continuity: no gaps.
- Delayed and permanently missing Godlog fallback scenarios: no prompt-boundary gaps.
- 1,200 prompt injection cycles: 0 failures.
- 700 randomized long-chat continuity scenarios: 0 gaps across 157,567 prompt boundaries.
- 1,500 dynamic recall timing cycles: 0 late-result coverage errors.
- 300 master-toggle cycles, 400 generation-pause races, and 300 hidden-state races: 0 data loss, stale prompts, or managed hidden rows left behind.
- 2,000 trailing rebuild scenarios and 1,976 historical interior-gap scenarios: passed.
- 3,000 transient message replacement scenarios: passed.
- 2,500 cumulative merge scenarios: passed.
- 5,000 anchor/merge dependency rollback scenarios: passed.
- Archive final merge, summary validation, staged entity rebuild, timeout classification, and secondary response parsing tests: passed.

The full console output is stored in `TEST-OUTPUT-0.9.17.log`.
