import type { CommandDef } from '@renderer/features/command-palette/types'

export const agentOverlayCommands: CommandDef[] = [
  {
    id: 'toggle-agent-overlay',
    surface: 'app',
    title: 'Floating Agent Status',
    description:
      '**What it does:** Toggles the **floating agent status** pill — a small always-on-top window that stays visible over other apps.\n\n**Use when:** You are in the browser or another app and want to see when agents finish or need approval.\n\n**Notes:** Click the pill to expand per-agent rows; click a row to jump to that agent. Auto-hides while Agent Code is focused.',
    keywords: [
      'overlay',
      'floating',
      'pill',
      'status',
      'agents',
      'always on top',
      'picture in picture',
      'monitor',
      'widget',
    ],
    // Fire-and-forget straight at the preload bridge: the toggle's state
    // of record lives in MAIN (it survives renderer reloads and drives
    // the actual window), so there is no renderer flag to flip here.
    run: () => {
      void window.api.agentOverlayToggle()
    },
  },
]
