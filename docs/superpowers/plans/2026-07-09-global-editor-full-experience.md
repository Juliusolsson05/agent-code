# Global Editor Full Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Issue:** [#513](https://github.com/Juliusolsson05/agent-code/issues/513)

**Goal:** Turn the Global Editor overlay from a half-wired file viewer into a real editor: correct syntax highlighting for every file type, LSP-backed intelligence (diagnostics, hover, go-to-definition, completions) with a pluggable multi-language server registry, working tab lifecycle with dirty-close confirmation and non-destructive save-conflict handling, file watching, explorer file mutations, quick-open + project content search, a fullscreen mode, tab/geometry persistence, and an isolation cleanup so editor code has one home.

**Architecture:** The existing layering is kept and strengthened: `features/editor/` stays a pure view layer, `features/global-editor/` stays the integration hub owning the zustand store and IPC adapters, `src/main/ipc/editorFs.ts` stays the single filesystem trust boundary, and `src/main/lspManager.ts` grows from a hardcoded tsserver spawner into a registry-driven multi-server manager. New capabilities are added as new IPC channels beside the existing ones (never widening existing channel semantics), and all new renderer state lives on the existing global-editor store.

**Tech Stack:** Electron (electron-vite), React 18, zustand 5, monaco-editor 0.52.2, typescript-language-server 4.4 via vscode-jsonrpc 8.2, chokidar 5 (already a dependency), Tailwind-style utility classes matching existing components.

## Global Constraints

