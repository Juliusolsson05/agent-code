# Provider Isolation Refactor

**Date:** 2026-04-12
**Status:** Approved design, pending implementation plan

## Problem

Claude and Codex implementations are entangled throughout the codebase. Working on Codex has broken Claude because provider-specific code shares files, functions, and state with no enforced boundary. Key coupling points:

- `sessionManager.ts` — if/else branches for Claude vs Codex spawn logic
- `main/index.ts` — IPC handlers branch on provider parameter
- `workspaceStore.ts` — mixed provider state management
- `TileLeaf.tsx` — runtime provider branching for parsers and optimistic entries
- `Feed.tsx` — imports both ClaudeRows and CodexRows

Both providers will grow significantly (50+ custom commands and renderers each). The current structure cannot support that without constant cross-contamination.

## Solution

Isolate Claude and Codex into separate provider directories that never import each other. Both providers import from a shared layer of UI primitives and runtime utilities. The shell (app chrome, tabs, keybinds, themes) imports providers through a thin registry — never directly.

## Directory Structure

```
src/
  providers/
    claude/
      runtime/           claudeSession.ts, sessionList.ts, projectDir.ts
      parsers/           streamingScreen.ts, trustDialog.ts, slashPicker.ts
      types/             claudeTranscript.ts
      renderer/
        Feed.tsx         Claude's own feed (composes shared primitives)
        TileLeaf.tsx     Claude's pane (input, slash mode, trust dialog)
        rows/            EditRow, WriteRow, TodoRow, ToolUseRow, ToolResultRow, ...
        SlashCommandPicker.tsx
        TrustDialogModal.tsx
      config.ts          ProviderConfig export
    codex/
      runtime/           codexSession.ts, sessionList.ts, projectDir.ts
      parsers/           streamingScreen.ts
      types/             codexTranscript.ts
      renderer/
        Feed.tsx         Codex's own feed
        TileLeaf.tsx     Codex's pane
        rows/            CodexToolRow, ... (will grow to 50+)
      config.ts          ProviderConfig export

  shared/
    ui/                  MarkerRow, LazyEntry, UserBand, ActivityIndicator
    markdown/            TextProse, StreamingProse, ReactMarkdown plugin config
    code/                CodeBlock, monacoRuntime, language detection, LSP bridge
    scroll/              useStickyScroll hook, scroll position persistence
    types/               transcript base types (Entry, ContentBlock, ToolUseBlock, etc.)
    runtime/             jsonlTailer, ptyScreen, lineDiff, base session interface

  shell/                 App chrome — provider-agnostic
    App.tsx
    tiles/               TileTree, TabBar, PathPickerModal, treeOps, types
    themes/              ThemePicker, themes.ts, styles.css
    keybinds/            useKeybinds
    workspaceStore.ts
    CommandPalette.tsx

  main/                  Electron main process
    index.ts             IPC handlers — dispatches via provider config
    sessionManager.ts    Uses provider config to create sessions

  preload/
    index.ts             IPC bridge — provider-agnostic API surface
```

## Provider Config Interface

Each provider exports a single config object. This is the only thing the shell knows about a provider.

```ts
// src/shared/types/providerConfig.ts

import type { ComponentType } from 'react'

type ProviderConfig = {
  /** Unique identifier used in state, IPC, and persistence. */
  id: string
  /** Human-readable name for UI display. */
  name: string

  // --- Runtime ---
  /** Factory: create a new session instance for this provider. */
  createSession: (opts: SessionOptions) => TerminalSession
  /** List resumable sessions for a given cwd. */
  listSessions: (cwd: string, limit: number) => Promise<SessionInfo[]>
  /** Resolve the on-disk project dir for a cwd. */
  getProjectDir: (cwd: string) => Promise<string>

  // --- Parsing ---
  /** Extract the assistant's in-progress text from a screen snapshot. */
  extractAssistantInProgress: (screen: string) => string

  // --- Renderer ---
  /** The pane component the shell mounts inside TileTree. */
  TileLeaf: ComponentType<TileLeafProps>
  /** The feed component rendered inside the provider's TileLeaf. */
  Feed: ComponentType<FeedProps>
}
```

The interface is deliberately thin. Providers are complex internally (trust dialogs, slash pickers, 50+ tool renderers), but the shell doesn't know about any of that. If Claude needs a slash command picker, Claude's TileLeaf renders it. The shell just mounts `config.TileLeaf` and gets out of the way.

Adding a third provider means exporting one more config object and adding it to the registry.

## Provider Registry

