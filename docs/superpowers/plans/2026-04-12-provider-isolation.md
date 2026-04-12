# Provider Isolation Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Claude and Codex into isolated provider directories that share UI primitives but never import each other, so editing one provider can't break the other.

**Architecture:** Each provider (`src/providers/claude/`, `src/providers/codex/`) exports a `ProviderConfig` consumed by the shell (`src/shell/`) through a registry. Shared building blocks live in `src/shared/`. The shell dispatches to providers at the `TileTree` level — each provider owns its own Feed, TileLeaf, and rows.

**Tech Stack:** TypeScript, React 18, Electron, electron-vite, Tailwind v4

**Spec:** `docs/superpowers/specs/2026-04-12-provider-isolation-refactor.md`

---

## File Map

### New files to create

| File | Purpose |
|------|---------|
| `src/shared/types/providerConfig.ts` | ProviderConfig interface + TileLeafProps/FeedProps types |
| `src/shared/types/session.ts` | SessionOptions, SessionInfo, base TerminalSession interface |
| `src/providers/registry.ts` | Provider lookup: `getProvider(id)`, `getAllProviders()` |
| `src/providers/claude/config.ts` | Claude's ProviderConfig export |
| `src/providers/codex/config.ts` | Codex's ProviderConfig export |
| `src/providers/claude/renderer/Feed.tsx` | Claude's feed (extracted from current Feed.tsx) |
| `src/providers/claude/renderer/TileLeaf.tsx` | Claude's pane (extracted from current TileLeaf.tsx) |
| `src/providers/codex/renderer/Feed.tsx` | Codex's feed |
| `src/providers/codex/renderer/TileLeaf.tsx` | Codex's pane |

### Files to move (rename, same content + import fixup)

| From | To |
|------|-----|
| `src/core/types/transcript.ts` | `src/shared/types/transcript.ts` |
| `src/core/types/claudeTranscript.ts` | `src/providers/claude/types/claudeTranscript.ts` |
| `src/core/types/codexTranscript.ts` | `src/providers/codex/types/codexTranscript.ts` |
| `src/core/runtime/jsonlTailer.ts` | `src/shared/runtime/jsonlTailer.ts` |
| `src/core/runtime/ptyScreen.ts` | `src/shared/runtime/ptyScreen.ts` |
| `src/core/runtime/projectDir.ts` | `src/shared/runtime/projectDir.ts` |
| `src/core/parsers/lineDiff.ts` | `src/shared/parsers/lineDiff.ts` |
| `src/core/parsers/extractAssistant.ts` | `src/shared/parsers/extractAssistant.ts` |
| `src/core/code/language.ts` | `src/shared/code/language.ts` |
| `src/core/runtime/claudeSession.ts` | `src/providers/claude/runtime/claudeSession.ts` |
| `src/core/runtime/sessionList.ts` | `src/providers/claude/runtime/sessionList.ts` |
| `src/core/parsers/claude/streamingScreen.ts` | `src/providers/claude/parsers/streamingScreen.ts` |
| `src/core/parsers/claude/trustDialog.ts` | `src/providers/claude/parsers/trustDialog.ts` |
| `src/core/parsers/claude/slashCommandPicker.ts` | `src/providers/claude/parsers/slashCommandPicker.ts` |
| `src/core/runtime/codexSession.ts` | `src/providers/codex/runtime/codexSession.ts` |
| `src/core/runtime/codexSessionList.ts` | `src/providers/codex/runtime/sessionList.ts` |
| `src/core/runtime/codexProjectDir.ts` | `src/providers/codex/runtime/projectDir.ts` |
| `src/core/parsers/codex/streamingScreen.ts` | `src/providers/codex/parsers/streamingScreen.ts` |
| `src/renderer/src/feed/claude/ClaudeRows.tsx` | `src/providers/claude/renderer/rows/ClaudeRows.tsx` |
| `src/renderer/src/feed/codex/CodexRows.tsx` | `src/providers/codex/renderer/rows/CodexRows.tsx` |
| `src/renderer/src/tiles/SlashCommandPicker.tsx` | `src/providers/claude/renderer/SlashCommandPicker.tsx` |
| `src/renderer/src/feed/TrustDialogModal.tsx` | `src/providers/claude/renderer/TrustDialogModal.tsx` |
| `src/renderer/src/feed/Feed.tsx` | `src/shared/ui/Feed.tsx` (shared primitives only — MarkerRow, LazyEntry, TextProse, etc.) |
| `src/renderer/src/code/CodeBlock.tsx` | `src/shared/code/CodeBlock.tsx` |
| `src/renderer/src/code/monacoRuntime.ts` | `src/shared/code/monacoRuntime.ts` |
| `src/renderer/src/feed/ThemePicker.tsx` | `src/shell/themes/ThemePicker.tsx` |
| `src/renderer/src/themes.ts` | `src/shell/themes/themes.ts` |
| `src/renderer/src/App.tsx` | `src/shell/App.tsx` |
| `src/renderer/src/CommandPalette.tsx` | `src/shell/CommandPalette.tsx` |
| `src/renderer/src/GitBar.tsx` | `src/shell/GitBar.tsx` |
| `src/renderer/src/tiles/TileTree.tsx` | `src/shell/tiles/TileTree.tsx` |
| `src/renderer/src/tiles/TabBar.tsx` | `src/shell/tiles/TabBar.tsx` |
| `src/renderer/src/tiles/PathPickerModal.tsx` | `src/shell/tiles/PathPickerModal.tsx` |
| `src/renderer/src/tiles/treeOps.ts` | `src/shell/tiles/treeOps.ts` |
| `src/renderer/src/tiles/types.ts` | `src/shell/tiles/types.ts` |
| `src/renderer/src/tiles/workspaceStore.ts` | `src/shell/tiles/workspaceStore.ts` |
| `src/renderer/src/tiles/useKeybinds.ts` | `src/shell/keybinds/useKeybinds.ts` |
| `src/renderer/src/tiles/TerminalLeaf.tsx` | `src/shell/tiles/TerminalLeaf.tsx` |
| `src/renderer/src/components/PathInput.tsx` | `src/shell/components/PathInput.tsx` |
| `src/renderer/src/lib/undoClose.ts` | `src/shell/lib/undoClose.ts` |
| `src/core/runtime/terminalSession.ts` | `src/shared/runtime/terminalSession.ts` |