- **No new test files, no new `test:*` scripts** (user policy — see `feedback_no_test_bloat`). Verification is `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json` plus manual end-to-end passes. The one existing editor test (`monacoEditorTheme.renderer.test.ts`) must keep passing (`npm run test -- monacoEditorTheme` at the END, not per task).
- **Thick WHY comments** on every non-obvious decision (CLAUDE.md policy). When a task below says "with WHY comment", the comment must explain the constraint that forced the shape, not what the code does.
- **The trust boundary stays in main.** Every new filesystem/LSP IPC handler validates paths with `resolveInsideRoot` (or documents why containment doesn't apply). Renderer never receives absolute-path write capability outside a project root.
- **No bundled language-server binaries.** The TS server ships as an npm dep (already does); other servers are detected on `PATH` at runtime and fail open (no server → no LSP, editor still works).
- **Monaco theme changes must keep the CodeBlock slab look intact** — transcript code blocks keep `--theme-code-bg` slabs; only the file editor uses the canvas theme.
- **Never persist unsaved buffer contents** to disk/localStorage (only paths + geometry).
- Work happens on branch `feat/editor-full-experience` in worktree `.worktrees/editor-full-experience`. Commit after every task. Do not merge the PR (user policy `feedback_no_auto_merge`).
- All file paths below are relative to the worktree root.

## File Structure (what's created/modified where)

```
src/shared/code/language.ts                    [modify] + monacoLanguageId(), LSP server candidate map
src/shared/types/lsp.ts                        [modify] + hover/definition/completion/symbol shared shapes
src/shared/types/editorFs.ts                   [modify] + recursive-list, search, watch-event shapes
src/main/lsp/serverRegistry.ts                 [create] pluggable LSP server specs + PATH detection
src/main/lspManager.ts                         [modify] registry-driven servers; hover/def/completion/refs/symbols
src/main/ipc/lsp.ts                            [modify] new request channels
src/main/ipc/editorFs.ts                       [modify] + list-files-recursive, search-content handlers
src/main/ipc/editorFsWatch.ts                  [create] chokidar file watcher IPC (watch/unwatch/push)
src/main/ipc/index.ts                          [modify] register watcher IPC
src/preload/api/lsp.ts                         [modify] new request methods
src/preload/api/editorFs.ts                    [modify] recursive list + search + watch methods
src/renderer/index.html                        [modify] CSP worker-src
src/renderer/src/lib/code/monacoRuntime.ts     [modify] eager MonacoEnvironment; theme handoff; ts defaults
src/renderer/src/lib/code/monacoThemeController.ts [create] single owner of the global Monaco theme
src/renderer/src/features/editor/lib/monacoEditorTheme.ts [modify] delegate to controller (thin back-compat)
src/renderer/src/features/editor/lib/editorModelRegistry.ts [create] ref-counted Monaco models (undo survival)
src/renderer/src/features/editor/lib/bufferOps.ts [create] pure buffer-lifecycle helpers (dedup GE/AIW)
src/renderer/src/features/editor/ui/MonacoFileEditor.tsx [modify] LSP wiring, model registry, banner not pane-replace
src/renderer/src/features/editor/ui/EditorWorkbench.tsx [modify] dirty-close confirm, conflict banner slot
src/renderer/src/features/editor/ui/EditorStatusBanner.tsx [create] save-error / conflict / stale banner
src/renderer/src/features/editor/ui/ConfirmCloseDialog.tsx [create] unsaved-changes dialog
src/renderer/src/features/editor/ui/ExplorerPane.tsx [modify] context menu: new/rename/delete, showHidden toggle
src/renderer/src/lib/code/editorLanguageFeatures.ts [create] hover/def/completion providers + editor opener
src/renderer/src/features/global-editor/store.ts [modify] force-close, conflict flag, fullscreen, quick-open state, rename
src/renderer/src/features/global-editor/ui/GlobalEditorShell.tsx [modify] fullscreen, watcher sync, confirm wiring
src/renderer/src/features/global-editor/ui/QuickOpenOverlay.tsx [create] ⌘P fuzzy file open
src/renderer/src/features/global-editor/ui/ContentSearchOverlay.tsx [create] ⌘⇧F project search
src/renderer/src/features/global-editor/lib/globalEditorPersistence.ts [create] localStorage tabs+geometry
src/renderer/src/features/global-editor/commands/globalEditorCommands.ts [create] editor-owned palette commands
src/renderer/src/features/workspace/commands/layoutCommands.ts [modify] remove the 5 editor commands
src/renderer/src/features/command-palette/registry.ts [modify] register globalEditorCommands
src/renderer/src/features/command-palette/types.ts [modify] new flags/ui entries
src/renderer/src/features/command-palette/ui/CommandPalette.tsx [modify] thread new flags/ui
src/renderer/src/workspace/tile-tree/useKeybinds.ts [modify] ⌘P, ⌘⇧F, ⌥⌘E
src/renderer/src/features/ai-workspace/ui/AiWorkspaceEditor.tsx [modify] bufferOps + force-close semantics
```

---

### Task 1: Monaco language IDs — fix blank `.tsx`/`.jsx` highlighting

The single highest-impact fix. Monaco has no `typescriptreact`/`javascriptreact` languages; models created with those IDs silently fall back to the plaintext tokenizer.

**Files:**
- Modify: `src/shared/code/language.ts`
- Modify: `src/renderer/src/lib/code/monacoRuntime.ts`
- Modify: `src/renderer/src/features/editor/ui/MonacoFileEditor.tsx:52`
- Modify: `src/renderer/src/lib/code/CodeBlock.tsx:132`

**Interfaces:**
- Produces: `monacoLanguageId(language: string): string` in `@shared/code/language` — maps LSP/VS Code language IDs to Monaco language IDs. Every later task that creates a Monaco model or registers a Monaco provider MUST pass language through this.

- [ ] **Step 1: Add `monacoLanguageId` to `src/shared/code/language.ts`**

Append after `supportsLsp`:

```typescript
// Monaco does not ship `typescriptreact` / `javascriptreact` languages —
// those are VS Code language IDs. Monaco's own `typescript` / `javascript`
// tokenizers handle JSX/TSX syntax natively. Creating a model with an
// unregistered language ID silently selects the *plaintext* tokenizer,
// which is exactly the "highlighting is completely blank for .tsx files"
// bug (#513). Everything that talks TO MONACO (createModel, provider
// registration) must translate through this; everything that talks to the
// LSP keeps the react-variant IDs because tsserver distinguishes them
// (languageId drives JSX parsing on the server side).
export function monacoLanguageId(language: string): string {
  if (language === 'typescriptreact') return 'typescript'
  if (language === 'javascriptreact') return 'javascript'
  return language
}
```

- [ ] **Step 2: Use it at both model-creation sites**

`MonacoFileEditor.tsx` — add `monacoLanguageId` to the existing `@shared/code/language` import (the file currently imports nothing from it; add `import { monacoLanguageId } from '@shared/code/language'`) and change model creation:

```typescript
model = existing ?? monaco.editor.createModel(
  file.currentText,
  monacoLanguageId(file.language),
  uri,
)
```

`CodeBlock.tsx` — the import at the top already pulls from `@shared/code/language`; add `monacoLanguageId` to it, then:

```typescript
const model = monaco.editor.createModel(code, monacoLanguageId(normalizedLanguage), uri)
```

- [ ] **Step 3: Configure the TS worker for JSX + defer semantics to LSP**

In `monacoRuntime.ts`, inside `getMonaco()` right after `registerMonacoModelCountProbe(...)` add:

```typescript
// JSX/TSX support for the built-in TypeScript worker. Without `jsx` set,
// the worker parses `.tsx` model content as plain TS and floods it with
// syntax errors on the first `<`. `allowNonTsExtensions` lets the worker
// attach to models whose URIs don't end in .ts/.tsx (transcript snippets
// use synthetic URIs).
//
// Semantic validation is intentionally OFF: the worker sees one file at a
// time, so every cross-file import resolves to "cannot find module" noise.
// Real semantic diagnostics come from the typescript-language-server via
// LspManager (which sees the whole project); the worker keeps only syntax
// validation, which is reliable single-file.
const tsDefaults = [
  monaco.languages.typescript.typescriptDefaults,
  monaco.languages.typescript.javascriptDefaults,
]
for (const defaults of tsDefaults) {
  defaults.setCompilerOptions({
    ...defaults.getCompilerOptions(),
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    target: monaco.languages.typescript.ScriptTarget.ESNext,
  })
  defaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  })
}
```

- [ ] **Step 4: Fix `ensureSemanticProvider` to register against the Monaco ID**

Still `monacoRuntime.ts` — in `ensureSemanticProvider`, the provider must be registered for the language Monaco models actually use, while the legend/IPC keeps the LSP ID. Change the registration line:

```typescript
monaco.languages.registerDocumentSemanticTokensProvider(
  // Models are created with the MONACO id (task 1); registering the
  // provider under the raw LSP id ('typescriptreact') would attach it to
  // a language no model uses. The legend request above still uses
  // `normalized` because tsserver keys its behavior on the LSP id.
  monacoLanguageId(normalized),
  {
```

Note: `registeredLanguages`/`pendingSemanticProviders` stay keyed by `normalized` (the LSP id) — `typescript` and `typescriptreact` will both map to Monaco `typescript`; guard double-registration by ALSO tracking Monaco ids. Add at module scope `const registeredMonacoLanguages = new Set<string>()` and inside the registration IIFE, before `monaco.languages.registerDocumentSemanticTokensProvider`:

```typescript
const monacoId = monacoLanguageId(normalized)
if (registeredMonacoLanguages.has(monacoId)) {
  registeredLanguages.add(normalized)
  return
}
registeredMonacoLanguages.add(monacoId)
```

Import `monacoLanguageId` in the existing `@shared/code/language` import at the top of `monacoRuntime.ts`.

- [ ] **Step 5: Typecheck + manual verify**

Run: `cd .worktrees/editor-full-experience && npx tsc --noEmit -p tsconfig.web.json`
Expected: no errors (node project untouched).

Manual (can defer to end-of-phase check): `npm run dev`, ⌘⇧E, open any `.tsx` file → tokens are colored, not flat.

- [ ] **Step 6: Commit**

```bash
git add src/shared/code/language.ts src/renderer/src/lib/code/monacoRuntime.ts src/renderer/src/features/editor/ui/MonacoFileEditor.tsx src/renderer/src/lib/code/CodeBlock.tsx
git commit -m "fix(editor): map react language ids to monaco ids — unblank .tsx/.jsx highlighting (#513)"
```

---

### Task 2: Single-owner Monaco theme controller + semantic highlighting enabled

Two modules currently fight over Monaco's global theme (`getMonaco()` re-asserts the slab theme on every call; `monacoEditorTheme.ts` refcounts the editor theme). Consolidate into one controller, and turn semantic highlighting on (custom themes default it OFF, so LSP semantic tokens are computed but never painted).

**Files:**
- Create: `src/renderer/src/lib/code/monacoThemeController.ts`
- Modify: `src/renderer/src/lib/code/monacoRuntime.ts`
- Modify: `src/renderer/src/features/editor/lib/monacoEditorTheme.ts`
- Modify: `src/renderer/src/features/editor/ui/MonacoFileEditor.tsx`
- Modify: `src/renderer/src/lib/code/CodeBlock.tsx`

**Interfaces:**
- Produces: `monacoThemeController.ts` exporting:
  - `initThemeController(monaco: typeof Monaco): void` (idempotent; defines all 6 themes, installs ONE theme-changed listener, applies the correct current theme)
  - `acquireEditorTheme(monaco: typeof Monaco): void` / `releaseEditorTheme(monaco: typeof Monaco): void` (refcounted editor-canvas theme)
- Consumes: existing `normalizeMonacoThemeColor(Alpha)` from `./monacoThemeColors`, `THEME_CHANGED_EVENT` from `@renderer/app-state/settings/theme`.

- [ ] **Step 1: Create `monacoThemeController.ts`**

Move the FOUR slab themes from `monacoRuntime.defineThemes` and the TWO editor-canvas themes from `monacoEditorTheme.defineEditorThemes` into one module (copy the definitions verbatim, including their WHY comments about light-mode slabs staying dark). Structure:

```typescript
import type * as Monaco from 'monaco-editor'

import { THEME_CHANGED_EVENT } from '@renderer/app-state/settings/theme'
import {
  normalizeMonacoThemeColor,
  normalizeMonacoThemeColorAlpha,
} from './monacoThemeColors'

// Single owner of Monaco's GLOBAL theme.
//
// WHY one module: Monaco's setTheme is process-global. Before this
// controller existed, monacoRuntime.getMonaco() re-defined themes AND
// re-asserted the slab theme on EVERY call — so a transcript CodeBlock
// mounting while the Global Editor was open yanked the whole editor back
// onto the dark slab palette. monacoEditorTheme.ts meanwhile refcounted
// the editor theme with its own listener. Two writers, one global — the
// classic fight. All setTheme calls now live in this file and nowhere
// else in the codebase.
//
// Ownership rule: while `editorThemeUsers > 0` the editor-canvas theme
// wins; otherwise the slab theme for the current app mode is applied.

let initialized = false
let editorThemeUsers = 0
let monacoRef: typeof Monaco | null = null

function currentSlabThemeName(): string { /* moved from monacoRuntime.currentThemeName */ }
function currentEditorThemeName(): string { /* moved from monacoEditorTheme */ }
function defineAllThemes(monaco: typeof Monaco): void { /* all 6 defineTheme calls, verbatim */ }

function applyOwnedTheme(monaco: typeof Monaco): void {
  monaco.editor.setTheme(
    editorThemeUsers > 0 ? currentEditorThemeName() : currentSlabThemeName(),
  )
}

export function initThemeController(monaco: typeof Monaco): void {
  monacoRef = monaco
  if (initialized) return
  initialized = true
  defineAllThemes(monaco)
  applyOwnedTheme(monaco)
  window.addEventListener(THEME_CHANGED_EVENT, () => {
    // Re-read CSS custom properties and re-assert whichever theme the
    // current owner wants — this is the ONLY place theme changes are
    // reapplied.
    defineAllThemes(monaco)
    applyOwnedTheme(monaco)
  })
}

export function acquireEditorTheme(monaco: typeof Monaco): void {
  editorThemeUsers += 1
  initThemeController(monaco)
  applyOwnedTheme(monaco)
}

export function releaseEditorTheme(monaco: typeof Monaco): void {
  editorThemeUsers = Math.max(0, editorThemeUsers - 1)
  applyOwnedTheme(monaco)
}
```

Fill the elided function bodies by MOVING the existing code: `currentThemeName` from `monacoRuntime.ts:30-38`, the four `defineTheme` calls from `monacoRuntime.ts:56-118`, `currentEditorThemeName`/`currentModeIsLight`/`defineEditorThemes`/`readToken` from `monacoEditorTheme.ts`. Keep every existing WHY comment attached to what it explains. Also install the legacy `${APP_SLUG}:theme-changed` listener alongside `THEME_CHANGED_EVENT` if grep shows they are different event names (`monacoRuntime.ts:126` uses `` `${APP_SLUG}:theme-changed` `` while `monacoEditorTheme.ts` uses `THEME_CHANGED_EVENT` — check `app-state/settings/theme.ts`; if `THEME_CHANGED_EVENT` string-equals the APP_SLUG template, subscribe once, otherwise subscribe to both and note why).

- [ ] **Step 2: Gut theme logic from `monacoRuntime.ts`**

- Delete `currentThemeName`, `defineThemes`, `installThemeListener`, `themeListenerInstalled`.
- In `getMonaco()`, replace `defineThemes(monaco); installThemeListener(monaco)` with `initThemeController(monaco)`.
- Keep `normalizeMonacoThemeColor` imports only if still used (they move to the controller — remove from runtime if unused).

- [ ] **Step 3: Reduce `monacoEditorTheme.ts` to a thin delegate**

Replace the whole implementation with re-exports so the existing test and `MonacoFileEditor` imports keep working, with a WHY note that the controller owns the logic now:

```typescript
// Kept as a thin alias so feature-level imports don't reach into lib/code
// internals directly. All theme logic (including the editor-canvas
// palette) lives in monacoThemeController — see the "two writers, one
// global" WHY there. This file exists because features/editor components
// were the original owner and their import path is stable API for the
// renderer test suite.
export {
  acquireEditorTheme as activateEditorTheme,
  releaseEditorTheme as deactivateEditorTheme,
} from '@renderer/lib/code/monacoThemeController'
```

Then check what `monacoEditorTheme.renderer.test.ts` asserts (read it first!) — if it tests `defineEditorThemes`/`currentEditorThemeName` exports directly, export those names from the controller too and re-export here. Adjust mechanically until `npx vitest run src/renderer/src/features/editor/lib/monacoEditorTheme.renderer.test.ts` passes (this is an EXISTING test — keeping it green is in-policy).

- [ ] **Step 4: Enable semantic highlighting at both editor creation sites**

`MonacoFileEditor.tsx` `monaco.editor.create` options — add:

```typescript
// Monaco defaults semanticHighlighting to "configuredByTheme", and custom
// themes don't opt in — so LSP semantic tokens were computed (IPC +
// tsserver round trip) and then never painted. Explicit true is the only
// way to get semantic colors with defineTheme-created themes.
'semanticHighlighting.enabled': true,
```

`CodeBlock.tsx` `monaco.editor.create` options — add the same option (comment: `// see MonacoFileEditor — custom themes never enable semantic tokens by default`).

- [ ] **Step 5: Typecheck + existing-test check + commit**

Run: `npx tsc --noEmit -p tsconfig.web.json && npx vitest run src/renderer/src/features/editor/lib/monacoEditorTheme.renderer.test.ts`
Expected: clean typecheck; existing theme test passes.

```bash
git add -A src/renderer/src/lib/code/ src/renderer/src/features/editor/lib/monacoEditorTheme.ts src/renderer/src/features/editor/ui/MonacoFileEditor.tsx
git commit -m "fix(editor): single-owner monaco theme controller; enable semantic highlighting (#513)"
```

---

### Task 3: Worker environment hardening + CSP `worker-src`

**Files:**
- Modify: `src/renderer/src/lib/code/monacoRuntime.ts`
- Modify: `src/renderer/index.html:23`

- [ ] **Step 1: Install `MonacoEnvironment` at module scope**

In `monacoRuntime.ts`, move the entire `monacoWindow.MonacoEnvironment = { getWorker(...) }` block OUT of `getMonaco()` to module top level (right after the worker imports), executing at import time:

```typescript
// Installed at MODULE SCOPE, not inside getMonaco(): Monaco resolves
// MonacoEnvironment lazily when a language service first needs a worker,
// but nothing guarantees every model/editor creation site awaits
// getMonaco() first (a future import of 'monaco-editor' from anywhere
// else would race it). The worker getter has no dependency on the loaded
// monaco module, so there is no reason to defer installing it — and a
// missing environment doesn't throw, it silently degrades to
// no-tokenization, which is the worst possible failure mode to debug.
const monacoWindow = window as Window & {
  MonacoEnvironment?: { getWorker: (moduleId: string, label: string) => Worker }
}
monacoWindow.MonacoEnvironment ??= {
  getWorker(_moduleId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    return new editorWorker()
  },
}
```

Remove the old block from `getMonaco()`.

- [ ] **Step 2: Add `worker-src` to the CSP**

`src/renderer/index.html` — extend the CSP content attribute with `; worker-src 'self' blob:` and add to the existing WHY comment block:

```
worker-src 'self' blob:  — Monaco language services run in Web Workers
(Vite ?worker imports are same-origin files in prod, but Vite's dev
server and some Monaco fallback paths construct blob: workers). With no
worker-src directive, workers fall back to script-src 'self', which
blocks blob: — the TS/JSON/CSS/HTML workers die silently and
tokenization goes blank intermittently (#513).
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.web.json`

```bash
git add src/renderer/src/lib/code/monacoRuntime.ts src/renderer/index.html
git commit -m "fix(editor): eager MonacoEnvironment install + worker-src CSP (#513)"
```

---

### Task 4: Tab close that works — force-close, confirm dialog, non-destructive error banner

**Files:**
- Modify: `src/renderer/src/features/global-editor/store.ts`
- Modify: `src/renderer/src/features/editor/types.ts`
- Create: `src/renderer/src/features/editor/ui/ConfirmCloseDialog.tsx`
- Create: `src/renderer/src/features/editor/ui/EditorStatusBanner.tsx`
- Modify: `src/renderer/src/features/editor/ui/EditorWorkbench.tsx`
- Modify: `src/renderer/src/features/editor/ui/MonacoFileEditor.tsx`
- Modify: `src/renderer/src/features/global-editor/ui/GlobalEditorShell.tsx`
- Modify: `src/renderer/src/features/ai-workspace/ui/AiWorkspaceEditor.tsx`

**Interfaces:**
- Produces (store): `closeFile(cwd, path, opts?: { force?: boolean }): boolean`; `setFileError(cwd, path, error: string | null, opts?: { conflict?: boolean })`; buffer gains `conflict: boolean`.
- Produces (workbench): `onCloseFile: (path: string, opts?: { force?: boolean }) => boolean` — EditorWorkbench OWNS the confirm dialog internally; hosts only supply force-capable close.
- Produces (workbench): new optional props `onSaveThenClose?: (path: string) => Promise<boolean>` (save; on success close; returns success) and `onReloadFromDisk?: (path: string) => void`, `onOverwriteDisk?: (path: string) => void` for the banner actions.

- [ ] **Step 1: Extend the buffer type**

`features/editor/types.ts` — add to `EditorFileBuffer`:

```typescript
  /** True when the last save failed the optimistic mtime check ("file
   *  changed on disk"). Distinct from `error` (which also covers hard IO
   *  failures) because the conflict state has dedicated recovery actions
   *  (reload / overwrite) while a hard error only has retry. */
  conflict: boolean
```

- [ ] **Step 2: Store changes**

`global-editor/store.ts`:

1. `createBuffer` gains `conflict: false`.
2. `closeFile` signature → `closeFile: (cwd: string, path: string, opts?: { force?: boolean }) => boolean`; the dirty guard becomes `if (current?.dirty && !opts?.force) return false` (update the WHY comment: caller shows ConfirmCloseDialog and re-calls with force).
3. `setFileError` signature → `(cwd, path, error: string | null, opts?: { conflict?: boolean })`; sets `error` AND `conflict: opts?.conflict === true`. `updateFileText` and `markFileSaved` also clear `conflict: false` where they clear `error` (typing past a conflict re-validates on next ⌘S anyway — same WHY as the existing error-clearing comment).
4. Update the `GlobalEditorStore` type accordingly.

- [ ] **Step 3: Create `ConfirmCloseDialog.tsx`**

```tsx
type Props = {
  fileName: string
  onSaveAndClose: () => void
  onDiscard: () => void
  onCancel: () => void
}

// Rendered by EditorWorkbench as an absolutely-positioned scrim over the
// editor area (NOT a portal/global modal — the decision is scoped to one
// workbench, and a global modal would fight the command palette /
// settings overlays for z-index and focus ownership).
export function ConfirmCloseDialog({ fileName, onSaveAndClose, onDiscard, onCancel }: Props) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40">
      <div className="w-[360px] rounded border border-border bg-surface p-4 font-code text-[12px] text-ink shadow-lg">
        <div className="mb-1 font-semibold">Unsaved changes</div>
        <div className="mb-4 text-ink-dim">
          “{fileName}” has unsaved changes. Save before closing?
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel}
            className="rounded border border-border px-3 py-1 text-ink-dim hover:bg-surface-hi hover:text-ink">
            Cancel
          </button>
          <button type="button" onClick={onDiscard}
            className="rounded border border-border px-3 py-1 text-danger hover:bg-surface-hi">
            Discard
          </button>
          <button type="button" onClick={onSaveAndClose} autoFocus
            className="rounded bg-accent px-3 py-1 text-black hover:opacity-90">
            Save &amp; Close
          </button>
        </div>
      </div>
    </div>
  )
}
```

(Match exact token classes used by nearby components — check `SettingsPage.tsx` button styling and reuse its classes if they differ from the above.)

- [ ] **Step 4: Create `EditorStatusBanner.tsx`**

```tsx
type Props = {
  message: string
  conflict: boolean
  onReload?: () => void
  onOverwrite?: () => void
}

// Save/stale errors render ABOVE the editor, never instead of it. The
// previous behavior (error replaces the whole Monaco pane —
// MonacoFileEditor's early return) meant a failed save hid the user's
// unsaved text at the exact moment they most need to see it, and made the
// dirty tab uncloseable with no visible path out (#513 bug 1).
export function EditorStatusBanner({ message, conflict, onReload, onOverwrite }: Props) {
  return (
    <div className="flex flex-shrink-0 items-center gap-3 border-b border-border bg-danger/10 px-3 py-1.5 font-code text-[11px] text-danger">
      <span className="min-w-0 flex-1 truncate" title={message}>{message}</span>
      {conflict && onReload && (
        <button type="button" onClick={onReload}
          className="flex-shrink-0 rounded border border-border px-2 py-0.5 text-ink-dim hover:text-ink">
          Reload from disk
        </button>
      )}
      {conflict && onOverwrite && (
        <button type="button" onClick={onOverwrite}
          className="flex-shrink-0 rounded border border-border px-2 py-0.5 text-ink-dim hover:text-ink">
          Overwrite
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 5: MonacoFileEditor stops replacing the pane on error**

Delete the `if (file.error) { return <error pane> }` early return (`MonacoFileEditor.tsx:154-160`). The editor always renders when a file is open; the banner is the workbench's job. (The `loading`/`!file` returns stay.)

- [ ] **Step 6: EditorWorkbench owns the confirm dialog + banner**

`EditorWorkbench.tsx` — new props (see Interfaces) and internal state:

```tsx
const [pendingClosePath, setPendingClosePath] = useState<string | null>(null)

const requestClose = (path: string) => {
  const closed = onCloseFile(path)
  if (!closed) setPendingClosePath(path)
}
```

- Pass `onClose={requestClose}` to `EditorTabs`.
- Render above `MonacoFileEditor`, inside the right-hand column (which needs `relative` on the flex column div for the dialog scrim):

```tsx
{activeFile?.error && (
  <EditorStatusBanner
    message={activeFile.error}
    conflict={activeFile.conflict}
    onReload={onReloadFromDisk && activeFilePath ? () => onReloadFromDisk(activeFilePath) : undefined}
    onOverwrite={onOverwriteDisk && activeFilePath ? () => onOverwriteDisk(activeFilePath) : undefined}
  />
)}
...
{pendingClosePath && (
  <ConfirmCloseDialog
    fileName={basename(pendingClosePath)}
    onCancel={() => setPendingClosePath(null)}
    onDiscard={() => {
      onCloseFile(pendingClosePath, { force: true })
      setPendingClosePath(null)
    }}
    onSaveAndClose={() => {
      void (async () => {
        const saved = onSaveThenClose ? await onSaveThenClose(pendingClosePath) : false
        // On save failure the buffer error/banner explains why; keep the
        // dialog closed either way so the banner is visible.
        if (!saved) onCloseFile(pendingClosePath, { force: false })
        setPendingClosePath(null)
      })()
    }}
  />
)}
```

Import `basename` from `@renderer/features/editor/lib/path` and `useState` from react.

- [ ] **Step 7: Wire GlobalEditorShell**

`GlobalEditorShell.tsx`:

1. Refactor `saveActive` into `saveFile(path: string): Promise<boolean>` (same body, parameterized path, returns `result.ok`; on conflict call `setFileError(activeCwd, path, result.error, { conflict: result.conflict === true })`). Keep `saveActive = () => activeFilePath && saveFile(activeFilePath)` for ⌘S.
2. New callbacks:

```tsx
const saveThenClose = useCallback(async (path: string) => {
  if (!activeCwd) return false
  const ok = await saveFile(path)
  if (ok) closeFileAction(activeCwd, path)   // clean now → closes
  return ok
}, [activeCwd, saveFile, closeFileAction])

const reloadFromDisk = useCallback(async (path: string) => {
  if (!activeCwd) return
  const result = await window.api.editorReadTextFile({ root: activeCwd, path })
  if (!result.ok) { setFileError(activeCwd, path, result.error); return }
  // markFileSaved overwrites currentText with disk content and clears
  // dirty/conflict — that is exactly what "Reload from disk" means.
  markFileSaved(activeCwd, path, result.text, result.mtimeMs)
}, [activeCwd, markFileSaved, setFileError])

const overwriteDisk = useCallback(async (path: string) => {
  if (!activeCwd) return
  const buf = useGlobalEditorStore.getState().byCwd[activeCwd]?.openFiles[path]
  if (!buf) return
  const result = await window.api.editorWriteTextFile({
    root: activeCwd, path, text: buf.currentText, expectedMtimeMs: null, // null = skip mtime check: explicit user override
  })
  if (result.ok) markFileSaved(activeCwd, path, buf.currentText, result.mtimeMs)
  else setFileError(activeCwd, path, result.error, { conflict: result.conflict === true })
}, [activeCwd, markFileSaved, setFileError])
```

3. Pass to `EditorWorkbench`: `onCloseFile={(path, opts) => closeFileAction(activeCwd, path, opts)}`, `onSaveThenClose={saveThenClose}`, `onReloadFromDisk={path => void reloadFromDisk(path)}`, `onOverwriteDisk={path => void overwriteDisk(path)}`.

- [ ] **Step 8: AiWorkspaceEditor parity**

`AiWorkspaceEditor.tsx`: its local `closeFile` gets the same `(entryId, opts?: { force?: boolean })` signature with a dirty guard (`if (openFiles[entryId]?.dirty && !opts?.force) return false`) so the workbench dialog works there too. Add `conflict: false` to both buffer literals; extract its save-error branch to set `conflict` when `result` has `conflict === true` (aiWorkspaceWriteFile result — check its type; if it has no conflict flag, always pass `conflict: false` and leave the reload/overwrite props unset). Add `onSaveThenClose` mirroring `saveActive` + force close.

- [ ] **Step 9: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.web.json`

```bash
git add -A src/renderer/src/features/editor src/renderer/src/features/global-editor src/renderer/src/features/ai-workspace
git commit -m "fix(editor): working tab close — confirm dialog, force-close, non-destructive save-error banner (#513)"
```

---

### Task 5: Ref-counted model registry — undo history survives tab switches

**Files:**
- Create: `src/renderer/src/features/editor/lib/editorModelRegistry.ts`
- Modify: `src/renderer/src/features/editor/ui/MonacoFileEditor.tsx`
- Modify: `src/renderer/src/features/global-editor/ui/GlobalEditorShell.tsx`
- Modify: `src/renderer/src/features/global-editor/store.ts` (no signature change; see step 3)

**Interfaces:**
- Produces:
  - `acquireEditorModel(monaco, params: { absolutePath: string, text: string, monacoLangId: string }): Monaco.editor.ITextModel` — returns existing model (syncing text if buffer differs) or creates one; bumps refcount.
  - `releaseEditorModel(absolutePath: string): void` — decrement; model is NOT disposed at zero (kept for reopen/undo), only marked releasable.
  - `disposeEditorModel(absolutePath: string): void` — hard dispose; called when a tab actually closes.
  - `disposeAllEditorModelsUnder(rootAbs: string): void` — hygiene for cwd eviction (not called yet; exists for the persistence task).

- [ ] **Step 1: Create the registry**

```typescript
import type * as Monaco from 'monaco-editor'

// Ref-counted Monaco model ownership for the file editor.
//
// WHY: MonacoFileEditor used to create AND dispose the model inside its
// mount effect, keyed on file.path — so every tab switch destroyed the
// model, and with it the undo stack, folding state, and view state.
// Buffers survive in zustand as plain strings, but Cmd+Z history lived
// only on the model. Model lifetime must therefore follow the BUFFER
// lifetime (open tab), not the COMPONENT lifetime (visible tab).
//
// Ownership contract:
//   - MonacoFileEditor acquires on mount / releases on unmount (it is a
//     *viewer* of the model, not its owner).
//   - The tab-close path (GlobalEditorShell → store.closeFile returning
//     true) calls disposeEditorModel — the close is the actual end of the
//     buffer's life.
//   - Models are keyed by absolutePath because that is what
//     monaco.Uri.file() keys on; two cwds can't collide (absolute paths).

type Entry = { model: Monaco.editor.ITextModel; refs: number }
const entries = new Map<string, Entry>()

export function acquireEditorModel(
  monaco: typeof Monaco,
  params: { absolutePath: string; text: string; monacoLangId: string },
): Monaco.editor.ITextModel {
  const existing = entries.get(params.absolutePath)
  if (existing && !existing.model.isDisposed()) {
    existing.refs += 1
    // Buffer text is the source of truth (it survives the model when the
    // app reloads a file from disk); only touch the model when they
    // actually differ — setValue clears the undo stack, which is the
    // thing this registry exists to protect.
    if (existing.model.getValue() !== params.text) existing.model.setValue(params.text)
    return existing.model
  }
  const uri = monaco.Uri.file(params.absolutePath)
  // A stale model can exist under this URI if a CodeBlock or previous
  // dispose path leaked it; reuse rather than crash (createModel throws
  // on duplicate URIs).
  const model =
    monaco.editor.getModel(uri) ??
    monaco.editor.createModel(params.text, params.monacoLangId, uri)
  if (model.getValue() !== params.text) model.setValue(params.text)
  entries.set(params.absolutePath, { model, refs: 1 })
  return model
}

export function releaseEditorModel(absolutePath: string): void {
  const entry = entries.get(absolutePath)
  if (!entry) return
  entry.refs = Math.max(0, entry.refs - 1)
  // Intentionally NOT disposing at zero refs — an open-but-inactive tab
  // has zero mounted viewers and must keep its undo stack alive.
}

export function disposeEditorModel(absolutePath: string): void {
  const entry = entries.get(absolutePath)
  entries.delete(absolutePath)
  if (entry && !entry.model.isDisposed()) entry.model.dispose()
}

export function disposeAllEditorModelsUnder(rootAbs: string): void {
  const prefix = rootAbs.endsWith('/') ? rootAbs : `${rootAbs}/`
  for (const [path] of [...entries]) {
    if (path.startsWith(prefix)) disposeEditorModel(path)
  }
}
```

- [ ] **Step 2: MonacoFileEditor uses the registry**

In the mount effect replace the model create/lookup block with:

```typescript
model = acquireEditorModel(monaco, {
  absolutePath: file.absolutePath,
  text: file.currentText,
  monacoLangId: monacoLanguageId(file.language),
})
```

In the cleanup replace the model-dispose block (`if (model && !model.isDisposed()) model.dispose()` and its WHY comment) with:

```typescript
// Viewer role only: release the refcount, never dispose here. Disposal
// happens on actual tab close via disposeEditorModel — see
// editorModelRegistry's ownership contract.
if (file) releaseEditorModel(file.absolutePath)
```

(Capture `file.absolutePath` in a local at effect start so the cleanup closure doesn't see a changed `file` prop.)

- [ ] **Step 3: Dispose on real close**

`GlobalEditorShell.tsx` — the close callback passed to the workbench computes the absolute path and disposes AFTER a successful close:

```tsx
onCloseFile={(path, opts) => {
  if (!activeCwd) return false
  const closed = closeFileAction(activeCwd, path, opts)
  if (closed) {
    // store paths are cwd-relative; the registry keys on absolute paths
    // (matches monaco.Uri.file). Same join the store's createBuffer does.
    disposeEditorModel(`${activeCwd.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`)
  }
  return closed
}}
```

Also dispose in `saveThenClose` after its `closeFileAction` call. AiWorkspaceEditor: same pattern in its `closeFile` using `entry.path`/`buffer.absolutePath`.

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.web.json`

```bash
git add -A src/renderer/src/features/editor src/renderer/src/features/global-editor src/renderer/src/features/ai-workspace
git commit -m "feat(editor): ref-counted model registry — undo history survives tab switches (#513)"
```

---

### Task 6: LSP server registry (main) — pluggable languages

**Files:**
- Create: `src/main/lsp/serverRegistry.ts`
- Modify: `src/main/lspManager.ts`
- Modify: `src/shared/code/language.ts`

**Interfaces:**
- Produces (`serverRegistry.ts`):
  - `type LspServerSpec = { id: string; languages: string[]; displayName: string; resolveCommand: () => Promise<{ command: string; args: string[]; env?: Record<string, string> } | null> }`
  - `lspServerForLanguage(language: string): LspServerSpec | null`
  - `LSP_SERVER_SPECS: LspServerSpec[]`
- Produces (`language.ts`): `LSP_LANGUAGES: Set<string>` superset used by `supportsLsp`.
- Consumes: `require.resolve('typescript-language-server/lib/cli.mjs')` (existing pattern from `lspManager.ts:231`).

- [ ] **Step 1: Extend `supportsLsp` in `src/shared/code/language.ts`**

```typescript
// Languages the LSP layer will ATTEMPT to serve. This is the renderer-
// visible candidate list, deliberately optimistic: actual availability is
// decided in main by serverRegistry.resolveCommand() (PATH detection).
// The renderer fails open — a candidate language with no installed server
// just gets no legend/diagnostics, identical to before this feature.
// tsserver ships as an npm dependency, so the TS family is always real;
// the rest require the user to have the server installed.
export const LSP_LANGUAGES = new Set([
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
  'python',
  'rust',
  'go',
])

export function supportsLsp(language: string): boolean {
  return LSP_LANGUAGES.has(language)
}
```

Also extend `languageFileExtension` with `if (language === 'go') return 'go'` (py/rs already exist).

- [ ] **Step 2: Create `src/main/lsp/serverRegistry.ts`**

```typescript
import { access, constants } from 'fs/promises'
import { createRequire } from 'module'
import { delimiter, join } from 'path'

const require = createRequire(import.meta.url)

export type LspResolvedCommand = {
  command: string
  args: string[]
  env?: Record<string, string>
}

export type LspServerSpec = {
  id: string
  displayName: string
  /** LSP languageIds this server owns. First matching spec wins. */
  languages: string[]
  /** Resolve to a spawnable command, or null when the server is not
   *  installed. Resolution is re-run per LspManager server creation (not
   *  cached here) so a user can install pyright and get LSP on the next
   *  workspace open without restarting the app. */
  resolveCommand: () => Promise<LspResolvedCommand | null>
}

// PATH probe. WHY not `which`/`command -v` via shell: spawning a shell to
// find a binary we're about to spawn anyway doubles the process cost and
// inherits shell-profile weirdness; a direct X_OK scan over PATH entries
// is exact and portable enough (win32 would need PATHEXT handling — the
// non-TS servers are best-effort and this app is macOS-first; revisit if
// packaged for Windows).
async function findOnPath(binary: string): Promise<string | null> {
  const pathVar = process.env.PATH ?? ''
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, binary)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      /* keep scanning */
    }
  }
  return null
}

