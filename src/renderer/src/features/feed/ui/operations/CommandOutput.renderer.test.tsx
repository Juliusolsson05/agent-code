import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CodeRenderContext } from '@renderer/features/feed/context'
import { CommandCard } from '@renderer/features/feed/ui/artifacts/command'
import type { CommandArtifact } from '@renderer/features/feed/ui/artifacts/types'

function command(
  output: string,
  status: CommandArtifact['status'] = 'complete',
  commandText = 'npm test',
): CommandArtifact {
  return {
    family: 'command',
    id: 'command-test',
    provider: 'codex',
    status,
    plane: 'committed',
    toolUseId: 'command-test',
    startedAt: null,
    endedAt: null,
    command: commandText,
    cwd: '/workspace/project',
    description: null,
    sourceTool: 'exec_command',
    output,
    exitCode: 0,
    durationMs: 120,
    yieldTimeMs: null,
    maxOutputTokens: null,
    stdinWrites: [],
    parsedRead: null,
  }
}

function renderCommand(
  output: string,
  status: CommandArtifact['status'] = 'complete',
  commandText?: string,
) {
  return render(
    <CodeRenderContext.Provider value={{ sessionId: 'test', workspaceRoot: '/workspace/project' }}>
      <CommandCard vm={command(output, status, commandText)} />
    </CodeRenderContext.Provider>,
  )
}

describe('CommandOutput', () => {
  it('adds structured JSON without consuming the original raw output', () => {
    const raw = '{"ok":true,"changed":2}'
    renderCommand(raw)

    expect(screen.getByText('Completed')).toBeTruthy()
    expect(screen.getByText('changed')).toBeTruthy()
    // The exact source bytes are still in OutputWell below the interpretation.
    expect(screen.getByText(raw)).toBeTruthy()
  })

  it('keeps incomplete JSON as raw streaming-compatible terminal text only', () => {
    const raw = '{"ok":true,"changed":'
    const { container } = renderCommand(raw)

    expect(container.querySelector('[data-command-output-enrichment]')).toBeNull()
    expect(screen.getByText(raw)).toBeTruthy()
  })

  it('defers structural summaries until the command reaches a terminal status', () => {
    const raw = '{"ok":true,"changed":2}'
    const { container } = renderCommand(raw, 'running')

    expect(container.querySelector('[data-command-output-enrichment]')).toBeNull()
    expect(screen.getByText(raw)).toBeTruthy()
  })

  it('lets keyboard users expand and collapse a truncated command', () => {
    const fullCommand = `printf '${'x'.repeat(220)}'`
    renderCommand('', 'complete', fullCommand)

    const commandToggle = screen.getByRole('button', { name: /^Show full command:/ })
    expect(commandToggle.getAttribute('aria-expanded')).toBe('false')
    expect(commandToggle.textContent).not.toBe(fullCommand)

    fireEvent.keyDown(commandToggle, { key: 'Enter' })
    expect(screen.getByRole('button', { name: /^Show shortened command:/ }).textContent).toBe(
      fullCommand,
    )

    fireEvent.keyDown(screen.getByRole('button', { name: /^Show shortened command:/ }), {
      key: ' ',
    })
    expect(screen.getByRole('button', { name: /^Show full command:/ })).toBeTruthy()
  })

  it('renders test counts, workspace diagnostics, and safe links above raw ANSI output', () => {
    const raw = [
      '\u001b[32mTests  3 passed | 1 skipped (4)\u001b[0m',
      'src/feed.tsx:12:4: warning unused value',
      'Report: https://example.com/report.',
    ].join('\n')
    renderCommand(raw)

    expect(screen.getByText('3 passed')).toBeTruthy()
    expect(screen.getByText('1 skipped')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'src/feed.tsx:12:4' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'https://example.com/report' })).toBeTruthy()
    // ANSI is interpreted into spans, but its human-visible source remains in
    // the lossless raw output region below the summaries.
    expect(screen.getAllByText(/Tests\s+3 passed/).length).toBeGreaterThan(0)
  })
})
