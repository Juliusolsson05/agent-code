# Grok Native Control Bridge

Status: user approved the native ACP control-bridge design on 2026-09-10.
Continues #832 / draft #844; no merge approval. Native TUI, authentication,
tools and permission UI remain Grok-owned.

## A: What Is Proven

- Installed Grok is now 1.0.25 (f7e67d6988e2), not the earlier 1.0.13 probe.
- Recorded fullscreen frames distinguish empty focus, multiline drafts, a
  stashed draft, unfocused input, command palette and slash completion.
- Native paste is NOT an opaque text channel. An isolated-HOME loopback test
  that supplied only text observed an unexpected image and changed text echo.
  No unexpected payload was published; the temporary native session was removed.
- Public source 37949780c144e37df692e3d669051a21fec24f20 queues clipboard
  attachment probes for eligible bracketed pastes. Its SOURCE_REV is different
  from the installed binary, so source and runtime evidence stay distinct.
- GROK_CLIPBOARD_NO_NATIVE_READ selects a fallback backend, not a complete
  clipboard opt-out. GROK_CONTEXTUAL_HINTS=0 suppresses hint polling, but not
  paste-triggered attachment probes. No complete supported off switch was found.
- Ordinary single-line typing avoids that conversion in audited macOS source;
  arbitrary multiline bursts can become synthetic paste. Modified-Enter behavior
  depends on native multiline mode; tabs are structural keys, not literal text.
- Inline --agents is ignored in the native TUI. The native ACP session/new and
  session/load interfaces accept mcpServers; x.ai/session/update_mcp_servers is
  a source-backed live update interface. A private leader/control connection is
  needed to verify those capabilities against the installed CLI.

## D: Intended End State

Agent Code sends explicit text/content blocks and session-scoped MCP launch
material over an owned native control connection. It retains the real native
TUI for display and permission interaction. Automated text delivery must not
invoke desktop clipboard probing, reinterpret tabs/newlines as UI actions, or
silently edit user configuration. A session lifetime has one proven native
identity; unobserved native context changes never inherit app authority.

## Proposed Stages

### 1. Record the Native Control Contract
Produces: minimized protocol evidence for initialization, new/load, prompt,
permission routing, MCP update and shutdown using an isolated native leader.
Verified by: loopback fake inference/MCP servers, explicit session identity and
request correlation, no personal clipboard/config access or paid inference.
Why separate: public source is not the installed build and a plausible RPC
shape is not sufficient evidence to enable input or managed MCP.
Reality check: installed 1.0.25 plus the source-backed ACP interfaces above.

### 2. Own the Native Leader and Control Connection
Produces: a headless-package control/lifecycle module and bounded protocol
transport. Use private per-lifetime socket paths, not the user's global leader.
Verified by: startup failure, backpressure, cancellation, request routing,
identity mismatch, reconnect and acknowledged cleanup tests.
Why separate: an unowned daemon or misrouted request would cross pane/session
boundaries even if the visible TUI and transcript parser looked correct.
Reality check: Stage 1's actual native handshake and lifecycle recordings.

### 3. Add Typed Prompt and MCP Delivery
Produces: literal-content prompt delivery and per-session MCP admission through
the supported native protocol, with explicit retry/uncertainty semantics.
Verified by: exact multiline/tab-bearing text, two identical requests, no
unexpected image/resource blocks, MCP isolation, permission routing and reload.
Why separate: terminal readiness is observational evidence, not a guarantee
that native paste will submit only the caller's supplied content.
Reality check: the observed clipboard attachment and supported ACP interfaces.

### 4. Complete the App Provider
Produces: Grok AgentSession, explicit transcript-reset/caught-up transport,
desktop/phone reconciliation, registry/setup/commands and switching integration.
Verified by: recorded replay, real sockets/filesystem, native loopback tests,
app CI and independent architecture/code reviews.
Why separate: protocol-correct delivery can still be lost, duplicated or
misattributed by app batching, optimistic reconciliation or stale pagination.
Reality check: existing AgentSession/SessionFeed boundaries and Grok corpus.

## Isolation and Unknowns

Headless owns native transport/session identity; the parser owns portable
conversation semantics; Agent Code owns pane lifetimes and rendered history.
Do not put correctness on diagnostic events or invent native JSONL reset rows.

Still to prove: installed leader framing/handshake, whether a supported control
client can coexist with the TUI, which requests own permissions, reconnect/MCP
seed behavior, and safe handling of native session-changing commands. If an
owned-session invariant requires constraining native new/load commands inside
an app pane, make that explicit and direct users to app session actions.

Until the protocol stage is approved and verified, keep the app and headless
input work draft. Do not claim general clipboard-independent automated prompt
delivery from screen readiness, padding heuristics or terminal-brand spoofing.
