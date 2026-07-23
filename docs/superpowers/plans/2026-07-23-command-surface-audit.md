# Command Surface Governance — Audit and Implementation Plan

Status: **Awaiting user review. No implementation has started.**

Date: 2026-07-23

Feature branch: `feat/command-governance`

Feature worktree: `.worktrees/command-governance`

Planned PR title: `Govern command visibility, state, and settings ownership`

Baseline: `main` at `670f4c2d00d5585f81bb1f5677a1deda70b08a44`

Research provenance: Agent Code Workflow MCP run
`run_e219348d-cdc8-49f7-893b-23858601e68d` (eight parallel audits plus one
independent synthesis pass), followed by direct local verification against the
runtime command exports.

## Goal and checkpoint

Audit every command that Agent Code registers, decide which commands need
context/capability/safety gates, normalize command-state badges, decide whether
each behavior belongs in Commands, Settings, or both, and establish an
implementation sequence that can be shipped without changing all invocation
paths in one flag day.

This commit is deliberately the review checkpoint. It contains the audit and
implementation plan only. The branch is intended to hold the eventual full
implementation, but no source or test changes should begin until this document
has been reviewed.

## Executive result

The catalog has **102 concrete static commands**, not 93, 98, or 100:

- 98 literal `id` fields exist in command modules;
- the pane module's two provider templates expand across Codex and OpenCode,
  adding four concrete runtime IDs; and
- `agent-index:<sessionId>` rows are transient search destinations generated
  outside the static catalog and are not counted as commands.

All 102 static commands currently have effective `pickerVisibility: 'default'`.
The type already supports `advanced`, `experimental`, and `debug`, but no
command uses any of them. Debug tooling, destructive maintenance, niche MCP
controls, and daily navigation therefore all enter the picker at the same tier.

The deepest defect is not one bad `when` predicate. The code has a **picker
resolver**, not a command-admission authority:

```text
static command definitions
  -> surface gate
  -> command.when
  -> rendered-view policy
  -> picker visibility / user override
  -> picker rows
       |-> picker click/Enter runs command
       |-> native menu also looks up in this already-filtered list

keybindings ---------------------------> call workspace actions directly
programmatic callers ------------------> may call actions or command.run directly
```

That shape creates two opposite failures:

1. A cosmetic command-visibility override can remove a native File-menu action,
   even though the type contract says picker visibility must never disable a
   capability.
2. A shortcut or programmatic caller can bypass surface, feature, debug, and
   provider predicates that exist only while constructing picker rows.

The implementation should therefore separate four concerns that are currently
collapsed into a boolean filter:

| Concern | Question | Must affect |
|---|---|---|
| Applicability | Does this concept make sense on this layout/surface? | Picker and native menu presentation. |
| Availability/admission | Can this exact invocation succeed now? | Every invocation source, immediately before mutation. |
| Discoverability | Should this applicable command be listed by default? | Picker only. Never authorization. |
| Authorization/safety | Has the required user intent/confirmation been established? | The final mutation boundary, not just the initiating UI. |

## Decisions proposed by this plan

| Area | Proposed decision | Why |
|---|---|---|
| Catalog | Create a context-free, validated command catalog and preserve its ordered 102-ID snapshot. | Registration order is user-visible, while duplicate IDs, omitted modules, generated commands, and native-menu IDs are currently unchecked. |
| Execution | Add one command execution gateway with invocation source and a fresh admission check. | Picker, native menu, keybindings, and programmatic calls currently have different guarantees. |
| Visibility | Make visibility strictly picker-only; classify developer commands as `debug` and niche supported operations as `advanced`. | The tiers already exist but are unused, and native-menu execution currently depends on them accidentally. |
| State | Replace `{label, tone}` with semantic toggle/value/status states plus unavailable/loading/error and target identity. | Color and arbitrary text cannot distinguish boolean truth, values, inherited state, async work, or unsupported commands. |
| Settings ownership | Remove `dangerous-agents` from Commands; keep Settings as the durable home for five benign quick preferences; preserve Settings-default + per-session-command for MCP and agent view. | Safety posture changes need Settings context and confirmation. Session overrides are intentionally different from global defaults. |
| Providers | Gate features by declared capability, not `isAgentProviderKind()`. | OpenCode currently receives Rewind, Duplicate, Resume, Switch Provider, and Copy Resume affordances that are empty, rejected, unsupported, or unverified. |
| Targeting | Resolve and pin one target for state + execution, then revalidate identity/capability before mutation. | The shared grid/Dispatch resolver is sound, but repeated resolution can display state for A and mutate B after focus changes. |
| Destructive actions | Confirm active/running or cascading closes, re-enumerate bulk-close targets at commit, and keep ownership checks in main. | Undo does not recover live terminal state, unsent drafts, or partial cascades. A stale preview must not authorize a later changed target set. |
| Rollout | Characterize first, then separate catalog/admission, then migrate high-risk families, then change UX defaults. | Structural changes and behavior changes need independent rollback boundaries. |

## What is already correct and must be preserved

- `commandTargetSessionId` correctly uses the selected related child in Grid,
  the strict focused row/lane in Dispatch, and no fallback for an empty or
  stale tiled lane.
- Rendered-view policies are distinct from layout surfaces and should remain so.
- The built-in MCP provider table correctly allows all injectable domains on
  Codex, excludes every built-in domain from OpenCode, and excludes Workflow
  MCP from Claude because Claude already supplies the native workflow feature.
- Settings MCP rows are defaults for **new sessions**; their command counterparts
  are **per-session** overrides. Those are complementary, not duplicate owners.
- Main-process session termination already proves `{sessionId, kind, cwd}`
  ownership atomically. UI confirmation must supplement that check, not replace
  it.
- `reply-to-selection` is the strongest current example of revalidating its
  target-specific transient input at execution time.
- The removed `toggle-dispatch-terminal` command is the correct precedent for
  moving a durable preference into Settings when a transient command created
  misleading persistence expectations.

## Canonical source map

| Registry contribution | Runtime count | Source |
|---|---:|---|
| Tabs | 6 | `features/workspace/commands/tabCommands.ts` |
| Panes, placement, navigation, generated provider splits | 28 | `features/workspace/commands/paneCommands.ts` |
| Layout and Dispatch | 9 | `features/workspace/commands/layoutCommands.ts` |
| Global Editor and AI Workspace | 10 | `features/global-editor/commands/globalEditorCommands.ts` |
| Session/provider/MCP/debug | 29 | `features/workspace/commands/sessionCommands.ts` |
| Dispatch color flag | 1 | `features/workspace/commands/dispatchColorFlagCommands.ts` |
| Spotlight / Reader / Tiled Tabs | 3 | Their feature-owned command modules. |
| Settings plus nested dangerous command | 5 | `features/settings/commands/{settings,dangerous}Commands.ts` |
| Copy Assistant / Copy Code Block | 2 | Their feature-owned command modules. |
| Prompt templates / Reply to Selection | 4 | Their feature-owned command modules. |
| Agent Status / Remote | 2 | Their feature-owned command modules. |
| Usage | 3 | `features/usage/commands/usageCommands.ts` |
| **Total** | **102** | Concatenated by `features/command-palette/registry.ts`. |

## Audit legend

- **Gate** describes current picker applicability beyond the command's surface.
  `none` means there is no command-specific `when`; surface and visibility still
  apply.
- **State** is the current badge, not the proposed semantic state.
- **Scope/risk** combines persistence scope with meaningful side effects.
- **Home** is `C` (Command), `S` (Settings), or `B` (both, with explicitly
  different or Settings-primary scopes).