```ts
// src/providers/registry.ts
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

The shell imports from `registry.ts` only — never from `./claude/` or `./codex/` directly. This is the firewall.

## Shared Building Blocks

Components and utilities in `src/shared/` that both providers consume. Using the same building blocks is what keeps the UI/UX visually identical across providers.

### UI Primitives (`shared/ui/`)
- **MarkerRow** — the `❯`/`⏺`/`⎿` hanging-indent layout used by every entry type
- **LazyEntry** — IntersectionObserver placeholder wrapper for deferred mounting
- **UserBand** — subtle background highlight behind user prompt entries
- **ActivityIndicator** — spinner with verb text ("Thinking...", "Crunching...")

### Markdown Rendering (`shared/markdown/`)
- **TextProse** — ReactMarkdown with remark-gfm, memo'd by text string. Used for completed JSONL entries.
- **StreamingProse** — same but with remark-breaks for screen buffer text where hard newlines are load-bearing.
- **Plugin config** — module-scope COMPLETED_REMARK, STREAMING_REMARK arrays, shared ReactMarkdown component overrides.

### Code Rendering (`shared/code/`)
- **CodeBlock** — Monaco-backed syntax-highlighted code block with copy button, language label, and LSP integration.
- **monacoRuntime** — lazy Monaco editor loader and configuration.
- **language.ts** — language detection and mapping utilities.

### Scroll Logic (`shared/scroll/`)
- **useStickyScroll** — hook that tracks sticky-bottom state, persists scroll position per session, and auto-scrolls on new content only when the user is at the bottom.
- **scrollPositions** — module-level Map for cross-mount scroll persistence.

### Base Types (`shared/types/`)
- **transcript.ts** — Entry, ContentBlock, ConversationEntry, ToolUseBlock, ToolResultBlock, Message, isConversationEntry. The union types that both providers' transcript formats conform to.
- **providerConfig.ts** — the ProviderConfig interface itself.
- **session.ts** — TerminalSession base interface, SessionOptions, SessionInfo, SessionRuntime.

### Runtime Utilities (`shared/runtime/`)
- **jsonlTailer.ts** — chokidar-based JSONL file watcher with line-by-line parsing.
- **ptyScreen.ts** — headless terminal (@xterm/headless) snapshot and markdown reconstruction.
- **lineDiff.ts** — generic line-level diff for tool result display.

## Data Flow

```
App.tsx (shell)
  → workspaceStore (provider-agnostic: tabs, sessions, runtimes)
  → TileTree (recursive binary-split layout)
  → getProvider(session.provider).TileLeaf  ← provider dispatch happens HERE
    → provider's own Feed
      → shared: MarkerRow, TextProse, CodeBlock, LazyEntry, useStickyScroll
```

`workspaceStore` stores `provider: string` per session. When rendering a pane, TileTree looks up the provider config and mounts `config.TileLeaf`. The store never imports provider-specific code — it calls `config.createSession()` and `config.listSessions()` through the registry.

`sessionManager.ts` in the main process uses the same pattern: it receives a provider id over IPC, looks up the config, and calls `config.createSession()`. The if/else branching on provider is eliminated entirely.

## Import Rules (The Isolation Guarantee)

```
providers/claude/  ──imports──→  shared/
providers/codex/   ──imports──→  shared/
shell/             ──imports──→  shared/, providers/registry.ts
main/              ──imports──→  shared/, providers/registry.ts
```

**Hard rules:**
1. `src/providers/claude/` never imports from `src/providers/codex/`.
2. `src/providers/codex/` never imports from `src/providers/claude/`.
3. `src/shell/` never imports from `src/providers/claude/` or `src/providers/codex/` directly — only through `registry.ts`.
4. `src/shared/` never imports from `src/providers/` or `src/shell/`.

A grep-based CI check or eslint-plugin-import boundary rule can enforce this. The directory structure itself makes violations obvious in code review.

## Migration Path

Incremental, not big-bang. Each step is independently committable and testable.

1. **Create `src/shared/`** — move building blocks there: MarkerRow, LazyEntry, UserBand, ActivityIndicator, TextProse, StreamingProse, CodeBlock, monacoRuntime, useStickyScroll, base types, jsonlTailer, ptyScreen, lineDiff. Update all imports.

2. **Create `src/providers/claude/`** — move Claude-specific files: claudeSession, sessionList, projectDir, streamingScreen parser, trustDialog parser, slashPicker parser, claudeTranscript types, ClaudeRows, SlashCommandPicker, TrustDialogModal. Create Claude's own Feed.tsx and TileLeaf.tsx by extracting the Claude-specific paths from the current shared versions. Export `claudeConfig`.

3. **Create `src/providers/codex/`** — same for Codex: codexSession, sessionList, codexProjectDir, codex streamingScreen parser, codexTranscript types, CodexRows. Create Codex's own Feed.tsx and TileLeaf.tsx. Export `codexConfig`.

4. **Create `src/providers/registry.ts`** — import both configs, export `getProvider()` and `getAllProviders()`.

5. **Create `src/shell/`** — move App.tsx, TileTree, TabBar, PathPickerModal, treeOps, workspaceStore, CommandPalette, ThemePicker, themes, useKeybinds. Update TileTree to use `getProvider(session.provider).TileLeaf` instead of hardcoded component. Update workspaceStore to use `getProvider().createSession()` and `getProvider().listSessions()`.

6. **Update `src/main/`** — refactor sessionManager to use provider configs instead of if/else branches. Update IPC handlers in index.ts to dispatch through registry.

7. **Update imports everywhere** — find and fix all broken imports from the moves.

8. **Delete old locations** — remove the now-empty `src/core/`, `src/renderer/src/feed/claude/`, etc.

9. **Add import boundary enforcement** — grep-based check in CI or eslint rule that fails on cross-provider imports.

## What This Does NOT Change

- **The UI/UX** — both providers look identical because they compose the same shared building blocks.
- **The workspace model** — tabs, splits, keybinds, scroll, themes all work exactly as before.
- **The IPC shape** — preload's API surface stays the same; it just threads provider id.
- **The headless packages** — `claude-code-headless` and `codex-headless` are separate npm packages and are unaffected by this internal restructure.