### Files to modify in place (not moved, but updated)

| File | Change |
|------|--------|
| `src/main/sessionManager.ts` | Replace if/else branches with registry dispatch |
| `src/main/index.ts` | Update imports to new paths, dispatch via registry |
| `src/preload/index.ts` | Update imports to new paths |
| `src/renderer/src/main.tsx` | Update import of App to `src/shell/App` |
| `src/renderer/src/styles.css` | Stays in place (loaded by main.tsx) |

---

## Task 1: Create shared types and provider config interface

**Files:**
- Create: `src/shared/types/providerConfig.ts`
- Create: `src/shared/types/session.ts`

- [ ] **Step 1: Create the shared types directory and session interface**

```ts
// src/shared/types/session.ts

// Base session interface that all providers implement. The shell and
// main process only interact with sessions through this interface —
// never through provider-specific session classes directly.

export type SessionOptions = {
  cwd: string
  cols?: number
  rows?: number
  binary?: string
  env?: Record<string, string | undefined>
  snapshotIntervalMs?: number
  resumeSessionId?: string
}

export type SessionInfo = {
  sessionId: string
  summary: string
  lastModified: number
  fileSize: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  createdAt?: number
}
```

- [ ] **Step 2: Create the ProviderConfig interface**

```ts
// src/shared/types/providerConfig.ts

import type { ComponentType } from 'react'
import type { SessionOptions, SessionInfo } from './session.js'

// Props the shell passes to every provider's TileLeaf.
// The provider's TileLeaf composes these with its own state
// (slash mode, trust dialogs, etc.) — the shell doesn't know
// about any of that.
export type TileLeafProps = {
  sessionId: string
  runtime: unknown    // SessionRuntime — typed as unknown here to avoid
                      // circular deps; providers cast internally
  focused: boolean
  onFocusRequest: () => void
  workspace: unknown  // Workspace handle — same treatment
}

export type ProviderConfig = {
  /** Unique identifier stored in session metadata. */
  id: string
  /** Human-readable name for UI. */
  name: string

  // --- Runtime (main process) ---
  /** Factory: create a new session instance. Called from sessionManager. */
  createSession: (opts: SessionOptions) => unknown
  /** List resumable sessions for a cwd. Called from IPC handler. */
  listSessions: (cwd: string, limit: number) => Promise<SessionInfo[]>
  /** Resolve the on-disk project dir for a cwd. */
  getProjectDir: (cwd: string) => Promise<string>

  // --- Parsing (renderer) ---
  /** Extract the assistant's in-progress text from a screen snapshot. */
  extractAssistantInProgress: (screen: string) => string

  // --- Renderer ---
  /** The pane component mounted inside TileTree for this provider. */
  TileLeaf: ComponentType<TileLeafProps>
}
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/providerConfig.ts src/shared/types/session.ts
git commit -m "shared: add ProviderConfig interface and session types"
```

---

## Task 2: Move shared runtime utilities to src/shared/

