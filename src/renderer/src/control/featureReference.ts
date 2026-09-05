import { controlReference as reference0 } from '@renderer/features/workspace/controlReference'
import { controlReference as reference1 } from '@renderer/features/agent-status/controlReference'
import { controlReference as reference2 } from '@renderer/features/ai-workspace/controlReference'
import { controlReference as reference3 } from '@renderer/features/caffeinate/controlReference'
import { controlReference as reference4 } from '@renderer/features/cli-updates/controlReference'
import { controlReference as reference5 } from '@renderer/features/command-keybindings/controlReference'
import { controlReference as reference6 } from '@renderer/features/command-palette/controlReference'
import { controlReference as reference7 } from '@renderer/features/copy-assistant/controlReference'
import { controlReference as reference8 } from '@renderer/features/copy-code-block/controlReference'
import { controlReference as reference9 } from '@renderer/features/debug/controlReference'
import { controlReference as reference10 } from '@renderer/features/dispatch-pin/controlReference'
import { controlReference as reference11 } from '@renderer/features/editor/controlReference'
import { controlReference as reference12 } from '@renderer/features/feed/controlReference'
import { controlReference as reference13 } from '@renderer/features/git/controlReference'
import { controlReference as reference14 } from '@renderer/features/global-editor/controlReference'
import { controlReference as reference15 } from '@renderer/features/path-picker/controlReference'
import { controlReference as reference16 } from '@renderer/features/performance/controlReference'
import { controlReference as reference17 } from '@renderer/features/prompt-templates/controlReference'
import { controlReference as reference18 } from '@renderer/features/reader/controlReference'
import { controlReference as reference19 } from '@renderer/features/remote/controlReference'
import { controlReference as reference20 } from '@renderer/features/rendered-content/controlReference'
import { controlReference as reference21 } from '@renderer/features/reply-to-selection/controlReference'
import { controlReference as reference22 } from '@renderer/features/session-preview/controlReference'
import { controlReference as reference23 } from '@renderer/features/settings/controlReference'
import { controlReference as reference24 } from '@renderer/features/setup/controlReference'
import { controlReference as reference25 } from '@renderer/features/spotlight/controlReference'
import { controlReference as reference26 } from '@renderer/features/system-perf/controlReference'
import { controlReference as reference27 } from '@renderer/features/tile-tabs/controlReference'
import { controlReference as reference28 } from '@renderer/features/usage/controlReference'
import { controlReference as reference29 } from '@renderer/features/voice-dictation/controlReference'
import { controlReference as reference30 } from '@renderer/features/workflows/controlReference'
import { controlReference as reference31 } from '@renderer/features/worktrees/controlReference'

export const featureReferences = [
  ...reference0,
  ...reference1,
  ...reference2,
  ...reference3,
  ...reference4,
  ...reference5,
  ...reference6,
  ...reference7,
  ...reference8,
  ...reference9,
  ...reference10,
  ...reference11,
  ...reference12,
  ...reference13,
  ...reference14,
  ...reference15,
  ...reference16,
  ...reference17,
  ...reference18,
  ...reference19,
  ...reference20,
  ...reference21,
  ...reference22,
  ...reference23,
  ...reference24,
  ...reference25,
  ...reference26,
  ...reference27,
  ...reference28,
  ...reference29,
  ...reference30,
  ...reference31,
]

// These directories implement shared infrastructure rather than separate UI
// features. Their user-facing behavior is covered by the named feature page.
export const referenceOwnership = {
  "reader": "reader",
  "settings": "settings",
  "spotlight": "spotlight",
  "caffeinate": "caffeinate",
  "session-preview": "session-preview",
  "voice-dictation": "dictation",
  "tile-tabs": "tiled-tabs",
  "path-picker": "path-picker",
  "global-editor": "global-editor",
  "workspace": "workspace",
  "setup": "setup",
  "command-keybindings": "keybindings",
  "workflows": "workflows",
  "usage": "usage",
  "rendered-content": "rendered-content",
  "dispatch-pin": "pins",
  "command-palette": "command-palette",
  "feed": "conversation",
  "worktrees": "worktrees",
  "system-perf": "system-performance",
  "cli-updates": "cli-updates",
  "copy-assistant": "copy-assistant",
  "copy-code-block": "copy-code-block",
  "performance": "performance",
  "prompt-templates": "prompt-templates",
  "reply-to-selection": "reply-to-selection",
  "agent-status": "agent-status",
  "ai-workspace": "ai-workspace",
  "editor": "read-only-documents",
  "git": "git",
  "debug": "debug",
  "remote": "remote",
  "shared": "conversation",
  "sessionFeed": "conversation"
} as const
