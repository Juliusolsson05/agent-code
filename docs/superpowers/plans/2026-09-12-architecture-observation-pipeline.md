# Architecture reference: terminal observation, reconciliation and feed rendering

Issue: #947 · Stacked on #940 (diagram clarity) · Source snapshot: `115e26fc`

## Problem

`ARCHITECTURE.md` describes most subsystems well, but it underexplains the part of Agent Code that makes the product possible. A reader can learn how windows, workflows and the control SDK behave, yet cannot follow a Claude or Codex answer from the native process to the painted feed.

The current reference has three concrete gaps:

1. **The premise is implicit.** Agent Code does not own a provider API client. It runs the native CLI in an emulated terminal, or OpenCode's native service. That choice keeps native commands, compaction, authentication and history intact, but it forces the application to reconstruct the conversation from observations it does not control. Provider subscription OAuth is not available to a third-party application, so the terminal is the supported client boundary. The document mentions PTYs, but it never states this constraint or its consequences.
2. **Headless packages are table rows.** Section 5.2 lists six submodules and omits `opencode-terminal-headless`. Section 5.3 gives a paragraph per provider. There is no view of each package's modules, the channels it produces, what it sanitizes before the application sees data, or where package responsibility stops.
3. **The reconciliation pipeline is compressed.** Section 8.3 summarizes the ownership ledger in seven short subsections and one illustrative diagram. The real system has four layers (package observation → main transport → renderer ingest → decide → render), a closed owner vocabulary, a closed reason enum (`selected` plus 24 rejection reasons), provider suppression policy, a five-rule ghost predicate, an ordering law, an unknown-behavior registry, identity-stability contracts, a shape recorder, per-provider shape catalogs, a coverage audit, and a replay harness with five whole-class invariants. None of these are visible as architecture.

The author's development method is part of this design. It follows A → B → C → D: build a sanitized conversation object, record every observed shape and its frequency, catalog those shapes per provider, then implement one shape at a time. That sequence explains why the directories and gates look the way they do. The reference should describe it as architecture, not anecdote.

## Goal

A maintainer should be able to:

- Explain why Agent Code emulates a terminal and which observation points exist around a native process.
- Open any headless package and know its internal layers, public entry points, emitted channels and sanitization duties.
- Say which channel is trusted for which fact, and why assistant prose never comes from the screen.
- Trace one event through main coalescing, renderer ingest reducers, `RuntimeRenderInput`, collectors, the ledger and the view bridge into a provider row.
- Name every owner, source plane, content kind and rejection reason, with the incident or fixture behind each one.
- Explain how an unknown provider shape is discovered, catalogued, fixture-backed and routed without inventing a renderer from a tool list.
- Reproduce a rendering bug as a replayable fixture and know which invariants the replay enforces.

## Non-goals

- No application behavior changes. This is a documentation change plus generated diagram previews.
- Do not duplicate `docs/rendering/rendering-system.md` line for line. The architecture reference owns the cross-process map and decisions; the rendering docs remain the detailed working guide. Link both ways.
- Do not invent rules. Every rule cites source at `115e26fc` or the pinned package revision.

## Structure of the change

### Opening, constraints and strategy

- Add a short "the core problem" passage after the opening map. It should explain terminal emulation, multiple observation channels and one sanitized conversation object, then link to the new chapter.
- Section 2: add the native-client constraint (no provider SDK/OAuth client path; native CLI or native service is the client).
- Section 4: sharpen the observation strategy row so it names the ledger and the evidence loop.

### Section 5.2 / 5.3: headless packages

- Correct the submodule table to seven packages at their pinned revisions, including `opencode-terminal-headless` and the current `codex-headless` gitlink.
- Replace the per-provider paragraphs with a package-architecture subsection:
  - a shared "observation points around a native process" diagram;
  - a responsibility boundary table (package vs application adapter vs renderer);
  - one structure diagram and module table per package: `claude-code-headless`, `codex-headless`, `opencode-headless` with `opencode-terminal-headless`, and `agent-transcript-parser`;
  - the per-channel sanitization each package performs, such as sidecar request filtering, replay settle, rollout attribution/leases, SSE part accumulation, and neutral decode.