**Files:**
- Move: `src/core/runtime/jsonlTailer.ts` → `src/shared/runtime/jsonlTailer.ts`
- Move: `src/core/runtime/ptyScreen.ts` → `src/shared/runtime/ptyScreen.ts`
- Move: `src/core/runtime/projectDir.ts` → `src/shared/runtime/projectDir.ts`
- Move: `src/core/runtime/terminalSession.ts` → `src/shared/runtime/terminalSession.ts`
- Move: `src/core/parsers/lineDiff.ts` → `src/shared/parsers/lineDiff.ts`
- Move: `src/core/parsers/extractAssistant.ts` → `src/shared/parsers/extractAssistant.ts`
- Move: `src/core/code/language.ts` → `src/shared/code/language.ts`
- Move: `src/core/types/transcript.ts` → `src/shared/types/transcript.ts`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p src/shared/runtime src/shared/parsers src/shared/code src/shared/ui src/shared/markdown src/shared/scroll
```

- [ ] **Step 2: Move each file with git mv**

```bash
git mv src/core/runtime/jsonlTailer.ts src/shared/runtime/jsonlTailer.ts
git mv src/core/runtime/ptyScreen.ts src/shared/runtime/ptyScreen.ts
git mv src/core/runtime/projectDir.ts src/shared/runtime/projectDir.ts
git mv src/core/runtime/terminalSession.ts src/shared/runtime/terminalSession.ts
git mv src/core/parsers/lineDiff.ts src/shared/parsers/lineDiff.ts
git mv src/core/parsers/extractAssistant.ts src/shared/parsers/extractAssistant.ts
git mv src/core/code/language.ts src/shared/code/language.ts
git mv src/core/types/transcript.ts src/shared/types/transcript.ts
```

- [ ] **Step 3: Fix all imports that referenced the old paths**

Search the entire `src/` tree for imports of each moved file and update them. Use the following mapping:

| Old import path segment | New import path segment |
|------------------------|------------------------|
| `core/runtime/jsonlTailer` | `shared/runtime/jsonlTailer` |
| `core/runtime/ptyScreen` | `shared/runtime/ptyScreen` |
| `core/runtime/projectDir` | `shared/runtime/projectDir` |
| `core/runtime/terminalSession` | `shared/runtime/terminalSession` |
| `core/parsers/lineDiff` | `shared/parsers/lineDiff` |
| `core/parsers/extractAssistant` | `shared/parsers/extractAssistant` |
| `core/code/language` | `shared/code/language` |
| `core/types/transcript` | `shared/types/transcript` |

For each file that imports one of these, update the relative path. Example: a file at `src/main/sessionManager.ts` that imports `../core/runtime/jsonlTailer` becomes `../shared/runtime/jsonlTailer`.

- [ ] **Step 4: Build to verify nothing is broken**

```bash
npm run build
```
Expected: clean build, no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "shared: move runtime utilities, parsers, and base types to src/shared/"
```

---

## Task 3: Move shared UI primitives to src/shared/

This task extracts the reusable building blocks from Feed.tsx into standalone files under `src/shared/`. Feed.tsx currently defines MarkerRow, LazyEntry, UserBand, ActivityIndicator, TextProse, StreamingProse, StreamingRow, and the markdown plugin config inline. These become shared imports that both providers' Feeds will use.

**Files:**
- Create: `src/shared/ui/MarkerRow.tsx`
- Create: `src/shared/ui/LazyEntry.tsx`
- Create: `src/shared/ui/UserBand.tsx`
- Create: `src/shared/ui/ActivityIndicator.tsx`
- Create: `src/shared/ui/StreamingRow.tsx`
- Create: `src/shared/ui/index.ts` (barrel export)
- Create: `src/shared/markdown/TextProse.tsx`
- Create: `src/shared/markdown/StreamingProse.tsx`
- Create: `src/shared/markdown/plugins.ts`
- Create: `src/shared/markdown/MarkdownComponents.tsx` (MarkdownPre, MarkdownCode)
- Create: `src/shared/markdown/index.ts` (barrel export)
- Create: `src/shared/scroll/useStickyScroll.ts`
- Move: `src/renderer/src/code/CodeBlock.tsx` → `src/shared/code/CodeBlock.tsx`
- Move: `src/renderer/src/code/monacoRuntime.ts` → `src/shared/code/monacoRuntime.ts`

- [ ] **Step 1: Extract MarkerRow into its own file**

Read the current `MarkerRow` function from `src/renderer/src/feed/Feed.tsx` and write it to `src/shared/ui/MarkerRow.tsx` as a named export. It has no provider-specific logic — it's pure layout (marker column + flex-1 content).

- [ ] **Step 2: Extract LazyEntry into its own file**

Read the current `LazyEntry` memo component from Feed.tsx (including the `EAGER_TAIL` constant) and write it to `src/shared/ui/LazyEntry.tsx`.

- [ ] **Step 3: Extract UserBand and ActivityIndicator**

Read `UserBand` and `ActivityIndicator` from Feed.tsx, write to `src/shared/ui/UserBand.tsx` and `src/shared/ui/ActivityIndicator.tsx`.

- [ ] **Step 4: Extract StreamingRow**

