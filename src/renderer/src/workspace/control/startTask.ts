import { startControlTask as start, type ControlContext } from '@control-sdk'

// Renderer transport wiring only; durable admission/result semantics live in the SDK.
export const startControlTask = (context: ControlContext, run: () => Promise<unknown>) =>
  start(context, request => window.api.controlInvoke(request), run, (callId, code) => {
    console.warn('[control] lifecycle result reporting failed', callId, code)
  })
