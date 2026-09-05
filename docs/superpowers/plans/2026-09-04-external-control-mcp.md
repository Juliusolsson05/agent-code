Status: Proposed — planning only; no runtime implementation has started.

Architecture and execution gates:
[internal control SDK decomposition](../../decomposition/external-control-sdk.md).
This product plan defines scope; the decomposition defines implementation order
and the feature-registration boundary, pending explicit approval.

# External control MCP and command discovery

## Product outcome

The user speaks to an external Codex conversation and asks it to operate Agent
Code. That operator discovers commands by describing an intention, invokes
dedicated MCP tools for common tasks and difficult UI interactions, and opens the real command picker or
another app surface when computer use is the appropriate next step.

Example: "Open this project, put Claude next to two Codex agents, give them
these tasks, and show me the one that needs attention." The operator can create
and prompt agents through MCP, then click through a provider picker or inspect
the rendered conversation through computer use. Both routes operate on the same
running application and the same user-visible state.

This plan incorporates both user clarifications: the MCP should do a lot,
including navigation and other work that is tricky for an agent using the UI.
Broad command discovery and good UI handoffs complement a substantial direct
control surface. Hybrid does not mean a small convenience layer over mouse use.
Complete one-to-one automation of every control is not a delivery requirement,
but finding an existing agent or reaching it across layout modes must not be
left to a sequence of guessed clicks.

Choose direct coverage by frequency, UI difficulty, precision required, and the
number of intermediate steps saved. An infrequent operation can still deserve
a tool if finding the target or recovering from a wrong click is difficult.
Computer use covers interactions that remain practical visually, especially
visual judgment and richer editing within an already-open surface. It is not
an excuse to defer the app's hardest navigation paths.

The MCP is also the operator's complete reference for the application: all
commands, all Agent Code keybindings, a description of the app as a whole, and
descriptions of every shipped feature, including features without commands or
direct tools. Complete discoverability and explanation are delivery requirements
even though complete direct automation is not.

The operator can also retrieve a complete local history of its MCP activity:
what it requested, the arguments and targets, what actually ran, and the returned
results or errors. Agent-output reading is a separate lightweight surface whose
default is user prompts and all user-visible assistant messages, with selectable
depth for activity and full available transcript detail.

The server is a separate, opt-in external control surface. Agent Code's own
agents do not receive it by default. Existing Orchestration, Agent Management,
AI Workspace, transcript, and Workflow MCP domains retain their scopes.

## Planning and delivery status

- Investigated base: `4c641f68c86b7c17ad04e1f3827b98bd581c6693` on `origin/main`.
- Worktree/branch: `agent-code-external-control-mcp` / `feat/external-control-mcp`.
- This document is the first artifact committed on that feature branch.
- Search for and create/link the feature Issue before production implementation.
  The Issue will record motivation, agreed scope, and acceptance scenarios.
- Implementation PRs reference that Issue. A plan commit is not evidence that
  the product exists; do not close the Issue or mark this plan complete for it.
- No app configuration, MCP installation, provider processes, or user workspace
  state are changed by this planning task.

## 1. Three supported ways to operate

| Route | Purpose | Example | Success means |
|---|---|---|---|
| Discover | Find commands and understand their effects and prerequisites | Search "read conversation without distractions" | Ranked descriptions, current availability, and the next supported route |
| Open UI | Bring the operator to the correct visible interface | Open the command picker with Reader Mode selected | The requested window and surface are visible and ready for computer use |
| Direct tool | Complete a frequent or UI-difficult task with explicit arguments | Find an existing agent across projects and reveal it in its actual view | The operation's actual outcome and resulting identities are returned |

Opening a picker is a useful completed MCP operation. It does not claim that
the action selected later inside that picker has finished. The operator must
observe after clicking, just as it observes after a direct tool call.

Do not build a new command-palette UI, a generic form renderer, a mouse/keyboard
automation engine, arbitrary JavaScript evaluation, or an unrestricted IPC
proxy. Reuse the existing palette and the operator's computer-use capability.

## 2. Existing implementation and implications

Paths below are relative to the repository root; abbreviated `features/` paths
resolve under `src/renderer/src/`.

| Existing source | What it provides | Implication |
|---|---|---|
| `src/renderer/src/features/command-palette/catalog.ts` | Ordered, context-free command membership | Command discovery derives from this catalog, including generated commands |
| `features/command-palette/types.ts` under renderer source | IDs, titles, descriptions, surface/category, state, applicability, handlers | Extend the existing contract; do not maintain a second handwritten command list |
| `features/command-palette/executeCommand.ts` | Dispatch admission, errors, single-flight protection, usage-history policy | Preserve this gateway and extend it deliberately for external invocation |
| `features/command-palette/resolveInvocation.ts` | Current availability and the history of failed target pinning | Target identities must reach the mutation, not merely be attached to dispatch metadata |
| `features/command-palette/lib/rankCommands.ts` and `rankEntries.ts` | Shared relevance tiers and browse ordering | Add description search without introducing a competing search algorithm |
| `features/command-palette/ui/CommandPalette.tsx` | Picker, local query/selection, lazy command-context assembly | Add acknowledged open intents; preserve lazy mounting while closed |
| `src/renderer/src/app-state/uiShell/` | Palette modes, pending invocations, modal/surface state | Own short-lived UI handoff intents here |
| `src/renderer/src/workspace/hook/actions/` | Actual tab, pane, Dispatch, session, and provider operations | Extract explicitly targeted operations only as wrappers need them |
| `src/renderer/src/workspace/agentIndexNavigation.ts` and `hook/actions/agentIndexNavigation.ts` | Existing mode-aware navigation and wake/revalidation behavior | Generalize from positional pane labels to stable session IDs, retaining existing-view precedence |
| `src/main/window/windowRegistry.ts` | Windows and session ownership | Route by an explicit window or the target's owner, never an arbitrary focused window |
| `src/main/agentManagement/AgentManagementBridge.ts` | Typed renderer requests and uncertain prompt outcomes | Reuse the request/response lessons without pretending an operator is an internal caller session |
| `src/main/sessionManager.ts` and `src/providers/` | Provider lifetimes, readiness, input, conditions, prompt delivery | Reuse provider behavior; successful process start is not prompt readiness |
| `src/mcp/runtime/` | Authenticated Streamable HTTP hosting and tool registration | Add a separate external host/registration path with shared low-level helpers where useful |
| `src/providers/shared/runtime/builtInMcpLaunch.ts` | Native MCP config injection | Verify external-server exclusion at provider launch and recovery boundaries |

The current command ranker searches titles and keywords, not descriptions.
The current palette mode is store-owned, but query and selected row are local
component state. The current command dispatcher reports `ran`, which means the
handler completed without throwing, not that a downstream UI workflow finished.
These are specific seams to address, not reasons to replace the command system.

## 3. Standardize the command contract

### 3.1 One command identity and one description

Keep existing command IDs stable, including historical mixed naming styles.
Renaming every command would break saved shortcuts and preferences without
helping this feature. New MCP tool names use one consistent prefix and snake
case; examples in this plan use `ac_`.

