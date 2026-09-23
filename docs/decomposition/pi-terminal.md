# Pi Terminal — stage decomposition (spec)

Status: APPROVED 2026-09-22 (all decisions at their defaults). Implementation
not started; progress is tracked in the plan's checkboxes and Execution notes.

Plan: `docs/superpowers/plans/2026-09-22-pi-terminal-harness.md` (the Agent Code
side and the order across repositories). The package-side tasks move into the
new package's own `docs/plans/` once that repository exists, exactly as
`opencode-terminal-headless` did.

Issue: #1132 (`feat(pi): add Pi as a terminal-only agent provider with
transcript support`).

Templates this document deliberately copies:
- `docs/decomposition/opencode-terminal-headless.md` (the transcript-support
  shape: durable + live channel, isolated `reconcile/`, evidence first).
- `docs/decomposition/grok-app-integration.md` and PR #844 (adding a brand new
  `AgentProviderKind` end to end).
- Owner rule (2026-09-12): a provider package mirrors the siblings 1:1. **The
  app spawns and owns every process; the package's root class never does.**
  Package-side reconciliation lives in an isolated `reconcile/` layer; launch
  preparation is a package helper; app code lives in
  `src/providers/<kind>/runtime/` + `renderer/` + one entry per registry.

---

## 1. What Pi is (verified facts this design rests on)

Research date 2026-09-22, against the published CLI and its source. Every fact
here was checked in source and, where marked *(PTY)*, in a real PTY run of the
TUI with Pi's scripted `faux` provider. Anything unverified is listed in §9.

- **Identity.** npm `@earendil-works/pi-coding-agent`, CLI `pi`, MIT, source
  `github.com/earendil-works/pi` (the old `badlogic/pi-mono` redirects; the old
  `@mariozechner/pi-coding-agent` package is deprecated at 0.73.1). Latest
  **0.87.1** (2026-09-22). Node **>= 22.19.0**. Also ships a curl installer and
  Bun-compiled standalone binaries.
- **Cadence.** ~30 releases in three months; breaking changes land in 0.x
  minors (0.87.0 added the `context_edit` entry and reshaped `TurnEndEvent`).
  **We pin an accepted version and parse tolerantly.**
- **No permission system, no question tool, no MCP** — all by design
  ("build your own with extensions"). The only blocking prompts are: project
  trust (when the cwd has `.pi/…` resources), the global `--session <id>`
  fork question, a missing-cwd question on resume, user-opened selectors
  (`/login`, `/model`, `/resume`, `/tree`), and extension `ui.*` dialogs, which
  all emit `ui_prompt_start` / `ui_prompt_end` to extensions.
- **Durable transcript** = one JSONL file per session:
  `<agentDir>/sessions/--<cwd with / \ : → ->--/<iso-ts>_<sessionId>.jsonl`,
  `agentDir` = `$PI_CODING_AGENT_DIR` or `~/.pi/agent`; session dir override
  precedence `--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `sessionDir`
  setting > default.
  - Format **v3**: header `{type:"session",version:3,id,timestamp,cwd,parentSession?}`,
    then entries `{type,id(8 hex),parentId|null,timestamp}` of types `message`,
    `model_change`, `thinking_level_change`, `usage`, `compaction`,
    `branch_summary`, `custom`, `custom_message`, `context_edit` (0.87+),
    `label`, `session_info`. v1/v2 files are migrated in place when Pi loads
    them, so a reader must tolerate v1 rows.
  - Messages: `system` (prompt + tool loadout, persisted before the first user
    message), `user` (TUI writes a block array), `assistant`
    (`content: (text|thinking|toolCall)[]`, `usage`, `stopReason ∈
    stop|length|toolUse|error|aborted|deferred`, `errorMessage?`), `toolResult`
    (`toolCallId`, `toolName`, `content`, `isError`, `details?`),
    `bashExecution` (user `!` commands), `custom`, `branchSummary`,
    `compactionSummary`.
  - **It is a tree.** `/tree` navigation keeps writing to the same file; the
    active branch is the `parentId` chain from the LAST line. Parents always
    precede children, so physical line order is monotonic along any branch.
  - **Write timing *(PTY)*:** a new session's file does not exist at all until
    the first assistant message completes (aborted/errored counts); then
    everything so far is written at once (`wx`), and afterwards each entry is
    one synchronous `appendFileSync` at `message_end`. Streaming partials are
    never persisted; queued steer/follow-up messages are written only when
    delivered.
- **Identity & resume.** `--session-id <id>` opens that session or **creates a
  new one with exactly that id** (prints a one-line yellow stderr warning when
  creating). `--session <path|id>`, `--continue`, `--resume`, `--fork`,
  `--session-dir`, `--no-session` also exist. Default ids are uuidv7. On exit
  Pi prints `To resume this session: pi --session <id>`.
- **In-TUI session switches** (`/new`, `/resume`, `/fork`, `/clone`, `/import`)
  change the file (and id). `/tree` does not change the file but changes the
  active branch. Every switch fires `session_shutdown` then
  `session_start{reason, previousSessionFile}` to extensions.
- **Live channel = an extension.** `pi -e <file.ts>` loads a TypeScript
  extension through jiti (no build step) into the *interactive TUI* as well as
  print/json/rpc modes. *(PTY)*: a probe extension received the complete event
  stream — `session_start → input → before_agent_start → agent_start →
  turn_start → message_start/update/end → tool_execution_start/update/end →
  tool_call → tool_result → turn_end → agent_end → agent_settled →
  session_shutdown` — and a prompt injected over a Unix socket with
  `pi.sendUserMessage` appeared and was persisted as a normal user message.
  `ctx.sessionManager.getSessionFile()` returns the future path already at
  `session_start`, before the file exists. **Crash hazard *(PTY)*:** an
  unhandled async `listen` error inside an extension kills the whole `pi`
  process (`uncaughtException`) and leaves a "pi crashed" banner on the next
  start; socket paths over macOS's 104-byte limit trigger it.
