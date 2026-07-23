import { randomUUID } from 'crypto'
import type { Stats } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'path'
import { lstat, mkdir, readdir, realpath, rmdir, unlink } from 'fs/promises'

import {
  atomicWriteTextFile,
  editorFileVersion,
  readBoundedTextFile,
} from '@main/editorFileIO.js'
import { AGENT_CODE_CONVENTIONS_STATE_FILE } from '@main/storage/paths.js'
import {
  readAgentCodeConventionsState,
  resetAgentCodeConventionsState,
  writeAgentCodeConventionsState,
} from './persistence.js'
import {
  normalizeAgentCodeConventionsMarkdown,
  previewAgentCodeConventions,
  renderAgentCodeConventionsSkill,
  sha256Text,
} from './renderSkill.js'
import {
  resolveAgentCodeConventionsTargets,
  type AgentCodeConventionsTarget,
  type ResolvedAgentCodeConventionsTargets,
} from './targets.js'
import {
  AGENT_CODE_CONVENTIONS_COLLISION_MAX_BYTES,
  AGENT_CODE_CONVENTIONS_SKILL_NAME,
  createEmptyAgentCodeConventionsDocument,
  type AgentCodeConventionsConflictResolution,
  type AgentCodeConventionsDocument,
  type AgentCodeConventionsMaterialization,
  type AgentCodeConventionsMutationResult,
  type AgentCodeConventionsPendingOperation,
  type AgentCodeConventionsPreviewResult,
  type AgentCodeConventionsSnapshot,
  type AgentCodeConventionsTargetStatus,
  type ClearAgentCodeConventionsRequest,
  type SaveAgentCodeConventionsRequest,
} from '@shared/types/agentCodeConventions.js'

// See docs/design/agent-code-conventions.md for the canonical ownership and
// reconciliation invariants enforced by this service.

type ServiceOptions = {
  stateFilePath?: string
  homeDirectory?: string
  environment?: Readonly<Record<string, string | undefined>>
  resolveTargets?: () => Promise<ResolvedAgentCodeConventionsTargets>
  now?: () => Date
  operationId?: () => string
}

type FileInspection =
  | {
      kind: 'missing'
      directoryExists: boolean
      directoryEmpty: boolean
    }
  | {
      kind: 'file'
      sha256: string | null
      version: string
      fingerprint: string
      readError?: string
    }
  | { kind: 'conflict'; fingerprint: string; message: string }

type PreflightTarget = {
  target: AgentCodeConventionsTarget
  inspection: FileInspection
  existing: AgentCodeConventionsMaterialization | undefined
  overwrite?: AgentCodeConventionsConflictResolution
}

const RETIRED_PREFIX = 'retired:'

export class AgentCodeConventionsService {
  private document = createEmptyAgentCodeConventionsDocument()
  private recovery: AgentCodeConventionsSnapshot['recovery']
  private targets: ResolvedAgentCodeConventionsTargets = {
    targets: [],
    unsupportedProviders: [],
  }
  private targetStatuses: AgentCodeConventionsTargetStatus[] = []
  private targetResolutionError: string | null = null
  private initialized = false
  private mutationTail: Promise<void> = Promise.resolve()

  private readonly stateFilePath: string
  private readonly homeDirectory: string
  private readonly resolveTargetsImpl: () => Promise<ResolvedAgentCodeConventionsTargets>
  private readonly now: () => Date
  private readonly operationId: () => string

  constructor(options: ServiceOptions = {}) {
    this.stateFilePath = options.stateFilePath ?? AGENT_CODE_CONVENTIONS_STATE_FILE
    this.homeDirectory = options.homeDirectory ?? homedir()
    this.resolveTargetsImpl = options.resolveTargets ?? (() => resolveAgentCodeConventionsTargets({
      homeDirectory: this.homeDirectory,
      environment: options.environment ?? process.env,
    }))
    this.now = options.now ?? (() => new Date())
    this.operationId = options.operationId ?? randomUUID
  }

  initialize(): Promise<void> {
    return this.serialize(async () => {
      if (this.initialized) return
      try {
        const state = await readAgentCodeConventionsState(this.stateFilePath)
        this.document = state.document
        if (state.kind === 'recovery-required') {
          this.recovery = { message: state.message, stateFilePath: state.stateFilePath }
        }
        const targetsResolved = await this.resolveTargetsSafely()
        if (!this.recovery && targetsResolved) {
          this.enterRecoveryForUnsafeOwnership()
          if (!this.recovery) await this.reconcileLocked()
        }
      } catch (error) {
        // This setting is a convenience feature loaded before the first window
        // so restored agents see fresh materialization. An unexpected defect or
        // platform error must degrade that feature, never turn it into an app
        // startup dependency that prevents the user from opening Agent Code.
        this.targetStatuses = [{
          id: 'conventions-initialization',
          providers: [],
          displayPath: this.displayPath(this.stateFilePath),
          state: 'error',
          message: safeErrorMessage(error),
        }]
      }
      this.initialized = true
    })
  }