Every command has:

- A stable ID, human-facing title, concise description, category, and surface.
- A description that names the affected object, the effect, and whether more
  input follows. "Opens a picker to choose a destination provider for this
  agent" is more useful than "Switch provider."
- Short intent synonyms in `keywords`, such as "hide", "park", and "restore".
  Do not stuff long manuals or every possible synonym into the search index.
- Existing availability and state, evaluated against a real target/context.
- An explicit automation disposition and a reason when direct automation is
  unavailable. Hidden-in-palette is a preference, not an authorization rule.

The initial normalization pass covers the whole command catalog, including
helper-generated definitions. Coverage means each command has a truthful route;
it does not mean each command gets a dedicated tool.

### 3.2 Automation dispositions

Use a small discriminated contract, with final TypeScript names settled during
implementation:

| Disposition | Contract |
|---|---|
| `direct` | An explicit, parameterized operation exists, with a named MCP wrapper and validated input/output |
| `command` | The ordinary zero-argument command can be dispatched with a supported target; its result is observable |
| `ui` | Open an existing picker/modal or provide a concrete UI entry point; computer use completes the interaction |
| `unavailable` | Diagnostic-only, unsupported in this build, or otherwise deliberately unavailable; include a reason |

A direct command can also offer a UI entry point. The disposition describes the
preferred operator route, not the only route a human may use.

Keep static metadata next to the owning command/feature. Parameterized operation
definitions contain their schemas and execution behavior; command definitions
reference these definitions. Register MCP wrappers and generate descriptions
from them. Do not duplicate schemas and business logic in the server module.

Additional metadata should be limited to information consumers actually use:

- `targetKind`: app, window, tab, session, or another explicitly supported type.
- Operation/tool reference for `direct` commands.
- UI entry point and concise next-step guidance for UI routes.
- Observable effect: a state change, surface opening, or longer-running operation.
- Retry semantics: state-setting, read-only, or request-deduplicated mutation.

Do not attempt to serialize closures such as `when`, `getState`, or `run` to
main. The renderer resolves them and returns plain data. Actions without a
palette command, such as reading an agent's latest output, may have operation
definitions without inventing a fake command row.

Context-free catalog membership does not make the current catalog safe to
import into Node: its feature imports can reach renderer dependencies. Main
requests serializable catalog projections from the renderer, and imports only
shared schemas/types. Separate an operation's schema from its renderer executor
where the MCP server needs to register that schema before a window is ready.

### 3.3 Targeted operations and ordinary commands

Dedicated tools accept explicit `windowId`, `tabId`, and/or `sessionId` as
appropriate. The operation consumes that identity all the way to the mutation.
Do not focus a pane temporarily, call a focus-dependent action, and restore
focus: human clicks and async provider work can race with that sequence.

For selected common features, refactor the UI command into a thin adapter:
resolve the human's current target, then call the same targeted operation used
by MCP. Existing commands that cannot honor an explicit target remain `ui`
until that work is done. Mere catalog membership never implies MCP executability.

Use setting semantics for repeatable tools, for example
`ac_view_set({ sessionId, mode: "reader" })`, instead of blindly wrapping a
toggle. Keep established human command labels and shortcut behavior.

External invocations get a distinct source such as `external-mcp`. They must
not affect human recent-command rankings. Retain existing admission rules and
revalidate after awaits. Extend single-flight protection by operation and
target where needed so work on one agent does not serialize every other agent.

## 4. Discovery and the real command picker

### 4.1 Foundation tool contracts

Names and arguments are proposed API contracts, not existing exports.

| Tool | Main arguments | Result |
|---|---|---|
| `ac_help` | Optional topic | Short app vocabulary, operating loop, and links to deeper command descriptions |
| `ac_app_describe` | Overview or expanded section, cursor | What the app does, its UI structure, concepts, operating workflows, and a complete feature index |
| `ac_features_list` | Optional category/filter, cursor | Every shipped feature with summary, availability, and its description/UI/tool references |
| `ac_feature_describe` | `featureId`, optional live target | Purpose, behavior, how to use it, entry points, commands, shortcuts, direct tools, and relevant limitations |
| `ac_state` | Optional window/scope; bounded detail level | Instance identity, windows, tabs, agents, active surfaces, placement, readiness, and pending conditions |
| `ac_agents_search` | Query plus optional project/window/provider/activity/placement filters; cursor | Matching existing agents with stable IDs, locations, distinguishing evidence, and a direct show route |
| `ac_commands_list` | Optional category/surface/target, cursor | Complete command inventory, including hidden/unavailable commands and contextual command families |
| `ac_commands_search` | `query`, optional target/category, `limit`, cursor | Ranked command descriptions with availability, current state, shortcut, and recommended route |
| `ac_command_describe` | `commandId`, optional target | Full command contract, tool/schema reference, effects, prerequisites, and UI fallback |
| `ac_keybindings_list` | Optional command/context/query; effective/default/both view; cursor | All shortcuts, alternate chords, customization/unbound state, ownership, and contextual meaning |
| `ac_palette_open` | `windowId`, optional `query`, `commandId` | Acknowledged visible palette, query, selected command if present, and current target |
| `ac_command_run` | `commandId`, explicit target, `requestId` | Completion, opened surface, pending operation, blocked/unavailable, or failure |
| `ac_wait` | Event cursor or operation ID, scope, bounded timeout | Relevant changes, completion, input needed, timeout, or an expired-cursor indication |
| `ac_history_list` | Optional operator/session/tool/status/time filters; cursor | Complete chronological inventory of MCP calls and their current/final outcomes |
| `ac_history_read` | Call/operation ID or event range; summary/full detail; cursor | Recorded requests, arguments, targets, execution steps, exact retained results/errors, and payload references |
| `ac_history_payload_read` | Payload reference, offset/cursor, bounded limit | Full retained large request/result content in retrievable chunks |

Mutating tools, including palette open and the dedicated tools below, share a
client-supplied `requestId` contract even where omitted from the table for space.
Static discovery is available without an active project; unavailable renderer
state is explicit, not fabricated from a previous workspace file.

`ac_command_run` accepts no arbitrary JavaScript, IPC names, or unvalidated
argument dictionary. It is for descriptors that explicitly allow ordinary
command dispatch or opening a UI entry point. Parameterized operations use
their dedicated tools. Unsupported commands return their UI route.

### 4.2 Search behavior

Search should cover the catalog, not just rows currently visible in the picker.
Results distinguish contextual unavailability, user-hidden rows, debug gating,
and missing direct wrappers. A known command should explain why it cannot run.
If no window/target was supplied, return static discovery plus
`availability: unknown` where a live context is necessary.

Use the same text-matching rules for MCP and the picker:

1. Preserve exact/prefix/title relevance ahead of supporting prose.
2. Keep short aliases/keywords searchable.
3. Include the description as a bounded prose field using the existing `body`
   literal-match policy initially. Never run scattered-character fuzzy matching
   over paragraphs. Short curated keywords cover paraphrases and reordered intent.
