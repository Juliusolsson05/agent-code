# Hermes: chat with your remote Hermes agent in an Agent Code pane

Refs #1482.
Branch `feat/hermes-agent-pane` · Worktree `.worktrees/hermes-agent-pane` · Base `origin/main` @ `1bcba637` (2026-09-27 tip, fetched 2026-10-13)
Status: approved 2026-10-13 (owner: "Yes good, lets build this whole thing … do not stop until we have the full thing built out in agent code and validated"); full build running as a goal loop with parallel orchestration reviewers. Decisions 3-11 ship at their defaults under that go-ahead (not individually confirmed — still listed as UNCONFIRMED product calls in the PR).
Decomposition: `docs/decomposition/hermes-remote-chat.md`. The decomposition
wins where they differ; Tasks 1-9 are its stages, plus cross-repo ordering.

## Outcome

A Hermes user stops switching to Telegram. In Agent Code they:

1. add their VPS's `hermes serve` under **Settings → Hermes**, sign in once in
   the browser, and see it marked connected, with its version;
2. open **New Hermes** in any tab, which gives a chat pane next to their coding
   agents;
3. chat with their own Hermes, the same agent with the same memory, skills,
   cron and tools it has on Telegram:
   - replies stream;
   - tool calls show as collapsible chips;
   - approvals, questions, sudo and secret requests appear as inline cards;
   - Esc stops a turn;
   - `/new` starts a fresh conversation in the same pane, as in Telegram;
   - slash commands and skills complete as you type;
4. close the laptop, reload or lose Wi-Fi, and get the same conversation back,
   with nothing lost or doubled.

Nothing is installed on the Mac. Hermes keeps running where it already runs.

## Evidence (verified, do not re-derive)

Hermes facts with upstream file paths are in decomposition §1. Agent Code seams
were verified on `origin/main` `1bcba637` and are listed below. Key upstream
facts, repeated here because every task depends on them:

- The integration surface is `hermes serve` (`tui_gateway`), a WebSocket
  JSON-RPC backend at `/api/ws`. It is the backend Hermes' own Electron
  desktop app uses. Its contract is Pydantic, generated to TS. `@hermes/shared`
  is private, so we write our own client.
- Remote sign-in is RFC 8252 PKCE:
  `/auth/native/authorize` → loopback code → `/auth/native/token` →
  `/auth/native/refresh` (reuse-detected) → `/api/auth/ws-ticket` (30 s,
  single use) → `wss://…/api/ws?ticket=`.
- The chat-core contract subset is unchanged between `v0.21.7` and `main`
  2026-10-13. The day's churn (+520/−189) was entirely in Desktop-only
  surfaces.
- Telegram sessions are rows the `serve` backend only *views*. Continuing them
  from a pane is unsupported upstream (decomposition G5).

Agent Code seams on `origin/main` `1bcba637` (a survey, with key items
re-read):

- **The single provider id list:** `AGENT_PROVIDER_KINDS`
  (`src/shared/types/providerKind.ts:35`). Exhaustive `Record<AgentProviderKind,…>`
  registries turn a missing entry into a compile error:
  - `src/providers/registry.main.ts:213-219`
  - `registry.renderer.capabilities.ts:471-477`
  - `registry.setup.ts:109-115`
  - `registry.renderShapes.ts:21-27`
  - `providers/shared/featureCapabilities.ts:102-172`
  - `src/mcp/shared/types.ts:108,252`
- **Hand-written lists that do NOT fail compilation** (edit by hand):
  - `src/main/agentActivity/attention.ts:18-24`
  - `src/remote-client/src/ui/v2/providerIdentity.ts:20-34`
  - `src/control-sdk/catalog/transcripts.ts:6`
  - `src/main/providerSwitch/transcriptEngine.ts:565,748`: not touched,
    because Hermes declares no switch features
  - `src/shared/skills/installSource.ts:72-80`
  - `scripts/extract-rendering-shape.mts:85`
  - `src/shared/types/cliUpdate.ts:33`: not touched
- **Binary requirement:** `SessionManager.spawnWithId` resolves
  `getToolPath(kind)` and throws `ProviderCliNotFoundError`
  (`src/main/sessionManager.ts` ~3080-3100) before MCP registration.
  `ProviderSetupDescriptor` is binary-only (`registry.setup.ts:21-49`).
- **cwd requirement:**
  - `SessionOptions.cwd` is required.
  - Detached spawn aborts without a project folder
    (`src/renderer/src/workspace/hook/actions/pane.ts` ~1139-1141).
  - `SessionMeta.cwd` and `projectId` are the ownership facts
    (`workspace/types.ts:164,353`).
- **Surface choice:** `TileTree.tsx:116-187` (terminal / extension-view /
  `getEffectiveAgentSurfaceForSession` → `AgentTerminalLeaf` | `TileLeaf`).
  The "no PTY, rendered only" pin is a literal `kind !== 'opencode'` in
  `agentDisplayMode.ts:44`. Further OpenCode-only literals:
  - `workspace/hook/index.ts:170`
  - `AgentViewModePickerModal.tsx:52`
  - `providerKind.ts:128-130`
