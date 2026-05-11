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

// WHY a separate type: this is the user-preference choice (a label)
// for which mode the app should boot into on a *fresh install*. It is
// deliberately NOT the same shape as DispatchModeState — the workspace
// mode at runtime is null for grid and a {scope, focusedSessionId?}
// object for dispatch, but the *preference* only needs to encode "which
// of the two should we start in". Keeping this as a flat string union
// keeps localStorage payload stable, makes coerceSettings trivial, and
// avoids leaking workspace-internal shape into a global setting.
export type WorkspaceModeId = 'grid' | 'dispatch'

export type WorkspaceModeMeta = {
  id: WorkspaceModeId
  label: string
}

export const WORKSPACE_MODES: WorkspaceModeMeta[] = [
  { id: 'grid', label: 'Grid' },
  { id: 'dispatch', label: 'Dispatch' },
]

export type DictationProviderId = 'deepgram'

export type Settings = {
  mode: ThemeMode
  contrast: boolean
  accent: AccentId
  customRendering: boolean
  showStatusMode: boolean
  showWorktreeBadges: boolean
  dangerousAgentsEnabled: boolean
  /** Mode the app boots into on first launch / fresh install (no
   *  workspace.json yet). After a workspace exists, its persisted
   *  dispatchMode always wins on subsequent launches — flipping this
   *  setting later does nothing for users with an existing workspace.
   *  This intentional narrowness matches the "new workspaces only"
   *  semantic the user asked for: the setting seeds initial state and
   *  then gets out of the way. */
  defaultWorkspaceMode: WorkspaceModeId
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
  /** Inline voice dictation for the active composer. This is intentionally
   *  a cc-shell setting instead of an agent-voice-dictation setting:
   *  package code provides STT primitives, while cc-shell decides whether
   *  voice belongs in its composer UI and which keyboard binding should
   *  toggle recording. */
  dictationEnabled: boolean
  dictationProvider: DictationProviderId
  /** Arbitrary keyboard binding captured by the settings UI. The standalone
   *  dictation app historically offered fixed choices, but cc-shell needs the
   *  same "press the key you want" model because composer bindings compete
   *  with editor shortcuts. Empty string means "button only". */
  dictationShortcut: string
  /** When true, periodically writes Save-Debug-Logs-style bundles for
   *  every active agent session and attempts one last write during
   *  renderer unload. This is a developer-mode setting, not a
   *  user-facing polish toggle: bundles can contain large runtime,
   *  DOM, semantic, and feed-debug snapshots, so they are interval-
   *  based rather than emitted on every render. */
  aggressiveDebugPersistence: boolean
  /** When true, Dispatch Mode mounts a project terminal pane beside the
   *  agent list. The terminal is auto-spawned on first entry to Dispatch
   *  and lives as a normal leaf in the tile tree (so tmux recovery and
   *  IPC routing keep working unchanged).
   *
   *  Off by default. The previous design kept a per-session
   *  `dispatchMode.terminalVisible` flag in workspace state, which made
   *  the "I turned it off but it came back" symptom hard to reason
   *  about: fresh workspaces, new tabs, and any code path that re-
   *  entered dispatch defaulted the flag to ON. Moving the gate to a
   *  global setting collapses the toggle surface to one place the user
   *  controls and removes the "terminal always mounted even when turned
   *  off" failure mode. */
  dispatchProjectTerminal: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'dark',
  contrast: false,
  accent: 'lime',
  customRendering: false,
  showStatusMode: true,
  showWorktreeBadges: true,
  dangerousAgentsEnabled: false,
  useProxyStreaming: false,
  dictationEnabled: false,
  dictationProvider: 'deepgram',
  dictationShortcut: 'Fn',
  aggressiveDebugPersistence: false,
  defaultWorkspaceMode: 'grid',
  dispatchProjectTerminal: false,
}
