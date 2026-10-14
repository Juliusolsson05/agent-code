# Hermes remote chat — stage decomposition (spec)

Status: DRAFT 2026-10-13, awaiting owner approval. No implementation code
exists. Stage 0 has not run, so every wire shape below is still a hypothesis.
Approval mode: **hard gate.** Implementation starts only after the owner
approves this document and the plan. Stage 0 is a second gate: no stage after
it may start until its results block is published below with numbers. Stop
and ask if any hypothesis marked **[gate]** is DISPROVEN.

Plan: `docs/plans/2026-10-13-hermes-agent-pane.md`. The plan's tasks are these
stages, plus the cross-repo ordering.
Issue: #1482 (`feat(hermes): add Hermes as a remote chat agent pane`).

Templates this document deliberately copies:
- `docs/decomposition/pi-terminal.md` and PR #1140: a brand-new
  `AgentProviderKind` end to end.
- `docs/decomposition/grok-app-integration.md` and PR #844: JSON-RPC
  server→client requests becoming conditions.
- PR #408 and `src/providers/opencode/runtime/opencodeSession.ts`: a provider
  with no PTY, structured events only.
- **Owner rule (2026-09-12):** a provider package mirrors its siblings 1:1.
  The app owns every process, credential and side effect; the package's root
  class never does. App code lives in `src/providers/<kind>/runtime/` +
  `renderer/`, plus one entry per registry.

---

## Why this applies

Every staged-decomposition trigger but one fires:

- **No recorded behaviour.** A brand-new protocol and provider. Nobody has
  captured a single frame of `hermes serve` traffic for Agent Code. Hermes is
  not installed on the development machine.
- **Several sources of truth must agree on one transcript.** The create/resume
  snapshot (`messages`, `inflight`, `open_requests`), live `event`
  notifications, the post-reconnect replay ring (`session.events.since`) and
  committed SQLite rows (`row_id`, `persisted_turn`) each describe the same
  conversation, at different times and with different guarantees.
- **Crosses every boundary we have.** A new repository (`hermes-headless`), the
  network (a remote VPS), a trust boundary (OAuth/password tokens, secrets
  typed into `secret`/`sudo` prompts), and a second product's release train
  (Hermes ships about weekly and its wire changes daily on `main`).

## 1. What Hermes is (facts this design rests on)

Research date 2026-10-13. Upstream `NousResearch/hermes-agent`, MIT, about 253k
stars. Latest release **v0.21.7** (2026-10-12; tag commit `71d34bad`, on a
release branch, not an ancestor of `main`). Source was read at `main` `d97007c`
(2026-10-13).

**Status of these facts:** read in source, never executed. Stage 0 turns each
into a recorded fact or kills it. Paths are relative to the upstream root, which
the plan pins as `vendor/hermes-agent-src` at `v0.21.7`.

- **What it is.** A personal, self-improving agent: memory, skills, cron, ~40
  tools, subagents. The same agent core runs behind a CLI, a TUI, a messaging
  gateway (Telegram, Discord, Slack, ~20 platforms) and Hermes' own Electron
  desktop app. Users mostly run it on a VPS and talk to it from Telegram.
- **Three server processes, not one** (`apps/desktop/src/AGENTS.md`;
  `website/docs/user-guide/desktop.md` "Connecting to a remote backend"):
  - `hermes gateway`: the messaging gateway that hosts the Telegram adapter.
  - `hermes serve`: a headless FastAPI + WebSocket JSON-RPC backend. This is
    what Hermes Desktop talks to (local, remote URL, SSH or Cloud). Its
    `tui_gateway` package is also the backend for the Ink TUI over stdio and
    for the dashboard `/chat`.
  - `hermes dashboard`: the web SPA. It shares `cmd_dashboard` with `serve`.
- **The integration surface is `hermes serve`.** It speaks JSON-RPC 2.0, one
  object per WebSocket text frame, at `/api/ws` (`hermes_cli/web_routers/
  chat_ws.py:701-720`, `tui_gateway/ws.py`). It is peer-to-peer:
  - client → server method calls;
  - server → client `event` notifications
    `{type, session_id, payload?, seq?}`;
  - server → client **requests** (`id: "srq-…"`) for anything that blocks on a
    human: `approval`, `clarify`, `sudo`, `secret`, `vault.*`, plus Desktop GUI
    bridges.
- **The wire is declared in Python and generated for TypeScript.**
  - Pydantic models live in `tui_gateway/contracts/*.py`, with
    `extra="forbid"`: unknown param keys are rejected with error `4000`.
  - They are generated into `apps/shared/src/gateway-contract.generated.ts`
    (~6.2k lines, `RpcMethods`, `ServerRequestMap`, `BackendGatewayEventMap`)
    and `gateway-contract.openrpc.json`.
  - CI fails on a stale generated file.
  - The TS client (`apps/shared/src/json-rpc-gateway.ts`,
    `json-rpc-channel.ts`) is in `@hermes/shared`, which is **private and
    unpublished** (`apps/shared/package.json`: `"private": true`, exports `.ts`
    sources). We cannot depend on it from npm.
- **Contract churn.** Between `v0.21.7` and `main` one day later, the contract
  sources moved +520/−189 lines. All of it was in Desktop-only surfaces:
  - onboarding `setup_beat` cards;
  - `layout.apply`;
  - `session.start_chat`;
  - machine/display.

  The chat core this design depends on is **byte-identical** across that diff:
  `session.create/resume/close/interrupt/list`, `prompt.submit`, `message.*`,
  `tool.*`, `approval`/`clarify`/`sudo`/`secret`. Pin the release, parse
  tolerantly, and depend on the smallest subset.
- **Version signals.**
  - `info.desktop_contract` (currently `8`, `tui_gateway/server.py:2285`) is
    present in every create/resume result. v7 introduced server→client
    requests; a v6 backend still sends `<kind>.request` notifications.
  - `/api/health` (public) reports `version`.
  - There is no handshake version field.
