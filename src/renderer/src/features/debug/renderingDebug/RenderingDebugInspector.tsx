import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  RENDER_SHAPE_LIFECYCLES,
  RENDER_SHAPE_PLANES,
  type RenderShapeLifecycle,
  type RenderShapePlane,
} from '@shared/types/renderShapes'
import { fingerprintRenderShape } from '@renderer/rendering/evidence/shapeFingerprint'
import { resolveRenderShapeDefinition } from '@providers/registry.renderShapes'
import { renderDebugSnapshot } from './registry'
import { operationDecisionDiagnostic } from './diagnostics'
import type { RenderDebugSelection, RenderDebugSnapshot } from './types'

const PREVIEW_CHARS = 100_000

type Props = {
  sessionId: string
  provider: import('@shared/types/providerKind').AgentProviderKind | 'unknown'
  onClose: () => void
}

type Bounds = { top: number; left: number; width: number; height: number }

function domPath(element: HTMLElement, pane: HTMLElement): string {
  const parts: string[] = []
  let cursor: HTMLElement | null = element
  while (cursor && cursor !== pane) {
    const tag = cursor.tagName.toLowerCase()
    const id = cursor.id ? `#${cursor.id}` : ''
    let ordinal = ''
    if (!id && cursor.parentElement) {
      const siblings = [...cursor.parentElement.children].filter(child => child.tagName === cursor!.tagName)
      if (siblings.length > 1) ordinal = `:nth-of-type(${siblings.indexOf(cursor) + 1})`
    }
    parts.unshift(`${tag}${id}${ordinal}`)
    cursor = cursor.parentElement
  }
  parts.unshift(`[data-pane-id="${pane.dataset.paneId ?? ''}"]`)
  return parts.join(' > ')
}

function selectedBounds(element: HTMLElement): Bounds {
  const rect = element.getBoundingClientRect()
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}

function exactJson(value: unknown): string {
  // Repeated references are not cycles. A global WeakSet would silently turn
  // `shapePayload: input.toolUse` into a circular-reference marker merely
  // because `input.toolUse` appeared earlier in the same diagnostic. Track the
  // active JSON ancestry instead, so only an object that points back into its
  // current parent chain is replaced while legitimate aliases remain exact.
  const ancestors: object[] = []
  return JSON.stringify(
    value,
    function (_key, item: unknown) {
      if (typeof item === 'bigint') return { __renderDebugType: 'bigint', value: item.toString() }
      if (typeof item === 'undefined') return { __renderDebugType: 'undefined' }
      if (typeof item === 'number' && !Number.isFinite(item)) {
        return { __renderDebugType: 'number', value: String(item) }
      }
      if (item instanceof Error) {
        return { name: item.name, message: item.message, stack: item.stack }
      }
      if (item !== null && typeof item === 'object') {
        while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop()
        if (ancestors.includes(item)) return { __renderDebugType: 'circular-reference' }
        ancestors.push(item)
      }
      return item
    },
    2,
  )
}

function shapeEvidence(
  provider: import('@shared/types/providerKind').AgentProviderKind | 'unknown',
  snapshot: RenderDebugSnapshot | null,
): unknown {
  if (!snapshot) return null
  if (!RENDER_SHAPE_PLANES.includes(snapshot.sourcePlane as RenderShapePlane)) return null
  if (!RENDER_SHAPE_LIFECYCLES.includes(snapshot.lifecycle as RenderShapeLifecycle)) return null
  const plane = snapshot.sourcePlane as RenderShapePlane
  const lifecycle = snapshot.lifecycle as RenderShapeLifecycle
  const fingerprint = fingerprintRenderShape({
    provider,
    plane,
    eventType: snapshot.eventType,
    payload: snapshot.shapePayload ?? snapshot.input,
  })
  const definition = resolveRenderShapeDefinition({
    provider,
    fingerprint: fingerprint.fingerprint,
    plane,
    eventType: snapshot.eventType,
    lifecycle,
  })
  return {
    ...fingerprint,
    catalog: definition
      ? {
          id: definition.id,
          disposition: definition.disposition,
          why: definition.why,
        }
      : null,
  }
}

