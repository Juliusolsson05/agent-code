# Extension contributions into the merged command / keybinding / settings systems

**Status:** planned · **Branch:** `feat/extension-platform` · **Date:** 2026-07-22
**Depends on:** the `origin/main` merge (`68c1b34a`) that brought the refactored
command catalog, keybinding resolver, and settings registry onto this branch.

## Why this is the first implementation commit

While this branch sat open, `main` refactored the three systems an extension
platform must plug into — and refactored them into *exactly* the contribution
shapes we need:

- The command list moved out of the palette into a **context-free catalog**
  (`command-palette/catalog.ts`), and `buildCommandRegistry` now resolves
  keybindings and gates via `commandApplicable` + `PALETTE_SELF_EXCLUDED_COMMAND_IDS`.
- Keybindings became a **separate id-keyed registry**
  (`command-keybindings/{defaults,resolve,reservations}.ts`) that resolves
  `commandId → chord`, decoupled from command definitions — the VS Code model.
- Settings rows are a **discriminated-union registry** (`settingsRegistry.ts`)
  whose `'apps'` marker variant this branch already added.

So the first real work is not new infrastructure. It is **bridging the branch's
declarative contribution model onto these merged registries.** It needs **no
sandbox** — every item here is declarative (the manifest already validates it;
nothing runs extension code at registration time), which is why it is the safest,
highest-value place to start. Imperative service access and the iframe boundary
come later (see the full-platform plan).

## Current state after the merge (verified)

| Contribution | Manifest schema | Wired? | Evidence |
| --- | --- | --- | --- |
| `contributes.commands` | `manifest.ts:65` | **YES** | `CommandPalette.tsx:808` passes `deriveExtensionCommands(...)` into `buildCommandRegistry(ctx, extensionCommands)` (`registry.ts`); derivation at `derive.ts:57`. Extension commands appear in the palette and fire. |
| `contributes.keybindings` | `manifest.ts:108` | **NO — dead** | Validated at `manifest.ts:230-237` (target command must exist), zero consumers. Never merged into `buildDefaultKeybindings()` / `resolveEffectiveKeybindings()`. |
| `contributes.settings` | `manifest.ts:82` | **NO — dead** | Validated only. Never turned into a `SettingDefinition`; no namespaced value store exists. |
| `contributes.views` | `manifest.ts:72` | partial | `mount: z.enum(['modal'])` only; modal surface works. Grid/dispatch panes are the *next* plan, not this one. |

The three gaps, precisely:

1. **Extension commands are invisible to the "Commands" settings category.**
   `listPickerCommandMeta()` (`registry.ts`) takes an optional
   `extensionCommands = []` (preserved through the merge) but the Settings caller
   passes nothing, so an extension command cannot be shown or hidden — and, more
   importantly, cannot be assigned a keybinding through the keybind editor, which
   iterates the same catalog.

2. **`contributes.keybindings` goes nowhere.** An extension can declare
   `{command, key}` and it validates, but the chord never reaches
   `resolveEffectiveKeybindings`, so it never fires and never shows in the editor.

3. **`contributes.settings` goes nowhere.** No `SettingDefinition` is produced,
   and there is no per-extension value store (the app's `Settings` is one flat
   first-party blob; extension storage is the separate main-owned namespace at
   `EXTENSION_STATE_DIR`).

## Scope of this commit series (no sandbox)

Three ordered pieces. Commands first because the other two hang off command ids.

### Piece 1 — extension commands into the Settings "Commands" category

**Goal:** extension commands are listable and hide-able in Settings, and therefore
bindable in the keybind editor, exactly like first-party commands.

**Do:**
- Find the Settings caller of `listPickerCommandMeta()` (the `command-visibility`
  marker row builder in `settingsRegistry.ts`, and the keybind editor's catalog
  iteration in `CommandKeybindingsRow.tsx`). Thread the same
  `deriveExtensionCommands(...)` list into it that `CommandPalette.tsx:808` already
  builds.
- Confirm `deriveExtensionCommands` output satisfies the **post-refactor**
  `CommandDef` contract that `catalog.ts`'s `findCatalogDefects` guards
  (`VALID_SURFACES`, required `surface`, a real `description`, a `declaredTier`).
  `derive.ts:87` already notes `buildCommandRegistry` throws on a blank
  description — verify the same fields the catalog now requires.

**Constraints:**
- Extension commands must keep sorting **last** (browse order); `allCommandDefs`
  already does this — do not reorder.
- Do **not** put extension commands into `builtInCommandCatalog` itself. The
  catalog is a frozen module-scope array; an installed extension must add a command
  without a reload, which is why the concat is per-call.

**Done when:** installing an extension with a command shows that command in
Settings → Commands, and the keybind editor lists it as bindable.

### Piece 2 — `contributes.keybindings` into the resolver

**Goal:** an extension's declared default chord fires and shows in the editor.

**Do:**
- Derive `CommandBindingDefault[]` (`command-keybindings/defaults.ts` shape:
  `{ commandId, bindings, context }`) from installed manifests' `keybindings`,
  the mirror of `deriveExtensionCommands`. Put it in `derive.ts`.
- Merge those into what `resolveEffectiveKeybindings` consumes. Match the
  first-party path: extension defaults are *defaults*, user overrides in
  `commandKeybindingOverrides` still win. Note `coerceCommandKeybindingOverrides`
  already **preserves unknown command ids** "for an extension temporarily
  uninstalled" — the store was built for this.
