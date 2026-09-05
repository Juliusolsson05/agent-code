import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "workspace",
    "title": "Projects, panes and agent lifecycle",
    "purpose": "Organize coding sessions by project, create agents or terminals, and control placement and lifecycle.",
    "ui": "Project tab bar, pane headers and command picker.",
    "prerequisites": "A project directory and a configured provider are needed to start an agent.",
    "workflow": [
      "Open a project",
      "create and title an agent",
      "split or place its view",
      "prompt it",
      "inspect results before cleanup."
    ],
    "outcome": "The intended session runs in the intended project and placement.",
    "cautions": "Session IDs differ from provider IDs and positional pane labels. Bury, detach, close, stop, switch, duplicate and rewind have different effects. Closing parents can affect children.",
    "commandIds": [
      "new-tab",
      "new-agent",
      "close-pane",
      "bury-pane",
      "linked-agent",
      "detach-to-dispatch"
    ]
  },
  {
    "id": "dispatch",
    "title": "Dispatch rows, lanes and project scope",
    "purpose": "Keep a fleet accessible independently of fixed grid placement.",
    "ui": "Dispatch mode and its index, row headers and lane views.",
    "prerequisites": "Existing sessions; global scope is needed when a row includes other projects.",
    "workflow": [
      "Enter Dispatch",
      "choose project/global scope",
      "add rows or lanes",
      "select agents",
      "pin frequently used sessions."
    ],
    "outcome": "Each lane shows its selected session; mirrored lanes share the same session.",
    "cautions": "Removing a lane and closing its agent are separate actions. Empty lanes stay empty until selected. layout.read returns the revision required by dispatch.configure, layout.adjust and tabs.reorder. Grid edits carry explicit sourceRow identities to preserve each retained row's agents and project filters.",
    "commandIds": [
      "dispatch-mode",
      "global-dispatch",
      "tiled-dispatch",
      "new-dispatch-row",
      "new-tiled-lane"
    ]
  },
  {
    "id": "provider-lifecycle",
    "title": "Provider selection, recovery and history changes",
    "purpose": "Choose a runtime and resume, duplicate, switch or rewind conversations through supported domain operations.",
    "ui": "Provider picker, agent header and session commands.",
    "prerequisites": "Provider availability, authentication and conversation compatibility.",
    "workflow": [
      "Inspect the current provider and readiness",
      "choose the supported operation",
      "wait for its actual outcome",
      "observe the same session again."
    ],
    "outcome": "The chosen provider or history state is visible and ready for the next step.",
    "cautions": "A live process does not establish input readiness. Provider switch can change the provider conversation identity. Rewind is not a harmless view change.",
    "commandIds": []
  },
  {
    "id": "terminal",
    "title": "Persistent terminals and raw provider terminals",
    "purpose": "Run shell commands or inspect a provider native interface alongside rendered agent views.",
    "ui": "Terminal panes and the agent terminal view.",
    "prerequisites": "An available shell; persistence depends on the managed tmux runtime and session type.",
    "workflow": [
      "Open the intended terminal",
      "confirm its working directory",
      "send input",
      "read output and exit state."
    ],
    "outcome": "Commands run in the selected terminal; agent terminal view exposes its existing provider process.",
    "cautions": "Use terminals.create/read/input for detached terminal creation and retained raw PTY output with exact run-bound input. Retained output is bounded and is not unlimited history. Terminal keystrokes belong to the running program. Closing a view, interrupting a job and killing a session differ.",
    "commandIds": []
  }
] satisfies FeatureReference[]
