import { DEFAULT_CUSTOM_APPEARANCE_JSON } from '@renderer/app-state/settings/customAppearance'
import type { SavedTheme } from '@renderer/app-state/settings/savedThemes'
import type { PromptTemplate } from '@renderer/features/prompt-templates/types'
import type { ColorFlagId } from '@renderer/app-state/settings/dispatchColorFlags'
import type { DictationProvider } from '@shared/types/dictation'
import type { MouseButtonBinding, MouseChordBinding } from '@renderer/lib/mouseBinding'
import type { ConfigurableBuiltInMcpDomain } from '@mcp/shared/types'
import type { CommandSortMode } from '@renderer/features/command-palette/lib/sortCommands'

// Built-in theme ids only. 'custom' used to live here as a sentinel that
// rendered as a picker cell but acted as a button (it opened the JSON editor
// instead of setting the mode). Named saved themes replaced it: a saved theme
// is a real, selectable value, so the fake entry — and the comment explaining
// that it sat at index 5 to make the Appearance grid an even 3x2 — are gone.
// The grid is now variable-length and always ends with a "+ New theme…" cell.
export type ThemeMode =
  | 'dark'
  | 'dark-dim'
  | 'dark-tokyonight'
  | 'light'
  | 'light-soft'

// What `Settings.mode` may actually hold: a built-in id, or a `theme:<uuid>`
// saved-theme id. Kept as a distinct alias so the many call sites that only
// ever deal with built-ins can keep using the narrower ThemeMode.
export type ThemeModeValue = ThemeMode | string

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

export function isBuiltInThemeMode(value: unknown): value is ThemeMode {
  return THEME_MODES.some(option => option.id === value)
}

