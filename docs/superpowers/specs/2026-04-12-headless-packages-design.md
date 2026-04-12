# Headless Agent Packages — Design Spec

Two standalone packages that let anyone programmatically control Claude Code and Codex through their terminal interfaces. Each package spawns the agent in a headless terminal, translates raw PTY output into structured JSON events, and exposes a clean async API for sending prompts, running commands, and streaming responses.

## Why

cc-shell currently mixes "control the agent" and "render the UI" in one codebase. Breaking the control layer into standalone packages:

- **Separation of concerns** — cc-shell becomes a thin UI consumer; the hard reverse-engineering work lives in focused, testable packages.
- **Open source leverage** — "programmatically use Claude Code" is a large market. Contributors who don't care about cc-shell's Electron UI will contribute to the headless packages because they can use them to build their own tools, servers, IDE extensions, CI pipelines, etc.
- **Testability** — each package ships its own test suite (replay-based, using recorded PTY fixtures). Bugs in screen parsing are caught before they reach cc-shell.
- **Reusability** — anyone can `npm install claude-code-headless` and get a typed, event-driven API to Claude Code. No Electron, no React, no cc-shell dependency.

## Repo Structure

```
cc-shell/
  claude-code-headless/     <-- new package (git submodule)
  codex-headless/           <-- new package (git submodule)
  claude-code-src/          <-- existing (CC source for reference)
  codex-src/                <-- existing (Codex source for reference)
  src/                      <-- cc-shell (imports the packages)
  testbench/                <-- migrates into the packages
```

Both packages are git submodules at the project root. Published to npm later for open source; consumed locally via relative imports for now.

## Package: `claude-code-headless`

### Public API

```ts
import { ClaudeCodeHeadless } from 'claude-code-headless'
import { spawn } from 'node-pty'

// Consumer owns the PTY
const pty = spawn('claude', [], { cwd: '/my/project', ... })

const claude = new ClaudeCodeHeadless({ pty, cwd: '/my/project' })

// --- Lifecycle ---
claude.start()                    // attach to PTY, start parsing
await claude.stop()               // detach, cleanup watchers

// --- Send a prompt ---
for await (const event of claude.sendPrompt('fix the auth bug')) {
  // Events stream in real time as CC works:
  //   { type: 'activity', status: 'Cogitating...' }
  //   { type: 'text_delta', text: 'I see the issue...' }
  //   { type: 'tool_use', name: 'Edit', id: '...', input: {...} }
  //   { type: 'tool_result', tool_use_id: '...', content: '...', is_error: false }
  //   { type: 'permission_request', tool: 'Edit', input: {...} }
  //   { type: 'complete', message: { role: 'assistant', content: [...] } }
}

// --- Commands (fully automated) ---

// Resume: returns parsed session list, then accepts a selection
const sessions = await claude.listResumableSessions()
// => SessionInfo[]
await claude.resumeSession(sessions[0].sessionId)

// Slash commands
await claude.runCommand('/compact')
await claude.runCommand('/clear')
const help = await claude.runCommand('/help')

// --- Permission handling ---
// Consumer always decides
claude.on('permission_request', async (req) => {
  // req: { id, tool, input, approve(), deny() }
  req.approve()   // sends 'y' keystroke
  // or: req.deny()  // sends 'n' keystroke
})

// --- Trust dialog ---
claude.on('trust_dialog', async (dialog) => {
  // dialog: { workspace, accept(), reject() }
  dialog.accept()
})

// --- Raw events (for power users) ---
claude.on('screen', (snapshot) => { ... })
claude.on('screen_markdown', (md) => { ... })
claude.on('jsonl_entry', (entry, file) => { ... })
claude.on('activity', (status) => { ... })
claude.on('idle', () => { ... })
claude.on('exit', (code, signal) => { ... })

// --- State queries ---
claude.isIdle()           // boolean
claude.isWorking()        // boolean
claude.getActivity()      // string | null ('Cogitating...')
claude.getScreen()        // plain text snapshot
claude.getScreenMarkdown() // markdown-reconstructed snapshot
```

### Internal Architecture