- **Tier** is the proposed default picker visibility. A hidden tier remains
  runnable only through an invocation path that independently passes admission.
- `target` in a proposed gate means resolve a concrete target and carry that
  identity into execution; it does not mean “rerun whichever target is focused.”

## Exhaustive 102-command audit

| ID / current title | Surface | Current gate; state | Scope / safety | Proposed category · tier · home | Required change |
|---|---|---|---|---|---|
| `new-tab` — New Tab | app | none; — | Workspace create / spawns agent | Create · default · C | Keep; native menu must resolve outside picker visibility; spawn boundary deduplicates/rate-limits. |
| `close-tab` — Close Tab | app | none; — | Workspace + process teardown / destructive cascade | Layout & Dispatch · default · C | Require active tab; pin tab; confirm when running or cascade count >1; revalidate before close. |
| `next-tab` — Next Tab | app | none; — | Focus only | Navigate · default · C | Gate/disable when fewer than two tabs; keep action no-op safe. |
| `prev-tab` — Previous Tab | app | none; — | Focus only | Navigate · default · C | Same as `next-tab`. |
| `reorder-tabs` — Reorder Tabs | app | more than one tab; — | Workspace order | Navigate · default · C | Recheck count and tab identities at modal commit; native menu ignores picker visibility. |
| `resume-session` — Resume Session | app | none; — | Provider session create/replace | Session · default · C | Require focused CWD plus a provider with saved-session listing; use provider chooser/friendly unavailable state instead of OpenCode/terminal fallback. |
| `new-agent` — New Agent… | app | active non-tiled tab; — | Workspace/process create | Create · default · C | Rename to New Pane… or stop offering Terminal; require at least one launchable provider/runtime and deduplicate commit. |
| `split-vertical` — Split Pane Right | grid | none; — | Workspace/process create | Create · default · C | One semantic contract across sources: reject in Dispatch or route the key to a distinct direction-free creation command; require default-provider launchability. |
| `split-horizontal` — Split Pane Down | grid | none; — | Workspace/process create | Create · default · C | Same as `split-vertical`. |
| `close-pane` — Close Pane | session | none; — | Process teardown / destructive | Session · default · C | Rename/contextualize as Close Focused Session; require/pin target and confirm running/cascading closes. |
| `bury-pane` — Bury Pane | session | none; — | Workspace placement; process remains live | Layout & Dispatch · advanced · C | Rename Bury Session; require a grid-owned buriable target or implement detached-to-buried; revalidate. |
| `linked-agent` — Linked Agent… | session | target is any agent provider; — | Workspace/process create | Create · advanced · C | Fix Claude/Codex-only copy; validate child-provider launchability and parent identity at commit. |
| `attach-detached-to-grid` — Attach Detached Session to Grid… | dispatch | target is detached; — | Workspace placement | Layout & Dispatch · advanced · C | Keep; preserve strict detached target and validate placement at commit. |
| `pin-agents` — Pin Agents… | dispatch | none; — | Workspace pins | Layout & Dispatch · default · C | Keep empty-state modal; validate selected IDs at commit. |
| `unpin-agent` — Unpin Agent | dispatch | target is pinned; — | Workspace pins | Layout & Dispatch · default · C | Repeat pinned membership for the pinned target before mutation. |
| `attach-all-detached-for-tab` — Attach All Dispatch Sessions for Tab | app | applicable tab has detached sessions; — | Batch workspace placement | Layout & Dispatch · advanced · C | Re-resolve tab and detached set at execution; report partial failure. |
| `detach-to-dispatch` — Detach Session to Dispatch | session | target is grid-owned; — | Workspace placement | Layout & Dispatch · advanced · C | Repeat owner and last-leaf invariants at mutation; disclose exact target. |
| `terminal-horizontal` — New Terminal Right | grid | none; — | Workspace/process create | Create · default · C | Align Dispatch shortcut semantics with command identity; require terminal runtime readiness. |
| `terminal-vertical` — New Terminal Below | grid | none; — | Workspace/process create | Create · default · C | Same as `terminal-horizontal`. |
| `codex-vertical` — New Codex Right | grid | generated; — | Workspace/process create | Create · default · C | Align Dispatch shortcut semantics; require Codex setup/binary launchability at execution. |
| `codex-horizontal` — New Codex Below | grid | generated; — | Workspace/process create | Create · default · C | Same as `codex-vertical`. |
| `opencode-vertical` — New OpenCode Right | grid | generated; — | Workspace/process create | Create · default · C | Require OpenCode setup/binary launchability; no invisible Dispatch behavior. |
| `opencode-horizontal` — New OpenCode Below | grid | generated; — | Workspace/process create | Create · default · C | Same as `opencode-vertical`. |
| `nav-left` — Focus Pane Left | grid | none; — | Focus only | Navigate · default · C | Keybinding and command share the grid-mode admission rule. |
| `nav-right` — Focus Pane Right | grid | none; — | Focus only | Navigate · default · C | Same as `nav-left`. |
| `nav-up` — Focus Pane Up | grid | none; — | Focus only | Navigate · default · C | Separate Dispatch-row navigation identity from grid command/shortcut. |
| `nav-down` — Focus Pane Down | grid | none; — | Focus only | Navigate · default · C | Same as `nav-up`. |
| `undo-close` — Undo Close | app | none; — | Bounded in-memory recovery → workspace/process | Session · default · C | Expose undo-stack availability/reason; pin the recorded entry and revalidate restore ownership. |
| `revive-pane` — Revive Buried Pane | app | any buried session; — | Workspace/process wake | Layout & Dispatch · advanced · C | Rename Revive Buried Session…; gate from the same scoped list the picker displays. |
| `kill-buried-pane` — Kill Buried Pane… | app | any buried session; — | Process teardown / destructive, no undo | Layout & Dispatch · advanced · C | Rename session; add second confirmation/running warning; validate selected record immediately before kill. |
| `toggle-tail` — Tail | session | nonterminal + rendered feed; `Off`/`On`/`On (all)` | Target runtime only | Session · default · C | Rename Auto-follow Focused Agent; semantic `mixed/inherited` state; repeat kind/render gate for pinned target. |
| `toggle-tail-all` — Tail All | app | none; `On`/`Off` | Transient workspace UI policy | Layout & Dispatch · advanced · C | Rename Auto-follow All Visible Agents; retain explicit zero-target stance; semantic boolean state. |
| `jump-latest-message` — Jump to Latest Message | session | nonterminal + rendered feed; — | Scroll only | Navigate · default · C | Re-resolve/pin feed owner before scroll. |
| `copy-last-assistant` — Copy Last Response | session | nonterminal; — | Clipboard | Session · default · C | Gate/disable when no assistant response; repeat target/provider extraction capability. |
| `dispatch-mode` — Dispatch Mode | app | none; `Off`/`Project`/`Global` | Workspace layout | Layout & Dispatch · default · C | Keep; formalize enum/value state and admission inside enter/exit actions. |
| `global-dispatch` — Global Dispatch | dispatch | none; `On`/`Off` | Workspace Dispatch scope | Layout & Dispatch · default · C | Rename Dispatch Scope; state `Project`/`Global`; repeat Dispatch-active admission. |
| `tiled-dispatch` — Tiled Dispatch | app | none; — | Workspace layout | Layout & Dispatch · default · C | Add `Off` or lane-count state; require a project/tab; validate tile count at commit. |
| `normalize-layout` — Normalize Layout | grid | none; — | Workspace layout rewrite | Layout & Dispatch · advanced · C | Repeat grid/active-tab admission at mutation. |
| `hard-normalize-layout` — Hard Normalize Layout | grid | none; — | Strong workspace layout rewrite | Layout & Dispatch · advanced · C | Mark advanced; repeat grid/active-tab admission. |
| `rotate-layout` — Rotate Layout | grid | none; — | Workspace layout rewrite | Layout & Dispatch · advanced · C | Repeat grid/active-tab admission. |
| `toggle-status-mode` — Status Mode | app | none; `On`/`Off` | Persisted app preference | Preferences · default · B | Settings is durable primary home; keep fast command; semantic persisted boolean state. |
| `toggle-performance-panel` — Performance Stats | debug | none; `On`/`Off` | Transient diagnostic UI | Developer · debug · C | Default-hide as debug; add developer/runtime admission if production access is not intended. |
| `toggle-caffeinate` — Caffeinate | app | none; `Off`/`On`/`Unsupported` | Main/OS process | Workspace Tools · default · C | Model loading/error/unsupported; disable or hide unsupported; main revalidates platform and single ownership. |
| `toggle-global-editor` — Global Editor | app | none; `On`/`Off` | Transient surface | Editor & Files · default · C | Add declared shortcut metadata; require project only when opening if empty editor is invalid. |
| `save-editor-file` — Save Editor File | editor | editor open; — | Filesystem write | Editor & Files · default · C | Native menu bypasses picker visibility; receiving editor revalidates visible document, dirty/version state, root and path containment. |
| `save-all-editor-files` — Save All Editor Files | editor | editor open; — | Batch filesystem write | Editor & Files · default · C | Same as save, plus partial-result contract; disable when no dirty files. |
| `quick-open-file` — Quick Open File | editor | focused CWD; — | Read/navigation | Editor & Files · default · C | Keep; revalidate root/CWD when selection opens. |
| `search-in-files` — Search in Files | editor | focused CWD; — | Read/search | Editor & Files · default · C | Keep; expose search backend unavailable/error if applicable. |
| `toggle-editor-fullscreen` — Editor Fullscreen | editor | editor open; `On`/`Off` | Feature runtime | Editor & Files · default · C | Repeat editor-open admission; semantic boolean state. |
| `open-ai-workspace` — Open AI Workspace | editor | none; — | Main-owned workspace reference | Editor & Files · advanced · C | Gate on API/storage readiness or retain an explicit empty/unavailable view. |
| `create-ai-workspace` — Create AI Workspace | editor | none; — | Main-owned create | Editor & Files · advanced · C | Validate name/root/storage readiness at commit. |
| `clear-ai-workspace` — Clear AI Workspace | editor | second-Enter flow later; — | Deletes app metadata, not files | Editor & Files · advanced · C | Keep target-bound arming; revalidate selected workspace ID and dirty attachments at mutation. |
| `toggle-file-tree` — File Tree | editor | editor open; `On`/`Off` | Feature-local persisted view | Editor & Files · default · C | Use panel vocabulary `Open`/`Closed`; repeat editor-open admission. |
| `view-prompts` — View Prompts | session | agent provider; — | Read-only modal | Session · default · C | Provider-neutral copy; repeat target/transcript-history capability. |
| `rewind-to-prompt` — Rewind to Prompt… | session | agent provider + provider session ID + feed lease; — | Provider transcript/session rewrite | Session · advanced · C | Require explicit rewind capability; hide/disable OpenCode; pin target through selection and commit. |
| `undo-rewind` — Undo Rewind | session | matching rewind runtime state; — | Provider/session recovery | Session · advanced · C | Preserve strict undo identity and repeat at action boundary. |
| `open-agent-activity` — Agent Activity… | app | none; — | Read-only modal | Workspace Tools · default · C | Rename Open Agent Activity…; explicit empty state is acceptable. |
| `close-old-agents` — Close Old Agents… | app | none; — | Batch process teardown / destructive | Workspace Tools · advanced · C | Re-enumerate activity, running state, ownership, and cascade set immediately after confirmation; report partial results. |
| `switch-agents-provider` — Switch Agents to Another Provider… | app | none; — | Batch provider replacement | Session · advanced · C | Use switch compatibility graph and launchability; preview exact targets; transactional/partial-result contract. |
| `search-conversation-prompts` — Search Conversation Prompts | app | none; — | Read-only transcript search | Workspace Tools · advanced · C | Gate on at least one indexed provider or show explicit empty state; add ellipsis if more input follows. |
| `enable-built-in-mcp-ping` — Built-in MCP Ping | session | dev debug + provider domain support; `On`/`Off` | Session process replacement / diagnostic capability | Developer · debug · C | Repeat dev flag and provider support at execution; pin target; pending/error state. |
| `enable-ai-workspace-mcp` — AI Workspace MCP | session | provider domain support; `On`/`Off` | Session process replacement / capability | Session · advanced · B | Preserve new-session Settings default + per-session command; pin target; pending/error state. |
| `enable-orchestration-mcp` — Orchestration MCP | session | provider domain support; `On`/`Off` | Session process replacement / capability | Session · advanced · B | Same; Claude/Codex only. |
| `enable-agent-transcripts-mcp` — Agent Transcripts MCP | session | provider domain support; `On`/`Off` | Session process replacement / read capability | Session · advanced · B | Same; disclose per-session scope. |
| `enable-agent-management-mcp` — Agent Management MCP | session | provider domain support; `On`/`Off` | Session process replacement / cross-agent capability | Session · advanced · B | Same; disclose authority and pin target; pending/error state. |
| `enable-workflow-mcp` — Workflow MCP | session | provider domain support; `On`/`Off` | Session process replacement / orchestration capability | Session · advanced · B | Preserve **Codex-only** policy; never expose on Claude (native workflow) or OpenCode. |
| `reload-agent` — Reload Agent | session | resumable provider/runtime; provider label | Process replacement | Session · default · C | Treat provider as context value, not toggle; pin target; repeat resume/launch capability; pending/error. |
| `soft-reload-agent` — Soft Reload Agent | session | agent + rendered feed; provider label | Renderer/feed reset | Session · advanced · C | Repeat target/render capability; present provider as context value. |
| `set-agent-view-mode` — Set Agent View Mode... | session | target agent; `Default`/`Agent`/`Terminal` | Persisted per-session override | Session · advanced · B | Rename Agent View for This Session…; typographic ellipsis; show effective default detail; validate provider at selection commit. |
| `copy-resume-command` — Copy Resume Command | session | provider session ID; provider label | Clipboard | Session · advanced · C | Require verified external-resume-command capability; hide OpenCode until its CLI form is verified. |
| `duplicate-agent` — Duplicate Agent | session | agent + provider session ID; — | Provider transcript + process create | Create · advanced · C | Require duplicate/transcript-projection capability; hide OpenCode; pin source; deduplicate spawn. |
| `switch-provider` — Switch Provider | session | any agent provider; provider label | Provider transcript/process replacement | Session · advanced · C | Drive from explicit switch graph; hide OpenCode as source today; validate destination launchability; pending/error. |
| `toggle-git-bar` — Git Bar | app | none; `On`/`Off` | Transient UI | Workspace Tools · default · C | Gate opening on repository/CWD, allow closing unconditionally; use `Open`/`Closed`. |
| `toggle-debug-panel` — Debug Panel | debug | none; `On`/`Off` | Transient diagnostic UI | Developer · debug · C | Default-hide; require target if pane-scoped; use `Open`/`Closed`. |
| `toggle-feed-debug-panel` — Feed Debug Panel | debug | none; `On`/`Off` | Transient diagnostic UI | Developer · debug · C | Default-hide; require feed target when opening. |
| `toggle-proxy-debug-panel` — Proxy Debug Panel | debug | none; `On`/`Off` | Transient diagnostic UI | Developer · debug · C | Default-hide; gate on proxy/runtime availability when opening. |
| `save-debug-logs` — Save Debug Logs | debug | active tab only; — | Sensitive filesystem write | Developer · debug · C | Require concrete target; repeat debug/backend readiness; redaction/size/error contract. |
| `toggle-session-recording` — Toggle Session Recording | debug | recording feature + agent target; — | Sensitive recording journal | Developer · debug · C | Rename Session Recording; add On/Off/Loading/Error; repeat feature/provider/target admission in renderer and main. |
| `attach-recording-note` — Attach Recording Note | debug | recording feature + agent target; — | Recording journal write | Developer · debug · C | Add ellipsis; require active recording and pinned target at reservation/commit. |
| `toggle-rendering-debug-mode` — Rendering Debug Mode | debug | none; `On`/`Off` | Transient invasive diagnostic UI | Developer · debug · C | Default-hide; require rendered target when enabling; retain danger semantic state. |
| `toggle-html-debug-panel` — HTML Debug Panel | debug | none; `On`/`Off` | Transient sensitive snapshot UI | Developer · debug · C | Default-hide; require rendered target when opening; use panel vocabulary. |
| `toggle-dev-debug-panel` — Dev Debug Panel | debug | dev debug enabled; `On`/`Off` | Transient developer UI | Developer · debug · C | Default-hide; repeat dev capability at execution; use panel vocabulary. |
| `dispatch.color-flag.set` — Set color flag | session | concrete target; — | Persisted session-keyed visual metadata | Layout & Dispatch · advanced · C | Rename Set Color Flag…; add current color/value state; confirm whether terminals are valid targets. |
| `toggle-spotlight` — Spotlight | app | none; `On`/`Off` | Workspace view | Navigate · default · C | Require target only when entering; allow exit unconditionally; include target identity if state is target-specific. |
| `toggle-reader-mode` — Reader Mode | session | agent provider; `On`/`Off` | Workspace view | Navigate · default · C | Repeat provider/render target admission; clarify whether `On` belongs to current target or any open reader. |
| `tiled-tabs` — Tiled Tabs | app | none; `On`/`Off` | Workspace view | Navigate · default · C | Require enough selectable tabs when entering; allow closing unconditionally. |
| `open-settings` — Open Settings | app | none; — | Navigation | Preferences · default · C | Update stale category copy; picker visibility must not affect any future native Settings menu item. |
| `toggle-aggressive-debug-persistence` — Persistent Aggressive Debug Logs | debug | none; `On`/`Off` | Persisted app preference + disk cost | Developer · debug · B | Settings is primary explanatory home; keep debug-tier quick override; require backend readiness and explicit persistence/cost copy. |
| `toggle-worktrees-bar` — Worktrees | app | none; `Open`/`Closed` | Transient UI | Workspace Tools · default · C | Gate opening on repo/worktree capability; closing always allowed; rename Worktrees Panel if needed. |
| `toggle-worktree-badges` — Worktree Badges | app | none; `On`/`Off` | Persisted app preference | Preferences · default · B | Settings primary; keep quick visual command; semantic persisted boolean state. |
| `dangerous-agents` — Dangerous Agents | app | none; `On`/`Off` | Persisted safety posture + fleet reload / destructive | Preferences · remove · S | Remove command; Settings confirmation previews affected agents, pins desired value, and reports/rolls back partial reload. Fix contradictory copy. |
| `copy-assistant-message` — Copy Assistant Message… | session | agent + rendered-feed lease; — | Clipboard/read | Session · advanced · C | Repeat provider/render policy before entering picker; pin target through selection. |
| `copy-code-block` — Copy Code Block… | session | agent + rendered-feed lease; — | Clipboard/read | Session · advanced · C | Pin/revalidate target before resolving selected DOM block. |
| `manage-prompt-templates` — Manage Prompt Templates… | app | none; — | Persisted template collection | Workspace Tools · advanced · C | Keep; Settings need not duplicate management UI; validate edits at commit. |
| `prompt-template` — Prompt Template… | session | nonterminal + opens rendered feed; — | Composer draft | Session · default · C | Pin/revalidate target when selected template is inserted. |
| `save-composer-as-prompt-template` — Save Composer as Prompt Template… | session | agent + nonempty draft + rendered feed; — | Persisted template create | Workspace Tools · advanced · C | Snapshot draft deliberately or recheck at form commit; disclose global template scope. |
| `reply-to-selection` — Reply to Selection | session | matching stashed selection; snippet value | Composer draft | Session · default · C | Keep current target-bound revalidation; render snippet as context value, not status. |
| `show-agent-status` — Agent Status | session | agent target; `On`/`Off` | Transient contextual panel | Workspace Tools · default · C | Rename Show Agent Status for Focused Agent or treat panel as `Open`/`Closed`; tolerate/revalidate target loss. |
| `toggle-remote-panel` — Remote Control | app | none; — | Transient panel; network config persists elsewhere | Workspace Tools · experimental · C | Add panel state; opening may be universal, but enable/listen/pair actions require explicit in-panel network disclosure and runtime readiness. |
| `usage.open` — Usage | app | none; — | Read-only modal | Workspace Tools · default · C | Rename Open Usage; provider fetch failures remain isolated in modal. |
| `usage.toggle-header` — Usage in Header | app | none; `On`/`Off` | Persisted app preference | Preferences · default · B | Settings primary; keep quick visual command; semantic persisted boolean state. |
| `usage.cycle-header-level` — Usage Header Detail | app | none; raw lowercase level; also enables header | Persisted app preference | Preferences · advanced · B | Make command pure cycling to match Settings; show user-facing value and `Header off` detail instead of silently enabling. |