function pathDetectedServer(binary: string, args: string[]): () => Promise<LspResolvedCommand | null> {
  return async () => {
    const resolved = await findOnPath(binary)
    return resolved ? { command: resolved, args } : null
  }
}

export const LSP_SERVER_SPECS: LspServerSpec[] = [
  {
    id: 'typescript',
    displayName: 'TypeScript (typescript-language-server)',
    languages: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'],
    // Bundled npm dependency — always available. Runs under the Electron
    // binary with ELECTRON_RUN_AS_NODE (see LspManager spawn WHY).
    resolveCommand: async () => ({
      command: process.execPath,
      args: [require.resolve('typescript-language-server/lib/cli.mjs'), '--stdio'],
      env: { ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' },
    }),
  },
  {
    id: 'pyright',
    displayName: 'Python (pyright-langserver)',
    languages: ['python'],
    resolveCommand: pathDetectedServer('pyright-langserver', ['--stdio']),
  },
  {
    id: 'rust-analyzer',
    displayName: 'Rust (rust-analyzer)',
    languages: ['rust'],
    resolveCommand: pathDetectedServer('rust-analyzer', []),
  },
  {
    id: 'gopls',
    displayName: 'Go (gopls)',
    languages: ['go'],
    resolveCommand: pathDetectedServer('gopls', []),
  },
]

export function lspServerForLanguage(language: string): LspServerSpec | null {
  return LSP_SERVER_SPECS.find(spec => spec.languages.includes(language)) ?? null
}
```

- [ ] **Step 3: Make `LspManager` registry-driven**

`src/main/lspManager.ts` changes:

1. Replace `SupportedLanguage`/`normalizeSupportedLanguage` with registry lookups: `import { lspServerForLanguage, type LspServerSpec } from '@main/lsp/serverRegistry.js'`. `OpenDocumentRecord.language` becomes `string`.
2. Server keying: `getOrCreateServer(workspaceRoot, spec)` — key is `` `${resolve(workspaceRoot)}::${spec.id}` `` (one server per root per language family). `ServerRecord` gains `specId: string`.
3. `getOrCreateServer` becomes async: `const resolved = await spec.resolveCommand(); if (!resolved) return null` — spawn `spawn(resolved.command, resolved.args, { cwd, stdio: 'pipe', env: { ...process.env, ...resolved.env } })`. Because it's now async AND can be called concurrently, hold a `private readonly serverPromises = new Map<string, Promise<ServerRecord | null>>()` single-flight map (same coalescing WHY as `pendingSemanticProviders` in monacoRuntime — concurrent opens must not double-spawn a server).
4. Callers: `ensureSemanticLegend(workspaceRoot, language)` → `const spec = lspServerForLanguage(language); if (!spec) return null; const server = await this.getOrCreateServer(workspaceRoot, spec); return server ? await server.legendPromise : null`. `openDocument` mirrors that (return early when no spec/server). `changeDocument`/`closeDocument`/`getSemanticTokens` are unchanged (they go through `this.docs`/`this.servers` by stored key).
5. The `docs`-cleanup in the `exit` handler keys on `doc.serverKey !== key` — still correct with the composite key.
6. Keep every existing WHY comment; update the spawn comment to note the command now comes from the registry.

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.node.json`

```bash
git add src/main/lsp src/main/lspManager.ts src/shared/code/language.ts
git commit -m "feat(lsp): pluggable server registry — tsserver bundled, pyright/rust-analyzer/gopls via PATH (#513)"
```

---

### Task 7: LSP request methods — hover, definition, completion, references, symbols

**Files:**
- Modify: `src/shared/types/lsp.ts` (read it first — it currently holds `LspDiagnostic`/`LspDiagnosticsEvent`)
- Modify: `src/main/lspManager.ts`
- Modify: `src/main/ipc/lsp.ts`
- Modify: `src/preload/api/lsp.ts`
- Modify: `src/preload/api/types.ts` (re-export new shapes if that's the existing pattern — check how `LspDiagnosticsEvent` is exposed there)

**Interfaces:**
- Produces (shared types):

```typescript
export type LspPosition = { line: number; character: number } // 0-based, LSP convention
export type LspLocation = {
  absolutePath: string
  startLine: number; startCharacter: number
  endLine: number; endCharacter: number
}
export type LspHoverResult = { markdown: string } | null
export type LspCompletionItem = {
  label: string
  kind: number            // raw LSP CompletionItemKind; renderer maps to Monaco
  insertText: string
  detail?: string
  documentation?: string
  sortText?: string
  isSnippet: boolean      // LSP InsertTextFormat.Snippet — Monaco needs the rule flag
}
export type LspDocumentSymbol = {
  name: string
  kind: number            // raw LSP SymbolKind
  startLine: number; startCharacter: number
  endLine: number; endCharacter: number
  children: LspDocumentSymbol[]
}
```

- Produces (LspManager): `getHover(clientUri, position)`, `getDefinition(clientUri, position): Promise<LspLocation[]>`, `getCompletions(clientUri, position): Promise<LspCompletionItem[]>`, `getReferences(clientUri, position): Promise<LspLocation[]>`, `getDocumentSymbols(clientUri): Promise<LspDocumentSymbol[]>`.
- Produces (preload → `window.api`): `getLspHover`, `getLspDefinition`, `getLspCompletions`, `getLspReferences`, `getLspDocumentSymbols` — same params with `clientUri: string` first.

- [ ] **Step 1: Add the shared types** (block above) to `src/shared/types/lsp.ts` with a header comment noting they are raw-LSP-shaped on purpose (renderer owns the Monaco mapping so main stays Monaco-free).

- [ ] **Step 2: Declare client capabilities**

`lspManager.ts` `initializeParams.capabilities.textDocument` — add alongside `semanticTokens`/`publishDiagnostics`:

```typescript
hover: { contentFormat: ['markdown', 'plaintext'] },
definition: { linkSupport: true },
completion: {
  completionItem: {
    snippetSupport: true,
    documentationFormat: ['markdown', 'plaintext'],
  },
},
references: {},
documentSymbol: { hierarchicalDocumentSymbolSupport: true },
```

- [ ] **Step 3: Implement the request methods on `LspManager`**

All follow the `getSemanticTokens` pattern (doc lookup → server lookup → `await server.initialized` → `sendRequest` → normalize → the same `isDestroyedStreamError` catch). Key normalization details:

```typescript
private requestContext(clientUri: string): { doc: OpenDocumentRecord; server: ServerRecord } | null {
  const doc = this.docs.get(clientUri)
  if (!doc) return null
  const server = this.servers.get(doc.serverKey)
  if (!server) return null
  return { doc, server }
}

async getHover(clientUri: string, position: LspPosition): Promise<LspHoverResult> {
  const ctx = this.requestContext(clientUri)
  if (!ctx) return null
  await ctx.server.initialized
  try {
    const hover = await ctx.server.connection.sendRequest('textDocument/hover', {
      textDocument: { uri: ctx.doc.serverUri },
      position,
    }) as Hover | null
    if (!hover) return null
    return { markdown: hoverContentsToMarkdown(hover.contents) }
  } catch (err) {
    if (isDestroyedStreamError(err) || ctx.server.closed) return null
    throw err
  }
}
```

`hoverContentsToMarkdown(contents)` — module-level helper handling the three LSP shapes (`MarkupContent` → `.value`; `MarkedString | MarkedString[]` → join; string → itself; code-fenced when `{ language, value }`):

```typescript
function hoverContentsToMarkdown(contents: Hover['contents']): string {
  const parts = Array.isArray(contents) ? contents : [contents]
  return parts
    .map(part => {
      if (typeof part === 'string') return part
      if ('kind' in part) return part.value            // MarkupContent
      return `\`\`\`${part.language}\n${part.value}\n\`\`\`` // MarkedString
    })
    .filter(Boolean)
    .join('\n\n')
}
```

`getDefinition` — request `textDocument/definition`; result can be `Location | Location[] | LocationLink[] | null`. Normalize with `fileURLToPath` (import from `url`):

```typescript
function toLspLocation(uri: string, range: Range): LspLocation | null {
  // Servers can return non-file URIs (untitled:, jdt:, lib dts inside
  // node_modules is still file:). Only file: URIs are openable by the
  // editor; drop the rest rather than crashing fileURLToPath.
  if (!uri.startsWith('file://')) return null
  return {
    absolutePath: fileURLToPath(uri),
    startLine: range.start.line, startCharacter: range.start.character,
    endLine: range.end.line, endCharacter: range.end.character,
  }
}
```

LocationLink uses `targetUri`/`targetSelectionRange`; Location uses `uri`/`range` — branch on `'targetUri' in item`.

`getCompletions` — request `textDocument/completion`; result `CompletionItem[] | CompletionList | null`; normalize `const items = Array.isArray(result) ? result : result?.items ?? []`, cap at 200 (`items.slice(0, 200)` with a WHY: tsserver returns 1k+ globals on bare identifiers; IPC-serializing all of them per keystroke is renderer jank for entries nobody scrolls to), map:

```typescript
items.slice(0, 200).map(item => ({
  label: typeof item.label === 'string' ? item.label : item.label.label,
  kind: item.kind ?? 1,
  insertText: item.insertText ?? (typeof item.label === 'string' ? item.label : item.label.label),
  detail: item.detail ?? undefined,
  documentation: typeof item.documentation === 'string'
    ? item.documentation
    : item.documentation?.value,
  sortText: item.sortText ?? undefined,
  isSnippet: item.insertTextFormat === 2, // InsertTextFormat.Snippet
}))
```

`getReferences` — `textDocument/references` with `context: { includeDeclaration: false }`, map through `toLspLocation`, cap 500.

`getDocumentSymbols` — `textDocument/documentSymbol`; result is `DocumentSymbol[]` (hierarchical) or `SymbolInformation[]` (flat); branch on `'range' in first`, map recursively (DocumentSymbol: `selectionRange` for position, keep `children`), flat SymbolInformation → children: [].

Import the needed protocol types (`Hover`, `Range`, `Location`, `LocationLink`, `CompletionItem`, `CompletionList`, `DocumentSymbol`, `SymbolInformation`) from `vscode-languageserver-protocol`.

- [ ] **Step 4: IPC + preload plumbing**

`src/main/ipc/lsp.ts` — five new handlers, same shape as existing:

```typescript
ipcMain.handle('lsp:get-hover', async (_evt, clientUri: string, position: LspPosition) =>
  await lspManager.getHover(clientUri, position))
