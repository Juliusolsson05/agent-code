import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { WorkflowSourceAuthorizationRequest } from 'workflow-mcp'

type StoredApproval = {
  canonicalIdentity: string
  sourceHash: string
  approvedAt: string
}

type StoredApprovalFile = {
  version: 1
  approvals: StoredApproval[]
}

/**
 * Persist execution approval for exactly one canonical workflow source version.
 *
 * WHY name/path approval is insufficient: repository-controlled JavaScript is executable
 * orchestration. An innocuous reviewed file can be replaced in place after approval, so the grant
 * must include the SHA-256 produced from the immutable bytes Workflow MCP actually snapshots.
 */
export class WorkflowSourceApprovalStore {
  private readonly filePath: string
  private readonly approvals = new Map<string, StoredApproval>()
  private readonly prompts = new Map<string, Promise<boolean>>()
  private loaded = false

  constructor(filePath: string) {
    this.filePath = resolve(filePath)
  }

  async authorize(
    request: WorkflowSourceAuthorizationRequest,
    prompt: (request: WorkflowSourceAuthorizationRequest) => Promise<boolean>,
  ): Promise<boolean> {
    await this.load()
    const key = approvalKey(request.canonicalIdentity, request.sourceHash)
    if (this.approvals.has(key)) return true

    const existing = this.prompts.get(key)
    if (existing) return existing
    const pending = (async () => {
      if (!await prompt(request)) return false
      this.approvals.set(key, {
        canonicalIdentity: request.canonicalIdentity,
        sourceHash: request.sourceHash,
        approvedAt: new Date().toISOString(),
      })
      await this.persist()
      return true
    })()
    this.prompts.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.prompts.get(key) === pending) this.prompts.delete(key)
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true
        return
      }
      throw error
    }
    if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.approvals)) {
      throw new Error(`Workflow source approval file is invalid: ${this.filePath}`)
    }
    for (const value of parsed.approvals) {
      if (
        !isObject(value) ||
        typeof value.canonicalIdentity !== 'string' ||
        typeof value.sourceHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.sourceHash) ||
        typeof value.approvedAt !== 'string'
      ) {
        throw new Error(`Workflow source approval entry is invalid: ${this.filePath}`)
      }
      const approval = value as StoredApproval
      this.approvals.set(approvalKey(approval.canonicalIdentity, approval.sourceHash), approval)
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`
    const document: StoredApprovalFile = {
      version: 1,
      approvals: [...this.approvals.values()].sort((left, right) => (
        left.canonicalIdentity.localeCompare(right.canonicalIdentity) ||
        left.sourceHash.localeCompare(right.sourceHash)
      )),
    }
    try {
      await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.filePath)
      await chmod(this.filePath, 0o600)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }
}

function approvalKey(canonicalIdentity: string, sourceHash: string): string {
  return `${canonicalIdentity}\0${sourceHash}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