4. Keep personal stars/history as same-tier UI tie-breakers. MCP ranking is
   deterministic, with stable ID tie-breaking and no changes to human history.
5. Return small pages and excerpts. Description/schema detail is on demand.

Do not add embeddings, an LLM search service, or an external index for a catalog
of this size. Revisit only if real operator searches expose a specific gap.

Search results should make the next step obvious. For example:

```json
{
  "commandId": "switch-provider",
  "title": "Switch Provider",
  "description": "Opens a destination picker for this agent and preserves conversation context during the switch.",
  "available": true,
  "route": "direct",
  "tool": "ac_agent_switch_provider",
  "ui": { "entryPoint": "ac_command_run", "commandId": "switch-provider" }
}
```

That example applies only once the wrapper is implemented; before then the
same command advertises `route: ui` and omits the tool reference.

### 4.3 Open-intent lifecycle

Add a transient palette open intent to UI-shell state containing a request ID,
query, optional selected command ID, and captured context. The visible picker
consumes it once and acknowledges the applied intent after mounting.

- Opening the picker is idempotent; a retry does not close an already-open one.
- Select by command ID, never by a row number that ranking can change.
- A command-specific open can reveal a user-hidden matching row temporarily,
  without changing the user's visibility preferences. Mark it as contextual.
- An unavailable requested row stays explanatory and cannot be executed.
- The tool does not press Enter or submit a highlighted item automatically.
- After the intent is applied, stop synchronizing it into local query state;
  otherwise the operator's or user's typing would be repeatedly overwritten.
- With both `query` and `commandId`, use the query for filtering and select the
  ID only if it is in those results; report a selection miss instead of choosing
  an unrelated first result. With only an ID, reveal that command directly.
- With neither argument, open ordinary command mode with an empty query.
- Initially expose ordinary command mode. Commands can open the existing resume,
  templates, and buried-session subflows; do not automate their internal forms.
- If an unrelated modal owns app interaction, return `blocked` with the surface
  identity. Do not dismiss it, replace its input, or route typing behind it.
- Repeated UI clicks may change the target. Include the current target in later
  observations and require explicit IDs for later direct operations.

The existing palette purposely avoids a heavyweight workspace subscription
while closed. Extract a reusable, lazily evaluated command-context adapter or
use a bounded request host mounted on demand. Do not keep the whole picker
mounted merely to service MCP search or background observations.

### 4.4 Complete command and keybinding reference

Searching is not the only way to retrieve the catalog. `ac_commands_list` must
allow the operator to enumerate everything without guessing search terms.
Default enumeration includes user-hidden commands and unavailable/debug-gated
commands with their actual status. Filtering to runnable or visible commands is
an explicit option. Each row links to its full description, owning feature,
effective shortcuts, direct tool if implemented, and UI route.

Generated provider commands belong in the complete list. Contextual families,
such as `A2` / `A2!` agent navigation, expose their grammar and the live target
list through the appropriate inventory. Do not pretend an infinite family of
search-generated IDs is a finite static catalog, or silently omit that feature.

`ac_keybindings_list` returns every binding, not just the primary shortcut that
the current palette row displays. Its records include:

- Stable command/interaction ID and a description of what the binding does.
- All normalized chords and platform-appropriate display labels.
- Shipped defaults, effective bindings, and whether the user customized them.
- Explicitly unbound state: an empty override is different from inheriting
  defaults. Also include commands with no assigned chord when listing commands.
- Context: Grid, Dispatch, editor, composer, picker/modal, global, or native.
- Conditions that change meaning or availability, plus known precedence,
  reservations, and conflicts where the app can establish them.
- Owner/source: customizable command, fixed app interaction, native menu role,
  embedded editor, or forwarded provider/terminal input.

Use `resolveEffectiveKeybindings` with the same context resolver as the runtime
router; join it to command descriptions and the shipped default table. Preserve
all alternate bindings and unresolved saved overrides with an explanatory status.
Do not invent a second implementation of override resolution.

The customizable-command table is not the whole keyboard surface. Inventory the
fixed interactions in `reservations.ts`, `useKeybinds.ts`, palette/modal handlers,
composer handlers, editor integration, native menu accelerators, and dictation
hotkeys. Include configured mouse chords in the interaction reference with their
input type distinguished. Reuse existing declarations; add concise descriptors
beside owning handlers where none exist. Reservations alone are neither a full
interaction inventory nor proof that the current runtime consumes a chord.

For embedded-editor bindings, use the loaded editor's registered actions/keymap
where available. For terminal/provider input, distinguish the app's forwarding
behavior from the downstream program's version-dependent keymap. Describe known
native interaction routes and report unknown external mappings honestly rather
than claiming to enumerate arbitrary shell programs or user-installed plugins.

Full listings are cursor-paginated and carry catalog/settings revisions so every
page can be retrieved and a changed snapshot can be detected. Return total count,
next cursor, and whether the page is complete; never present a top-N sample as
"all commands" or "all shortcuts." Opening Settings and changing a shortcut
must be reflected by the next MCP observation without restarting the app.

### 4.5 The app and every feature explained through MCP

`ac_app_describe` provides a short orientation plus access to an expanded guide:
what Agent Code is for, what runs locally, how providers fit in, the window/tab/
agent model, major screen regions, Grid versus Dispatch, agent view versus raw
terminal, and the discover-act-observe workflow. The guide links to a complete
feature index rather than burying every feature in one large initialization
prompt. The complete guide remains retrievable section by section through MCP.

Every feature description answers:

1. What is it, what problem does it solve, and when would the user use it?
2. Where is it in the UI, and how can the operator open or reveal it?
3. What does it operate on, and what state or provider prerequisites apply?
4. Which commands, keybindings, settings, and MCP tools are associated with it?
5. What is a representative workflow, including any computer-use continuation?
6. What outcome is visible, and which important limitations or lifecycle effects
   must the operator understand?

The release inventory must cover these areas, expanding to individual features
within them rather than declaring a whole subsystem documented by its name:

- Windows, project tabs, tiled tabs, pane labels, focus/navigation, and layout.
- Dispatch/global Dispatch, rows/lanes, project scoping, pins, and color flags.
- Agent creation, naming, relationships, lifecycle, detach/bury/revive, recovery.
- Providers/runtime choices, model/native configuration routes, switching,
  compaction, duplicate/resume, rewind, and undo behavior.
- Composer, prompt queue/suggestions, images, history, templates, quoting, and
  copying responses/code blocks.
- Conversation rendering, tools/results, Reader, Spotlight, auto-follow,
  previews, and raw agent-terminal view.
- Persistent terminals and how their behavior differs from agent sessions.
- File explorer, global editor, search, buffers, save/conflict behavior, LSP,
  and curated AI Workspaces.
