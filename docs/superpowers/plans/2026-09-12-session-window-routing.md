# Session event routing with explicit ownership recovery

Status: implementation in progress for [#920](https://github.com/Juliusolsson05/agent-code/issues/920), B01 of [#918](https://github.com/Juliusolsson05/agent-code/issues/918), following [program plan #931](https://github.com/Juliusolsson05/agent-code/pull/931).

Baseline: `552914f5610518458f944fa1bdaf63f243685bd1`, independently based on main. PR #933 changes tmux startup and is not assumed merged. No competing routing PR was found. Source and existing tests confirm that a missing owner broadcasts session content.

## Contract

Session content may cross IPC only to an explicitly registered owner in its current renderer generation. Missing ownership must never choose every window, the focused window, or a cwd match. Global application broadcasts remain separate. Ownership claims are revisioned so a delayed release from an old kill/recovery cannot revoke a successor's claim.

Known closing-window/handoff intervals are different from never-owned traffic. Retain a bounded ordered queue for a recognized ownership lifetime; after a veto or transfer, revalidate the owner/renderer lifetime before flushing. A new claim or renderer generation invalidates old pending publication authority. Bound retained items, bytes, and age across the application as well as per session. Overflows and stale/unknown traffic create bounded metadata evidence and an explicit observation gap, never an unlimited secondary transcript buffer.

Unknown traffic retains metadata only and requests repair. Repair must await an explicit ownership claim; persisted workspace membership alone is too stale to grant routing. The eventual owner receives a gap notification and a scoped resynchronization capability. Current screen, readiness, conditions, and available committed history can be reseeded without starting a new backend. Transient semantics/PTY output that cannot be reconstructed remain explicitly incomplete. Control responses and workspace-adoption requests retain their existing explicit request/response paths and are not admitted to a lossy observation queue.

Final removal/exit ordering must survive composition with the real forwarder. A view's ownership is not proof of a live backend and should not disappear before final events can reach it. Explicit pane disposal and failed spawn admissions must release only their captured ownership lifetime. Any revised natural-exit policy must account for owner-map retention and handoff/rollback behavior rather than merely removing a cleanup call.

## Implementation sequence

1. Initialize the seven pinned package checkouts and isolated dependencies; baseline the registry, forwarder, coalescer, session IPC, and workspace handoff tests.
2. Introduce an inspectable, bounded routing owner/queue contract behind the existing registry facade. Keep application/gesture routing behavior intact. Carry window renderer-generation invalidation through actual navigation/reload lifecycle hooks.
3. Replace unknown-owner broadcast with bounded incident/repair evidence. Queue only recognized transition traffic; validate buffered ownership at flush. Add explicit gap notification and owner-scoped resynchronization, including a visible representation of unavailable transient replay.
4. Update spawn/recover/kill and final forwarder cleanup to retain their admission/release identity across awaits. Keep semantic-before-commit and final removal barriers. Distinguish routing ownership from backend execution rather than importing preload definitions into new domain code.
5. Exercise real registry + forwarder + IPC/renderer consumers with mocked Electron/process boundaries: two windows, pre-claim traffic, close/veto, successful/refused handoff, renderer reload, delayed old release, final exit during closing, new claim before deferred cleanup, queue byte/item/age exhaustion, no-owner expiry, repeated repair, stale resync results, and global broadcast parity. Do not rely only on mocks of the safeguard's own caller.
6. Run scoped tests, type checking, the test contract, seven-pin verification, and app build-output verification. Review scope and comments, open a complete linked PR, inspect CI and feedback, and synchronize #920/#918. No merge without explicit user authorization.

## Boundaries and review gates

A routing generation is not a conversation binding epoch. This slice must fence its own buffers and resynchronization requests; the program's B12 audit still carries native/run/source lifetimes through all observation producers, transport buffers, snapshots, reducers, and remote clients. Do not claim that fixing ownership routing alone completes that audit.

No UI recovery action may repeat a prompt, restart a process, or invent native completion. Resynchronization is read-only and stale replies lose publication authority. A bounded raw PTY tail is not a complete terminal checkpoint. Unknown-owner incidents retain only bounded shape/count metadata, not prompts, transcript bodies, or arbitrary paths.

If code inspection changes a contract above, update this plan and the issue before shipping. Rollback may preserve/drop with an explicit gap and repair path; it must not reintroduce broadcast as a recovery mechanism.

