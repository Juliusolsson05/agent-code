import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RenderingDebugInspector } from './RenderingDebugInspector'
import { operationRoutingTrace } from './diagnostics'
import { RenderDebugBoundary, RenderingDebugProvider } from './registry'

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

function StatefulDebugChild() {
  const [count, setCount] = useState(0)
  return (
    <button type="button" onClick={() => setCount(value => value + 1)}>
      ordinary row {count}
    </button>
  )
}

describe('RenderingDebugInspector', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>()
  const save = vi.fn<(diagnosticJson: string) => Promise<void>>()
  const close = vi.fn<() => void>()

  beforeEach(() => {
    writeText.mockReset()
    writeText.mockResolvedValue(undefined)
    save.mockReset()
    save.mockResolvedValue(undefined)
    close.mockReset()
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('selects the exact descendant and copies one self-contained JSON diagnostic', async () => {
    const input = {
      toolUse: {
        type: 'tool_use',
        id: 'call-1',
        name: 'exec',
        input: { raw: 'text("hello")' },
      },
      result: null,
      live: false,
      streaming: false,
    }
    render(
      <>
        <div data-pane-id="session-1">
          <button type="button" data-testid="pane-chrome">pane control</button>
          <div data-render-debug-feed-root>
            <RenderingDebugProvider enabled>
              <RenderDebugBoundary
                snapshot={{
                  sourcePlane: 'committed-tool-use',
                  lifecycle: 'durable',
                  eventType: 'tool_use',
                  input,
                  shapePayload: input.toolUse,
                  component: { name: 'CommandView' },
                  routingTrace: [{
                    id: 'owner',
                    condition: 'Which renderer won?',
                    outcome: 'codex.rows.dispatch',
                  }],
                }}
              >
                <button type="button"><span data-testid="exact-target">hello</span></button>
              </RenderDebugBoundary>
            </RenderingDebugProvider>
          </div>
        </div>
        <RenderingDebugInspector
          sessionId="session-1"
          provider="codex"
          onSave={save}
          onClose={close}
        />
      </>,
    )

    // Pane headers and the composer share data-pane-id with Feed but are not
    // rendering evidence. Debug mode must not make that surrounding chrome
    // inert while the operator is navigating to a suspicious row.
    const paneControl = screen.getByTestId('pane-chrome')
    const paneControlClick = vi.fn()
    paneControl.addEventListener('click', paneControlClick)
    fireEvent.click(paneControl)
    expect(paneControlClick).toHaveBeenCalledOnce()

    const target = screen.getByTestId('exact-target')
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    let dispatched = true
    act(() => {
      dispatched = target.dispatchEvent(click)
    })

    expect(dispatched).toBe(false)
    expect(screen.getByText(/boundary .*CommandView/, { selector: 'div.text-muted' })).toBeInTheDocument()
    expect(document.querySelector('.border-red-500')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copy All as JSON' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))

    const copied = JSON.parse(writeText.mock.calls[0][0]) as {
      schemaVersion: number
      selectedElement: { html: string; renderBoundaryHtml: string; domPath: string }
      renderInput: typeof input
      shapePayload: typeof input.toolUse
      renderer: { component: { name: string } }
      routingTrace: { outcome: string }[]
    }
    expect(copied.schemaVersion).toBe(1)
    expect(copied.selectedElement.html).toBe(
      '<span data-testid="exact-target">hello</span>',
    )
    expect(copied.selectedElement.renderBoundaryHtml).toContain('<button type="button">')
    expect(copied.selectedElement.renderBoundaryHtml).not.toContain('data-render-debug-')
    expect(copied.selectedElement.domPath).toContain('[data-pane-id="session-1"]')
    expect(copied.renderInput).toEqual(input)
    expect(copied.shapePayload).toEqual(input.toolUse)
    expect(copied.renderer.component.name).toBe('CommandView')
    expect(copied.routingTrace[0].outcome).toBe('codex.rows.dispatch')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(JSON.parse(save.mock.calls[0][0])).toEqual(copied)

    const auxiliaryClick = new MouseEvent('auxclick', {
      bubbles: true,
      cancelable: true,
      button: 1,
    })
    expect(target.dispatchEvent(auxiliaryClick)).toBe(false)

    const claimedEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    claimedEscape.preventDefault()
    document.dispatchEvent(claimedEscape)
    expect(close).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('selects and suppresses SVG descendants instead of activating their owner', () => {
    const activate = vi.fn()
    render(
      <>
        <div data-pane-id="session-svg">
          <div data-render-debug-feed-root>
            <RenderingDebugProvider enabled>
              <RenderDebugBoundary
                snapshot={{
                  sourcePlane: 'feed-entry',
                  lifecycle: 'visible',
                  eventType: 'assistant',
                  input: { type: 'assistant' },
                }}
              >
                <button type="button" onClick={activate}>
                  <svg><path data-testid="svg-target" d="M0 0" /></svg>
                </button>
              </RenderDebugBoundary>
            </RenderingDebugProvider>
          </div>
        </div>
        <RenderingDebugInspector
          sessionId="session-svg"
          provider="claude"
          onSave={save}
          onClose={close}
        />
      </>,
    )

    fireEvent.click(screen.getByTestId('svg-target'))
    expect(activate).not.toHaveBeenCalled()
    expect(screen.getByText(/path$/)).toBeInTheDocument()
  })

  it('adds no disabled DOM metadata and preserves row state across mode toggles', () => {
    const renderTree = (enabled: boolean) => (
      <RenderingDebugProvider enabled={enabled}>
        <RenderDebugBoundary
          snapshot={{
            sourcePlane: 'feed-entry',
            lifecycle: 'visible',
            eventType: 'assistant',
            input: { type: 'assistant' },
          }}
        >
          <StatefulDebugChild />
        </RenderDebugBoundary>
      </RenderingDebugProvider>
    )
    const { container, rerender } = render(renderTree(false))

    fireEvent.click(screen.getByRole('button', { name: 'ordinary row 0' }))
    expect(screen.getByRole('button', { name: 'ordinary row 1' })).toBeInTheDocument()

    rerender(renderTree(true))
    expect(screen.getByRole('button', { name: 'ordinary row 1' })).toBeInTheDocument()
    expect(container.querySelector('[data-render-debug-start]')).toBeInTheDocument()

    rerender(renderTree(false))
    expect(screen.getByRole('button', { name: 'ordinary row 1' })).toBeInTheDocument()
    expect(container.querySelector('[data-render-debug-start]')).toBeNull()
    expect(container.querySelector('[data-render-debug-end]')).toBeNull()
    expect(container.innerHTML).toBe(
      '<button type="button">ordinary row 1</button>',
    )
  })
})

describe('operationRoutingTrace', () => {
  it('reports the result-side renderer when the selected result has a different owner', () => {
    const trace = operationRoutingTrace(
      {
        toolUse: { action: 'fallback' },
        toolResult: {
          action: 'render',
          node: null,
          receipt: { rendererId: 'claude.specialized-result' },
        },
      },
      true,
      'tool-result',
    )

    expect(trace.find(step => step.id === 'visible-owner')?.outcome).toBe(
      'claude.specialized-result',
    )
  })
})