- Keep the provider comparison table and update it where the survey shows drift.

### Section 8.2: transport

- Expand the channel table with producer, trust and coalescing policy per channel, and name the IPC channel strings.
- Keep `observation-ordering`; add the recorder tap point (outbound observer), because recordings capture exactly what crossed IPC.

### Section 8.3: conversation reconstruction (the core chapter)

Replace the current 8.3 with an exhaustive chapter:

1. **Why reconciliation exists.** Describe the three failure shapes: two owners (duplicate), suppress-before-replace (vanish), and present-but-buried (wrong order). Tie them to the pre-rewrite plane renderer.
2. **End-to-end pipeline.** Show one diagram from PTY bytes to rows, with layer boundaries and one-way imports (`session-runtime/` → `rendering/` → `features/feed/`).
3. **Channel trust hierarchy.** Show which channel may supply assistant content, user content, tool results, conditions and busy state. Include the D4 timestamp hierarchy.
4. **Ingest.** Cover the nine `SessionFeed` listeners, provider entry mappers, UUID dedupe and tool indexes, `foldSemanticEvent` with per-provider fold policy and turn replacement, `reduceStreamPhase`, and ghost mint/reconcile/orphan. `RuntimeRenderInput` is the declared contract.
5. **The sanitized object (A).** Describe `RenderCandidate`, `OwnershipDecision`, `RenderRow`, `RenderLedger` and `UnknownBehavior`, with a worked JSON example taken from the real type shape. Add a full reason table grouped by stage: collector-time, live ownership, ghost gate, lifecycle.
6. **Collectors.** Cover committed visibility (meta, synthetic Claude user rows, sidechain, task-notification join, durable kinds), semantic block candidates (compaction synthesis, empty thinking, empty `write_stdin`, duplicate history turn, blockless text), optimistic prompts, lifecycle work/empty, ghosts, and provider notices.
7. **The ledger pass.** Show a diagram of pass order and a decision flowchart for `decideLiveCandidate`, including the collapsed-running tail gate. Include the provider suppression policy table.
8. **Ghosts.** Show a lifecycle state diagram, the five-rule predicate, and the OpenCode gate.
9. **Ordering law.** Show phase rank, time, source rank and sequence, with a worked example of the #239 buried-prompt case.
10. **Identity stability (D11).** Explain the three cache tiers and why they are correctness requirements.
11. **Worked example.** Show a tick-by-tick Claude turn: prompt, proxy blocks, JSONL commit, and ghost orphaning. Include the ledger decisions at each tick.
12. **From object to pixels (D).** Show a diagram of view bridge grouping, `dropped[]` accounting, the post-correlation empty repair, and provider durable/operation/semantic dispatch with specialized, generic and absorbed outcomes.
13. **The evidence loop (B and C).** Cover the structural fingerprint (`fp2`), observer backpressure, `__render_shape` sidecar in session recordings, catalog definitions (`defineRenderShape`, dispositions, lifecycles, fixtures, `why`), coverage classification, catalog audit, and the Unknown Shape Inbox loop. Show an A→B→C→D diagram and an evidence-loop sequence.
14. **Fixtures and replay.** Show debug bundles and recordings → extract scripts with redaction gates → fixtures → `replayRecording` → five invariants and bundle triage stability. State the honest fidelity gap (reducer-faithful, not full React fold).
15. **Conditions and stream phase.** Condition precedence is structured first, then screen fallback. Stream phase is not process lifecycle; keep the existing diagram.
16. **Memory and DOM bounds.** Keep the existing content.

### Diagrams

