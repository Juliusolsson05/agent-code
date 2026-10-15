# Optional `hermes` MCP domain: agents read and message the owner's Hermes (#1512)

**Size:** standard plan. The shape is known: one more built-in domain, and a main-side bridge over pieces that already exist.

**Mode:** full build. The owner said "figure that out for me", so the decisions below are defaults, marked UNCONFIRMED where they are product calls.

## Outcome

A coding agent in Agent Code (Claude, Codex, OpenCode, Grok or Pi) can, once the owner enables the `hermes` domain for it:
- list the owner's Hermes conversations;
- read one;
- send Hermes a message and get the reply back as text.

The agent never sees a credential.

## Evidence (verified, do not re-derive)

- **Domains.** Built-in domains are a closed union plus lists in `src/mcp/shared/types.ts`:
  - `BUILT_IN_MCP_DOMAINS`;
  - `CONFIGURABLE_BUILT_IN_MCP_DOMAINS`, which can be switched on in Settings;
  - `PARENT_HELD_ONLY_BUILT_IN_MCP_DOMAINS`;
  - per-provider availability.

  `usage` (`src/mcp/runtime/usageTools.ts`) is the template for a domain backed by an injected main-side dependency. The registrar is called from `createBuiltInMcpServer.ts`, and the dependency comes from `builtInMcpHost.setDependencies` in `src/main/index.ts`. Settings rows live in `src/renderer/src/features/mcp/lib/builtInServers.ts`.
- **Caller identity.** Tools receive `scope.sessionId` for the calling agent. It is authenticated by the host's per-session bearer, never supplied by the model.
- **Connections.** `HermesConnectionService` (`src/main/hermes/service.ts`) owns them:
  - `dialFor(id)` gives a fresh ticketed WebSocket per dial;
  - `restFor(id)` gives the dashboard REST client;
  - `defaultLaneKey(id)` gives the Telegram DM thread's routing key.

  Tokens never leave main.
- **Client.** `HermesHeadless` (`packages/hermes-headless`) is the whole client:
  - targets: `create` (with a `title`), `resume` (stored id) and `lane` (Telegram thread);
  - `prompt()` always submits `queued: true`, so it never redirects a running turn. In lane mode it HOLDS while the phone's turn runs;
  - `committed` emits rows and a `caught-up` boundary after each history apply. After a turn settles, it re-fetches `session.history`;
  - `request` events carry approval, clarify, sudo and secret requests.
- **Recordings.** The corpus has full WebSocket recordings with both directions in order:
  - S4: `session.create` → `prompt.submit` → a 3-tool turn → `message.complete`;
  - S10: an approval path.

  `FakeSocket` lets a test play the server.

## Decisions (defaults taken; product calls UNCONFIRMED)

1. **Domain name and gating.** The domain is `hermes`.
   - Configurable in Settings → MCP and off by default: it is not in the shipped default set.
   - Parent-held-only, because a send makes the owner's agent act on their server and accounts.
   - Not confirmation-gated like `root_management`. Its blast radius is one conversation with the owner's own agent, and every message is visible in Hermes.
2. **Where an agent's messages go (UNCONFIRMED).**
   - By default, to a conversation of its own, created on first send and titled `Agent Code · <agent title>`. The mapping from session id to stored id is kept in main and persisted (`hermes/agent-conversations.json`), so it survives reloads of the app.
   - An agent can explicitly pass `conversation: "telegram"` (the DM thread) or a stored id from `hermes_conversations`.
   - **Why:** agent traffic in the owner's Telegram thread would interleave with their phone chat, and Hermes would act on it as if the owner had written it there.
3. **Waiting for the reply.** `hermes_send` waits by default for the reply, bounded (default 5 min, max 15). It returns the assistant text plus a one-line summary per tool call.
   - On timeout it returns `still_running` with the conversation id, so the agent can call `hermes_read` later.
   - `wait: false` returns as soon as the message is accepted.
4. **Approvals (UNCONFIRMED).** If Hermes raises an approval, clarify, sudo or secret request during the turn, the call returns `awaiting_approval` with the request's own description and leaves the request pending. The tool never answers or declines it. The owner can answer it from a Hermes pane on that conversation.
5. **Telegram-thread busy.** When the phone's turn is running on the thread, the lane HOLDS the message (lane/laneBusy). The tool reports `held` and does not force it.
6. **One connection.** The default is the only signed-in connection. With several, a `connection` argument names one by name or id. With none, the tool returns a curated error ("Sign in to Hermes in Settings → Providers"), never a stack.

## Change

**`src/mcp/shared/types.ts`:**
- add `'hermes'` to the union, `BUILT_IN_MCP_DOMAINS`, `CONFIGURABLE_…` and `PARENT_HELD_ONLY_…`;
- make it available for claude, codex, opencode, grok and pi;
- `hermes: []` stays: a Hermes agent cannot reach this Mac's loopback.

