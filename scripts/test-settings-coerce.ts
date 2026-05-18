import { coerceSettings } from '@renderer/app-state/settings/persistence'
import {
  parseCustomAppearanceJson,
  stringifyCustomAppearance,
} from '@renderer/app-state/settings/customAppearance'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const defaults = coerceSettings({})
assert(defaults.showStatusMode === true, 'showStatusMode should default on')
assert(defaults.showWorktreeBadges === true, 'showWorktreeBadges should default on')
assert(defaults.dangerousAgentsEnabled === false, 'dangerousAgentsEnabled should default off')
assert(defaults.defaultWorkspaceMode === 'grid', 'defaultWorkspaceMode should default to grid')
assert(defaults.dictationShortcut === 'Fn', 'dictation shortcut should default to Fn')
assert(
  defaults.customAppearanceJson.includes('"canvas"'),
  'customAppearanceJson should default to a full raw JSON payload',
)

const coerced = coerceSettings({
  mode: 'not-a-theme',
  accent: 'not-an-accent',
  contrast: 'yes',
  customRendering: 1,
  showStatusMode: false,
  showWorktreeBadges: false,
  dangerousAgentsEnabled: true,
  useProxyStreaming: true,
})

assert(coerced.mode === 'dark', 'invalid theme should fall back to default')
assert(coerced.accent === 'lime', 'invalid accent should fall back to default')
assert(coerced.contrast === false, 'contrast should only accept boolean true')
assert(coerced.customRendering === false, 'customRendering should only accept boolean true')
assert(coerced.showStatusMode === false, 'showStatusMode should preserve explicit false')
assert(coerced.showWorktreeBadges === false, 'showWorktreeBadges should preserve explicit false')
assert(coerced.dangerousAgentsEnabled === true, 'dangerousAgentsEnabled should accept true')
assert(coerced.useProxyStreaming === true, 'useProxyStreaming should accept true')
assert(coerced.dictationShortcut === 'Fn', 'missing dictation shortcut should fall back to Fn')

const customDictationShortcut = coerceSettings({ dictationShortcut: 'Ctrl+Shift+SPACE' })
assert(
  customDictationShortcut.dictationShortcut === 'Ctrl+Shift+SPACE',
  'dictation shortcut should accept arbitrary captured bindings',
)

const legacyDictationShortcut = coerceSettings({ dictationShortcut: 'mod-shift-d' })
assert(
  legacyDictationShortcut.dictationShortcut === 'Cmd+Shift+D',
  'legacy dictation shortcut ids should migrate to captured binding strings',
)

const dispatchPick = coerceSettings({ defaultWorkspaceMode: 'dispatch' })
assert(
  dispatchPick.defaultWorkspaceMode === 'dispatch',
  'defaultWorkspaceMode should accept "dispatch"',
)

const bogusMode = coerceSettings({ defaultWorkspaceMode: 'unrecognized' })
assert(
  bogusMode.defaultWorkspaceMode === 'grid',
  'unknown defaultWorkspaceMode should fall back to grid',
)

// fontFamily: default + valid pick + bogus fallback. Same shape as
// the existing mode/accent/workspace-mode coverage; the field is
// curated so the validation surface is just "id is in the list".
assert(defaults.fontFamily === 'jetbrains-mono', 'fontFamily should default to jetbrains-mono')

const spaceMonoPick = coerceSettings({ fontFamily: 'space-mono' })
assert(spaceMonoPick.fontFamily === 'space-mono', 'fontFamily should accept a curated id')

const bogusFont = coerceSettings({ fontFamily: 'comic-sans' })
assert(bogusFont.fontFamily === 'jetbrains-mono', 'unknown fontFamily should fall back to default')

const customTheme = coerceSettings({
  mode: 'custom',
  customAppearanceJson: stringifyCustomAppearance({
    ...parseCustomAppearanceJson(defaults.customAppearanceJson),
    canvas: '#101010',
  }),
})
assert(customTheme.mode === 'custom', 'theme mode should accept custom')
assert(
  customTheme.customAppearanceJson.includes('#101010'),
  'valid customAppearanceJson should be preserved and normalized',
)

const invalidCustomTheme = coerceSettings({
  mode: 'custom',
  customAppearanceJson: '{"canvas":"#000"}',
})
assert(
  invalidCustomTheme.customAppearanceJson === defaults.customAppearanceJson,
  'invalid customAppearanceJson should fall back to default payload',
)

const urlInjectedTheme = coerceSettings({
  mode: 'custom',
  customAppearanceJson: stringifyCustomAppearance({
    ...parseCustomAppearanceJson(defaults.customAppearanceJson),
    canvas: 'url(http://example.invalid/pixel)',
  }),
})
assert(
  urlInjectedTheme.customAppearanceJson === defaults.customAppearanceJson,
  'customAppearanceJson should reject non-color url() values',
)

console.log('settings coercion ok')
