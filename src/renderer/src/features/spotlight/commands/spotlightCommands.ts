import type { CommandDef } from '@renderer/features/command-palette/types'
import { toggle } from '@renderer/features/command-palette/commandState'
import { useAppStore } from '@renderer/app-state/store'

export const spotlightCommands: CommandDef[] = [
  {
    id: 'toggle-spotlight',
    category: 'navigate',
    // `app`, not `grid`: toggleSpotlight resolves its target through the
    // Dispatch-aware focus path, so single-pane spotlight works whether
    // the user is commanding a grid pane or a Dispatch row.
    surface: 'app',
    title: 'Spotlight',
    description: '**What it does:** Toggles a focused **single-pane view**.\n\n**Use when:** You want one session large without changing the grid layout.\n\n**Notes:** Press **Esc** to exit. While you are typing in the **Sidekick**, it spotlights the sidekick instead: its column fills the window.',
    getState: ({ workspace }) => toggle(Boolean(workspace.spotlight) || useAppStore.getState().sidekickSpotlight),
    // One Spotlight chord for both places an agent can be (#1493 follow-up).
    // While the Sidekick owns the keyboard, Spotlight means the SIDEKICK fills
    // the window (sidekickSpotlight in uiShell; why it is not the workspace's
    // tab-keyed SpotlightState is recorded there). Leaving is checked first so
    // the chord always exits whichever Spotlight is up, wherever the keyboard
    // happens to be.
    run: ({ workspace }) => {
      const store = useAppStore.getState()
      if (store.sidekickSpotlight) {
        store.setSidekickSpotlight(false)
        return
      }
      if (store.keyboardRegion === 'sidekick' && workspace.state.sidekickPanel?.open === true) {
        store.setSidekickSpotlight(true)
        return
      }
      workspace.toggleSpotlight()
    },
  },
]
