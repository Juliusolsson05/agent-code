import { beforeEach, describe, expect, it, vi } from 'vitest'

let resolvedCodexPath = ''
const execute = vi.fn()
const codexConstructor = vi.fn()

vi.mock('@main/setup/toolchain.js', () => ({
  getToolPath: () => resolvedCodexPath,
}))

vi.mock('workflow-mcp', () => {
  class TestAgentProviderFailure extends Error {
    readonly code?: string

    constructor(message: string, options: { code?: string } = {}) {
      super(message)
      this.name = 'AgentProviderFailure'
      this.code = options.code
    }
  }

  return {
    AgentProviderFailure: TestAgentProviderFailure,
    CodexAgentProvider: class {
      constructor(options: unknown) {
        codexConstructor(options)
      }

      execute(request: unknown, context: unknown) {
        return execute(request, context)
      }
    },
  }
})

const { createCodexWorkflowProvider } = await import(
  '@main/workflows/CodexWorkflowProvider.js'
)

describe('createCodexWorkflowProvider', () => {
  beforeEach(() => {
    resolvedCodexPath = ''
    execute.mockReset()
    codexConstructor.mockReset()
  })

  it('returns a durable agent failure when Codex is not configured', async () => {
    const provider = createCodexWorkflowProvider()

    expect(provider.name).toBe('codex')
    expect(codexConstructor).not.toHaveBeenCalled()
    await expect(provider.execute({} as never, {} as never)).rejects.toMatchObject({
      name: 'AgentProviderFailure',
      code: 'codex-cli-unavailable',
    })
  })

  it('always supplies the setup-resolved absolute CLI override', () => {
    resolvedCodexPath = '/opt/agent-code/bin/codex'

    createCodexWorkflowProvider()

    expect(codexConstructor).toHaveBeenCalledWith({
      codexPathOverride: '/opt/agent-code/bin/codex',
    })
  })

})
