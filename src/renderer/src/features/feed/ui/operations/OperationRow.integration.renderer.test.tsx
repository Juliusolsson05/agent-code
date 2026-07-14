import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Entry, ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import { CodeRenderContext } from '@renderer/features/feed/context'
import type { FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import { projectFeedPresentation } from '@renderer/features/feed/presentation/projectFeed'
import type { PresentationNode } from '@renderer/features/feed/presentation/types'
import { PresentationRow } from '@renderer/features/feed/ui/operations/PresentationRow'

const ORDER = {
  phase: 'content' as const,
  timeMs: 1,
  sequence: 1,
  source: 'operation-row-integration-test',
}

function conversation(
  uuid: string,
  role: 'user' | 'assistant',
  content: unknown,
): Entry {
  return {
    type: role,
    uuid,
    parentUuid: null,
    message: { role, content },
  } as Entry
}

function entryItem(entry: Entry, ordinal: number): FeedRenderItem {
  return {
    type: 'entry',
    key: `entry:${String(entry.uuid ?? ordinal)}`,
    entry,
    entryOrdinal: ordinal,
    visibleDecision: {
      key: `entry:${String(entry.uuid ?? ordinal)}`,
      entry,
      visible: true,
      reason: 'conversation',
    },
    order: { ...ORDER, sequence: ordinal },
  }
}

function projection(
  items: readonly FeedRenderItem[],
  provider: 'claude' | 'codex' | 'opencode' = 'claude',
  tools: readonly ToolUseBlock[] = [],
  results: readonly ToolResultBlock[] = [],
) {
  return projectFeedPresentation({
    items,
    provider,
    toolUseIndex: new Map(tools.map(tool => [tool.id, tool])),
    toolResultIndex: new Map(results.map(result => [result.tool_use_id, result])),
  })
}

function Rows({ nodes }: { nodes: readonly PresentationNode[] }) {
  // Keying here mirrors Feed.tsx. Rendering OperationRow directly would prove
  // that its body works, but it would miss the regression where the list key
  // changed at the semantic-to-transcript ownership hand-off and remounted an
  // otherwise stable component.
  return (
    <CodeRenderContext.Provider value={{ sessionId: 'test-session', workspaceRoot: null }}>
      {nodes.map(node => (
        <PresentationRow
          key={node.id}
          node={node}
          turnStartedAt={null}
          toolHint={null}
        />
      ))}
    </CodeRenderContext.Provider>
  )
}

describe('OperationRow presentation integration', () => {
  it('keeps the mounted operation shell through live-to-committed ownership', () => {
    const partialScript =
      'const patch = "*** Begin Patch\\n*** Update File: src/example.ts\\n@@\\n-oldValue\\n+nextValue\\n'
    const live: FeedRenderItem = {
      type: 'semantic-block',
      key: 'semantic:patch-live',
      turnId: 'turn-1',
      owner: 'semantic-current',
      block: {
        blockIndex: 0,
        kind: 'function_call',
        toolName: 'exec',
        callId: 'patch-call-1',
        argumentsJson: partialScript,
        finalized: false,
      },
      toolState: null,
      order: ORDER,
    }
    const committedTool: ToolUseBlock = {
      type: 'tool_use',
      id: 'patch-call-1',
      name: 'exec',
      input: { raw: `${partialScript}"; await tools.apply_patch(patch);` },
    }
    const liveProjection = projection([live], 'codex')
    const committedProjection = projection(
      [entryItem(conversation('assistant-patch', 'assistant', [committedTool]), 0)],
      'codex',
      [committedTool],
    )

    const { container, rerender } = render(<Rows nodes={liveProjection.nodes} />)
    const shellBefore = container.querySelector(
      '[data-operation-id="operation:codex:patch-call-1"]',
    )
    expect(shellBefore).toBeTruthy()

    rerender(<Rows nodes={committedProjection.nodes} />)

    expect(
      container.querySelector('[data-operation-id="operation:codex:patch-call-1"]'),
    ).toBe(shellBefore)
  })

  it('renders a partial unified-exec patch as a diff without exposing wrapper code', () => {
    const wrapperPrefix =
      'const patch = "*** Begin Patch\\n*** Update File: src/example.ts\\n@@\\n-const oldValue = 1\\n+const nextValue = 2\\n'
    const live: FeedRenderItem = {
      type: 'semantic-block',
      key: 'semantic:partial-patch',
      turnId: 'turn-1',
      owner: 'semantic-current',
      block: {
        blockIndex: 0,
        kind: 'function_call',
        toolName: 'exec',
        callId: 'patch-call-2',
        argumentsJson: wrapperPrefix,
        finalized: false,
      },
      toolState: null,
      order: ORDER,
    }

    const { container } = render(<Rows nodes={projection([live], 'codex').nodes} />)

    expect(screen.getByText('ApplyPatch')).toBeTruthy()
    expect(container.querySelectorAll('[data-diff-kind="+"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-diff-kind="-"]')).toHaveLength(1)
    expect(container.textContent).toContain('const nextValue = 2')
    expect(container.textContent).not.toContain('const patch =')
    expect(screen.queryByText('Source input (debug)')).toBeNull()
  })

  it('paints every committed Write line as a green addition row', () => {
    const write: ToolUseBlock = {
      type: 'tool_use',
      id: 'write-1',
      name: 'Write',
      input: {
        file_path: 'src/generated.ts',
        content: 'export const first = 1\nexport const second = 2\n',
      },
    }
    const nodeProjection = projection(
      [entryItem(conversation('assistant-write', 'assistant', [write]), 0)],
      'claude',
      [write],
    )

    const { container } = render(<Rows nodes={nodeProjection.nodes} />)
    const rows = container.querySelectorAll('[data-diff-kind="+"]')

    expect(rows).toHaveLength(2)
    expect(rows[0]?.className).toContain('bg-diff-add-bg')
    expect(rows[1]?.className).toContain('bg-diff-add-bg')
    expect(rows[0]?.textContent).toContain('export const first = 1')
    expect(rows[1]?.textContent).toContain('export const second = 2')
  })

  it('renders the base64 result carried by a live image-generation call', () => {
    const live: FeedRenderItem = {
      type: 'semantic-block',
      key: 'semantic:image-generation',
      turnId: 'turn-image',
      owner: 'semantic-current',
      block: {
        blockIndex: 0,
        kind: 'image_generation_call',
        itemId: 'image-call-1',
        finalized: true,
        imageGeneration: {
          status: 'completed',
          revisedPrompt: 'A tiny generated fixture',
          result: 'a'.repeat(64),
        },
      },
      toolState: null,
      order: ORDER,
    }

    render(<Rows nodes={projection([live], 'codex').nodes} />)

    const image = screen.getByAltText('Generated image: A tiny generated fixture')
    expect(image.getAttribute('src')).toBe(`data:image/png;base64,${'a'.repeat(64)}`)
  })

  it('streams every string from an array-shaped function output into the command row', () => {
    const call: FeedRenderItem = {
      type: 'semantic-block',
      key: 'semantic:string-array-call',
      turnId: 'turn-string-array',
      owner: 'semantic-current',
      block: {
        blockIndex: 0,
        kind: 'function_call',
        toolName: 'exec_command',
        callId: 'string-array-call',
        argumentsJson: '{"cmd":"printf output"}',
        finalized: true,
      },
      toolState: null,
      order: ORDER,
    }
    const output: FeedRenderItem = {
      type: 'semantic-block',
      key: 'semantic:string-array-output',
      turnId: 'turn-string-array',
      owner: 'semantic-current',
      block: {
        blockIndex: 1,
        kind: 'function_call_output',
        callId: 'string-array-call',
        output: ['first streamed line', 'second streamed line'],
        finalized: true,
      },
      toolState: null,
      order: { ...ORDER, sequence: 2 },
    }

    const { container } = render(<Rows nodes={projection([call, output], 'codex').nodes} />)

    // Arrival of the finalized output item must not replace the originating
    // call block and collapse the command headline back to the `…` placeholder.
    expect(container.textContent).toContain('printf output')
    expect(container.textContent).toContain('first streamed line')
    expect(container.textContent).toContain('second streamed line')
  })

  it('keeps live output visible after the committed call takes ownership', () => {
    const command: ToolUseBlock = {
      type: 'tool_use',
      id: 'committed-call-live-output',
      name: 'exec_command',
      input: { cmd: 'printf retained-command' },
    }
    const committedCall = entryItem(
      conversation('committed-call-owner', 'assistant', [command]),
      0,
    )
    const liveOutput: FeedRenderItem = {
      type: 'semantic-block',
      key: 'semantic:live-output-after-call-commit',
      turnId: 'turn-live-output-after-call-commit',
      owner: 'semantic-current',
      block: {
        blockIndex: 1,
        kind: 'function_call_output',
        callId: command.id,
        output: 'stdout survives the ownership hand-off',
        finalized: true,
      },
      toolState: null,
      order: { ...ORDER, sequence: 2 },
    }

    const { container } = render(
      <Rows nodes={projection(
        [committedCall, liveOutput],
        'codex',
        [command],
      ).nodes} />,
    )

    // The ledger intentionally keeps this exact mixed-plane interval: committed
    // call ownership must not hide stdout before its transcript result commits.
    expect(container.textContent).toContain('printf retained-command')
    expect(container.textContent).toContain('stdout survives the ownership hand-off')
  })

  it('renders every committed output event absorbed by one command operation', () => {
    const command: ToolUseBlock = {
      type: 'tool_use',
      id: 'multi-result-command',
      name: 'Bash',
      input: { command: 'run-many-output-phases' },
    }
    const first: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: command.id,
      content: 'first committed output',
    }
    const second: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: command.id,
      content: 'second committed output',
    }
    const items = [
      entryItem(conversation('multi-command-use', 'assistant', [command]), 0),
      entryItem(conversation('multi-command-first', 'user', [first]), 1),
      entryItem(conversation('multi-command-second', 'user', [second]), 2),
    ]

    const { container } = render(
      <Rows nodes={projection(items, 'claude', [command], [first, second]).nodes} />,
    )

    expect(container.querySelectorAll('[data-operation-id]')).toHaveLength(1)
    expect(container.textContent).toContain('first committed output')
    expect(container.textContent).toContain('second committed output')
  })

  it('renders a Codex spawn join as identity metadata, not a final report object', () => {
    const spawn: ToolUseBlock = {
      type: 'tool_use',
      id: 'spawn-call-1',
      name: 'spawn_agent',
      input: { agent_type: 'explorer', message: 'Inspect the renderer.' },
    }
    const join: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: spawn.id,
      content: JSON.stringify({ agent_id: 'agent-thread-1', nickname: 'Cicero' }),
    }
    const items = [
      entryItem(conversation('spawn-use', 'assistant', [spawn]), 0),
      entryItem(conversation('spawn-result', 'user', [join]), 1),
    ]

    const { container } = render(
      <Rows nodes={projection(items, 'codex', [spawn], [join]).nodes} />,
    )

    expect(container.querySelector('[data-codex-spawn-join]')?.textContent).toContain(
      'joined Cicero · agent-thread-1',
    )
    // StructuredOutput's record renderer would expose protocol field labels.
    // Their absence proves the join ACK was not mislabeled as a work report.
    expect(container.textContent).not.toContain('agent_id')
    expect(container.textContent).not.toContain('nicknameCicero')
  })

  it('renders one fleet tally above adjacent sibling spawns', () => {
    const spawns: ToolUseBlock[] = [
      {
        type: 'tool_use',
        id: 'fleet-spawn-1',
        name: 'spawn_agent',
        input: { message: 'Inspect projection' },
      },
      {
        type: 'tool_use',
        id: 'fleet-spawn-2',
        name: 'spawn_agent',
        input: { message: 'Inspect streaming' },
      },
    ]
    const items = [
      entryItem(conversation('fleet-entry', 'assistant', spawns), 0),
    ]

    const { container } = render(
      <Rows nodes={projection(items, 'codex', spawns).nodes} />,
    )

    expect(container.querySelectorAll('[data-collaboration-group]')).toHaveLength(1)
    expect(container.textContent).toContain('Spawned 2 agents')
    expect(container.querySelectorAll('[data-operation-id]')).toHaveLength(2)
  })

  it('uses projected completion status instead of a family adapter guess', () => {
    const command: ToolUseBlock = {
      type: 'tool_use',
      id: 'status-complete-command',
      name: 'local_shell',
      input: { command: 'pwd', status: 'completed' },
    }
    const items = [
      entryItem(conversation('status-complete-entry', 'assistant', [command]), 0),
    ]

    const { container } = render(
      <Rows nodes={projection(items, 'codex', [command]).nodes} />,
    )

    expect(container.textContent).toContain('Ran')
    expect(container.textContent).toContain('✓')
    expect(container.textContent).not.toContain('running')
  })

  it('renders a direct wait tool as a compact terminal continuation', () => {
    const wait: ToolUseBlock = {
      type: 'tool_use',
      id: 'wait-direct',
      name: 'wait_terminal',
      input: {},
    }
    const items = [entryItem(conversation('wait-entry', 'assistant', [wait]), 0)]

    const { container } = render(<Rows nodes={projection(items, 'codex', [wait]).nodes} />)

    expect(container.textContent).toContain('Waited for background terminal')
    expect(container.textContent).not.toContain('(no command)')
  })

  it('mounts one visible structured row for each long-tail family', () => {
    const tools: ToolUseBlock[] = [
      {
        type: 'tool_use',
        id: 'mcp-visible',
        name: 'mcp__docs__lookup',
        input: { query: 'projection receipts' },
      },
      {
        type: 'tool_use',
        id: 'collaboration-visible',
        name: 'send_message',
        input: { target: 'fixture-reader', message: 'report findings' },
      },
      {
        type: 'tool_use',
        id: 'task-visible',
        name: 'update_plan',
        input: { explanation: 'renderer verified' },
      },
      {
        type: 'tool_use',
        id: 'question-visible',
        name: 'request_user_input',
        input: {
          questions: [{ question: 'Which view should open?', header: 'View', options: [] }],
        },
      },
    ]
    const items = tools.map((tool, index) =>
      entryItem(conversation(`assistant-${tool.id}`, 'assistant', [tool]), index),
    )

    const { container } = render(<Rows nodes={projection(items, 'claude', tools).nodes} />)

    expect(container.querySelectorAll('[data-operation-id]')).toHaveLength(4)
    expect(container.querySelector('[data-operation-family="mcp"]')).toBeTruthy()
    expect(container.querySelector('[data-operation-family="collaboration"]')).toBeTruthy()
    expect(container.querySelector('[data-operation-family="task-plan"]')).toBeTruthy()
    expect(container.querySelector('[data-operation-family="question"]')).toBeTruthy()
    expect(screen.getByText('projection receipts')).toBeTruthy()
    // Non-headline parameters are deliberately lazy. Requiring their payload
    // text in the closed DOM would undo the restored-feed performance contract;
    // the operation header and family shell are the normal-view visibility
    // guarantee, while the parameter disclosure remains available on demand.
    expect(screen.getByTitle('send_message')).toBeTruthy()
    expect(screen.getByTitle('update_plan')).toBeTruthy()
    expect(screen.getByTitle('request_user_input')).toBeTruthy()
    expect(screen.getByText('2 parameters')).toBeTruthy()
  })
})