ipcMain.handle('lsp:get-definition', async (_evt, clientUri: string, position: LspPosition) =>
  await lspManager.getDefinition(clientUri, position))
ipcMain.handle('lsp:get-completions', async (_evt, clientUri: string, position: LspPosition) =>
  await lspManager.getCompletions(clientUri, position))
ipcMain.handle('lsp:get-references', async (_evt, clientUri: string, position: LspPosition) =>
  await lspManager.getReferences(clientUri, position))
ipcMain.handle('lsp:get-document-symbols', async (_evt, clientUri: string) =>
  await lspManager.getDocumentSymbols(clientUri))
```

`src/preload/api/lsp.ts` — five matching `ipcRenderer.invoke` methods on `lspApi` (`getLspHover(clientUri, position)`, etc.), typed against the shared types; follow how `LspDiagnosticsEvent` is imported there (via `@preload/api/types.js` — add re-exports there if that's the pattern).

- [ ] **Step 5: Typecheck both projects + commit**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`

```bash
git add src/shared/types/lsp.ts src/main/lspManager.ts src/main/ipc/lsp.ts src/preload/api/
git commit -m "feat(lsp): hover/definition/completion/references/symbols requests + IPC (#513)"
```

---

### Task 8: Wire the real editor to LSP — document sync, diagnostics, providers, go-to-def

**Files:**
- Create: `src/renderer/src/lib/code/editorLanguageFeatures.ts`
- Modify: `src/renderer/src/features/editor/ui/MonacoFileEditor.tsx`

**Interfaces:**
- Consumes: everything from Task 7's preload API; `ensureSemanticProvider`/`getMonaco` from monacoRuntime; `openFileInGlobalEditor` from global-editor.
- Produces: `ensureEditorLanguageFeatures(monaco: typeof Monaco, language: string): void` — idempotent per Monaco language; registers hover/definition/completion providers + one global editor-opener.

- [ ] **Step 1: Create `editorLanguageFeatures.ts`**