**`src/mcp/runtime/hermesTools.ts`:**
- `HermesToolDependencies = { hermesAgentBridge?: HermesAgentBridge }`;
- `registerHermesTools(server, scope, deps)`, registering the three tools with zod inputs and curated `{ ok, … }` JSON results;
- `HERMES_INSTRUCTIONS`.

**`src/main/hermes/agentBridge.ts`, class `HermesAgentBridge`** (built over `HermesConnectionService`):
- `conversations(callerSessionId, { connection? })` returns `{ connection, telegram: { key, storedSessionId } | null, own: storedSessionId | null, recent: Array<{ id, title, source, lastActiveAt }> }`.
- `read(callerSessionId, { conversation?, limit? })` returns `{ conversationId, messages: Array<{ role, text }> }`.
- `send(callerSessionId, callerTitle, { text, conversation?, wait?, timeoutSeconds? })` returns one of `{ status: 'replied', reply, tools }`, `'accepted'`, `'still_running'`, `'awaiting_approval'` or `'held'`, each with its `conversationId`.

  Each call opens one `HermesHeadless`, does its work, and `stop()`s in `finally`. Nothing stays connected between calls. Sends are serialized per conversation.

**Wiring and Settings:**
- `src/main/index.ts`: construct the bridge and pass `hermesAgentBridge` to `setDependencies`. The caller's pane title comes from the session registry.
- `builtInServers.ts`: a Settings → MCP row.

## Tests (recorded data; each fails before the change)

1. **Bridge send** on recorded S4 (a `FakeSocket` replay server that answers each client call with the recording's next result for that method, and pushes the recorded events after it): `status: 'replied'`, and the reply equals the recorded `message.complete` text. Tool summaries name the three recorded tools.
2. **Bridge send** on recorded S10 (approval): `awaiting_approval`, carrying the recorded request's command.
3. **Own conversation:** the first send `session.create`s with the agent title; a second send `session.resume`s the same stored id; and the mapping survives a new bridge instance (read back from disk).
4. **Tools:** with the domain off, no `hermes_*` tool is listed; with it on, three are. No bridge means a curated error. Results never contain `token`, `ticket` or `Authorization`.
5. **Domain policy:** `hermes` is configurable, parent-held-only and absent from the shipped defaults.

## Verification boundary

The app is not launched (standing rule). The real VPS is not called. The live Hermes path is covered by the replayed recordings plus hermes-headless's own live matrix. The first real use is the owner's.

## Out of scope

- Hermes calling Agent Code's tools (#1490).
- Answering approvals from MCP.
- Streaming partial replies to the agent.

## Review round (one round, two reviewers)

### Fixed
- **Concurrent first sends (A1, reproduced).** Map writes go through one queue, each with a unique temp file. The map loads once (A6). Its shape is validated, and a corrupt file is kept as `.corrupt-<ts>` (A5).
- **Identity across reloads (A2).** The map is keyed by the scope's `tldrIdentity`, which survives reload and provider switch, not the session id.
- **Secrets in summaries (A3).** Tool lines and approval text pass through `redactSecrets`: bearer tokens, key/token/secret/password assignments, `sk-`, `ghp_`/`github_pat_`, `xox*` and `AKIA` keys.
- **Attribution (A4, UNCONFIRMED).** Every message is prefixed `[Sent by an Agent Code agent: <title>]`.
- **No junk conversations (A7 / B4).** Before resuming, `latest-descendant` is checked over REST. An unknown id is refused before any socket opens, so no conversation is created. A deleted "own" conversation is forgotten and replaced. The lookup also follows compression to the tip.
- **Telegram lookup side effect (A8).** `service.lookupLaneKey` is a lookup without side effects.
- **Reply binding (B1).** `rowsForOurMessage` finds our user row by id, or by text after the mark when the submit was queued (S20). The answer is bounded at the next user row. Our turn is the first stop after an accepted submit, or the second after a queued one.
- **Timeouts (B2).** The default wait is 25 s, capped at 50 s, because MCP clients time out at 60 s. A second send waits at most 10 s for the first, then reports `busy`.
- **Turns that end without an answer (B3).** They return `ended` with the reason (interrupted or error) instead of waiting out the timeout.
- **Smaller send fixes (B5).**
  - A replayed open request also reports `awaiting_approval`.
  - A dropped socket reports `uncertain`: delivered, read later.
  - The `held` wording now covers "busy or could not be checked".
  - A held message is taken back (`cancelHeld`) before returning.
- **Tests (B6).**
  - S20-derived reply binding;
  - concurrent first sends;
  - a corrupt map;
  - a deleted own conversation;
  - an unknown id with no dial;
  - redaction;
  - attribution.

  Every guard was mutation-checked: 6/6 caught.

### Not covered by a replay test
- **Lane hold (T4).** It needs the REST lane fake.
- **`ended` on a recorded interrupt (S7).** S7's interrupt comes from the client.

Both paths are covered by code reading and by the pure binding tests.
