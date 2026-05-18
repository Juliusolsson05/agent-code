import { DEFAULT_CUSTOM_APPEARANCE_JSON } from '@renderer/app-state/settings/customAppearance'

export type ThemeMode =
  | 'dark'
  | 'dark-dim'
  | 'dark-tokyonight'
  | 'light'
  | 'custom'
  | 'light-soft'

export type ThemeModeMeta = {
  id: ThemeMode
  label: string
  family: 'dark' | 'light' | 'custom'
}

export const THEME_MODES: ThemeModeMeta[] = [
  { id: 'dark', label: 'Dark', family: 'dark' },
  { id: 'dark-dim', label: 'Gray Dark', family: 'dark' },
  { id: 'dark-tokyonight', label: 'Tokyonight', family: 'dark' },
  { id: 'light', label: 'Light', family: 'light' },
  // WHY Custom sits before Soft Light: the settings UI renders theme modes in
  // a two-column grid. Adding Custom as the fifth option lands it in the
  // lower-left cell and Soft Light in the lower-right cell, which gives the
  // Appearance section an even 3x2 shape without moving the established dark
  // and light defaults at the top.
  { id: 'custom', label: 'Custom', family: 'custom' },
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

// Font choice for the entire app. This is the single source of truth for
// "what monospace face does Agent Code render in" — normal DOM inherits
// `--theme-app-font`, old `font-code` Tailwind classes alias to that same
// token, and canvas/metric-cached renderers (xterm.js + Monaco) read from
// this setting through `applyTheme` / `getActiveAppFontFamily`.
//
// WHY a curated id union instead of a free-text font-family string:
//   1. Validates cleanly at the persistence boundary — `coerceSettings`
//      just checks membership in `FONT_FAMILIES` and falls back to the
//      default on garbage / typo.
//   2. Each entry carries its own fallback chain in `family`, so a
//      user-chosen webfont that fails to load (offline, blocked CDN,
//      stale cache) degrades to a sensible system mono instead of the
//      browser's default proportional font.
//   3. Lets us declare which entries need the Google Fonts `@import`
//      bundle without runtime hacks — the `webFont` flag exists so a
//      future maintainer who adds an entry knows whether they also
//      need to add it to the `@import` URL in `styles.css`.
//
// Adding a new font: pick an id, write the meta below, AND add the
// family to the Google Fonts @import URL in `styles.css:28` if
// `webFont: true`.
export type FontFamilyId =
  | 'jetbrains-mono'
  | 'roboto-mono'
  | 'space-mono'
  | 'ubuntu-mono'
  | 'courier-prime'

export type FontFamilyMeta = {
  id: FontFamilyId
  /** User-visible name in the picker. */
  label: string
  /** Short picker hint that explains why this option exists. The font list is
   *  intentionally tiny, so each face needs to earn its slot by offering a
   *  visibly different texture instead of being yet another near-identical
   *  modern coding mono. */
  description: string
  /** Exact value assigned to `--theme-app-font`. The leading family
   *  is the preferred face; the trailing chain is the fallback so a
   *  webfont that hasn't finished loading (or isn't available because
   *  the user is offline / CDN-blocked) still renders monospace text
   *  instead of falling all the way back to the browser's default
   *  proportional font.
   *
   *  Quoting style note: family names that contain whitespace are
   *  single-quoted; CSS keywords (ui-monospace, monospace) are
   *  unquoted. xterm.js parses this same string verbatim, so the
   *  format MUST be a valid CSS `font-family` declaration. */
  family: string
  /** True when the font is loaded from the Google Fonts CDN @import in
   *  `styles.css`. Useful for the picker to surface a "requires
   *  network" note, and as documentation for future-me about which
   *  entries are tied to the @import URL. */
  webFont: boolean
}

export const FONT_FAMILIES: FontFamilyMeta[] = [
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    description: 'Modern coding default',
    family: "'JetBrains Mono', ui-monospace, Menlo, Monaco, monospace",
    webFont: true,
  },
  {
    id: 'roboto-mono',
    label: 'Roboto Mono',
    description: 'Neutral and compact',
    family: "'Roboto Mono', ui-monospace, Menlo, Monaco, monospace",
    webFont: true,
  },
  {
    id: 'space-mono',
    label: 'Space Mono',
    description: 'Wide geometric',
    family: "'Space Mono', ui-monospace, Menlo, Monaco, monospace",
    webFont: true,
  },
  {
    id: 'ubuntu-mono',
    label: 'Ubuntu Mono',
    description: 'Rounded humanist',
    family: "'Ubuntu Mono', ui-monospace, Menlo, Monaco, monospace",
    webFont: true,
  },
  {
    id: 'courier-prime',
    label: 'Courier Prime',
    description: 'Classic typewriter',
    family: "'Courier Prime', ui-monospace, Menlo, Monaco, monospace",
    webFont: true,
  },
]

export type Settings = {
  mode: ThemeMode
  contrast: boolean
  accent: AccentId
  /** Raw JSON string for the Custom Appearance mode. It is stored as raw
   *  user input rather than as a parsed object because the settings UI is a
   *  JSON editor: users expect formatting, ordering, and comments about parse
   *  errors to be local to that editor instead of losing their text on every
   *  keystroke. Persistence still validates/coerces the string on boot, and
   *  the modal validates before saving. */
  customAppearanceJson: string
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
   *  user must run `npm run runtime:fetch:mitmproxy` once) and because
   *  the feature is still experimental. Toggle is per-Claude-session
   *  at spawn time — flipping it mid-session has no effect; the next
   *  new session picks up the new value. */
  useProxyStreaming: boolean
  /** Inline voice dictation for the active composer. This is intentionally
   *  an Agent Code setting instead of an agent-voice-dictation setting:
   *  package code provides STT primitives, while Agent Code decides whether
   *  voice belongs in its composer UI and which keyboard binding should
   *  toggle recording. */
  dictationEnabled: boolean
  dictationProvider: DictationProviderId
  /** Arbitrary keyboard binding captured by the settings UI. The standalone
   *  dictation app historically offered fixed choices, but Agent Code needs the
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
  /** Monospace face used across the whole app: inherited DOM text,
   *  existing `font-code` Tailwind classes, Monaco code blocks, and
   *  xterm panes all resolve through the same `--theme-app-font`
   *  value. Applied live by `applyTheme` on every settings change; no
   *  restart required.
   *
   *  Curated id union (see `FONT_FAMILIES`) rather than a free-text
   *  family string so typos / corrupted localStorage can't break
   *  rendering — `coerceSettings` falls back to the default on any
   *  unknown id. */
  fontFamily: FontFamilyId
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'dark',
  contrast: false,
  accent: 'lime',
  customAppearanceJson: DEFAULT_CUSTOM_APPEARANCE_JSON,
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
  fontFamily: 'jetbrains-mono',
}