- Built-in MCP domains, agent orchestration/management, and existing workflows.
- Conventions, custom/installed skills, provider deployment, and settings.
- Appearance/themes, command visibility, shortcuts, and input customization.
- Dictation, its controls/history, and relevant setup.
- Git/worktrees, activity/status, usage, performance, and caffeinate.
- Remote access/pairing, setup, toolchain/provider updates, and diagnostics.
- External control itself, connection state, hybrid operation, and revocation.

Maintain feature descriptions as feature-owned data adjacent to implementation.
An assembled feature catalog references command, settings, surface, and tool IDs;
generate the mechanical lists and live status from those sources. The explanation
of purpose/workflows is authored and reviewed, not guessed from filenames.

Use the inspected repository layout, surface registry, settings registry, and
command owners to establish the initial complete inventory. Features without
commands still need entries. A feature folder is evidence to inspect, not an
automatic one-to-one definition of a product feature. Subsequent feature changes
update their descriptors in the same diff; coverage checks catch missing/broken
references, and review checks whether the explanation remains true.

The operator must be able to ask "what else can this app do?" and get a complete
index, including opt-in/experimental features with accurate status. An unwrapped
feature must still be discoverable and explained, with a UI route.

## 5. Broad direct coverage for common and difficult operations

These priorities are a proposed product shortlist, not measured usage data.
The first operator trial should validate them. Implement the listed broad
families; do not require usage telemetry before addressing obviously difficult
navigation, targeting, or multi-step control. Use trials to refine priority and
fill omissions, not to narrow this into a handful of convenience tools.

### Navigation is a core product capability

Support intentions such as:

- "Go to the Codex agent fixing terminal rendering."
- "Show the agent waiting for approval in the other project."
- "Open A2 here without creating another agent."
- "Bring back the agent I buried yesterday."
- "Show that agent next to this one, then open its last response."

`ac_agents_search` searches existing workspace metadata across all windows,
project tabs, Grid, Dispatch, linked children, and buried records. Search fields
include title, project/cwd, provider, pane label, relationship, and optionally
bounded recent user-prompt/assistant excerpts. Return the matched evidence and
its freshness. Archived native-provider sessions belong to an explicit history
search, not silently in the same list as app-owned open agents.

Each agent record has one stable session ID and zero or more visible placements.
The same session in two Dispatch lanes is one agent with two views. Duplicate
titles or positional labels produce candidates, not an implicit "best" target
for mutation. Labels such as A2 are navigation hints resolved against an
observation; once selected, all following operations use the stable ID.

`ac_agent_show({ sessionId, destination?, restore? })` is a complete navigation
operation, not a focus flag. It locates the owner window, selects the appropriate
project/tab, reveals the related-child view or Dispatch lane, and brings the
agent into view. Prefer an existing visible slot unless the caller explicitly
asks to show the session in another named lane/anchor. Reuse the existing
`navigateToAgentIndexTarget` policy rather than inventing conflicting precedence.

Return the actual destination, any mode/scope change, and whether a hibernated
backend was woken. Navigation must not create a duplicate session. A buried
record requires explicit restore intent and then follows the existing revive
path. Searching, locating, and reading remain non-waking; the UI's existing
wake-on-show behavior is a distinct documented operation.

Generalize the navigation implementation to accept stable IDs. Do not route
the tool through a positional label and hope the label still names the same
agent after a tab reorder or an awaited wake. Test all seven existing navigation
result kinds, related-child reveal, cross-window routing, and buried revival.

### Tier A: first useful release

| Tool | Required behavior | Existing owner |
|---|---|---|
| `ac_project_open` | Open a directory in a specified window; return tab/session IDs; make new-tab versus reuse intent explicit | Workspace tab actions and path resolution |
| `ac_projects_list` | Return open project tabs across windows with stable ownership and counts | Live workspace projections |
| `ac_target_focus` | Focus a named window/tab; agent navigation uses the complete show operation | Window registry and workspace focus actions |
| `ac_agent_locate` | Resolve an existing session to its window, tab, parent, and visible/hidden placements without waking it | Workspace inventory and pane labels |
| `ac_agent_show` | Reveal an existing agent across modes/windows, with explicit destination/restore intent | Mode-aware agent-index navigation and revive actions |
| `ac_agent_create` | Provider/runtime, project tab, title, and placement; return IDs and current readiness | Pane/session actions and provider choice registry |
| `ac_agent_prompt` | Submit text and optional supported attachments to an explicit agent; return delivery disposition | Wake/readiness and provider prompt-delivery paths |
| `ac_agent_read` | Default conversation view: user prompts and all user-visible assistant messages; explicit depth/range/cursors; no wake merely to inspect | Existing transcript readers and renderer projections |
| `ac_agent_interrupt` | Interrupt the named backend lifetime; report observation rather than claim instantaneous cancellation | SessionManager/provider control |
| `ac_agent_title_set` | Set a title directly and reflect it in the UI | Agent-title workspace operations |
| `ac_view_set` | Explicit supported workspace/session modes and auto-follow state; unsupported combinations explain themselves | Dispatch, Reader, Spotlight, and view-mode actions |
| `ac_agent_pin_set` | Set pinned state without a toggle race | Dispatch actions |
| `ac_agent_placement_set` | Detach, attach to a named grid anchor, bury, or revive without losing session identity | Pane and Dispatch actions |

Creation placement uses a small typed set: new project tab where applicable,
detached Dispatch, or a split relative to a named existing pane. Support a
direction and ratio where the existing action supports it. Do not invent a
declarative whole-workspace replacement language for the first release.

Prompt submission must not overwrite an unrelated draft. The default sends the
provided message through the explicit provider delivery path and leaves the
existing draft intact; any send-current-draft mode must capture and validate its
version. Readiness and acceptance are different outcomes. Preserve provider
semantics for busy/queued delivery rather than promising universal queue control.

### Tier B: difficult control paths and session lifecycle

| Tool/family | Scope and constraints |
|---|---|
| `ac_agent_switch_provider` | Source ID plus explicit provider/runtime destination; reuse capacity planning, compaction decisions, and replacement transaction; return identity remapping |
| `ac_agent_resume` / `ac_agent_duplicate` | Explicit native session or app session identity; clear placement and recovery semantics |
| `ac_layout_adjust` | Split/resize/normalize/rotate against explicit anchors or tabs, with per-action schemas |
| `ac_dispatch_configure` | Set project/global scope, row/lane structure, project assignments, and selected agents using existing layout invariants; these multi-step navigation tasks deserve direct coverage |
| `ac_tabs_reorder` / `ac_window_create` | Reorder explicit tab IDs and create a new app window; preserve session ownership |
| `ac_condition_reply` | Respond to an observed condition and one of its advertised options; verify condition and backend identity immediately before acting |
| `ac_agent_close` | Reuse exact affected-target expansion and existing close policy; expose any required decision rather than bypassing it |
| `ac_terminal_create` / `ac_terminal_read` / `ac_terminal_input` | Create/place terminals, read bounded output, and send explicit input to a named session; preserve PTY behavior and never equate byte delivery with shell-command completion |
| `ac_editor_open` / `ac_editor_locate` | Find and reveal a file/location or open buffer in the correct editor/project; preserve dirty buffers and expose their state |
| `ac_history_search` / `ac_agent_rewind` | Find relevant sessions/prompts and rewind to an exact returned prompt address through existing transaction/confirmation semantics |
| `ac_agent_draft_get` / `ac_agent_draft_set` | Inspect/update a named composer's draft with version checks and existing clear/undo semantics |