Read `StreamingRow` from Feed.tsx, write to `src/shared/ui/StreamingRow.tsx`. It imports `extractAssistantInProgress` from shared and `StreamingProse` from shared/markdown.

- [ ] **Step 5: Extract markdown primitives**

- `src/shared/markdown/plugins.ts` — the module-scope `COMPLETED_REMARK`, `STREAMING_REMARK` arrays.
- `src/shared/markdown/MarkdownComponents.tsx` — `MarkdownPre`, `MarkdownCode` components and the `MARKDOWN_COMPONENTS` object. These use `CodeBlock` from `src/shared/code/`.
- `src/shared/markdown/TextProse.tsx` — the memo'd `TextProse` component.
- `src/shared/markdown/StreamingProse.tsx` — the memo'd `StreamingProse` component.

- [ ] **Step 6: Extract useStickyScroll hook**

Read the scroll-position persistence logic from Feed.tsx (the `scrollPositions` map, `ScrollPosition` type, `useLayoutEffect` restore, scroll listener, auto-scroll effect) and extract into `src/shared/scroll/useStickyScroll.ts` as a reusable hook.

- [ ] **Step 7: Move CodeBlock and monacoRuntime**

```bash
git mv src/renderer/src/code/CodeBlock.tsx src/shared/code/CodeBlock.tsx
git mv src/renderer/src/code/monacoRuntime.ts src/shared/code/monacoRuntime.ts
```

- [ ] **Step 8: Create barrel exports**

```ts
// src/shared/ui/index.ts
export { MarkerRow } from './MarkerRow'
export { LazyEntry, EAGER_TAIL } from './LazyEntry'
export { UserBand } from './UserBand'
export { ActivityIndicator } from './ActivityIndicator'
export { StreamingRow } from './StreamingRow'
```

```ts
// src/shared/markdown/index.ts
export { TextProse } from './TextProse'
export { StreamingProse } from './StreamingProse'
export { COMPLETED_REMARK, STREAMING_REMARK } from './plugins'
export { MARKDOWN_COMPONENTS, MarkdownPre, MarkdownCode } from './MarkdownComponents'
```

- [ ] **Step 9: Update Feed.tsx to import from shared**

Replace all the inline definitions in Feed.tsx with imports from the shared barrel files. Feed.tsx should now only contain: `FeedImpl`, `EntryRow`, `ConversationRow`, `Block`, `ToolUseRow`, `ToolResultRow`, `SystemRow`, and the tool-use index logic. Everything else comes from `src/shared/`.

- [ ] **Step 10: Fix all imports referencing moved CodeBlock/monacoRuntime**

Update any file that imported from `../code/CodeBlock` or `../code/monacoRuntime` to the new `src/shared/code/` paths.

- [ ] **Step 11: Build to verify**

```bash
npm run build
```

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "shared: extract UI primitives, markdown components, scroll hook, and code rendering"
```

---

## Task 4: Move Claude-specific files to src/providers/claude/

**Files:**
- Move: `src/core/runtime/claudeSession.ts` → `src/providers/claude/runtime/claudeSession.ts`
- Move: `src/core/runtime/sessionList.ts` → `src/providers/claude/runtime/sessionList.ts`
- Move: `src/core/parsers/claude/streamingScreen.ts` → `src/providers/claude/parsers/streamingScreen.ts`
- Move: `src/core/parsers/claude/trustDialog.ts` → `src/providers/claude/parsers/trustDialog.ts`
- Move: `src/core/parsers/claude/slashCommandPicker.ts` → `src/providers/claude/parsers/slashCommandPicker.ts`
- Move: `src/core/types/claudeTranscript.ts` → `src/providers/claude/types/claudeTranscript.ts`
- Move: `src/renderer/src/feed/claude/ClaudeRows.tsx` → `src/providers/claude/renderer/rows/ClaudeRows.tsx`
- Move: `src/renderer/src/tiles/SlashCommandPicker.tsx` → `src/providers/claude/renderer/SlashCommandPicker.tsx`
- Move: `src/renderer/src/feed/TrustDialogModal.tsx` → `src/providers/claude/renderer/TrustDialogModal.tsx`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p src/providers/claude/runtime src/providers/claude/parsers src/providers/claude/types src/providers/claude/renderer/rows
```

- [ ] **Step 2: Move all Claude files with git mv**

```bash
git mv src/core/runtime/claudeSession.ts src/providers/claude/runtime/claudeSession.ts
git mv src/core/runtime/sessionList.ts src/providers/claude/runtime/sessionList.ts
git mv src/core/parsers/claude/streamingScreen.ts src/providers/claude/parsers/streamingScreen.ts
git mv src/core/parsers/claude/trustDialog.ts src/providers/claude/parsers/trustDialog.ts
git mv src/core/parsers/claude/slashCommandPicker.ts src/providers/claude/parsers/slashCommandPicker.ts
git mv src/core/types/claudeTranscript.ts src/providers/claude/types/claudeTranscript.ts
git mv src/renderer/src/feed/claude/ClaudeRows.tsx src/providers/claude/renderer/rows/ClaudeRows.tsx
git mv src/renderer/src/tiles/SlashCommandPicker.tsx src/providers/claude/renderer/SlashCommandPicker.tsx
git mv src/renderer/src/feed/TrustDialogModal.tsx src/providers/claude/renderer/TrustDialogModal.tsx
```

