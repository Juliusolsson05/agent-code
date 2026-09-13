# Grok Controlled Runtime and App Adoption

**Status: APPROVED for staged execution. Stage 1 is next.**

**Amended 2026-09-12 (user decision):** the Grok package and app provider mirror
Claude, Codex and OpenCode one-to-one. The original Stage 3 put a process-owning
`src/session-runtime/` coordinator inside the package; the user rejected that
("making it handle its own process is pure stupidity"). Every sibling root class
takes a consumer-spawned PTY and never spawns or kills a process
(`ClaudeCodeHeadless`, `CodexHeadless`, `OpencodeTerminalHeadless`), and every
side process a session needs is started by the app session through a package
helper whose handle the session owns (`createProxyServer` in `claudeSession.ts`,
`prepareOpencodeTerminalLaunch` in `opencodeTerminalSession.ts`). Stages 3 and 4
and the isolation rules below are rewritten to that shape; any remaining
structural divergence from the siblings is a defect, not a design option.

The user approved this written decomposition after reasserting the
recorded-evidence-first methodology. Execution in #832 / #844 now begins with
Stage 1 recording. Approval does not skip independent stage exit gates: do not
implement the combined runtime before the corpus and catalog are verified.
Unresolved or contradictory ownership semantics return to the user rather than
being silently invented in code or test expectations.

## Plain-language sequence

1. Record what real Grok actually does.
2. Catalog those recordings and agree which source owns each fact.
3. Build one isolated runtime owner against the recordings.
4. Translate its output once into the app's contracts.
5. Carry that contract through desktop and phone without reinterpreting it.
6. Finish provider registration and verify complete user journeys.

Each stage must produce its artifact and pass its independent exit gate before
the next begins. An uncovered real case reopens the contract; it is not a reason
to add another fallback in a renderer or to weaken a test.

## A — Existing artifacts and their limits

At app commit `51d37e5a`, the branch includes main `552914f5` and headless pin
`4814a17`. These are versioned starting points, not a claim about future main.

| Artifact | What it establishes | What it does not establish |
| --- | --- | --- |
| Headless `src/control/GrokAcpClient.ts`, `GrokLeaderConnection.ts`, `GrokNativeControl.ts` | Bounded owned control transport, typed native calls, uncertainty and correlated completion | One combined TUI/control/history runtime or app prompt acceptance |
| Headless `src/control/GrokTuiSocketGuard.ts` and `GrokLeaderEnvelope.ts` | Framed downstream holding, PID admission, native wire validation and cleanup ordering in the exercised cases | All startup/session-change behavior or a dead/stalled host |
| `testing/fixtures/native-acp-proof.json`, `native-tui-guard-proof.json` in headless | Metadata-only verdicts from installed Grok 1.0.25 probes | Replayable event timelines; these booleans are not a lifecycle corpus |
| Headless `testing/fixtures/recorded/` | Twenty-two privacy-normalized native history sessions and their structural variants | Original cross-channel timing, current TUI state, or app delivery acknowledgement |
| Headless `src/GrokHeadless.ts` and `src/transcript/JsonlTailer.ts` | Existing PTY/history observation and reset/caught-up machinery | A safe combined ACP runtime; legacy `sendPrompt` still uses paste |
| Parser Grok decode/project modules and app `src/main/providerSwitch/grokTranscript.ts` | Conversation conversion and strict native file-set publication | Complete provider-switch lifecycle or UI reconciliation |
| App `src/shared/types/session.ts`, `src/shared/sessionFeed/SessionFeed.ts` | Current provider and transport seams | A native same-session history reset/caught-up contract |
| App ledger adapter and phone `src/remote-client/src/transcript/store.ts` | Existing rendering helpers and explicit phone reset/exit handling | That all desktop/phone ownership decisions already have one shared reducer |

The existing suites remain useful regression coverage. Hand-built protocol
packets and controlled faults must remain labelled as such. Their pass counts
must not substitute for recorded reconciliation inputs or prove full integration.

## D — Observable end state

