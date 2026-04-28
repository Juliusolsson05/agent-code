export type SettingCategoryId =
  | 'appearance'
  | 'workspace'
  | 'dictation'
  | 'experimental'
  | 'safety'

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
]
