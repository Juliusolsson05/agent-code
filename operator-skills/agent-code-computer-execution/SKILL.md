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
→ External operator MCP offers connection configuration. Do not attach this
external server to the agents being operated or edit their MCP configuration.

## Select the correct window and agent

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
the composer's draft; do not also click Send for the same prompt.

To edit unsent text, read `ac_agents_draft_get` and supply its revision to
`ac_agents_draft_set`. Replace preserves attachments; clear removes them; undo
restores text only. Draft editing never submits a prompt.

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
