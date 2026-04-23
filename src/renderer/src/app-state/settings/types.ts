export type ThemeMode =
  | 'dark'
  | 'dark-dim'
  | 'dark-tokyonight'
  | 'light'
  | 'light-soft'

export type ThemeModeMeta = {
  id: ThemeMode
  label: string
  family: 'dark' | 'light'
}

export const THEME_MODES: ThemeModeMeta[] = [
  { id: 'dark', label: 'Dark', family: 'dark' },
  { id: 'dark-dim', label: 'Gray Dark', family: 'dark' },
  { id: 'dark-tokyonight', label: 'Tokyonight', family: 'dark' },
  { id: 'light', label: 'Light', family: 'light' },
  { id: 'light-soft', label: 'Soft Light', family: 'light' },
]

export function isDarkThemeMode(mode: ThemeMode): boolean {
  return THEME_MODES.find(option => option.id === mode)?.family !== 'light'
}

export type AccentId =
  | 'lime'
  | 'amber'
  | 'sky'
  | 'magenta'
  | 'gold'
  | 'coral'
  | 'sage'
  | 'lavender'

export type AccentMeta = {
  id: AccentId
  name: string
  dark: string
  light: string
  fgDark: string
  fgLight: string
}

export const ACCENTS: AccentMeta[] = [
  { id: 'lime', name: 'Lime', dark: '#7dd3a0', light: '#4b8a63', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'amber', name: 'Amber', dark: '#ff9f4a', light: '#b05d14', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'sky', name: 'Sky', dark: '#6bb6ff', light: '#2c6bb5', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'magenta', name: 'Magenta', dark: '#e66ed9', light: '#a23895', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'gold', name: 'Gold', dark: '#f5d64a', light: '#9a7c16', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'coral', name: 'Coral', dark: '#ff6b6b', light: '#b83c3c', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'sage', name: 'Sage', dark: '#a8c49a', light: '#5f7a52', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'lavender', name: 'Lavender', dark: '#b5a3ff', light: '#6e57c7', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
]

export type Settings = {
  mode: ThemeMode
  contrast: boolean
  accent: AccentId
  customRendering: boolean
  dangerousAgentsEnabled: boolean
  /** When true, Claude sessions are spawned through a per-session
   *  mitmproxy that decrypts Anthropic `/v1/messages` SSE in real
   *  time and feeds structured per-block semantic events to the
   *  ReaderView. When false (default), screen parsing remains the
   *  semantic source and no proxy process is spawned.
   *
   *  Opt-in because it requires mitmproxy installed locally (the
   *  user must run `npm run proxy-demo-bootstrap` once) and because
   *  the feature is still experimental. Toggle is per-Claude-session
   *  at spawn time — flipping it mid-session has no effect; the next
   *  new session picks up the new value. */
  useProxyStreaming: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'dark',
  contrast: false,
  accent: 'lime',
  customRendering: false,
  dangerousAgentsEnabled: false,
  useProxyStreaming: false,
}