## Cross-cutting defects

### Missing or inconsistent admission gates

| Severity | Defect | Affected surface | Required invariant |
|---|---|---|---|
| High | Native menu resolves from the picker-filtered registry, so a `commandVisibilityOverrides[id] = false` preference silently disables File-menu actions. | `new-tab`, `resume-session`, `save-editor-file`, `save-all-editor-files`, `reorder-tabs`, `close-tab` | Native menu resolves a full catalog entry, skips picker visibility, and receives an explicit unavailable reason when contextual admission fails. |
| High | `isAgentProviderKind` is treated as a feature capability. | OpenCode Resume, Rewind, Duplicate, Switch Provider, Copy Resume | Provider membership distinguishes agents from terminals only. Feature gates consume explicit provider/transcript/switch capabilities. |
| Medium | Surface and `when` predicates are picker-time only. Several shortcuts intentionally call the same action under different semantics. | Grid splits/navigation; debug/recording commands; editor save; Reader | The same command ID has one semantic contract across picker, native menu, keybinding, and programmatic dispatch. Every side-effect boundary rechecks admission. |
| Medium | Target-sensitive commands independently resolve in `when`, `getState`, and `run`. | MCP toggles, reload/switch/duplicate, recording, close/bury, reader/copy | One invocation pins the target shown in state. Async/destructive execution either revalidates that exact target or rejects; it never silently retargets. |
| Medium | Unsupported or empty operations remain ordinary executable rows. | Caffeinate, Resume on OpenCode, Bury on detached sessions, no-target close/bury, Undo Close with no history | Discovery-worthy commands may be disabled with a reason; mode-irrelevant commands remain hidden; direct actions with no transition are unavailable. |
| Medium | Debug is a surface label, not a visibility or capability policy. | Performance, debug panels, logs, recording, rendering/HTML/dev debug, aggressive persistence, Ping MCP | All diagnostic commands declare `pickerVisibility: 'debug'`; developer-only actions also require a live developer capability at execution. |
| Medium | Provider spawn commands are generated from registered kinds, not current launchability. | Generic/provider splits, New Agent, Linked/Duplicate | Admission includes setup/binary/platform readiness and the spawn boundary repeats it. |
| Low | Modal entry often uses broad inventory while the modal uses a narrower scoped list. | Revive/Kill Buried, bulk switch/close, transcript searches | Gate and modal source the same resolver; commit re-enumerates or validates selected identities. |