- **Remote auth (the path every user takes).** A non-loopback bind turns on the
  auth gate (`hermes_cli/web_server.py:547-569`), using one of two providers:
  username/password (trusted network, Tailscale) or Nous OAuth / self-hosted
  OIDC (public internet). For native apps Hermes ships an RFC 8252 PKCE flow
  (`hermes_cli/dashboard_auth/routes.py`, `native_flow.py`):
  1. `GET /auth/native/authorize?code_challenge&code_challenge_method=S256&redirect_uri=http://127.0.0.1:<p>/…&state&provider?`
     runs in the system browser. Password providers render the `/login` form;
     OAuth runs the upstream round trip; several providers get a chooser page.
     The redirect must be a canonical loopback IP literal (`localhost` is
     rejected).
  2. The loopback redirect carries `?code&state`, and the code is single-use
     with a 120 s TTL.
  3. `POST /auth/native/token {code, code_verifier}` returns
     `{access_token, refresh_token, token_type:"Bearer", expires_at, provider, user_id}`.
  4. `POST /auth/native/refresh {refresh_token, provider}` rotates the pair.
     Refresh tokens are **reuse-detected**, so two concurrent refreshes log the
     user out. The access-token lifetime is about 15 minutes, per Hermes
     Desktop's comments.
  5. `POST /api/auth/ws-ticket` (Bearer) returns
     `{ticket, ttl_seconds: 30}`: single use, one per WebSocket dial.
  6. The WebSocket is `wss://host[/prefix]/api/ws?ticket=…`. Alternatives are
     `?token=<access token>` and the subprotocol
     `hermes-gateway-v1, hermes-gateway-ticket.<t>`. Close code `4401` means
     bad auth; `4403` means a Host/Origin/peer rejection.
  - Public probes: `GET /api/status` (includes `auth_required`) and
    `GET /api/auth/providers`.
- **Handshake** (`tui_gateway/ws.py:365-370`, `json-rpc-channel.ts:489-577`):
  1. The first frame is the `gateway.ready` event
     `{skin, change_events, heartbeat, replay_epoch}`.
  2. The client sends `client.capabilities {server_requests:true}` once per
     connection. Without it every server request for this client fails fast
     and the agent proceeds as if unanswered.
  3. Heartbeat: `gateway.ping` every 15 s with a 45 s deadline. Any inbound
     frame counts as liveness.
- **Session identity** (`tui_gateway/contracts/sessions.py`):
  - `session_id` on the wire is a **runtime** id (8 hex) that lives only for
    one backend process. `stored_session_id` is the durable SQLite key.
  - `session.create` returns both. Its doc says "a DB row appears on the first
    prompt unless seeded".
  - `session.resume {session_id: <stored id | exact title>}` returns a
    `LiveSessionSnapshot`: `messages`, `inflight`, `queued`,
    `pending_approval`, `open_requests`, `status`, `running`. It follows a
    compression lineage to its tip.
  - The `source` passed to `session.create` is stored verbatim. Any
    non-platform string (e.g. `agent-code`) counts as a self-owned session
    (`tui_gateway/session_lifecycle.py:310-330`).
- **Streaming events.** In turn order:
  - `message.start`;
  - `message.delta {text}`, `reasoning.delta`, `message.interim`;
  - `tool.generating {name}`, `tool.start {tool_id, name, args, preview}`,
    `tool.complete {tool_id, result, summary, inline_diff?, todos?}`;
  - `status.update {kind, text}`, `session.usage`;
  - finally `message.complete {text, usage, status: complete|error|interrupted, persisted_turn?{row_ids, user_row_id, final_assistant_row_id}}`.

  Deltas are coalesced server-side into batches of about 33 ms.
- **Reconnect** (`tui_gateway/event_replay.py`):
  - Per-session monotonic `seq`. The ring holds 512 events / 4 MiB per
    session, at most 64 sessions.
  - `replay_epoch` is a UUID per backend process.
  - `session.events.since {session_id, last_seen}` returns
    `{events, latest_seq, truncated, epoch, open_requests}`.
  - A session left with no client is reaped after
    `ws_orphan_reap_grace_s` (default **20 s**; `tui_gateway/server.py:139-146`)
    unless resumed first.
- **Server→client requests** (`tui_gateway/contracts/server_requests.py`):

  | Request | Params | Result | Timeout |
  |---|---|---|---|
  | `approval` | `{request_id, command, description, choices[once\|session\|always\|deny], allow_permanent?, …}` | `{choice, all?}` | 300 s (`approvals.timeout`) |
  | `clarify` | `{questions[{qid, question, choices?, multi_select}]}` | `{answers}` | 300 s |
  | `sudo` | `{command}` | `{value}`; `""` skips | 120 s |
  | `secret` | `{env_var, prompt}` | `{value}` | 300 s |

  - A timeout emits `request.cancel`. An error response counts as unanswered.
  - A window-bound bridge declined with `4404` settles once every client has
    declined.
  - **Interrupt** clears queued prompts and cancels that session's open
    requests.
- **Telegram continuity.** Telegram chats are ordinary rows (`source:"telegram"`)
  in the same profile `state.db`. A `serve` client can list and resume them,
  but:
  - `serve` treats itself as a **viewer** of gateway-owned sessions;
  - a reply produced through `serve` is not delivered to Telegram (INFERRED,
    not read);
  - the gateway's busy fence keys on its own session key, not the stored id
    (INFERRED).

  So "the same conversation as my Telegram chat" is not a supported mode
  upstream.
- **Slash commands.** `commands.catalog` and `complete.slash {text}` already
  include built-ins, user `quick_commands` and skill commands.
  `slash.exec {session_id, command}` runs one, falling back to
  `command.dispatch`. A `skill`/`send` directive is resubmitted as an ordinary
  `prompt.submit` (Desktop: `apps/desktop/src/app/session/hooks/use-prompt-actions/slash.ts`).

## 2. Measured problem

