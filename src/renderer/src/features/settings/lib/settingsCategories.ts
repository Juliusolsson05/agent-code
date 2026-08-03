export type SettingCategoryId =
  | 'appearance'
  | 'workspace'
  | 'agents'
  | 'commands'
  | 'dictation'
  | 'experimental'
  | 'safety'
  | 'apps'

export type SettingCategory = {
  id: SettingCategoryId
  label: string
  description: string
}

export const SETTING_CATEGORIES: SettingCategory[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme modes, accents, and contrast.',
  },
  {
    id: 'workspace',
    label: 'Workspace',
    description: 'How the shell behaves during normal use.',
  },
  {
    id: 'agents',
    label: 'Agents',
    description: 'Shared behavior and instructions for agent runtimes.',
  },
  {
    id: 'commands',
    label: 'Commands',
    description: 'Keyboard shortcuts, and which commands appear in the command picker.',
  },
  {
    id: 'dictation',
    label: 'Dictation',
    description: 'Inline speech-to-text for the active composer.',
  },
  {
    id: 'experimental',
    label: 'Experimental',
    description: 'Features that still depend on local setup.',
  },
  {
    id: 'safety',
    label: 'Safety',
    description: 'Defaults that change agent risk posture.',
  },
  // Last on purpose: apps are additive tooling rather than a setting that changes
  // how the shell or an agent behaves, so they should not push the behavioural
  // categories down the list. In Stage 2 this becomes the install/manage surface
  // and the position can be revisited then, with a reason.
  {
    id: 'apps',
    label: 'Extensions',
    description: 'Install extensions from a GitHub repository.',
  },
]
