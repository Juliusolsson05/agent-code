import { useEffect, useRef } from 'react'
import { createControlRegistry } from '@control-sdk/host'
import {
  controlFailure, controlRegistrationSchema, rendererControlResponseSchema,
  type RegisteredCapability,
} from '@control-sdk'
import { workspaceControlCapabilities } from '@renderer/workspace/control'
import { agentControlCapabilities } from '@renderer/workspace/control/agents'
import { draftControlCapabilities } from '@renderer/workspace/control/drafts'
import { conditionControlCapabilities } from '@renderer/workspace/control/conditions'
import { layoutControlCapabilities } from '@renderer/workspace/control/layout'
import { editorControlCapabilities } from '@renderer/features/global-editor/control'
import { commandControlCapabilities } from '@renderer/features/command-palette/control'
import { keybindingControlCapabilities } from '@renderer/features/command-keybindings/control'
import { createAgentReadControl } from '@renderer/features/feed/controlRead/control'
import { documentationCapabilities } from './documentation'
import type { Workspace } from '@renderer/workspace/hook'

export async function registerRendererHost(capabilities: readonly RegisteredCapability[]): Promise<() => void> {
  const generation = crypto.randomUUID()
  const registry = createControlRegistry()
  // Install the receiver before publishing descriptors. Requests that arrive
  // before the IPC acknowledgement wait for registration rather than racing it.
  let ready: Promise<void>
  const off = window.api.onControlRequest(async message => {
    if (message.context.owner.generation !== generation) return
    try {
      await ready
      const result = await registry.invoke(message.request, message.context)
      await window.api.controlRespond(rendererControlResponseSchema.parse({
        requestId: message.context.requestId, generation, result,
      }))
    } catch {
      await window.api.controlRespond(rendererControlResponseSchema.parse({
        requestId: message.context.requestId, generation,
        result: controlFailure('failed', 'Renderer control transport failed', 'unknown'),
      })).catch(() => {})
    }
  })
  let unregister: (() => void) | undefined
  ready = Promise.resolve().then(() => window.api.controlRegister(controlRegistrationSchema.parse({
    generation, capabilities: capabilities.map(capability => capability.descriptor),
  }))).then(owner => { unregister = registry.register(owner, capabilities) })
  try {
    await ready
  } catch (error) {
    off()
    await window.api.controlUnregister(generation).catch(() => {})
    throw error
  }
  return () => {
    off()
    unregister?.()
    void window.api.controlUnregister(generation).catch(() => {})
  }
}

export function useControlRegistration(workspace: Workspace): void {
  const current = useRef(workspace)
  current.current = workspace
  useEffect(() => {
    // Optional desktop integration: the phone client and small renderer tests
    // have no control transport. Their ordinary UI must continue to work.
    if (!window.api?.controlRegister) return
    const reads = createAgentReadControl()
    let stopped = false
    let dispose: (() => void) | undefined
    void registerRendererHost([
      ...workspaceControlCapabilities(() => current.current),
      ...agentControlCapabilities(() => current.current),
      ...draftControlCapabilities(() => current.current),
      ...conditionControlCapabilities(),
      ...layoutControlCapabilities(() => current.current),
      ...editorControlCapabilities(),
      ...commandControlCapabilities(),
      ...keybindingControlCapabilities(),
      ...documentationCapabilities(),
      ...reads.capabilities,
    ]).then(cleanup => {
      if (stopped) cleanup()
      else dispose = cleanup
    }).catch(error => console.warn('[control] registration failed:', error))
    return () => { stopped = true; dispose?.(); reads.dispose() }
  }, [])
}