One Agent Code Grok session owns one assigned native conversation and its control,
guard, TUI and history observation lifetimes. A user can create/resume it, submit
a prompt, stop a turn, answer a permission and follow the same conversation on
desktop and phone. History replacement removes the superseded generation without
duplicating messages or acknowledging a new prompt from old replay.

Switch, duplicate and rewind use the app's existing replacement transactions.
Conversations discovery, setup, capabilities and built-in MCP include Grok.
Unsupported behavior is explicit. No uncertain prompt is automatically replayed,
and no unobserved native session change inherits app authority.

## Approved ownership rules — reopen if evidence exposes ambiguity

- **Conversation identity:** assigned by the owning runtime, not inferred from
  the newest file, matching text, or a terminal heading. If the native terminal
  tries to move to another conversation, fence input and require an explicit app
  session action rather than silently following it.
- **Prompt status:** transport write, provider acceptance and turn completion are
  different facts. A write receipt must not be labelled provider acceptance. An
  uncorrelated echo is insufficient, especially for identical/concurrent prompts.
- **Durable messages:** committed native history is the durable source. Live
  output is provisional until its relationship to that history is evidenced.
- **History replacement:** the physical observer owns generation/byte boundaries;
  the app's existing transcript/ledger machinery owns row reconciliation. A
  caught-up byte boundary is never provider idle or successful turn completion.
- **Permissions and drafts:** only the current native request may authorize an
  answer. Another client's resolution invalidates the old action. User drafts
  cannot be overwritten or submitted by automation; uncertainty about preserving
  them must be exposed rather than resolved by guessing.
- **Process lifetime:** only retained owned identities may be signalled. Releasing
  the guard requires acknowledged TUI exit. Native engine death and host death
  are distinct fault models; the current guard proves neither arbitrary host
  stalls nor recovery after the host itself dies.

If any rule conflicts with intended product behavior, change it with the user
before recording expected outcomes or writing the coordinator.

## Stage 1 — Capture actual multi-source runtime behavior

**Produces:** in the headless repository, explicit instrumentation at
`scripts/record-controlled-runtime.mts`, capture-only helpers under
`src/testing/controlled-runtime/`, and a versioned fixture set under
`testing/fixtures/controlled-runtime/` with `manifest.json`.

Capture ACP request/notification/response observations, TUI byte/frame events,
owned-process lifecycle events, and native history snapshot/append/replacement
observations from the same disposable run. Record observer arrival order,
per-channel sequence, relative timing, connection epoch and correlated identities.
Do not reinterpret arrival order as a total causal order inside the provider.

**Verified by:** independently checking capture completeness, per-channel
continuations, referenced identities, event counts and replayable bytes. Compare
captured outputs with the actual native files/terminal from that same run.
Refuse to certify a truncated capture. Review privacy and capture fidelity before
publishing any recording. This gate does not depend on the future coordinator.

**Why separate:** verdict booleans cannot reveal ordering, duplicate notifications,
replayed user echoes, or delayed completion. Coding the combined runtime first
would make its assumptions determine which evidence gets retained.

**Reality check:** extend the existing installed-native ACP/guard probe and retain
its actual observations. Seed history from the existing native corpus where useful.
Use non-sensitive fixture content and isolated home/cwd. Replayed inference must
be labelled controlled stimulus, not organic model behavior. If a case requires
genuine paid inference or a personal session, request that access rather than
inventing an equivalent trace.

Initial scenarios to exercise (this is a collection agenda, not an assumed catalog):
fresh/resumed session; prompt submission/completion; two identical prompts;
TUI/app concurrent input; draft preservation; permission resolved by either client;
cancellation before/after delivery; unavailable attachment; failure during load;
idle/mid-turn loss; native new/resume/rewind behavior; history replacement;
MCP update/discovery; cleanup failure and explicit retry.

Record counts by scenario, native version and observed variant. Report those as
frequencies in the captured sample, never as production usage statistics. A
scenario not safely exercisable is a coverage gap with a reason, not a fixture.

