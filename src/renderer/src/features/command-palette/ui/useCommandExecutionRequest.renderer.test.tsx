import { StrictMode, useSyncExternalStore } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { useCommandExecutionRequest } from './useCommandExecutionRequest'
import { commandExecutionRequests } from '../commandExecutionRequests'
import { makeTestCommandContext } from '../testing/commandContextHarness'
import type { CommandContext } from '../types'

const original = useAppStore.getState()
afterEach(() => { cleanup(); vi.useRealTimers(); useAppStore.setState(original, true) })

// Exercise the actual rendezvous and dispatcher with existing catalog commands.
// This is a React admission/at-most-once probe, not a fabricated provider trace.
function Host({ context }: { context: CommandContext }) {
  const request = useSyncExternalStore(commandExecutionRequests.subscribe, commandExecutionRequests.snapshot)
  useCommandExecutionRequest(request, context)
  return null
}

it('dispatches a real hidden command once through StrictMode without changing picker visibility', async () => {
  const uiCalls: string[] = []
  const context = makeTestCommandContext({ uiCalls, focusedSessionId: 'agent',
    flags: { commandVisibilityOverrides: { 'open-settings': false } } })
  render(<StrictMode><Host context={context} /></StrictMode>)
  let result!: ReturnType<typeof commandExecutionRequests.request>
  act(() => { result = commandExecutionRequests.request({ commandId: 'open-settings', expectedSessionId: 'agent' }) })
  await act(async () => { await result })
  expect(await result).toMatchObject({ status: 'ran', source: 'programmatic' })
  expect(uiCalls).toEqual(['openSettings'])
  expect(context.flags.commandVisibilityOverrides).toEqual({ 'open-settings': false })
})

it('rejects stale selection and a competing native command before reaching the command callback', async () => {
  const uiCalls: string[] = []
  render(<Host context={makeTestCommandContext({ uiCalls, focusedSessionId: 'replacement' })} />)
  let result!: ReturnType<typeof commandExecutionRequests.request>
  act(() => { result = commandExecutionRequests.request({ commandId: 'open-settings', expectedSessionId: 'original' }) })
  await act(async () => { await result })
  expect(await result).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('selected agent changed') })
  useAppStore.setState({ pendingCommandInvocation: { id: 'open-settings', source: 'keybinding', closeAfterRun: true } })
  act(() => { result = commandExecutionRequests.request({ commandId: 'open-settings' }) })
  await act(async () => { await result })
  expect(await result).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('pending') })
  expect(uiCalls).toEqual([])
})

it('expires an unclaimed request so mounting the UI later cannot execute abandoned work', async () => {
  vi.useFakeTimers()
  const result = commandExecutionRequests.request({ commandId: 'open-settings' })
  const token = commandExecutionRequests.snapshot()!.token
  const rejected = expect(result).rejects.toMatchObject({ started: false })
  await expect(commandExecutionRequests.request({ commandId: 'open-settings' })).rejects.toThrow('pending')
  await vi.advanceTimersByTimeAsync(20_000)
  await rejected
  expect(commandExecutionRequests.claim(token)).toBe(false)
  const uiCalls: string[] = []
  render(<Host context={makeTestCommandContext({ uiCalls })} />)
  expect(uiCalls).toEqual([])
})