There is no Agent Code surface for a remote, conversational, non-repo agent.
Today a Hermes user leaves Agent Code to use Telegram. Agent Code's provider
architecture (#394) assumes three things Hermes breaks:

| Assumption | Where it is enforced | Hermes |
|---|---|---|
| A local CLI binary | `SessionManager.spawnWithId`: `getToolPath` → `ProviderCliNotFoundError` (`src/main/sessionManager.ts` ~3080-3100); `registry.setup.ts` is binary-only | No binary; a remote URL and a signed-in account |
| A local cwd that is a project folder | `SessionOptions.cwd` (required, `src/shared/types/session.ts`); `createDetachedDispatchAgent` aborts with "no project folder found" (`workspace/hook/actions/pane.ts` ~1139) | The cwd lives on the VPS; a Mac path means nothing there |
| A coding-feed pane | `TileTree.tsx` mounts `TileLeaf` (feed) or `AgentTerminalLeaf`; "rendered only" is hardcoded to `'opencode'` in ~7 places | A chat surface (bubbles, tool chips, inline prompt cards) |

## 3. Prior attempts and graveyard

There are no prior attempts. Considered and rejected at design time, with the
evidence (never delete):

- **G1. A Hermes messaging-gateway platform adapter** (Agent Code as "a
  Telegram"). Rejected:
  - It requires a Hermes plugin running inside the user's gateway process.
  - Platform adapters deliver text, not structured tool events or approvals.
  - Hermes' own contribution rubric forbids third-party products in its core
    tree (root `AGENTS.md`, "Rejected even when well-built").
- **G2. ACP adapter** (`acp_adapter/`, stdio). Rejected:
  - Sessions are scoped to `source="acp"`: it cannot list or resume anything
    else (`acp_adapter/session.py:216,456`).
  - It runs over stdio, so a remote VPS needs SSH process plumbing per pane.
  - No clarify/secret/sudo cards, no replay ring, no `open_requests`.
- **G3. OpenAI-compatible `api_server` platform**
  (`gateway/platforms/api_server.py`). Rejected:
  - It lives inside the messaging gateway, so it needs that process.
  - Its request types are approvals only, with no clarify/sudo/secret
    (INFERRED from its capability table).
  - No replay, and a coarser event vocabulary.
- **G4. Spawning `hermes serve` locally.** Rejected by the owner (2026-10-13):
  "all users will use hermes from their VPS instances". Kept compatible: a
  `ws://127.0.0.1:…` URL is just another connection; the package never cares
  where the server is.
- **G5. Continuing the user's actual Telegram session from the pane.**
  Rejected:
  - Upstream calls `serve` only a viewer of gateway-owned sessions
    (`session_lifecycle.py:310-330`).
  - Replies would not reach Telegram.
  - Both surfaces could write the same session at once (INFERRED: the busy
    fences key differently).

  See Decision 4.
- **G6. Depending on `@hermes/shared`.** It is private, unpublished and
  sources-only. Rejected. We implement our own client, modelled on it (MIT;
  attribution in the package README) and only as large as the subset we use.
- **G7. Copying the whole generated contract** (6.2k lines) into the package.
  Rejected: it would turn every unrelated upstream field move into a diff we
  have to review. We copy the subset we call or render (§6, Stage 1) and parse
  tolerantly. The rest is documented as ignored with a "Nobody" owner row.

## 4. A — what exists and is trusted

| Artifact | Establishes | Does NOT establish |
|---|---|---|
| Upstream source at `d97007c` / `v0.21.7` (read, not run) | Method/event/request names and Pydantic shapes; auth routes; replay mechanics | That a real VPS emits these shapes, in this order, at these frequencies; behaviour under sleep/wake, reaping, compression, model errors |
| Hermes Desktop client code (`apps/desktop/electron/*`, `apps/shared/src/*`) | A working third-party-shaped client exists: ticket-per-dial, refresh single-flight, replay hold, capability announcement | That these are sufficient for us; Desktop also uses REST paging (`/api/sessions/{id}/messages`) that we might not need |
| OpenCode structured provider (`src/providers/opencode/*`, PR #408) | How a PTY-less provider becomes `AgentSession` events (`jsonl-entry`, `semantic-event`, `conditions`, `process-state`, `input-readiness`) and `transport` prompt acceptance | Anything about remote connections or credentials |
| Grok provider (PR #844) | JSON-RPC server→client requests surfaced as conditions and answered with a stored token | Text-entry answers (sudo/secret values); Grok's permission prompts are choices only |
| User MCP secret store (`src/main/userMcp/secrets.ts`, PR #1144) | safeStorage-encrypted, prompt-free, destination-bound secrets readable at agent launch | OAuth refresh-token rotation; single-flight refresh |
| Rendering ledger (`src/renderer/src/rendering/model/ledger.ts`, `features/feed/ledger/useLedgerFeedItems.ts`) and Reader Mode (`features/reader/*`) | One owner per visible unit across committed/live/optimistic; a conversation-style projection over the same rows already exists (Reader Mode) | That Hermes' committed/live pair fits the ledger's ownership rules (Stage 4) |

## 5. D — end state (observable)

1. **Connections.** Settings → Hermes lists named connections (name, URL,
   status, signed-in identity, backend version). The user can add, sign in
   (system browser, password or Nous OAuth), test, sign out and remove. No
   token is ever visible to, or stored by, the renderer.
2. **New pane.** "New Hermes" opens a chat pane in the current tab against a
   chosen connection, even in a tab whose folder Hermes cannot see. No local
   binary or folder is needed.
3. **Live chat.** User bubbles appear on send. Assistant text streams in.
   Tools show as collapsed chips (name + one-line preview, expand for
   args/result). Reasoning is collapsed. A turn that errors says which layer
   failed (`error_surface`).
4. **Prompts from Hermes.** Approvals, questions (choices and free text), sudo
   and secret appear as inline cards in the chat and can be answered there.
   Secret and sudo inputs are masked and never persisted or logged. A card
   withdrawn by Hermes (timeout, interrupt) disappears.
5. **Stop.** Esc or `/stop` interrupts the running turn.
6. **Telegram's `/new`.** `/new` starts a fresh Hermes conversation **in the
   same pane**, as in a Telegram chat.
7. **Resilience.** Closing the laptop, losing Wi-Fi or reloading the window
   reconnects. The pane shows the same conversation with nothing duplicated
   or lost, including a turn that finished while disconnected and any prompt
   card still open.
8. **Slash commands.** Commands complete as you type (built-ins, quick
   commands, skills) and run in the pane.
9. **Header.** It shows connection name, model and state (connecting / idle /
   working / reconnecting / signed out / version skew), each with its own copy
   and a way out (e.g. "Sign in again").
10. **Shared surfaces.** Search, Reader Mode, View Prompts, Close Completed
    Agents, Goal/TLDR peeks (`provider: 'hermes'`) and the phone's provider
    identity treat a Hermes pane as an agent like any other, without
    special-casing.

## 6. Decisions

Answers recorded verbatim with dates. An item with no answer ships as its
default and is marked **UNCONFIRMED** in the plan and PR.

1. **Where Hermes runs.** Default: a remote `hermes serve` the user already
   runs on a VPS, configured in Settings. Answer (2026-10-13): "all users will
   use hermes from their VPS instances so we have connection info for that in
   settings."
2. **What the pane is.** Default: a chat window that replaces the Telegram
   chat. Answer (2026-10-13): "We just basically want to replace the telegram
   UI with a agent code ui to take up a agent window".
3. **Connection kinds in v1.** Default: remote URL + browser sign-in only (SSH
   tunnel and Hermes Cloud later), because the native PKCE flow covers both
   password and OAuth backends with one implementation, and it is the
   documented VPS path. **UNCONFIRMED.**
4. **Telegram sessions.** Default: kept separate (same agent, memory and
   skills; a new conversation per pane), because of G5. **UNCONFIRMED.**
5. **Pane identity.** Default: Telegram semantics. A pane is a *chat*. Its
   Hermes conversation is the pane's `providerSessionId` (= the
   `stored_session_id`). `/new` rotates the conversation inside the same pane
   (emitted as the existing `provider-session-changed` event). A reload
   resumes the pane's current conversation. **UNCONFIRMED.**
6. **Several connections.** Default: several named connections; the pane
   records its connection id. A single global connection would be cheaper but
   could not express "home server" and "work VPS". **UNCONFIRMED.**
7. **The pane's local folder.** Default: Hermes opens in any project tab; the
   pane's `cwd` is metadata only and is **never sent** to Hermes, which uses
   its own `terminal.cwd`. **UNCONFIRMED.**
8. **v1 scope.** Default in: D1-D10. Default out: see the plan's Out of scope
   (provider switch, rewind, attachments, voice, Agent Code MCP tools inside
   Hermes, SSH/Cloud, Telegram history, model picker UI beyond `/model`, Hermes
   Desktop extras). **UNCONFIRMED.**

## 7. Stage 0 — evidence

**Method:** record + probe. Nothing is on disk yet. A recorder is built first,
then driven against a real VPS backend.

**Prerequisite (owner):** one Hermes backend the owner allows us to record,
plus a sign-in. Two backends if possible: one password, one Nous OAuth. A local
`hermes serve` on loopback is an acceptable *supplement* for scenarios that
need a disposable backend (backend restart, reaping), and must be labelled as
such.

**Recorder:** `packages/hermes-headless/research/record-wire.mts`, mirroring
the siblings' `research/` folders.
- **What it writes:** a dumb tap that logs every frame in both directions and
  every auth/REST request/response to `research/corpus/<scenario>/<run>.jsonl`
  as `{t, dir, kind:'ws'|'http', frame}`.
- **What it must not do:** interpret anything.
- **Redaction:** at write time, same-length:
  - `access_token`, `refresh_token`, `ticket`, `token=`, `code`,
    `code_verifier`;
  - `secret`/`sudo` answer values;
  - `Authorization` and cookies.

  A post-pass reads the **whole** file (memory: q36, read the whole fixture
  before committing) and fails on any residual high-entropy string.

**Scenarios** (each produces ≥1 recording; counts go in the results block):

| ID | Scenario | Drives |
|---|---|---|
| S1 | Sign-in, password provider: probe → authorize → login form → loopback code → token → ws-ticket → WS → `gateway.ready` | auth, handshake |
| S2 | Sign-in, Nous OAuth provider | auth (provider-chooser branch) |
| S3 | New conversation: `session.create {source:'agent-code'}` → first prompt → plain text reply | create, first-row timing, the streaming sequence |
| S4 | A turn with ≥3 tool calls, one long-running, one failing | `tool.*` ordering, `tool.complete` result shapes |
| S5 | A turn that asks for approval: answer once / session / deny; plus one left to time out | the `approval` request, `request.cancel`, `approval.cancelled` |
| S6 | clarify (single choice, multi-select, free text), sudo, secret | request shapes; the masking path |
| S7 | Interrupt mid-stream, and interrupt with an open approval | `message.complete status:interrupted`, cancellation frames |
| S8 | Drop the socket mid-turn (kill the network) <20 s, reconnect, `session.events.since` | replay, seq gaps, held live frames |
| S9 | Drop the socket for >20 s mid-turn, then resume | the orphan reap: does the turn finish? what does resume return? |
| S10 | Drop with an open approval, reconnect | `open_requests` re-delivery |
| S11 | Restart the backend (local supplement) | epoch change; runtime-id invalidation |
| S12 | Resume an old conversation with ≥200 messages, including one with compression | `session.resume` snapshot size/shape, `messages_omitted`, tip following |
| S13 | Slash: `complete.slash "/"`, `"/mo"`, `slash.exec "model"`, a skill command, `/stop` | catalog shape, directives |
| S14 | Access-token expiry during an open socket; refresh; redial | whether an open socket survives expiry; refresh timing |
| S15 | Model/provider error (bad key or rate limit) | `message.complete status:error`, `error_surface` |
| S16 | A second client (Hermes Desktop) on the same session while we watch | multi-client fan-out, `session.reclaimed` |

**Hypotheses until checked** (verdict in place: HOLDS / REFINED / DISPROVEN,
with the recording path):

- **H1 [gate]**: The native PKCE flow works for a third-party app with an
  ephemeral loopback port, for both password and OAuth providers, with no
  per-app registration. *Killed by:* S1/S2 refusing our redirect or requiring
  a registered client id.
- **H2 [gate]**: A Bearer-minted ws-ticket opens `/api/ws` on a gated
  backend, and `gateway.ready` is the first frame. *Killed by:* S1 closing with
  4401/4403 or a non-ready first frame.
- **H3**: `session.create` returns a `stored_session_id` that equals the row
  later written on the first prompt, so it can be persisted as the pane's
  identity before any prompt. *Killed by:* S3 producing a different stored id
  after the first prompt, or no row for an unprompted session (then we persist
  only after `persisted_turn`).
- **H4**: Within one turn, frames arrive as `message.start` → (`message.delta`
  | `reasoning.delta` | `tool.generating` | `tool.start` | `tool.complete` |
  `status.update` | `session.usage`)* → `message.complete`, and every
  `tool.start` has exactly one `tool.complete` with the same `tool_id`, except
  under interrupt. *Killed by:* any S3/S4/S7 recording that breaks the
  bracketing.
- **H5**: The concatenated `message.delta` text equals `message.complete.text`
  for an uninterrupted turn. *Killed by:* a mismatch in S3/S4 (e.g.
  `rendered` vs `text`, or `message.interim` segments).
- **H6**: `persisted_turn.row_ids` identify exactly the rows that
  `session.resume` later returns as `messages[].row_id` for that turn, so a
  committed row can claim (own) the live turn. *Killed by:* S3 + S12 ids
  that do not join.
- **H7 [gate]**: After a <20 s drop, `session.events.since` with the last seen
  `seq` returns exactly the missing frames (no gap, no duplicate) and any
  `open_requests`. *Killed by:* S8/S10 gaps or duplicates once the replay
  hold is applied.
- **H8**: After a >20 s drop, the runtime session is reaped but the turn's
  result is persisted, and `session.resume <stored id>` shows it. *Killed
  by:* S9 losing the turn, or the turn being interrupted by the reap. Then
  the design needs a keep-alive (an always-connected connection-scoped
  socket), which is a stage change.
- **H9**: The `approval` request params carry everything the card needs
  (command, description, choices), and answering via the server request
  response (not `approval.respond`) is sufficient. *Killed by:* S5 needing
  `approval.received`/`approval.respond` for the backend to apply the choice.
- **H10**: A timed-out or interrupted request is always followed by
  `request.cancel {id}` on the session's socket. *Killed by:* S5/S7 cards that
  are never withdrawn.
- **H11**: Answering an unsupported server request with JSON-RPC error
  `-32601` makes the agent proceed immediately (no stall until timeout).
  *Killed by:* S13/any recording where an unsupported request (e.g.
  `preview.read`) stalls the turn.
- **H12**: An open WebSocket survives access-token expiry; the token is only
  needed for the next dial. *Killed by:* S14 closing the socket at expiry
  (then the refresh must run ahead of expiry while connected).
- **H13**: Telegram-sourced rows never appear in our pane's lifecycle,
  because we only resume ids we created. *Killed by:* any resume or
  `session.list` path that adopts another source's row.
- **H14**: Event and request payloads in the recordings match the pinned
  `v0.21.7` contract subset, with no unknown keys we would need. *Killed by:*
  extra keys we must render, or a missing required key (then the subset is
  widened, which is a stage 1 revision).

**Stage 0 results (2026-10-13):**

- **Method (plan Ruling 2026-10-13).** Real `hermes serve` v0.21.7 (`71d34bad`) runs from the pinned source in an isolated `HERMES_HOME`. The auth gate is ON (password provider; a loopback bind with a non-loopback `dashboard.public_url`). It talks to a scripted OpenAI-compatible model.
- **Corpus.** `hermes-headless/research/corpus/`: 15 scenario folders (S1, S3, S3b, S4–S16), about 1.5k WebSocket frames, 3.3 MB. `scan-corpus` is clean: no credential-shaped strings and no personal paths.
- **Not recorded.** S2 (Nous OAuth) needs a real Nous account. A real VPS (TLS, proxy prefix, latency) is not recorded.
- **Census (inbound events).**

  | Count | Event |
  |---|---|
  | 413 | `message.delta` |
  | 272 | `thinking.delta` |
  | 98 | `session.info` |
  | 80 | `message.start` |
  | 80 | `message.complete` |
  | 77 | `reasoning.available` |
  | 39 | `sessions.changed` |
  | 25 | `session.title` |
  | 13 | `tool.generating` |
  | 13 | `tool.start` |
  | 13 | `tool.complete` |
  | 5 | `status.update` |
  | 5 | `session.usage` |
  | 2 | `request.cancel` |

  Server requests: 6 `approval`, 2 `secret`, 1 `clarify`, 1 `sudo`.

**Verdicts:**

- **H1 HOLDS (password provider).** Native PKCE with an arbitrary loopback port, no registration (S1). OAuth branch UNVERIFIED (S2 not recorded).
- **H2 HOLDS.** A ticket opens the socket and `gateway.ready` is the first frame. A reused ticket fails the handshake (S1).
- **H3 REFINED.** `session.create` returns a stored id at once, but an unprompted session has NO row (`session.list` empty, S3b). It can be resumed only while its runtime lives. Consequence: resume answering 4007 falls back to a new conversation (`session-replaced`).
- **H4 HOLDS.** Every `tool.start` pairs with one `tool.complete` by `tool_id`, interrupts included (S4, S5, S7). `session.title` / `session.info` can FOLLOW `message.complete` in seq.
- **H5 REFINED.** A post-tool answer segment starts with `"

"`, and `message.complete.text` is the last segment only (S6, S8). `reasoning.available` repeats the final answer verbatim (S3–S5, all 77 occurrences with this model), so it must not render as reasoning.
- **H6 HOLDS** (differential test, `reconcile.system.test.ts`, S3/S4/S8/S9/S11/S12/S16). Caveats:
  - Tool rows in the resume projection have no `row_id` and no result (S4), so they are keyed by `tool_call_id`.
  - Compression rewrites row ids (S12).
- **H7 HOLDS** (S8: replay returned exactly seq 10..17, live resumed at 18). Proven for every cut point with newer frames racing the reply. Removing the hold turns the test red.
- **H8 REFINED.** A detached turn that is still PRODUCING keeps running past the reap grace (S9: 4 s grace, 12 s drop, the turn finished on the new socket). Hermes interrupts only stalled turns (no activity, e.g. waiting on an approval) and reaps idle sessions. No keep-alive socket is needed.
- **H9 HOLDS.** Approval params carry command, description, choices and pattern keys. A plain response settles a live request; a REPLAYED one is answered with `request.answer` (S5, S10).
- **H10 HOLDS.** `request.cancel` follows a timeout (S5) and an interrupt (S7).
- **H11 UNVERIFIED on the wire.** No unsupported request occurred in the corpus. The decline path is contract-probe tested.
- **H12 HOLDS.** The open socket keeps working past access-token expiry. The expired token gets ticket 401 `session_expired`, then refresh 200, then ticket 200 (S14; the basic provider clamps TTL to ≥ 60 s).
- **H13 HOLDS.** The client only ever resumes ids it created.
- **H14 HOLDS.** Every recorded frame classifies. Every event type has an owner or an ignore reason (`subset.test.ts`).

**New facts (no hypothesis predicted them):**

- **F1.** A plain `prompt.submit` to a BUSY session returns `redirected` and kills the running turn (S16). `queued: true` holds it instead (live tier: both turns end `end_turn`).
- **F2.** `thinking.delta` is spinner text ("(◔_◔) musing...").
- **F3.** A refused bearer on an API route answers 401 `{"error":"session_expired"}`, which means refresh, not sign in again (S1).
- **F4.** The basic provider's tokens are stateless: 30-day refresh, no reuse detection (S1 refreshed twice with the same RT). Single-flight refresh stays the design, because Nous OAuth DOES reuse-detect (Hermes Desktop comments).
- **F5.** Slash: built-ins go through `slash.exec`. A skill returns 4018 ("use command.dispatch"), and `command.dispatch` returns `{type:'skill', message}`. `/stop` via `slash.exec` stops only background processes (S13).
- **F6.** `/model` before the first prompt prints `(unknown)`: the agent builds lazily (live tier).
- **F7.** A second client on the same session receives the same events (S16).

## 8. Stages

### Stage 1 — wire subset + shape catalog
- **Produces:**
  - `packages/hermes-headless/src/contract/`: hand-copied TypeScript types for
    exactly the methods, events and requests in the "Owner" table below, each
    with the upstream contract path and `v0.21.7` in a header comment.
  - `research/catalog.md`: every event type, request method and payload key
    path seen in the corpus, with counts, plus which owner consumes it or
    "Nobody (ignored)".
- **Verified by:** a test that every corpus frame parses against the subset
  without errors, and every unknown event type is in the explicit ignore list.
  An unseen type is reported as an unknown (`UnknownBehavior`), not thrown.
- **Why separate:** the parser and every later stage depend on these types.
  If they are derived from the source instead of the recordings, H14 is
  untested.
- **Reality check:** Stage 0 corpus.

### Stage 2 — connection + auth client (pure HTTP)
- **Produces:** `packages/hermes-headless/src/auth/`: pure functions.
  - `probe(baseUrl)` (status + providers + health/version)
  - `buildAuthorizeUrl({baseUrl, codeChallenge, redirectUri, state, provider?})`
  - `exchangeCode`
  - `refresh`
  - `mintWsTicket`
  - `buildWsUrl`
  - Typed failure classes: `transport` (ETIMEDOUT / ECONNREFUSED / DNS),
    `auth-rejected` (401/403), `session-expired` (refresh 401),
    `unavailable` (503).

  No storage, no browser, no timers. The app owns all of those (§10).
- **Verified by:** tests that replay the recorded S1/S2/S14 HTTP exchanges
  through an injected `fetch`.
- **Why separate:** credential handling has the highest blast radius (a
  refresh race logs the user out; a leak exposes their VPS). It must be
  reviewable alone, and it has no WebSocket dependency.
- **Reality check:** S1, S2, S14.

### Stage 3 — RPC transport
- **Produces:** `packages/hermes-headless/src/transport/RpcConnection.ts`.
  - JSON-RPC over an injected WebSocket factory.
  - Request ids, per-method timeouts (approval answers 300 s), `-32601` for
    unhandled server requests.
  - Heartbeat (start only when `gateway.ready.heartbeat`).
  - `client.capabilities` on ready.
  - Per-session seq watermarks + `replay_epoch`, with the replay hold
    (park live frames during the `session.events.since` fetch; dispatch only
    `seq > watermark`; an epoch change clears the watermarks).
  - Typed connection states.
  - **No reconnect loop inside.** The owner (the app session) decides when to
    redial, because only it can mint the next ticket.
- **Verified by:** S8/S10/S11 recordings replayed through a fake socket,
  asserting exactly-once dispatch and `open_requests` re-delivery. Mutation:
  remove the replay hold and watch the duplicate test go red.
- **Why separate:** this is hard part #1. Mixing it with chat semantics is how
  duplicate or vanished messages turn into "rendering bugs".
- **Reality check:** S8, S10, S11, S16.

### Stage 4 — conversation reconciler (isolated)
- **Produces:** `packages/hermes-headless/src/reconcile/`.
  - **Input:** the create/resume `LiveSessionSnapshot` + the ordered event
    stream for ONE runtime session + server requests.
  - **Output:** the package's three channels, in the sibling vocabulary:
    - `committed.entry`: one durable message per `TranscriptMessage` row, keyed
      by `row_id`;
    - `semantic` turn/block events: `turn_started`, `text_delta`,
      `thinking_delta`, `tool_started`, `tool_completed`, `turn_completed`,
      `turn_stopped`, `api_error`, `usage_updated`, each with a numeric
      `blockIndex`;
    - `screen.activity` (idle / working / status text);

    plus a `conditions` stream of open requests (add/remove).
  - One owner per signal (table below).
- **Verified by:** golden tests on every recording (S3-S12, S15). Assert that
  the emitted channel events, replayed into a fresh fold, produce the same
  final conversation as `session.resume` on the same stored id (H6). This
  differential test is the oracle.
- **Why separate:** hard part #2. Four sources of truth (snapshot, live, replay,
  committed rows) must become one stream. Spread across the app session and
  the renderer, they fight.
- **Reality check:** S3-S12, S15.

### Stage 5 — `HermesHeadless` facade + package release
- **Produces:** `packages/hermes-headless/src/HermesHeadless.ts`, an
  `EventEmitter` mirroring its siblings.
  - **Constructor input:** a `dial: () => Promise<WebSocket-like>` (the app
    mints the ticket) and a session target:
    `{ mode:'create', source, title? } | { mode:'resume', storedSessionId }`.
  - **Channels:** `semantic`, `committed`, `screen`, plus `conditions`,
    `connection`, `session` (stored id known or changed) and `exit`.
  - **Commands:** `prompt(text)`, `interrupt()`, `newConversation()`,
    `answerRequest(id, result)`, `declineRequest(id)`, `completeSlash(text)`,
    `runSlash(command)`, `stop()`.
  - Plus `package.json`/README/LICENSE/test-contract, mirroring the
    opencode-headless and grok-code-headless layout and npm scripts.
- **Verified by:** the package's `npm run check` (core + system tests on
  recordings), plus one opt-in `test:live` against a real backend URL from env.
- **Why separate:** this is the boundary the app consumes. Everything above it
  is package-internal and can change without app edits.
- **Reality check:** the corpus; one live run.

### Stage 6 — app runtime: kind, registries, connections, session
- **Produces:**
  - `'hermes'` in `AGENT_PROVIDER_KINDS`, and every exhaustive registry entry.
  - A new **remote provider** notion: `REMOTE_PROVIDER_KINDS = ['hermes']` in
    `providerKind.ts`, mirroring `TERMINAL_ONLY_PROVIDER_KINDS`. It means "no
    local binary; `cwd` is local metadata only". Read by spawn, setup
    readiness and the cwd gate.
  - `src/main/hermes/`: the connection store, token store, native sign-in and
    token broker (§10).
  - `src/providers/hermes/runtime/hermesSession.ts`: an `AgentSession` that
    maps package channels to `jsonl-entry` / `semantic-event` / `conditions`
    / `process-state` / `input-readiness` / `provider-session-changed` /
    `exit`, and owns the reconnect loop. Plus `promptDelivery.ts`.
  - IPC + preload for the connections.
- **Verified by:** system tests driving `HermesSession` with a recorded-corpus
  fake server. `sessionManager` tests that a Hermes spawn needs no binary and
  never sends `cwd`. `tsc -b`.
- **Why separate:** this is where Agent Code's assumptions (binary, cwd) are
  relaxed. It touches shared code, so it is reviewed apart from the UI.
- **Reality check:** the corpus; `sessionManager.*.test.ts` precedents.

### Stage 7 — chat surface
- **Produces:**
  - `CHAT_SURFACE_PROVIDER_KINDS = ['hermes']`, with `agentDisplayMode` pinned
    to rendered for them (generalising the `'opencode'` pin).
  - A `TileTree` branch mounting `HermesChatLeaf`
    (`src/renderer/src/features/hermes-chat/`). It renders bubbles from the
    **same** `useLedgerFeedItems` rows the feed and Reader Mode use: ownership
    and dedupe are not reimplemented.
  - `src/providers/hermes/renderer/*`: identity, mapper, fold and ledger
    policies, condition views (cards with masked inputs), composer submit,
    slash completion source.
- **Verified by:**
  - Renderer tests that replay recordings into the runtime and assert the
    rendered bubble/chip/card sequence: one bubble per user turn, streamed
    text equals final text, no duplicate after a reconnect replay.
  - Mutation: drop the committed-claims-live policy and watch a duplicate
    appear.
- **Why separate:** presentation must not own any reconciliation. Keeping it
  last proves that.
- **Reality check:** the corpus via the existing `rendering/replay`
  recorded-session harness.

### Stage 8 — integration polish
- **Produces:**
  - Commands: "New Hermes" with a connection pick, and Settings deep links.
  - Header states.
  - The phone `providerIdentity` entry.
  - Conversation catalog: a stub source that lists only our own `agent-code`
    rows, if cheap; otherwise out of scope.
  - `support/upstream-versions.json` pin.
  - `ARCHITECTURE.md` §5.3 section.
- **Verified by:** command-catalog tests; `npm run check`; CI.
- **Why separate:** pure wiring with no new semantics.
- **Reality check:** none needed (wiring); the corpus covers behaviour.

## 9. Isolation

| Hard part | Lives in | Single consumer | Forbidden importers |
|---|---|---|---|
| Replay / seq / epoch / held frames | `hermes-headless/src/transport/` | `HermesHeadless` | anything outside the package |
| Snapshot + live + replay + committed reconciliation | `hermes-headless/src/reconcile/` | `HermesHeadless` | `transport/` (one-way: reconcile consumes transport output, never the reverse); the app |
| Credentials (tokens, refresh single-flight, tickets) | `src/main/hermes/tokenBroker.ts` (+ `tokenStore.ts`) | `HermesSession` (through an injected `dial`), the Settings IPC | the renderer, preload, the package, logs, debug bundles, recordings |
| Chat presentation | `src/renderer/src/features/hermes-chat/` | `TileTree` | `providers/*` (import boundary already enforced), main |

**One owner per signal:**

| Signal | Owner | Mechanism |
|---|---|---|
| Durable conversation rows | `reconcile/` → `committed.entry` (`row_id` keyed) | Snapshot `messages` at create/resume; then `message.complete.persisted_turn` row ids. Stage 0 decides whether it refetches via `session.history` or synthesizes rows from the turn |
| In-flight assistant text | `reconcile/` → semantic `text_delta` | `message.delta`; the snapshot's `inflight.assistant` seeds it on resume |
| Reasoning text | semantic `thinking_delta` | `reasoning.delta`, `reasoning.available` (non-stream) |
| Tool calls | semantic `tool_started` / `tool_completed` | `tool.start` / `tool.complete`, keyed by `tool_id`; `tool.generating` maps only to activity text |
| Turn lifecycle | semantic `turn_started` / `turn_completed` / `turn_stopped` / `api_error` | `message.start` / `message.complete.status` |
| Activity / status line | `screen.activity` → `process-state` | `status.update`, live `running`, connection state |
| Usage | semantic `usage_updated` | `session.usage`, `message.complete.usage` |
| Blocking prompts | `conditions` (the app maps them to `hermes.*` condition kinds) | `approval` / `clarify` / `sudo` / `secret` server requests + `request.cancel` / `approval.cancelled` + snapshot/replay `open_requests` |
| Conversation identity | `session` channel → `provider-session-changed` | create/resume `stored_session_id`; `/new`; `session.title` (title only) |
| Model / settings | `session` channel (info) | `session.info` |
| Credentials, tickets, refresh | `src/main/hermes/tokenBroker.ts` | native PKCE + refresh single-flight per connection |
| **Nobody (ignored, logged as unknown once)** | — | `skin.changed`, `pet.*`, `voice.*`, `wake.detected`, `preview.*`, `pane.reveal`, `tip.show`, `browser.*`, `display.*`, `moa.*`, `subagent.*` (v1: shown only as activity text), `background.*`/`btw.*`, `notification.*`, `free_tier.*`, `onboarding.*`, `setup.ready`, change signals (`cron.changed`, `sessions.changed`, …), `bot_relay.*`, `agent.terminal.output`, `review.summary`, `reaction`/`message.reaction`, `todo.updated` (v1). Unsupported server requests (`vault.*`, `preview.*`, `terminal.read`, `window.read`, `tour`, `theme.*`, `setup_beat`, `display.install.sudo`) are declined immediately with `-32601` (H11) |

## 10. App-side credential design (contract)

- **`HermesConnection`** (persisted, non-secret, `<userData>/hermes/connections.json`):
  `{ id, name, baseUrl (normalized), createdAt, lastVerified?: {at, version, desktopContract, identity:{userId, provider, displayName?}} }`.
- **`HermesTokenStore`**: one safeStorage-encrypted blob per connection
  (`<userData>/hermes/tokens/<connectionId>.bin`), holding
  `{accessToken, refreshToken, expiresAt, provider}`.
  - Copy the user-MCP secret-store pattern, including **destination binding**:
    the record carries the normalized `baseUrl`, and a read for a different
    URL returns "signed out". Editing a connection's URL can never send its
    token elsewhere (the #1304 lesson).
  - Prompt-free: workspace restore must reconnect without Touch ID (the same
    WHY as `userMcp/secrets.ts`).
- **`HermesTokenBroker`** (main, one per connection):
  - `getTicket()` = ensure a fresh access token, then `mintWsTicket`.
  - Refresh is **single-flight per connection**, because Hermes reuse-detects
    rotated refresh tokens.
  - A refresh `401 session_expired` moves the connection to `signed-out` and
    surfaces "Sign in again" in Settings and every pane on it.
- **`signIn(connectionId)`** (main):
  - PKCE pair + `state`.
  - An ephemeral `http.createServer` on `127.0.0.1:0`, single path, closed
    after the first valid hit or a 10-minute deadline (mirrors Hermes'
    `_PENDING_TTL_SECONDS`).
  - `shell.openExternal(authorizeUrl)`.
  - Verify `state`, exchange the code, store the tokens.
  - The loopback page says "You can close this tab".
- **The renderer only ever sees** connection metadata and states:
  `signed-out | signing-in | ready | unreachable(reason) | auth-rejected | version-skew(found, expected)`.

## 11. Unknowns

1. **H1 / H2:** do third-party native sign-in and ticketed WS work on a real
   VPS? — answered by: Stage 0 (S1, S2).
2. **H8:** what does reaping do to a running turn? This decides whether a
   connection-scoped keep-alive socket is needed — answered by: Stage 0 (S9).
3. **Is `source: 'agent-code'` acceptable upstream, or should we pass
   `desktop`?** Hermes Desktop groups its sidebar by source; our rows would
   show as an unknown source there — answered by: Stage 0 (look at what Hermes
   Desktop shows for our rows) + the owner.
4. **Sudo/secret answers.** A Hermes `secret` answer is written into the
   VPS's `.env`. Does the owner want that possible from Agent Code at all, or
   always declined in v1? — answered by: the owner (default: allowed, masked,
   never persisted).
5. **Does `prompt.submit` on a busy session queue, steer or redirect, and
   which does a Telegram-like UX want?** Default: queue (the composer's
   existing queue UI) — answered by: Stage 0 (S3 variant) + the owner.
6. **Large-history resume cost** (`messages_omitted`, `defer_history`) —
   answered by: Stage 0 (S12).
7. **Hermes Desktop on the same session at the same time** (S16) — answered
   by: Stage 0.
8. **Conversation catalog / resume picker for Hermes** — answered by: the
   owner (default: out of scope v1; the pane already resumes its own
   conversation).
9. **Version skew policy:** warn only, or refuse below a minimum
   `desktop_contract`? Default: warn at `!= 8`, refuse below 7 (pre-
   server-request wire) — answered by: Stage 0 (H14) + the owner.

## 12. Fixture and evidence plan

| Family | Real source | Label | Redaction | Consumer |
|---|---|---|---|---|
| WS frames per scenario | Stage 0 recorder against the owner's VPS | recording | same-length tokens/tickets/codes/secret values; whole-file entropy scan | transport, reconcile, HermesSession, chat renderer tests |
| Auth HTTP exchanges | Stage 0 recorder (S1, S2, S14) | recording | as above, plus cookies | auth client tests |
| Backend restart / reap | local loopback `hermes serve` | recording (local supplement, labelled) | as above | transport (epoch), reconcile (H8) |
| Mechanical variants (drop the socket at frame N) | cut points over the recordings | mechanical mutation of a recording | inherited | replay-hold tests |
| Contract subset types | upstream `tui_gateway/contracts` at `v0.21.7` | schema-derived | none | type checking only; never used as test data |

**Not permitted:**
- invented frames;
- editing a captured fixture to make a test pass;
- fixtures derived from the Pydantic models instead of the wire;
- any unredacted credential, cookie, ticket, or VPS hostname/IP (replace with
  `hermes.example`).

## 13. Outcome and deviations (filled at close)

_(empty)_