- [ ] **Step 3: Fix all imports in moved files and their consumers**

Every moved file's internal imports (to shared utilities, to each other) need updating. Every consumer that imported from the old paths needs updating too. Use the same search-and-replace approach as Task 2 Step 3.

- [ ] **Step 4: Build to verify**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "providers/claude: move runtime, parsers, types, and renderer to provider dir"
```

---

## Task 5: Move Codex-specific files to src/providers/codex/

**Files:**
- Move: `src/core/runtime/codexSession.ts` → `src/providers/codex/runtime/codexSession.ts`
- Move: `src/core/runtime/codexSessionList.ts` → `src/providers/codex/runtime/sessionList.ts`
- Move: `src/core/runtime/codexProjectDir.ts` → `src/providers/codex/runtime/projectDir.ts`
- Move: `src/core/parsers/codex/streamingScreen.ts` → `src/providers/codex/parsers/streamingScreen.ts`
- Move: `src/core/types/codexTranscript.ts` → `src/providers/codex/types/codexTranscript.ts`
- Move: `src/renderer/src/feed/codex/CodexRows.tsx` → `src/providers/codex/renderer/rows/CodexRows.tsx`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p src/providers/codex/runtime src/providers/codex/parsers src/providers/codex/types src/providers/codex/renderer/rows
```

- [ ] **Step 2: Move all Codex files with git mv**

```bash
git mv src/core/runtime/codexSession.ts src/providers/codex/runtime/codexSession.ts
git mv src/core/runtime/codexSessionList.ts src/providers/codex/runtime/sessionList.ts
git mv src/core/runtime/codexProjectDir.ts src/providers/codex/runtime/projectDir.ts
git mv src/core/parsers/codex/streamingScreen.ts src/providers/codex/parsers/streamingScreen.ts
git mv src/core/types/codexTranscript.ts src/providers/codex/types/codexTranscript.ts
git mv src/renderer/src/feed/codex/CodexRows.tsx src/providers/codex/renderer/rows/CodexRows.tsx
```

- [ ] **Step 3: Fix all imports**

Same approach as Task 4 Step 3.

- [ ] **Step 4: Build to verify**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "providers/codex: move runtime, parsers, types, and renderer to provider dir"
```

---

## Task 6: Create provider-specific Feed and TileLeaf for Claude

The current `Feed.tsx` and `TileLeaf.tsx` contain Claude-specific logic (trust dialog, slash picker, Claude row rendering). Extract Claude's version into `src/providers/claude/renderer/`.

**Files:**
- Create: `src/providers/claude/renderer/Feed.tsx`
- Create: `src/providers/claude/renderer/TileLeaf.tsx`

- [ ] **Step 1: Create Claude's Feed.tsx**

Copy the current Feed.tsx's `FeedImpl` function, `EntryRow`, `ConversationRow`, `Block`, `ToolUseRow`, `ToolResultRow`, `SystemRow`, and `buildToolUseIndex` into `src/providers/claude/renderer/Feed.tsx`. Replace inline primitive definitions with imports from `src/shared/ui/` and `src/shared/markdown/`. Import `ClaudeRows` from `./rows/ClaudeRows`. Remove all Codex-specific imports and branches. Export as `ClaudeFeed`.

- [ ] **Step 2: Create Claude's TileLeaf.tsx**

Copy the current TileLeaf.tsx into `src/providers/claude/renderer/TileLeaf.tsx`. It keeps: the composer input, slash mode logic, trust dialog rendering, streaming baseline capture, `extractAssistantInProgress` calls (using Claude's parser). Import Feed from `./Feed`. Import shared primitives from `src/shared/`. Remove any Codex-specific code paths. Export as `ClaudeTileLeaf`.

- [ ] **Step 3: Build to verify**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "providers/claude: create Claude-specific Feed and TileLeaf"
```

---

## Task 7: Create provider-specific Feed and TileLeaf for Codex

Same as Task 6 but for Codex.

**Files:**
- Create: `src/providers/codex/renderer/Feed.tsx`
- Create: `src/providers/codex/renderer/TileLeaf.tsx`

- [ ] **Step 1: Create Codex's Feed.tsx**

Similar structure to Claude's but uses `CodexRows` from `./rows/CodexRows`. No trust dialog context, no slash picker context. Import shared primitives from `src/shared/`. Export as `CodexFeed`.

- [ ] **Step 2: Create Codex's TileLeaf.tsx**