**Stage 1 status (2026-09-13): exit gate met** in grok-code-headless PR #1.
The recorder, strict verifier (evidence rules r3) and sealed verdicts are in
`src/testing/controlled-runtime/`; every one of the 49 registered scenarios has a
strictly verified private capture on installed Grok **1.0.30** (the A table's
probes were 1.0.25). The shareable fixture set is
`testing/fixtures/controlled-runtime/corpus/` with `manifest.json` (per-version
verified/refused/failed counts, coverage gaps, every lossy transformation),
guarded by an independent publication gate and passed by an independent
privacy/fidelity review. `claude-shape-verdicts.json` gives a cited verdict for
each of the 61 Claude render shapes plus recorded Grok behaviour with no Claude
shape. Recorded coverage gap: no scenario cancels before native accepts the
prompt. Stage 2 consumes the corpus and verdicts, and needs the user's
ownership decisions wherever recordings conflict.

**Stage 2 evidence (2026-09-13):** three more scenarios were recorded on 1.0.30
because the contract could not settle acceptance, Stop or terminal session
changes without them (52 scenarios; the 49 earlier timelines are byte-identical).
Native adopts a client-chosen `_meta.promptId` for the running prompt, its
completion and its result, which gives the root class an acceptance correlation
that does not depend on echoed text (unknown 1, for one prompt at a time).
`session/cancel` with a prompt queued behind a held turn cancels only the running
turn, and the queued prompt still runs. `/new` typed in the native terminal
requests `session/new` on the terminal's own connection, and the terminal then
shows the new session. Nothing is announced to the control client, the original
session keeps answering control prompts, and native keeps writing that
session's updates to the terminal connection (33 during one control prompt),
which the terminal did not draw within a 5 s sample. The screen and the wire
disagree about which conversation the terminal is on, so neither control traffic
nor the updates the terminal receives reveal the move; only the terminal's own
requests do, and the conversation-identity rule's fence must be driven from
those (unknown 3, `/new` only; `/resume`, `/fork` and `/rewind` are still
unrecorded). The coverage gap narrows to a cancel racing the first
prompt write. Before the catalog is written the user must decide whether Stop
also clears queued prompts, and how prompts typed directly in the terminal are
shown.

## Stage 2 — Catalog observations and settle the contract

**Produces:** headless `testing/fixtures/controlled-runtime/catalog.json` and
`contract.md`. Every case references exact Stage 1 capture/event ranges, sample
counts, source identities, contradictory evidence and its expected outcome.

**Verified by:** replay/read every captured case without the new runtime. Check
that every distinct observation is accounted for, including inconvenient and
rare variants. Review the proposed ownership rules against the recordings with
the user wherever observations conflict or leave product semantics undecided.

**Why separate:** a recorder says what happened; it cannot decide what should own
state. Deriving both expected outcomes and implementation from the same model
would recreate the same error one layer deeper.

**Reality check:** only Stage 1 recordings and their explicit provenance establish
observed cases. Existing hand-authored fault tests are supplemental robustness
coverage and cannot fill a missing recorded case.

## Stage 3 — Build the Grok headless package in the sibling shape

**Produces:** the headless package laid out like `opencode-terminal-headless`,
`claude-code-headless` and `codex-headless`:

- `src/GrokHeadless.ts` — the root class. It takes a consumer-spawned `pty` and
  never spawns or kills a process. Today it spawns its own PTY internally; that
  is removed, not wrapped or hidden behind a mode flag.
- `src/launch/prepareLaunch.ts` — returns the exact TUI `{ binary, args, env }`
  plus the private per-lifetime leader/guard socket paths, like
  `prepareOpencodeTerminalLaunch`. Prepared values only; nothing is started.
- `src/control/` — the native leader (`GrokNativeControl`) and TUI socket guard
  as consumer-started helpers returning a handle the app session owns, starts
  and disposes, like `createProxyServer` → `proxy.start()` in `claudeSession.ts`.
  The ordering is forced by native behavior: the TUI uses unbounded
  connect_or_spawn with no connect-only flag, so the owned leader and guard must
  exist before the app spawns the TUI or the TUI launches an unowned leader.
- `src/reconcile/` — the isolated sequencing of control, screen and history
  observations, whose single consumer is `GrokHeadless`, exactly like
  OpenCode's `reconcile/SessionSequencer.ts`. It detects; it never owns a
  process or makes app policy.