### State and badge inconsistencies

`CommandState` is currently `{label: string, tone?: neutral | accent | danger}`.
The renderer uppercases every label into the same chip. This cannot express
whether the text is a boolean, a selected value, contextual information,
effective/inherited truth, unavailable state, or async progress.

| Problem | Commands | Required presentation |
|---|---|---|
| Missing state on real toggles/modes | `tiled-dispatch`, `toggle-session-recording`, `toggle-remote-panel`, `dispatch.color-flag.set` | Lane count or Off; recording On/Off/Loading/Error; panel Open/Closed; selected color/value. |
| Boolean vocabulary drift | Worktrees uses Open/Closed; panels mostly use On/Off; Dispatch Scope uses On/Off | Preferences/capabilities: On/Off. Panels: Open/Closed. Enum modes: user-facing option labels. |
| Context values masquerade as state | provider badges on Reload/Soft Reload/Copy Resume/Switch Provider; selection snippet on Reply | `kind: 'value'`, neutral context styling, never interpreted as enabled/disabled. |
| Effective state differs from owned state | Tail shows `On (all)` while invoking Tail cannot turn that effective state off | `mixed`/`inherited` with detail `On via Auto-follow All`; action description names the local setting it changes. |
| Persisted preference leads runtime | Dangerous Agents says On before fleet replacement completes | Loading with affected count, Mixed on partial application, Error on failure, On only after policy is applied. |
| Async replacement has no lifecycle | MCP toggles, reload, switch, duplicate, recording | Pending state begins before work; success/failure is observable after palette reopen; duplicate execution is single-flight or rejected. |
| Unavailable is rendered as neutral value | Caffeinate `Unsupported`; Usage detail while header is off | First-class unavailable state and reason; inactive enum value includes `Header off` detail. |
| Target scope is invisible | Reader, Spotlight, Agent Status, MCP toggles, session view mode | Badge/detail names `This session` or carries target identity for exact execution binding. |