```typescript
import type * as Monaco from 'monaco-editor'

import { monacoLanguageId, normalizeCodeLanguage, supportsLsp } from '@shared/code/language'
import type { LspCompletionItem } from '@shared/types/lsp'
import { openFileInGlobalEditor } from '@renderer/features/global-editor/openFileInGlobalEditor'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

// Monaco↔LSP feature providers for the FILE EDITOR surface.
//
// WHY these are registered per-language globally (Monaco has no
// per-editor providers) but fail open per-model: providers key off
// model.uri, and main's LspManager only answers for uris that went
// through openLspDocument. Transcript CodeBlocks share the same monaco
// languages but use synthetic uris (cc-shell://…) that were opened as
// LSP docs too — hover is disabled on those editors and completions
// can't trigger in readOnly, so the file-editor providers are inert
// there by construction rather than by special-casing.

const registered = new Set<string>()
let openerInstalled = false

// LSP CompletionItemKind (1-based) → Monaco CompletionItemKind. The two
// enums are DIFFERENT integer spaces — passing LSP kinds straight through
// renders wrong icons (e.g. LSP Function=3 vs Monaco Function=1).
function completionKindToMonaco(monaco: typeof Monaco, kind: number): Monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind
  const map: Record<number, Monaco.languages.CompletionItemKind> = {
    1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field,
    6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module, 10: K.Property,
    11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet,
    16: K.Color, 17: K.File, 18: K.Reference, 19: K.Folder, 20: K.EnumMember,
    21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter,
  }
  return map[kind] ?? K.Text
}

function toLspPosition(position: Monaco.Position) {
  // Monaco is 1-based, LSP is 0-based. Off-by-one here silently degrades
  // every feature (hover misses, definitions point one line off).
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

export function ensureEditorLanguageFeatures(monaco: typeof Monaco, language: string): void {
  installEditorOpener(monaco)
  const normalized = normalizeCodeLanguage(language)
  if (!supportsLsp(normalized)) return
  const monacoId = monacoLanguageId(normalized)
  if (registered.has(monacoId)) return
  registered.add(monacoId)

  monaco.languages.registerHoverProvider(monacoId, {
    async provideHover(model, position) {
      const result = await window.api.getLspHover(model.uri.toString(), toLspPosition(position))
      if (!result) return null
      return { contents: [{ value: result.markdown }] }
    },
  })

  monaco.languages.registerDefinitionProvider(monacoId, {
    async provideDefinition(model, position) {
      const locations = await window.api.getLspDefinition(model.uri.toString(), toLspPosition(position))
      return locations.map(loc => ({
        uri: monaco.Uri.file(loc.absolutePath),
        range: new monaco.Range(
          loc.startLine + 1, loc.startCharacter + 1,
          loc.endLine + 1, loc.endCharacter + 1,
        ),
      }))
    },
  })

  monaco.languages.registerReferenceProvider(monacoId, {
    async provideReferences(model, position) {
      const locations = await window.api.getLspReferences(model.uri.toString(), toLspPosition(position))
      return locations.map(loc => ({
        uri: monaco.Uri.file(loc.absolutePath),
        range: new monaco.Range(
          loc.startLine + 1, loc.startCharacter + 1,
          loc.endLine + 1, loc.endCharacter + 1,
        ),
      }))
    },
  })

  monaco.languages.registerCompletionItemProvider(monacoId, {
    triggerCharacters: ['.', '"', "'", '/', '@', '<'],
    async provideCompletions(model, position) {
      const items = await window.api.getLspCompletions(model.uri.toString(), toLspPosition(position))
      const word = model.getWordUntilPosition(position)
      const range = new monaco.Range(
        position.lineNumber, word.startColumn,
        position.lineNumber, word.endColumn,
      )
      return {
        suggestions: items.map((item: LspCompletionItem) => ({
          label: item.label,
          kind: completionKindToMonaco(monaco, item.kind),
          insertText: item.insertText,
          insertTextRules: item.isSnippet
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
          detail: item.detail,
          documentation: item.documentation ? { value: item.documentation } : undefined,
          sortText: item.sortText,
          range,
        })),
      }
    },
  })
}

// Cross-file go-to-definition. Standalone Monaco can't open other files —
// its default behavior on a foreign-uri definition is nothing (or a
// throwing peek widget). registerEditorOpener is the standalone escape
// hatch: Monaco calls it with the target resource + selection and we
// route through openFileInGlobalEditor, which enforces root containment
// in main. Definitions OUTSIDE the active cwd (node_modules .d.ts under a
// different root, system libs) are rejected by that containment — we
// deliberately fail closed there (no OS-level "open anything" hole).
function installEditorOpener(monaco: typeof Monaco): void {
  if (openerInstalled) return
  openerInstalled = true
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== 'file') return false
      const { activeCwd } = useGlobalEditorStore.getState()
      if (!activeCwd) return false
      const rootAbs = activeCwd.replace(/\/+$/, '')
      if (!resource.path.startsWith(`${rootAbs}/`)) return false
      const relative = resource.path.slice(rootAbs.length + 1)
      const line = selectionOrPosition
        ? ('startLineNumber' in selectionOrPosition
            ? selectionOrPosition.startLineNumber
            : selectionOrPosition.lineNumber)
        : 1
      const column = selectionOrPosition
        ? ('startColumn' in selectionOrPosition
            ? selectionOrPosition.startColumn
            : selectionOrPosition.column)
        : 1
      void openFileInGlobalEditor({ root: activeCwd, path: relative, line, column })
      return true
    },
  })
}
```

Note: the completion provider method name in Monaco is `provideCompletionItems` — use that exact name (the sketch above says `provideCompletions`; fix when writing).

- [ ] **Step 2: Document sync + diagnostics + semantic tokens in MonacoFileEditor**

In the mount effect, after `editor = monaco.editor.create(...)`:

```typescript
// LSP wiring — the transcript CodeBlock had all of this from day one;
// the actual FILE EDITOR never did (#513 bug 3). clientUri must be
// exactly model.uri.toString(): the semantic-token provider and every
// request in editorLanguageFeatures key their main-process doc lookup
// on it.
ensureEditorLanguageFeatures(monaco, file.language)
const clientUri = model.uri.toString()
if (projectRoot && supportsLsp(file.language)) {
  await ensureSemanticProvider(monaco, projectRoot, file.language).catch(() => {
    // fail open — same rationale as CodeBlock: no LSP must never mean no editor
  })
  if (disposed) return
  await window.api.openLspDocument({
    clientUri,
    content: file.currentText,
    language: file.language,
    workspaceRoot: projectRoot,
    filePath: file.path,
  })
  if (disposed) return
  const unsubDiag = window.api.onLspDiagnostics(event => {
    if (event.clientUri !== clientUri) return
    if (!model || model.isDisposed()) return
    monaco.editor.setModelMarkers(model, 'agent-code-lsp', event.diagnostics.map(d => ({
      message: d.message,
      startLineNumber: d.startLine + 1,
      startColumn: d.startCharacter + 1,
      endLineNumber: d.endLine + 1,
      endColumn: d.endCharacter + 1,
      severity: d.severity === 'error' ? monaco.MarkerSeverity.Error
        : d.severity === 'warning' ? monaco.MarkerSeverity.Warning
        : d.severity === 'info' ? monaco.MarkerSeverity.Info
        : monaco.MarkerSeverity.Hint,
    })))
  })
  cleanupFns.push(unsubDiag)
  cleanupFns.push(() => void window.api.closeLspDocument(clientUri))

  // Debounced change sync. 200ms: fast enough that diagnostics feel live,
  // slow enough that a keystroke burst is one didChange, not thirty.
  let changeTimer: number | null = null
  const changeSub = model.onDidChangeContent(() => {
    if (changeTimer !== null) window.clearTimeout(changeTimer)
    changeTimer = window.setTimeout(() => {
      changeTimer = null
      void window.api.changeLspDocument(clientUri, model!.getValue())
    }, 200)
  })
  cleanupFns.push(() => {
    changeSub.dispose()
    if (changeTimer !== null) window.clearTimeout(changeTimer)
  })
}
```

Refactor the effect to use a `cleanupFns: Array<() => void>` array (the CodeBlock pattern, `CodeBlock.tsx:104-259` — copy its LIFO cleanup loop and the WHY comment about async-init cleanup capture). The existing `changeDisposable`/`saveCommandId`/theme cleanups migrate into the array. Note the LSP `closeLspDocument` cleanup runs on COMPONENT unmount (tab switch) — that's acceptable churn for now (reopen re-syncs); add a comment saying a future doc-registry could align LSP doc lifetime with the model registry.

Imports to add: `ensureSemanticProvider` from monacoRuntime, `supportsLsp` from `@shared/code/language`, `ensureEditorLanguageFeatures` from `@renderer/lib/code/editorLanguageFeatures`.

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.web.json`

```bash
git add src/renderer/src/lib/code/editorLanguageFeatures.ts src/renderer/src/features/editor/ui/MonacoFileEditor.tsx
git commit -m "feat(editor): LSP in the real editor — diagnostics, hover, go-to-def, completions (#513)"
```

---

### Task 9: File watcher — open buffers track external writes

**Files:**
- Create: `src/main/ipc/editorFsWatch.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/shared/types/editorFs.ts`
- Modify: `src/preload/api/editorFs.ts`
- Modify: `src/renderer/src/features/global-editor/ui/GlobalEditorShell.tsx`

**Interfaces:**
- Produces (shared): `type EditorFsChangeEvent = { root: string; path: string; kind: 'change' | 'unlink'; mtimeMs: number | null }`
- Produces (preload): `editorWatchFile(params: { root: string; path: string }): Promise<void>`, `editorUnwatchFile(params: { root: string; path: string }): Promise<void>`, `onEditorFileChanged(cb: (e: EditorFsChangeEvent) => void): Unsub`
- Push channel: `editor-fs:file-changed`.

- [ ] **Step 1: Create `editorFsWatch.ts`**

```typescript
import { ipcMain, type WebContents } from 'electron'
import { watch, type FSWatcher } from 'chokidar'
import { stat } from 'fs/promises'
import { resolve } from 'path'

import type { EditorFsChangeEvent } from '@shared/types/editorFs.js'

// Per-file watchers for open editor buffers.
//
// WHY individual file watchers, not one recursive root watcher: the roots
// here are entire project checkouts (node_modules included). A recursive
// watcher on a big repo costs thousands of kernel watch descriptors and a
// storm of events the editor doesn't care about; the editor only needs to
// know about files it actually has open — a handful. Watch registration
// follows buffer lifetime, driven by the renderer.
//
// WHY refcounted: two surfaces (Global Editor per-cwd buffers now,
// possibly split views later) may watch the same file; the second
// unwatch must not kill the first watcher.

type WatchEntry = { watcher: FSWatcher; refs: number }
const watchers = new Map<string, WatchEntry>()          // key: absolute path
const subscribers = new Set<WebContents>()

function watchKey(root: string, path: string): string {
  return `${resolve(root)}/${path.replace(/^\/+/, '')}`
}

function broadcast(event: EditorFsChangeEvent): void {
  for (const wc of subscribers) {
    if (!wc.isDestroyed()) wc.send('editor-fs:file-changed', event)
  }
}

export function registerEditorFsWatchIpc(): void {
  ipcMain.handle('editor-fs:watch', async (evt, params: { root: string; path: string }) => {
    subscribers.add(evt.sender)
    evt.sender.once('destroyed', () => subscribers.delete(evt.sender))
    const key = watchKey(params.root, params.path)
    const existing = watchers.get(key)
    if (existing) { existing.refs += 1; return }
    // awaitWriteFinish debounces the half-written states most tools
    // produce (git checkout, agents streaming a Write tool) so the editor
    // sees one settled change, not three partial ones.
    const watcher = watch(key, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    })
    watcher.on('change', () => {
      void stat(key)
        .then(s => broadcast({ root: params.root, path: params.path, kind: 'change', mtimeMs: s.mtimeMs }))
        .catch(() => broadcast({ root: params.root, path: params.path, kind: 'change', mtimeMs: null }))
    })
    watcher.on('unlink', () => {
      broadcast({ root: params.root, path: params.path, kind: 'unlink', mtimeMs: null })
    })
    watchers.set(key, { watcher, refs: 1 })
  })

  ipcMain.handle('editor-fs:unwatch', async (_evt, params: { root: string; path: string }) => {
    const key = watchKey(params.root, params.path)
    const entry = watchers.get(key)
    if (!entry) return
    entry.refs -= 1
    if (entry.refs <= 0) {
      watchers.delete(key)
      await entry.watcher.close()
    }
  })
}
```

Path containment note: `watchKey` does NOT re-run `resolveInsideRoot` — add it (import from a small refactor: export `resolveInsideRoot` from `editorFs.ts`) so a malicious relative path can't watch files outside the root. Watching is read-signal only, but the containment invariant should hold everywhere uniformly.

- [ ] **Step 2: Register in `src/main/ipc/index.ts`** — `import { registerEditorFsWatchIpc } from '@main/ipc/editorFsWatch.js'` and call it next to `registerEditorFsIpc()` (line ~69).

- [ ] **Step 3: Shared type + preload**

Add `EditorFsChangeEvent` to `src/shared/types/editorFs.ts`. In `preload/api/editorFs.ts` add `editorWatchFile`/`editorUnwatchFile` invokes and `onEditorFileChanged` using the same multiplexed-subscriber pattern as `subscribeLspDiagnostics` in `preload/api/lsp.ts` (copy the pattern + its WHY comment, adapted).

- [ ] **Step 4: Renderer sync in GlobalEditorShell**

New effect — watch set follows the ACTIVE cwd's open files:

```tsx
// Keep main-process file watchers aligned with the open buffer set.
// Only the active cwd's buffers are watched: background cwd states are
// dormant (not rendered, not editable) and their buffers revalidate
// against disk on reactivation via openFileInGlobalEditor's
// read-on-open, so watching them would spend fs watchers on files
// nobody is looking at.
useEffect(() => {
  if (!open || !activeCwd) return
  const paths = cwdState.fileOrder
  for (const path of paths) void window.api.editorWatchFile({ root: activeCwd, path })
  return () => {
    for (const path of paths) void window.api.editorUnwatchFile({ root: activeCwd, path })
  }
}, [open, activeCwd, cwdState.fileOrder])