- `channels/`, `conditions/`, `terminal/`, `transcript/` as in the siblings.

There is no `src/session-runtime/` coordinator and no package class that owns a
process lifetime. Legacy `GrokHeadless` activity inference and the control
client's pending-turn bookkeeping must not become competing state machines; the
Stage 2 catalog distinguishes primitive transport facts from the root class's
public activity/acceptance events before that code is reused.

**Verified by:** tests written first from Stage 1 traces and Stage 2 outcomes.
Demonstrate failure against the absent/incorrect behavior, then implement each
observed case. Replay must produce one consistent provider-state/event stream,
with stale epochs unable to mutate it. Then rerun native scenarios through
`GrokHeadless` using the same sequence the app will use (prepare launch → start
leader and guard helpers → spawn PTY → attach), rather than the recorder's
hand-assembled resource lifetimes.

**Why separate:** identity, acceptance and replay arbitration belong inside the
package root class and its reconcile layer, as for OpenCode. Process lifetime
belongs to the app session, as for every sibling. Splitting either across IPC or
renderer callbacks creates disagreements that later look like UI bugs.

**Reality check:** the recorded multi-source corpus. Missing proof of acceptance,
session-changing behavior, binary-version agreement or startup deadlines blocks
the corresponding capability; it does not authorize a heuristic.

## Stage 4 — Adapt once to the app's existing contracts

**Produces:** app `src/providers/grok/` with the same files as the siblings:

- `runtime/grokSession.ts` — the AgentSession. It prepares the launch, starts the
  leader and guard helpers, spawns the TUI PTY with node-pty, constructs
  `GrokHeadless({ pty, launch, ... })`, forwards its events, and owns rollback and
  teardown order (the guarded-spawn rollback shape of `claudeSession.ts` and
  `codexSession.ts`).
- `runtime/promptDelivery.ts` and `runtime/skillDiscovery.ts`.
- `renderer/` starting from OpenCode's minimal set: `composerSubmit.ts`,
  `conditions/{policy.ts,views.tsx}`, `identity.ts`, `rows/dispatch.tsx`,
  `semanticFoldPolicy.ts`, `shapes.ts`, `transcript/mapper.ts`.
- `types/` for the native transcript types.

Plus only the history-boundary contract extensions in
`src/shared/types/session.ts` and `src/shared/sessionFeed/` that Stage 2 proves
are needed.

**Verified by:** recorded provider output passed through this adapter and the real
manager batching/retirement boundary, capturing the actual emitted app events.
Check prompt-result semantics, native/local identity mapping, condition tokens,
and ordering of reset relative to queued entries. Verify this before UI adoption.

**Why separate:** provider-correct events can still be lost or reordered by app
batching. The adapter translates; it must not independently overrule runtime
ownership or add a second native lifecycle/replay engine.

**Reality check:** Stage 3's contract and recordings, plus the current manager,
`src/main/sessions/forwarder.ts` and `src/main/remote/SessionFeedSource.ts` behavior.

## Stage 5 — Reconcile desktop and phone from one app observation contract

**Produces:** explicit reset/caught-up delivery through preload and both SessionFeed
implementations, Grok display interpretation, and app-owned recordings under
`testing/fixtures/grok-session-feed/` of actual post-batch/transport/store behavior.
Name the shared pure reconciliation owner in the stage contract before editing
either client; reuse/extract existing ledger/transcript logic where recordings
prove it fits. Do not assume shared types already imply shared behavior.

**Verified by:** record then replay the real application data path in integration
harnesses. Cover queued entries crossing reset, stale initial/older-history replies,
reconnect, optimistic prompt rows and committed/live overlap using those recordings.
Expected reconciliation must have one pure app owner, not separate Grok guesses
in desktop and phone. The phone currently makes reset/exit decisions locally;
record those and the desktop path before choosing the shared boundary. If making
that boundary requires a broader cross-provider rewrite, stop and decompose that
structural change before implementing it.

