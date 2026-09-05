import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import type { Workspace } from '@renderer/workspace/hook'
import { settingsControlCapabilities } from './control'
const initial = useAppStore.getState()
afterEach(() => useAppStore.setState(initial, true))
it('uses registry choices/apply handlers and excludes fleet-reloading safety or managed-file controls', async () => {
  const caps = settingsControlCapabilities(() => ({ restoreStatus: 'fresh' }) as Workspace)
  const context = { requestId: 'settings', caller: { kind: 'external' as const, id: 'operator' }, owner: { kind: 'window' as const, windowId: 'one', generation: 'one' } }
  const invoke = (id: string, input: unknown) => caps.find(cap => cap.descriptor.id === id)!.execute(input, context)
  const listing = await invoke('settings.values', { limit: 200 })
  if (!listing.ok) throw new Error(JSON.stringify(listing))
  const rows = (listing.value as { items: Array<{ id: string; revision: string; value: boolean | string }> }).items
  expect(rows.some(row => ['dangerous-agents', 'external-control', 'dictation-api-key'].includes(row.id))).toBe(false)
  const setting = rows.find(row => row.id === 'high-contrast')!
  expect(await invoke('settings.set', { settingId: setting.id, revision: setting.revision, value: !setting.value })).toMatchObject({ ok: true, value: { value: !setting.value } })
  expect(useAppStore.getState().settings.contrast).toBe(!setting.value)
  expect(await invoke('settings.set', { settingId: setting.id, revision: setting.revision, value: setting.value })).toMatchObject({ ok: false, error: { code: 'stale_cursor' } })
  const select = rows.find(row => row.id === 'font-family')!
  expect(await invoke('settings.set', { settingId: select.id, revision: select.revision, value: 'not-an-option' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
})