  async getSnapshot(options: { audit?: boolean } = {}): Promise<AgentCodeConventionsSnapshot> {
    await this.initialize()
    if (options.audit) return this.audit()
    return this.snapshot()
  }

  audit(): Promise<AgentCodeConventionsSnapshot> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      const targetsResolved = await this.resolveTargetsSafely()
      if (!this.recovery && targetsResolved) {
        this.enterRecoveryForUnsafeOwnership()
        if (!this.recovery) await this.reconcileLocked()
      }
      return this.snapshot()
    })
  }

  preview(markdown: string): AgentCodeConventionsPreviewResult {
    return previewAgentCodeConventions(markdown)
  }

  save(request: SaveAgentCodeConventionsRequest): Promise<AgentCodeConventionsMutationResult> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      if (this.recovery) return { ok: false, code: 'recovery-required', snapshot: this.snapshot() }
      if (request.expectedRevision !== this.document.revision) {
        return { ok: false, code: 'revision-conflict', snapshot: this.snapshot() }
      }

      const normalized = normalizeAgentCodeConventionsMarkdown(request.markdown, {
        requireContent: request.enabled,
      })
      if (!normalized.ok) {
        return {
          ok: false,
          code: 'validation',
          message: normalized.message,
          warnings: normalized.warnings,
        }
      }

      const targetsResolved = await this.resolveTargetsSafely()
      if (!targetsResolved && request.enabled) {
        return this.ioError(new Error(
          `Could not resolve provider skill targets: ${this.targetResolutionError ?? 'unknown error'}`,
        ))
      }
      if (request.enabled && this.targets.unsupportedProviders.length > 0) {
        this.targetStatuses = this.unsupportedStatuses()
        return { ok: false, code: 'unsupported', snapshot: this.snapshot() }
      }

      if (!request.enabled) {
        return this.saveDisabledLocked(normalized.value.markdown, request.expectedRevision)
      }

      const rendered = renderAgentCodeConventionsSkill(normalized.value.markdown)
      const desiredHash = sha256Text(rendered)
      const resolutions = new Map(
        (request.overwriteTargets ?? []).map(value => [value.targetId, value]),
      )
      const preflight = await this.preflightTargets(resolutions)
      const conflicts = preflight.filter(item => !this.canWritePreflight(item))
      if (conflicts.length > 0) {
        this.targetStatuses = preflight.map(item => this.preflightStatus(item, desiredHash))
        return { ok: false, code: 'target-conflict', snapshot: this.snapshot() }
      }

      const next = structuredClone(this.document)
      next.revision += 1
      next.enabled = true
      next.markdown = normalized.value.markdown
      next.updatedAt = this.now().toISOString()

      for (const item of preflight) {
        if (item.existing?.sha256 === desiredHash && item.inspection.kind === 'file'
          && item.inspection.sha256 === desiredHash) continue
        next.pendingOperations[item.target.id] = this.pendingWrite(
          item,
          desiredHash,
        )
      }

      try {
        await writeAgentCodeConventionsState(this.stateFilePath, next)
      } catch (error) {
        return this.ioError(error)
      }
      this.document = next

      const statuses: AgentCodeConventionsTargetStatus[] = []
      for (const item of preflight) {
        if (!next.pendingOperations[item.target.id]) {
          statuses.push(this.status(item.target, 'installed'))
          continue
        }
        statuses.push(await this.publishTarget(item, rendered, desiredHash))
      }
      this.targetStatuses = statuses
      await this.persistBestEffort(statuses)
      return { ok: true, snapshot: this.snapshot() }
    })
  }

  disable(expectedRevision: number): Promise<AgentCodeConventionsMutationResult> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      if (this.recovery) return { ok: false, code: 'recovery-required', snapshot: this.snapshot() }
      if (expectedRevision !== this.document.revision) {
        return { ok: false, code: 'revision-conflict', snapshot: this.snapshot() }
      }
      const result = await this.disableLocked({
        revision: this.document.revision + 1,
        markdown: this.document.markdown,
      })
      if (!result.ok) return result
      return { ok: true, snapshot: this.snapshot() }
    })
  }

  clear(request: ClearAgentCodeConventionsRequest): Promise<AgentCodeConventionsMutationResult> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      if (this.recovery) return { ok: false, code: 'recovery-required', snapshot: this.snapshot() }
      if (request.expectedRevision !== this.document.revision) {
        return { ok: false, code: 'revision-conflict', snapshot: this.snapshot() }
      }

      const nextRevision = this.document.revision + 1
      if (this.document.enabled || Object.keys(this.document.materializations).length > 0) {
        const disabled = await this.disableLocked({
          revision: nextRevision,
          markdown: this.document.markdown,
        })
        if (!disabled.ok) return disabled
      }

      if (Object.keys(this.document.materializations).length > 0) {
        await this.inspectRemainingMaterializations()
        const approvals = new Map(
          (request.abandonTargets ?? []).map(value => [value.targetId, value]),
        )
        const unresolved = this.targetStatuses.filter(status => {
          if (status.state !== 'conflict' && status.state !== 'retired') return false
          const approval = approvals.get(status.id)
          return !approval
            || !status.conflictFingerprint
            || approval.expectedConflictFingerprint !== status.conflictFingerprint
        })
        if (unresolved.length > 0) {
          return { ok: false, code: 'clear-blocked', snapshot: this.snapshot() }
        }

        // WHY abandonment deletes only ownership records: the user reviewed a
        // modified external file and explicitly chose to leave it. Treating that
        // as overwrite/delete authority would turn a data-preserving escape
        // hatch into the exact destructive behavior this feature forbids.
        for (const status of this.targetStatuses) {
          if (status.state === 'conflict' || status.state === 'retired') {
            delete this.document.materializations[status.id]
            delete this.document.pendingOperations[status.id]
          }
        }
      }

      this.document.enabled = false
      this.document.markdown = ''
      this.document.updatedAt = this.now().toISOString()
      this.document.revision = Math.max(this.document.revision, nextRevision)
      try {
        await writeAgentCodeConventionsState(this.stateFilePath, this.document)
      } catch (error) {
        return this.ioError(error)
      }
      this.targetStatuses = this.targets.targets.map(target => this.status(target, 'not-installed'))
      return { ok: true, snapshot: this.snapshot() }
    })
  }

  async resolveRevealTarget(targetId: string): Promise<string | null> {
    await this.initialize()
    const current = this.targets.targets.find(target => target.id === targetId)
    if (current) return current.skillFile
    return this.document.materializations[targetId]?.path ?? null
  }

  async resolveRecoveryFile(): Promise<string | null> {
    await this.initialize()
    return this.recovery?.stateFilePath ?? null
  }

  resetRecovery(): Promise<AgentCodeConventionsMutationResult> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      if (!this.recovery) return { ok: true, snapshot: this.snapshot() }
      try {
        await resetAgentCodeConventionsState(this.stateFilePath)
      } catch (error) {
        return this.ioError(error)
      }
      this.document = createEmptyAgentCodeConventionsDocument()
      this.recovery = undefined
      this.targetStatuses = this.targets.targets.map(target => this.status(target, 'not-installed'))
      return { ok: true, snapshot: this.snapshot() }
    })
  }

  private async saveDisabledLocked(
    markdown: string,
    expectedRevision: number,
  ): Promise<AgentCodeConventionsMutationResult> {
    if (this.document.enabled || Object.keys(this.document.materializations).length > 0) {
      return this.disableLocked({ revision: expectedRevision + 1, markdown })
    }
    this.document = {
      ...this.document,
      revision: expectedRevision + 1,
      enabled: false,
      markdown,
      updatedAt: this.now().toISOString(),
    }
    try {
      await writeAgentCodeConventionsState(this.stateFilePath, this.document)
    } catch (error) {
      return this.ioError(error)
    }
    this.targetStatuses = this.targets.targets.map(target => this.status(target, 'not-installed'))
    return { ok: true, snapshot: this.snapshot() }
  }

  private async disableLocked(options: {
    revision: number
    markdown: string
  }): Promise<AgentCodeConventionsMutationResult> {
    const next = structuredClone(this.document)
    next.enabled = false
    next.markdown = options.markdown
    next.updatedAt = this.now().toISOString()
    next.revision = options.revision
    for (const [key, record] of Object.entries(next.materializations)) {
      next.pendingOperations[key] = {
        operationId: this.operationId(),
        targetId: key,
        path: record.path,
        kind: 'delete',
        previousSha256: record.sha256,
        desiredSha256: null,
      }
    }
    try {
      await writeAgentCodeConventionsState(this.stateFilePath, next)
    } catch (error) {
      return this.ioError(error)
    }
    this.document = next

    const statuses: AgentCodeConventionsTargetStatus[] = []
    for (const [key, record] of Object.entries(next.materializations)) {
      statuses.push(await this.removeMaterialization(key, record))
    }
    for (const target of this.targets.targets) {
      if (!statuses.some(status => status.id === target.id)) {
        statuses.push(this.status(target, 'not-installed'))
      }
    }
    this.targetStatuses = statuses
    await this.persistBestEffort(statuses)
    return { ok: true, snapshot: this.snapshot() }
  }

  private async reconcileLocked(): Promise<void> {
    this.rehomeMovedMaterializations()
    if (this.document.enabled) await this.reconcileEnabledLocked()
    else await this.reconcileDisabledLocked()
  }

  private async reconcileEnabledLocked(): Promise<void> {
    if (this.targets.unsupportedProviders.length > 0) {
      this.targetStatuses = this.unsupportedStatuses()
      return
    }
    const normalized = normalizeAgentCodeConventionsMarkdown(this.document.markdown, {
      requireContent: true,
    })
    if (!normalized.ok) {
      this.targetStatuses = this.targets.targets.map(target =>
        this.status(target, 'error', normalized.message))
      return
    }
    const rendered = renderAgentCodeConventionsSkill(normalized.value.markdown)
    const desiredHash = sha256Text(rendered)
    const statuses: AgentCodeConventionsTargetStatus[] = []

    for (const target of this.targets.targets) {
      const inspection = await this.inspectTarget(target)
      const record = this.document.materializations[target.id]
      const pending = this.document.pendingOperations[target.id]
      if (inspection.kind === 'file' && inspection.sha256 === desiredHash) {
        if (record?.sha256 === desiredHash || (
          pending?.kind === 'write'
          && pending.path === target.skillFile
          && pending.desiredSha256 === desiredHash
        )) {
          this.document.materializations[target.id] = {
            path: target.skillFile,
            sha256: desiredHash,
            createdDirectory: record?.createdDirectory ?? false,
          }
          delete this.document.pendingOperations[target.id]
          statuses.push(this.status(target, 'installed'))
          continue
        }
        statuses.push(this.conflictStatus(
          target,
          inspection.fingerprint,
          'A matching skill exists, but Agent Code has no write-ahead ownership proof.',
        ))
        continue
      }
      if (inspection.kind === 'file' && record?.sha256 === inspection.sha256) {
        const item = { target, inspection, existing: record } satisfies PreflightTarget
        this.document.pendingOperations[target.id] = this.pendingWrite(item, desiredHash)
        if (!await this.persistJournalBeforeExternalMutation(statuses, target)) continue
        statuses.push(await this.publishTarget(item, rendered, desiredHash))
        continue
      }
      if (inspection.kind === 'missing') {
        const item = { target, inspection, existing: record } satisfies PreflightTarget
        this.document.pendingOperations[target.id] = this.pendingWrite(item, desiredHash)
        if (!await this.persistJournalBeforeExternalMutation(statuses, target)) continue
        statuses.push(await this.publishTarget(item, rendered, desiredHash))
        continue
      }
      if (inspection.kind === 'conflict') {
        statuses.push(this.conflictStatus(target, inspection.fingerprint, inspection.message, false))
      } else {
        statuses.push(this.conflictStatus(
          target,
          inspection.fingerprint,
          inspection.readError ?? 'The installed skill differs from Agent Code ownership state.',
        ))
      }
      delete this.document.pendingOperations[target.id]
    }

    for (const [key, record] of Object.entries(this.document.materializations)) {
      if (!key.startsWith(RETIRED_PREFIX)) continue
      if (!this.document.pendingOperations[key]) {
        this.document.pendingOperations[key] = {
          operationId: this.operationId(),
          targetId: key,
          path: record.path,
          kind: 'delete',
          previousSha256: record.sha256,
          desiredSha256: null,
        }
        if (!await this.persistJournalBeforeExternalMutation(statuses)) continue
      }
      statuses.push(await this.removeMaterialization(key, record))
    }
    this.targetStatuses = statuses
    await this.persistBestEffort(statuses)
  }

  private async reconcileDisabledLocked(): Promise<void> {
    const statuses: AgentCodeConventionsTargetStatus[] = []
    for (const [key, record] of Object.entries(this.document.materializations)) {
      if (!this.document.pendingOperations[key]) {
        this.document.pendingOperations[key] = {
          operationId: this.operationId(),
          targetId: key,
          path: record.path,
          kind: 'delete',
          previousSha256: record.sha256,
          desiredSha256: null,
        }
        if (!await this.persistJournalBeforeExternalMutation(statuses)) continue
      }
      statuses.push(await this.removeMaterialization(key, record))
    }
    for (const target of this.targets.targets) {
      if (!statuses.some(status => status.id === target.id)) {
        statuses.push(this.status(target, 'not-installed'))
      }
    }
    this.targetStatuses = statuses
    await this.persistBestEffort(statuses)
  }

  private async preflightTargets(
    resolutions: Map<string, AgentCodeConventionsConflictResolution>,
  ): Promise<PreflightTarget[]> {
    const result: PreflightTarget[] = []
    for (const target of this.targets.targets) {
      result.push({
        target,
        inspection: await this.inspectTarget(target),
        existing: this.document.materializations[target.id],
        overwrite: resolutions.get(target.id),
      })
    }
    return result
  }

  private canWritePreflight(item: PreflightTarget): boolean {
    if (item.inspection.kind === 'missing') return true
    // Directory sidecars, symlinks, and non-regular filesystem objects are not
    // ordinary replaceable-file collisions. Confirmation cannot make those
    // paths safe; the user must move/fix them outside Agent Code first.
    if (item.inspection.kind === 'conflict') return false
    if (item.existing?.path === item.target.skillFile
      && item.existing.sha256 === item.inspection.sha256) return true
    return item.overwrite?.expectedConflictFingerprint === item.inspection.fingerprint
  }

  private preflightStatus(item: PreflightTarget, desiredHash: string): AgentCodeConventionsTargetStatus {
    if (this.canWritePreflight(item)) {
      if (item.inspection.kind === 'file' && item.inspection.sha256 === desiredHash) {
        return this.status(item.target, 'installed')
      }
      return this.status(item.target, 'missing')
    }
    if (item.inspection.kind === 'conflict') {
      return this.conflictStatus(
        item.target,
        item.inspection.fingerprint,
        item.inspection.message,
        false,
      )
    }
    if (item.inspection.kind === 'missing') {
      return this.status(item.target, 'missing')
    }
    return this.conflictStatus(
      item.target,
      item.inspection.fingerprint,
      item.inspection.readError ?? 'An unmanaged skill already exists at this path.',
    )
  }

  private pendingWrite(
    item: PreflightTarget,
    desiredHash: string,
  ): AgentCodeConventionsPendingOperation {
    return {
      operationId: this.operationId(),
      targetId: item.target.id,
      path: item.target.skillFile,
      kind: 'write',
      previousSha256: item.existing?.sha256 ?? null,
      desiredSha256: desiredHash,
      expectedConflictFingerprint: item.overwrite?.expectedConflictFingerprint,
    }
  }

  private async publishTarget(
    item: PreflightTarget,
    rendered: string,
    desiredHash: string,
  ): Promise<AgentCodeConventionsTargetStatus> {
    try {
      const createdDirectory = await this.ensureTargetDirectory(item.target)
      const expectedVersion = item.inspection.kind === 'file'
        ? item.inspection.version
        : null
      if (item.inspection.kind === 'conflict') {
        const current = await this.inspectTarget(item.target)
        if (current.kind !== 'conflict'
          || current.fingerprint !== item.overwrite?.expectedConflictFingerprint) {
          delete this.document.pendingOperations[item.target.id]
          return current.kind === 'file'
            ? this.conflictStatus(item.target, current.fingerprint, 'The file changed after confirmation.')
            : this.status(item.target, 'conflict', 'The target changed after confirmation.')
        }
      }
      const result = await atomicWriteTextFile({
        absolutePath: item.target.skillFile,
        text: rendered,
        expectedVersion,
        maxBytes: AGENT_CODE_CONVENTIONS_COLLISION_MAX_BYTES,
      })
      if (!result.ok) {
        delete this.document.pendingOperations[item.target.id]
        const current = await this.inspectTarget(item.target)
        return current.kind === 'file'
          ? this.conflictStatus(item.target, current.fingerprint, 'The file changed while Agent Code was saving.')
          : this.status(item.target, 'conflict', 'The target changed while Agent Code was saving.')
      }
      this.document.materializations[item.target.id] = {
        path: item.target.skillFile,
        sha256: desiredHash,
        createdDirectory: item.existing?.createdDirectory ?? createdDirectory,
      }
      delete this.document.pendingOperations[item.target.id]
      return this.status(item.target, 'installed')
    } catch (error) {
      return this.status(item.target, 'error', safeErrorMessage(error))
    }
  }

  private async removeMaterialization(
    key: string,
    record: AgentCodeConventionsMaterialization,
  ): Promise<AgentCodeConventionsTargetStatus> {
    const target = this.targets.targets.find(value => value.id === key)
    const baseStatus = (state: AgentCodeConventionsTargetStatus['state'], message?: string) =>
      target
        ? this.status(target, state, message)
        : {
            id: key,
            providers: [],
            displayPath: this.displayPath(record.path),
            state,
            message,
          }
    try {
      const inspected = await this.inspectExactFile(record.path)
      if (inspected.kind === 'missing') {
        delete this.document.materializations[key]
        delete this.document.pendingOperations[key]
        return baseStatus('not-installed')
      }
      if (inspected.kind !== 'file' || inspected.sha256 !== record.sha256) {
        delete this.document.pendingOperations[key]
        const fingerprint = inspected.fingerprint
        return {
          ...baseStatus(key.startsWith(RETIRED_PREFIX) ? 'retired' : 'conflict',
            inspected.kind === 'conflict'
              ? inspected.message
              : 'External changes were preserved; Agent Code did not delete this file.'),
          conflictFingerprint: fingerprint,
        }
      }
      const current = await lstat(record.path)
      if (current.isSymbolicLink() || !current.isFile()
        || editorFileVersion(current) !== inspected.version) {
        delete this.document.pendingOperations[key]
        return {
          ...baseStatus('conflict', 'The file changed immediately before removal.'),
          conflictFingerprint: inspected.fingerprint,
        }
      }
      // The exact file can remain regular while one of its parent directories
      // is swapped for a symlink after inspection. Rechecking the directory
      // chain immediately before unlink prevents a persisted hash from becoming
      // authority to delete matching bytes reached through a different path.
      await this.assertNoSymlinkComponents(dirname(record.path))
      await unlink(record.path)
      if (record.createdDirectory) await rmdir(dirname(record.path)).catch(error => {
        if (!['ENOTEMPTY', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      })
      delete this.document.materializations[key]
      delete this.document.pendingOperations[key]
      return baseStatus('not-installed')
    } catch (error) {
      delete this.document.pendingOperations[key]
      return baseStatus('error', safeErrorMessage(error))
    }
  }

  private async inspectTarget(target: AgentCodeConventionsTarget): Promise<FileInspection> {
    try {
      await this.assertNoSymlinkComponents(target.skillsDirectory)
      const directory = await lstat(target.skillDirectory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!directory) return { kind: 'missing', directoryExists: false, directoryEmpty: true }
      if (directory.isSymbolicLink() || !directory.isDirectory()) {
        return this.pathConflict(target.skillDirectory, 'The skill path is not a regular directory.')
      }
      const entries = await readdir(target.skillDirectory)
      const file = await lstat(target.skillFile).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!file) {
        if (entries.length > 0) {
          return {
            kind: 'conflict',
            fingerprint: sha256Text(`${target.skillDirectory}\0${entries.sort().join('\0')}`),
            message: 'The skill directory contains files Agent Code does not own.',
          }
        }
        return { kind: 'missing', directoryExists: true, directoryEmpty: true }
      }
      return this.inspectRegularFile(target.skillFile, file)
    } catch (error) {
      return this.pathConflict(target.skillFile, safeErrorMessage(error))
    }
  }

  private async inspectExactFile(path: string): Promise<FileInspection> {
    if (!isAbsolute(path)) return this.pathConflict(path, 'Persisted ownership path is not absolute.')
    try {
      await this.assertNoSymlinkComponents(dirname(path))
    } catch (error) {
      return this.pathConflict(path, safeErrorMessage(error))
    }
    const file = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!file) return { kind: 'missing', directoryExists: false, directoryEmpty: true }
    return this.inspectRegularFile(path, file)
  }

  private async inspectRegularFile(
    path: string,
    stat: Stats,
  ): Promise<FileInspection> {
    const version = editorFileVersion(stat)
    const fingerprint = sha256Text(`${path}\0${version}`)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { kind: 'conflict', fingerprint, message: 'The target is not a regular file.' }
    }
    try {
      const read = await readBoundedTextFile(path, AGENT_CODE_CONVENTIONS_COLLISION_MAX_BYTES)
      return {
        kind: 'file',
        sha256: sha256Text(read.text),
        version: read.version,
        fingerprint: sha256Text(`${path}\0${read.version}`),
      }
    } catch (error) {
      return {
        kind: 'file',
        sha256: null,
        version,
        fingerprint,
        readError: safeErrorMessage(error),
      }
    }
  }

  private pathConflict(path: string, message: string): FileInspection {
    return {
      kind: 'conflict',
      fingerprint: sha256Text(`${path}\0${message}`),
      message,
    }
  }

  private async ensureTargetDirectory(target: AgentCodeConventionsTarget): Promise<boolean> {
    await this.ensureDirectoryTreeNoSymlinks(target.skillsDirectory)
    let created = false
    try {
      await mkdir(target.skillDirectory, { mode: 0o700 })
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await this.assertNoSymlinkComponents(target.skillDirectory)
    const canonical = await realpath(target.skillDirectory)
    const trustedHome = resolve(this.homeDirectory)
    const fromHome = relative(trustedHome, resolve(target.skillDirectory))
    const expectedCanonical = fromHome === ''
      || (!fromHome.startsWith(`..${sep}`) && fromHome !== '..' && !isAbsolute(fromHome))
      ? resolve(await realpath(trustedHome).catch(() => trustedHome), fromHome)
      : resolve(target.skillDirectory)
    if (resolve(canonical) !== expectedCanonical) {
      throw new Error('Symbolic-link skill directories are not supported')
    }
    return created
  }

  private async ensureDirectoryTreeNoSymlinks(path: string): Promise<void> {
    const { cursor: initialCursor, segments } = this.pathWalk(path)
    let cursor = initialCursor
    for (const segment of segments) {
      cursor = join(cursor, segment)
      let stat = await lstat(cursor).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!stat) {
        try {
          // Creating one component at a time prevents mkdir({recursive:true})
          // from silently following a symlink hidden in an otherwise missing
          // provider path. EEXIST is a race signal, not success: re-lstat below.
          await mkdir(cursor, { mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        stat = await lstat(cursor)
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Symbolic-link path component is not supported: ${cursor}`)
      }
      if (!stat.isDirectory()) throw new Error(`Path component is not a directory: ${cursor}`)
    }
  }

  private async assertNoSymlinkComponents(path: string): Promise<void> {
    const { cursor: initialCursor, segments } = this.pathWalk(path)
    let cursor = initialCursor
    for (const segment of segments) {
      cursor = join(cursor, segment)
      const stat = await lstat(cursor).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!stat) return
      if (stat.isSymbolicLink()) throw new Error(`Symbolic-link path component is not supported: ${cursor}`)
      if (!stat.isDirectory()) throw new Error(`Path component is not a directory: ${cursor}`)
    }
  }

  private pathWalk(path: string): { cursor: string; segments: string[] } {
    const absolute = resolve(path)
    const trustedHome = resolve(this.homeDirectory)
    const fromHome = relative(trustedHome, absolute)
    if (fromHome === '' || (!fromHome.startsWith(`..${sep}`) && fromHome !== '..' && !isAbsolute(fromHome))) {
      // The effective home is inherited from the same environment as provider
      // processes, so it is the trust anchor. Rejecting symlinks above it would
      // incorrectly reject macOS /var-backed temporary homes and user accounts
      // reached through an administrator-chosen mount alias; provider-owned
      // components below home remain fully checked.
      return { cursor: trustedHome, segments: fromHome.split(sep).filter(Boolean) }
    }
    const root = parse(absolute).root
    return {
      cursor: root,
      segments: absolute.slice(root.length).split(sep).filter(Boolean),
    }
  }

  private rehomeMovedMaterializations(): void {
    const currentTargets = new Map(this.targets.targets.map(target => [target.id, target]))
    for (const [key, record] of Object.entries(this.document.materializations)) {
      if (key.startsWith(RETIRED_PREFIX)) continue
      const target = currentTargets.get(key)
      if (target && resolve(record.path) === resolve(target.skillFile)) continue
      // A provider removal and a provider root move are the same ownership
      // problem: the old copy still exists, but it is no longer a current
      // publish target. Retiring unknown ids as well as moved known ids keeps
      // those artifacts visible and eligible for hash-proven cleanup.
      const retiredKey = `${RETIRED_PREFIX}${key}:${sha256Text(record.path).slice(0, 12)}`
      this.document.materializations[retiredKey] = record
      delete this.document.materializations[key]
      const pending = this.document.pendingOperations[key]
      if (pending) {
        this.document.pendingOperations[retiredKey] = { ...pending, targetId: retiredKey }
        delete this.document.pendingOperations[key]
      }
    }
  }

  private enterRecoveryForUnsafeOwnership(): void {
    const problem = this.persistedOwnershipProblem()
    if (!problem) return
    // A syntactically valid state file can still contain a path that is too
    // broad to use as deletion authority. Treat it exactly like a newer schema:
    // preserve the original bytes, expose recovery, and perform no provider
    // mutation until the user deliberately resets the state.
    this.recovery = {
      message: `Conventions ownership state is unsafe: ${problem} The original file was preserved.`,
      stateFilePath: this.stateFilePath,
    }
  }

  private persistedOwnershipProblem(): string | null {
    const currentTargets = new Map(this.targets.targets.map(target => [target.id, target]))
    const currentPaths = new Set(this.targets.targets.map(target => resolve(target.skillFile)))

    for (const [key, record] of Object.entries(this.document.materializations)) {
      if (!this.isSafePersistedSkillPath(record.path, currentPaths)) {
        return `materialization ${key} points outside an allowed skill path.`
      }
    }

    for (const [key, operation] of Object.entries(this.document.pendingOperations)) {
      if (operation.targetId !== key) return `pending operation ${key} has a mismatched target id.`
      if (!this.isSafePersistedSkillPath(operation.path, currentPaths)) {
        return `pending operation ${key} points outside an allowed skill path.`
      }
      if (operation.kind === 'write') {
        const target = currentTargets.get(key)
        const record = this.document.materializations[key]
        const currentWrite = target
          && resolve(operation.path) === resolve(target.skillFile)
        const journaledHistoricalWrite = record
          && resolve(record.path) === resolve(operation.path)
          && operation.previousSha256 === record.sha256
        if ((!currentWrite && !journaledHistoricalWrite) || operation.desiredSha256 === null) {
          return `pending write ${key} does not match a current provider target.`
        }
        continue
      }
      const record = this.document.materializations[key]
      if (!record
        || resolve(record.path) !== resolve(operation.path)
        || operation.previousSha256 !== record.sha256
        || operation.desiredSha256 !== null) {
        return `pending delete ${key} does not match its ownership record.`
      }
    }
    return null
  }

  private isSafePersistedSkillPath(path: string, currentPaths: Set<string>): boolean {
    if (!isAbsolute(path) || resolve(path) !== path) return false
    if (basename(path) !== 'SKILL.md'
      || basename(dirname(path)) !== AGENT_CODE_CONVENTIONS_SKILL_NAME
      || basename(dirname(dirname(path))) !== 'skills') return false

    const absolute = resolve(path)
    if (currentPaths.has(absolute)) return true
    const fromHome = relative(resolve(this.homeDirectory), absolute)
    return fromHome === ''
      || (!fromHome.startsWith(`..${sep}`) && fromHome !== '..' && !isAbsolute(fromHome))
  }

  private async inspectRemainingMaterializations(): Promise<void> {
    const statuses: AgentCodeConventionsTargetStatus[] = []
    for (const [key, record] of Object.entries(this.document.materializations)) {
      const inspection = await this.inspectExactFile(record.path)
      const state = key.startsWith(RETIRED_PREFIX) ? 'retired' : 'conflict'
      const target = this.targets.targets.find(value => value.id === key)
      const status: AgentCodeConventionsTargetStatus = target
        ? this.status(target, state, 'External changes remain on disk.')
        : {
            id: key,
            providers: [],
            displayPath: this.displayPath(record.path),
            state,
            message: 'External changes remain on disk.',
          }
      if (inspection.kind === 'file' || inspection.kind === 'conflict') {
        status.conflictFingerprint = inspection.fingerprint
      }
      statuses.push(status)
    }
    this.targetStatuses = statuses
  }

  private async resolveTargetsSafely(): Promise<boolean> {
    try {
      this.targets = await this.resolveTargetsImpl()
      this.targetResolutionError = null
      return true
    } catch (error) {
      this.targetResolutionError = safeErrorMessage(error)
      this.targets = { targets: [], unsupportedProviders: [] }
      this.targetStatuses = [{
        id: 'provider-target-resolution',
        providers: [],
        displayPath: '',
        state: 'error',
        message: safeErrorMessage(error),
      }]
      return false
    }
  }

  private async persistBestEffort(statuses: AgentCodeConventionsTargetStatus[]): Promise<void> {
    try {
      await writeAgentCodeConventionsState(this.stateFilePath, this.document)
    } catch (error) {
      statuses.push({
        id: 'conventions-state',
        providers: [],
        displayPath: this.displayPath(this.stateFilePath),
        state: 'error',
        message: safeErrorMessage(error),
      })
    }
  }

  private async persistJournalBeforeExternalMutation(
    statuses: AgentCodeConventionsTargetStatus[],
    target?: AgentCodeConventionsTarget,
  ): Promise<boolean> {
    try {
      await writeAgentCodeConventionsState(this.stateFilePath, this.document)
      return true
    } catch (error) {
      // WHY this is not the best-effort final persistence path: without a
      // durable pending entry, a crash after the next provider-file mutation
      // would leave bytes that Agent Code can neither prove nor safely clean.
      // Availability loses to ownership truth at this exact boundary.
      statuses.push(target
        ? this.status(target, 'error', safeErrorMessage(error))
        : {
            id: 'conventions-state',
            providers: [],
            displayPath: this.displayPath(this.stateFilePath),
            state: 'error',
            message: safeErrorMessage(error),
          })
      return false
    }
  }

  private snapshot(): AgentCodeConventionsSnapshot {
    const normalized = normalizeAgentCodeConventionsMarkdown(this.document.markdown, {
      requireContent: false,
    })
    return {
      revision: this.document.revision,
      enabled: this.document.enabled,
      markdown: this.document.markdown,
      updatedAt: this.document.updatedAt,
      health: this.health(),
      warnings: normalized.ok ? normalized.value.warnings : [],
      unsupportedProviders: this.targets.unsupportedProviders,
      recovery: this.recovery,
      targets: [...this.targetStatuses].sort((left, right) => left.id.localeCompare(right.id)),
    }
  }

  private health(): AgentCodeConventionsSnapshot['health'] {
    if (this.recovery) return 'recovery-required'
    if (this.targets.unsupportedProviders.length > 0) return 'unsupported'
    if (this.targetStatuses.some(status => status.state === 'conflict' || status.state === 'retired')) {
      return 'conflict'
    }
    if (this.targetStatuses.some(status => status.state === 'error' || status.state === 'missing')) {
      return 'degraded'
    }
    if (this.document.enabled) {
      return this.targetStatuses.length > 0
        && this.targetStatuses.every(status => status.state === 'installed')
        ? 'active'
        : 'degraded'
    }
    return 'disabled'
  }

  private unsupportedStatuses(): AgentCodeConventionsTargetStatus[] {
    return this.targets.unsupportedProviders.map(provider => ({
      id: `unsupported:${provider}`,
      providers: [provider],
      displayPath: '',
      state: 'unsupported',
      message: 'This provider does not declare personal Agent Skill support.',
    }))
  }

  private status(
    target: AgentCodeConventionsTarget,
    state: AgentCodeConventionsTargetStatus['state'],
    message?: string,
  ): AgentCodeConventionsTargetStatus {
    return {
      id: target.id,
      providers: target.providers,
      displayPath: this.displayPath(target.skillDirectory),
      state,
      message,
    }
  }

  private conflictStatus(
    target: AgentCodeConventionsTarget,
    fingerprint: string,
    message: string,
    canOverwrite = true,
  ): AgentCodeConventionsTargetStatus {
    return {
      ...this.status(target, 'conflict', message),
      canOverwrite,
      conflictFingerprint: fingerprint,
    }
  }

  private displayPath(path: string): string {
    const absolute = resolve(path)
    const rel = relative(this.homeDirectory, absolute)
    if (rel === '') return '~'
    if (!rel.startsWith('..') && !isAbsolute(rel)) return `~${sep}${rel}`
    return absolute
  }

  private ioError(error: unknown): AgentCodeConventionsMutationResult {
    return {
      ok: false,
      code: 'io-error',
      message: safeErrorMessage(error),
      snapshot: this.snapshot(),
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(task, task)
    this.mutationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async ensureInitializedLocked(): Promise<void> {
    if (this.initialized) return
    const state = await readAgentCodeConventionsState(this.stateFilePath)
    this.document = state.document
    if (state.kind === 'recovery-required') {
      this.recovery = { message: state.message, stateFilePath: state.stateFilePath }
    }
    const targetsResolved = await this.resolveTargetsSafely()
    if (!this.recovery && targetsResolved) {
      this.enterRecoveryForUnsafeOwnership()
      if (!this.recovery) await this.reconcileLocked()
    }
    this.initialized = true
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Unknown filesystem error'
}
