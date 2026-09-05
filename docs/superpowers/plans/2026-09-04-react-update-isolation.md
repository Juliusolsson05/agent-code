# React update isolation and shared-store work budget

Refs #781, #763, #103. Independent of the terminal-throughput branch.

## Audit scope

Inventory React/store/context usage across desktop, provider renderers, and the
remote client. Follow high-frequency runtime changes from ingest through the
store, workspace root, panes, surface registry, feed rows, and editor consumers.
Separate proven extra work from architectural candidates that need profiling;
do not equate a missing memo wrapper with a measured performance bug.

The first confirmed defects are in the shared app store (#781): Zustand persist
serializes settings on every workspace/UI update even when the settings object
is unchanged, and workspace setters replace root state when their updater
returns the original slice. Address these before larger pane-subscription work.

## Implementation

- Cache the last successfully persisted settings identity and schema version
  before JSON serialization. Preserve immediate writes for settings changes,
  existing storage format/migration, and retry after storage errors. Invalidate
  the cache on storage reads/removal so rehydrate and clear cannot leave a stale
  successful-write claim. Keep cache ownership local to the storage instance.
- Return original root state for unchanged workspace slice updates. Apply this
  consistently to layout, runtimes, spotlight, reader mode, and tile tabs.
- Keep runtime state immutable: reference equality is meaningful only if writers
  replace changed objects. Do not use JSON comparison or deep cloning on the hot
  path and do not debounce durable settings edits.
- Record remaining React-wide findings against existing issues where applicable.
  Pane-scoped subscriptions and context restructuring need their own rendering
  correctness tests; do not freeze closures with broad memo comparators.

## Verification and generation slices

Parent owns production design and source changes. A disjoint test-generation
slice may extend real-store tests for no-op subscriber notifications, unchanged
settings zero serialization/write, changed settings persistence, failed-write
retry, and rehydrate/clear. Existing migration and palette tests must remain
green. Run TypeScript and focused renderer/store tests; preserve all user state.