- **RPC mode** (`--mode rpc`) is a complete JSONL protocol, but it replaces the
  TUI, so it is NOT an option for a terminal harness. Its event vocabulary is
  the same as the extension API's and is documented; we reuse its names.
- **TUI.** Regular mode = inline, no alternate screen (fullscreen is opt-in via
  `--tui-mode fullscreen`). Differential rendering wrapped in synchronized
  output `?2026`. Enables bracketed paste; queries Kitty keyboard protocol and
  DA1 (**the host terminal must answer DA1**). Enter submits; Shift+Enter/Ctrl+J
  newline; Enter while working queues a *steer*, Alt+Enter a *follow-up*; Esc
  aborts and restores queued messages to the editor. "Working" is a braille
  spinner in the editor border; with `terminal.showTerminalProgress: true` Pi
  emits OSC `9;4;3` / `9;4;0` around a run.
- **Context & skills.** Reads `AGENTS.md`/`CLAUDE.md` from agentDir, cwd and
  ancestors. Implements the Agent Skills spec and discovers
  `~/.agents/skills` — *(verified)* it already picked up Agent Code's managed
  skills from there. Project `.pi/` resources require project trust.
- **Auth.** `/login` OAuth for Claude Pro/Max, ChatGPT/Codex, Copilot, xAI and
  others, or ~35 API-key providers. Agent Code never touches `auth.json`.

## 2. A — what exists and is trusted in Agent Code

- **The provider registry pattern** (`src/providers/registry.{main,renderer,
  renderer.capabilities,setup,renderShapes}.ts`) and the compile-enforced
  `Record<AgentProviderKind, …>` tables. Adding `'pi'` to
  `AGENT_PROVIDER_KINDS` (`src/shared/types/providerKind.ts:35`) turns every
  missing entry into a compile error — that error list is the first checklist.
