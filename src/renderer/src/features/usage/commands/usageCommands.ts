import type { CommandDef } from '@renderer/features/command-palette/types'

export const usageCommands: CommandDef[] = [
  {
    id: 'usage.open',
    category: 'workspace-tools',
    title: 'Open Usage',
    description: 'Open provider usage for Claude and Codex.',
    surface: 'app',
    keywords: ['quota', 'tokens', 'limits', 'claude', 'codex', 'usage'],
    run: ({ ui }) => {
      ui.openUsageModal()
      ui.closePalette()
    },
  },
  // RETIRED: `usage.toggle-header` and `usage.cycle-header-level`.
  //
  // Both were durable app preferences with no momentary scope, so Settings is
  // their single home (`usageHeaderEnabled` and `usageHeaderLevel`).
  //
  // The detail cycler is worth recording separately, because it was retired
  // rather than repaired. It had three defects at once: it rendered the RAW
  // lowercase enum value as its badge ("providers"), it cycled forward through
  // four states with no way back, and — the real problem — it IMPLICITLY
  // ENABLED the header as a side effect of changing the detail level. A user
  // who had deliberately hidden the header could not adjust its detail without
  // silently un-hiding it. That is one command doing two things, one of them
  // undisclosed. Settings shows a labelled select that changes exactly the
  // level and never touches the enabled flag.
]