Similar to Claude's but: no slash mode, no trust dialog, includes Codex-specific optimistic user entry injection if present. Import Feed from `./Feed`. Export as `CodexTileLeaf`.

- [ ] **Step 3: Build to verify**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "providers/codex: create Codex-specific Feed and TileLeaf"
```

---

## Task 8: Create provider configs and registry

**Files:**
- Create: `src/providers/claude/config.ts`
- Create: `src/providers/codex/config.ts`
- Create: `src/providers/registry.ts`

- [ ] **Step 1: Create Claude's config**

```ts
// src/providers/claude/config.ts
import type { ProviderConfig } from '../../shared/types/providerConfig'
import { ClaudeSession } from './runtime/claudeSession'
import { listSessionsForCwd } from './runtime/sessionList'
import { getProjectDirForCwd } from '../../shared/runtime/projectDir'
import { extractAssistantInProgress } from './parsers/streamingScreen'
import { ClaudeTileLeaf } from './renderer/TileLeaf'

export const claudeConfig: ProviderConfig = {
  id: 'claude',
  name: 'Claude Code',
  createSession: (opts) => new ClaudeSession(opts),
  listSessions: listSessionsForCwd,
  getProjectDir: getProjectDirForCwd,
  extractAssistantInProgress,
  TileLeaf: ClaudeTileLeaf,
}
```

- [ ] **Step 2: Create Codex's config**

```ts
// src/providers/codex/config.ts
import type { ProviderConfig } from '../../shared/types/providerConfig'
import { CodexSession } from './runtime/codexSession'
import { listSessionsForCwd } from './runtime/sessionList'
import { getCodexProjectDir } from './runtime/projectDir'
import { extractCodexAssistantInProgress } from './parsers/streamingScreen'
import { CodexTileLeaf } from './renderer/TileLeaf'

export const codexConfig: ProviderConfig = {
  id: 'codex',
  name: 'Codex',
  createSession: (opts) => new CodexSession(opts),
  listSessions: listSessionsForCwd,
  getProjectDir: getCodexProjectDir,
  extractAssistantInProgress: extractCodexAssistantInProgress,
  TileLeaf: CodexTileLeaf,
}
```

- [ ] **Step 3: Create the registry**

```ts
// src/providers/registry.ts
import type { ProviderConfig } from '../shared/types/providerConfig'
import { claudeConfig } from './claude/config'
import { codexConfig } from './codex/config'

const providers: Record<string, ProviderConfig> = {
  claude: claudeConfig,
  codex: codexConfig,
}

export function getProvider(id: string): ProviderConfig {
  const p = providers[id]
  if (!p) throw new Error(`Unknown provider: ${id}`)
  return p
}

export function getAllProviders(): ProviderConfig[] {
  return Object.values(providers)
}
```

- [ ] **Step 4: Build to verify**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "providers: add config objects and registry"
```

---

## Task 9: Move shell files to src/shell/