Proposed state contract:

```ts
type CommandTarget =
  | { kind: 'none' }
  | { kind: 'app' }
  | { kind: 'project'; id: string }
  | { kind: 'session'; id: string }
  | { kind: 'document'; id: string }

type CommandState =
  | {
      kind: 'toggle'
      value: 'on' | 'off' | 'mixed'
      detail?: string
      truth: 'persisted' | 'runtime' | 'effective'
    }
  | {
      kind: 'value'
      label: string
      detail?: string
      truth: 'persisted' | 'runtime' | 'effective'
    }
  | {
      kind: 'status'
      value: 'loading' | 'unavailable' | 'error'
      detail: string
    }

type CommandAvailability =
  | { available: true }
  | { available: false; reason: string; presentation: 'hide' | 'disable' }

type ResolvedCommandInvocation = {
  commandId: CommandId
  target: CommandTarget
  availability: CommandAvailability
  state: CommandState | null
  execute: () => void | Promise<void>
}
```

The exact union may evolve during implementation, but four constraints are not
negotiable: tone is derived from semantics; unavailable is not a fake state
label; targeted state and execution share one identity; and async failures are
handled rather than fire-and-forgotten.

### Settings versus Commands

The placement rule is behavioral, not aesthetic:

| Behavior | Product home |
|---|---|
| Immediate action, navigation, modal/workflow entry, or temporary view | Command. |
| Persistent application preference with no useful momentary override | Settings only. |
| Persistent benign preference users reasonably flip while working | Settings primary plus a quick command, sharing one setter/source of truth. |
| Global default plus a meaningful per-session override | Both, with scope explicitly named. |
| Safety posture, credentials, network exposure, or expensive persistent diagnostics | Settings with explanatory context and confirmation; a command exists only if its safety flow is equivalent. |

| Settings control | Command | Decision | Required correction |
|---|---|---|---|
| Status Mode | `toggle-status-mode` | Both; Settings primary | Add scope metadata and semantic persisted state. |
| Worktree Badges | `toggle-worktree-badges` | Both; Settings primary | Same. |
| Usage in Header | `usage.toggle-header` | Both; Settings primary | Same. |
| Usage Header Detail | `usage.cycle-header-level` | Both; Settings primary | Stop implicitly enabling the header; show friendly option label and inactive detail. |
| Persistent Aggressive Debug Logs | `toggle-aggressive-debug-persistence` | Both; Settings primary, command debug-hidden | Disclose persistence/disk cost and verify backend readiness. |
| Dangerous Agents By Default | `dangerous-agents` | **Settings only** | Remove command; confirm enablement with affected-agent preview and explicit partial-failure behavior. |
| Agent View Mode | `set-agent-view-mode` | Both with different scope | Settings = app default; command = this session. Rename the command to disclose that. |
| Default built-in MCP rows | five configurable MCP commands | Both with different scope | Settings = new sessions; command = this session. Keep Workflow Codex-only. |
| Default Workspace Mode | Dispatch/Tiled Dispatch commands | Not duplicates | Settings controls initial/default policy; commands control the current workspace. |
| Attach Project Terminal to Dispatch | no command | Settings only, already correct | Preserve as the migration precedent. |

No data migration is needed to remove `dangerous-agents`: its canonical Settings
field remains. A stale `commandVisibilityOverrides['dangerous-agents']` entry is
harmless, but the implementation should define an explicit retired-built-in ID
policy instead of opportunistically deleting unknown extension/provider IDs.

Any new or changed persisted Settings field still requires:

1. a default;
2. coercion of old/malformed values;
3. a persistence-version increment;
4. an idempotent migration test; and
5. one canonical setter used by Settings and any surviving command.

### Destructive and privileged behavior

| Severity | Operation | Existing protection | Required addition |
|---|---|---|---|
| High | Close Pane / Close Tab / tab close button / shortcuts | Dispatch-aware targeting, main ownership proof, bounded Undo Close | Confirm a running target or any multi-session cascade; bind confirmation to exact expanded IDs; handle partial kill failure. |
| High | Close Old Agents | Preview modal and user click; running agents excluded in the snapshot | Re-enumerate immediately after confirmation, including activity/running/ownership/cascade changes; serialize and report partial completion. |
| High | Dangerous Agents | Persisted setting and main ownership proof during reload | Settings-only enable confirmation, affected count, preflight, single-flight, rollback or explicit Mixed state. Fix copy that currently says existing agents are unaffected even though they reload. |
| Medium | Kill Buried Session | Separate picker mode and main ownership proof | Second confirmation/running warning; target-bound grant; preserve record on backend rejection. |
| Medium | MCP enable/disable, Reload, Provider Switch, Rewind | Provider/domain checks and feature-specific modals | Pin target, explain process replacement/authority change, prevent duplicate execution, surface kill/spawn partial failure. |
| Medium | Agent Management MCP close tool (outside the 102-command catalog) | Tool prose requires an explicit user request; scope/self/cascade checks | Prose is not an enforceable grant. Add a short-lived user-issued caller/target authorization or renderer confirmation checked at mutation time. |
| Medium | Save / Save All | Explicit save gesture; editor conflict handling | Receiving editor revalidates root, target/version, symlink containment and dirty state for native-menu/programmatic invocation. |
| Low | Debug logs/recording/persistent diagnostics | Debug feature gates and explicit file picker in some paths | Repeat gates in renderer/main, bound retention/size, redact secrets, expose disk-full/cancellation errors. |
| Low | Remote networking controls | Command only opens panel | Keep enabling/listening/pairing behind an explicit in-panel gesture with bind/tunnel disclosure and main-process policy. |

