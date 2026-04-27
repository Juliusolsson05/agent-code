import { coerceSettings } from '@renderer/app-state/settings/persistence'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const defaults = coerceSettings({})
assert(defaults.showStatusMode === true, 'showStatusMode should default on')
assert(defaults.showWorktreeBadges === true, 'showWorktreeBadges should default on')
assert(defaults.dangerousAgentsEnabled === false, 'dangerousAgentsEnabled should default off')
assert(defaults.defaultWorkspaceMode === 'grid', 'defaultWorkspaceMode should default to grid')

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

console.log('settings coercion ok')