- **The terminal-pane machinery** built for OpenCode Terminal: TUI surface pin
  (`agentDisplayMode.ts:74`), history loading for terminal panes
  (`initialHistory.ts`, #882), read commands on terminal panes (#972,
  `transcriptAvailability.ts`), DEC-mode replay on remount (#1041),
  `jumpToLatest` (#1043), `server-unreachable` diagnostics (#1093).
  **Trusted, but keyed on `providerRuntime === 'terminal'`** — see §5.1.
- **The OpenCode Terminal package shape**
  (`packages/opencode-terminal-headless`): root class takes a caller-owned PTY
  (`PtyLike`), `prepareLaunch` helper, `channels/`, `conditions/` with vendored
  core, `reconcile/SessionSequencer.ts` (answer-before-`turn_completed`, 2 s
  settle deadline, heartbeat while busy), recorded fixtures + oracle, opt-in
  live test, reusable package CI.
- **The Grok JSONL-reading pieces** (`packages/grok-code-headless`):
  `FileTailer` (byte-offset, 100 ms stat poll, partial lines) and the
  `history` reset / caught-up boundary events already carried through both
  SessionFeeds (desktop + phone) by #844.
- **The shared JSONL history loader** (`src/main/sessions/historyLoader.ts`),
  used when a provider has no `loadHistoryChunk` hook — **not trusted for Pi**
  because it reads linearly backwards and would leak abandoned branches.
- **agent-transcript-parser's neutral hub**: `ProviderId = string` (no closed
  union), `ConversationDecoder`, `NativeResumeProjector`, `rewindConversation`
  (line-based), shrink ladder (provider-neutral).

## 3. D — end state, as observable behavior

1. **Spawn.** "New Pi" appears in the New Agent picker / split commands when
   `pi` is on PATH (Setup shows the install hint otherwise). The pane is the
   real Pi TUI and is ALWAYS the terminal surface, from every spawn path
   (picker, split chord, Dispatch, conversation catalog resume, orchestration
   `create_agent`, control API, duplicate, provider switch, restart restore).
2. **Status.** While Pi works, the pane header, tab badge, Dispatch row, Agent
   Status panel and busy guards show it running; it returns to idle on Pi's own
   `agent_settled`. No idle flicker between tool steps.
3. **Transcript.** `runtime.entries` holds the active branch of the
   conversation, live and after reload/restart. Reader Mode, View Prompts, Copy
   Last Response, Dispatch titles, `orchestration_read_agent`,
   `orchestration_wait_agents`, `agent_management_read_agent` and
   `agent_transcript_read_file|search_file|inspect_file` return it.
4. **Prompts.** Programmatic prompt delivery (Dispatch, orchestration
   `send_prompt`, goal loop, composer-less text delivery) reaches Pi through the
   live channel and reports honest outcomes: delivered, refused-not-sent, or
   unknown. Never "delivered" for a prompt nobody received (the #877 lesson).
5. **Attention.** A blocking Pi dialog (extension `ui.select/confirm/input`,
   trust prompt handled by the bridge, selectors) raises the Dispatch QUESTION
   badge and clears when answered in the TUI.
6. **Session switches inside the TUI** (`/new`, `/resume`, `/fork`, `/clone`,
   `/tree`) are followed: the pane's provider session id and transcript follow
   Pi's active session/branch, with a history reset boundary. (Decision D4.)
7. **Catalog & resume.** Pi sessions appear in the Conversations picker, resume
   into a Pi terminal pane, and "Copy Resume Command" copies a verified
   `pi --session-id <id>` command.
8. **Switch / duplicate.** A Pi session can be switched to Claude / Codex /
   OpenCode / Grok and back, and duplicated. Rewind stays hidden (as for every
   terminal-runtime pane — no composer to receive the draft).
9. **Built-in MCP.** TLDR, Goal and orchestration tools work inside Pi through
   the bridge's tool proxy. (Decision D5 — separable final stage.)
10. **Degradation.** No bridge (old Pi, extension failed to load, socket lost):
    the pane still works as a plain TUI, committed transcript still arrives
    from the durable file, status falls back to "unknown/idle", prompt delivery
    REFUSES with a typed reason, and a visible diagnostic says why. Never wrong
    data; never a crashed `pi`.

## 4. The pipeline (one owner per signal)

| Signal | Owner | Mechanism |
|---|---|---|
| Committed entries (live) | **Durable** | Tail the session JSONL with `FileTailer`; commit each complete line; project onto the active branch |
| History (cold, parked, restart, MCP reads) | **Durable** | Read the file, walk `parentId` from the last line → active branch, page newest-first |
| Session identity (file + id), switches, branch moves | **Live** (bridge) | `session_start{reason}` / `session_tree` carry `getSessionFile()` / `getSessionId()` / `getLeafId()` |
| Activity, turn start/end, stream phase | **Live** (bridge) | `agent_start` → busy, `agent_settled` → idle; `turn_start`/`turn_end`; `message_update` delta kinds → phase |
| Conditions (blocking dialogs) | **Live** (bridge) | `ui_prompt_start` / `ui_prompt_end` (+ bridge-owned `project_trust` handler) |
| Queue state | **Live** (bridge) | `input{streamingBehavior}` + committed user rows (no `queue_update` for extensions) |
| Prompt delivery | **Live** (bridge) | `pi.sendUserMessage(text, {deliverAs: 'followUp'})` ALWAYS (Stage 0: a busy prompt without a mode is silently lost; `followUp` is ignored while idle). Ack = Pi's own evidence the text entered the conversation or queue — a user `message_start` with our text, or `hasPendingMessages()` turning true after our `input` event; otherwise `unknown`, never `ok` |
| Abort | **Live** (bridge) | `ctx.abort()` |
| Screen | **Nobody** | No headless xterm mirror (the 60 Hz snapshot churn is the most expensive thing the older packages do). The PTY only carries bytes for the pane. |

The live channel doubles as the durable channel's doorbell — but NOT at
`message_end`. Stage 0 (H3, `research/census-2026-09-22.md` in the package)
showed Pi's session writer runs AFTER extension handlers for the same
`message_end`, so at that instant the row is not on disk. The valid doorbells
are `turn_end` (it carries `messageEntryId` + `toolResultEntryIds`, and those
rows are on disk when its handler runs — checked on 30+ recorded turn ends),
`agent_settled` (everything the run wrote), `session_tree`, `session_compact`
and `session_start`. While the bridge is connected, the tailer reads on those
doorbells plus a slow safety poll; while disconnected it falls back to the
100 ms stat poll.

### 4.1 Why the bridge extension (and not the alternatives)

- **RPC mode** is the richest channel but replaces the TUI. The product is "Pi's
  own TUI in a pane"; RPC would be a different (structured) runtime — possible
  later, out of scope.
- **Screen scraping** (spinner border, "Operation aborted", OSC 9;4) is
  fragile across 0.x releases, needs a headless xterm mirror (the GC-churn cost
  OpenCode Terminal deliberately avoided), and cannot carry identity after
  `/new`. It is not used even as a fallback: a wrong "idle" is worse than an
  honest "unknown".
- **File-only** (durable tail, no live channel) cannot tell busy from idle
  (nothing is written until `message_end`, and a new session's file doesn't
  exist until the first reply completes), cannot follow `/new`, and has no safe
  prompt path (paste into a TUI is the #877 failure).
- **The extension API is Pi's documented integration surface**, loads in the
  interactive TUI via `-e` without touching the user's config, and was verified
  end to end. Its cost is that our code runs inside Pi's process — hence the
  hard rules in §6.

## 5. Design decisions

### 5.1 D1 — Pi is its own provider kind, pinned to the terminal surface

`'pi'` joins `AGENT_PROVIDER_KINDS`. It is not a runtime flavour of anything.
But its pane must behave like an OpenCode Terminal pane (TUI surface, feed
never mounted, read commands available, Rewind hidden), and every one of those
gates today reads `meta.providerRuntime === 'terminal'`.

Setting `providerRuntime: 'terminal'` at every spawn site does not survive
contact: the catalog resume (`ConversationsPicker.tsx:113`), split chords
(`paneCommands.ts`), provider switch (`session.ts:1237-1241` drops the runtime
when the kind changes), MCP `create_agent` with the runtime omitted, and the
control API all pass only a kind. A missed site silently mounts a feed for Pi.

**Decision:** make "terminal-only" a provider property and resolve the
effective runtime at READ time through one helper:

```ts
// src/shared/types/providerKind.ts
export const TERMINAL_ONLY_PROVIDER_KINDS = ['pi'] as const satisfies readonly AgentProviderKind[]
export function effectiveProviderRuntime(kind: SessionKind, runtime: AgentProviderRuntime | null | undefined): AgentProviderRuntime | undefined
// → 'terminal' for terminal-only kinds regardless of the stored value; otherwise the stored value
```

- Every `providerRuntime === 'terminal'` gate (the list in the plan, Task 6)
  switches to `effectiveProviderRuntime(meta.kind, meta.providerRuntime) ===
  'terminal'`. Read-time resolution cannot miss a spawn site because it doesn't
  depend on them.
- Main's `resolveProviderRuntime` (`sessionManager.ts:424-437`) returns
  `'terminal'` for terminal-only kinds, so backend snapshots, ownership
  comparisons and recovery agree with the renderer.
- OpenCode-hardcoded terminal checks become capability checks
  (`control/agents.ts:218`, `control/lifecycle.ts:64`, `RemoteServer.ts:963`,
  `providerChoices.ts:41/71`, `AgentViewModePickerModal.tsx:50`,
  `hook/index.ts:155-170`, `useIpcSubscriptions.ts:909` diagnostic kind).
- Pi registers the SAME session for `createSession` and `createTerminalSession`
  (Grok precedent, `registry.main.ts:154-157`) so no factory selection can
  reach a nonexistent structured runtime.
- Rejected: the Grok model (own kind, rendered feed allowed). Pi's committed
  stream is fine for a feed, but the request is explicitly a terminal-only
  harness, and the rendered surface would need shape catalogs and semantic
  streaming we have no evidence for yet.

### 5.2 D2 — A new package `pi-terminal-headless` (public submodule)

`Juliusolsson05/pi-terminal-headless`, mirrored from `opencode-terminal-headless`
file for file. Zero runtime dependencies if possible (the durable tailer is
copied from the siblings' `FileTailer`, not imported); `node-pty` as an optional
peer. App consumes it by alias from source (no `file:` dep, no lockfile change),
like OTH (`0fc879ad`).

```
src/
  index.ts                     public exports only (reconcile/ and readers NOT exported)
  PiTerminalHeadless.ts        root class; caller passes the PTY; never spawns/kills
  terminal/PtyBinding.ts       PtyLike, exit latch, write/resize; DA1 answer helper if Stage 0 requires it
  launch/prepareLaunch.ts      args + env + socket path + token + bridge path; spawns nothing
  launch/sessionPaths.ts       agentDir / session-dir resolution, cwd→dir encoding, file lookup by id
  bridge/extension.ts          THE extension Pi loads via -e (self-contained, see §6)
  bridge/protocol.ts           wire types shared by extension.ts and the host side (type-only import in extension)
  live/BridgeServer.ts         host side of the Unix socket: accept exactly one authenticated peer
  live/BridgeClient.ts         request/response (sendUserMessage, abort, resync) with correlation ids
  live/LiveStateProjector.ts   pure: bridge events → activity/turn/phase/requests/identity transitions
  transcript/SessionFile.ts    the only code that knows Pi's JSONL schema (entry/message guards, version tolerance)
  transcript/ActiveBranch.ts   pure: rows → active branch (parentId walk from the last line), branch-move diff
  transcript/DurableReader.ts  FileTailer-driven; doorbell/poll policy; emits committed rows in branch order
  transcript/history.ts        readHistory / iterateEntries / listSessions (cold reads, paging by entry id)
  transcript/transcriptFile.ts locator helpers (plain absolute file path; see §5.6)
  reconcile/SessionSequencer.ts THE place live and durable meet (see §5.4)
  conditions/{core/*generated*, modules.ts}   pi.dialog (+ pi.trust if D-trust says so)
  channels/{channels,types}.ts  Semantic / Screen / Committed, same shapes as siblings
  testing/                     fixtures loader, FakePty, replay rig, oracle (host-reachable by alias)
scripts/  census.mts  probe-live.mts  lib/sanitize.mts  + the standard contract scripts
testing/fixtures/  durable/*.jsonl  live/*.json  README.md
research/  census-YYYY-MM-DD.md
support/upstream-versions.json   accepted @earendil-works/pi-coding-agent version
```

### 5.3 D3 — Launch and identity

```ts
prepareLaunch({ binary, cwd, env, sessionId, resume, bridgeScriptPath, extraArgs? }): PiTerminalLaunch
// → { binary, args, env, sessionId, socketPath, token, sessionDir, expectedFileGlob }
```

- **Fresh session:** the app mints a uuidv7 and launches
  `pi --session-id <uuid> -e <bridge.ts>`; the provider session id is known
  before the process starts (the same property `createEmptyOpencodeSession`
  buys OpenCode Terminal, without a CLI round trip). Stage 0 (H1): the one-line
  stderr warning ("No project session found with id …; creating a new session
  with that id.") prints above Pi's banner and is harmless — accepted. The file
  does not exist until the first reply completes; nothing may treat its absence
  as an error.
- **Resume:** `pi --session-id <id> -e <bridge.ts>` (opens the existing session
  for this project). Stage 0 checks the cross-project case (the global-match
  fork question must never appear unanswered in an agent pane).
- **Env:** `AGENT_CODE_PI_BRIDGE_SOCKET`, `AGENT_CODE_PI_BRIDGE_TOKEN` (env only,
  never argv), `TERM=xterm-256color`, `COLORTERM=truecolor`,
  `PI_SKIP_VERSION_CHECK=1` (no update nag inside an agent pane),
  `PI_TELEMETRY` untouched (user's choice).
- **Socket path:** `${os.tmpdir()}`-independent short path
  `/tmp/acpi-<8 hex>/s` in a fresh `0700` directory — macOS `sun_path` is 104
  bytes and an overlong path crashes Pi (verified). Created by the HOST
  (`BridgeServer` listens; the extension connects), so the extension never
  calls `listen` — removing the verified crash path entirely.
- **Agent dir / session dir:** never overridden. The user's own Pi config,
  auth, models, skills and sessions are used, exactly as for claude/codex. The
  package resolves the session directory with Pi's own precedence
  (`PI_CODING_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR`, `sessionDir` setting in
  `settings.json`, default).
- **Binary:** PATH-resolved like Grok (`registry.setup.ts`, `binaryName: 'pi'`,
  install `npm install -g @earendil-works/pi-coding-agent`). NOT bundled under
  `third_party/`: the `third_party` pattern is for one self-contained
  executable per arch, and Pi is an npm tree that needs Node ≥ 22.19. (A later
  option: bundle Pi's Bun-compiled standalone binary the way OpenCode is
  bundled — out of scope.)
- **Bridge script location:** shipped as a resource of the package
  (`src/bridge/extension.ts`), copied by `copyMainRuntimeResourcesPlugin` +
  `scripts/copy-packaged-resources.mjs` to `out/main/runtime/pi/bridge.ts` (the
  `mitmAddon.py` precedent), which `asarUnpack: out/main/runtime/**/*` keeps on
  the real filesystem so Pi's jiti can load it.

### 5.4 D4 — Reconciliation rules (`reconcile/SessionSequencer.ts`)

The only module that sees both bridge events and durable rows. Single
consumer: `PiTerminalHeadless`. Forbidden importers: every other package
directory and all of Agent Code. Rules (each becomes a test over recorded
interleavings):

1. **Answer before end.** `turn_completed` for a run is released only after
   every durable row the bridge reported for that run (`turn_end`'s
   `messageEntryId` + `toolResultEntryIds`, `message_end` ids) has been
   committed, or after a 2 s settle deadline (then the turn ends and late rows
   follow) — the OpenCode Terminal rule, same constant.
2. **One run = one `agent_start → agent_settled` span.** `turn_start/turn_end`
   inside a run are steps, not user turns; no idle between them. `agent_end`
   with `willRetry` does NOT end the run.
3. **Active branch only.** Committed rows are emitted only if they are on the
   active branch at emit time. A `/tree` move (bridge `session_tree`, or a new
   leaf whose ancestry diverges) produces a history `reset` boundary followed
   by the new branch's rows, then `caught-up` — the Grok `history` boundary
   contract already carried by both SessionFeeds. Stage 0 (H6): a move WITHOUT
   a summary writes nothing, so the live leaf comes from
   `session_tree.newLeafId`, while cold reads use the last row (what Pi itself
   loads). A move with a summary appends a `branch_summary` row that is the
   new leaf.
4. **Session switch = identity change + reset.** `session_start{reason:new|
   resume|fork|clone}` with a different file retargets the durable reader,
   emits `session-switched{from,to}` and a reset boundary, and the adapter
   updates the provider session id (D4 follow, not detect-only). The new file
   may not exist yet (fresh `/new`); the reader waits for it without erroring.
5. **Foreign rows never leak.** Rows from a file other than the current one are
   dropped after a switch, even if the old tailer flushes late.
6. **Exit ends everything.** PTY exit → final drain → open turn ended → conditions
   cleared → `exit`. `stop()` idempotent before, during and after `start()`.
7. **Rewrites reset.** Pi rewrites an old-version (v1/v2) file in place when it
   loads it (Stage 0 H10, `migrateToCurrentVersion`). A size shrink or inode
   change on the tracked file is a rewrite: reset boundary + re-read.
8. **Bridge loss is not idle.** Socket closed while `pi` is alive → activity
   `unknown` + `live-state {connected:false, reason}`; the durable reader keeps
   running on its own poll.

### 5.5 D5 — Built-in MCP through the bridge (separable stage)

Pi has no MCP. The bridge extension receives the per-session built-in MCP
server list (URL + bearer, via env like the Codex/OpenCode launch configs, never
argv), speaks the minimal MCP streamable-HTTP JSON-RPC client itself
(`initialize`, `tools/list`, `tools/call` — `fetch` only, no SDK import), and
registers each tool with `pi.registerTool({ name, description, parameters:
Type.Unsafe(inputSchema), execute })`. Tool names keep the `mcp__agent_code__`
prefix convention Claude uses so skills that reference them keep working.
`BUILT_IN_MCP_DOMAINS_BY_PROVIDER.pi` is `[]` until this stage lands, then the
same domains as the others. Root-management non-inheritance and per-agent
choices follow main's existing policy unchanged.

TLDR/Goal *hooks* (turn-end enforcement) are Claude/Codex only today; Pi gets
the MCP tools, not the hooks (`TldrOverlay` `ENFORCED_PROVIDERS` unchanged).
A bridge-driven turn-end nudge is a follow-up.

### 5.6 D6 — Transcript locator

Pi's transcript IS a file, so the locator is the absolute `.jsonl` path — no
`pi://` scheme. `MainProviderConfig.resolveTranscriptPath(cwd, id)` finds
`<sessionDir>/*_<id>.jsonl` (exactly one match, else null). But the shared
backward reader can't be used (abandoned branches), so Pi supplies
`loadHistoryChunk` (active-branch paging, marker = Pi entry id) and
`AgentTranscriptReader` gets a Pi case that reads the active branch only.

### 5.7 D7 — Provider switch, duplicate, catalog

- **agent-transcript-parser** gains `src/pi/`: `decodePiConversation(rows,
  {sessionId})` (active branch, physical `source.line`, compaction entry placed
  BEFORE its kept entries so `conversationAfterLatestPortableCompaction`'s
  index slice is correct, `branch_summary`/`custom_message` as developer
  context, metadata rows opaque) and `piNativeResumeProjector` (writes a v3 file:
  header + linear `id`/`parentId` chain + a `session_info`/`custom` originator
  marker so the catalog can classify projected sessions). `'pi'` joins
  `compactionPortability`'s portable set (Pi summaries are plaintext).
- **Host adapter** `src/main/providerSwitch/piTranscript.ts` + registration in
  `transcriptEngine.ts` (Grok's file-based adapter is the template: `locate`,
  `readAt`, `listPrompts`, `plainDraft`, `targetProfile` from Pi's
  `settings.json` default model, atomic `wx` publish into the session dir).
- **Full switch graph**: Pi is a source and a target for all four others
  (`providerFeatures.test.ts` "complete directed switch graph" stays true).
  `compactBeforeSwitch` gets a Pi branch (Pi summaries are portable → Claude-like
  path), not the Codex fallthrough.
- **Conversations catalog** `src/main/conversations/sources/pi.ts`: walk the
  session dirs, header + bounded head for first user texts, `session_info` name
  as title, last row timestamp for activity; prompts via the shared Pi snapshot
  loader.

## 6. Hard rules for code that runs inside Pi (`bridge/extension.ts`)

1. **Never throw out of an event handler or a socket callback; never leave an
   async error unhandled.** Every socket gets an `error` listener; every handler
   body is wrapped. A bridge failure must degrade to "no live channel", never
   kill the user's `pi` (verified crash mode).
2. **Never `listen`.** The host listens; the extension connects (with bounded
   retry) at `project_trust` (Stage 0 H7: it fires ~300 ms before
   `session_start` while Pi's native trust selector is up, so this is the only
   way to report that blocking prompt) or `session_start`, whichever comes
   first, and closes at the final `session_shutdown{reason:'quit'}` — as Pi's
   docs require, never in the factory.
3. **Self-contained.** Only `node:*` builtins and Pi's virtual modules
   (`@earendil-works/pi-coding-agent` types, `typebox`). Type-only import of
   `protocol.ts`. No npm dependencies — jiti resolves them against Pi's tree,
   not ours.
4. **Authenticate first.** First frame is `{hello, token, protocolVersion,
   piVersion, pid}`; the host drops anything else. The socket dir is `0700`.
5. **Observe, don't steer.** The bridge never blocks or mutates tool calls,
   never answers dialogs on its own, never changes the model/tools/thinking
   level. Exception by explicit decision only: the project-trust handler
   (open question T below).
6. **Bounded payloads.** Events carry ids, kinds and small metadata — never
   message bodies (the durable file is the content owner). `message_update`
   is forwarded as a phase hint at most every 100 ms.
7. **Version tolerant.** Unknown events/fields ignored; the hello carries
   `piVersion` so the host can refuse a known-bad version with a diagnostic.

## 7. Intermediate stages

Stage exit = its "Verified by" passes. Stages 0–5 are package-side, 6–11
app-side, 12 parser, 13 MCP. The plan orders them across repositories.

### Stage 0 — Evidence corpus (package `scripts/`, `testing/fixtures/`, `research/`)
- **Produces:** `scripts/probe-live.mts` (sandboxed recorder: isolated
  `PI_CODING_AGENT_DIR` + HOME, temp git project, Pi's `faux` scripted provider
  so no auth/quota is used, real PTY via `NODE_PTY_PATH`, a recording bridge
  that logs every event with timestamps and the file's byte length at that
  moment); `scripts/census.mts` (read-only walk of real session dirs, reports
  entry/role/stopReason/version counts, branch counts, invariant violations);
  sanitized fixtures; `research/census-<date>.md`.
- **Scenarios:** plain turn; multi-step tool turn; aborted turn (Esc); provider
  error; steer while busy; follow-up while busy; `/new`; `/resume` into an older
  session; `/fork`; `/tree` move + branch summary; compaction; extension dialog
  (`ctx.ui.confirm` from a test extension); project-trust prompt; resume by
  `--session-id`; crash/kill mid-turn.
- **Verified by:** fixture validator — replaying each recording's durable rows
  through a reference active-branch walk reproduces the file's final branch;
  every recording has `recordedWith` = the Pi version observed.
- **Why separate:** every later test is built from these files (the 40%
  failure otherwise).
- **Real-model supplement:** faux runs prove structure, not real providers'
  content shapes (thinking signatures, redacted thinking, images). One
  real-model recording per auth type the user has, only with explicit
  permission, sanitized like OTH's durable fixtures.

### Stage 1 — Durable reader (`src/transcript/`)
- **Produces:** `SessionFile` guards (v1/v3 tolerant), `ActiveBranch` (pure),
  `DurableReader` (tailer + doorbell/poll + retarget), `history.ts`
  (`readHistory(file, {limit, beforeEntryId})`, `iterateEntries`,
  `listSessions(sessionDir)`), locator helpers.
- **Verified by:** replaying every Stage 0 recording's byte growth into a temp
  file yields exactly the final active branch, in order, each row once; a
  `/tree` recording yields a reset + new branch; a missing-then-created file
  is waited for, not errored; partial last lines never parse.
- **Why separate:** the only code that knows Pi's schema.

### Stage 2 — Bridge extension + live reader (`src/bridge/`, `src/live/`)
- **Produces:** `extension.ts`, `protocol.ts`, `BridgeServer`, `BridgeClient`,
  `LiveStateProjector` (pure).
- **Verified by:** projector over recorded bridge streams: busy at
  `agent_start`, idle at `agent_settled`, one run per span, no idle between
  steps, `willRetry` does not end the run, dialog visible from
  `ui_prompt_start` to `ui_prompt_end`, identity changes on every
  `session_start` with a new file. Expectations come from the recordings' own
  events. A system test loads the real `extension.ts` into the real `pi`
  (opt-in live tier) and proves hello/auth, event flow, `sendUserMessage`
  idle and busy (`followUp`), abort, and that killing the host socket leaves
  `pi` running.
- **Why separate:** the only code that knows Pi's event vocabulary, testable
  without a file or a PTY.

### Stage 3 — Reconciliation and composition
- **Produces:** `reconcile/SessionSequencer.ts`, `PiTerminalHeadless.ts`,
  `launch/`, `terminal/PtyBinding.ts`, `conditions/`, `channels/`.
- **Verified by:** recorded interleavings meet every §5.4 rule; root-class
  system tests with `FakePty` + replay rig (fake bridge peer + file writer)
  cover start/stop idempotence, exit ordering, bridge loss, switch
  retargeting.

### Stage 4 — Package repository and app wiring
- **Produces:** the public repo (README "Should you use this package? Probably
  not", CI caller of `reusable-package-ci.yml`, release caller, upstream-watch,
  dependabot, contract scripts, `support/upstream-versions.json`); in Agent
  Code: submodule, aliases (`electron.vite.config.ts` `headlessAlias` +
  `headlessExclude`, `tsconfig.node.json` paths + include, `tsconfig.web.json`
  paths, `vitest.config.ts`), `sync-conditions-core.mjs` target, bridge
  resource copy (vite plugin + `copy-packaged-resources.mjs`), app-level
  `support/upstream-versions.json` `pi` entry.
- **Verified by:** package `npm run check`; app `npm run typecheck`,
  `conditions-core:check`, `test:package` (bridge file present in `out/`).

### Stage 5 — (package) live test tier
- **Produces:** `src/PiTerminalHeadless.live.test.ts`, opt-in via
  `PI_TERMINAL_HEADLESS_LIVE=1`, `PI_BINARY`, `NODE_PTY_PATH`; faux provider;
  drives the public API exactly as the app will.
- **Verified by:** green on the pinned Pi version, on Node 24.

### Stage 6 — Provider kind + terminal-only surface (app)
- **Produces:** `'pi'` in `AGENT_PROVIDER_KINDS`; `effectiveProviderRuntime` +
  every gate converted (§5.1); every compile-enforced registry entry (setup,
  main, renderer capabilities, renderer, feature capabilities, MCP domains
  `[]`, suppression policy, conditions); every hand-written list from the
  plan's Task 6 inventory; identity (`π`, "Pi"); binary resolver.
- **Verified by:** `providerKind.test.ts`; a table test that every spawn path
  (picker, split, catalog resume, MCP create_agent, control API, duplicate,
  switch target, rehydrate) yields the terminal surface for `kind: 'pi'` with
  AND without a stored runtime; `agentDisplayMode`/command-policy tests;
  typecheck.

### Stage 7 — Runtime adapter (`src/providers/pi/runtime/`)
- **Produces:** `piSession.ts` (thin translator like `opencodeTerminalSession.ts`:
  prepareLaunch → app spawns PTY → `new PiTerminalHeadless({pty, cwd, launch})`
  → forward `activity`→`process-state`, `semantic`→`semantic-event`,
  `entry`→`jsonl-entry(row, file)`, `history`→`history-boundary`,
  `conditions`, `transcript-error`→`jsonl-error`, `live-state`→diagnostic,
  `session-switched`→provider session id update), `promptDelivery.ts`
  (`deliverPromptText` via the bridge; typed refusals), `skillDiscovery.ts`.
- **Verified by:** adapter tests with a fake headless (the mapping, identity
  entry at start, stop/exit ordering, switch → new provider session id); a
  system test over the replay rig.

### Stage 8 — Read paths (app)
- **Produces:** `loadHistoryChunk` for Pi; renderer mapper
  (`src/providers/pi/renderer/transcript/mapper.ts`: Pi rows → Claude-shaped
  entries, typed-user-prompt detection, provider session id extraction);
  `AgentTranscriptReader` Pi case (detect, extract, timestamps, active branch);
  Agent Management publishes the file path; `resolveTranscriptPath`;
  `detectJsonlProvider` learns Pi's header; tool descriptions; subagents guard
  (`src/main/subagents/index.ts` must not invent a directory for Pi files).
- **Verified by:** history loader system test over a fixture session file with
  an abandoned branch (abandoned rows never appear); mapper tests over Stage 0
  fixtures; transcript-reader system tests; renderer test that a Pi pane loads
  history, stays on the terminal surface, and offers Reader/View Prompts/Copy
  Last Response but not Rewind.

### Stage 9 — Catalog, resume command, diagnostics (app)
- **Produces:** `conversations/sources/pi.ts` + registration + fixtures + system
  test; verified resume command; diagnostics copy for bridge loss / old Pi;
  remote-client identity badge; attention map.
- **Verified by:** catalog system test over fixture session dirs; resume from
  catalog row yields a Pi terminal pane with the right `--session-id`.

### Stage 10 — Parser codec (agent-transcript-parser)
- **Produces:** `src/pi/conversation/decode.ts`, `src/pi/project/…`, exports,
  evidence fixtures, import-boundary list update, `compactionPortability`.
- **Verified by:** decoder tests over Stage 0 rows (branching, compaction,
  abort, error, bash execution); projector round-trip (decode → project →
  decode is equal on the portable subset); cross-provider composition tests
  like Grok's; an isolated native-load probe (projected file resumes in a
  sandboxed real `pi`).

### Stage 11 — Switch, duplicate (app)
- **Produces:** `piTranscript.ts` host adapter, `transcriptEngine` registration,
  `ipcPromptAddress`, `compactBeforeSwitch` Pi branch, feature matrix flags.
- **Verified by:** switch tests Pi↔each provider over fixtures; duplicate
  produces a new Pi file that resumes; the full directed graph test.

### Stage 12 — Built-in MCP via bridge (D5)
- **Produces:** bridge tool proxy, env plumbing from `builtInMcpServers`,
  `BUILT_IN_MCP_DOMAINS_BY_PROVIDER.pi`.
- **Verified by:** live-tier test: faux provider scripted to call
  `mcp__agent_code__tldr_update` → the app-side MCP host receives it with the
  session's bearer; tool list matches the session's domains.

### Stage 13 — Verification and PRs
Package gate, parser gate, app gates (`npm run typecheck`, `test:contract`,
`conditions-core:check`, `npm test` once on Node 24, `test:package`), diff
review, PRs (package, parser, app — app PR last, pointing at pushed commits).
Never launch Agent Code.

## 8. Hypotheses Stage 0 must confirm or kill

Results (2026-09-22, Pi 0.87.1, 18 recorded scenarios): H1, H2, H4, H8, H9
hold. H3, H5 and H6 hold only in the refined forms applied above (doorbell =
`turn_end`/`agent_settled`, never `message_end`; always `deliverAs:
'followUp'`; live leaf from `session_tree`). H7 observed (trust fires to `-e`
extensions before `session_start`; not a `ui_prompt`). H10 partly open (no
old-version file recorded; hand-authored v1/v2 fixtures). Details and
evidence: `packages/pi-terminal-headless/research/census-2026-09-22.md`,
pinned by `src/testing/fixtures.corpus.test.ts`.

- **H1** `--session-id <new uuid>` creates `<ts>_<uuid>.jsonl`; the stderr
  warning is a single line above the TUI and harmless. (If not: `--session
  <chosen absolute path>` + read the id from the header.)
- **H2** `getSessionFile()` at `session_start` equals the file later created, for
  fresh, resumed, `/new`, `/fork`, `/clone`.
- **H3** At the extension's `message_end` handler, the row is already on disk
  (doorbell validity). Measured as "byte length at event time ≥ row end".
- **H4** `agent_settled` fires exactly once per run, after the last row, and
  not while a steer/follow-up is pending.
- **H5** `sendUserMessage` with `deliverAs: 'followUp'` while busy is persisted
  and runs after the current run; while idle without `deliverAs` it starts a
  run. Pi's own `input` event carries our correlation (or we correlate by
  text + source `extension`).
- **H6** `/tree` produces a `session_tree` event and the new leaf; the last line
  of the file is always the active leaf after navigation.
- **H7** The project-trust prompt happens before `-e` extensions can answer it
  or not — and what `project_trust` lets the bridge report.
- **H8** DA1 / Kitty keyboard queries are answered by node-pty + xterm.js in the
  pane (the app's terminal emulator), so Pi doesn't stall at startup.
- **H9** A 0600 socket in a 0700 dir under `/tmp` is reachable from Pi launched
  with the user's env on macOS (sandboxing, `TMPDIR` differences).
- **H10** v1/v2 session files exist in the wild only as pre-migration leftovers;
  the reader never sees mixed versions inside one file.

## 9. Unknowns and risks

- **Upstream churn.** Weekly minors with breaking changes. Mitigation: pinned
  accepted version in `support/upstream-versions.json`, upstream-watch
  workflow, tolerant guards, bridge hello refuses unknown protocol versions
  with a diagnostic instead of misreading.
- **Our code inside the user's process.** §6 rules; the live test kills the host
  side mid-run and asserts `pi` survives.
- **Real-provider content shapes** (redacted thinking, signatures, images) are
  not covered by faux recordings. This machine has no Pi login (Stage 0), so
  the corpus is faux-only; the reader must stay tolerant of unknown content
  block types.
- **Global-match fork question / missing-cwd prompt** read in source, not run.
- **Unverified third-party `pi-mcp-adapter`** — not used; D5 is our own proxy.
- **Project trust (open question T):** leave the native prompt to the user
  (attention badge) vs. map Agent Code's dangerous mode to `--approve`. Default
  in this spec: never auto-approve; surface the prompt as a condition.

## 10. Fixture plan

- **Live fixtures** (Stage 0 probe, faux provider, sandbox): kept verbatim
  except sandbox paths normalized to `/sandbox`; each = `{meta:{recordedWith,
  scenario, piVersion}, bridge:[{t, event}], file:[{t, bytes}], pty:[{t,len}],
  prompts:[…]}` plus the final `.jsonl`.
- **Durable fixtures** (census, only with permission if the user has real Pi
  sessions): allowlist sanitizer — keep `type`, `role`, `stopReason`, ids,
  `parentId`, timestamps, tool names, versions; replace every free-text value
  with length-class placeholders.
- **The oracle is never the reader:** branch expectations come from a reference
  walk defined in `testing/oracle.ts` (independent of `transcript/`), status
  expectations from the recordings' own `agent_start/agent_settled` events,
  ordering expectations from §5.4.

## 11. What is being isolated

- `src/reconcile/` — the only module that sees both sources. Single consumer
  `PiTerminalHeadless`.
- `src/transcript/SessionFile.ts` — the only code that knows Pi's schema.
- `src/bridge/extension.ts` — the only code that runs inside Pi; imports
  nothing from the package at runtime.
- Agent Code imports the package root only (plus `pi-terminal-headless/testing`
  in tests).