Confirmation is not a blanket modal before every close. The proposed default is:

- idle single-session close remains immediate and undoable;
- running/streaming sessions require confirmation;
- any close that expands to linked children, detached tab-owned sessions, or
  multiple targets requires an exact count/list confirmation; and
- bulk flows revalidate after confirmation so the grant cannot drift onto new
  work.

## Provider policy

The command system should consume three explicit authorities:

1. the provider registry for spawn, live resume, saved-session listing,
   rendered-feed, attachments, and verified external CLI capabilities;
2. the transcript-adapter/switch registry for rewind, duplicate, prompt
   projection, and allowed provider-switch edges; and
3. the MCP domain table for injected domains and native-feature conflicts.

| Capability / command family | Claude | Codex | OpenCode | Terminal | Authority |
|---|:---:|:---:|:---:|:---:|---|
| Spawn / named creation | Yes | Yes | Yes | Yes | Provider/runtime launchability. |
| Saved-session Resume picker | Yes | Yes | **No today** | No | Main provider `listSessions` capability. |
| View Prompts / rendered feed actions | Yes | Yes | Yes where feed/history exists | No | Renderer/history capability. |
| Rewind / Duplicate | Yes | Yes | **No today** | No | Transcript adapter capability. |
| Switch Provider | Claude→Codex | Codex→Claude | **No edge today** | No | Explicit switch compatibility graph. |
| Copy Resume Command | Verified | Verified | **Unverified; hide** | No | Optional verified external-resume command. |
| Ping / AI Workspace / Orchestration / Transcript / Agent Management MCP | Yes | Yes | No | No | MCP provider-domain table. |
| Workflow MCP | **No — native Claude workflow** | Yes | No | No | MCP domain table + native-feature conflict. |
| Reader / Tail / Copy rendered content | Yes | Yes | Yes when rendered feed exists | No | Rendered-view policy. |
| Lifecycle/placement | Yes | Yes | Yes | Some lifecycle/placement actions | Workspace ownership/placement policy. |

Adding a provider must fail compilation or a catalog capability test until all
relevant declarations are supplied. It must not automatically inherit broad
agent features merely because it joined `AGENT_PROVIDER_KINDS`.

## Target and invocation invariant

| Visible context | Required command target |
|---|---|
| Grid parent pane | Focused grid session. |
| Selected linked/orchestration child shown inside a grid parent | The visible child, not the physical parent leaf. |
| Classic Dispatch | Strict visible focused row. |
| Tiled Dispatch | Strict selected lane row. |
| Empty or stale tiled lane | Unavailable; never fallback to another row. |
| Detached Dispatch session | That detached session when the command supports detached ownership. |
| Buried session | Only an explicit buried-picker selection; ordinary focused-session commands never wake it implicitly. |

For target-sensitive commands, resolution produces `{target, state, execute}` in
one snapshot. A later focus change does not retarget the operation. Immediately
before mutation, execution verifies that the pinned target still exists, still
belongs to the expected project/placement, and still has the required provider
and runtime capability. Failure produces an unavailable/error result, not a
fallback.

## Command and Settings taxonomy

`surface` remains a machine applicability dimension. It must not also serve as
the user-facing category. Add a required `category`:

| Command category | Objective rule |
|---|---|
| Create | Creates a tab, pane, session, terminal, agent, or durable template. |
| Navigate | Changes focus or opens a transient reading/navigation surface. |
| Session | Acts on exactly one resolved agent/session. |
| Layout & Dispatch | Changes placement, arrangement, membership, pins, or Dispatch scope. |
| Editor & Files | Primarily acts on a document, file, editor, or AI Workspace reference. |
| Workspace Tools | Opens project/workspace inspection and management tools. |
| Preferences | Mirrors a persisted app preference or opens Settings. |
| Developer | Diagnostics, recording, raw inspection, or support artifacts. |

Destructive and experimental are metadata, not categories. The Settings
information architecture should likewise separate functional ownership from
maturity:

1. Appearance
2. Workspace & Layout
3. Interface
4. Agents & Tools
5. Commands & Shortcuts
6. Voice & Dictation
7. Updates
8. Developer
9. Reset & Data

Every Settings row should expose machine-readable scope/apply/storage metadata,
rendered as small badges:

```ts
scope: 'app' | 'project' | 'session-default' | 'fresh-install'
apply: 'immediate' | 'new-session' | 'reload-live-sessions' | 'restart-required'
storage: 'settings' | 'workspace' | 'setup' | 'keychain' | 'external-files'
status?: 'experimental' | 'dangerous' | 'developer'
```

This also fixes misleading umbrella copy such as “Application defaults,” the
overloaded Workspace/Experimental categories, and Reset Settings' unclear
relationship to separately owned credentials, update policy, and convention
files.

## Naming and discoverability cleanup

| Current | Proposed | Reason |
|---|---|---|
| `Set color flag` | `Set Color Flag…` | Title case and additional input. |
| `Toggle Session Recording` | `Session Recording` | Stable toggle title; state lives in badge. |
| `Set Agent View Mode...` | `Agent View for This Session…` | Typographic ellipsis plus explicit scope. |
| `Tail` / `Tail All` | `Auto-follow Focused Agent` / `Auto-follow All Visible Agents` | Names the behavior and target; retain Tail as keyword. |
| `Close Pane` | `Close Focused Session` or contextual Pane/Dispatch label | The command can close a Dispatch row, not only a grid pane. |
| Bury/Revive/Kill “Pane” | Use “Session” | The live object persists without a pane. |
| `New Agent…` offering Terminal | `New Pane…` or remove Terminal choice | Title matches the objects the flow can create. |
| `Global Dispatch` + On/Off | `Dispatch Scope` + Project/Global | The behavior selects a scope, not a boolean. |
| raw usage levels | `Minimal`, `Providers`, `All Limits`, `Detailed` | Match Settings labels and title case. |

The command-visibility Settings row must stop being a flat title-only catalog.
It should group by command category and make nested command titles, descriptions,
keywords, shortcuts, tier, scope, and risk searchable. It must disclose when a
hidden command has no shortcut or alternate UI; “still executable” is not the
same as practically discoverable.

## Phased implementation plan

The phases below are intended as separately reviewable commits on this branch.
Each phase has a behavior boundary and rollback point. Do not combine catalog
extraction, provider policy, destructive confirmation, Settings migrations, and
visual defaults in one commit.

### Phase 0 — Characterize the current catalog

Files:

- add `src/renderer/src/features/command-palette/catalog.ts` as a read-only
  export of the current ordered definitions;
- add `src/renderer/src/features/command-palette/catalog.test.ts` and an ordered
  catalog snapshot;
- add/expand `src/main/menu/appMenu.test.ts`;
- expand Settings persistence/registry tests.

Work:

