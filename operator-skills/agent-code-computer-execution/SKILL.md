---
name: agent-code-computer-execution
description: Operate the Agent Code desktop app from an external assistant using its control MCP and computer use. Use to find and prompt agents, navigate multiple windows, read progress, or operate app features. Not for implementing code inside the Agent Code repository.
---

# Agent Code computer execution

Use Agent Code's external control MCP for precise app operations and computer use
for visual context and UI interactions. An Agent Code agent is a provider session
inside the app; you are the external operator coordinating those sessions for the
user. Keep the user's objective and existing authorizations as the scope.

## Learn the running app

Call `ac_app_describe` with default arguments for the crash course. It explains
what Agent Code is, the UI, layouts, features and operating conventions. Fetch a
specific section from its `sectionIndex`, or use `mode: "full"` and follow
pagination when a feature needs more detail. The running tool schemas and live
reference are authoritative; this skill deliberately does not duplicate the app
manual or every command.

Discover available tools before using them: clients may prefix the `ac_` names.
If the control MCP is absent, use computer use for authorized work and report the
missing connection if it prevents reliable progress. The app's Settings → Agents
→ External operator MCP installs the global external Codex connection and this skill.
Restart the external client after enabling it or rotating its key. Do not attach this
external server to the agents being operated or edit their MCP configuration.

## Select the correct window and agent

For computer attachment, first use `ac_app_identity`: match the running PID and
exact executable/bundle path. Development checkouts can share the Electron bundle
ID and title. Attach to the existing process; opening a guessed executable can
launch an unrelated blank Electron window.

Use `ac_app_windows` to get stable window IDs and current renderer generations,
then `ac_app_observe` for the project tabs, agents, layout and input-owning surfaces
in each window. A window, project tab, grid tile and agent session are different
identities. An agent can appear in several placements, and a hidden or detached
agent still exists.

Use `ac_agents_search` across windows before creating an agent. Match the user's
project, title, provider and current conversation; do not assume the focused
window or the first search result is the target. Pass the returned `sessionId`
to agent tools. These normally resolve their owning window automatically.

For a window-specific operation, pass `_control.windowId`. Include
`_control.generation` when the action depends on the exact workspace you just
observed. A reload makes the old generation stale: refresh the observation before
continuing. Window numbers or titles help identify a window visually; retain its
stable ID for subsequent calls. On `ambiguous_owner`, inspect the matching windows
and choose the intended owner. Ask the user only if the available evidence cannot
resolve their intent.

Use `ac_agents_locate` to inspect an agent without waking it and `ac_agents_show`
to display that exact session. Showing an agent may wake it. Buried agents require
explicit restoration; do not create a replacement just because a session is off
screen. After a tool changes focus or opens a surface, inspect the actual selected
window before clicking or typing.

For example, to focus “A5 in window two” while preserving `[A5, B7, B8, B9]`:

1. Match window two using `ac_app_windows` and its projects in `ac_app_observe`.
2. Search `{label: "A5", windowId: "<that stable ID>"}`. Check `displayedTitle`,
   provider and conversation; the same label in another window is another agent.
3. Locate the returned stable session ID, then call `ac_agents_show` with
   `intent: "reuse-existing-view"` and that window/generation.
4. Verify the foreground window and lane selections before computer input.

Clicking A5 in a Dispatch row’s shared index places it into that row’s **focused lane**
(or its first lane when focus is in another row),
even if another lane already shows A5. That can change `[A5, B7, B8, B9]` to
`[A5, A5, B8, B9]`: two views of one process, not a new agent. Use explicit
`open-in-focused-tiled-dispatch-lane` only when that replacement is intended.
`layout.read.effectiveFocusedSessionId` is the current command target;
`dispatch.classicFocusedSessionId` only remembers classic Dispatch selection.

## Choose MCP or computer use

Prefer a typed tool for stable IDs, difficult navigation, prompt delivery,
conversation reads and operations with an explicit result. Use computer use for
visual inspection, modal choices, rich editor interactions and remaining UI work.
MCP coverage is intentionally broad but does not imply every feature has a tool.

