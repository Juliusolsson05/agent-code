import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "conversations",
    "title": "Conversations picker",
    "purpose": "Find and resume any past Claude, Codex or OpenCode conversation of the focused repository, across every worktree.",
    "ui": "Resume Session… and Search Conversations… open the same picker; the path picker's resume rows and View Prompts read the same catalog.",
    "prerequisites": "A focused pane with a working directory inside a repository, or any directory for the everywhere scope.",
    "workflow": [
      "Open the picker",
      "narrow by scope, provider or a search over titles, names and prompts",
      "preview the highlighted row",
      "press Enter to resume it in place, under its own directory and provider."
    ],
    "outcome": "The focused pane is replaced by the resumed conversation, or a new tab opens when nothing can be replaced.",
    "cautions": "Orchestration children, native subagents and exec runs are hidden until the children toggle is on. Rows are ordered by the user's last activity, not by file modification. External operators read the same catalog through nativeHistory.list and nativeHistory.search.",
    "commandIds": [
      "resume-session",
      "search-conversation-prompts"
    ]
  }
] satisfies FeatureReference[]
