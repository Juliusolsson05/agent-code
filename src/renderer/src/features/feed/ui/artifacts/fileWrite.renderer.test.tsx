import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { SemanticLiveBlock } from '@renderer/session-runtime/state'
import { CodeRenderContext } from '@renderer/features/feed/context'

import {
  FileWriteCard,
  fileWriteFromLive,
} from './fileWrite'
import type { FileWriteArtifact } from './types'

function liveBlock(overrides: Partial<SemanticLiveBlock>): SemanticLiveBlock {
  return {
    blockIndex: 0,
    kind: 'tool',
    toolName: 'Write',
    toolUseId: 'write-1',
    finalized: false,
    ...overrides,
  }
}

describe('fileWriteFromLive', () => {
  it('replaces a bounded preview with exact finalized parsed content', () => {
    const exact = `preview-prefix${'-exact-tail'.repeat(20_000)}`
    const vm = fileWriteFromLive(
      liveBlock({
        finalized: true,
        // This is the provider-authoritative object. The raw input can remain a
        // capped prefix; parsedInput must win without consulting that scanner.
        inputJson: '{"file_path":"src/exact.txt","content":"preview-prefix',
        parsedInput: { file_path: 'src/exact.txt', content: exact },
      }),
      null,
      'claude',
    )

    expect(vm?.contentState).toBe('exact')
    expect(vm?.content).toBe(exact)
    expect(vm?.content.endsWith('-exact-tail')).toBe(true)
  })
})

describe('FileWriteCard preview state', () => {
  it('makes a capped live prefix explicit instead of silently freezing it', () => {
    const vm: FileWriteArtifact & { resultError: string | null } = {
      family: 'file-write',
      id: 'write:bounded',
      provider: 'claude',
      status: 'streaming',
      plane: 'live',
      toolUseId: 'bounded',
      startedAt: null,
      endedAt: null,
      filePath: 'src/generated.txt',
      content: 'first visible line\n',
      lineCount: 1,
      contentState: 'capped',
      resultError: null,
    }

    render(
      <CodeRenderContext.Provider
        value={{ sessionId: 'test', workspaceRoot: '/workspace' }}
      >
        <FileWriteCard vm={vm} />
      </CodeRenderContext.Provider>,
    )

    expect(screen.getByRole('status').textContent).toContain(
      'Live preview paused at its safety limit',
    )
    expect(screen.getByRole('status').textContent).toContain(
      'exact file will replace it',
    )
    expect(screen.getByText('1+ preview line')).toBeTruthy()
  })

  it('shows an honest preparing state before content begins', () => {
    const vm: FileWriteArtifact & { resultError: string | null } = {
      family: 'file-write',
      id: 'write:preparing',
      provider: 'claude',
      status: 'streaming',
      plane: 'live',
      toolUseId: 'preparing',
      startedAt: null,
      endedAt: null,
      filePath: 'src/empty.txt',
      content: '',
      lineCount: 0,
      contentState: 'receiving',
      resultError: null,
    }

    render(<FileWriteCard vm={vm} />)

    expect(screen.getByRole('status').textContent).toBe(
      'Receiving file content…',
    )
  })
})