function diagnosticRecord(
  selection: RenderDebugSelection,
  sessionId: string,
  provider: import('@shared/types/providerKind').AgentProviderKind | 'unknown',
): unknown {
  const snapshot = selection.snapshot
  return {
    schemaVersion: 1,
    capturedAt: new Date(selection.selectedAt).toISOString(),
    sessionContext: { sessionId, provider },
    selectedElement: {
      tagName: selection.selectedElement.tagName.toLowerCase(),
      domPath: selection.domPath,
      bounds: selectedBounds(selection.selectedElement),
      // This is deliberately nested as a JSON string. Consumers can parse one
      // self-contained object without juggling a sidecar HTML file.
      html: selection.selectedHtml,
      renderBoundaryHtml: selection.boundaryHtml,
      renderBoundaryId: selection.boundaryId,
    },
    renderInput: snapshot?.input ?? null,
    shapePayload: snapshot?.shapePayload ?? null,
    pairedResult: snapshot?.pairedResult ?? null,
    normalizedModel: snapshot?.normalizedModel ?? null,
    routingTrace: snapshot?.routingTrace ?? [],
    finalDecision: snapshot?.decision
      ? operationDecisionDiagnostic(snapshot.decision)
      : null,
    renderer: snapshot
      ? {
          component: snapshot.component ?? null,
          sourcePlane: snapshot.sourcePlane,
          lifecycle: snapshot.lifecycle,
          eventType: snapshot.eventType,
        }
      : null,
    shapeEvidence: shapeEvidence(provider, snapshot),
  }
}

function preview(text: string): string {
  return text.length <= PREVIEW_CHARS
    ? text
    : `${text.slice(0, PREVIEW_CHARS)}\n\n[… preview truncated; copy retains all ${text.length.toLocaleString()} characters]`
}

