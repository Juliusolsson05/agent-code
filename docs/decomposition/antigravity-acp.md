# Antigravity over ACP — decision record

Status: IMPLEMENTED on branch `feat/antigravity-provider` (not merged). Every
protocol fact below was recorded live against **agy 1.5.15** with a personal
Google AI Ultra login. Anything not recorded is listed in §10.

Where it is described elsewhere: ARCHITECTURE.md §5.3.8 (the integration as it
stands) and README.md ("Getting started" for installing `agy`).

Templates this document copies:
- `docs/decomposition/pi-terminal.md` (tone: facts first, then one decision per
  section, with the rejected options named).
- Owner rule shared with every headless package here: **the app spawns and owns
  the process; the package's session class never does.** Provider code lives in
  `src/providers/antigravity/{runtime,renderer}/` plus one entry per registry.

Code: `packages/antigravity-acp-headless/src/` (protocol, rows, catalog, MCP
proxy) and `src/providers/antigravity/` (runtime adapter, history, renderer).

---

## 1. Why Antigravity, and why not Gemini CLI

Google stopped serving personal accounts (free, Google AI Pro, Google AI Ultra)
through Gemini CLI on **2026-06-18**. Its replacement for those accounts is
Antigravity: the `agy` CLI. Adding a Gemini CLI provider now would add a harness
that signs a personal user out of the product they pay for. So there is no
Gemini CLI work in this branch, and none is planned.

- Install: `curl -fsSL https://antigravity.google/cli/install.sh | bash`. It
  puts a binary in `~/.local/bin`. Sign-in is agy's own: the user runs `agy`
  once. Agent Code never sees a credential and has no sign-in screen for it.
- Setup row: `registry.setup.ts` (`binaryName: 'agy'`) shows the install command
  and the sign-in instruction when the binary is missing.

## 2. Why ACP, and not the TUI in a PTY

Claude, Codex, Grok and Pi run in a PTY because each one leaves something a
host can observe: a JSONL file, a rollout, a socket, an extension API. agy
leaves none of those.

- **No transcript file.** agy keeps each conversation in private SQLite:
  `~/.gemini/antigravity-cli/conversations/<id>.db`, plus an index in
  `conversation_summaries.db`. The schema is undocumented. The binary is closed
  and updates itself in the background. A reader of that schema breaks on an
  update and cannot be tested against the next one.
- **No hook, socket or extension point** in the TUI that a host could use for a
  live channel.
- **Screen scraping** is rejected for the same reason as for Pi: a wrong "idle"
  is worse than an honest "unknown", and it cannot carry identity.
- **`agy acp` is agy's own supported integration surface.** It speaks the open
  Agent Client Protocol: structured text, thinking and tool streams, permission
  requests that the client answers, `session/load` to replay a conversation,
  `session/list` for the catalog, and MCP servers handed over per session.

**Decision:** Agent Code spawns `agy acp` and is its ACP client. There is no
PTY. The pane is the rendered feed only, so `antigravity` joins
`STRUCTURED_ONLY_PROVIDER_KINDS` (`providerKind.ts`). Like `TERMINAL_ONLY` for
Pi, this is a provider property resolved at read time, because a spawn path
that forgot a per-pane flag would otherwise paint an empty terminal. It is a
coding feed (tool rows, thinking, permission cards), not Hermes' chat surface.

The cost is that the user's own `agy` TUI is not the pane. The compensation is
that both share one store, so `agy --conversation <id>` opens the same
conversation in agy's TUI (§5).

## 3. Protocol facts recorded (agy 1.5.15)

Transport: JSON-RPC 2.0, one JSON object per line on stdio, both directions.
The agent also sends requests. agy logs to stderr, never stdout.

- `initialize` with `protocolVersion: 1`. agy answers version 1. We advertise
  no `fs` and no `terminal` capability, so agy uses its own file and shell
  tools under its own permission rules. Offering ours would route every read
  through Agent Code.
