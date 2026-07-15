import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const serviceInitialize = vi.fn(async () => undefined)
const stores: Array<{ root: string }> = []
const services: Array<{ options: Record<string, unknown> }> = []

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => name === 'userData'
      ? '/tmp/agent-code-user-data'
      : '/tmp/agent-code-home',
  },
  utilityProcess: { fork: vi.fn() },
}))

vi.mock('workflow-mcp', () => ({
  FileWorkflowStore: class {
    constructor(root: string) {
      stores.push({ root })
    }
  },
  WorkflowService: class {
    constructor(options: Record<string, unknown>) {
      services.push({ options })
    }

    initialize = serviceInitialize
  },
}))

const providerFactory = vi.fn()
vi.mock('@main/workflows/CodexWorkflowProvider.js', () => ({
  createCodexWorkflowProvider: providerFactory,
}))

const { createWorkflowService } = await import(
  '@main/workflows/createWorkflowService.js'
)

describe('createWorkflowService', () => {
  beforeEach(() => {
    vi.stubEnv('CODEX_HOME', '/tmp/agent-code-home/.codex')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('lets WorkflowService acquire storage ownership before initialization without eagerly constructing Codex', async () => {
    const service = await createWorkflowService()

    expect(service).toBeDefined()
    expect(stores).toEqual([{ root: '/tmp/agent-code-user-data/workflows' }])
    expect(serviceInitialize).toHaveBeenCalledOnce()
    expect(providerFactory).not.toHaveBeenCalled()
    expect(services[0]!.options).toMatchObject({
      provider: expect.any(Function),
      sandbox: {
        mode: 'read-only',
        approvalPolicy: 'never',
        network: false,
      },
      modelAliases: {
        inherit: null,
        haiku: null,
        sonnet: null,
        opus: null,
      },
    })
    expect(services[0]!.options.workerFilePath).toMatch(/workflowWorker\.js$/)

    const provider = services[0]!.options.provider as () => unknown
    provider()
    expect(providerFactory).toHaveBeenCalledWith({
      providerHostFilePath: expect.stringMatching(/workflowProviderHost\.js$/),
      codexHome: '/tmp/agent-code-user-data/workflows/codex-home',
      authenticationFile: '/tmp/agent-code-home/.codex/auth.json',
    })
  })
})