Every diagram follows Appendix B: `accTitle` question, `accDescr` takeaway, `%% scope:` comment, labeled arrows, and the shared palette. Prefer tables for inventories such as reasons, fields and modules; use diagrams for flow, decisions and state.

Planned new or replaced diagram ids:

- `native-observation-points`
- `claude-headless-structure`
- `codex-headless-structure`
- `opencode-headless-structure`
- `transcript-parser-structure`
- `claude-proxy-stream`
- `reconstruction-pipeline` (replaces `rendering-pipeline`)
- `runtime-ingest`
- `ledger-pass`
- `live-ownership-decision`
- `ghost-lifecycle`
- `ordering-law`
- `worked-turn-ticks`
- `feed-dispatch`
- `shape-evidence-method`
- `shape-evidence-loop`
- `fixture-replay`

Survey results may add or merge diagrams, such as Codex rollout attribution or the conditions plane. Each decision will be recorded below.

## Verification

- Every new source link resolves to an existing path at this revision; package links use pinned gitlink revisions.
- `node scripts/render-architecture-diagrams.mjs … --check` reproduces all previews byte for byte.
- Visually inspect each new SVG at reading width for clipped labels and collisions.
- Markdown anchors and local links check clean.
- Cross-check every enumerated vocabulary (owners, planes, reasons, dispositions, lifecycles, invariants) against source by grep, not memory.

## Decisions log

- Combined with #940 into one PR targeting `main` at the maintainer's request (2026-09-12): both changes rewrite the same document and diagram set, so reviewing them separately only duplicated review. #940's commits are included unchanged.
- Stack on #940 rather than `main`. #940 rewrites every diagram and adds renderer metadata requirements; branching from `main` would conflict on the same sections and produce previews the new renderer rejects.
- Keep arc42 numbering. Put the core chapter in 8.3 (crosscutting, because it spans packages, main, renderer and the remote client), and link to it prominently from the opening, sections 3, 4, 5.3 and 6.4/6.5.
- Source research: six read-only surveys (one per headless package, main-process transport, renderer reconciliation), plus direct reading of every `rendering/` model, collector, adapter, evidence and replay module. Survey claims used as facts were re-verified by grep (for example the Codex 0.149.1 profile, the phone's zero committed tail, the recorded channel allowlist, accepted upstream versions).
- Honest findings are documented rather than smoothed over: four `RenderReason` values and three owners are declared but never produced; ledger decisions have no runtime reader outside replay and tests; the recording corpus holds two hand-built fixtures; named fixture tests use hand-authored inputs; the phone disables the collapsed-running rule; Codex fresh attribution depends on the attested 0.149.1 input profile; structured OpenCode has replay and reconnect gaps; the registered OpenCode fold policy contradicts its type comment.
- Final diagram set: 20 new views (8 in 5.3: `native-observation-points`, `headless-channel-model`, `claude-headless-structure`, `claude-proxy-stream`, `codex-headless-structure`, `codex-rollout-attribution`, `opencode-runtimes-structure`, `transcript-parser-structure`; 12 in 8.3: `reconstruction-pipeline`, `semantic-turn-replacement`, `runtime-ingest`, `ledger-pass`, `live-ownership-decision`, `ghost-lifecycle`, `ordering-law`, `worked-turn-ticks`, `feed-dispatch`, `shape-evidence-method`, `shape-evidence-loop`, `fixture-replay`) replacing `rendering-pipeline`. Inventories (reasons, owners, policies, dispositions, invariants, module lists) stay tables.
- Layout review at reading width changed three views: wide left-to-right parser and fixture views became top-down, and the live-ownership decision became the equivalent first-match chain. Long subgraph titles were shortened because Mermaid wraps them under nodes.
- Local re-rendering changes byte output for previews whose sources this change does not touch (Chrome/font environment). Those previews are restored from the base branch rather than churned; only new or edited diagrams are regenerated.