- agy advertises **no HTTP MCP capability** (`mcpCapabilities.http` absent). It
  does advertise image prompt capability; we do not use it yet (§9).
- `session/new {cwd, mcpServers}` returns `sessionId`, assigned by agy. It takes
  no id from the client.
- `session/load {sessionId, cwd, mcpServers}` replays the whole conversation as
  `session/update` notifications **before** its response arrives. The update
  kinds seen in a replay: `user_message_chunk`, `agent_thought_chunk`,
  `tool_call`, `agent_message_chunk`.
- `session/prompt {sessionId, prompt:[{type:'text',text}]}` answers only when
  the whole turn ends, with a `stopReason`. That can be hours, so the request
  has no timeout.
- During a **live** turn the user's prompt is not echoed. Only replays carry
  `user_message_chunk`.
- A tool's input arrives on `tool_call`, its output on a later
  `tool_call_update` with the same `toolCallId`. Output is in `rawOutput`
  (`{output}` for run_command) and/or in `content` blocks (text or diff). A
  replay carries output for few tools.
- `session/request_permission` is a request from agy with the options it
  accepts. Recorded: **Allow** and **Deny**. The turn waits until the client
  answers with `{outcome:{outcome:'selected', optionId}}`, or `cancelled`.
- `session/cancel` (a notification) stops the running turn.
- `session/list` returns conversations created in the TUI as well as over ACP,
  with a cursor. It reports the cwd of ACP-created sessions percent-encoded
  (`/Users/x/Application%20Support/...`) and plain for TUI sessions.
- `session_info_update` carries agy's generated title; `usage_update` carries
  `used` and `size`.
- `session/set_model` exists; model ids look like `gemini-4-neon-high`. A bad id
  must not make the pane unusable, so a failure is a diagnostic, not an error.

## 4. Identity and resume

agy assigns the id, so a fresh pane has no provider session id until
`session/new` answers. The runtime adapter binds identity the moment it does
and emits one `antigravity-identity` envelope before any row, so the renderer
binds the pane at once. The mapper renders nothing for that envelope.

Resume is `session/load` with the stored id. Replay arrives as history: the
session emits `history reset`, folds the updates into rows only (no live
events), then emits `history caught-up`.

If agy no longer holds the conversation (the `.db` file is gone), the adapter
does not call `session/load`. It starts a new conversation and emits
`provider-session-changed` with reason `antigravity-conversation-missing`.
A pane that opens to a notice is better than a pane that fails to start.
The existence check reads only the file name (`paths.ts`), never the file.

The transcript locator is `antigravity://session/<id>`. It is an identity, not
a path: `resolveTranscriptPath` returns null because Agent Code reads no file.

## 5. Row keying

agy streams text as chunks with no message ids. Replays use the same kinds of
chunks. So rows are cut by one rule that live turns and replays share:

- A new segment starts when the update kind changes, or when a new tool call
  appears.
- One row per segment: a user prompt, a stretch of assistant text, a stretch of
  thinking, or one tool call carrying both its input and its result.
- The key is `ag:<sessionId>:<ordinal>`, where the ordinal counts segments in
  the conversation.
- The user row of a live turn is cut by the session at prompt time, because ACP
  does not echo it. That is what keeps live ordinals equal to replay ordinals.
- A row is committed when its segment **closes**, never per chunk. The ledger
  treats committed rows as immutable by id, so a row emitted on its first chunk
  would freeze half a sentence. The live `text_delta` stream shows growing text;
  the committed row lands once the text is whole.
- A tool row commits at a terminal status (completed, failed, cancelled) or when
  the turn ends. Rows can therefore close out of ordinal order, so the session
  inserts them in ordinal order.

The ledger policy (`ledgerPolicy.ts`) is `wholeTurnByMessageId: false` and
`hideUnresolvedHistoryTools: false`: rows have no whole-turn message id, and a
tool result is its own entry threaded by call id.