- **Template:** structured OpenCode.
  - `OpencodeSession` maps package events to `jsonl-entry` / `semantic-event`
    (with numeric `blockIndex`) / `conditions` / `process-state` /
    `input-readiness`, attaching listeners **before** `start()`
    (`src/providers/opencode/runtime/opencodeSession.ts:150-260`).
  - Prompts go through `deliverPromptText` with `transport` acceptance
    (`opencode/runtime/promptDelivery.ts`).
  - The composer throws on a failed delivery so the draft survives
    (`opencode/renderer/composerSubmit.ts`).
- **Template for JSON-RPC server→client requests as conditions:** Grok
  (`grokSession.ts:310-316,453-462`, PR #844).
- **Encrypted, prompt-free, destination-bound secrets:**
  `src/main/userMcp/secrets.ts` (PR #1144, #1304 binding).
- **Ledger:**
  - `createSessionLedger` (`src/renderer/src/rendering/model/ledger.ts:197`)
    via `useLedgerFeedItems` (`features/feed/ledger/useLedgerFeedItems.ts:56`).
  - Consumers: `Feed.tsx`, **`ReaderView.tsx`** (a conversation-style
    projection over the same rows; the precedent for the chat surface) and
    `useAgentFeedModel.ts`.
- **Hermes in the repo today:** none (`git grep -i hermes`: unrelated test
  strings only; no issues/PRs/branches before #1482).

## Decisions

1. **Where Hermes runs.** *Default: the user's VPS `hermes serve`, configured
   in Settings.* Answered 2026-10-13: "all users will use hermes from their
   VPS instances so we have connection info for that in settings."
2. **What the pane is.** *Default: a chat that replaces the Telegram UI.*
   Answered 2026-10-13: "replace the telegram UI with a agent code ui to take
   up a agent window".
3. **Connection kinds in v1.** *Default: URL + browser sign-in only*, because
   one PKCE implementation covers password and OAuth backends. Alternatives: an
   SSH tunnel to a loopback-only backend, or Hermes Cloud (both follow-ups).
   **UNCONFIRMED.**
4. **Telegram sessions.** *Default: separate*: same agent, its own
   conversation. Alternative: read-only Telegram history in a picker
   (follow-up). Continuing them is rejected (G5). **UNCONFIRMED.**
5. **Pane identity.** *Default: Telegram semantics*:
   - the pane is the chat;
   - `/new` rotates the Hermes conversation inside the pane
     (`provider-session-changed`);
   - a reload resumes the pane's current conversation.

   Alternative: one Hermes Desktop–style "Bot Chat" forever-chat per profile.
   **UNCONFIRMED.**
6. **Several connections.** *Default: several named connections*; each pane
   records its connection id. **UNCONFIRMED.**
7. **Local folder.** *Default: any tab; `cwd` is local metadata, never sent.*
   **UNCONFIRMED.**
8. **Secret/sudo answers.** *Default: supported, masked, never persisted,
   logged or recorded.* Alternative: always decline in v1. **UNCONFIRMED**
   (decomposition Unknown 4).
9. **Prompt while Hermes is busy.** *Default: Agent Code's existing queued-
   prompt UI*: hold the prompt locally and submit after `message.complete`.
   Hermes' own steer/redirect is out of scope. **UNCONFIRMED** (Unknown 5).
10. **Hermes `source` tag.** *Default: `agent-code`*, so Hermes can tell our
    sessions apart and they are never gateway-owned. **UNCONFIRMED** (Unknown
    3).
11. **Mode.** Plan-only now (owner: "write the massive plan file"). The build
    starts on explicit approval, then runs as a full build to an open PR, with
    two hard stops: Stage 0 results, and any **[gate]** hypothesis disproven.

## Design

### Repositories

- **New repo `Juliusolsson05/hermes-headless`** (public, MIT): a git
  submodule at `packages/hermes-headless`, compiled from source through Vite
  aliases exactly like `grok-code-headless` (PR #835). It is **not** a `file:`
  dependency, which broke `npm ci`. Its layout mirrors its siblings:
  - `src/HermesHeadless.ts`
  - `src/index.ts`
  - `src/channels/{SemanticChannel,CommittedChannel,ScreenChannel,types}.ts`
  - `src/contract/`
  - `src/auth/`
  - `src/transport/`
  - `src/reconcile/`
  - `research/{record-wire.mts,corpus/,catalog.md}`
  - `testing/`
  - `support/upstream-versions.json`
  - `scripts/check-test-contract.mjs`
  - `vitest.config.ts`, `vitest.live.config.ts`, `tsconfig.build.json`
  - npm scripts `check`, `test:core`, `test:system`, `test:live`,
    `test:package`, `test:contract`

  The package never spawns anything, never stores or refreshes a credential,
  never opens a browser, and never reconnects on its own. It receives
  `dial()` from the app.
- **New reference submodule `vendor/hermes-agent-src`** at tag `v0.21.7`
  (`71d34bad`), like `vendor/codex-src`. Never imported, never built.

### Package contract (`hermes-headless`)

```
type HermesTarget = { mode: 'create'; source: string; title?: string }
                  | { mode: 'resume'; storedSessionId: string }
type HermesDial = () => Promise<WebSocketLike>   // app mints ticket + URL each call

class HermesHeadless extends EventEmitter {
  constructor(opts: { dial: HermesDial; target: HermesTarget; requestTimeoutMs?: number })
  readonly semantic: SemanticChannel     // turn_started/text_delta/thinking_delta/tool_started/
                                         // tool_completed/turn_completed/turn_stopped/api_error/usage_updated
  readonly committed: CommittedChannel   // 'entry' (HermesCommittedEntry, row_id keyed), 'history_error'
  readonly screen: ScreenChannel         // 'activity' {active, status}
  // emitter events: 'connection' (ConnectionState), 'session' ({storedSessionId, runtimeSessionId, info}),
  //                 'request' / 'request-cancelled' (HermesOpenRequest), 'exit', 'unknown' (UnknownShape)
  start(): Promise<void>                 // dial → ready → capabilities → create|resume → emit snapshot
  reconnect(): Promise<void>             // owner-driven redial + replay (the owner's loop calls this)
  prompt(text: string): Promise<PromptSubmitResult>
  interrupt(): Promise<void>
  newConversation(): Promise<void>       // session.close + session.create; emits 'session'
  answerRequest(id: string, result: unknown): void
  declineRequest(id: string): void
  completeSlash(text: string): Promise<SlashCompletion>
  runSlash(command: string): Promise<SlashOutcome>   // resolves skill/send directives into prompt()
  stop(): Promise<void>                  // session.close is NOT called (the conversation stays resumable)
}
// Auth: pure HTTP helpers, fetch injected
probe(baseUrl, fetch): Promise<{authRequired, providers, version, displayVersion}>
buildAuthorizeUrl(...): string
exchangeCode(...), refreshTokens(...), mintWsTicket(...): Promise<…>
buildWsUrl(baseUrl, ticket): string
```

**Invariants** (each becomes a WHY comment at the code that protects it):

- **Exactly-once dispatch per `(runtime session, seq)`.** Live frames for a
  replaying session are parked until the replay lands. An epoch change clears
  watermarks and forces a `session.resume` re-snapshot.
- **Every server request the package does not support is declined at once
  with `-32601`**, so the agent never waits out a 120-300 s timeout on a UI
  that does not exist (H11).
- **`client.capabilities {server_requests:true}` is sent on every
  `gateway.ready`.** Without it the backend silently drops approvals for this
  client.
- **`stop()` never calls `session.close`.** Closing the pane must not end
  the conversation; the reaper and the next resume own that.
  `newConversation()` is the only path that closes.
- **Committed rows are keyed by `row_id`.** A live turn is claimed by its
  `persisted_turn.row_ids` (H6), never by text similarity.

### App runtime

- **`src/shared/types/providerKind.ts`:**
  - add `'hermes'` to `AGENT_PROVIDER_KINDS`;
  - add `REMOTE_PROVIDER_KINDS = ['hermes'] as const satisfies readonly AgentProviderKind[]`
    with `isRemoteProviderKind(value: unknown)`, meaning "no local binary,
    `cwd` is metadata";
  - add `CHAT_SURFACE_PROVIDER_KINDS = ['hermes']` with
    `isChatSurfaceProviderKind`.

  WHY two sets, not one: "remote" governs spawn and setup, "chat surface"
  governs the pane, and a future remote coding agent would want the feed.
  This mirrors `TERMINAL_ONLY_PROVIDER_KINDS` (read-time resolution, so no
  spawn path can miss a stamp).
- **`src/providers/registry.setup.ts`:** `ProviderSetupDescriptor` becomes a
  union:
  - `{ kind: 'binary', binaryName, label, detail, install }` (existing
    entries gain `kind: 'binary'`);
  - `{ kind: 'remote', label, detail, docsUrl }` for Hermes.

  Binary resolution and the SetupGate iterate only `kind:'binary'`. Hermes
  readiness is "≥1 connection signed in". Ruling at implementation if the
  union ripples too far: a separate `remoteProviderDescriptors` table, with
  the reason recorded.
- **`src/main/sessionManager.ts` `spawnWithId`:** when
  `isRemoteProviderKind(kind)`:
  - skip binary resolution;
  - pass `binary: undefined`;
  - require `options.hermesConnectionId`, threaded as a provider-scoped launch
    option (exact field name decided against `SessionOptions` at
    implementation and recorded);
  - throw a typed `RemoteProviderNotConnectedError` (rendered by
    `sessionSpawnErrorMessage`) when the connection is missing or signed out.

  Built-in MCP, user MCP and the skill reconcile are skipped for remote kinds
  (out of scope): `builtInMcpDomains` must be empty for Hermes in
  `mcp/shared/types.ts`.
- **`src/main/hermes/`:**
  - `connectionStore.ts`: `HermesConnection[]` in
    `<userData>/hermes/connections.json`, atomic writes, normalized URLs, and
    names that are unique per connection.
  - `tokenStore.ts`: safeStorage blobs, destination-bound to the normalized
    URL. Copies the `userMcp/secrets.ts` pattern, including "an unbindable
    record reads as signed out".
  - `tokenBroker.ts`: `getDial(connectionId): HermesDial`, with refresh
    single-flight per connection and `connection-state` events.
  - `nativeSignIn.ts`: PKCE, a loopback listener, `shell.openExternal`, state
    check, code exchange, a 10-minute deadline.
  - `ipc.ts`: `hermes:connections:list/add/update/remove/test/sign-in/sign-out`
    and a `hermes:connections:changed` push. Tokens never cross IPC.
- **`src/providers/hermes/runtime/hermesSession.ts`** (`AgentSession`):
  - Listeners are attached before `start()`.
  - Package `committed.entry` → `jsonl-entry(entry, 'hermes://<connectionId>/<storedSessionId>')`.
  - `semantic.*` → `semantic-event`.
  - `screen.activity` → `process-state`.
  - Requests → `conditions` snapshot (`hermes.approval`, `hermes.clarify`,
    `hermes.sudo`, `hermes.secret`), resolved by `resolveCondition` →
    `answerRequest`.
  - `session` → `provider-session-changed`.
  - Connection → `input-readiness`.
  - **Owns the reconnect loop:** full-jitter backoff (300 ms base, 15 s cap;
    a socket counts as stable after 5 s open), stopping on `auth-rejected`.
  - `write('\x1b')` → `interrupt()`; `resize` is a no-op;
    `deliverPromptText(text)`.
- **`src/providers/hermes/runtime/promptDelivery.ts`:** copies
  `deliverOpencodePrompt`:
  - `transport` acceptance;
  - refused before dispatch: `before-write`, `retrySafe: true`;
  - dispatched with the outcome unknown: `after-enter`, `do-not-retry`.
- **`src/shared/types/providerConditions.ts`:** `HermesCondition` union and
  `HermesConditionSnapshot`. The state carries only what the cards render;
  secret/sudo state never carries an answer.
- **`src/shared/types/providerConditionAttention.ts`:** all four kinds need
  attention.

### Renderer

- **`agentDisplayMode.ts`:** `normalizeAgentViewModeForKind` pins
  `isChatSurfaceProviderKind(kind) || kind === 'opencode'` to `'agent'`, with
  the existing WHY extended. `workspace/hook/index.ts:170` and
  `AgentViewModePickerModal.tsx:52` use the same predicate.
- **`TileTree.tsx`:** before the terminal/feed choice, an
  `isChatSurfaceProviderKind(kind)` branch mounts `HermesChatLeaf`, still
  inside `TldrPane` + `GoalLoopPane`, so the peeks keep working.
- **`src/renderer/src/features/hermes-chat/`:**
  - `HermesChatLeaf.tsx`: header (connection, model, state), message list,
    condition cards, composer.
  - `chatProjection.ts`: a pure projection from `useLedgerFeedItems` rows to
    `ChatItem[]` (`user` | `assistant` | `tool-chip` | `notice`), modelled on
    `readerMessages.ts`.
  - `bubbles/*`, `ToolChip.tsx`.
  - The **existing composer component** is reused (drafts, queue, history,
    keybinds), with a Hermes slash-completion source.

  **The chat surface owns no ownership or dedupe logic.** That is the
  ledger's job, already used by Feed and Reader.
- **`src/providers/hermes/renderer/`:**
  - `identity.ts`: glyph ☤, label "Hermes", `resumeCommand: null`.
  - `composerSubmit.ts`: copy of OpenCode's.
  - `transcript/mapper.ts`: Hermes `TranscriptMessage` rows → Claude-shaped
    entries, so Reader Mode, search, View Prompts and the phone work
    unchanged.
  - `semanticFoldPolicy.ts`, `ledgerPolicy.ts`, `shapes.ts`.
  - `conditions/{policy.ts,views.tsx}`: cards with masked inputs; actions are
    custom, `actionKinds` empty.
  - `rows/dispatch.tsx`: generic fallbacks; tool chips live in `hermes-chat`.
- **Settings:** a `hermes-connections` entry in `settingsRegistry.ts`, plus
  `src/renderer/src/features/hermes-settings/HermesConnectionsPanel.tsx`
  (list, add, sign in, test, sign out, remove). Every state has its own copy
  and a way forward.
- **Commands:** "New Hermes…" (`paneCommands.ts`; picks the connection when
  there are several). Generated `New <shortLabel>` commands come for free from
  the registry; `catalog.test.ts` counts update.

### Why this shape and not the obvious alternative

- **The obvious build** is a Hermes React component that opens a WebSocket
  from the renderer and renders events directly. It would:
  - put credentials in the renderer;
  - skip the reconnect/replay reconciliation (the 40%-correct trap);
  - bypass every shared surface (Reader, search, TLDR, phone, close
    commands);
  - duplicate the ledger's ownership rules.
- **This design** puts the wire in an isolated, recording-tested package,
  makes Hermes an ordinary `AgentSession` emitting the vocabulary every
  consumer already understands, and makes the chat window only a new *view*
  over the same runtime state.

## Files

**`hermes-headless` (new repo):**
- Create the whole layout above. `README.md` carries the MIT attribution for
  any logic modelled on `@hermes/shared`.

**`agent-code`:**
- Create:
  - `vendor/hermes-agent-src` (submodule, reference only)
  - `packages/hermes-headless` (submodule)
- Modify:
  - `.gitmodules`
  - `electron.vite.config.ts` (`headlessAlias`, `headlessExclude`)
  - `tsconfig.node.json` (`paths`, `include`)
  - `tsconfig.web.json` (`paths`)
  - `vitest.config.ts` (alias)
  - `support/upstream-versions.json`
- Modify:
  - `src/shared/types/providerKind.ts`: the kind plus the two sets
  - `src/shared/types/providerConditions.ts`
  - `src/shared/types/providerConditionAttention.ts`
- Modify:
  - `src/providers/registry.main.ts`
  - `registry.renderer.capabilities.ts`
  - `registry.setup.ts` (descriptor union)
  - `registry.renderShapes.ts`
  - `providers/shared/featureCapabilities.ts` (`NO_PROVIDER_FEATURES`)
  - `src/mcp/shared/types.ts` (empty defaults)
- Create:
  - `src/providers/hermes/runtime/{hermesSession.ts,promptDelivery.ts,skillDiscovery.ts}`
    (skills: `{supported:false, reason:'remote agent; skills live on the Hermes host'}`)
  - `src/providers/hermes/renderer/*` (above)
- Create `src/main/hermes/{connectionStore,tokenStore,tokenBroker,nativeSignIn,ipc}.ts`.
- Modify:
  - `src/main/sessionManager.ts`: the remote spawn path
  - `src/main/index.ts`: construct the Hermes services
  - `src/main/ipc/*` registration
  - `src/preload/api/*` + `index.d.ts`
- Modify (setup readiness for remote kinds):
  - `src/main/setup/{binaryResolver,toolchain,providerEnablement}.ts` and the
    readiness code;
  - `features/setup/ui/SetupGate.tsx`: skip binary rows for remote kinds.
- Modify, renderer:
  - `src/renderer/src/workspace/agentDisplayMode.ts`
  - `workspace/hook/index.ts`
  - `features/workspace/ui/AgentViewModePickerModal.tsx`
  - `workspace/tile-tree/TileTree.tsx`
  - `workspace/hook/actions/pane.ts`: the remote kind needs no project folder
- Create:
  - `src/renderer/src/features/hermes-chat/*`
  - `features/hermes-settings/*`
- Modify:
  - `src/main/agentActivity/attention.ts`
  - `src/remote-client/src/ui/v2/providerIdentity.ts`
  - `src/control-sdk/catalog/transcripts.ts`
  - `src/shared/skills/installSource.ts`: not touched if skills are
    unsupported; ruling at implementation
  - `scripts/extract-rendering-shape.mts`
- Modify:
  - `features/command-palette/*` (`paneCommands.ts`, keyword lists)
  - `settingsRegistry.ts`
  - `catalog.test.ts`
  - `src/providers/providerFeatures.test.ts`
  - `src/shared/types/providerKind.test.ts`
- Modify `ARCHITECTURE.md`: §5.2 package table, §5.3 provider table and a new
  §5.3.x "Hermes (remote chat)", plus a diagram if the section needs one (per
  the diagram workflow memory).

## Tests

Every fixture comes from the Stage 0 corpus, labelled per decomposition §12.
Each test names the failure it would show before its code exists.

**Package (`hermes-headless`):**

| Test | Fixture | Asserts | Red before |
|---|---|---|---|
| `contract/subset.test.ts` | every corpus frame | every frame parses against the subset; unknown types land in the ignore list or `unknown` | parser missing / subset too narrow (H14) |
| `auth/nativeFlow.test.ts` | S1, S2 HTTP | authorize URL params; code exchange; failure classes | no auth client |
| `auth/refresh.test.ts` | S14 | rotation result shape; a 401 → `session-expired` | — |
| `transport/replay.system.test.ts` | S8 + mechanical cut points | exactly-once dispatch across a drop; held frames released in order | goes red when the replay hold is removed (mutation proof) |
| `transport/epoch.system.test.ts` | S11 (local) | an epoch change clears watermarks and forces a re-snapshot | stale watermark → silent loss |
| `transport/unsupportedRequest.test.ts` | the first corpus occurrence of an unsupported request (or a local probe if absent, labelled) | a `-32601` reply is sent at once | stall until timeout (H11) |
| `reconcile/differential.system.test.ts` | S3-S12, S15 | the channel stream folded from a live recording == the fold of `session.resume` on the same stored id | H6 violation / duplicate turn |
| `reconcile/requests.system.test.ts` | S5, S6, S7, S10 | request add → cancel/answer → removed; `open_requests` after a reconnect re-add exactly once | ghost cards |
| `HermesHeadless.live.test.ts` (opt-in) | a real backend via env | create → prompt → complete → resume | — |

**App:**

| Test | Fixture | Asserts | Red before |
|---|---|---|---|
| `src/main/hermes/tokenBroker.test.ts` | S14 exchanges, fake clock | concurrent `getDial()` → one refresh; a 401 → signed-out | double refresh = logout |
| `src/main/hermes/tokenStore.test.ts` | justified literals (no wire) | a token bound to URL A reads as signed-out for URL B | token sent to an edited URL (#1304 class) |
| `src/main/hermes/nativeSignIn.test.ts` | justified literals | state mismatch rejected; listener closed after the first valid hit or the deadline | — |
| `sessionManager.remoteProvider.test.ts` | — | a Hermes spawn needs no binary, never passes `cwd` to the session, and refuses a signed-out connection with the typed error | `ProviderCliNotFoundError` |
| `src/providers/hermes/runtime/hermesSession.system.test.ts` | the corpus through a fake WS server | `AgentSession` event stream; `/new` → `provider-session-changed`; Esc → interrupt; the reconnect loop stops on auth-rejected | — |
| `src/providers/hermes/renderer/transcript/mapper.test.ts` | S12 resume snapshot | rows → entries; tool rows paired; `row_id` preserved | — |
| `features/hermes-chat/chatProjection.test.ts` | S4, S8 replayed through the runtime + ledger | the bubble/chip/card sequence; no duplicate after a reconnect | duplicate bubble when the ledger claim policy is dropped (mutation proof) |
| `features/hermes-chat/HermesChatLeaf.renderer.test.tsx` | S5/S6 | cards render; secret input masked; answer → `resolveCondition` payload; a withdrawn card disappears | — |
| `providerKind.test.ts`, `providerFeatures.test.ts`, `catalog.test.ts` | — | Hermes in the sets; no switch/rewind features; generated commands | — |

## Verification

- **Per task:** scoped vitest for the touched files; `npx tsc -b` (memory: the
  build and vitest do not type-check; never `--noEmit` on the node project).
- **Worktree setup first** (memory):
  - `git submodule update --init` for the new and existing packages;
  - symlink `node_modules` only if absent;
  - Node 24.
- **Once at the end:**
  - the package's `npm run check`;
  - the app's `npm run check` (known local env failures, per memory: the
    imageAttachment and store-timeout tests, which also fail on main);
  - CI quality gate.
- **Submodule hygiene** (memory):
  - push `HEAD:<branch>` from the submodule and verify the origin sha before
    bumping the gitlink;
  - check `git diff origin/main --submodule=short` before any merge commit.
- **Verification boundary.** Not provable here, reported as such in the PR:
  - the packaged app;
  - a real multi-hour session with sleep/wake (the S8/S9 recordings stand in);
  - Nous OAuth if the owner only provides a password backend (S2 then stays
    UNVERIFIED);
  - the visual quality of the chat surface (never launch the app, per memory;
    manual QA is owed by the owner);
  - Hermes Desktop on the same session (S16) if no second client is available.

## Out of scope

Each item goes to a follow-up issue filed at PR time:

- **SSH-tunnel and Hermes Cloud connection kinds.** One flow first.
- **Telegram history in a picker** (read-only), and any Telegram continuation
  (G5).
- **Conversation catalog / resume picker for Hermes rows.** The pane resumes
  its own conversation.
- **Provider switch, duplicate and rewind** to or from Hermes. These need an
  agent-transcript-parser codec (parser#5).
- **Image/file attachments.** `image.attach`, `pdf.attach` and `file.attach`
  exist upstream.
- **Voice / dictation sent as Hermes voice turns.** The existing dictation
  into the composer still works.
- **Agent Code built-in MCP (Goal/TLDR/orchestration) inside Hermes.**
  Hermes' MCP config lives on the VPS. The peeks still show the pane.
- **A model picker UI.** `/model` via `slash.exec` works; a picker comes
  later.
- **Hermes Desktop extras:** previews, pets, rooms, Bot Mode, subagent
  roster, todos panel, the MoA view.
- **Steer/redirect while busy** (Decision 9).
- **Auto-updating Hermes** (`CliUpdateKind`). Hermes updates on its own host.

## Tasks

- [x] **0. Approval + prerequisites.** (approved 2026-10-13; no VPS given, so the Ruling's local real-backend method was used)
  - The owner approves this plan and the decomposition; UNCONFIRMED items
    become answers.
  - The owner provides a VPS backend URL to record (password or OAuth),
    whether it is behind Tailscale, and permission to create the public
    `Juliusolsson05/hermes-headless` repo.
  - Hands to task 1: the backend URL (kept out of git) and the go-ahead.
- [x] **1. Package scaffold + recorder.**
  - Create the `hermes-headless` repo mirroring opencode-headless/grok
    (scripts, configs, test contract).
  - `research/record-wire.mts` (a dumb tap with same-length redaction and a
    whole-file entropy scan).
  - Add the `vendor/hermes-agent-src` submodule at `v0.21.7`.
  - Produces the recorder.
  - Verified by: a dry run against a local loopback `hermes serve`.
- [x] **2. Stage 0: record S1-S16, publish results.**
  - Corpus under `research/corpus/`.
  - Counts per scenario and per event type; H1-H14 verdicts written into
    decomposition §7.
  - **STOP and report to the owner**; stop also if any [gate] is DISPROVEN.
  - Hands on: the corpus manifest.
- [x] **3. Stage 1: contract subset + catalog.**
  - `src/contract/*` and `research/catalog.md`.
  - Hands on: the exact TS types (`HermesEvent`, `HermesServerRequest`,
    `LiveSessionSnapshot`, `TranscriptMessage`, `PromptSubmitResult`).
  - Verified by: `subset.test.ts`.
- [x] **4. Stage 2: auth client.**
  - `src/auth/*`.
  - Hands on: `probe`, `buildAuthorizeUrl`, `exchangeCode`, `refreshTokens`,
    `mintWsTicket`, `buildWsUrl`, and the failure classes.
  - Verified by: the auth tests on S1/S2/S14.
- [x] **5. Stage 3: RPC transport.**
  - `src/transport/RpcConnection.ts`.
  - Hands on: `RpcConnection` (`call`, `onEvent`, `onRequest`, `respond`,
    `replay`, `state`).
  - Verified by: the replay/epoch/unsupported-request tests, with the
    replay-hold mutation going red.
- [x] **6. Stage 4: reconciler.**
  - `src/reconcile/*`.
  - Hands on: the channel event stream.
  - Verified by: the differential and requests tests.
- [x] **7. Stage 5: facade + package PR.** (hermes-headless#1; review A fixed in `9427867`; review b re-run on Pi)
  - `HermesHeadless`; README; package `npm run check` green.
  - Open the package PR. Do not merge until the app PR is ready, mirroring
    Pi #1140.
  - Hands on: the package sha for the gitlink.
- [ ] **8. Stage 6: app runtime.**
  - Kind and sets; registries; setup union; the remote spawn path;
    `src/main/hermes/*`; `HermesSession`; prompt delivery; conditions types;
    IPC/preload.
  - Verified by: the main/system tests; `tsc -b`.
- [ ] **9. Stage 7: chat surface + Settings.**
  - Display-mode pin; the TileTree branch; `hermes-chat/*`;
    `providers/hermes/renderer/*`; the Settings panel.
  - Verified by: the renderer tests, including the dropped-claim mutation.
- [ ] **10. Stage 8: integration.**
  - Commands, phone identity, hand-written provider lists, `ARCHITECTURE.md`,
    `upstream-versions.json`.
  - Full `npm run check` + CI.
  - Plan vs built; one `pr-review` round; open the app PR (`Fixes #1482`);
    file the Out of scope follow-ups.
  - Stop. No merge without explicit approval.

## Loop (ledger)

This plan IS the loop ledger. Every pass: re-read this file and `git log`, continue from the first unticked task, append an Execution notes line, commit, push.

- Builder: this session (Claude). It implements every task itself; coupled code is never delegated (memory: delegated implementation is risky).
- Reviewers: at each stage boundary (tasks 3-6 package, 8, 9, 10 app), two read-only reviewers through the orchestration MCP, run IN PARALLEL with the next task. Providers: Codex + Pi or OpenCode, never Claude (the builder's provider). Briefs at `temp/hermes-loop/review-<stage>/{a,b}.md` (git-ignored), reports beside them. One round per boundary; findings are triaged against the code and fixed or declined with a reason in the notes below.
- Merge authority: NONE. PRs are opened; nothing is merged without the owner.
- Stop rule: `goal_loop_complete` only when tasks 1-10 are ticked, both PRs are open with green CI, the review dispositions are recorded, and Plan vs built is filled. `blocked` only if a [gate] hypothesis is disproven or something needs the owner.

## Rulings

- Ruling (2026-10-13): Stage 0 records against the REAL `hermes serve` from `vendor/hermes-agent-src` (v0.21.7), run locally in an isolated `HERMES_HOME` with the auth gate ON (password provider), talking to a scripted OpenAI-compatible model server (`hermes-headless/testing/scripted-model/`). Why: no VPS URL was given, and the wire between Agent Code and Hermes is what we must record; a scripted model makes every turn (tools, approvals, clarify, sudo, secret, errors) deterministic and repeatable, so the same harness doubles as the live integration suite. Cost if wrong: VPS-only behaviour (TLS, reverse-proxy path prefixes, network latency) and the Nous OAuth branch (S2) stay unrecorded. They are reported as UNVERIFIED and re-recorded when the owner provides a VPS.
- Ruling (2026-10-13): "heavy integration tests" means three tiers. (1) Recorded-corpus system tests that run in CI with no Python. (2) A live tier (`npm run test:live` in the package and an app live test) that boots the real `hermes serve` plus the scripted model and drives `HermesHeadless` / `HermesSession` end to end. (3) Differential tests: a live fold compared with a resume fold of the same conversation. Tier 2 is not in CI: it needs a Python and Hermes install.
- Ruling (2026-10-13): the Hermes source is a reference checkout under `vendor/` (not `third_party/`). The owner asked for "a third party vendor"; repo CLAUDE.md reserves `third_party/` for shipped runtime artifacts with manifests, and nothing of Hermes ships in Agent Code. It is a shallow submodule at the release commit `71d34bad` (1.25 GB full history).

## Review (2026-10-13, package, one round)

Reviewer a: Codex (correctness/security), report `temp/hermes-loop/review-package/report-a.md`, verdict FIX-BEFORE-MERGE.
Reviewer b: OpenCode failed at once (provider: "Insufficient balance"); replaced by Pi.

| Finding (review A) | Verdict | Disposition |
|---|---|---|
| 1. Replay before activate leaves a gap (text + approval lost) | valid (probed on S8/S10) | fixed in hermes-headless `9427867`: `RpcConnection.acquire` holds every seq'd event across attach + ring read; test `HermesHeadless.system.test.ts` #1 |
| 2. Delta before the resume response overwritten by the snapshot | valid (probed on S9) | fixed `9427867`: running turn rebuilt from the ring's `message.start`, snapshot inflight not seeded; test #2 |
| 3. Stale snapshot `open_requests` resurrects a cancelled card | valid | fixed `9427867`: open requests only from the ring, surfaced before parked events release; test #3 (both cases) |
| 4. Accepted-but-not-started prompt window redirects | valid (S8 1.3 s, S16 6.5 s windows) | fixed `9427867`: `pendingTurns` counted from send until settle; test #4 |
| 5. Another session's `session.reclaimed` wipes cards | valid (source-derived probe; 0 in corpus) | fixed `9427867`: payload-identity fence + re-attach by stored id; test #5 |
| 6. `stop()` during a pending dial leaves a live socket/session | valid | fixed `9427867`: connect generation; test #6 |
| Suspicion: history reply after `/new` commits old rows | overstated (reviewer: inline handlers are serial on the pinned backend) | kept a cheap runtime fence; its mutation survives by design (race unreachable on v0.21.7) |
| Review B (Pi, at 2dfaeba): history reply after /new applied to the new conversation | valid (FakeSocket ordering through the public API) | fence already in `9427867`; now pinned by a test |
| Review B: facade 0% covered, 11/11 facade mutations survive | valid | facade system tests (13 now); listed facade mutations killed |
| Review B: rowKey / tool fallbacks / sealText / success:false untested | valid | tests on S4/S6 + justified literal; mutations killed |
| Review B minor: probe auth_flows/version fallback | valid, low | declined: pass-through of recorded fields; OAuth shape needs S2 (UNVERIFIED residual) |
| Review B suspicions: truncated ring, heartbeat, backendCompatibility, PKCE, untyped frames | valid as gaps | tests added (truncated: mechanical mutation of S8); `backendCompatibility(null)` was a real bug (contract 0), fixed |
| 15 surviving mutations | valid as test gaps | facade + reconciler + auth tests added; every new guard and the redirect/verifier/provider mutations now fail tests (50 core/system tests); remaining survivor: the history fence above |

## Execution notes

- **2026-10-13, plan-only:**
  - Research done: upstream read at `d97007c` / `v0.21.7`; Agent Code survey
    at `1bcba637`.
  - Issue #1482 filed.
  - No implementation.
  - Hermes is not installed on the dev machine.
  - The owner answered Decisions 1-2; the rest are defaults awaiting
    confirmation.
- **2026-10-13, tasks 1–7:**
  - **Stage 0.** The recorder ran 3 times. Run 2 fixed over-redaction of `error_surface.code`; run 3 scrubbed personal paths.
  - **Final corpus.** 16 files; scan clean.
  - **Package.** hermes-headless commits `f289420..2dfaeba` on `feat/initial-client`, PR Juliusolsson05/hermes-headless#1.
  - **`npm run check` green.** 38 core/system tests.
  - **Live tier: 7/7 pass** against a real `hermes serve`.
  - **Confirm-red observed.**
    - Removing the replay hold, or the seq duplicate guard, fails the transport tests.
    - The first cut-point test did NOT catch a removed hold, because its racing frames were gap frames. It was rewritten to race NEWER frames and now does.
  - **Deviations.**
    - Test helpers moved under `src/testing/` (rootDir).
    - The H6 oracle excludes mid-turn snapshots (S10), and S5/S6, which have no oracle.
    - New auth error kind `access-expired`, from the recorded S1/S14 semantics.
  - **Review.** Package reviewers started: Codex (a: correctness) and OpenCode (b: tests/mutation), run `review-hh-package`.