```
claude-code-headless/
  src/
    index.ts                        -- ClaudeCodeHeadless class
    
    terminal/
      HeadlessTerminal.ts           -- @xterm/headless wrapper
                                       Owns the Terminal instance.
                                       Pipes PTY data in, exposes:
                                         snapshotPlain()
                                         snapshotMarkdown()
                                         getTerminal() (for cell access)
                                       Emits throttled 'screen' events.
                                       Moved from: ptyScreen.ts
      
      TerminalToMarkdown.ts         -- terminalToMarkdown() pure function
                                       Walk cells, reconstruct **bold** *italic*
                                       Moved from: ptyScreen.ts
    
    parsers/
      ScreenParser.ts               -- extractStreamingText()
                                       extractAssistantInProgress()
                                       detectActivity()
                                       isChromeLine(), isDividerLine(), etc.
                                       All pure string-in string-out.
                                       Moved from: parsers/claude/streamingScreen.ts
      
      SlashPickerParser.ts          -- detectSlashPicker()
                                       Needs Terminal instance for cell fg colors.
                                       Moved from: parsers/claude/slashCommandPicker.ts
      
      TrustDialogParser.ts          -- detectTrustDialog()
                                       TRUST_DIALOG_ACCEPT_KEYS
                                       Pure string matching.
                                       Moved from: parsers/claude/trustDialog.ts
      
      PermissionParser.ts           -- NEW: detect tool permission prompts
                                       from screen text. Returns { tool, input }
                                       so consumer can approve/deny.
    
    transcript/
      JsonlTailer.ts                -- FileTailer class (poll-based file watcher)
                                       tailNewSessionFile()
                                       tailSessionFile()
                                       Moved from: runtime/jsonlTailer.ts
      
      TranscriptTypes.ts            -- Message, ContentBlock, ToolUseBlock,
                                       ToolResultBlock, ConversationEntry, etc.
                                       Moved from: types/transcript.ts
      
      SessionList.ts                -- listSessionsForCwd()
                                       Moved from: runtime/sessionList.ts
      
      ProjectDir.ts                 -- getProjectDirForCwd()
                                       Resolves ~/.claude/projects/<sanitized>
                                       Moved from: runtime/projectDir.ts
    
    commands/
      CommandRunner.ts              -- Base class for automated commands.
                                       Pattern: write keystrokes to PTY,
                                       watch screen for expected pattern,
                                       parse structured result, resolve promise.
                                       Timeout + error handling.
      
      ResumeCommand.ts              -- Automates /resume:
                                       1. Send '/resume\r' to PTY
                                       2. Wait for picker to appear on screen
                                       3. Parse session list from screen text
                                       4. Return SessionInfo[]
                                       5. resumeSession(id): navigate picker,
                                          send Enter
      
      CompactCommand.ts             -- Send '/compact\r', wait for completion
      ClearCommand.ts               -- Send '/clear\r', wait for completion
      HelpCommand.ts                -- Send '/help\r', capture + parse output
      GenericSlashCommand.ts        -- Fallback for unknown /commands
    
    state/
      StateMachine.ts               -- Tracks: idle | prompting | working |
                                       picker | trust_dialog | permission |
                                       exited
                                       Transitions driven by screen + JSONL.
                                       Gates sendPrompt (queues if working).
    
    protocol/
      events.ts                     -- Discriminated union of all event types.
                                       Every event has { type: string, ts: number }.
                                       Versioned so consumers can handle
                                       schema evolution.
    
    testing/
      fixtures/                     -- Recorded PTY sessions (.events.jsonl)
      replay.ts                     -- Feed fixtures through parsers offline
      verify.ts                     -- Assertion-based regression tests
  
  package.json
  tsconfig.json
```

### Event Protocol

All events are a discriminated union on `type`:

```ts
type HeadlessEvent =
  // --- Streaming (real-time, from screen scraping) ---
  | { type: 'activity'; ts: number; status: string }
  | { type: 'text_delta'; ts: number; text: string }
  | { type: 'thinking'; ts: number; text: string }
  
  // --- Structured (from JSONL, after CC writes the entry) ---
  | { type: 'tool_use'; ts: number; name: string; id: string; input: unknown }
  | { type: 'tool_result'; ts: number; tool_use_id: string; content: string; is_error: boolean }
  | { type: 'message_complete'; ts: number; message: Message }
  
  // --- Interactive (require consumer response) ---
  | { type: 'permission_request'; ts: number; id: string; tool: string; input: unknown;
      approve: () => void; deny: () => void }
  | { type: 'trust_dialog'; ts: number; workspace: string;
      accept: () => void; reject: () => void }
  
  // --- State ---
  | { type: 'idle'; ts: number }
  | { type: 'working'; ts: number }
  | { type: 'screen'; ts: number; plain: string; markdown: string }
  | { type: 'exit'; ts: number; exitCode: number; signal?: number }
```

### How Streaming Works

The package merges two data sources into one event stream:

1. **Screen scraping** (real-time, ~60Hz): The HeadlessTerminal pipes PTY data into @xterm/headless. On each throttled tick, ScreenParser runs extractAssistantInProgress on the plain text. If the extracted text changed since last tick, the delta is emitted as `text_delta`. Activity detection emits `activity` events.

2. **JSONL tailing** (slightly delayed, but structured): JsonlTailer watches CC's transcript file. When a complete assistant entry lands, it's emitted as `message_complete` with the full structured content (text blocks, tool_use blocks, thinking blocks). Tool results from the subsequent user entry emit as `tool_result`.

