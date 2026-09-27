import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { FileWorkflowStore, WorkflowService, FakeAgentProvider } from 'workflow-mcp'
import { createControlExecutor, createControlRegistry } from '../../control-sdk/host'
import { FileControlHistory } from '@main/control/history/FileControlHistory'
import { taskHistoryCapabilities } from '@main/control/history/tasks'
import { workflowControlCapabilities } from './control'
// This starts the real isolated workflow worker, so it belongs to the system
// tier even though the workflow fixture never launches a provider agent.
//
// WHY a precondition (#1107): the worker is forked from the BUILT package
// (packages/workflow-mcp/dist/workflowWorker.js; see workerFilePath in runWorkflow.ts). A fresh git
// worktree has no dist, the package throws `worker-missing` inside the run, and all this test used
// to see was an operation that never completed — a 5 s waitFor timeout that looked like load. It
// now fails at once and says why. It does not build the package itself: a build inside one test is
// slow and races parallel workers; CI builds it before the suite.
const BUILT_WORKER = 'packages/workflow-mcp/dist/workflowWorker.js'
const directories: string[] = [], services: WorkflowService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.quiesce())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
it('admits a main-host task before source approval and persists external ownership through a real existing workflow run', async () => {
  expect(existsSync(BUILT_WORKER), `${BUILT_WORKER} is missing: run \`npm run build\` in packages/workflow-mcp (this test forks the built worker)`).toBe(true)
  const cwd = await mkdtemp(join(tmpdir(), 'ac-workflow-operator-')); directories.push(cwd)
  await mkdir(join(cwd, '.claude/workflows'), { recursive: true })
  await copyFile('packages/workflow-mcp/test/fixtures/workflow-corpus/minimal.js', join(cwd, '.claude/workflows/minimal.js'))
  let approve!: (allowed: boolean) => void
  const authorization = new Promise<boolean>(resolve => { approve = resolve })
  const service = new WorkflowService({ store: new FileWorkflowStore(join(cwd, 'workflow-state')), provider: new FakeAgentProvider([]), authorizeWorkflowSource: () => authorization })
  services.push(service); await service.initialize()
  const history = new FileControlHistory(join(cwd, 'control-history'))
  const registry = createControlRegistry(), owner = { kind: 'main' as const, generation: 'host' }
  const caller = { kind: 'external' as const, id: 'operator' }
  const executor = createControlExecutor({ history, instanceId: 'instance', id: randomUUID, now: () => new Date().toISOString(), catalog: () => registry.list(), dispatch: (request, context) => registry.invoke(request, context) })
  registry.register(owner, [...taskHistoryCapabilities(history, () => true), ...workflowControlCapabilities(service,
    (_context, request) => executor.invoke(request, { kind: 'application', id: 'control-main:host' }))])
  const invoke = (capabilityId: string, input: unknown) => executor.invoke({ capabilityId, input }, caller)
  const started = await invoke('workflows.start', { cwd, name: 'corpus-minimal', args: { evidence: 'existing workflow source' } })
  expect(started).toMatchObject({ ok: true, value: { accepted: true } })
  const callId = started.operation!.callId
  expect(await invoke('operations.read', { callId })).toMatchObject({ ok: true, value: { status: 'pending' } })
  // A renderer cannot report a main-host task, even with its public call ID.
  expect(await executor.invoke({ capabilityId: 'operations.finish', input: { callId, result: { ok: true, value: {} } } }, { kind: 'application', id: 'some-window' })).toMatchObject({ ok: false, error: { code: 'stale_owner' } })
  approve(true)
  let runId = ''
  await vi.waitFor(async () => {
    const task = await invoke('operations.read', { callId })
    expect(task).toMatchObject({ ok: true, value: { status: 'completed', result: { ok: true, value: { runId: expect.any(String) } } } })
    if (task.ok) runId = (task.value as { result: { value: { runId: string } } }).result.value.runId
  }, { timeout: 5000 })
  await vi.waitFor(async () => expect(await invoke('workflows.status', { cwd, runId })).toMatchObject({ ok: true, value: { ownedByCaller: true, manifest: { status: 'completed', clientId: 'agent-code-external:external:operator' } } }), { timeout: 5000 })
  const manifest = await service.status({ cwd }, runId)
  expect(await invoke('workflows.result', { cwd, runId, artifactId: manifest.result!.artifactId })).toMatchObject({ ok: true, value: { page: { content: expect.stringContaining('existing workflow source') } } })
  expect(await executor.invoke({ capabilityId: 'workflows.cancel', input: { cwd, runId } }, { kind: 'external', id: 'another-client' })).toMatchObject({ ok: false })
  expect((await service.status({ cwd }, runId)).status).toBe('completed')
})