### Tier C: operations that otherwise require repeated panel navigation

| Tool/family | Scope and constraints |
|---|---|
| `ac_agents_read` / `ac_agents_prompt` | Reads share the single-agent depth/range contract and independent cursors; explicit per-agent messages return per-target outcomes and correlate partial success so retries do not repeat delivered messages |
| `ac_prompt_templates_list` / `ac_prompt_template_apply` | Discover saved templates, fill known variables, and explicitly choose draft insertion or send; missing variables remain actionable |
| `ac_settings_search` / `ac_setting_set` | Find descriptions/current values and set supported ordinary values from existing schemas; commands with side effects use their real operation, not a raw store patch |
| `ac_workflows_list` / `ac_workflow_run` / `ac_workflow_read` | Run and inspect existing workflows from an external operator; reuse WorkflowService while giving runs explicit external ownership instead of inventing an internal parent session |
| `ac_usage_get` / `ac_worktrees_list` | Read provider usage and known worktree/status evidence without opening and interpreting multiple panels |
| `ac_surface_open` | Reveal named Settings sections, workflow details, transcript views, Git/worktree panels, or other supported surfaces with explicit context |

All three tiers are planned delivery scope, split into reviewed increments.
They represent dozens of supported operations; exact tool grouping should follow
schema clarity, not a desired small tool count. A discriminated domain tool can
group closely related actions, but avoid one untyped `do_anything` tool.
Discovery returns the actual supported route at every stage, so a temporarily
unimplemented wrapper has a UI route until its increment lands.

### Deliberate UI coverage

Use computer interaction for visual theme tuning, rich text/code editing,
keybinding capture, skill-source review, prompt-template/workflow authoring,
unusual provider dialogs, OS authentication/permission sheets, remote pairing,
and visual inspection of diagnostics. MCP should still locate/open those
surfaces and provide structured information where that removes navigation work.

Bulk destructive cleanup can start with a structured inventory/read/selection
and continue through the existing review UI. Routine targeted close remains a
direct operation with the existing policy. Do not add direct credential-entry
tools just to eliminate an occasional setup interaction.

Non-command surfaces get a short topic guide and a concrete opening command or
visible navigation description. The guide is bounded and maintained with the
feature; it is not a hand-maintained element-by-element copy of the interface.

Adding another direct wrapper requires a recurring or UI-difficult operator
task, typed arguments, explicit targeting, shared implementation, observable
results, and a behavioral check. There is no target tool count. The criterion
is practical capability, not maximizing tools or minimizing tools.

## 6. Observation, results, and computer-use handoff

### State and identities

The initial snapshot includes:

- App instance/build and protocol version; renderer generation per window.
- Window IDs, titles, focus, project tabs, active modes, and visible surfaces.
- Agent IDs, provider-native IDs where useful, provider/runtime, title, cwd,
  owning tab/window, placement, parent links, and pinned/buried state.
- Backend generation/lifetime, activity, input readiness, pending conditions,
  and concise latest-output summaries on request.
- Palette visibility, mode/query and selected command when visible, plus
  modal ownership relevant to the next interaction.

Use live renderer snapshots for layout and main-owned evidence for backends.
Never infer current state from the debounced workspace file. Distinguish stale,
unknown, unavailable, hibernated, waiting for input, and active states. Inspecting
a parked agent must not spawn it or steal focus.

Snapshots are bounded observations, not globally atomic transactions. Include
per-window revisions/observation times. Validate entity generations and the
relevant state again at mutation time. Do not invalidate every action simply
because an unrelated agent streamed another token.

### Lightweight agent reads with selectable depth

`ac_agent_read` and `ac_agents_read` share one contract. Detail depth controls
which kinds of content are included; history range and pagination independently
control how much is returned. Do not use "depth" to conflate a shorter history
with a more detailed transcript.

| Depth | Included by default | Intended use |
|---|---|---|
| `status` | Identity, activity/readiness, pending input, last activity, whether new output exists | Cheap fleet monitoring |
| `conversation` (default) | User prompts and every user-visible assistant message in the selected range, in order | Read what the user asked and what the agent said |
| `activity` | Conversation plus compact tool/action records, targets, completion/exit status, and bounded result excerpts | Understand what work produced an answer |
| `full` | Available conversation and tool-call/result detail with references to full retained payloads and provider records | Investigate a specific action or inspect the full available execution record |

The default is not a generated summary, only the final assistant response, or a
dump of provider event JSON. Include assistant progress/commentary/preambles as
well as the final response, preserving their text and order. Filter out tool
calls, tool results, synthetic protocol carriers, system bookkeeping, and
provider-internal events unless the requested depth includes them. Role labels
alone are insufficient: some providers place tool-result blocks in user-shaped
records. Those are not user prompts.

Range options should include `session` (default), `current_exchange`, `latest`,
an explicit message/turn boundary, and incremental reads after a cursor. A
session-range read exposes the whole conversation through pagination rather
than silently restricting it to the latest answer. `current_exchange` means the
latest accepted user prompt and every subsequent assistant message; queued but
unaccepted prompts remain separately identified. `latest` supports a cheap
explicit tail when that is what the caller wants.

Use conservative defaults, initially a page budget such as 24,000 characters
and 50 messages, tuned by actual trials. These are transport budgets, not a
license to discard content. Include `hasMore`, continuation cursors, range/
snapshot boundaries, and truncation detail. A single message that exceeds a
page budget needs a message-content continuation, not an irrecoverable clipped
string. Attachments are small typed references by default; do not dump base64.

An active agent can be read before its transcript file catches up. Include the
current visible assistant text with `partial: true` and an explicit live source,
then reconcile it with committed history using existing ownership/identity
rules. Do not show both copies or pretend a partial reply is final. Readers use
structured state/transcripts and do not require the pane to be rendered or
focused. Reading never wakes a parked backend.

Each result includes stable message IDs, role, available timestamps, completion
state, source/availability, and a transcript revision/cursor. Incremental reads
return appended messages plus revisions to a previously partial message, with
upsert semantics so the operator can replace that message instead of appending
a duplicate. Compaction, rewind, or provider replacement can invalidate an old
cursor: report a reset/remapping boundary instead of silently skipping content.

For multi-agent reads, apply the requested depth consistently and return each
agent's status, cursor, and completeness separately. Enforce a total response
budget fairly; one verbose agent must not make other agents look empty. Report
deferred agents and how to continue. Do not silently downgrade conversation
reads to status-only summaries without identifying the omitted content.