Search `ac_commands_list` for an unfamiliar action; `ac_commands_describe` explains
its route and effective bindings. `ac_keybindings_list` includes customized,
unbound, fixed and contextual interactions, including mouse controls. Use the
reported binding and context instead of guessing a shortcut. A catalog entry is
reference information, not proof that the command is currently available.

`ac_commands_run` invokes an exact catalog command through the app's contextual
dispatcher. Prefer dedicated tools when available. Supply `expectedSessionId`
for an agent command so a changed selection is rejected. `dispatch: "ran"` means
the dispatcher returned; finish any dialog and verify background work separately.
It acts in the chosen window's selected context. Use `ac_app_window_focus` before
a computer-use handoff when that window needs to become foreground.

`ac_ui_command_picker_open` opens the real picker with a query and optional
`commandId`. It reports the rendered selection and does not execute it. If
`requestedSelectionFound` is false, inspect the picker and revise the route; do
not press Enter on a different selected row. Complete the intended interaction
with computer use, then observe the resulting state.

If another surface owns input, inspect it before continuing. A screenshot or
selection made in one window cannot justify keystrokes in another.

Use `ac_layout_read` before layout or Dispatch edits and refresh its revision
after each change. Lane and row indices are local to that revision. When changing
Dispatch row structure, retain each row's `sourceRow` identity; use null only for
a new empty row. Removing a lane does not close its agent. `ac_editor_buffers`
shows unsaved/conflicting buffers; `ac_editor_open` preserves those edits.

## Prompt agents and read progress

Use `ac_agents_prompt` with the exact session and the user's intended prompt.
A successful response confirms provider acceptance, which may be a queue or
transport acknowledgment. It does not mean the task finished. The tool preserves
Agent Code’s app-owned draft; do not also click Send for the same prompt.

To edit unsent text, read `ac_agents_draft_get` and supply its revision to
`ac_agents_draft_set`. Replace preserves attachments; clear removes them; undo
restores text only. Draft editing never submits a prompt. `ac_agents_input_inspect` separately reports
native provider draft knowledge. `unknown` is not empty; an xterm accessibility
“Terminal input” value is transport state and may omit existing TUI text. Prefer
typed prompt delivery with its provider checks. If computer paste/Return is
needed, establish the full native composer first and verify the committed prompt;
do not clear uncertain existing text just to make room.

Use `ac_agents_conditions_read` to inspect a blocking provider condition. Reply
only with an advertised action ID and its current revision using
`ac_agents_conditions_reply`, within the user's authorization. Read again after
the action. Use the actual UI for custom answers absent from the action list;
do not synthesize keystrokes from a remembered dialog layout.

For reads, `ac_agents_read` defaults to actual user prompts and all visible
assistant prose, including intermediate updates. Select depth and range separately:

- `depth: "status"` reads lightweight process/readiness/condition information.
- `depth: "conversation"` reads prompts and assistant text.
- `depth: "activity"` adds summarized tool activity; `"full"` adds full available
  detail for the selected feed records.
- `range: "session"` starts with the current history window and offers older
  pages; `"current_exchange"` starts at its latest accepted prompt when present;
  `"latest"` returns a recent tail.
- `range: "delta"` with `since` set to a completed read's `deltaCursor` returns
  changed messages and transient removals. Use this for subsequent progress reads.

Finish `nextCursor` pages before using the returned `olderCursor` or `deltaCursor`.
Keep the same agent and depth. Long messages are fragments identified by `id`,
`offset`, `totalChars` and `nextOffset`; reconstruct them by offset. Merge messages
by ID, apply `deletedMessageIds`, and update partial messages in place. Older pages
precede the current window chronologically. Do not treat a continuation page as a
new conversation or repeat the entire history to the user.

On an expired or changed cursor, start a fresh read. Read availability and reason:
missing durable history or native-terminal live output may require computer use;
an empty result alone is not evidence that the agent did nothing. Reads never
wake the agent. Check output or the relevant app state for completion and summarize
progress at a useful cadence rather than repeatedly fetching full history.

