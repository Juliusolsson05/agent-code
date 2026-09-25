import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    id: 'providers',
    title: 'Provider enablement',
    purpose:
      'Choose which coding agents Agent Code offers, with detection-backed defaults and user overrides.',
    ui: 'Settings → Providers. The enablement state also filters the new-agent pickers, provider switching (single and bulk), saved-session pickers, and the usage surfaces.',
    prerequisites: 'None. Detection reuses the setup toolchain probes (PATH, well-known dirs, bundled OpenCode).',
    workflow: [
      'Open Settings → Providers',
      'toggle a provider on or off, or reset it back to detection',
      'pickers, switching, and usage react immediately in every window; running agents are untouched',
    ],
    outcome: 'Disabled providers stop appearing as alternatives; enabled providers report usage where a reader exists.',
    cautions:
      'The state is main-owned (setup.json), so it is shared by every window and survives restarts. Only user overrides persist — detection is recomputed on reset and app start. A disabled provider keeps its keybindings and saved sessions; its palette commands decline to run while disabled. Running sessions are never closed by this setting.',
    commandIds: [],
  },
] satisfies FeatureReference[]