Reuse `AgentTranscriptReader`, existing conversation projections, and the live
renderer/feed ownership rules where their contracts fit. The current file-reader
implementation detects Claude/Codex files; it is not proof of OpenCode support.
Use OpenCode's supported history API through its adapter rather than forcing it
through a JSONL reader. Mark unavailable provider detail as unavailable.

The read path must be lightweight in actual work, not just in response size:
avoid serializing complete runtimes, repeatedly parsing the entire history for
a tail/delta, waking agents, mounting the feed, or invoking a model to summarize.
Use bounded projections, per-session cursors/indexes, and lazy payload retrieval.
Keep summary/status views cheap; full inspection is an explicit request.

### Result vocabulary

Use a shared discriminated result envelope with `requestId`, `instanceId`,
resolved target, and observation metadata. Define variants rather than one bag
of optional fields:

- `completed`: an operation-specific result and the observed effect.
- `ui_opened`: visible surface/window, captured target, and next interaction.
- `pending`: operation ID and a wait/read path; no claim of completion yet.
- `blocked`: condition/modal/required decision with a concrete next step.
- `unavailable`: unsupported provider, mode, capability, or missing target.
- `failed`: structured failure with whether anything changed.
- `outcome_unknown`: dispatched, but completion cannot be established; do not
  automatically retry a create or prompt submission.

The bridge must not blindly translate existing `ran` into `completed` for a
picker-opening or fire-and-forget command. Add effect observation for classified
commands and return uncertainty when acknowledgement is lost.

Deduplicate mutations by operator client plus request ID and argument digest.
Reject reuse of an ID with different arguments. Bound retention and report its
scope: in-process deduplication does not prove exactly-once effects across an
app crash. On reconnect, compare instance/generation and reconcile before retry.

### Hybrid operating loop

1. Read a compact state snapshot.
2. Search by intention if the route is unknown.
3. Use the advertised direct tool, or open the command/picker UI.
4. For a UI handoff, the operator takes a fresh screenshot and clicks/types using
   its existing computer-use tools. It does not reuse coordinates from old state.
5. Read state or wait for the relevant change to verify the result.

Do not add screenshot capture or screen-coordinate mapping to this MCP solely
to duplicate the operator's existing tools. Return window/surface identities
and clear UI guidance. Add visual metadata only if actual trials show it helps.

Event waits should be bounded and cancellable, with explicit timeout and cursor
expiry. Aggregate meaningful changes such as ready, question appeared, exited,
output advanced, and operation completed; do not stream every provider token
into the operator context. Return partial renderer failures without blocking
inspection of healthy windows.

### Complete MCP operation history

Operation history is a product capability with its own durable store, separate
from agent conversation history and lightweight incident diagnostics. It answers
"what did the operator do through MCP?" without guessing from the current UI or
the final conversation transcript.

Record every authenticated tool invocation, including searches/reads, UI-open
requests, mutations, blocked/failed calls, and deduplicated retries. Each call
has an ordered lifecycle: received/validated, dispatched where applicable,
progress or child steps, and final or uncertain outcome. A refused request must
not look as though its action executed.

Records include:

- Call ID, client request ID, operation ID where applicable, operator identity,
  tool/command name, timestamps, app instance, and relevant target generations.
- Validated arguments, including actual submitted prompt text and resolved
  target IDs, plus explicit annotations for redacted credential fields.
- Execution steps and concrete effects such as created IDs, placement changes,
  provider replacements, and per-target batch outcomes.
- The actual returned result or error. Large text/structured payloads live in
  immutable local artifacts with references, sizes, and digests; summaries in
  the index are navigation aids, not substitutes for retained full content.
- Whether a retry reused an earlier operation/result, anything remains pending,
  and whether the outcome is unknown after a timeout or crash.

Persist an intent record before dispatching a mutation and append outcome
records as evidence arrives. Preserve late acknowledgements. A crash between
dispatch and completion leaves an unresolved operation to reconcile; logging
alone does not provide exactly-once execution. A restarted app and reconnected
operator can read the existing history without rerunning any recorded calls.

`ac_history_list` enumerates the full retained call history with filters and
stable cursors. `ac_history_read` exposes an exact call or ordered event range
at summary/full detail. `ac_history_payload_read` retrieves large request/result
payloads in chunks so the whole retained log remains accessible over MCP, not
only through a local path. Captured results describe what was returned at that
time; never reconstruct an old result from the agent's newer current state.

History reads themselves get a call record. Freeze their read boundary before
servicing the call, and store returned history entries as references to immutable
event IDs/payloads rather than recursively embedding the log into itself. This
keeps the recorded response reconstructable without exponential duplication.

The full history includes normal non-credential arguments/results by default
while control MCP is enabled, including prompt text sent through its tools. Keep
it local and private to the application user. Never persist transport tokens,
authorization headers, or declared credential fields; mark those omissions.
An attachment reference or a redacted field must not be described as preserved
byte-for-byte content. Do not copy these full payloads into ordinary crash logs.

History survives renderer reloads, reconnects, app restarts, and agent closure.
Retention and storage limits are explicit settings with visible retained ranges
and missing/pruned-payload markers. Do not silently prune data and keep calling
the result a full log. Initially retain records/payloads until explicit cleanup
or a configured retention policy applies. Register storage with the app's storage
management and make exports/cleanup possible through the appropriate UI route.
If durable recording cannot be established, refuse a new mutation before dispatch
rather than execute it without the promised record. Read-only recovery tools
remain available with an explicit history-recording-unavailable indication.

MCP history does not claim to capture every computer-use click. Record an
MCP-initiated UI opening and any reliably correlated resulting state change;
unattributed mouse interaction is not fabricated as a tool invocation. The app
snapshot remains the authority for where the hybrid workflow is now.

## 7. External server lifecycle and isolation

Use a separate external-control HTTP host in Electron main. Reuse the SDK and
extract small transport helpers if needed; do not add `external_control` to
`defaultBuiltInMcpDomains` or impersonate a parent agent session.

- Disabled initially. A Settings surface enables it and shows connection status,
  the local endpoint, connected operator clients, and disable/revoke controls.
- Bind to loopback and authenticate operator connections with separate tokens.
  Configure a stable local endpoint; report port conflicts without attaching to
  an arbitrary existing server. Include app identity in the initial observation.
- Main owns startup/shutdown. Renderer reloads re-register their generation;
  stale in-flight replies cannot complete requests against a replacement window.
- Disabling immediately rejects new mutations and revokes access. Document how
  already-dispatched operations settle; stopping transport cannot undo them.
- Keep secrets out of tool results, command descriptions, process arguments,
  broad environment inheritance, and normal diagnostics. Setup can present a
  credential through its dedicated user-facing connection flow.
- Record concise operation identity, target, and disposition in existing local
  diagnostics. The separate product history retains full non-credential request/
  result payloads as specified above; normal diagnostics reference its IDs.

Codex supports local Streamable HTTP MCP with bearer authentication. Its clients
share MCP configuration, so a globally enabled server may also be discovered by
the Codex CLI launched inside Agent Code. Use a stable reserved server identity,
operator-specific enablement, and explicit launch overrides/exclusion for
internal sessions, including resumed/recovered sessions and workflow workers.
Preserve the user's other MCP servers and native authentication.

