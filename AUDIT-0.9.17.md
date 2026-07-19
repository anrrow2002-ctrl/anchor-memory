# Anchor Memory 0.9.17 Audit

## Scope

Secondary API named preset management was added on top of the complete 0.9.16 codebase. Chat-memory data version remains 12.

## Storage and security behavior

- Presets live in SillyTavern extension settings and are global across chats/characters.
- A preset stores its display name, URL, API key, selected model, and fetched model IDs.
- Existing Anchor Memory already persisted the active secondary API key in the same settings store; presets use the same persistence boundary.
- Generic configuration export/import excludes `secondaryKey`, `secondaryPresets`, and `activeSecondaryPresetId`, so named presets and credentials are not copied into the export box.

## Switching behavior

- Loading a preset restores the full connection immediately without a model-list request.
- Switching advances a secondary-connection revision. Any model-list request started under an older URL/key is ignored when it returns and cannot clear or overwrite the newly selected preset.
- Active summary/index writers are not aborted merely because the connection changes; their already-started result remains valid for the same chat facts, avoiding false failed-summary or dirty-index states. Future requests use the selected preset.
- Recall prefetch is cleared, and background memory work is requeued only when the selected preset is complete and secondary processing is enabled.

## Editing behavior

- Manual URL/key edits still clear the selected model and fetched list, preventing stale model IDs from crossing providers.
- A loaded preset is not silently mutated by field edits or a new model pull. The UI marks it as having unsaved changes until the user explicitly overwrites it.
- Duplicate preset names require explicit overwrite confirmation.
- Deleting a preset leaves the current input fields intact.

## Migration

0.9.16 settings gain an empty preset list and active preset ID. Invalid, duplicate, unnamed, or oversized legacy records are normalized away without touching active API fields or any chat memory.