**Why separate:** native history recordings do not prove app delivery order, and
two UIs making their own authority decisions will diverge under the same input.

**Reality check:** Stage 4 output plus actual app processing traces. Do not insert
invented reset rows into native JSONL or promote diagnostic events into state.

## Stage 6 — Register the provider and verify complete journeys

**Produces:** exhaustive provider/setup/capability registration, Grok Conversations
discovery, built-in MCP adoption, and existing switch/duplicate/rewind transaction
integration. Current registry seams include `src/providers/registry.main.ts`,
`registry.renderer.ts`, `registry.setup.ts`, `src/main/conversations/service.ts`
and `src/mcp/shared/types.ts`.

**Verified by:** recorded/native journey evidence for create/resume, send/stop,
permissions, tools, history replacement, switching in both directions and source
retirement. Run package/app checks and independent reviews; report native,
recorded replay and synthetic fault coverage separately. Preserve current MCP
choice/reload policy and root-management non-inheritance.

**Why separate:** appearing in a picker is not a working provider. Register only
after the runtime and data-delivery contracts can stand on their own evidence.

**Reality check:** prior-stage artifacts and actual existing app transactions.
No Electron/app launch, personal account use or merge is newly authorized by
this document. If final evidence needs an interactive app run, request it then
and report the missing gate honestly until that run is performed.

## Isolation and forbidden dependencies

```text
app grokSession: prepareLaunch → start leader/guard helpers → spawn TUI PTY
               → GrokHeadless (consumer-owned PTY; reconcile/ internal)
               → existing manager/SessionFeed → app ledger/stores → display
```

- Capture helpers have one consumer: the recorder/replay harness. Production
  runtime, parser, UI and packaging entrypoints may not import them. They may
  spawn native processes because they are instrumentation; production package
  code may not.
- Process lifetimes (TUI PTY, leader, guard) are owned by
  `src/providers/grok/runtime/grokSession.ts`, exactly as Claude's session owns
  its proxy and OpenCode's session owns its PTY. `src/reconcile/` is internal to
  the package; its only consumer is `GrokHeadless`. SessionManager, control SDK,
  preload, desktop renderer and phone may not reach into control/guard internals.
- AgentSession exposes the shared app contract. Transports must preserve it;
  they may not infer native idle, acceptance or session ownership from content.
- The app's ledger/transcript machinery owns row reconciliation. Display modules
  may not repair native generations, deduplicate by matching text, or decide which
  source overrides another. Provider-runtime code may not import renderer state.
- The parser owns conversation conversion and loss reporting, not live process
  management. This work does not relocate Claude/Codex corpora or rewrite their
  provider runtimes as collateral cleanup.

## Fixture integrity and privacy

Retain a private exact capture first. Prefer controlled non-sensitive content so
native bytes/order/timing can be kept intact. Public privacy normalization must
be explicit, independently reviewed and retain consistent cross-channel identity
mapping. Never tidy ordering, suppress duplicates or synthesize missing events.
Label every transformed field and every resulting coverage limit. If redaction
changes byte offsets or terminal geometry needed by a test, do not claim that
public derivative proves original byte/layout fidelity; retain a private evidence
reference or report the gap. No secrets, personal drafts, clipboard data or raw
personal transcripts enter the repository.

## Unknowns that must remain visible

1. Authoritative acceptance correlation for repeated and concurrent prompts.
2. What an external ACP submission does to a pending native TUI draft.
3. All native actions that change the active conversation, including child views.
4. Cross-channel ordering during load, cancellation, permission resolution and
   history replacement; identical visible text cannot establish identity.
5. Startup/binary-version races, host scheduling stalls, and whether they require
   stronger guard ownership than the current in-process listener.
6. Which semantic streams can be attributed to the main turn without speculation.
7. Real model-driven MCP discovery and reseeding through reload/resume.
8. Missing native condition variants and where the current app ledger needs an
   explicit provider-neutral extension rather than a Grok-specific workaround.

**Stop rule:** if evidence contradicts the chosen owner or needs another consumer
to arbitrate, revise this decomposition and seek approval before further code.
The next authorized work after approval is Stage 1, not a combined runtime class.