The exact exclusion mechanism must be verified against each supported provider
before shipping. Test it in disposable configuration roots rather than editing
the developer's live account configuration. Hiding a tool in descriptions is
not exclusion. These measures prevent default exposure; they are not an OS
security boundary against arbitrary code executing as the same user.

Connection reference checked during investigation:
[OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
Recheck supported configuration details when implementing the installation flow.

## 8. File ownership and proposed additions

Use the existing app repository, not a new submodule. A small internal control
SDK supplies capability registration and invocation. Features expose handlers
beside their domain code, reusing the same operations as the UI; MCP discovers
and calls them through the SDK. Ordinary UI execution remains independent of
the control host. "Public SDK" means supported internal imports, not publication
or a mandatory new application-wide API.

```text
src/control-sdk/
  contracts/               Typed capability definitions, inputs/results, targets
  registration/            Registration lifecycle and supported feature API
  client/                  Typed invocation contract
  core/                    Registry, execution, private target reconciliation
  ports/                   Injected transport/storage/observation requirements
  catalog/                 Description and reference queries
  history/                 Durable invocation semantics
  reads/                   Canonical depth/range/live-history projections

src/main/control/
  createControlHost.ts      Composition and feature installation
  rendererBridge.ts         Window routing, correlation, generation checks
  adapters/                 Main infrastructure such as window/storage ports

src/preload/api/control.ts Typed renderer requests, responses, and registration

src/renderer/src/control/
  registerRendererHost.ts   Window registration and teardown composition

src/main/<domain>/control.ts
src/renderer/src/features/<feature>/control.ts
  Feature-owned descriptors/handlers; workspace registrations beside its actions

src/main/externalControlMcp/
  host.ts                  Independent opt-in authenticated MCP lifecycle
  tools.ts                 Tool mappings and protocol serialization only
  connectionSettings.ts    External connection setup and revocation

src/renderer/src/features/command-palette/
  Existing catalog, types, ranker, dispatcher, and UI updated incrementally

src/renderer/src/workspace/hook/actions/
  Existing mutations accept explicit targets where selected wrappers require it
```

These filenames describe ownership, not a requirement for a class per concept.
Keep small pieces together until real complexity warrants splitting them. Keep
operation definitions with their owning feature. Feature registrations import
only the supported SDK contract and their domain dependencies. MCP cannot import
feature handlers, stores, or SDK internals; normal UI does not need to invoke the
SDK. Enforce these boundaries with resolved-import checks. Node-only transport
imports never enter renderer code; update aliases only if necessary.

## 9. Implementation sequence and review checkpoints

The phases below group product coverage and their exit scenarios. They are not
the dependency order: follow Stages 0–10 in the decomposition, which establishes
registration, routing, history, and real feature capabilities before attaching
the MCP adapter. The earlier phase grouping is retained to track all agreed
scope, not to require a host before its substrate or a rewrite of normal UI.

### Phase 0 — record scope and create the coverage map

- Create/link the feature Issue and synchronize this plan with its acceptance
  criteria before implementation.
- Enumerate actual catalog exports, settings entry points, and relevant surfaces.
- Inventory all keyboard/mouse interaction owners and shipped features, including
  fixed shortcuts and features without palette commands.
- Assign every command a proposed route and mark the Tier A/B wrappers.
- Record representative user intentions for search and a small operator script.
- Decide the minimal protocol and reserved external server identity.
- Specify history event/payload storage and the shared agent-read depth/range
  contract before adding tools, so observability is not retrofitted later.

Exit: a reviewable command coverage map where UI routes count as supported.

### Phase 1 — shared metadata and description search

- Extend command descriptors and add serializable projections.
- Normalize descriptions and keywords, including generated command families.
- Add description matching to the shared command-search policy.
- Build complete command/keybinding listings from real defaults, customizations,
  fixed-interaction descriptors, and runtime context.
- Author the app overview and feature-owned descriptions, with a complete feature
  index and shared command/shortcut/settings/UI references.
- Preserve browse order, visibility preferences, state badges, and relevance
  ahead of stars/history.
- Classify commands without running their handlers or mounting the full UI.

Exit: the user can find commands by their descriptions; the same catalogs can
list all commands and shortcuts and explain the whole app and every shipped
feature without duplicating runtime definitions.

### Phase 2 — connect and hand off to the picker

- Implement independent host settings, authentication, renderer registration,
  compact observations, and discovery tools.
- Implement durable MCP history and its list/read/payload tools with the host;
  even the first picker/search trial must have retrievable call outcomes.
- Expose the full command list, complete keybinding reference, app overview,
  feature index, and detailed feature descriptions through the MCP tools.
- Add one-shot palette open intents, explicit window routing, and acknowledgements.
- Implement `ac_command_run` only for classified supported routes, with fresh
  admission, interaction ownership, and truthful effects.
- Ensure startup with the server disabled installs no provider config and no
  unnecessary full-state subscriptions.
- Verify internal-agent exclusion before enabling a developer operator trial.
- Include existing-agent search, locate, and mode-aware show so the first trial
  can reach an open agent without manually searching every project and pane.

Exit: Codex searches for an unfamiliar command, opens its picker in the correct
window, finishes the interaction by clicking, and verifies the resulting state.
It can also find and reveal an existing agent across windows and layout modes.
This is an intermediate milestone, not the completed product.

### Phase 3 — Tier A direct operations

- Extract and expose explicitly targeted project, agent, prompt, focus, view,
  pin, and placement operations in small vertical slices.
- Add operation/result correlation, deduplication, bounded agent reads, and waits.
- Make conversation depth the default, including all user-visible assistant
  messages; add status/activity/full modes, paginated session reads, current-
  exchange/tail ranges, incremental updates, and large-message continuations.
- Preserve draft ownership, wake semantics, and provider-specific delivery outcomes.
- Run the "open project, create agents, prompt, monitor, focus" scenario.

Exit: the frequent operating loop works without repetitive picker navigation,
and the real UI shows the same changes made through MCP.

### Phase 4 — Tier B control and lifecycle

- Add continuation, provider, condition, close, terminal IO, editor navigation,
  history/rewind, drafts, and explicit Dispatch/grid configuration.
- Validate navigation by identity across all placement types rather than only
  the currently visible pane. Preserve existing-view and shared-session semantics.
- Use actual operator friction to improve descriptions, direct operations, and
  UI handoffs. Do not treat a hard control path as UI-only merely to avoid it.
- Keep unsupported long-tail operations explicitly routed through the UI.
- Exercise at least two windows, Grid and Dispatch, multiple projects, and
  provider/runtime capability differences.

Exit: the most difficult layout and session-control tasks have structured paths.

### Phase 5 — Tier C breadth and hybrid trials

- Add bounded multi-agent operations, templates, settings discovery/ordinary
  values, existing-workflow execution, usage/worktree evidence, and surface open.
- Adapt existing services rather than register duplicate implementations of
  current MCP tools; external scope and ownership must be explicit.
- Exercise workflows with several MCP steps, several computer-use steps, and
  another MCP observation/action after the UI has changed.

Exit: the agreed broad operational surface is supported. Computer use handles
the remaining interactions rather than carrying the app's navigation burden.

### Phase 6 — packaging and durable maintenance

- Verify the packaged app can enable, disable, reconnect, and revoke the server.
- Verify history survives restart/agent closure, full payloads remain retrievable,
  and any storage/retention gap is explicit. Verify live/incremental reads stay
  bounded under long sessions and multi-agent activity.
- Provide a concise setup/help flow for the external operator. Installation must
  not silently enable the server in internal agents.
- Add contract checks for new command classifications, schema/tool-reference
  validity, stale UI routes, complete shortcut projections, and feature-reference
  coverage. Keep tests behavioral rather than asserting an arbitrary tool count.
- Run the relevant unit/system/renderer checks, typecheck, and package validation.
- Update Issue/PR verification and this plan's status; merge only on explicit approval.

## 10. Verification scenarios

No runtime checks are executed for this document-only planning change. The
implementation should colocate meaningful Vitest coverage with its owners.

1. **Description discovery:** an intention found only in a command description
   returns that command; exact title matches still outrank prose matches.
2. **Honest availability:** a hidden, unsupported, or wrong-mode command explains
   its state; search does not execute it or wake an agent.
3. **Picker handoff:** open with a query/ID, acknowledge the correct selection,
   click it through computer use, and observe the effect. Reopening/retrying
   never submits the row or overwrites later human typing.
4. **Multi-window targeting:** focus changes between request and commit do not
   redirect an agent prompt, creation, provider switch, or UI opening.
5. **Modal ownership:** an unrelated confirmation blocks UI takeover and typing;
   the response identifies the actual blocking surface.
6. **Common workflow:** create two differently configured agents in a chosen
   project, title them, submit distinct tasks, read outputs, and focus one.
7. **Prompt retries:** duplicate request IDs cannot send a second prompt; lost
   acknowledgements report uncertainty rather than invite blind retries.
8. **Lifecycle races:** a close, provider replacement, renderer reload, or window
   handoff during an operation cannot apply a stale response to a new lifetime.
9. **Provider questions:** a stale condition reply is rejected; unsupported
   provider question shapes provide a UI route instead of guessed keystrokes.
10. **Preserved local state:** sending explicit text keeps an unrelated draft;
    opening a file preserves unsaved buffers; reads do not wake parked agents.
11. **Mixed modality:** after the operator changes layout or provider by clicking,
    its next MCP observation reflects the change and identifies any replacement.
12. **Isolation and packaging:** disabled means no listener; invalid/revoked
    credentials fail; internal launches cannot discover the reserved external
    server by default; packaged reconnect does not require an extra Node process.
13. **Cost while idle:** the closed palette stays lazily mounted and the control
    observer does not rebuild the full command context on every semantic delta.
14. **Existing controls:** keyboard, native menu, palette, and direct tools retain
    their shared admission and mutation contracts; external calls do not change
    human command history.
15. **Find an already-open agent:** query by a task excerpt/title across multiple
    projects/windows, disambiguate repeated names, and reveal the chosen ID.
    Reordered A2 labels cannot redirect the operation during a wake.
16. **Reveal every placement:** show an agent in an existing tiled-tab slot,
    classic Dispatch, an existing/mirrored lane, a related-child view, a detached
    record, and an explicitly restored buried record. Never duplicate a backend.
17. **Directed arrangement:** place known agents into named lanes/anchors and
    adjust row/project scope without losing agents outside the selected targets.
18. **Batch partial success:** one failed prompt in a named batch reports its own
    disposition; retrying unresolved targets cannot resend accepted messages.
19. **Long-output navigation:** search history, select an exact prompt/response,
    read a bounded excerpt, and open the matching UI view without losing context.
20. **Operational breadth:** discover/apply a saved template, change a supported
    ordinary setting, inspect usage/worktrees, and run/read an existing workflow
    through the appropriate external ownership path.
21. **Complete command enumeration:** paginate through all static/generated
    commands, including hidden/unavailable rows; contextual families describe
    their grammar and link to live targets. No page silently omits the remainder.
22. **Actual shortcuts:** customize a command, add a second chord, explicitly
    unbind another, and verify the MCP output matches the runtime. Include fixed,
    editor/native, composer/modal, and mouse interactions with correct ownership.
23. **Complete app guide:** enumerate the feature index and retrieve explanations
    for command-backed and UI-only features, including disabled/experimental
    ones. Every description has valid entry points and truthful capability status.
24. **Reference stays current:** after settings, focus, provider capabilities, or
    catalog revision changes, subsequent observations identify the new revision
    and update shortcuts/availability rather than serving a misleading cached list.
25. **Default conversation read:** a session with multiple user prompts, assistant
    progress messages, a final reply, and tool-result carriers returns all real
    user/assistant messages through pagination; tools/protocol records are absent
    by default, and assistant updates are not reduced to the final response.
26. **Depth and range are independent:** status/conversation/activity/full honor
    the selected session/current-exchange/tail range and expose omitted payloads
    with continuations. Increasing depth does not silently change the time range.
27. **Live incremental read:** partial assistant text updates under one identity,
    commits without duplication, and survives normal polling. Rewind/replacement
    reports an explicit reset; a long message is recoverable across chunk reads.
28. **Full operation history:** successful, blocked, failed, pending, and retried
    calls are reconstructable with their real arguments/results and identities
    after restart. Large payloads and batch partial outcomes are fully readable.
29. **History correctness under failure:** a crash after dispatch remains an
    unknown outcome, credential fields are marked/redacted, a history read cannot
    recursively inflate storage, and retention/disk failures never masquerade as
    complete evidence or trigger silent replay of a mutation.
30. **Lightweight multi-agent reads:** status/delta requests avoid full-history
    serialization and feed mounts; page budgets and per-agent continuations
    prevent a verbose agent from hiding another agent's output.

## 11. Definition of done

The feature is complete when the external operator can enumerate all commands
and keybindings, retrieve a whole-app guide and descriptions of every shipped
feature, search the catalog by useful descriptions, reliably open the real picker and
supported UI entry points, find/reveal existing agents across the whole app,
use the Tier A/B/C direct surface for common and UI-difficult work, and alternate
between MCP and computer use while observing the same app state.

The operator can retrieve its full retained MCP call history and exact recorded
results, with explicit gaps/redactions when applicable. Agent reads default to
user prompts and all user-visible assistant messages and offer independent
detail depth, history range, and incremental/paginated access.

The server remains separately enabled and excluded from internal agents by
default. Existing command behavior, provider semantics, and UI ownership remain
intact. Coverage checks prevent newly added commands from becoming unexplained
gaps. Unwrapped long-tail UI actions are an intentional supported workflow, not
unfinished automation work.