**Files:**
- Move: `src/renderer/src/App.tsx` → `src/shell/App.tsx`
- Move: `src/renderer/src/CommandPalette.tsx` → `src/shell/CommandPalette.tsx`
- Move: `src/renderer/src/GitBar.tsx` → `src/shell/GitBar.tsx`
- Move: `src/renderer/src/feed/ThemePicker.tsx` → `src/shell/themes/ThemePicker.tsx`
- Move: `src/renderer/src/themes.ts` → `src/shell/themes/themes.ts`
- Move: `src/renderer/src/tiles/TileTree.tsx` → `src/shell/tiles/TileTree.tsx`
- Move: `src/renderer/src/tiles/TabBar.tsx` → `src/shell/tiles/TabBar.tsx`
- Move: `src/renderer/src/tiles/PathPickerModal.tsx` → `src/shell/tiles/PathPickerModal.tsx`
- Move: `src/renderer/src/tiles/treeOps.ts` → `src/shell/tiles/treeOps.ts`
- Move: `src/renderer/src/tiles/types.ts` → `src/shell/tiles/types.ts`
- Move: `src/renderer/src/tiles/workspaceStore.ts` → `src/shell/tiles/workspaceStore.ts`
- Move: `src/renderer/src/tiles/useKeybinds.ts` → `src/shell/keybinds/useKeybinds.ts`
- Move: `src/renderer/src/tiles/TerminalLeaf.tsx` → `src/shell/tiles/TerminalLeaf.tsx`
- Move: `src/renderer/src/components/PathInput.tsx` → `src/shell/components/PathInput.tsx`
- Move: `src/renderer/src/lib/undoClose.ts` → `src/shell/lib/undoClose.ts`
- Keep: `src/renderer/src/main.tsx` (entry point, stays in place, update App import)
- Keep: `src/renderer/src/styles.css` (loaded by main.tsx)
- Keep: `src/renderer/src/vite-env.d.ts`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p src/shell/themes src/shell/tiles src/shell/keybinds src/shell/components src/shell/lib
```

- [ ] **Step 2: Move all shell files with git mv**

```bash
git mv src/renderer/src/App.tsx src/shell/App.tsx
git mv src/renderer/src/CommandPalette.tsx src/shell/CommandPalette.tsx
git mv src/renderer/src/GitBar.tsx src/shell/GitBar.tsx
git mv src/renderer/src/feed/ThemePicker.tsx src/shell/themes/ThemePicker.tsx
git mv src/renderer/src/themes.ts src/shell/themes/themes.ts
git mv src/renderer/src/tiles/TileTree.tsx src/shell/tiles/TileTree.tsx
git mv src/renderer/src/tiles/TabBar.tsx src/shell/tiles/TabBar.tsx
git mv src/renderer/src/tiles/PathPickerModal.tsx src/shell/tiles/PathPickerModal.tsx
git mv src/renderer/src/tiles/treeOps.ts src/shell/tiles/treeOps.ts
git mv src/renderer/src/tiles/types.ts src/shell/tiles/types.ts
git mv src/renderer/src/tiles/workspaceStore.ts src/shell/tiles/workspaceStore.ts
git mv src/renderer/src/tiles/useKeybinds.ts src/shell/keybinds/useKeybinds.ts
git mv src/renderer/src/tiles/TerminalLeaf.tsx src/shell/tiles/TerminalLeaf.tsx
git mv src/renderer/src/components/PathInput.tsx src/shell/components/PathInput.tsx
git mv src/renderer/src/lib/undoClose.ts src/shell/lib/undoClose.ts
```

- [ ] **Step 3: Fix all imports**

Update all imports in moved files and their consumers. Key changes:
- `src/renderer/src/main.tsx`: update `import App from './App'` → `import App from '../../shell/App'`
- Every file that imported from `../tiles/workspaceStore` etc. needs path adjustment

- [ ] **Step 4: Build to verify**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "shell: move app chrome, tiles, themes, keybinds to src/shell/"
```

---

## Task 10: Wire TileTree to use provider registry

The critical integration step: TileTree stops importing `TileLeaf` directly and instead looks up the provider's TileLeaf from the registry.

**Files:**
- Modify: `src/shell/tiles/TileTree.tsx`

- [ ] **Step 1: Update TileTree to dispatch via provider config**

Replace the hardcoded `<TileLeaf>` import with a dynamic lookup:

```tsx
// src/shell/tiles/TileTree.tsx
import { getProvider } from '../../providers/registry'
import { TerminalLeaf } from './TerminalLeaf'
// Remove: import { TileLeaf } from './TileLeaf'

export function TileTree({ node, focusedSessionId, workspace }: Props) {
  if (node.type === 'leaf') {
    const meta = workspace.state.sessions[node.sessionId]
    const kind = meta?.kind ?? 'claude'

    if (kind === 'terminal') {
      return (
        <TerminalLeaf
          sessionId={node.sessionId}
          focused={node.sessionId === focusedSessionId}
          onFocusRequest={() => workspace.focusSession(node.sessionId)}
          workspace={workspace}
        />
      )
    }

    // Provider dispatch: look up the config and mount its TileLeaf.
    // The shell never imports provider-specific code directly —
    // only through the registry.
    const provider = getProvider(kind)
    const runtime = workspace.getRuntime(node.sessionId)
    const LeafComponent = provider.TileLeaf
    return (
      <LeafComponent
        sessionId={node.sessionId}
        runtime={runtime}
        focused={node.sessionId === focusedSessionId}
        onFocusRequest={() => workspace.focusSession(node.sessionId)}
        workspace={workspace}
      />
    )
  }
  // ... rest of SplitContainer unchanged
}
```

- [ ] **Step 2: Build to verify**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "shell: TileTree dispatches to provider TileLeaf via registry"
```

---

## Task 11: Wire sessionManager to use provider registry

Replace the if/else branches in sessionManager.ts with registry-based dispatch.

**Files:**
- Modify: `src/main/sessionManager.ts`

- [ ] **Step 1: Refactor sessionManager to use provider configs**

Replace the explicit `ClaudeSession` / `CodexSession` imports and if/else spawn logic with:

```ts
import { getProvider } from '../providers/registry'

// In spawn():
const provider = getProvider(kind)
const session = provider.createSession({
  cwd,
  cols,
  rows,
  resumeSessionId,
  // ... other opts
})
```

The event wiring (`session.on('screen', ...)`, `session.on('jsonl-entry', ...)`, etc.) stays the same — it's provider-agnostic because all sessions implement the same event interface.

- [ ] **Step 2: Update main/index.ts IPC handlers**

Replace provider branching in the `session:list-for-cwd` handler:

```ts
const provider = getProvider(providerParam)
const sessions = await provider.listSessions(cwd, limit)
```

- [ ] **Step 3: Build to verify**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "main: sessionManager and IPC dispatch through provider registry"
```

