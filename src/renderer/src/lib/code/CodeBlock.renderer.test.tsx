import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReactNode } from 'react'

import { CodeBlock } from './CodeBlock'
import { INERT_RENDERER_HOST, RendererHostProvider } from '@renderer/features/rendererHost/RendererHostContext'

const monacoRuntime = vi.hoisted(() => ({
  getMonaco: vi.fn(),
}))

vi.mock('@renderer/lib/code/monacoRuntime', () => ({
  ensureSemanticProvider: vi.fn(),
  getMonaco: monacoRuntime.getMonaco,
}))

// Monaco is a HOST capability since #1177: a block only reaches the editor
// path when the mounting app supplies the runtime loader. These tests act as
// the desktop host, handing CodeBlock the (mocked) runtime module.
const desktopHost = {
  ...INERT_RENDERER_HOST,
  loadMonacoRuntime: () => import('@renderer/lib/code/monacoRuntime'),
}
function WithMonacoHost({ children }: { children: ReactNode }) {
  return <RendererHostProvider host={desktopHost}>{children}</RendererHostProvider>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => {
    resolve = next
  })
  return { promise, resolve }
}

function fakeMonaco() {
  const createModel = vi.fn(() => ({ dispose: vi.fn() }))
  const create = vi.fn(() => ({
    dispose: vi.fn(),
    getContentHeight: vi.fn(() => 48),
    layout: vi.fn(),
    onDidContentSizeChange: vi.fn(() => ({ dispose: vi.fn() })),
    updateOptions: vi.fn(),
  }))

  return {
    MarkerSeverity: {
      Error: 8,
      Warning: 4,
      Info: 2,
      Hint: 1,
    },
    Uri: { parse: vi.fn((value: string) => value) },
    editor: {
      create,
      createModel,
      setModelMarkers: vi.fn(),
    },
  }
}

describe('CodeBlock Monaco readiness', () => {
  beforeEach(() => {
    monacoRuntime.getMonaco.mockReset()
  })

  it('keeps the replacement placeholder until its exact editor generation is ready', async () => {
    const monaco = fakeMonaco()
    const supersededBuild = deferred<typeof monaco>()
    const currentBuild = deferred<typeof monaco>()
    monacoRuntime.getMonaco
      .mockResolvedValueOnce(monaco)
      .mockReturnValueOnce(supersededBuild.promise)
      .mockReturnValueOnce(currentBuild.promise)

    const view = render(
      <CodeBlock code="const first = 1" language="typescript" engine="monaco" />,
      { wrapper: WithMonacoHost },
    )

    await waitFor(() => {
      expect(view.container.querySelector('.code-block-static')).not.toBeInTheDocument()
    })

    view.rerender(<CodeBlock code="const second = 2" language="javascript" engine="monaco" />)
    expect(view.container.querySelector('.code-block-static')).toHaveTextContent('const second = 2')

    await waitFor(() => expect(monacoRuntime.getMonaco).toHaveBeenCalledTimes(2))
    view.rerender(<CodeBlock code={'{"third":true}'} language="json" engine="monaco" />)
    expect(view.container.querySelector('.code-block-static')).toHaveTextContent('{"third":true}')

    await waitFor(() => expect(monacoRuntime.getMonaco).toHaveBeenCalledTimes(3))
    await act(async () => {
      supersededBuild.resolve(monaco)
      await supersededBuild.promise
    })

    // WHY this checks the visible content instead of only editor creation:
    // the user-facing regression was a blank frame. A stale async completion
    // is harmless only if it cannot retire the lexical layer belonging to the
    // newer render, regardless of how far the abandoned build progressed.
    expect(view.container.querySelector('.code-block-static')).toHaveTextContent('{"third":true}')

    await act(async () => {
      currentBuild.resolve(monaco)
      await currentBuild.promise
    })
    await waitFor(() => {
      expect(view.container.querySelector('.code-block-static')).not.toBeInTheDocument()
    })

    expect(monaco.editor.createModel).toHaveBeenCalledTimes(2)
    expect(monaco.editor.createModel).toHaveBeenLastCalledWith('{"third":true}', 'json', expect.anything())
  })

  it('renders a Monaco request through the static engine on a host without a runtime', () => {
    // The phone's case: no loader, so the block must paint the same static
    // hljs layer and never start an editor. This replaced a phone-only stub
    // CodeBlock that re-implemented the static engine by hand.
    const view = render(<CodeBlock code="const phone = 1" language="typescript" engine="monaco" />)
    expect(view.container.querySelector('.code-block-static')).toHaveTextContent('const phone = 1')
    expect(view.container.querySelector('.code-block-shell')).not.toBeInTheDocument()
    expect(monacoRuntime.getMonaco).not.toHaveBeenCalled()
  })
})
