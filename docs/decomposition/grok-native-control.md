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
- Inline --agents is ignored in the native TUI. Installed 1.0.25 now passes an
  isolated production-control proof for session/new, session/load, literal ACP
  prompts, live TUI echo, MCP update/readiness/invocation and session isolation.
- Production control uses direct length-framed leader IPC with protocol/PID
  verification. The native stdio helper reconnects/replays automatically and is
  therefore unsuitable as the owner of an app control lifetime.
- Both permission variants pass: ACP cancellation and a native TUI reject-once
  key. TUI resolution retires the other control client's stale request token.
  Normal cleanup awaits TUI/leader exit and verifies process absence by private
  socket path. Headless verification: 180 tests, typecheck/build/packed exports.

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

Next blocking gate: [grok-code-headless#3](https://github.com/Juliusolsson05/grok-code-headless/issues/3).
Independent public-source audits found that the native TUI uses unbounded
connect_or_spawn, can create a replacement immediately after leader loss, and
can fall back to an embedded agent after initial connection timeout. There is
no supported connect-only TUI flag in that source. A deliberate installed-binary
crash/respawn experiment has not been run; source and binary evidence remain
distinct. Normal-path coexistence does not establish crash containment.

The headless owner stops an attached TUI before terminating its leader and
retains the owned leader if dependent cleanup fails. Full app integration needs
an agreed, verified TUI lifetime boundary for unexpected loss plus safe handling
of native session-changing commands. A stable app-owned TUI socket boundary is
a candidate design to evaluate, not an implemented guarantee. MCP model-driven
discovery and native reload/reconnect reseeding also remain verification gates.

Until the protocol stage is approved and verified, keep the app and headless
input work draft. Do not claim general clipboard-independent automated prompt
delivery from screen readiness, padding heuristics or terminal-brand spoofing.