---

## Task 12: Remove workspaceStore provider imports

The workspace store currently imports `detectActivity` from Claude's parser and `extractAssistantInProgress` from the shared parser. After the refactor, screen parsing should go through the provider config.

**Files:**
- Modify: `src/shell/tiles/workspaceStore.ts`

- [ ] **Step 1: Remove direct parser imports**

Replace `detectActivity` and `extractAssistantInProgress` imports with provider-config-based dispatch. The store knows each session's provider id (from `SessionMeta.kind`), so it can call `getProvider(kind).extractAssistantInProgress(screen)`.

- [ ] **Step 2: Build to verify**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "shell: workspaceStore dispatches screen parsing through provider config"
```

---

## Task 13: Delete old src/core/ directory and the old renderer Feed/TileLeaf

After all files have been moved, the old locations should be empty or contain only the moved-from stubs. Clean them up.

**Files:**
- Delete: `src/core/` (should be empty after moves)
- Delete: `src/renderer/src/feed/Feed.tsx` (replaced by provider-specific Feeds)
- Delete: `src/renderer/src/tiles/TileLeaf.tsx` (replaced by provider-specific TileLeafs)
- Delete: `src/renderer/src/feed/claude/` (moved)
- Delete: `src/renderer/src/feed/codex/` (moved)

- [ ] **Step 1: Verify nothing imports from old paths**

```bash
grep -r "from.*core/" src/ --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v '.d.ts'
grep -r "from.*feed/Feed" src/ --include='*.ts' --include='*.tsx'
grep -r "from.*tiles/TileLeaf" src/ --include='*.ts' --include='*.tsx'
```

Expected: no matches (all imports updated in previous tasks).

- [ ] **Step 2: Delete old directories and files**

```bash
rm -rf src/core/
rm -f src/renderer/src/feed/Feed.tsx
rm -f src/renderer/src/tiles/TileLeaf.tsx
rm -rf src/renderer/src/feed/claude/
rm -rf src/renderer/src/feed/codex/
rm -rf src/renderer/src/tiles/SlashCommandPicker.tsx
rm -rf src/renderer/src/feed/TrustDialogModal.tsx
rm -rf src/renderer/src/code/
```

- [ ] **Step 3: Build to verify nothing is broken**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "cleanup: remove old src/core/ and migrated renderer files"
```

---

## Task 14: Update electron-vite config and tsconfig if needed

The electron-vite config and tsconfigs may reference `src/core/` or `src/renderer/src/` paths that no longer exist.

**Files:**
- Check: `electron.vite.config.ts`
- Check: `tsconfig.json`, `tsconfig.web.json`, `tsconfig.node.json`

- [ ] **Step 1: Check and fix vite config**

Read `electron.vite.config.ts`. If it references `src/core/` as an alias or include path, update to `src/shared/` + `src/providers/` + `src/shell/`.

- [ ] **Step 2: Check and fix tsconfigs**

Ensure `tsconfig.web.json` includes the new directories for the renderer build. Ensure `tsconfig.node.json` includes the new directories for the main process build. Both `src/shared/` and `src/providers/` contain files used by both build targets.

- [ ] **Step 3: Build to verify**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "config: update vite and tsconfig paths for new directory structure"
```

---

## Task 15: Add import boundary enforcement

**Files:**
- Create: `scripts/check-imports.sh` (or add to CI)

- [ ] **Step 1: Write a grep-based import check**

```bash
#!/bin/bash
# scripts/check-imports.sh
# Fails if any provider imports from another provider.

set -e

echo "Checking: Claude must not import from Codex..."
if grep -r "from.*providers/codex" src/providers/claude/ --include='*.ts' --include='*.tsx' 2>/dev/null; then
  echo "FAIL: Claude imports from Codex"
  exit 1
fi

echo "Checking: Codex must not import from Claude..."
if grep -r "from.*providers/claude" src/providers/codex/ --include='*.ts' --include='*.tsx' 2>/dev/null; then
  echo "FAIL: Codex imports from Claude"
  exit 1
fi

echo "Checking: shared must not import from providers or shell..."
if grep -r "from.*providers/" src/shared/ --include='*.ts' --include='*.tsx' 2>/dev/null; then
  echo "FAIL: shared imports from providers"
  exit 1
fi
if grep -r "from.*shell/" src/shared/ --include='*.ts' --include='*.tsx' 2>/dev/null; then
  echo "FAIL: shared imports from shell"
  exit 1
fi

echo "All import boundaries clean."
```

- [ ] **Step 2: Run it**

```bash
chmod +x scripts/check-imports.sh
./scripts/check-imports.sh
```

Expected: "All import boundaries clean."

- [ ] **Step 3: Commit**

```bash
git add scripts/check-imports.sh
git commit -m "ci: add import boundary check script"
```
