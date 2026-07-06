# Phase 0 seam inventory (Task 1 findings)

Working notes for the SessionFeed refactor. Source of truth for which call
sites Tasks 5-6 edit. Delete or fold into the plan when Phase 0 merges.

## window.api shape

FLAT — every domain module is spread onto one `api` object
(`src/preload/api/index.ts`). So `window.api.sendInput(...)`,
`window.api.onSessionScreen(...)`. IpcSessionFeed delegates to the flat
surface.

## Listeners the feed covers (all in useIpcSubscriptions.ts)

| Listener | Line |
|---|---|
| onSessionStarted | 525 |
| onSessionScreen | 542 |
| onSessionJsonlError | 689 |
| onSessionExit | 698 |
| onSessionProcessState | 761 |
| onSessionSemanticEvent | 810 |
| onSessionConditions | 1163 |
| onSessionSubAgents | 1202 |
| onSessionJsonlEntries | 1227 |

Caller: `src/renderer/src/workspace/hook/index.ts:445` —
`useIpcSubscriptions(refs, setState, setRuntimes, updateRuntime, appendFeedDebug)`.

## Listeners deliberately NOT in the feed (raw PTY, desktop-only)

- `onSessionAgentPtyData` — AgentTerminalLeaf.tsx:169, features/debug/ui/AgentInlineTerminal.tsx:98
- `onSessionTerminalData` — TerminalLeaf.tsx:255

Phone v1 has no terminals; these stay on window.api.

## Input call sites routed through the feed (Task 6)

Agent-composer / feed-row paths (reachable by the phone client later):

- `workspace/tile-tree/TileLeaf.tsx:230,234` — sendInput (composer submit)
- `workspace/tile-tree/TileLeaf.tsx:581` — resolveCondition (condition banner)
- `workspace/tile-tree/TileLeaf/useComposerDictation.ts:322` — sendInput (dictation bracket paste)
- `features/feed/ui/semantic/AskUserQuestionRow.tsx:213` — resolveCondition
- `features/feed/ui/semantic/AskUserQuestionRow.tsx:360` — sendInput

## Input call sites that stay on window.api (raw-terminal, desktop-only)

- `workspace/tile-tree/AgentTerminalLeaf.tsx:163,207` — sendInput (xterm keystrokes)
- `workspace/tile-tree/TerminalLeaf.tsx:218,298` — sendInput (xterm keystrokes)
- `features/debug/ui/AgentInlineTerminal.tsx:93` — sendInput (debug terminal)

## deliverPrompt

ZERO renderer call sites today — it exists on preload for the MCP
orchestration path (opencode, API transport, no PTY). It stays in the
SessionFeed contract because the phone client MUST use it for opencode
sessions; IpcSessionFeed delegates to the existing `window.api.deliverPrompt`.
No desktop call-site changes.

## Payload type home

Declared in `src/preload/api/types.ts`; constituents come only from
`@shared`/`@mcp`. Decision (per plan Task 1 Step 2 rule): move the pure event
declarations to `src/shared/sessionFeed/types.ts`, have preload re-export so
every existing `@preload/api/types` import keeps resolving byte-for-byte
(same pattern providerConditions.ts documents for conditions-core).

Types moving to shared: Unsub, PickerItem, SlashPickerState, ScreenSnapshot,
SessionStartedEvent, SessionScreenEvent, SessionJsonlEntriesEvent,
SessionJsonlErrorEvent, SessionSemanticEvent, SessionConditionsEvent,
SubAgentToolCall, SubAgentState, SessionSubAgentsEvent, SessionExitEvent,
ResolveConditionResult, and a new named SessionProcessStateEvent (currently an
inline literal in preload/session.ts). JsonlEntry stays a preload alias of
`@shared/types/session`'s AgentTranscriptEntry; shared types use
AgentTranscriptEntry directly.

ConditionCustomAction already lives in `@shared/conditions-core/contract` —
re-export, don't move.
