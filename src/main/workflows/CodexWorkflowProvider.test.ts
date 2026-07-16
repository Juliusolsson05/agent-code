import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const providerOptions = {
  providerHostFilePath: '/opt/agent-code/workflowProviderHost.js',
  codexHome: '/tmp/agent-code-workflow-codex',
  authenticationFile: '/tmp/interactive-codex/auth.json',
  prepareAuthentication: vi.fn(),
  sessionSourceHome: '/tmp/interactive-codex',
}

describe('createCodexWorkflowProvider', () => {
  beforeEach(() => {
    resolvedCodexPath = ''
    execute.mockReset()
    codexConstructor.mockReset()
  })

  it('returns a durable agent failure when Codex is not configured', async () => {
    const provider = createCodexWorkflowProvider(providerOptions)

    expect(provider.name).toBe('codex')
    expect(codexConstructor).not.toHaveBeenCalled()
    await expect(provider.execute({} as never, {} as never)).rejects.toMatchObject({
      name: 'AgentProviderFailure',
      code: 'codex-cli-unavailable',
    })
  })

  it('always supplies the setup-resolved absolute CLI override', () => {
    resolvedCodexPath = '/opt/agent-code/bin/codex'

    createCodexWorkflowProvider(providerOptions)

    expect(codexConstructor).toHaveBeenCalledWith({
      codexPathOverride: '/opt/agent-code/bin/codex',
      providerHostFilePath: '/opt/agent-code/workflowProviderHost.js',
      configurationIsolation: {
        codexHome: '/tmp/agent-code-workflow-codex',
        authenticationFile: '/tmp/interactive-codex/auth.json',
        prepareAuthentication: providerOptions.prepareAuthentication,
        sessionSourceHome: '/tmp/interactive-codex',
      },
      capabilities: { inheritedMcpServers: 'unknown' },
    })
  })

  it('attaches a hash of the actual setup-resolved executable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-codex-evidence-'))
    resolvedCodexPath = join(directory, 'codex')
    await writeFile(resolvedCodexPath, 'fixture executable bytes')

    createCodexWorkflowProvider(providerOptions)

    expect(codexConstructor).toHaveBeenCalledWith(expect.objectContaining({
      executableEvidence: {
        path: resolvedCodexPath,
        sha256: createHash('sha256').update('fixture executable bytes').digest('hex'),
      },
    }))
  })

})