## 6. Permissions

A permission request is a real decision, not an attention flag. Each
`session/request_permission` becomes an `antigravity.permission` condition
whose actions are exactly the options agy sent. The card shows them as buttons;
the answer goes back over ACP, with no keystrokes.

- `resolveCondition` answers only a request that is **still open**, with one of
  **its own** options. A stale card cannot approve anything (the OpenCode #1068
  lesson).
- One card at a time, oldest first, with a count of the queued ones.
- Esc cancels the turn and answers every open request as `cancelled`. The end
  of a turn does the same, so no request is left hanging.
- **Dangerous mode is not mapped.** agy's `session/new` has no auto-approve
  switch. Approving every request in the client would hide from the user the
  exact thing dangerous mode is meant to skip, so the Allow/Deny cards stay.
- Any other agent request (fs, terminal) gets a JSON-RPC `-32601` error. We
  advertised neither, and an explicit error beats a silent hang.

## 7. MCP

Agent Code's built-in MCP servers are per-session HTTP endpoints with a bearer
token. agy advertises no HTTP MCP capability over ACP. stdio is the one
transport every ACP agent accepts. So the endpoint reaches agy as a **stdio
server**: `mcpProxy.mjs`, run by Agent Code's own Electron in node mode
(`ELECTRON_RUN_AS_NODE=1`), which speaks Streamable HTTP to the real endpoint.
It is the same shape as the Pi bridge's MCP proxy.

- URLs and header names go in `AGENT_CODE_ACP_MCP_SERVERS` (JSON). Each header
  **value** goes in its own env var (`AGENT_CODE_MCP_<server index>_<header index>`). Both
  travel in the `env` list of `session/new`. No bearer is ever in argv.
- Nothing is written to agy's own MCP config, so a user's `agy` outside Agent
  Code is untouched.
- With no servers configured (MCP off for this agent) the proxy is a valid MCP
  server with zero tools, never a failing one.
- Tool names pass through unchanged. A duplicate name across servers keeps the
  first server's tool, because one tool call must map to one endpoint.
- The script is plain JavaScript with only Node built-ins and global `fetch`, so
  it runs outside any bundle. `scripts/copy-packaged-resources.mjs` and
  `scripts/verify-build-output.mjs` ship and check it.

## 8. History, catalog, and what the feed reads

**Live rows first.** A renderer reload, or the phone's backfill, adopts the
running `AntigravitySession` and rebuilds the feed from the provider's history
source. The rows the live session already emitted are exactly what the renderer
folded the first time, under the same keys. Serving them back makes a reload
look like nothing happened, and later live rows dedupe by key. Paging uses the
row key as the marker: everything strictly older.

**Replay fallback.** A pane that is not live (the catalog's preview, MCP
`read_agent` on a closed agent, prompt extraction) has no rows in memory. A
short-lived `agy acp` runs `session/load`, which makes no model call, and the
rows come out under the same ordinal keys a live pane would use. The process is
killed afterwards, with a 2 s wait for exit. A failure is reported as
`unreadable`, not as an empty history.

`AgentTranscriptReader` reads Antigravity only from live rows, and says so when
the conversation is not open ("open or resume the agent to read it") instead of
launching agy from a read path.

**Catalog.** `session/list` in a short-lived `agy acp`, following cursors up to
100 pages. It includes conversations made in agy's TUI, which is what makes
"open it here" work for the user's earlier agy work. Titles are agy's own. The
cwd is decoded from percent-encoding only when the result is still an absolute
path, so a real directory containing `%` survives. A missing `agy` lists
nothing: the catalog lists every provider on every open, and a user without
Antigravity must not see an error for a provider they never installed.

The catalog and the replay never read agy's SQLite files. The paths module only
answers "does the conversation file exist".

## 9. Out of scope, and why

