import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'

const original = useAppStore.getState()
afterEach(() => useAppStore.setState(original, true))

it('switches bulk policies atomically without changing individual followers or workspace placement', () => {
  const runtimes = { reader: emptyRuntime(), follower: { ...emptyRuntime(), tailMode: true } }
  useAppStore.setState({ tailAllMode: true, tailWorkingMode: false, workspaceRuntimes: runtimes })
  const workspace = useAppStore.getState().workspaceState
  useAppStore.getState().toggleTailWorkingMode()
  expect(useAppStore.getState()).toMatchObject({ tailAllMode: false, tailWorkingMode: true })
  useAppStore.getState().toggleTailWorkingMode()
  expect(useAppStore.getState()).toMatchObject({ tailAllMode: false, tailWorkingMode: false })
  useAppStore.getState().toggleTailWorkingMode()
  useAppStore.getState().toggleTailAllMode()
  expect(useAppStore.getState()).toMatchObject({ tailAllMode: true, tailWorkingMode: false })
  useAppStore.getState().toggleTailAllMode()
  expect(useAppStore.getState()).toMatchObject({ tailAllMode: false, tailWorkingMode: false })
  expect(useAppStore.getState().workspaceRuntimes).toBe(runtimes)
  expect(useAppStore.getState().workspaceState).toBe(workspace)
})
