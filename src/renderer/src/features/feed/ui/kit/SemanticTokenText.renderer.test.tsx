import { act, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LspSemanticLegend } from '@shared/types/lsp'

import {
  decodeSemanticTokenLines,
  decorateLexicalHtml,
  useSemanticTokenLines,
} from './SemanticTokenText'

const legend: LspSemanticLegend = {
  tokenTypes: ['class', 'variable', 'function'],
  tokenModifiers: [],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function SemanticHarness({ content }: { content: string }) {
  const lines = useSemanticTokenLines({
    content,
    language: 'typescript',
    workspaceRoot: '/repo',
    documentKey: 'stable-operation:after',
  })
  return <div data-token-length={lines?.[0]?.[0]?.length ?? 'lexical'} />
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SemanticTokenText', () => {
  it('decodes relative LSP positions and clamps malformed overlong ranges', () => {
    const lines = decodeSemanticTokenLines(
      [
        0, 6, 6, 0, 0, // Widget on line 0
        1, 4, 99, 1, 0, // value on line 1, overlong response is clamped
      ],
      legend,
      'class Widget {\nlet value',
    )

    expect(lines?.[0]).toEqual([
      { start: 6, length: 6, tokenType: 'class', className: 'hljs-title class_' },
    ])
    expect(lines?.[1]).toEqual([
      { start: 4, length: 5, tokenType: 'variable', className: 'hljs-variable' },
    ])
  })

  it('preserves lexical spans while semantic identifiers upgrade in place', () => {
    const decorated = decorateLexicalHtml(
      '<span class="hljs-keyword">const</span> answer = <span class="hljs-number">42</span>',
      [
        {
          start: 6,
          length: 6,
          tokenType: 'variable',
          className: 'hljs-variable',
        },
      ],
    )

    const template = document.createElement('template')
    template.innerHTML = decorated
    expect(template.content.querySelector('.hljs-keyword')?.textContent).toBe('const')
    expect(template.content.querySelector('[data-lsp-token="variable"]')?.textContent).toBe(
      'answer',
    )
    expect(template.content.querySelector('.hljs-number')?.textContent).toBe('42')
  })

  it('keeps lexical output when the server returns no usable semantic types', () => {
    expect(decodeSemanticTokenLines([0, 0, 5, 99, 0], legend, 'const')).toBeNull()
  })

  it('keeps one virtual document, coalesces changes, and discards stale tokens', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 1
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      frames.delete(id)
    })

    const firstTokens = deferred<{ data: number[] } | null>()
    const finalTokens = deferred<{ data: number[] } | null>()
    const ensureLspLegend = vi.fn(async () => ({
      tokenTypes: ['variable'],
      tokenModifiers: [],
    }))
    const openLspDocument = vi.fn(async () => undefined)
    const changeLspDocument = vi.fn(async (_clientUri: string, _content: string) => undefined)
    const closeLspDocument = vi.fn(async () => undefined)
    const getLspSemanticTokens = vi
      .fn<() => Promise<{ data: number[] } | null>>()
      .mockImplementationOnce(() => firstTokens.promise)
      .mockImplementationOnce(() => finalTokens.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ensureLspLegend,
        openLspDocument,
        changeLspDocument,
        closeLspDocument,
        getLspSemanticTokens,
      },
    })

    const flushFrame = async () => {
      const callbacks = Array.from(frames.values())
      frames.clear()
      await act(async () => {
        callbacks.forEach(callback => callback(performance.now()))
        await Promise.resolve()
      })
    }

    const { container, rerender, unmount } = render(
      <SemanticHarness content="const old = 1" />,
    )
    await waitFor(() => expect(frames.size).toBe(1))
    await flushFrame()
    expect(getLspSemanticTokens).toHaveBeenCalledTimes(1)

    // Two provider deltas while an older semantic request is in flight must not
    // queue more full-document work. The single dirty replay below carries only
    // the newest prefix once the server has capacity again.
    rerender(<SemanticHarness content="const newer = 2" />)
    rerender(<SemanticHarness content="const final = 3" />)
    expect(frames.size).toBe(0)
    expect(getLspSemanticTokens).toHaveBeenCalledTimes(1)

    await act(async () => {
      firstTokens.resolve({ data: [0, 6, 3, 0, 0] })
      await Promise.resolve()
    })
    expect(container.firstElementChild?.getAttribute('data-token-length')).toBe('lexical')
    expect(frames.size).toBe(1)
    await flushFrame()
    await waitFor(() => expect(getLspSemanticTokens).toHaveBeenCalledTimes(2))
    expect(changeLspDocument).toHaveBeenCalledTimes(1)
    expect(changeLspDocument.mock.calls[0]?.[1]).toBe('const final = 3')

    await act(async () => {
      finalTokens.resolve({ data: [0, 6, 5, 0, 0] })
      await Promise.resolve()
    })
    expect(container.firstElementChild?.getAttribute('data-token-length')).toBe('5')
    expect(openLspDocument).toHaveBeenCalledTimes(1)

    unmount()
    expect(closeLspDocument).toHaveBeenCalledTimes(1)
  })
})