- Choose a `BindingContext` for extension bindings. Default to `'global'` unless
  the extension's view runs in a specific surface. (Contexts: `global | grid |
  dispatch | editor | feed`.)
- Run the contributed chord through `findBindingCollisions` /
  `findBindingOwners` (`reservations.ts`). Decision needed (see open questions):
  reject at install, or accept-and-report like cross-extension command-id
  collisions already do at load time.

**Constraints:**
- A binding whose `commandId` is not a contributed/known command must not silently
  vanish — the manifest cross-check (`manifest.ts:230`) already rejects an
  extension binding targeting a command it does not contribute, so at minimum the
  intra-extension case is safe.
- Keybindings live in the `Settings` blob (`commandKeybindingOverrides`), **not**
  a `~/.claude` file — do not invent a JSON-file path.

**Done when:** an extension shipping `{command, key}` fires that key, the editor
shows the chord, and a conflicting chord is surfaced (not silently dropped).

### Piece 3 — `contributes.settings` into the registry

**Goal:** an extension's declared settings render as real rows and persist.

**The real decision — where does an extension setting's VALUE live?** The app's
`Settings` is one flat first-party blob owned by zustand-persist, and
`app-state/store.ts` records that adding a field without a version bump
black-screened launch twice (#249). Extension settings are authored outside the
release cycle, so they **must not** enter that blob — the same rule that put
extension state in the main-owned `EXTENSION_STATE_DIR`.

**Recommended shape:**
- Add one `SettingDefinition` control variant, `'extension'` (sits beside the
  existing `'apps'` marker variant in the union you just merged), OR map the three
  manifest setting types (`boolean`/`number`/`string`) onto the existing
  `toggle` / `select-free` / `action` controls. Prefer a dedicated `'extension'`
  variant: it keeps the read/write path pointed at extension storage instead of
  the first-party `setSettings`.
- Back the value with the **existing** per-extension storage
  (`extension:storage-get/set`, `EXTENSION_STATE_DIR`) keyed by the setting's
  contribution id — reusing the one capability whose isolation is already
  acceptable, rather than opening a second store.
- Derive the rows from installed manifests (a `deriveExtensionSettings`, mirroring
  the command derivation) and concatenate into `getSettingsRegistry()` under an
  "Extensions" category or each extension's own section.

**Constraints:**
- Setting ids are already namespaced `<extensionId>.<name>` and validated.
- A `number` default is `.finite()` in the schema — NaN can't reach storage.
- Do not route extension setting writes through `setSettings`/the persisted blob.

**Done when:** an extension shipping a `boolean`/`number`/`string` setting renders
an editable row whose value survives a reload, stored under extension state.

## Cross-cutting constraints (do not break)

- **`AppDefinition` stays a manifest superset-by-one** (`apps/types.ts`). Capabilities
  never become fields on it — they go through `AgentCodeApiV1`. Contribution
  *wiring* is host-side derivation from the manifest, not new manifest fields.
- **Everything here is declarative.** Nothing in this series imports or runs an
  extension bundle at registration time — the palette, keybind editor, and Settings
  populate from manifests alone. Keep it that way; the moment a piece needs the
  loaded module, it has crossed into Stage 2 territory.
- **First-party callers unchanged.** Every threaded parameter
  (`extensionCommands`, extension defaults, extension settings) is additive with an
  empty default, so nothing first-party regresses.
- **Per-call concat, never module-scope snapshot.** An adversarial audit already
  found eight module-scope snapshots that could not react to an install; do not add a ninth.

## Verification

- `tsc -b tsconfig.node.json` then `tsc -p tsconfig.web.json --noEmit` — the
  project's real gate (electron-vite build + vitest do not type-check).
- Manual: install `Juliusolsson05/agent-code-timer` (or a fixture manifest adding a
  command + keybinding + setting), then confirm in one session: command in palette
  and in Settings → Commands; keybinding fires and shows in the editor; setting row
  renders and persists across reload.
- This is also the still-outstanding **Stage 1 acceptance test** ("nobody has
  launched the app and clicked it") — piece it in here rather than deferring again.

## Open questions for the implementer

1. **Keybinding conflict policy** — reject a colliding extension binding at install,
   or accept-and-report at load (matching cross-extension command-id collisions)?
   Recommend accept-and-report: an extension cannot see another's manifest, so
   failing install punishes whoever installed second.
2. **Settings category placement** — one shared "Extensions" category, or a
   per-extension section? Recommend per-extension section under an "Extensions"
   category so uninstalling cleanly removes a whole block.
3. **Uninstall cleanup** — when an extension is removed, do its stored setting
   values and keybind overrides get purged, or preserved for reinstall? The keybind
   store already preserves unknown ids deliberately; mirror that for settings
   (preserve), and document it.

## What this explicitly is NOT

- Not the sandbox / iframe boundary.
- Not grid/dispatch pane mounting (that is the next plan; needs the `'panel'`/`'tab'`
  mount kinds and the multi-mount registry).
- Not any imperative service API (`agentCode.workspace`, `.session`, etc.).
- Not fixing #577's three known bugs (Update-button closure, deactivate-on-uninstall,
  ledger validation) — those are their own small commit, fold in alongside piece 1.