export function RenderingDebugInspector({ sessionId, provider, onClose }: Props) {
  const [selection, setSelection] = useState<RenderDebugSelection | null>(null)
  const [bounds, setBounds] = useState<Bounds | null>(null)
  const [copyState, setCopyState] = useState<string | null>(null)
  const selectedRef = useRef<HTMLElement | null>(null)

  const pane = useCallback((): HTMLElement | null => {
    for (const candidate of document.querySelectorAll<HTMLElement>('[data-pane-id]')) {
      if (candidate.dataset.paneId === sessionId) return candidate
    }
    return null
  }, [sessionId])

  useEffect(() => {
    const shouldIntercept = (target: EventTarget | null): target is HTMLElement => {
      if (!(target instanceof HTMLElement)) return false
      if (target.closest('[data-render-debug-ui]')) return false
      const ownerPane = target.closest<HTMLElement>('[data-pane-id]')
      return ownerPane?.dataset.paneId === sessionId
    }
    const suppress = (event: Event) => {
      if (!shouldIntercept(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }
    const select = (event: MouseEvent | PointerEvent) => {
      if (!shouldIntercept(event.target)) return
      suppress(event)
      const element = event.target
      const ownerPane = pane()
      if (!ownerPane) return
      const boundary = element.closest<HTMLElement>('[data-render-debug-id]')
      const boundaryId = boundary?.dataset.renderDebugId ?? null
      const next: RenderDebugSelection = {
        selectedAt: Date.now(),
        selectedElement: element,
        selectedHtml: element.outerHTML,
        boundaryElement: boundary,
        boundaryHtml: boundary?.outerHTML ?? null,
        boundaryId,
        snapshot: boundaryId ? renderDebugSnapshot(boundaryId) : null,
        domPath: domPath(element, ownerPane),
      }
      selectedRef.current = element
      setSelection(next)
      setBounds(selectedBounds(element))
    }
    // Capture phase is the product contract: inspection must not submit a
    // prompt, toggle a disclosure, follow a link, or activate a destructive
    // button before the debugger sees the click.
    // Selection happens on pointerdown because canceling pointerdown can stop
    // browsers from synthesizing a later compatibility click. The click
    // listener remains as an accessibility/programmatic fallback and is safe:
    // it simply refreshes the same selection if the browser emits both.
    document.addEventListener('pointerdown', select, true)
    document.addEventListener('mousedown', suppress, true)
    document.addEventListener('click', select, true)
    return () => {
      document.removeEventListener('pointerdown', select, true)
      document.removeEventListener('mousedown', suppress, true)
      document.removeEventListener('click', select, true)
    }
  }, [pane, sessionId])

  useEffect(() => {
    // The mode is global but its evidence is pane-local. Keeping a selection
    // after focus moves would pair old HTML with the new session/provider in a
    // copied record, which is worse than showing no selection at all.
    selectedRef.current = null
    setSelection(null)
    setBounds(null)
  }, [provider, sessionId])

  useEffect(() => {
    const update = () => {
      const element = selectedRef.current
      if (!element?.isConnected) {
        selectedRef.current = null
        setBounds(null)
        return
      }
      setBounds(selectedBounds(element))
    }
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    const observer = new ResizeObserver(update)
    if (selectedRef.current) observer.observe(selectedRef.current)
    return () => {
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
      observer.disconnect()
    }
  }, [selection])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const allJson = useMemo(
    () => (selection ? exactJson(diagnosticRecord(selection, sessionId, provider)) : ''),
    [provider, selection, sessionId],
  )
  const inputJson = useMemo(
    () => (selection?.snapshot ? exactJson(selection.snapshot.input) : ''),
    [selection],
  )

  const copy = useCallback(async (label: string, text: string) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopyState(`${label} copied`)
    } catch (error) {
      setCopyState(`copy failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    window.setTimeout(() => setCopyState(null), 1800)
  }, [])

  return (
    <>
      {bounds ? (
        <div
          data-render-debug-ui
          aria-hidden="true"
          className="fixed pointer-events-none border-2 border-red-500 z-[10000]"
          style={{
            top: bounds.top - 2,
            left: bounds.left - 2,
            width: bounds.width + 4,
            height: bounds.height + 4,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.65)',
          }}
        />
      ) : null}
      <aside
        data-render-debug-ui
        className="h-full w-[580px] flex-shrink-0 border-l border-red-500/60 bg-surface flex flex-col overflow-hidden font-code"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-border text-[10px] uppercase tracking-wider">
          <span className="text-red-400">Rendering Debug Mode</span>
          <div className="flex items-center gap-2">
            {copyState ? <span className="normal-case text-accent">{copyState}</span> : null}
            <button
              type="button"
              disabled={!selection}
              onClick={() => void copy('all JSON', allJson)}
              className="border border-red-500/50 rounded px-2 py-1 text-red-300 hover:bg-red-500/10 disabled:opacity-40"
            >
              Copy All as JSON
            </button>
            <button type="button" onClick={onClose} className="text-muted hover:text-ink text-[16px]">×</button>
          </div>
        </div>
        <div className="px-3 py-2 border-b border-border text-[11px] text-muted">
          Click any element in the focused pane. Its normal action is blocked. Press Esc to exit.
        </div>
        {!selection ? (
          <div className="flex-1 flex items-center justify-center text-muted text-[12px] px-8 text-center">
            Select a rendered element to inspect its input, route, receipt, and exact HTML.
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3 text-[11px]">
            <Section title="Selection">
              <div className="text-ink-dim break-all">{selection.domPath}</div>
              <div className="text-muted mt-1">
                boundary {selection.boundaryId ?? 'none'} · {selection.snapshot?.component?.name ?? 'unidentified component'}
              </div>
            </Section>
            <Section title="Routing trace">
              {selection.snapshot?.routingTrace?.length ? (
                <ol className="space-y-1">
                  {selection.snapshot.routingTrace.map(step => (
                    <li key={step.id}>
                      <span className="text-muted">{step.condition}</span>{' '}
                      <span className="text-ink">→ {step.outcome}</span>
                    </li>
                  ))}
                </ol>
              ) : <span className="text-muted">No instrumented routing boundary for this element.</span>}
            </Section>
            <Disclosure title="Exact render input" onCopy={inputJson ? () => void copy('input JSON', inputJson) : undefined}>
              <pre className="whitespace-pre-wrap break-all text-ink-dim m-0">{preview(inputJson || 'null')}</pre>
            </Disclosure>
            <Disclosure title="Exact selected outerHTML" onCopy={() => void copy('HTML', selection.selectedHtml)}>
              <pre className="whitespace-pre-wrap break-all text-ink-dim m-0">{preview(selection.selectedHtml)}</pre>
            </Disclosure>
            <Disclosure title="Complete diagnostic JSON" onCopy={() => void copy('all JSON', allJson)}>
              <pre className="whitespace-pre-wrap break-all text-ink-dim m-0">{preview(allJson)}</pre>
            </Disclosure>
          </div>
        )}
      </aside>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-[9px] uppercase tracking-wider text-muted mb-1">{title}</div>
      {children}
    </section>
  )
}

function Disclosure({
  title,
  onCopy,
  children,
}: {
  title: string
  onCopy?: () => void
  children: React.ReactNode
}) {
  return (
    <details className="border border-border rounded bg-canvas">
      <summary className="cursor-pointer select-none px-2 py-1.5 text-ink-dim">
        {title}
        {onCopy ? (
          <button
            type="button"
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              onCopy()
            }}
            className="float-right text-muted hover:text-ink"
          >
            copy
          </button>
        ) : null}
      </summary>
      <div className="border-t border-border p-2 max-h-[360px] overflow-auto">{children}</div>
    </details>
  )
}
