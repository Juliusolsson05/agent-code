# Bulk Provider Switch — Design

**Date:** 2026-06-24
**Branch:** `feat/bulk-provider-switch`
**Status:** Approved design, ready for implementation plan

## Problem / Motivation

You run many agents in parallel across both providers (Claude and Codex). When you
hit a **usage limit on one provider**, every agent on that provider is stuck. Today
the only escape is to switch each agent's provider **one at a time** via the existing
single-agent "Switch Provider" command (`switchFocusedProvider`). With 20 agents on
the throttled provider, that's 20 manual focus-and-switch operations under time
pressure — exactly when you least want friction.

What's needed is a **batch operation**: take a whole batch of agents and move them to
the other provider in one action. And because limits reset, you want a cheap way to
move **that same batch back** later without manually re-selecting all of them — so the
app must **remember the most recent batch it switched**.

This is a true round-trip on a *batch*: switch a set out when a limit hits, bring the
same set back when the limit clears. The "bring back" is **optional** — you might never
do it, or do it days later — so the remembered batch is a *standing, durable record*,
not a transient undo that auto-expires.

## What already exists (and why this is mostly a composition, not new machinery)

This feature is largely a **bulk wrapper + a memory record** over machinery that is
already built and shipping. The research that informed this design:

### Single-agent provider switch — already implemented
- `switchFocusedProvider` in `src/renderer/src/workspace/hook/actions/provider.ts`
  orchestrates a single switch today: it calls `window.api.switchProvider(...)`,
  then `sessionActions.replaceSession(...)` to spawn the new provider in the same
  tile slot and kill the old process, then shows a pane toast.
- `window.api.switchProvider({ sourceKind, sourceProviderSessionId, cwd, ... })`
  (`src/preload/api/provider.ts` → `src/main/providerSwitch/switchProvider.ts`)
  **translates** the agent's transcript into the target provider's format, writes a
  **new** transcript file with a **new** provider session id, and returns
  `{ targetKind, targetProviderSessionId, targetFilePath }`.
- **The source transcript is never modified or deleted.** Switch is non-destructive
  to the origin file; it always creates a fresh target file.
- `replaceSession(cwd, { kind, resumeSessionId, ... })` in
  `hook/actions/session.ts` spawns the target session in the same tile-tree slot and
  kills the old one. **This mints a new cc-shell `SessionId`** — the workspace-level
  id changes on every switch. (Important for how we track a batch; see below.)

### The "Close Old Agents" modal — our UI template
- `src/renderer/src/features/workspace/ui/CloseOldAgentsModal.tsx` is the structural
  template: a command-palette-opened modal with a **scope toggle** (All projects /
  Selected projects), a **live preview** of exactly which agents are affected, a
  per-project checklist, and a confirm button whose label tracks the count. On confirm
  it loops **sequentially** over matching agents (`for ... await workspace.closeSession`)
  — sequential is intentional because each operation mutates load-bearing shared state
  (tile tree, runtime maps, undo stack) and concurrent mutation would read stale
  snapshots. We mirror this exactly.
- It is opened via a `uiShell` store flag (`closeOldAgentsOpen` + `openCloseOldAgents` /
  `closeCloseOldAgents`) and mounted in `App.tsx`. The command lives in
  `src/renderer/src/features/workspace/commands/sessionCommands.ts`.
- It enumerates agents into rows (kind, cwd, tab, live/idle status, age) and excludes
  terminals. We need almost the same enumeration (kind, cwd, tab, live status) minus
  the age math, plus a source-provider filter.

### Undo / remembered-operation idioms — prior art for the batch record
- **Undo Close** (`hook/actions/undoClose.ts`, `lib/undoClose.ts`): a LIFO ref stack,
  capped at 10 entries / 1-hour retention, triggered by ⌘⇧T. Multi-level history.
- **Rewind Undo** (`PendingRewindUndo` on `SessionRuntime`): a **single-shot** record
  that **auto-clears** on the next submit. Single level, transient.
- Our batch record is closest to Rewind Undo (single level — "the most recent batch")
  but **must not auto-clear** (it persists until the user returns the batch or it's
  superseded by a newer switch). It also lives at the **workspace level**, not on a
  single `SessionRuntime`, because a batch spans many agents.

## Design

### Surface: one modal, opened from the command palette

A single modal — **"Switch Agents to Another Provider"** — is the entire surface.
Opened from the command palette (one entry). **No keybind** (deliberately — this is not
a high-frequency operation). The modal hosts *both* halves of the round-trip:

1. The **forward switch** (pick direction + scope, preview, confirm).
2. The **return** of the last remembered batch (a banner at the top with its own button).