// Anything not in the light family counts as dark, so a saved-theme id resolves
// to "dark" here.
//
// WHY that is correct rather than a bug worth inferring around: this function
// exists to pick which half of an ACCENT pair to write, and a saved theme never
// needs that decision made for it. `accent` and `accentFg` are themselves two
// of the 81 custom-appearance tokens, so parseCustomAppearanceJson backfills
// them and applyCustomAppearance writes the theme's own concrete accent
// directly — the accent-pair branch in applyTheme is only reachable when there
// is no custom payload at all.
//
// An earlier version of this PR shipped an `isDarkThemeValue` that inferred a
// saved theme's family from its canvas luminance. Review proved the luminance
// branch was unreachable at both call sites: reaching it required the theme to
// exist AND parse, which is exactly the condition that produces a payload and
// takes the other branch. It was deleted rather than kept as defense, because
// dead code that looks load-bearing invites the next person to build on it.
export function isDarkThemeMode(mode: ThemeModeValue): boolean {
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
  { id: 'lime', name: 'Lime', dark: '#7dd3a0', light: '#2f6f46', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'amber', name: 'Amber', dark: '#ff9f4a', light: '#8a470b', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'sky', name: 'Sky', dark: '#6bb6ff', light: '#1f5eaa', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'magenta', name: 'Magenta', dark: '#e66ed9', light: '#8b247f', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'gold', name: 'Gold', dark: '#f5d64a', light: '#735905', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'coral', name: 'Coral', dark: '#ff6b6b', light: '#9f2929', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'sage', name: 'Sage', dark: '#a8c49a', light: '#4d6a3f', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'lavender', name: 'Lavender', dark: '#b5a3ff', light: '#5a43b4', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
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

export type AgentViewMode = 'agent' | 'terminal' | 'hybrid'

export type AgentViewModeMeta = {
  id: AgentViewMode
  label: string
  description: string
}

export const AGENT_VIEW_MODES: AgentViewModeMeta[] = [
  {
    id: 'agent',
    label: 'Agent',
    description: 'Always show Agent Code rendering.',
  },
  {
    id: 'terminal',
    label: 'Terminal',
    description: 'Always show the provider TUI.',
  },
  {
    id: 'hybrid',
    label: 'Hybrid',
    description: 'Use terminal by default; render only when a feature needs it.',
  },
]

/* ---------- Corner radius ----------
 *
 * The app's corner language as one three-value axis. See hard rule 1 in
 * styles.css for what each token class means and why the tiling grid is
 * excluded from all of them.
 *
 * WHY a closed enum of presets and not a number input per token: the
 * interesting question is "which corner language does this app speak", not
 * "is 7px better than 8px". A free length invites the three tokens to drift
 * apart and, worse, removes the fixed point that makes this safe to ship —
 * `sharp` is a GUARANTEE that every token is literally 0px, restoring the
 * historical square app exactly, and a guarantee is testable in a way that an
 * approximation is not.
 *
 * WHY this is a top-level setting and not part of customAppearance: that
 * contract is CUSTOM_APPEARANCE_COLOR_KEYS — 80 keys, all colours, validated
 * as colours and surfaced in the theme editor as colour fields. Threading
 * three lengths through a colour pipeline means either weakening that
 * validation or special-casing three keys in every consumer, to buy an axis
 * nobody wants 80 values of.
 *
 * This array is the SINGLE source of truth for the numbers. `applyTheme`
 * reads them from here; styles.css carries a matching `:root` fallback for
 * the default tier only, and that duplication is the one copy allowed.
 */
export type CornerStyleId = 'sharp' | 'soft' | 'round'

export type CornerStyleMeta = {
  id: CornerStyleId
  label: string
  description: string
  /** Non-interactive capsule labels: badges, keycaps, counters, scope tags.
   *  The only class that goes fully pill-shaped — safe because a label is
   *  always content-sized. */
  chip: string
  /** Interactive chrome: buttons, inputs, textareas, option rows, hover
   *  targets. Kept modest at every tier because controls come in every
   *  width and a full-width pill is a stadium, not a button. */
  control: string
  /** Inset content plates: code blocks, tool output, diffs, thumbnails. */
  slab: string
  /** Detached surfaces: dialogs, palette, popovers, menus, toasts. */
  float: string
}

export const CORNER_STYLES: CornerStyleMeta[] = [
  {
    id: 'round',
    label: 'Round',
    description: 'Pill-shaped badges and clearly detached panels.',
    chip: '9999px',
    control: '8px',
    slab: '8px',
    float: '14px',
  },
  {
    id: 'soft',
    label: 'Soft',
    description: 'Visible corners that keep the terminal character.',
    chip: '3px',
    control: '4px',
    slab: '4px',
    float: '6px',
  },
  {
    id: 'sharp',
    label: 'Sharp',
    description: 'Square everywhere. The original Agent Code look.',
    chip: '0px',
    control: '0px',
    slab: '0px',
    float: '0px',
  },
]

export type DictationProviderId = DictationProvider

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

/** Detail levels for the header usage indicator, ordered from least to
 *  most detail. The ORDER is load-bearing: the `usage.cycle-header-level`
 *  palette command advances through this array circularly, and the
 *  settings-page select lists options in this order. Add new levels in
 *  display order, never alphabetically. */
export const USAGE_HEADER_LEVELS = ['minimal', 'providers', 'all', 'detailed'] as const
export type UsageHeaderLevel = (typeof USAGE_HEADER_LEVELS)[number]

export type Settings = {
  /** Built-in theme id, or the id of an entry in `savedThemes`. One field
   *  answers "what am I looking at" for applyTheme, useThemeSync, and the
   *  paired phone client alike — see savedThemes.ts for why this is not a
   *  separate `activeSavedThemeId`. */
  mode: ThemeModeValue
  /** Named custom color schemes. The active one is identified by `mode`
   *  holding its id. Stored inside Settings (rather than in their own
   *  localStorage key) so they ride the existing persist/coerce/IPC paths
   *  for free — the phone client already receives the whole Settings blob. */
  savedThemes: SavedTheme[]
  /** User-authored prompt templates live in Settings for the same reason as
   *  savedThemes: one persisted/coerced settings blob means every renderer
   *  surface sees the same template catalog, and migrations can move older
   *  local-only shapes forward without inventing another storage authority. */
  savedPromptTemplates: PromptTemplate[]
  /** Per-agent Dispatch color flags: sessionId → color id (see
   *  dispatchColorFlags.ts). Lives in Settings for the same reason as
   *  savedThemes/savedPromptTemplates — it rides the one persisted, coerced,
   *  phone-mirrored settings blob rather than inventing another store. Absent
   *  key = no flag. */
  dispatchColorFlags: Partial<Record<string, ColorFlagId>>
  contrast: boolean
  accent: AccentId
  /** Raw JSON string for the Custom Appearance mode. It is stored as raw
   *  user input rather than as a parsed object because the settings UI is a
   *  JSON editor: users expect formatting, ordering, and comments about parse
   *  errors to be local to that editor instead of losing their text on every
   *  keystroke. Persistence still validates/coerces the string on boot, and
   *  the modal validates before saving. */
  customAppearanceJson: string
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
  /** App-wide default surface for Claude/Codex agent panes.
   *
   * WHY this is global settings instead of per-session metadata:
   * terminal mode attaches an interactive xterm to the provider PTY and
   * resizes that PTY while mounted. Persisting "this specific session should
   * reopen raw" in workspace metadata would let a stale workspace silently
   * seize provider terminal dimensions on launch. The durable user intent is
   * broader and clearer: choose how Agent Code should present agent panes.
   *
   * The transient part of Hybrid ("render while Copy Assistant is active") is
   * deliberately runtime-only in SessionRuntime.renderedViewLeases. That
   * split keeps app preference durable while feature lifetimes stay tied to
   * the UI state that actually requested them. */
  agentViewMode: AgentViewMode
  /** Built-in MCP capabilities used to seed a new agent session when its
   *  caller does not provide an explicit per-session list. This is a default,
   *  not a fleet policy: after initialization the resolved array lives in
   *  SessionMeta and command-palette toggles may change it independently.
   *
   *  `ping` is deliberately excluded from the type because it is a
   *  development bridge probe, not a product capability. Provider-specific
   *  restrictions (notably Workflow MCP being Codex-only) are applied at the
   *  session and main-host boundaries rather than encoded as parallel
   *  per-provider preference lists. */
  defaultBuiltInMcpDomains: ConfigurableBuiltInMcpDomain[]
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
  /** Mouse button held to dictate, or '' for none. Separate from
   *  `dictationShortcut` because its REACH differs: the keyboard binding is
   *  registered in main and fires globally, while this one is a renderer DOM
   *  listener that only fires while Agent Code has focus. See
   *  lib/mouseBinding.ts for the full WHY. Both may be set at once; whichever
   *  the user presses starts the same hold. */
  dictationMouseButton: MouseButtonBinding
  /** Mouse chord that opens the command palette, or '' for none.
   *
   *  WHY a chord rather than a single button: the palette is the door to ~60
   *  commands that have no other mouse path, so it needs a binding that works
   *  anywhere — but every single button either already has a job or is the one
   *  the user may have given to dictation. A two-button chord is reachable
   *  everywhere and collides with nothing, at the cost of being deliberate.
   *
   *  WHY the vocabulary is a closed union rather than an arbitrary mask: it
   *  keeps "right is never bindable ALONE" (see mouseBinding.ts) structurally
   *  true rather than a rule someone has to remember to enforce. */
  paletteMouseChord: MouseChordBinding
  /** When true, periodically writes Save-Debug-Logs-style bundles for
   *  every active agent session and attempts one last write during
   *  renderer unload. This is a developer-mode setting, not a
   *  user-facing polish toggle: bundles can contain large runtime,
   *  DOM, semantic, and feed-debug snapshots, so they are interval-
   *  based rather than emitted on every render. */
  aggressiveDebugPersistence: boolean
  /** When on (default), clicking a prompt-suggestion chip immediately SENDS
   *  that suggestion as the next prompt; when off, clicking only prefills the
   *  composer draft so the user can edit before submitting. The chip is an
   *  offer that appears after a turn (issue #174); most users want one click
   *  to act, hence on-by-default. The send-vs-prefill decision lives at the
   *  apply site (TileLeaf), so the chip component stays presentational. */
  autoSendPromptSuggestion: boolean
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
  /** Corner radius language for the whole app (see `CORNER_STYLES`).
   *
   *  Applied live by `applyTheme`, which writes the tier's three lengths as
   *  inline custom properties on <html> — the same mechanism as accent and
   *  font, so a change cascades through every `rounded-chip/slab/float`
   *  utility with no React re-render.
   *
   *  Never reaches the tiling grid: pane, tab, terminal, editor, and feed-row
   *  surfaces carry no radius class at any tier. */
  cornerStyle: CornerStyleId
  /** Sparse per-command picker-visibility overrides, keyed by each
   *  command's STABLE string `id`. Present boolean wins over the
   *  command's declared `pickerVisibility`: `true` = force into the
   *  picker, `false` = force out. Absent ids fall back to the declared
   *  default (so the map only ever stores deliberate user choices, not
   *  the full command catalog).
   *
   *  WHY a sparse map keyed by id, not a per-command flag or an array
   *  of hidden ids:
   *   - Survives commands being added or removed across releases: an id
   *     that no longer exists is simply never consulted (and gets
   *     pruned only if the user re-saves), and a new command picks up
   *     its declared default with no migration.
   *   - Stays tiny in localStorage — only commands the user actually
   *     touched are stored.
   *  The override is consumed by `commandVisible` in the command
   *  registry, the single picker-list chokepoint. It NEVER affects
   *  `run()` or keybindings — hiding is list-only. */
  commandVisibilityOverrides: Record<string, boolean>
  /** Commands the user has starred, keyed by stable command id. Sparse and
   *  absent-means-false, exactly like `commandVisibilityOverrides` above — the
   *  map only ever holds deliberate stars, never a full 99-entry table.
   *
   *  WHY this is a second map rather than a richer per-command record shared
   *  with visibility: visibility is consumed INSIDE `buildCommandRegistry` and
   *  therefore has to travel in `CommandContext.flags`, while starring is
   *  applied after the registry is built and must NOT be in flags — putting it
   *  there would rebuild all 99 commands (including every function title and
   *  `resolveEffectiveKeybindings`) on every single star toggle. Two maps with
   *  two lifecycles beats one map that forces the cheap one to pay the
   *  expensive one's cost. */
  commandStarred: Record<string, boolean>
  /** How the command palette orders its list while the search box is EMPTY.
   *
   *  Scope is the whole point: this never touches search results. Typing is
   *  answered by relevance alone (`rankEntries`), and a sort applied on top of
   *  that would let 'A – Z' push a tier-5 prefix match below a tier-1
   *  subsequence match — the inversion class the ranking rewrite exists to
   *  prevent. `rankCommands` enforces the split with an early return; the
   *  header control shows "Relevance" and disables itself while a query is
   *  present so the user is told, not left guessing.
   *
   *  WHY a persisted setting rather than per-open state: it is a scanning
   *  preference, not a transient one. Someone who browses by group wants to
   *  browse by group tomorrow too, and re-picking it on every palette open
   *  would make the feature not worth using.
   *
   *  Defaults to 'catalog' — today's exact behavior — which keeps the whole
   *  feature additive: nothing about the palette changes until the user asks. */
  commandSortMode: CommandSortMode
  /** Include prompt templates in the TOP-LEVEL command palette only after the
   *  user starts typing. The empty command menu remains command-only even when
   *  this is enabled; the dedicated template picker remains available in both
   *  states.
   *
   *  WHY this is opt-in rather than an unconditional catalog expansion:
   *  templates are user content, not application commands. Mixing them into
   *  every search can be useful for people who treat the palette as a global
   *  launcher, but doing it silently would change a long-standing navigation
   *  surface and make generic command queries noisier for everyone else. */
  promptTemplatesInCommandSearchEnabled: boolean
  /** Show pointer-only affordances that a keyboard user does not need — today
   *  the composer's Send and Stop buttons.
   *
   *  WHY this gates so little: the instinct is to hang every mouse affordance
   *  off one mode, but that means two UIs to keep correct forever and two sets
   *  of states every future change must be checked against. Steppers, the
   *  Dispatch "+", and command starring are harmless always-on and nobody
   *  resents them. The composer buttons are the only ones that are genuine
   *  visual noise for someone who lives on Enter, so they are the only ones
   *  behind this flag. More affordances join it only if they prove annoying in
   *  practice. */
  mouseModeEnabled: boolean
  /**
   * Whether the closed **Navigation Commands** family appears in the command
   * picker. Off by default.
   *
   * Membership is exactly six ids — Next/Previous Tab and Focus Pane
   * Left/Right/Up/Down — declared on the commands themselves via
   * `commandGroup: 'navigation'`. They duplicate chords most users already
   * have in muscle memory (Cmd+[ / Cmd+], Option+HJKL and the arrow variants),
   * so six picker rows earn their space for almost nobody while adding noise
   * to every fuzzy search for "tab" or "pane".
   *
   * CRITICAL, and the reason this is not just another
   * `commandVisibilityOverrides` entry: this is a DISCOVERABILITY gate over a
   * whole family, not an execution permission. Turning it off removes six rows
   * from a list. It does not disable Cmd+[, Option+K, the arrow variants, or
   * the underlying workspace navigation actions, and it does not stop the ids
   * being dispatched by keybinding, native menu, or programmatic call. A
   * setting that silently disabled keyboard navigation would be a functional
   * regression wearing a preference's clothes.
   *
   * The group also stays present in the context-free catalog in BOTH states,
   * so catalog validation, native lookup, diagnostics and stable ids never
   * depend on a persisted UI preference.
   */
  navigationCommandsEnabled: boolean
  /**
   * Per-command keyboard binding overrides, keyed by stable command id.
   *
   * SPARSE, with three meaningful states — absent inherits the shipped
   * defaults, `[]` is an explicit unbind, and a non-empty array replaces the
   * defaults entirely. See `command-keybindings/resolve.ts` for why absent and
   * empty must not collapse into one thing (briefly: a future release may
   * improve an untouched default, but must not resurrect a chord the user
   * deliberately removed).
   *
   * Unknown ids are preserved rather than pruned: an id that names nothing in
   * this build may belong to an extension that is temporarily uninstalled or a
   * command a downgrade removed.
   */
  commandKeybindingOverrides: Record<string, string[]>
  /** Ambient provider-quota indicator in the SettingsBar header row.
   *  On by default: quota headroom is a planning input for dispatching
   *  agent fleets, and the whole point of the feature is ambient
   *  visibility. The widget is fully unmounted when off (its polling
   *  hook lives inside the component), so the off state costs nothing. */
  usageHeaderEnabled: boolean
  /** How much of the usage snapshot the header shows. 'all' (every
   *  active limit row, compact labels) is the default per the design
   *  spec — an aggregate-only number was explicitly rejected as not
   *  enough. See docs/superpowers/specs/2026-07-12-usage-header-indicator-design.md §3. */
  usageHeaderLevel: UsageHeaderLevel
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'dark',
  savedThemes: [],
  savedPromptTemplates: [],
  dispatchColorFlags: {},
  contrast: false,
  accent: 'lime',
  customAppearanceJson: DEFAULT_CUSTOM_APPEARANCE_JSON,
  showStatusMode: true,
  showWorktreeBadges: true,
  dangerousAgentsEnabled: false,
  useProxyStreaming: false,
  dictationEnabled: false,
  dictationProvider: 'deepgram',
  // WHY the default binding is Cmd+Shift+D and not Fn (packaged-mode fix):
  // the Fn key can only be captured on macOS via a CGEventTap, which
  // requires the app to hold the Accessibility permission — an OS-level
  // prompt every user gets on first launch. Wispr Flow's own docs confirm
  // the same constraint and use Ctrl+Opt as their fallback for exactly
  // this reason. Shipping Fn as the default meant every packaged Agent
  // Code launch nagged for Accessibility before the user had chosen to
  // enable dictation at all. Cmd+Shift+D is a plain keyboard accelerator
  // that main can register via Electron globalShortcut with NO OS prompt
  // at all; power users can still switch to Fn from Settings, which
  // re-arms the Accessibility-gated CGEventTap helper. The literal string
  // matches the hotkeyBinding.ts vocabulary (see modifierParts + the
  // `mod-shift-d -> Cmd+Shift+D` alias in coerceHotkeyBinding) so it
  // round-trips through the settings persistence layer without any
  // special-casing.
  dictationShortcut: 'Cmd+Shift+D',
  // Off by default. Every bindable button already has a job — middle click
  // is paste/new-tab and the side buttons are history navigation — so
  // claiming one without the user asking would silently break a gesture they
  // rely on. Opt-in only.
  dictationMouseButton: '',
  // Off by default for the same reason as dictationMouseButton: the chord
  // suppresses both of its buttons while held, and claiming a gesture the
  // user never asked for is how you break something they relied on.
  paletteMouseChord: '',
  aggressiveDebugPersistence: false,
  defaultWorkspaceMode: 'grid',
  agentViewMode: 'agent',
  // Preserve today's opt-in behavior. Users choose which capabilities become
  // defaults; session commands remain available regardless of this empty seed.
  defaultBuiltInMcpDomains: [],
  autoSendPromptSuggestion: true,
  fontFamily: 'jetbrains-mono',
  // WHY `round` and not the historical `sharp`: this axis exists because the
  // blanket square look was retired deliberately, and defaulting to the tier
  // that changes nothing would ship the feature switched off. `sharp` remains
  // one click away and is a byte-for-byte return to the old app — strictly
  // MORE square than before, since the token floor also closes the bare
  // `rounded` 4px leak this work uncovered.
  cornerStyle: 'round',
  // Empty by default: nothing is hidden until the user opts in per
  // command. This keeps the whole feature purely additive — fresh
  // installs and existing users see the exact same picker they do today.
  commandVisibilityOverrides: {},
  // Nothing starred until the user stars something. The palette's resting
  // order is otherwise exactly the catalog order it has always been.
  commandStarred: {},
  // Catalog order is what the palette has always shown, so it stays the
  // default and the sort control is a pure opt-in.
  commandSortMode: 'catalog',
  // Off by default so upgrading users keep the exact command-search surface
  // they already know. Enabling it still leaves the empty browse menu alone.
  promptTemplatesInCommandSearchEnabled: false,
  // Off by default. The composer buttons cost ~28px of pane height per pane
  // and a keyboard user gets nothing from them, so this is opt-in.
  mouseModeEnabled: false,
  // Off on a fresh install: the six members duplicate shortcuts users already
  // have, so the default that costs nothing is the one that keeps them out of
  // the picker. Their keyboard behavior is unaffected either way.
  navigationCommandsEnabled: false,
  // Empty: every command inherits its shipped default until the user edits one.
  // Seeding this with today's defaults would pin every command to this
  // release's chords and make future default improvements invisible.
  commandKeybindingOverrides: {},
  usageHeaderEnabled: true,
  usageHeaderLevel: 'all',
}
