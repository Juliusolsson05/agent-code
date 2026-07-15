import { describe, expect, it, vi } from 'vitest'

const storeInitialize = vi.fn(async () => undefined)
const serviceInitialize = vi.fn(async () => undefined)
const stores: Array<{ root: string }> = []
const services: Array<{ options: Record<string, unknown> }> = []

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => name === 'userData' ? '/tmp/agent-code-user-data' : '',
  },
  utilityProcess: { fork: vi.fn() },
}))

vi.mock('workflow-mcp', () => ({
  FileWorkflowStore: class {
    constructor(root: string) {
      stores.push({ root })
    }

    initialize = storeInitialize
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
  it('initializes durable storage without eagerly constructing Codex', async () => {
    const service = await createWorkflowService()

    expect(service).toBeDefined()
    expect(stores).toEqual([{ root: '/tmp/agent-code-user-data/workflows' }])
    expect(storeInitialize).toHaveBeenCalledOnce()
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
  })
})