| Not done | Reason |
| --- | --- |
| Rewind, duplicate, switch to and from other providers | Each must **write** a conversation agy will resume. The only place agy keeps one is private, undocumented SQLite owned by a self-updating binary. A command that no-ops or corrupts is worse than no command. `featureCapabilities.ts` sets them off |
| Personal skills | agy's personal skills folder is undocumented. Listing a location agy may not read would show deployed skills that never load. Project `.agents/skills` (cwd up to the git root) is discovered |
| Mapping dangerous mode to auto-approve | No switch in agy; see §6 |
| Image attachments | agy accepts images over ACP, but the composer-to-main path for images is Claude-specific today. Text first |
| agy subagents (`/agents`, `/teamwork`) | Not observable over ACP yet. `isSpawnTool` is `false` until a capture backs it |
| A native terminal view | There is no PTY. `agy --conversation <id>` in the user's own terminal is the escape hatch, and it is the verified Copy Resume Command |
| Reading agy's SQLite directly | Schema is undocumented and changes without notice. ACP is the supported read path |
| A Gemini CLI provider | See §1 |

Still on, because they only read or use ACP: catalog, prompt history extraction,
in-app resume, Copy Resume Command, built-in MCP, permission cards, usage and
title updates.

## 10. Unknowns and risks

- **One version, one account type.** All facts come from agy 1.5.15 and a
  personal Google AI Ultra login. Other plans, enterprise accounts and later
  versions are unrecorded. agy updates itself, so a protocol change can land
  without an Agent Code release. Mitigation: `initialize` refuses an unknown
  `protocolVersion`, frames that are not JSON are skipped, and unknown update
  kinds fall through to the assembler without throwing.
- **Replay fidelity.** Replays carry tool output for few tools. A replayed tool
  row can show a call with no result text. Live rows do not have this gap.
- **Project trust.** For a project agy has not trusted, agy asks in its own TUI
  first. The live test therefore needs a project agy already trusts
  (`ANTIGRAVITY_LIVE_CWD`; the default is a fresh temp directory, which agy may not trust).
- **Quota and auth errors** arrive as a failed `session/prompt`. They surface as
  an `api_error` on the turn and a `transcript-diagnostic`, and start failures
  tell the user to run `agy` once.
- **Hung agy.** `session/prompt` has no timeout by design. Esc sends
  `session/cancel`; closing the pane kills the process.

## 11. The live gate

The unit and system tests use recorded frames and a fake `agy acp`. The only
evidence against the real binary is the live test. It is **opt-in** because it
spends the user's own plan and needs the user's own agy login:

```bash
ANTIGRAVITY_LIVE=1 npx vitest run --config vitest.live.config.ts packages/antigravity-acp-headless
```

`AGY_BINARY` points at an install that is not on `PATH`. `ANTIGRAVITY_LIVE_CWD`
names a project agy already trusts. It runs two short prompts and proves, end to
end: `session/new`, streamed text, a tool turn whose permission request is
answered through `respondPermission`, rows committed with ordinal keys, and
`session/load` in a **fresh process** replaying the same rows under the same
keys. That last property is what history and reloads depend on, so run the gate
before changing `transcript/assembler.ts` and after any agy upgrade.

## 12. What is being isolated

- `acp/AcpConnection.ts` is the only code that frames JSON-RPC. It never puts
  frame text in an error, because a frame can carry a prompt, a tool result or
  an MCP credential. Every pending request settles when the stream closes. A
  frame over 64 MiB closes the connection.
- `transcript/assembler.ts` is the only code that knows ACP update shapes and
  decides segment boundaries.
- `AntigravityAcpSession.ts` composes the two and never spawns or kills.
- `paths.ts` is the only code that knows where agy keeps files.
- `mcpProxy.mjs` is the only code that runs inside agy's process tree for us.
- Agent Code imports the package root only (`antigravity-acp-headless`).
