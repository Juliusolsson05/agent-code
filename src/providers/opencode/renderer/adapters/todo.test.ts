import { describe, expect, it } from 'vitest'

import { fromOpencodeTodoUse } from '@providers/opencode/renderer/adapters/todo'

describe('OpenCode todo adapter', () => {
  it('admits the captured checklist grammar', () => {
    expect(fromOpencodeTodoUse({
      type: 'tool_use',
      id: 'todo-1',
      name: 'todowrite',
      input: { todos: [{ content: 'Verify renderer', status: 'in_progress', priority: 'high' }] },
    })).toEqual({ items: [{ content: 'Verify renderer', status: 'in_progress' }] })
  })

  it('declines name matches whose item schema drifted', () => {
    expect(fromOpencodeTodoUse({
      type: 'tool_use', id: 'todo-2', name: 'todowrite', input: { todos: [{ text: 'wrong' }] },
    })).toBeNull()
  })
})