The consumer sees a unified stream: fast `text_delta` events while CC is typing, then a `message_complete` event when the full structured message is available. The `message_complete` is the source of truth; `text_delta` is the preview.

### How Commands Work

Commands are automated interactions that send keystrokes and parse screen responses:

```
sendPrompt("fix the bug")
  |
  v
StateMachine: idle -> prompting
  |
  v
Write "fix the bug\r" to PTY
  |
  v
StateMachine: prompting -> working (spinner detected)
  |
  v
Screen parser emits text_delta events
JSONL tailer emits tool_use / tool_result events
  |
  v
StateMachine: working -> idle (spinner gone, prompt visible)
  |
  v
Yield { type: 'message_complete', ... }
AsyncGenerator returns
```

For interactive commands like `/resume`:

```
claude.listResumableSessions()
  |
  v
Write "/resume\r" to PTY
  |
  v
Wait for picker to appear on screen (poll ScreenParser)
  |
  v
Parse picker items from screen text
  |
  v
Write "\x1b" (Escape) to dismiss picker
  |
  v
Return SessionInfo[]

claude.resumeSession(id)
  |
  v
Write "/resume\r" to PTY
  |
  v
Wait for picker, navigate to matching item (arrow keys)
  |
  v
Write "\r" (Enter) to select
  |
  v
Wait for session to load (JSONL entries start flowing)
```

## Package: `codex-headless`

Mirror API surface with provider-specific differences:

- Different binary (`codex` instead of `claude`)
- Different screen parser (Codex has different chrome, spinner format)
- Different transcript format (rollout JSON instead of JSONL)
- Different command set (Codex may not have `/resume`, `/compact`, etc.)
- Same event protocol types where possible
- Same `sendPrompt` / async generator interface

Internal structure mirrors claude-code-headless but with codex-specific parsers.

## Migration Plan

### Phase 1: Scaffold + move parsers (no behavior change)

1. Create `claude-code-headless/` at project root with package.json, tsconfig
2. Copy (don't move yet) parser files into the package
3. Add exports from package index
4. Verify the package compiles standalone
5. No changes to cc-shell imports yet

### Phase 2: Move runtime primitives

1. Move HeadlessTerminal (from ptyScreen.ts), JsonlTailer, SessionList, ProjectDir
2. Build the ClaudeCodeHeadless class composing these
3. Write basic tests using existing fixture recordings
4. cc-shell still uses its own copies — no integration yet

### Phase 3: Wire cc-shell to use the package

1. Replace cc-shell's `src/core/` imports with package imports
2. ClaudeSession in cc-shell simplifies to: spawn PTY, create ClaudeCodeHeadless, forward events to IPC
3. Delete the duplicated files from src/core/
4. Verify cc-shell works identically

### Phase 4: Add command automation

1. Build CommandRunner base class
2. Implement ResumeCommand, CompactCommand, etc.
3. Add permission and trust dialog event handling
4. Build the state machine

### Phase 5: codex-headless

1. Scaffold codex-headless with same structure
2. Move codex-specific parsers
3. Build CodexHeadless class
4. Wire cc-shell's Codex integration to use the package

## Dependencies

### claude-code-headless

```json
{
  "dependencies": {
    "@xterm/headless": "^5.5.0",
    "chokidar": "^5.0.0"
  },
  "peerDependencies": {
    "node-pty": "^1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

`node-pty` is a peer dependency because the consumer owns the PTY. The package never spawns processes itself — it takes an `IPty` instance.

`@xterm/headless` is a direct dependency because the package owns the headless terminal internally. The consumer never touches it.

## What Stays in cc-shell

- `src/main/sessionManager.ts` — Electron-specific session registry + IPC multiplexing
- `src/main/index.ts` — Electron app, IPC handlers, BrowserWindow
- `src/preload/` — IPC bridge
- `src/renderer/` — React UI, Feed, TileLeaf, CommandPalette, etc.
- `src/core/runtime/terminalSession.ts` — plain shell (not agent-related)
- `src/core/code/` — language detection, LSP (UI concern)

cc-shell's `ClaudeSession` becomes:

```ts
import { ClaudeCodeHeadless } from 'claude-code-headless'
import { spawn } from 'node-pty'

class ClaudeSession {
  private headless: ClaudeCodeHeadless

  constructor(options) {
    const pty = spawn('claude', args, { cwd, env, ... })
    this.headless = new ClaudeCodeHeadless({ pty, cwd })
    
    // Forward events to IPC
    this.headless.on('screen', snap => this.emit('screen', snap))
    this.headless.on('jsonl_entry', entry => this.emit('jsonl-entry', entry))
    this.headless.on('activity', status => this.emit('activity', status))
    this.headless.on('exit', code => this.emit('exit', code))
  }
}
```