ASCII of the approved layout:

```
╔════════════════════════════════════════════════════════════════════════════╗
║  Switch Agents to Another Provider                                       ✕  ║
║  Move a batch of agents between providers when you hit a usage limit.       ║
║  History is translated; the originals stay on disk so you can return.       ║
║                                                                            ║
║  ┌──────────────────────────────────────────────────────────────────────┐  ║
║  │  ↩  Last batch — 20 agents · Codex → Claude · 1h ago     [ Return 20 ]│  ║
║  └──────────────────────────────────────────────────────────────────────┘  ║
║                                                                            ║
║  Switch   [ Codex  →  Claude  ▾ ]              Scope   ( ● ) All projects   ║
║                                                        (   ) Selected       ║
║                                                                            ║
║ ┌─────────────────────────┬──────────────────────────────────────────────┐ ║
║ │ PROJECTS                 │  WILL SWITCH · 17 agents                      │ ║
║ │ ⌕ ____________________   │  ⬡ codex   pharos-ai     Tab 2   idle   3m   │ ║
║ │ ☑ pharos-ai      6 / 6   │  ⬡ codex   open-seo      Tab 4   ● working   │ ║
║ │ ☑ open-seo       5 / 5   │  ⬡ codex   agent-code    Tab 1   idle  22m   │ ║
║ │ ☑ agent-code     4 / 6   │  … 14 more                                   │ ║
║ │ ☐ misc           0 / 3   │                                              │ ║
║ │ [ All ]   [ Clear ]      │  ⚠ 3 of 17 are mid-turn and will be          │ ║
║ │                          │    interrupted when they respawn.            │ ║
║ └─────────────────────────┴──────────────────────────────────────────────┘ ║
║                                            [ Cancel ]    [ Switch 17  ▸ ]   ║
╚════════════════════════════════════════════════════════════════════════════╝
```

### Controls

- **`Switch [ Codex → Claude ▾ ]`** — direction selector. It sets both the **source**
  (which agents are eligible: only agents of the source kind) and the **target** (where
  they go). Flipping it re-filters the preview to the other provider's agents. Two
  states only: `codex→claude` and `claude→codex`.
- **`Scope` — All projects / Selected projects** — identical semantics to Close Old
  Agents. In *All* mode every source-kind agent is eligible. In *Selected* mode the left
  PROJECTS column becomes a checklist (`matching / total` per project), and only checked
  projects' agents are eligible. The PROJECTS column is only interactive in Selected mode.
- **Preview (`WILL SWITCH · N agents`)** — the live list of exactly which agents will
  move, each showing kind glyph, project basename, tab, and live/idle status. Excludes
  terminals (only `claude`/`codex` agents are switchable).
- **⚠ mid-turn line** — "**M of N are mid-turn and will be interrupted when they
  respawn.**" This is the chosen handling for actively-working agents (decision below):
  we **switch everything**, but we **surface** how many in-flight turns get interrupted.
  No skip toggle.
- **Footer `[ Switch N ▸ ]`** — confirm; label tracks the count; disabled when N = 0 or
  a switch is in progress (shows "Switching…").

### The "Return last batch" banner

- Rendered at the **top of the modal**, and **only when a remembered batch exists**.
- Shows: agent count, the direction that was applied, and a relative timestamp
  ("1h ago"), plus a **`[ Return N ]`** button.
- Clicking `Return N` switches **that exact batch** back to each agent's original
  provider, then clears the banner.
- This is the *only* return affordance — no command-palette entry, no keybind, no toast
  action button. The modal is the single home for the round-trip.

### Decision: handling of mid-turn (actively working) agents — **show, don't skip**

When the bulk switch fires, some agents may be mid-turn (running/streaming). Switching
kills and respawns the process, interrupting the in-flight turn. We **switch all of
them regardless** and **display the count** that will be interrupted in the preview's
⚠ line — no opt-in/skip checkbox.

**Why:** the entire trigger for this feature is "I just hit a usage limit." A
half-switch that strands a few agents on the throttled provider defeats the purpose,
and under a rate limit the in-flight turns are likely failing anyway. But the user
should still *see* what they're interrupting, so we surface the count rather than hide
it behind a default-off toggle (which is what Close Old Agents does, because there the
default intent is the opposite — preserve running work).

### Decision: what "Return" does to interim work — **re-translate, don't snapshot-restore**

A subtle but important choice. After a forward switch (say Codex→Claude), the agent runs
on Claude and may accumulate **new turns**. When the user later returns the batch to
Codex, there are two possible semantics:

