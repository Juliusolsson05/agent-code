import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "sidekick",
    "title": "Sidekick: global agents beside the workspace",
    "purpose": "Keep one global agent — Hermes, or any agent started in the home folder — open beside every project, in a panel docked at the right edge of each window.",
    "ui": "Sidekick panel (Sidekick command), Sidekick Picker… and New Sidekick… commands; panel header Switch, Reload, Remove and Hide.",
    "prerequisites": "At least one enabled agent provider; Hermes needs a signed-in connection under Settings → Hermes.",
    "workflow": [
      "Open the Sidekick panel",
      "create a sidekick of the chosen kind or switch to an existing one in the picker",
      "chat with it while lanes keep their own agents",
      "use Open here to move a sidekick that is live in another window"
    ],
    "outcome": "The chosen sidekick's conversation is shown in the panel and survives tab closes, window closes and restarts.",
    "cautions": "A sidekick belongs to no project or lane: it never appears in the Dispatch index, lanes, pins, bulk closes, the Control workspace observation or the extension session list. It is live in one window at a time. Palette commands keep acting on the focused lane, not on the sidekick.",
    "commandIds": [
      "sidekick-panel",
      "sidekick-picker",
      "new-sidekick"
    ]
  }
] satisfies FeatureReference[]