useEffect(() => {
  if (!open) return
  return window.api.onEditorFileChanged(event => {
    if (event.root !== activeCwd) return
    const buf = useGlobalEditorStore.getState().byCwd[event.root]?.openFiles[event.path]
    if (!buf) return
    if (event.kind === 'unlink') {
      setFileError(event.root, event.path, 'file was deleted on disk', { conflict: true })
      return
    }
    if (buf.dirty) {
      // Dirty buffer + external write = a real conflict the user must
      // resolve; the banner's Reload/Overwrite actions handle both arms.
      setFileError(event.root, event.path, 'file changed on disk while you have unsaved edits', { conflict: true })
      return
    }
    // Clean buffer: silently follow disk. This is what makes agent writes
    // show up live in an open tab.
    void window.api.editorReadTextFile({ root: event.root, path: event.path }).then(result => {
      if (result.ok) markFileSaved(event.root, event.path, result.text, result.mtimeMs)
    })
  })
}, [open, activeCwd, markFileSaved, setFileError])
```

(`markFileSaved` already sets `savedText`+`currentText`+clears dirty — correct semantics for "follow disk". The model updates through the existing `file?.currentText` effect in MonacoFileEditor.)

- [ ] **Step 5: Typecheck both + commit**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`

```bash
git add src/main/ipc src/shared/types/editorFs.ts src/preload/api/editorFs.ts src/renderer/src/features/global-editor/ui/GlobalEditorShell.tsx
git commit -m "feat(editor): file watcher — open buffers follow external writes, conflicts surface in banner (#513)"
```

---

### Task 10: Explorer mutations — new file / new folder / rename / delete + showHidden toggle

**Files:**
- Modify: `src/renderer/src/features/editor/ui/ExplorerPane.tsx`
- Modify: `src/renderer/src/features/global-editor/store.ts` (add `renameOpenFile`)

**Interfaces:**
- Consumes: existing `window.api.editorCreateFile/editorCreateDirectory/editorRename/editorDelete` (zero callers today).
- Produces (ExplorerPane props): `onOpenFile` unchanged; new optional prop `onFileRenamed?: (fromPath: string, toPath: string) => void` and `onFileDeleted?: (path: string) => void` so the host can fix up open buffers.
- Produces (store): `renameOpenFile(cwd: string, fromPath: string, toPath: string): void` — moves the buffer key, updates `path`/`absolutePath`, preserves dirty text; no-op if not open.

- [ ] **Step 1: Store action `renameOpenFile`**

```typescript
renameOpenFile: (cwd, fromPath, toPath) =>
  set(state => {
    const prev = state.byCwd[cwd]
    const buf = prev?.openFiles[fromPath]
    if (!prev || !buf) return state
    const nextFiles = { ...prev.openFiles }
    delete nextFiles[fromPath]
    nextFiles[toPath] = {
      ...buf,
      path: toPath,
      absolutePath: absolutePath(cwd, toPath),
      // Rename does not touch content — dirty text and undo-relevant
      // state ride along. mtime is still valid (rename preserves it on
      // POSIX) so the next save's conflict check stays meaningful.
    }
    return {
      byCwd: {
        ...state.byCwd,
        [cwd]: {
          fileOrder: prev.fileOrder.map(p => (p === fromPath ? toPath : p)),
          openFiles: nextFiles,
          activeFilePath: prev.activeFilePath === fromPath ? toPath : prev.activeFilePath,
        },
      },
    }
  }),
```

(Also dispose+reacquire the Monaco model for the old absolute path at the call site — the model URI embeds the path; simplest correct move: `disposeEditorModel(oldAbs)` and let the next mount recreate. Undo history is lost on rename; acceptable, note it.)

- [ ] **Step 2: ExplorerPane context menu + inline edit rows**

Implementation shape (all component-local state, no store):

```tsx
type MenuState = { x: number; y: number; entry: EditorFsEntry | null } | null  // null entry = root header menu
type EditState =
  | { kind: 'create-file' | 'create-dir'; parentPath: string; draft: string }
  | { kind: 'rename'; entry: EditorFsEntry; draft: string }
  | null
```

- Row `onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, entry }) }}`; root header gets a `+` button opening the same menu with `entry: null`.
- Menu renders `position: fixed` at x/y, `z-30`, closes on any click (window `mousedown` listener while open). Items: **New File**, **New Folder** (dirs + root), **Rename**, **Delete** (non-root).
- New File/Folder → `setEdit({ kind, parentPath: entry?.isDirectory ? entry.path : dirname(entry?.path ?? ''), draft: '' })`; renders an inline `<input>` row under the parent (autoFocus; Enter commits, Escape cancels).
- Commit handlers:

```tsx
const commitCreate = async (kind: 'create-file' | 'create-dir', parentPath: string, name: string) => {
  const path = parentPath ? `${parentPath}/${name}` : name
  const result = kind === 'create-file'
    ? await window.api.editorCreateFile({ root, path })
    : await window.api.editorCreateDirectory({ root, path })
  if (!result.ok) { setError(result.error); return }
  await loadDirectory(parentPath)
  if (kind === 'create-file') onOpenFile(result.path)
}

const commitRename = async (entry: EditorFsEntry, newName: string) => {
  const toPath = dirname(entry.path) ? `${dirname(entry.path)}/${newName}` : newName
  const result = await window.api.editorRename({ root, fromPath: entry.path, toPath })
  if (!result.ok) { setError(result.error); return }
  await loadDirectory(dirname(entry.path))
  onFileRenamed?.(entry.path, result.path)
}

const commitDelete = async (entry: EditorFsEntry) => {
  const result = await window.api.editorDelete({ root, path: entry.path })
  if (!result.ok) { setError(result.error); return }
  await loadDirectory(dirname(entry.path))
  onFileDeleted?.(entry.path)
}
```

- Delete confirms via the menu itself: first click turns the item into "Delete — click to confirm" (danger tone) instead of adding another modal (keep it cheap; comment the choice).
- showHidden: add `const [showHidden, setShowHidden] = useState(false)`, pass `showHidden` through `editorListDirectory`, add an eye/dot toggle button in the pane header. NOTE: `loadDirectory`'s dep array gains `showHidden`, and the reset effect already re-runs on `loadDirectory` identity change — verify the tree reloads on toggle. This also makes the stale comment in `editorFs.ts:33-35` true again.

- [ ] **Step 3: Host wiring in GlobalEditorShell**