Use `ac_terminals_create` for a detached terminal in an observed project. Read
`ac_terminals_read` for the retained raw PTY output, starting with a recent tail;
`range: "retained"` pages the complete retained buffer, not unlimited shell history.
Send exact bytes with `ac_terminals_input` and the observed `sessionRunId`; it does
not append Enter. These tools never wake a missing process.

`ac_agents_close` uses the normal close flow and child-cascade confirmation.
Finish its dialog with computer use and call `ac_operations_read` with the returned
callId to learn whether it closed or was cancelled. Do not interpret acceptance as
completion or issue a second close while confirmation is pending.

## Batches and broader controls

`ac_agents_batch_read` and `ac_agents_batch_prompt` accept up to 20 independent
items. Inspect every child result, including failures. Keep each read cursor with
its own agent/depth. For partial prompt retries, keep `batchKey` and each `itemKey`
stable; if the subset changes, use a new parent `_control.requestKey`. Retrying an
unknown child under another key risks duplicate delivery. Batch acceptance says
nothing about task completion; monitor each agent and its conditions.

`ac_settings_values/set` handles advertised ordinary choices with revisions.
Use `ac_settings_reference` and the UI for other settings. `ac_templates_list/read`
finds reusable prompts; insertion needs both template and draft revisions and an
explicit project for dynamic context. Inspect the draft before sending. Save/delete
only changes custom templates. `ac_ui_surfaces/surface_set` selects named panels;
`ac_usage_read` and `ac_worktrees_read` provide read-only evidence.

For existing workflows, list definitions for the exact cwd, then start with JSON
arguments. Ordinary source approval may need computer use. Poll the returned task
callId through `ac_operations_read` for runId, then use `ac_workflows_status/events/result`.
Cancel/resume is limited to the external connection's runs. Clients sharing this
connection share that ownership; it is not a per-person identity. Internal agent
runs keep their owner, and workflow workers do not gain this operator toolkit.

## Lifecycle and views

Read `ac_agents_lifecycle_read` before reload, switch, duplicate, rewind or undo.
Use its supported choices and current revision. These operations return a task
callId; `ac_operations_read` returns the final replacement ID. Re-find that ID
before further actions. Reload/rewind/duplicate require idle native conversations;
`ac_agents_interrupt` requests the ordinary Stop signal, not process termination.

Use `ac_native_history_list` for a bounded recent catalog outside the workspace,
and `ac_native_history_prompts` for exact rewind addresses. Native IDs are not
Agent Code session IDs. Resume continues the native conversation; duplicate
branches a copy. OpenCode discovery can be unavailable while known IDs still work. This catalog is
not a full historical topic search.

`ac_placement_inspect` explains detach/bury consequences before their revision-bound
operations. Last-pane bury also archives detached children. `ac_views_agent_set`
selects Reader, Spotlight or normal workspace by desired state, without toggles.

Creating a detached agent normally selects it in the lane focused when creation
began, replacing that view without closing its agent. To preserve current tabs and
lanes, use `ac_agents_create` with `selectCreated:false`. Then read `ac_layout_read`
and use `ac_dispatch_configure` with `change.action:"lane-select"`, the target
`laneIndex`, the returned session ID and a fresh revision. Resume/duplicate also
select their created agent using normal creation behavior; inspect lanes afterwards.

## Recover and verify

Use a fresh `_control.requestKey` for each new mutation intention. Reuse that key
only when retrying the same call with the same arguments and target. An uncertain
outcome is a reason to inspect state, not send the action again under a new key.

Keep `operation.callId`. Use `ac_history_read` to inspect a call and its retries,
`ac_history_list` to browse an execution window, and `ac_history_payload_read` to
recover full arguments/results through byte continuations. Preserve the history
list's snapshot while paging so it does not chase its own new read events.

A `pending` result acknowledges an accepted action; `ui_opened` confirms a surface;
`outcome_unknown` requires observation before another effect. MCP history covers
MCP/SDK execution, not unrecorded computer clicks. Report what was actually
observed, which agent/window performed the work, and any unresolved outcome.