1. **Snapshot restore (lossless re-point):** re-point each agent to its *original,
   untouched* pre-switch Codex transcript. Cheap and lossless *for the original
   history*, but **discards any work done on Claude after the switch.**
2. **Re-translate (chosen):** translate the agent's *current* Claude transcript back to
   Codex — i.e. run the same `switchProvider` machinery in reverse on the live session.
   Preserves interim work; costs a second (lossy) translation pass.

We choose **(2) re-translate.** The motivating workflow is "switch to the other provider
**to keep working**, then come back" — interim turns are real work the user does not want
to lose. Re-translation also means **Return is just the forward switch pointed the other
way**, reusing 100% of the existing single-agent switch code path. The only thing Return
adds over a manual reverse switch is that it **remembers the batch membership and target
for you**.

> Note: this refines an earlier verbal description ("re-point to the original transcript,
> lossless"). On reflection, lossless re-point would silently drop post-switch work, which
> contradicts the "switch to keep working" intent. Re-translation is the correct default.
> Round-tripping through translation twice is slightly lossier on transcript *metadata*
> (one-shot events like rollbacks/aborts are already dropped by the translator), but it
> never loses **conversational turns**, which is what matters.

### What counts as "the batch"

The batch is **exactly the set of agents switched in one confirm of the modal** —
captured as a list after the switches complete. New agents spawned afterward are **not**
part of it and are never dragged back by Return. If a user manually switches one of the
batch's agents back (or closes it) before hitting Return, that agent is detected as no
longer matching the batch's expected post-switch provider and is **skipped** on return
(reported in the summary).

### One level of memory, durable

Only **one** batch is remembered — "the most recent." A new forward switch **replaces**
the remembered batch (the previous record is discarded; you can't return a batch from two
switches ago). This matches the user's "most recent" framing and avoids a history-stack
UI.

The record is **durable**: it is stored in workspace state and **persisted to
`workspace.json`**, so it survives app restarts ("bring them back tomorrow"). This is
*not* the auto-clearing transient behavior of Rewind Undo. The record is cleared only
when (a) the user returns the batch, or (b) a new forward switch supersedes it.

## Data model

A new workspace-level record (not per-`SessionRuntime`, because a batch spans agents):

```ts
// One agent's membership in a switched batch.
type ProviderSwitchBatchAgent = {
  // The cc-shell SessionId the agent has AFTER the forward switch. replaceSession mints
  // a new SessionId on every switch, so this is captured post-switch. Return acts on this id.
  sessionId: SessionId
  cwd: string
  // Where the agent came from — the Return target.
  originalKind: AgentProviderKind          // 'claude' | 'codex'
  // Where the agent is now (the forward switch's target). Guard: Return only acts on
  // agents whose current kind still equals this, so manually-reverted/closed agents are skipped.
  switchedToKind: AgentProviderKind
  title?: string                            // for the summary/labels only
}

// The single remembered batch.
type ProviderSwitchBatch = {
  id: string
  switchedAt: number                        // epoch ms, for the "1h ago" label
  sourceKind: AgentProviderKind             // batch-level direction (for the banner text)
  targetKind: AgentProviderKind
  agents: ProviderSwitchBatchAgent[]
}
```

Stored as `WorkspaceState.lastProviderSwitchBatch: ProviderSwitchBatch | null`
(alongside existing global fields like `dispatchMode`), and added to
`PersistedWorkspace` so it round-trips through `persistence.ts`. The persisted ids are
the same `SessionId`s that are already keys in the persisted `sessions` map, so the
record stays consistent with the rest of the persisted workspace.

## Architecture / components

1. **Extract a reusable single-agent switch helper.** Today `switchFocusedProvider`
   (provider.ts) inlines: read meta → `window.api.switchProvider` → `replaceSession` →
   toast. Extract the core into `switchOneAgent(sessionId, targetKind): Promise<{ newSessionId } | null>`
   so both the existing focused command and the new bulk action share one
   implementation (reduces duplication; the existing command becomes a thin caller).
   This is a targeted refactor of code we're already touching, not unrelated cleanup.

2. **New action hook `hook/actions/bulkProviderSwitch.ts`** exposing:
   - `switchAgentsToProvider(sessionIds: SessionId[], targetKind): Promise<void>` —
     loops **sequentially** over the ids calling `switchOneAgent`, collects the new
     session ids, writes `lastProviderSwitchBatch`, and shows a global toast
     ("Switched N agents to Claude"). Mirrors Close Old Agents' sequential loop and its
     rationale (load-bearing shared-state mutation per switch).
   - `returnLastProviderSwitchBatch(): Promise<void>` — reads
     `lastProviderSwitchBatch`, for each member still matching `switchedToKind` calls
     `switchOneAgent(sessionId, originalKind)`, clears the record, and toasts a summary
     ("Returned M of N agents to Codex"; if some were skipped, say so).
   - Wired into `useWorkspace()` in `hook/index.ts` and exposed on the workspace object,
     following the existing action-hook pattern.

3. **New modal `features/workspace/ui/BulkProviderSwitchModal.tsx`** — structurally
   modeled on `CloseOldAgentsModal.tsx`. Reuses the agent-enumeration shape (kind, cwd,
   tab, live status). To avoid duplicating the enumeration across the two modals, factor
   the shared row-building into a small helper (e.g. `collectSwitchableAgentRows`) used by
   this modal; the close modal can adopt it later but we will not refactor it in this PR
   unless trivial. The modal owns local UI state (direction, scope, selected projects,
   `switching` flag) and calls the workspace actions on confirm / return.

4. **`uiShell` store flag** — add `bulkProviderSwitchOpen` + `openBulkProviderSwitch` /
   `closeBulkProviderSwitch`, mirroring `closeOldAgentsOpen`. Mount the modal in
   `App.tsx` with `open` / `onClose` / `workspace` props.

5. **Command palette entry** — add `switch-agents-provider` ("Switch Agents to Another
   Provider…") in `sessionCommands.ts`, `run: ({ ui }) => { ui.openBulkProviderSwitch();
   ui.closePalette() }`. This is the only entry point.

## Data flow

**Forward switch:**
```
Command palette → ui.openBulkProviderSwitch() → modal opens
  → user picks direction + scope → preview lists eligible source-kind agents
  → [ Switch N ] → workspace.switchAgentsToProvider(ids, targetKind)
      for each id (sequential):
        switchOneAgent(id, targetKind)
          → window.api.switchProvider(...)            (translate transcript, new file+id)
          → replaceSession(...)                       (spawn target, kill old, new SessionId)
      → setState: lastProviderSwitchBatch = { agents: [...new ids...], sourceKind, targetKind, switchedAt }
      → global toast "Switched N agents to Claude"
  → modal closes
```

**Return:**
```
Open modal → banner shows lastProviderSwitchBatch
  → [ Return N ] → workspace.returnLastProviderSwitchBatch()
      for each member where currentKind === switchedToKind (sequential):
        switchOneAgent(member.sessionId, member.originalKind)
      → setState: lastProviderSwitchBatch = null
      → toast "Returned M of N agents to Codex" (note skipped, if any)
  → banner disappears
```

## Error handling & edge cases

- **A switch in the batch fails mid-loop.** Sequential execution means earlier agents
  already switched; we continue the loop, count failures, and the recorded batch
  contains only the successfully-switched agents. Toast reports "Switched K of N
  (P failed)". Same pattern for Return.
- **Agent closed between switch and return.** Its `sessionId` no longer resolves to a
  live session → skip, count as skipped in the Return summary.
- **Agent manually reverted between switch and return.** Its current kind !=
  `switchedToKind` → skip (we don't re-switch an agent the user already moved).
- **New forward switch while a batch is remembered.** Replaces the record outright (one
  level of memory). The previously-remembered batch is forgotten.
- **Empty eligible set.** `[ Switch N ]` disabled at N=0; preview shows an empty state
  ("No Codex agents to switch").
- **Mid-turn agents.** Switched along with the rest; interrupted in-flight turn is
  expected and surfaced in the ⚠ line. No special suppression.
- **Terminals.** Never eligible (not a switchable provider kind), excluded from
  enumeration exactly as Close Old Agents excludes them.

## Testing

Per repo convention (no new test files in feature PRs; a separate testing-stack cleanup
is planned), this PR ships **no new test files** and wires **no new `test:*` scripts**.
Verification is manual via the running app: switch a batch across ≥2 projects (mix of
idle and mid-turn agents), confirm the preview count and ⚠ line, confirm the agents
respawn on the target provider with translated history, reopen the modal, confirm the
banner shows the batch, hit Return, and confirm the agents come back on the origin
provider with interim work intact. Temporary throwaway fixtures during development are
fine but not committed.

## Out of scope (YAGNI)

- Multi-level batch history / a stack of past switches (only "most recent" is kept).
- Keybind for switch or return.
- A command-palette entry for Return (it lives only in the modal).
- Auto-switching on detected rate-limit (this is a manual, user-initiated action).
- Per-agent selection checkboxes in the preview (scope is project-level, matching Close
  Old Agents; the preview is informational).
- Refactoring `CloseOldAgentsModal` to share enumeration beyond what's trivial.
```