```tsx
<ExplorerPane
  ...
  onFileRenamed={(fromPath, toPath) => {
    if (!activeCwd) return
    renameOpenFile(activeCwd, fromPath, toPath)
    disposeEditorModel(`${activeCwd.replace(/\/+$/, '')}/${fromPath.replace(/^\/+/, '')}`)
  }}
  onFileDeleted={path => {
    if (!activeCwd) return
    // Deleted on disk → force-close the buffer (the file is gone; keeping
    // a zombie tab that can only fail to save is worse than closing).
    closeFileAction(activeCwd, path, { force: true })
    disposeEditorModel(`${activeCwd.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`)
  }}
/>
```

(Pull `renameOpenFile` into the `useShallow` selector.)

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.web.json`

```bash
git add src/renderer/src/features/editor/ui/ExplorerPane.tsx src/renderer/src/features/global-editor
git commit -m "feat(editor): explorer context menu — create/rename/delete + showHidden toggle (#513)"
```

---

### Task 11: Quick Open (⌘P) — recursive file index + fuzzy overlay

**Files:**
- Modify: `src/main/ipc/editorFs.ts` (new handler)
- Modify: `src/shared/types/editorFs.ts`
- Modify: `src/preload/api/editorFs.ts`
- Create: `src/renderer/src/features/global-editor/ui/QuickOpenOverlay.tsx`
- Modify: `src/renderer/src/features/global-editor/store.ts` (`quickOpenOpen` flag)
- Modify: `src/renderer/src/features/global-editor/ui/GlobalEditorShell.tsx` (mount overlay)
- Modify: `src/renderer/src/workspace/tile-tree/useKeybinds.ts` (⌘P)

**Interfaces:**
- Produces (shared): `type EditorFsRecursiveListResult = { ok: true; files: string[]; truncated: boolean } | { ok: false; error: string }`
- Produces (preload): `editorListFilesRecursive(params: { root: string }): Promise<EditorFsRecursiveListResult>`
- Produces (store): `quickOpenOpen: boolean`, `setQuickOpenOpen(open: boolean)`.

- [ ] **Step 1: Recursive lister in main**

In `editorFs.ts` (reusing the module's ignore sets + containment):

```typescript
ipcMain.handle(
  'editor-fs:list-files-recursive',
  async (_evt, params: { root: string }): Promise<EditorFsRecursiveListResult> => {
    try {
      const root = resolve(params.root)
      const files: string[] = []
      // Hard cap. Quick-open ranks client-side over the whole list; 20k
      // relative paths ≈ a few MB of IPC — fine once, not fine unbounded
      // (a rogue root at / would otherwise walk the disk). `truncated`
      // lets the UI say "index incomplete" instead of silently lying.
      const LIMIT = 20_000
      const walk = async (dirAbs: string): Promise<void> => {
        if (files.length >= LIMIT) return
        const dirents = await readdir(dirAbs, { withFileTypes: true }).catch(() => [])
        for (const dirent of dirents) {
          if (files.length >= LIMIT) return
          if (dirent.name.startsWith('.')) continue
          if (dirent.isDirectory()) {
            if (EDITOR_IGNORED_DIR_NAMES.has(dirent.name)) continue
            await walk(join(dirAbs, dirent.name))
          } else {
            if (EDITOR_IGNORED_FILE_NAMES.has(dirent.name)) continue
            files.push(toProjectPath(root, join(dirAbs, dirent.name)))
          }
        }
      }
      await walk(root)
      return { ok: true, files, truncated: files.length >= LIMIT }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  },
)
```

Preload: add `editorListFilesRecursive` to `editorFsApi`. Shared: add the result type.

- [ ] **Step 2: Store flag** — add `quickOpenOpen: false` + `setQuickOpenOpen: (open: boolean) => set({ quickOpenOpen: open })` to the global-editor store (plus type).

- [ ] **Step 3: `QuickOpenOverlay.tsx`**

Behavior spec:
- Mounted by GlobalEditorShell when `open && quickOpenOpen`. Fixed-position centered panel (`fixed inset-0 z-40`, click-outside + Escape close via `setQuickOpenOpen(false)`).
- On mount: `editorListFilesRecursive({ root: activeCwd })` into local state (`files`, `truncated`); show a subtle "index truncated at 20k files" footer line when truncated.
- Ranking — reuse the palette's tiering idea adapted to paths (score basename separately from full path so `store` finds `store.ts` before `src/stores/deep/thing.ts`):

```typescript
import { fuzzyMatch } from '@renderer/features/command-palette/lib/rankCommands'

function scorePath(path: string, query: string): number {
  const q = query.toLowerCase()
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const full = path.toLowerCase()
  if (base.startsWith(q)) return 5
  if (base.includes(q)) return 4
  if (full.includes(q)) return 3
  if (fuzzyMatch(base, query)) return 2
  if (fuzzyMatch(full, query)) return 1
  return 0
}
```

Filter score>0, sort score desc → shorter path first → localeCompare; render top 50 (`slice` AFTER sort; comment why: bounded DOM, ranking already saw everything). Empty query → show nothing (not 20k rows).
- Keyboard: ArrowUp/Down move selection, Enter opens (`void openFileInGlobalEditor({ root: activeCwd, path: selected })` then close), input autoFocused. Rows show `<FileIcon name>` + basename + dim full path.

- [ ] **Step 4: Keybind + shell mount**

`useKeybinds.ts` — add near the ⌘⇧E branch (`:220`), following the file's branch pattern and updating the header doc list:

```typescript
// Cmd+P — Quick Open a file in the Global Editor. Opens the overlay
// (and the editor itself if it was closed: quick-open with nowhere to
// show the file would be a dead command).
if (cmd && !shift && !alt && k.toLowerCase() === 'p') {
  e.preventDefault()
  if (!globalEditorOpenRef.current) toggleGlobalEditor()
  useGlobalEditorStore.getState().setQuickOpenOpen(true)
  return
}
```

(Match how the file actually accesses `globalEditorOpen`/`toggleGlobalEditor` — read the surrounding code first; it pulls from app-state at `:107`. Add `useGlobalEditorStore` import.)

`GlobalEditorShell.tsx` — render `{quickOpenOpen && activeCwd && <QuickOpenOverlay root={activeCwd} onClose={() => setQuickOpenOpen(false)} />}` inside the outer container (pull the flag+setter into the selector).

- [ ] **Step 5: Typecheck both + commit**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`

```bash
git add -A src/main/ipc/editorFs.ts src/shared/types/editorFs.ts src/preload/api/editorFs.ts src/renderer/src
git commit -m "feat(editor): quick open (cmd+P) — recursive index + fuzzy ranking (#513)"
```

---

### Task 12: Project content search (⌘⇧F)

**Files:**
- Modify: `src/main/ipc/editorFs.ts` (new handler)
- Modify: `src/shared/types/editorFs.ts`
- Modify: `src/preload/api/editorFs.ts`
- Create: `src/renderer/src/features/global-editor/ui/ContentSearchOverlay.tsx`
- Modify: `src/renderer/src/features/global-editor/store.ts` (`contentSearchOpen` flag)
- Modify: `src/renderer/src/features/global-editor/ui/GlobalEditorShell.tsx`
- Modify: `src/renderer/src/workspace/tile-tree/useKeybinds.ts` (⌘⇧F)

**Interfaces:**
- Produces (shared):

```typescript
export type EditorFsSearchMatch = {
  path: string
  line: number          // 1-based (UI-facing)
  column: number        // 1-based
  preview: string       // the matched line, trimmed to ≤200 chars around the hit
}
export type EditorFsSearchResult =
  | { ok: true; matches: EditorFsSearchMatch[]; truncated: boolean; filesScanned: number }
  | { ok: false; error: string }
```

- Produces (preload): `editorSearchContent(params: { root: string; query: string; caseSensitive?: boolean }): Promise<EditorFsSearchResult>`

- [ ] **Step 1: Search handler in main**

In `editorFs.ts`:

```typescript
ipcMain.handle(
  'editor-fs:search-content',
  async (_evt, params: { root: string; query: string; caseSensitive?: boolean }): Promise<EditorFsSearchResult> => {
    try {
      const root = resolve(params.root)
      const query = params.query
      if (query.length < 2) return { ok: true, matches: [], truncated: false, filesScanned: 0 }
      const needle = params.caseSensitive ? query : query.toLowerCase()
      const matches: EditorFsSearchMatch[] = []
      let filesScanned = 0
      let truncated = false
      // Bounds. A JS scan of a typical repo (few thousand files after the
      // junk filter) lands well under a second; the caps are the fuse for
      // pathological roots. If real projects hit these limits routinely,
      // the follow-up is a ripgrep binary via the third_party manifest
      // pattern (#119/#120), NOT raising the caps.
      const MAX_MATCHES = 2_000
      const MAX_FILE_BYTES = 1_048_576 // skip >1MB files: generated bundles, lockfiles
      const MAX_FILES = 20_000
      const walk = async (dirAbs: string): Promise<void> => {
        if (truncated) return
        const dirents = await readdir(dirAbs, { withFileTypes: true }).catch(() => [])
        for (const dirent of dirents) {
          if (truncated) return
          if (dirent.name.startsWith('.')) continue
          const abs = join(dirAbs, dirent.name)
          if (dirent.isDirectory()) {
            if (EDITOR_IGNORED_DIR_NAMES.has(dirent.name)) continue
            await walk(abs)
            continue
          }
          if (EDITOR_IGNORED_FILE_NAMES.has(dirent.name)) continue
          if (filesScanned >= MAX_FILES) { truncated = true; return }
          filesScanned += 1
          const itemStat = await stat(abs).catch(() => null)
          if (!itemStat || itemStat.size > MAX_FILE_BYTES) continue
          const text = await readFile(abs, 'utf8').catch(() => null)
          if (text === null || text.includes(' ')) continue // binary sniff
          const haystackFull = params.caseSensitive ? text : text.toLowerCase()
          if (!haystackFull.includes(needle)) continue
          const lines = text.split('\n')
          for (let i = 0; i < lines.length; i++) {
            const hay = params.caseSensitive ? lines[i] : lines[i].toLowerCase()
            const col = hay.indexOf(needle)
            if (col === -1) continue
            matches.push({
              path: toProjectPath(root, abs),
              line: i + 1,
              column: col + 1,
              preview: lines[i].length > 200
                ? lines[i].slice(Math.max(0, col - 80), col + 120)
                : lines[i],
            })
            if (matches.length >= MAX_MATCHES) { truncated = true; break }
          }
        }
      }
      await walk(root)
      return { ok: true, matches, truncated, filesScanned }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  },
)
```

Preload + shared types as per Interfaces.

- [ ] **Step 2: `ContentSearchOverlay.tsx`**

Same shell pattern as QuickOpenOverlay (fixed panel, Escape/click-outside close). Contents:
- Query input (autoFocus) + case-sensitive toggle + result count / "truncated" note + `filesScanned` footer.
- Debounce 300ms after last keystroke → `editorSearchContent`; show spinner state while in flight; drop stale responses (generation counter — same pattern as `ExplorerPane.loadGenerationRef`).
- Results grouped by `path` (collapsible group header: FileIcon + path + match count), each match row: line number + `preview` with the hit substring wrapped in `<mark>`-styled span.
- Click/Enter on a match → `void openFileInGlobalEditor({ root, path: match.path, line: match.line, column: match.column })` then close. (The existing selection/reveal plumbing in the buffer handles the jump.)
- ArrowUp/Down navigate the flattened match list.

- [ ] **Step 3: Store flag + keybind + mount**

- Store: `contentSearchOpen: boolean` + setter (same as quick-open).
- `useKeybinds.ts`: `if (cmd && shift && !alt && k.toLowerCase() === 'f')` → preventDefault, open editor if closed, `setContentSearchOpen(true)`, return. FIRST verify ⌘⇧F is genuinely unbound: `grep -n "'f'" src/renderer/src/workspace/tile-tree/useKeybinds.ts` — if taken, fall back to `⌘⇧H` and note it in the command description.
- Shell: render overlay when `contentSearchOpen && activeCwd`.

- [ ] **Step 4: Typecheck both + commit**

```bash
git add -A src/main/ipc/editorFs.ts src/shared/types/editorFs.ts src/preload/api/editorFs.ts src/renderer/src
git commit -m "feat(editor): project content search (cmd+shift+F) with bounded main-process scan (#513)"
```

---

### Task 13: Fullscreen editor

**Files:**
- Modify: `src/renderer/src/features/global-editor/store.ts`
- Modify: `src/renderer/src/features/global-editor/ui/GlobalEditorShell.tsx`
- Modify: `src/renderer/src/workspace/tile-tree/useKeybinds.ts` (⌥⌘E)

**Interfaces:**
- Produces (store): `editorFullscreen: boolean`, `toggleEditorFullscreen(): void`, `setEditorFullscreen(on: boolean): void`.

- [ ] **Step 1: Store** — add the flag + actions (global, not per-cwd — same rationale as `fileTreeVisible`).

- [ ] **Step 2: Shell layout**

In `GlobalEditorShell` (after the `if (!open)` return):

```tsx
// Fullscreen: the editor takes the whole workspace area; the wrapped
// workspace stays MOUNTED but display:none. Unmounting would tear down
// every terminal/feed in the tab (scroll positions, xterm buffers,
// in-flight renders) just because the user wanted a big editor for a
// minute — display:none costs nothing and restores instantly.
const leftWidth = editorFullscreen
  ? '100%'
  : `calc(${leftPercent}% - ${SPLITTER_PX / 2}px)`
```

- Left pane div: `style={{ width: leftWidth }}`.
- Splitter + cursorLock: render only when `!editorFullscreen`.
- Right pane div: `style={editorFullscreen ? { display: 'none' } : { width: ... }}` (keep `{children}` inside).
- Escape exits fullscreen: window keydown listener effect active while `editorFullscreen` (`if (e.key === 'Escape' && no modal open) setEditorFullscreen(false)`) — guard: skip when quickOpenOpen/contentSearchOpen (those own Escape first; check their flags in the handler).

- [ ] **Step 3: Keybind** — `useKeybinds.ts`: `if (cmd && alt && !shift && k.toLowerCase() === 'e')` → preventDefault; if editor closed, open it AND set fullscreen; else `toggleEditorFullscreen()`. Update the header doc.

- [ ] **Step 4: Typecheck + commit**

```bash
git add src/renderer/src/features/global-editor src/renderer/src/workspace/tile-tree/useKeybinds.ts
git commit -m "feat(editor): fullscreen mode (alt+cmd+E, Esc to exit) (#513)"
```

---

### Task 14: Persistence — tabs + geometry survive restart (paths only, never contents)

**Files:**
- Create: `src/renderer/src/features/global-editor/lib/globalEditorPersistence.ts`
- Modify: `src/renderer/src/features/global-editor/store.ts`
- Modify: `src/renderer/src/features/global-editor/ui/GlobalEditorShell.tsx`

**Interfaces:**
- Produces: `loadPersistedGlobalEditorState(): PersistedGlobalEditorState | null`, `startGlobalEditorPersistence(): () => void` (subscribe; returns stop fn), where

```typescript
type PersistedGlobalEditorState = {
  version: 1
  splitterRatio: number
  fileTreeWidthPx: number
  fileTreeVisible: boolean
  tabsByCwd: Record<string, { fileOrder: string[]; activeFilePath: string | null }>
}
```

- [ ] **Step 1: Persistence module**

```typescript
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

// Global Editor persistence: geometry + open-tab PATHS per cwd.
//
// WHY localStorage and not a main-process persistence channel: the
// store's original header documents the risk ("every persistence path
// is a potential leak") specifically about UNSAVED FILE CONTENTS. This
// module never touches contents — it stores relative paths and three
// numbers. localStorage keeps it renderer-local, synchronous at boot
// (no IPC race with first paint), and trivially inspectable.
//
// WHY paths-only survives correctness review: on rehydrate the shell
// re-opens each path through openFileInGlobalEditor, which reads from
// disk — files that changed while the app was closed load fresh, files
// that were deleted simply fail to open and drop out. There is no
// stale-content class of bug because there is no persisted content.

const KEY = 'agent-code:global-editor:v1'
const MAX_CWDS = 20 // LRU-ish cap so a year of projects doesn't accrete unbounded

export function loadPersistedGlobalEditorState(): PersistedGlobalEditorState | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedGlobalEditorState
    if (parsed?.version !== 1) return null
    return parsed
  } catch {
    return null
  }
}

export function startGlobalEditorPersistence(): () => void {
  let timer: number | null = null
  const unsub = useGlobalEditorStore.subscribe(state => {
    if (timer !== null) return // trailing-edge debounce: one write per burst
    timer = window.setTimeout(() => {
      timer = null
      const s = useGlobalEditorStore.getState()
      const cwds = Object.keys(s.byCwd).slice(-MAX_CWDS)
      const tabsByCwd: PersistedGlobalEditorState['tabsByCwd'] = {}
      for (const cwd of cwds) {
        const cs = s.byCwd[cwd]
        if (!cs || cs.fileOrder.length === 0) continue
        tabsByCwd[cwd] = { fileOrder: cs.fileOrder, activeFilePath: cs.activeFilePath }
      }
      try {
        localStorage.setItem(KEY, JSON.stringify({
          version: 1,
          splitterRatio: s.splitterRatio,
          fileTreeWidthPx: s.fileTreeWidthPx,
          fileTreeVisible: s.fileTreeVisible,
          tabsByCwd,
        }))
      } catch { /* quota — drop silently; persistence is best-effort */ }
    }, 500)
  })
  return () => { unsub(); if (timer !== null) window.clearTimeout(timer) }
}
```

(Adjust `subscribe` usage to zustand v5's signature — plain `subscribe(listener)`.)

- [ ] **Step 2: Store hydration of geometry**

In `store.ts`, initialize geometry from persistence at store creation:

```typescript
const persisted = loadPersistedGlobalEditorState()
...
splitterRatio: clampSplitter(persisted?.splitterRatio ?? 0.5),
fileTreeWidthPx: clampFileTreeWidth(persisted?.fileTreeWidthPx ?? 260),
fileTreeVisible: persisted?.fileTreeVisible ?? true,
```

WATCH import cycle: persistence module imports the store, store imports `loadPersistedGlobalEditorState`. Break it by putting `loadPersistedGlobalEditorState` + the type in the persistence file WITHOUT importing the store at module scope (it already only uses the store inside `startGlobalEditorPersistence`, called later) — module-level cycle with only type/function references is fine in ESM as long as store creation doesn't call INTO a function that touches the store synchronously. `loadPersistedGlobalEditorState` doesn't → safe. Add a comment noting the cycle and why it's benign. Also update the store's header comment (the "in-memory only" paragraph) to describe the new paths-only persistence and keep the "never persist contents" invariant statement.

- [ ] **Step 3: Rehydrate tabs on cwd activation**

In `GlobalEditorShell`, extend the cwd-sync effect (or add a sibling): when the editor opens for a cwd whose `byCwd` state is empty but `tabsByCwd[cwd]` exists, re-open the persisted paths:

```tsx
const rehydratedCwdsRef = useRef<Set<string>>(new Set())
useEffect(() => {
  if (!open || !activeCwd) return
  if (rehydratedCwdsRef.current.has(activeCwd)) return
  rehydratedCwdsRef.current.add(activeCwd)
  const state = useGlobalEditorStore.getState()
  if ((state.byCwd[activeCwd]?.fileOrder.length ?? 0) > 0) return // live state wins
  const persisted = loadPersistedGlobalEditorState()?.tabsByCwd[activeCwd]
  if (!persisted) return
  void (async () => {
    // Sequential opens preserve fileOrder (parallel opens race the
    // store's append). Missing/renamed files fail silently — the read
    // errors and the tab simply doesn't come back, which is correct.
    for (const path of persisted.fileOrder) {
      await openFileInGlobalEditor({ root: activeCwd, path })
    }
    if (persisted.activeFilePath) {
      useGlobalEditorStore.getState().setActiveFile(activeCwd, persisted.activeFilePath)
    }
  })()
}, [open, activeCwd])
```

Note `openFileInGlobalEditor` calls `openGlobalEditor()` (already open — harmless) and sets active cwd (same cwd — harmless).

- [ ] **Step 4: Start persistence once** — in `GlobalEditorShell` (top-level effect, empty deps): `useEffect(() => startGlobalEditorPersistence(), [])`.

- [ ] **Step 5: Typecheck + commit**

```bash
git add src/renderer/src/features/global-editor
git commit -m "feat(editor): persist open-tab paths + geometry across restarts (contents never persisted) (#513)"
```

---

### Task 15: Editor-owned command module + palette/keybind registration

**Files:**
- Create: `src/renderer/src/features/global-editor/commands/globalEditorCommands.ts`
- Modify: `src/renderer/src/features/workspace/commands/layoutCommands.ts` (remove 5 commands)
- Modify: `src/renderer/src/features/command-palette/registry.ts`
- Modify: `src/renderer/src/features/command-palette/types.ts`
- Modify: `src/renderer/src/features/command-palette/ui/CommandPalette.tsx`

**Interfaces:**
- Consumes: existing `CommandDef`, `ui.toggleGlobalEditor`, `ui.toggleFileTreeVisible`, `ui.enterAiWorkspace*Mode`, flags `globalEditorOpen`/`fileTreeVisible`.
- Produces: `globalEditorCommands: CommandDef[]` registered in the registry; new flag `editorFullscreen: boolean` in `CommandContext.flags`.

- [ ] **Step 1: Create the module** — MOVE (verbatim, comments included) the five editor commands out of `layoutCommands.ts`: `toggle-global-editor`, `open-ai-workspace`, `create-ai-workspace`, `clear-ai-workspace`, `toggle-file-tree`. Add a module header:

```typescript
// Global Editor command module.
//
// WHY these live here and not in workspace/commands/layoutCommands: the
// palette registry aggregates per-FEATURE modules, and every other
// feature owns its commands (reader, spotlight, settings, …). Editor
// commands were squatting in the workspace feature because the editor
// predates the convention — which meant "where do I add an editor
// command" had no answer (#513 isolation). New editor commands go HERE.
```

Then ADD the new commands:

```typescript
{
  id: 'quick-open-file',
  surface: 'editor',
  title: 'Quick Open File',
  description: '**What it does:** Fuzzy-finds a file by name in the focused agent\'s project and opens it in the **Global Editor**.\n\n**Use when:** You know (roughly) the file name and don\'t want to click through the tree.\n\n**Notes:** Opens the editor overlay if it isn\'t already open. Index skips junk directories (node_modules, build output, VCS internals).\n\n**Shortcut:** ⌘P.',
  keywords: ['quick open', 'go to file', 'find file', 'fuzzy', 'open file', 'cmd+p'],
  shortcut: '⌘P',
  run: ({ ui, flags }) => {
    if (!flags.globalEditorOpen) ui.toggleGlobalEditor()
    useGlobalEditorStore.getState().setQuickOpenOpen(true)
  },
},
{
  id: 'search-in-files',
  surface: 'editor',
  title: 'Search in Files',
  description: '**What it does:** Searches file contents across the focused agent\'s project and opens matches in the **Global Editor** at the matched line.\n\n**Use when:** You\'re hunting a string/identifier across the project.\n\n**Notes:** Bounded scan (skips >1MB files, junk dirs; caps at 2k matches). Case-sensitivity toggle in the overlay.\n\n**Shortcut:** ⌘⇧F.',
  keywords: ['search', 'grep', 'find in files', 'content search', 'ripgrep'],
  shortcut: '⌘⇧F',
  run: ({ ui, flags }) => {
    if (!flags.globalEditorOpen) ui.toggleGlobalEditor()
    useGlobalEditorStore.getState().setContentSearchOpen(true)
  },
},
{
  id: 'toggle-editor-fullscreen',
  surface: 'editor',
  title: 'Editor Fullscreen',
  description: '**What it does:** Expands the **Global Editor** to fill the whole workspace area (the normal workspace stays alive underneath, just hidden).\n\n**Use when:** You want maximum reading/editing room for a while.\n\n**Notes:** Esc exits fullscreen. The previous split ratio is restored on exit.\n\n**Shortcut:** ⌥⌘E.',
  keywords: ['fullscreen', 'maximize', 'editor', 'zen', 'focus'],
  shortcut: '⌥⌘E',
  when: ({ flags }) => flags.globalEditorOpen,
  getState: ({ flags }) => ({
    label: flags.editorFullscreen ? 'On' : 'Off',
    tone: flags.editorFullscreen ? 'accent' : 'neutral',
  }),
  run: () => useGlobalEditorStore.getState().toggleEditorFullscreen(),
},
```

(Direct `useGlobalEditorStore.getState()` access matches the established pattern in the moved `toggle-global-editor` command — the store IS the editor feature's API here; no new ui-bridge methods needed beyond what exists.)

- [ ] **Step 2: Register + thread the new flag**

- `registry.ts`: import `globalEditorCommands` and add to `commandDefs` right after `...layoutCommands`.
- `types.ts` flags: add `editorFullscreen: boolean` (with a one-line doc comment).
- `CommandPalette.tsx`: `const editorFullscreen = useGlobalEditorStore(state => state.editorFullscreen)` next to the existing `fileTreeVisible` read (`:139`), add to the flags object at both places it's built (`:416` area and the dep array `:494` area — follow `fileTreeVisible` exactly).

- [ ] **Step 3: Typecheck + commit**

```bash
git add src/renderer/src/features
git commit -m "refactor(editor): editor-owned command module + quick-open/search/fullscreen commands (#513)"
```

---

### Task 16: Buffer-lifecycle dedup — `bufferOps` shared by Global Editor and AI Workspace

**Files:**
- Create: `src/renderer/src/features/editor/lib/bufferOps.ts`
- Modify: `src/renderer/src/features/global-editor/store.ts`
- Modify: `src/renderer/src/features/ai-workspace/ui/AiWorkspaceEditor.tsx`

**Interfaces:**
- Produces (pure functions over `EditorFileBuffer`):

```typescript
export function makeBuffer(params: {
  path: string; absolutePath: string; fileName: string
  text: string; mtimeMs: number | null
  selection?: { line: number; column: number } | null
}): EditorFileBuffer

export function withTextUpdate(buffer: EditorFileBuffer, text: string): EditorFileBuffer
export function withSaved(buffer: EditorFileBuffer, text: string, mtimeMs: number): EditorFileBuffer
export function withError(buffer: EditorFileBuffer, error: string | null, conflict?: boolean): EditorFileBuffer
```

- [ ] **Step 1: Create `bufferOps.ts`** — implementations are exactly the object-spread bodies currently duplicated in `global-editor/store.ts` (`createBuffer`, `updateFileText`'s spread, `markFileSaved`'s spread, `setFileError`'s spread) and `AiWorkspaceEditor.tsx` (`bufferFromEntry`, `updateText`, `saveActive` success/failure spreads). `makeBuffer` calls `normalizeCodeLanguage(null, fileName)` internally. Header comment:

```typescript
// Pure buffer-lifecycle transitions shared by the Global Editor store
// (zustand, per-cwd) and the AI Workspace editor (component-local state).
//
// WHY only the TRANSITIONS are shared and not a whole store: the two
// surfaces intentionally keep different state containers and IO adapters
// (root-contained editor-fs vs the AI Workspace registry — see the trust-
// boundary WHY on EditorWorkbench). What they kept re-implementing, and
// drifting on (dirty derivation, error/conflict clearing rules), is the
// buffer math itself. Pure functions capture exactly that overlap.
```

- [ ] **Step 2: Rewire both call sites** — `global-editor/store.ts`: `createBuffer` → `makeBuffer`; `updateFileText`/`markFileSaved`/`setFileError` bodies use `withTextUpdate`/`withSaved`/`withError` (keeping their WHY comments about error-clearing at the call site). `AiWorkspaceEditor.tsx`: `bufferFromEntry` → `makeBuffer`; `updateText` → `withTextUpdate`; `saveActive` result handling → `withSaved`/`withError`.

- [ ] **Step 3: Stale-comment hygiene (folds in issue item 17)** — in `global-editor/store.ts`, fix the three references to the deleted `features/editor/store.ts` (`:17-25`, `:191`, `:342-345`): rewrite to describe the CURRENT world (the old single-workspace Code Editor store was deleted; the semantics it pioneered — dirty-preserving reopen, dirty-close guard — live on here). In `editorFs.ts:33-35` the ExplorerPane showHidden claim became TRUE in Task 10 — verify wording still matches reality.

- [ ] **Step 4: Typecheck + commit**

```bash
git add src/renderer/src/features
git commit -m "refactor(editor): shared bufferOps for global-editor + ai-workspace; fix stale comments (#513)"
```

---

### Task 17: Final verification gate + PR

- [ ] **Step 1: Full typecheck, both projects** (the ONLY complete gate — build/vitest don't type-check):

Run: `cd .worktrees/editor-full-experience && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: zero errors.

- [ ] **Step 2: Existing test suite** (once, at the end — no per-task runs):

Run: `npm run test`
Expected: everything green (especially `monacoEditorTheme.renderer.test.ts` against the theme-controller refactor).

- [ ] **Step 3: Manual end-to-end pass** (use the `verify` skill / `npm run dev`):

1. ⌘⇧E → open a `.tsx` file → syntax colors present (bug 2 fixed); after ~2s semantic colors sharpen (LSP tokens).
2. Introduce a type error → red squiggle appears; hover it → diagnostic message; hover a symbol → type info.
3. ⌘-click / F12 a cross-file import → target file opens as a new tab at the right line.
4. Type in a file → close tab → confirm dialog appears; Discard closes; reopen → Save & Close writes.
5. Edit a file, then modify it externally (`echo x >> file` from a terminal) → conflict banner with Reload/Overwrite; on a CLEAN buffer the change appears automatically.
6. ⌘P → type partial filename → Enter opens. ⌘⇧F → search a known string → click a match → opens at line.
7. ⌥⌘E → fullscreen; Esc → restores split. Right-click in explorer → create/rename/delete a scratch file.
8. Restart the app → same tabs reopen (contents from disk), geometry restored.
9. Tab-switch between two files, undo (⌘Z) in the first → history intact.
10. Transcript code blocks still render as dark slabs while the editor is open (theme war fixed).

- [ ] **Step 4: Push + PR**

```bash
git push -u origin feat/editor-full-experience
gh pr create --title "Global Editor: full editor experience — LSP, search, fullscreen, working tabs (#513)" --body "Closes #513. <summary of the four root-cause fixes + feature list + verification notes>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Do NOT merge (user policy). Report the PR URL and stop.

---

## Execution Notes (post-implementation, 2026-07-09)

All 17 tasks executed on this branch. Deviations from the plan as written:

- **Task 2 (theme controller):** implemented as a shared refcount module (`lib/code/monacoThemeState.ts`) consulted by both existing theme owners, NOT the planned full `monacoThemeController.ts` consolidation. The existing renderer test (`monacoEditorTheme.renderer.test.ts`) pins the split-listener contract — the editor module must never call `setTheme` while inactive — and consolidation would have required rewriting the test to a new contract for zero additional behavior. The actual bug (getMonaco() re-asserting the slab theme on every call) is fixed either way.
- **Tasks 11/12 backend:** the recursive lister and content-search handlers landed inside `editorFs.ts` alongside the other handlers (same ignore lists, same containment) rather than a separate file — they are 2 more `ipcMain.handle` blocks, not a new subsystem.
- **Task 15:** `toggle-global-editor`'s description was updated to mention tab persistence (Task 14 changed the "not persisted across restarts" claim it used to make).
- Verification: `tsc` node+web clean; `npm run test` 481/481 passing (one pre-existing submodule suite failure, identical on `main`); `npm run build` (electron-vite production bundle) succeeds. Manual end-to-end checklist from Task 17 step 3 left for PR review — it needs a human driving the app window.

## Plan Self-Review Notes

- **Spec coverage vs issue #513:** A1→Task 1, A2→Task 2, A3→Task 3, A4→Task 4, B5→Task 6, B6→Task 7, B7/B8→Task 8, B8(models)→Task 5, C9→Task 9, C10→Task 10, C11→Task 11, C12→Task 12, C13→Task 13, C14→Task 14, D15→Task 15, D16/D17→Task 16. Out-of-scope list unchanged.
- **Known judgment calls encoded above:** LSP doc lifetime stays component-scoped (Task 8 note) — acceptable churn, documented; rename drops undo history (Task 10) — documented; content search is JS-scan with caps, rg is an explicit follow-up (Task 12); `references`/`documentSymbols` are wired at the protocol level and exposed via Monaco's built-in References peek (definition provider covers the main flow) — documentSymbol UI (outline/⇧⌘O) is NOT built in this PR (protocol groundwork only; add to follow-ups in the PR body).
- **Type-consistency spots to watch while implementing:** `closeFile` signature change ripples through `GlobalEditorStore` type + both workbench hosts; `setFileError` opts param has three call sites by Task 9; Monaco completion provider method is `provideCompletionItems` (NOT `provideCompletions`); zustand v5 `subscribe(listener)` signature in Task 14.
