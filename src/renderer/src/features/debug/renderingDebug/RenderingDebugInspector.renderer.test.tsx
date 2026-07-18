import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RenderingDebugInspector } from './RenderingDebugInspector'
import { RenderDebugBoundary, RenderingDebugProvider } from './registry'

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

describe('RenderingDebugInspector', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>()

  beforeEach(() => {
    writeText.mockReset()
    writeText.mockResolvedValue(undefined)
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
        <RenderingDebugInspector
          sessionId="session-1"
          provider="codex"
          onClose={() => undefined}
        />
      </>,
    )

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
    expect(copied.selectedElement.renderBoundaryHtml).toContain('data-render-debug-id')
    expect(copied.selectedElement.domPath).toContain('[data-pane-id="session-1"]')
    expect(copied.renderInput).toEqual(input)
    expect(copied.shapePayload).toEqual(input.toolUse)
    expect(copied.renderer.component.name).toBe('CommandView')
    expect(copied.routingTrace[0].outcome).toBe('codex.rows.dispatch')
  })

  it('adds no DOM metadata while the mode is disabled', () => {
    const { container } = render(
      <RenderingDebugProvider enabled={false}>
        <RenderDebugBoundary
          snapshot={{
            sourcePlane: 'feed-entry',
            lifecycle: 'visible',
            eventType: 'assistant',
            input: { type: 'assistant' },
          }}
        >
          <div>ordinary row</div>
        </RenderDebugBoundary>
      </RenderingDebugProvider>,
    )

    expect(container.querySelector('[data-render-debug-id]')).toBeNull()
    expect(container.innerHTML).toBe('<div>ordinary row</div>')
  })
})
