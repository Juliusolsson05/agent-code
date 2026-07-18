import { isValidElement, type ReactNode } from 'react'

import type {
  ProviderOperationDecision,
  ProviderResultDecision,
} from '@shared/types/providerConfig'
import type { RenderDebugTraceStep } from './types'

export function routeDiagnostic(route: ProviderResultDecision | null): unknown {
  if (route === null) return null
  if (route.action === 'fallback') return { action: 'fallback' }
  if (route.action === 'absorb') {
    return {
      action: 'absorb',
      ownerRenderId: route.ownerRenderId,
      protocolId: route.protocolId ?? null,
      reason: route.reason,
    }
  }
  return {
    action: 'render',
    receipt: route.receipt,
    component: reactComponentName(route.node),
  }
}

export function operationDecisionDiagnostic(decision: ProviderOperationDecision): unknown {
  return {
    toolUse: routeDiagnostic(decision.toolUse),
    toolResult: routeDiagnostic(decision.toolResult),
  }
}

export function operationRoutingTrace(
  decision: ProviderOperationDecision,
  resultPresent: boolean,
): RenderDebugTraceStep[] {
  const use = decision.toolUse
  const result = decision.toolResult
  return [
    {
      id: 'paired-result',
      condition: 'Was a correlated result available when the operation renderer ran?',
      outcome: resultPresent ? 'present' : 'absent',
    },
    {
      id: 'provider-tool-use-route',
      condition: 'Which explicit provider operation route claimed the invocation?',
      outcome: use.action,
      evidence: routeDiagnostic(use),
    },
    {
      id: 'provider-tool-result-route',
      condition: 'Which route owns the correlated result evidence?',
      outcome: result === null ? 'not-applicable' : result.action,
      evidence: routeDiagnostic(result),
    },
    {
      id: 'visible-owner',
      condition: 'What ultimately owns the selected visible operation?',
      outcome:
        use.action === 'render'
          ? `${use.receipt.rendererId}${use.receipt.protocolId ? ` / ${use.receipt.protocolId}` : ''}`
          : use.action === 'absorb'
            ? `${use.ownerRenderId}${use.protocolId ? ` / ${use.protocolId}` : ''}`
            : 'shared.generic-tool',
    },
  ]
}

export function reactComponentName(node: ReactNode): string | null {
  if (!isValidElement(node)) return null
  const type = node.type
  if (typeof type === 'string') return type
  if (typeof type === 'function') {
    const fn = type as { displayName?: string; name?: string }
    return fn.displayName ?? fn.name ?? null
  }
  if (typeof type === 'object' && type !== null) {
    const candidate = type as { displayName?: unknown; name?: unknown; type?: unknown }
    if (typeof candidate.displayName === 'string') return candidate.displayName
    if (typeof candidate.name === 'string') return candidate.name
    if (typeof candidate.type === 'function') {
      const fn = candidate.type as { displayName?: string; name?: string }
      return fn.displayName ?? fn.name ?? null
    }
  }
  return null
}

export function reactNodeModel(node: ReactNode): unknown {
  if (!isValidElement(node)) return undefined
  const props = node.props as Record<string, unknown>
  // Provider views consistently call their presentation object `model`. This
  // best-effort extraction is debug metadata only; routing never depends on it.
  // A missing model remains explicit instead of attempting to inspect rendered
  // component internals or re-run an adapter after the fact.
  return props.model
}
