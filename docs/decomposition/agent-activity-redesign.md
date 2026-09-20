# Decomposition: Agent Activity, redesigned

Owner, 2026-09-19: *"completely redesigning or reimagining the agent activity
command, that modal is ages and just shit across the board"* (release-readiness
ledger, T14).

## A — what exists and is trusted (named)

- `src/renderer/src/features/workspace/ui/AgentActivityModal.tsx` (545 lines) —
  the surface being replaced. Rows are grouped by tab or sorted by activity,
  each showing provider glyph, cwd basename, tab, a relative time, and
  hover-revealed Focus / Close / Bury.
- `src/renderer/src/features/agent-status/model/agentStatusModel.ts` — ALREADY
  reconciles one agent's identity, runtime, placement and MCP domains into a
  single object. Trusted, and the natural substrate; it is currently built for
  one focused agent rather than the whole fleet.
- `src/renderer/src/workspace/dispatch/dispatchSelectors.ts` (`buildVisibleDispatchRows`,
  `isPinned`) — the one owner of "what is in the pool, what is pinned, what is
  on a lane" since the unified stage (#1013).
- `src/renderer/src/workspace/sessionDisplayTitle.ts` — the existing title
  resolution (explicit title → spoken agent name → first prompt → cwd).
- `orchestrationChildLifecycle` / `terminalProviderFailure`
  (`workspace/orchestrationMcp.ts`, #1018) — the only place that already
  answers "did this agent's provider turn FAIL".
- Conditions (`shared/types/providerConditions.ts`), queued prompts
  (`runtime.queuedMessages`, #889), goal loops (`shared/types/goalLoop.ts`,
  #1001), TLDR and Goal notes (#932, #936), Agent Analytics (#964).
- `bulkClose.ts` (#960) — the sequential approved-close executor every bulk
  close must route through.

## The evidence this is built on

`testing/fixtures/agent-activity/owner-fleet-2026-09-19.json` is the owner's
live workspace, read through Agent Code's own control MCP (`ac_agents_list`)
rather than imagined:

| Fact | Value |
|---|---|
| Sessions in one window | **33** |
| Sessions in the largest project | **28** |
| Sessions with an explicit title | **3** |
| Sessions with a spoken agent name | **0** |
| Sessions currently on a lane | **11** |

What that says about the current modal, in order of severity:

1. **It cannot answer "which agent needs me".** It has no attention signal at
   all: not a pending permission condition, not a provider failure (#1018), not
   a queued prompt, not a goal loop at its cap. With 33 rows this is the ONLY
   question worth asking, and the modal is silent on it.
2. **Rows are unidentifiable.** With 3 titles across 33 sessions, the row label
   falls through to the first user prompt, so the real fleet reads:
   *"but what that makes 0 senes? most of the times when i start a agent it goes
   and manages to get back to glm 5.3…"* — a paragraph, truncated, as the name
   of a row. Three rows read `agent-code` (the cwd) and are indistinguishable.
3. **It shows a fraction of the fleet, by the wrong rule.** It lists panes, so
   22 parked pool sessions — the ones most likely to be closable — are the
   hardest to reach.
4. **Its vocabulary is pre-#1013.** "Tab", "Dispatch order", "grid" and "tiled"
   are gone from the product; lanes, projects and the pool replaced them.
5. **No search.** 33 rows, no filter, in an app whose palette is keyboard-first.
6. **Actions are hidden until hover** and are one-at-a-time, while the real
   cleanup job ("close these nine") is inherently bulk.

## D — end state in observable behaviour

One surface that, in a single glance at a 30-agent fleet, answers:

1. **Who needs me?** Agents with a pending condition, a failed provider turn, a
   stopped goal loop, or a queued prompt that never went — grouped first, with
   the reason in words.
2. **Who is working, and on what?** The live agents, each with its current
   activity and its TLDR/Goal line rather than a prompt fragment.
3. **What can I clean up?** Idle and exited agents, oldest first, selectable in
   bulk and closed through the approved-close executor.

Plus: type-to-filter over every row; one keyboard grammar (arrows, Enter to
focus, Space to select, ⌫ to close the selection); every row identifiable
without hovering it.

## Stages

### Stage 1 — Fleet recorder (instrumentation; no visible change)
- **Produces:** `testing/fixtures/agent-activity/` recordings of REAL fleets,
  through `ac_agents_list` + `ac_workspace_observe` (the owner's 33-session
  window is the first), plus a runtime-side capture that records, for each
  session, the fields a row needs: conditions, queued messages, stream phase,
  session status, process error, goal loop state, TLDR/Goal note, orchestration
  role and lifecycle, last committed entry time.
- **Verified by:** the capture runs against the live app and the committed file
  reproduces the counts above; no field is invented.
- **Why separate:** every later stage is graded against "does it make THIS
  fleet legible". A hand-built 5-row fixture would make any design look fine.
- **Reality check:** it is the owner's own workspace, which is the workspace
  the complaint is about.

### Stage 2 — One row model (the isolated hard part)
- **Produces:** `src/renderer/src/features/agent-activity/model/activityRow.ts`
  — a pure function from (workspace state, runtimes, notes, loops) to
  `ActivityRow[]`, where each row carries: identity (title, source of that
  title, provider, project, placement), attention (`needs-you | working | idle |
  failed | exited`, with a reason string), activity (last-active time, current
  phase), and the actions the row admits.
- **Verified by:** replaying the Stage 1 recordings through it and asserting the
  bucket, reason and label of every row; fail-first against today's behaviour
  (no attention bucket exists yet).
- **Why separate:** this is the reconciliation the current modal lacks. It must
  have ONE owner, not a `useMemo` per view. Only the view and the command may
  import it.
- **Isolation:** forbidden to import any view; forbidden for any other surface
  (Close Old Agents, Close Idle, Agent Status) to re-derive attention — they
  move onto this model in Stage 6 or stay as they are.

### Stage 3 — The surface
- **Produces:** the replacement view: attention-grouped sections, per-row
  identity + status + TLDR line, a filter field, and empty states that say what
  is true ("nothing needs you").
- **Verified by:** renderer tests rendering the recorded fleets, asserting what
  a user can SEE: the needs-you section names the right agents, no row's label
  is a prompt fragment when a better source exists.

### Stage 4 — Actions and bulk
- **Produces:** row actions (focus, close, bury, pin) plus multi-select and
  bulk close routed through `bulkClose.ts`, with the same confirmation policy
  as the root close.
- **Verified by:** tests that a bulk close goes through the approved executor
  (never a raw kill loop), and that a refused confirmation closes nothing.

### Stage 5 — Keyboard
- **Produces:** one grammar: type to filter, ↑/↓ to move, Enter focus, Space
  select, ⌫ close selection, Esc dismiss, with the chord shown in the footer.
- **Verified by:** router-level tests through the real keybinding path.

### Stage 6 — Consolidation sweep
- **Produces:** a decision, recorded here, for each adjacent surface: Close Old
  Agents (#930), Close Idle Orchestration Agents (#960), Agent Status (#900),
  Agent Analytics (#964) — folded in, kept, or re-pointed at the Stage 2 model.
- **Verified by:** no surface computes "is this agent idle/failed" twice.

## Unknowns (explicitly not yet decided)

1. **Modal or full surface?** 33 rows with sections and bulk selection is a
   panel, not a dialog. Spotlight and Reader are precedents for a takeover.
   OWNER CALL.
2. **Does it replace Close Old Agents and Close Idle Orchestration Agents?**
   Both are single-purpose commands whose job is a filtered bulk close, which
   this surface would do natively. OWNER CALL.
3. **Is "needs you" allowed to include a goal loop that hit its cap?** It is
   the agent waiting on a human decision, so I think yes.
4. **Should idle agents show their last answer's first line?** It is the
   cheapest "what happened here" and costs one entry read per row.
5. Pinned agents: their own section, or a marker on the row?
6. Whether the row model should also power the phone (`src/remote-client`),
   which today has its own session list.

## Fixture plan

Stage 1 produces everything later stages assert against: the control-MCP fleet
reading (committed), plus a runtime capture of the same window. No stage may
introduce a hand-written fleet; a single-row unit fixture is allowed only for a
pure formatting helper.
