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

The full syntax inventory covers 692 production TS/TSX files across the three
renderer trees (278 TSX files; 269 store calls; 69 workspace/context calls).
These counts are discovery, not proof of waste. Manual follow-up confirmed
three closed modals still enumerate/sort all agent rows on runtime changes:
Agent Activity, Close Old Agents, and Bulk Provider Switch. Gate their row
builders on `open` and include it in memo dependencies. Preserve mounted state,
open-time resets, and action-time revalidation; do not replace their lifetimes
with conditional mounts. Add closed/open/update/close behavioral coverage in a
second independent test-generation slice.

## Verification and generation slices

Parent owns production design and source changes. A disjoint test-generation
slice may extend real-store tests for no-op subscriber notifications, unchanged
settings zero serialization/write, changed settings persistence, failed-write
retry, and rehydrate/clear. Existing migration and palette tests must remain
green. Run TypeScript and focused renderer/store tests; preserve all user state.

## Audit findings and boundaries

- #781: settings identity cache and no-op root preservation implemented with
  real-store persistence/notification regression tests.
- #782: closed modal row derivations gated without changing modal lifetimes;
  all three mounted-component regression tests passed locally.
- #763: broad workspace context remains the main architectural follow-up.
  Twenty-two surface wrappers consume that context. Its methods close over
  current state, so memoizing the entire object is not a safe shortcut.
- #784: unrelated preferences and dispatch flags still trigger theme DOM work
  and remote theme IPC. Theme-specific projection needs separate coverage.
- CommandPalette already gates its expensive inner component when closed,
  except while processing a pending invocation. Preserve that intentional
  native-command path; its large selector count is not by itself idle work.
- Feed already has memoization/index caches. Persistent terminal ownership
  (#760), screen-interest work (#762), and history loading (#769) remain
  separate tasks, not fixes claimed by this renderer branch.

The syntax inventory is not a semantic review of every component and does not
establish a measured FPS gain. This branch removes demonstrated work, while
larger subscription changes still need per-pane rendering correctness tests.