1. Move only the concatenation into `catalog.ts`; keep runtime filtering and
   behavior unchanged.
2. Validate all definitions before contextual filtering: unique ID, nonempty
   static catalog label/description, known surface/tier, and a run handler.
3. Assert the exact ordered **102-ID** snapshot and the generated provider
   invariant `(providers - default) × {vertical, horizontal}`.
4. Assert every native-menu ID exists in the executable catalog and every
   catalog ID appears in command-visibility Settings.
5. Capture the current shortcut metadata and dynamic-title fallback so later UX
   changes are explicit snapshot updates.

Rollback boundary: delete the new catalog API/tests and restore the existing
array; no product behavior will have changed.

### Phase 1 — Separate discoverability from admission

Files:

- `features/command-palette/types.ts`
- `features/command-palette/catalog.ts`
- `features/command-palette/registry.ts`
- new `features/command-palette/pickerVisibility.ts`
- new `features/command-palette/executeCommand.ts`
- `features/command-palette/ui/CommandPalette.tsx`
- `main/menu/appMenu.ts` and preload menu types/tests

Work:

1. Extract one context-free picker-visibility resolver used by the picker and
   Settings. Visibility remains presentation-only.
2. Replace the non-exhaustive `surfaceAvailable` fallthrough with an exhaustive
   switch and `assertNever`.
3. Resolve native-menu IDs from the full catalog, apply contextual admission,
   and deliberately skip picker visibility.
4. Introduce `dispatchCommand({source, id})` for `palette`, `native-menu`,
   `keybinding`, and `programmatic` sources. Centralize fresh admission,
   promise rejection/error reporting, history policy, and single-flight hooks.
5. Route picker and native menu through it first. Keep legacy direct keybinding
   actions temporarily, covered by parity tests, rather than claiming a false
   flag-day migration.

Rollback boundary: the old `buildCommandRegistry` remains available behind an
adapter until menu/picker parity tests pass.

### Phase 2 — Add typed availability, targets, safety, and categories

Files:

- `features/command-palette/types.ts`
- `features/command-palette/catalog.ts`
- `features/command-palette/registry.ts`
- `workspace/hook/selectors/commandTargetSessionId.ts`
- command modules as their metadata is populated

Work:

1. Add required `category`, declared `pickerVisibility`, target kind, and safety
   metadata to `CommandDef`.
2. Add unavailable reasons with `hide` versus `disable` presentation.
3. Add target-aware resolved invocations without making app/editor commands
   invent session targets.
4. Pin one session ID for high-risk commands first: close/bury, MCP toggles,
   reload/switch/duplicate/rewind, recording, and filesystem writes.
5. Add a mutation-boundary admission helper that consumes the same capability
   predicate as presentation but re-reads authoritative state.

Rollback boundary: definitions can use a legacy adapter during migration; no
high-risk command switches until its target/admission matrix test exists.

### Phase 3 — Apply visibility and taxonomy policy

Files:

- all feature-owned command modules
- `features/settings/lib/settingsRegistry.ts`
- `features/settings/ui/SettingsList.tsx`
- command ranking/search metadata tests

Work:

1. Mark diagnostic commands `debug` and the table's niche operations
   `advanced`; keep daily reversible actions `default`; mark Remote Control
   `experimental` until its runtime/support policy is final.
2. Populate the required command categories from the exhaustive table.
3. Group command-visibility Settings by category and search nested command
   metadata, not merely the parent setting row.
4. Display title, description, shortcut, tier, target/scope, and safety status.
5. Give dynamic-title commands a friendly stable catalog label rather than a
   raw ID.
6. Preserve explicit user visibility overrides when declared defaults change.

Rollback boundary: metadata-only commit; reverting restores the current flat,
all-visible picker without touching execution authority.

### Phase 4 — Make provider capability policy authoritative

Files:

- `src/providers/registry.renderer.capabilities.ts`
- `src/providers/registry.main.ts`
- provider identity files
- `src/main/providerSwitch/transcriptEngine.ts`
- provider switch compatibility code
- `src/mcp/shared/types.ts`
- `sessionCommands.ts`, `paneCommands.ts`, and Resume UI

Work:

1. Declare saved-session listing, transcript projection/rewind/duplicate,
   provider-switch edges, verified external resume command, rendered-feed, and
   launchability capabilities.
2. Gate Resume, Rewind, Duplicate, Switch Provider, and Copy Resume through
   those authorities. OpenCode is unavailable for those unsupported operations
   until its adapters are real.
3. Generate provider names in copy from the same capability set used by gates.
4. Add setup/binary/runtime readiness to provider creation commands.
5. Preserve the existing MCP matrix exactly: Workflow MCP remains Codex-only,
   Claude keeps its native workflow surface, and OpenCode gets no injected
   built-in MCP domains.

Rollback boundary: capability declarations land with characterization tests;
each command family switches to them in a separate commit.

### Phase 5 — Replace arbitrary badge text with semantic state

Files:

- `features/command-palette/types.ts`
- command badge UI inside `CommandPalette.tsx`
- a shared badge renderer usable by picker/details/Settings
- stateful command modules and async operation stores

Work:

1. Introduce toggle/value/status state variants and derive tone, icon, checkmark,
   and accessible text from the variant.
2. Convert simple booleans first, then enum/context values, then
   mixed/inherited Tail state.
3. Add missing state for Tiled Dispatch, Remote Panel, Session Recording, and
   Color Flag.
4. Model Caffeinate loading/unsupported/error instead of treating null as Off.
5. Persist operation state for MCP/reload/switch/recording so pending and error
   survive palette close/reopen.
6. Include target/scope detail where a global panel state and a session target
   could otherwise be confused.

Rollback boundary: keep a temporary adapter from old `{label, tone}` states;
remove it only after every `getState` definition is migrated and snapshot-tested.

### Phase 6 — Move ownership and harden destructive flows

Files:

- `features/settings/commands/{settings,dangerous}Commands.ts`
- `features/settings/lib/settingsRegistry.ts`
- `features/usage/commands/usageCommands.ts`
- `features/workspace/ui/CloseOldAgentsModal.tsx`
- pane/tab/session mutation actions and confirmation UI
- Agent Management MCP bridge/contracts if the adjacent grant fix is accepted

Work:

1. Remove `dangerous-agents` from the command catalog. Keep its canonical
   Settings field and add an enable confirmation with the exact live reload set.
2. Make dangerous-agent reload single-flight and expose success, Mixed partial
   application, failure, and rollback semantics. Correct contradictory copy.
3. Keep Status Mode, Worktree Badges, Usage Header, Usage Detail, and Aggressive
   Debug Persistence as Settings-primary quick commands; make Usage Detail a
   pure cycle.
4. Add running/cascade confirmation for tab/session close from every source,
   including buttons and shortcuts, with a target-bound grant.
5. Re-enumerate Close Old Agents after confirmation and before every kill.
6. Add a second confirmation for Kill Buried Session.
7. If included in this PR, replace Agent Management MCP close's prose-only
   permission with an enforceable short-lived caller/target grant or renderer
   confirmation. Preserve its project/self/cascade checks.

Rollback boundary: Settings ownership, ordinary close confirmation, bulk close,
and MCP grants are separate commits because they affect different authorities.

### Phase 7 — Naming, Settings information architecture, and cleanup

Files:

- command modules named in the audit table
- `docs/command-style.md`
- Settings registry/page/list components
- Settings coercion/version migration only if metadata is persisted

Work:

1. Apply stable title/ellipsis/target vocabulary corrections.
2. Add Settings scope/apply/storage/status metadata and render concise badges.
3. Split Settings categories as proposed; clarify Reset Settings' actual scope.
4. Add versioned command-ID aliases for any renamed IDs. Prefer title-only
   changes so user visibility overrides and keybindings retain stable IDs.
5. Remove the temporary state adapter and legacy execution paths only after
   catalog, invocation, and UI matrices are green.

Rollback boundary: visual/copy/category changes are isolated from command ID and
persistence changes.

## Required test matrices

### Catalog integrity

- Exact ordered 102-ID snapshot and explicit count.
- Unique IDs; required metadata; valid surface/category/tier/safety values.
- Generated provider split parity.
- Native-menu IDs are a subset of executable catalog IDs.
- Settings command catalog equals the command catalog, excluding explicitly
  retired IDs and transient agent-index destinations.
- Descriptions are validated before contextual filtering, including hidden
  commands.

### Presentation and invocation

Cross representative commands over:

| Axis | Values |
|---|---|
| Layout | Grid, project Dispatch, global Dispatch, tiled Dispatch. |
| Surface | app, grid, dispatch, session, editor, debug. |
| Context predicate | absent, true, false. |
| Declared tier | default, advanced, experimental, debug. |
| User override | absent, true, false. |
| Reveal-all | false, true. |
| Invocation source | picker, native menu, keybinding, programmatic. |
| Render policy | Agent, Terminal, Hybrid with/without lease. |
| Target | none, grid parent, selected child, detached row, stale/empty lane. |

Assertions:

- hidden affects picker only;
- native menu diagnoses unavailable versus unknown IDs;
- keybindings cannot bypass capability/safety admission;
- excluded commands do not evaluate state;
- async rejection is user-visible and never unhandled; and
- registry/picker order stays stable.

### Provider/capability

- Claude/Codex/OpenCode/Terminal matrix exactly matches the table above.
- OpenCode Resume/Rewind/Duplicate/Switch/Copy Resume are unavailable until a
  declared implementation capability exists.
- Claude never receives Workflow MCP; Codex does; OpenCode/Terminal do not.
- Adding an agent provider fails capability parity until every required policy
  decision is supplied.
- Provider setup/binary unavailability blocks spawn in picker and at mutation.

### Target and state

- Grid parent, selected related child, classic Dispatch row, tiled lane, stale
  lane, detached session, buried record.
- Focus change between palette render and invocation never silently retargets.
- Target closes/provider changes after confirmation: invocation rejects safely.
- Boolean/value/status rendering, accessibility, and details agree in picker,
  preview panel, and Settings.
- Tail inherited state; Caffeinate loading/error; recording and MCP
  pending/success/failure; dangerous fleet Mixed state.

### Safety and persistence

- Close via palette, keybinding, tab button, native menu/programmatic path.
- Running target, linked descendants, last-pane detached ownership, rapid
  duplicate invocation, backend kill failure, and partial cascade.
- Close Old Agents activity begins after preview; ownership/cascade changes;
  partial failure/retry.
- Settings coercion for absent, malformed, same-version-missing, unknown,
  renamed, and retired visibility keys.
- Defaults changing while explicit user overrides remain stable.
- Reset behavior across renderer Settings versus main-owned setup/keychain/file
  state is explicit and tested.

## Acceptance matrix

| Requirement | Acceptance evidence |
|---|---|
| Complete audit | Catalog test reports exactly 102 ordered static IDs and all appear in this document/Settings metadata. |
| Visibility is not authorization | Hiding each native File-menu command does not disable its menu item; direct invocation still fails any real contextual/capability gate. |
| Debug clutter is gated | Debug-tier commands are absent by default, revealable/overridable, and remain protected by live capability checks where required. |
| Consistent state | No stateful command returns arbitrary tone semantics; panels, toggles, values, unavailable, loading, mixed, and error states render predictably and accessibly. |
| Correct provider policy | Unsupported OpenCode operations do not appear as executable; Claude Workflow MCP remains blocked; provider additions require explicit capabilities. |
| Stable target | State and mutation refer to the same pinned target across focus, Dispatch lane, provider, and lifecycle changes. |
| Settings ownership | Dangerous Agents is Settings-only with confirmation; benign quick preferences share one source; MCP/view defaults and session overrides disclose scope. |
| Destructive safety | Running/cascading closes and all bulk closes are target-bound, freshly validated, and expose partial failure without silent retargeting. |
| Invocation parity | Palette, menu, shortcut, and programmatic paths share admission/error handling while retaining source-specific UI behavior. |
| Migration safety | Persistence-version/coercion/alias tests pass; command IDs remain stable unless an explicit idempotent alias migration exists. |
| Discoverability | Command Settings is grouped and searchable by nested titles, keywords, description, shortcut, tier, scope, and risk. |

## Validation commands

During implementation, run focused tests after each phase and the full contract
before declaring the PR complete:

```bash
npm run test:unit
npm run test:renderer
npm run test:system
npm run typecheck
npm test
npm run test:package
npm run check
```

Manual packaged-app checks must cover:

1. hide each native File-menu command and invoke it from the menu;
2. Grid/project Dispatch/global Dispatch/tiled Dispatch targeting;
3. Claude/Codex/OpenCode/Terminal command availability;
4. Caffeinate on supported and unsupported platforms;
5. debug reveal/override behavior;
6. focus change while an MCP/reload/switch operation is pending;
7. running and cascading close confirmation from button and shortcut paths;
8. Settings restart persistence and new-session versus current-session scope;
9. Claude does not receive Workflow MCP while Codex does; and
10. assistive-technology text for every semantic badge state.

## Product decisions requested at review

The source establishes the defects above, but these UX choices genuinely need
product confirmation before implementation:

1. **Unavailable presentation.** Recommendation: hide mode-irrelevant commands;
   show discovery-worthy unsupported commands disabled with a reason when the
   user searches for them.
2. **Persistent quick preferences.** Recommendation: remove only Dangerous
   Agents; keep Status Mode, Worktree Badges, Usage Header/Detail, and Aggressive
   Debug Persistence as Settings-primary commands (the last one debug-hidden).
3. **Close confirmation threshold.** Recommendation: confirm running/streaming
   targets and any cascade/multi-target close; keep an idle single close
   immediate and undoable.
4. **Directional shortcuts in Dispatch.** Recommendation: one command ID must
   have one meaning. Dispatch keybindings should invoke a distinct direction-free
   creation/navigation command rather than bypassing a hidden grid command.
5. **Remote Control maturity.** Recommendation: classify the panel
   `experimental` until packaged runtime/network readiness and disclosure are
   complete; keep actual enable/listen/pair actions separately authorized.
6. **Agent Management MCP close grant.** Recommendation: include the enforceable
   explicit-user-intent grant in this governance PR because prose-only safety is
   not a real gate. It is listed separately because it is an MCP tool, not one
   of the 102 palette commands.

## Non-goals

- Do not remove session-level MCP toggles; Settings owns defaults for new
  sessions, while commands intentionally own current-session overrides.
- Do not enable Workflow MCP for Claude; it duplicates a native feature.
- Do not make picker visibility a security or capability boundary.
- Do not replace main-process ownership checks with renderer-only confirmation.
- Do not persist transient panels/layout stances merely because they have state
  badges.
- Do not force every keybinding through the new gateway in one change; migrate
  high-risk bindings first with parity tests.
- Do not delete unknown command visibility keys indiscriminately; future
  extension/provider commands may be temporarily absent.
- Do not implement any item in this document before the review checkpoint is
  approved.
