import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { isAbsolute, relative, resolve, sep } from 'path'

import { atomicWriteTextFile } from '@main/editorFileIO.js'
import {
  AGENT_CODE_CONVENTIONS_STATE_FILE,
  AGENT_CODE_INSTALLED_SKILL_SNAPSHOTS_DIR,
} from '@main/storage/paths.js'
import {
  readAgentCodeConventionsState,
  resetAgentCodeConventionsState,
  writeAgentCodeConventionsState,
} from './persistence.js'
import {
  previewAgentCodeCustomSkill,
  normalizeAgentCodeCustomSkill,
  renderAgentCodeCustomSkill,
} from './renderCustomSkill.js'
import {
  AgentCodeCustomSkillOwnershipPolicy,
  customArtifactKey,
} from './customSkillOwnershipPolicy.js'
import {
  GitHubSkillSource,
  GitHubSkillSourceError,
  type GitHubSkillDiscoveryPayload,
  type StagedInstalledSkillCandidate,
} from './githubSkillSource.js'
import { InstalledSkillPackageStore } from './installedSkillPackageStore.js'
import { InstalledSkillMaterializer } from './installedSkillMaterializer.js'
import {
  AgentCodeInstalledSkillOwnershipPolicy,
  installedArtifactKey,
} from './installedSkillOwnershipPolicy.js'
import {
  normalizeAgentCodeConventionsMarkdown,
  previewAgentCodeConventions,
  renderAgentCodeConventionsSkill,
  sha256Text,
} from './renderSkill.js'
import {
  journalCaptureDirectory,
  journalTemporaryPath,
  SkillPathSafety,
  type FileInspection,
} from './skillPathSafety.js'
import {
  AgentCodeConventionsOwnershipPolicy,
  RETIRED_CONVENTIONS_TARGET_PREFIX,
} from './ownershipPolicy.js'
import {
  resolveAgentCodeConventionsTargets,
  targetsForSkillName,
  type AgentCodeConventionsTarget,
  type ResolvedAgentCodeConventionsTargets,
} from './targets.js'
import {
  AGENT_CODE_CONVENTIONS_COLLISION_MAX_BYTES,
  createEmptyAgentCodeConventionsDocument,
  type AgentCodeConventionsConflictResolution,
  type AgentCodeConventionsDocument,
  type AgentCodeConventionsMaterialization,
  type AgentCodeConventionsMutationResult,
  type AgentCodeConventionsPendingOperation,
  type AgentCodeConventionsPreviewResult,
  type AgentCodeConventionsSnapshot,
  type AgentCodeConventionsTargetStatus,
  type AgentCodeInstalledSkillPendingOperation,
  type AgentCodeInstalledSkillRecord,
  type ClearAgentCodeConventionsRequest,
  type SaveAgentCodeConventionsRequest,
} from '@shared/types/agentCodeConventions.js'
import {
  AGENT_CODE_CUSTOM_SKILL_MAX_COUNT,
  type AgentCodeCustomSkill,
  type AgentCodeCustomSkillDraft,
  type AgentCodeCustomSkillPreviewResult,
  type AgentCodeCustomSkillsMutationResult,
  type AgentCodeCustomSkillsSnapshot,
  type CreateAgentCodeCustomSkillRequest,
  type DeleteAgentCodeCustomSkillRequest,
  type SetAgentCodeCustomSkillEnabledRequest,
  type UpdateAgentCodeCustomSkillRequest,
} from '@shared/types/agentCodeCustomSkills.js'
import {
  AGENT_CODE_INSTALLED_SKILL_DISCOVERY_TTL_MS,
  AGENT_CODE_INSTALLED_SKILL_MAX_COUNT,
  AGENT_CODE_INSTALLED_SKILL_MAX_STAGED_DISCOVERIES,
  type AgentCodeInstalledSkillCandidate,
  type AgentCodeInstalledSkillDiscovery,
  type AgentCodeInstalledSkillDiscoveryResult,
  type AgentCodeInstalledSkillFileChanges,
  type AgentCodeInstalledSkillsMutationResult,
  type AgentCodeInstalledSkillsSnapshot,
  type AgentCodeInstalledSkillUpdateResult,
  type ApplyAgentCodeInstalledSkillUpdateRequest,
  type DeleteAgentCodeInstalledSkillRequest,
  type InstallAgentCodeGitHubSkillsRequest,
  type SetAgentCodeInstalledSkillEnabledRequest,
} from '@shared/types/agentCodeInstalledSkills.js'
import type { AgentCodeCustomSkillRecord } from '@shared/types/agentCodeConventions.js'

// See docs/design/agent-code-conventions.md for the canonical ownership and
// reconciliation invariants enforced by this service.

type ServiceOptions = {
  stateFilePath?: string
  homeDirectory?: string
  environment?: Readonly<Record<string, string | undefined>>
  resolveTargets?: () => Promise<ResolvedAgentCodeConventionsTargets>
  now?: () => Date
  operationId?: () => string
  githubSkillSource?: Pick<GitHubSkillSource, 'discover'>
  installedSkillSnapshotRoot?: string
  installedSkillSnapshotMaxBytes?: number
  pathSafety?: SkillPathSafety
}

type PreflightTarget = {
  target: AgentCodeConventionsTarget
  inspection: FileInspection
  existing: AgentCodeConventionsMaterialization | undefined
  overwrite?: AgentCodeConventionsConflictResolution
}

type CustomPreflightTarget = {
  target: AgentCodeConventionsTarget
  inspection: FileInspection
  key: string
  existing: AgentCodeConventionsMaterialization | undefined
}

type InstalledPreflightTarget = {
  target: AgentCodeConventionsTarget
  key: string
  existing: AgentCodeConventionsDocument['installedMaterializations'][string] | undefined
  writable: boolean
  conflictMessage?: string
  conflictFingerprint?: string
}

type StagedInstalledDiscovery = {
  discovery: AgentCodeInstalledSkillDiscovery
  candidates: Map<string, StagedInstalledSkillCandidate>
  expiresAtMs: number
}

export class AgentCodeManagedSkillsService {
  private document = createEmptyAgentCodeConventionsDocument()
  private recovery: AgentCodeConventionsSnapshot['recovery']
  private targets: ResolvedAgentCodeConventionsTargets = {
    targets: [],
    unsupportedProviders: [],
  }
  private targetStatuses: AgentCodeConventionsTargetStatus[] = []
  private customTargetStatuses = new Map<string, AgentCodeConventionsTargetStatus[]>()
  private installedTargetStatuses = new Map<string, AgentCodeConventionsTargetStatus[]>()
  private targetResolutionError: string | null = null
  private journalWriteCollisions = new Map<string, string>()
  private initialized = false
  private mutationTail: Promise<void> = Promise.resolve()

  private readonly stateFilePath: string
  private readonly homeDirectory: string
  private readonly pathSafety: SkillPathSafety
  private readonly ownershipPolicy = new AgentCodeConventionsOwnershipPolicy()
  private readonly customOwnershipPolicy = new AgentCodeCustomSkillOwnershipPolicy()
  private readonly installedOwnershipPolicy = new AgentCodeInstalledSkillOwnershipPolicy()
  private readonly resolveTargetsImpl: () => Promise<ResolvedAgentCodeConventionsTargets>
  private readonly now: () => Date
  private readonly operationId: () => string
  private readonly githubSkillSource: Pick<GitHubSkillSource, 'discover'>
  private readonly installedSkillPackageStore: InstalledSkillPackageStore
  private readonly installedSkillMaterializer: InstalledSkillMaterializer
  private readonly stagedInstalledDiscoveries = new Map<string, StagedInstalledDiscovery>()

  constructor(options: ServiceOptions = {}) {
    this.stateFilePath = options.stateFilePath ?? AGENT_CODE_CONVENTIONS_STATE_FILE
    this.homeDirectory = options.homeDirectory ?? homedir()
    this.pathSafety = options.pathSafety ?? new SkillPathSafety(this.homeDirectory)
    this.resolveTargetsImpl = options.resolveTargets ?? (() => resolveAgentCodeConventionsTargets({
      homeDirectory: this.homeDirectory,
      environment: options.environment ?? process.env,
    }))
    this.now = options.now ?? (() => new Date())
    this.operationId = options.operationId ?? randomUUID
    this.githubSkillSource = options.githubSkillSource ?? new GitHubSkillSource()
    this.installedSkillPackageStore = new InstalledSkillPackageStore(
      options.installedSkillSnapshotRoot ?? AGENT_CODE_INSTALLED_SKILL_SNAPSHOTS_DIR,
      options.installedSkillSnapshotMaxBytes,
    )
    this.installedSkillMaterializer = new InstalledSkillMaterializer(
      this.pathSafety,
      this.installedSkillPackageStore,
    )
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
          this.rehomeMovedMaterializations()
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
        for (const skill of Object.values(this.document.customSkills)) {
          this.customTargetStatuses.set(skill.id, [{
            id: 'managed-skills-initialization',
            providers: [],
            displayPath: this.displayPath(this.stateFilePath),
            state: 'error',
            message: safeErrorMessage(error),
          }])
        }
        for (const skill of Object.values(this.document.installedSkills)) {
          this.installedTargetStatuses.set(skill.id, [{
            id: 'managed-skills-initialization',
            providers: [],
            displayPath: this.displayPath(this.stateFilePath),
            state: 'error',
            message: safeErrorMessage(error),
          }])
        }
      }
      this.initialized = true
    })
  }

  getSnapshot(options: { audit?: boolean } = {}): Promise<AgentCodeConventionsSnapshot> {
    if (options.audit) return this.audit()
    return this.serialize(async () => {
      // Snapshot reads share the mutation queue. Without this, a renderer
      // refresh could observe the new document with the previous operation's
      // status list during an awaited provider write.
      await this.ensureInitializedLocked()
      return this.snapshot()
    })
  }

  audit(): Promise<AgentCodeConventionsSnapshot> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      const targetsResolved = await this.resolveTargetsSafely()
      if (!this.recovery && targetsResolved) {
        this.rehomeMovedMaterializations()
        this.enterRecoveryForUnsafeOwnership()
        if (!this.recovery) await this.reconcileLocked()
      }
      return this.snapshot()
    })
  }

  preview(markdown: string): AgentCodeConventionsPreviewResult {
    return previewAgentCodeConventions(markdown)
  }

  getCustomSkillsSnapshot(options: { audit?: boolean } = {}): Promise<AgentCodeCustomSkillsSnapshot> {
    if (options.audit) {
      return this.audit().then(() => this.customSnapshot())
    }
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      return this.customSnapshot()
    })
  }

  previewCustomSkill(draft: AgentCodeCustomSkillDraft): AgentCodeCustomSkillPreviewResult {
    return previewAgentCodeCustomSkill(draft)
  }

  async discoverGitHubSkills(inputUrl: string): Promise<AgentCodeInstalledSkillDiscoveryResult> {
    try {
      const payload = await this.githubSkillSource.discover(inputUrl)
      return { ok: true, discovery: this.stageInstalledDiscovery(payload) }
    } catch (error) {
      return installedDiscoveryError(error)
    }
  }

  getInstalledSkillsSnapshot(
    options: { audit?: boolean } = {},
  ): Promise<AgentCodeInstalledSkillsSnapshot> {
    if (options.audit) {
      return this.audit().then(() => this.installedSnapshot())
    }
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      return this.installedSnapshot()
    })
  }

  installGitHubSkills(
    request: InstallAgentCodeGitHubSkillsRequest,
  ): Promise<AgentCodeInstalledSkillsMutationResult> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      const unavailable = this.installedMutationUnavailable(request.expectedRevision)
      if (unavailable) return unavailable
      const staged = this.getStagedInstalledDiscovery(request.discoveryId)
      if (!staged) {
        return { ok: false, code: 'expired', message: 'That GitHub skill review expired. Discover it again.' }
      }
      const candidateIds = [...new Set(request.candidateIds)]
      if (candidateIds.length === 0 || candidateIds.length !== request.candidateIds.length) {
        return { ok: false, code: 'validation', message: 'Choose one or more unique reviewed skills.' }
      }
      const candidates = candidateIds.map(id => staged.candidates.get(id))
      if (candidates.some(candidate => !candidate)) {
        return { ok: false, code: 'validation', message: 'The selected skill was not part of that review.' }
      }
      if (Object.keys(this.document.installedSkills).length + candidates.length
        > AGENT_CODE_INSTALLED_SKILL_MAX_COUNT) {
        return {
          ok: false,
          code: 'validation',
          message: `Agent Code manages at most ${AGENT_CODE_INSTALLED_SKILL_MAX_COUNT} installed skills.`,
        }
      }
      const selected = candidates as StagedInstalledSkillCandidate[]
      const selectedNames = selected.map(value => value.candidate.name)
      if (new Set(selectedNames).size !== selectedNames.length) {
        return { ok: false, code: 'validation', message: 'The review contains duplicate skill names.' }
      }
      const managedNames = this.managedSkillNames()
      const collision = selectedNames.find(name => managedNames.has(name))
      if (collision) {
        return {
          ok: false,
          code: 'validation',
          message: `A managed skill already uses the name ${collision}.`,
        }
      }
      const prepared = await this.prepareInstalledMutation(true)
      if (!prepared.ok) return prepared.result

      const timestamp = this.now().toISOString()
      const records = selected.map(candidate => ({
        candidate,
        record: {
          id: this.operationId(),
          name: candidate.candidate.name,
          description: candidate.candidate.description,
          enabled: true,
          source: candidate.candidate.source,
          snapshotDigest: candidate.snapshotDigest,
          files: candidate.candidate.files,
          warnings: candidate.candidate.warnings,
          createdAt: timestamp,
          updatedAt: timestamp,
        } satisfies AgentCodeInstalledSkillRecord,
      }))
      const preflights = new Map<string, InstalledPreflightTarget[]>()
      for (const { record } of records) {
        const preflight = await this.preflightInstalledTargets(record)
        preflights.set(record.id, preflight)
        const conflicts = preflight.filter(item => !item.writable)
        if (conflicts.length > 0) {
          const targets = preflight.map(item => this.installedPreflightStatus(item))
          this.installedTargetStatuses.set(record.id, targets)
          return {
            ok: false,
            code: 'target-conflict',
            message: `A personal skill named ${record.name} already exists outside Agent Code.`,
            snapshot: this.installedSnapshot(),
            targets,
          }
        }
      }

      try {
        // Persist immutable bytes only after every provider destination has
        // passed preflight. A collision is a normal rejected installation and
        // should not quietly accumulate unreferenced package snapshots.
        for (const value of records) await this.installedSkillPackageStore.store(value.candidate)
      } catch (error) {
        await this.removeUnreferencedInstalledSnapshots(
          records.map(value => value.candidate.snapshotDigest),
        )
        return this.installedIoError(error)
      }

      const next = structuredClone(this.document)
      next.revision += 1
      for (const { record } of records) {
        next.installedSkills[record.id] = record
        for (const item of preflights.get(record.id)!) {
          next.installedPendingOperations[item.key] = this.pendingInstalledSync(record, item)
        }
      }
      try {
        await writeAgentCodeConventionsState(this.stateFilePath, next)
      } catch (error) {
        await this.removeUnreferencedInstalledSnapshots(
          records.map(value => value.candidate.snapshotDigest),
        )
        return this.installedIoError(error)
      }
      this.document = next
      this.stagedInstalledDiscoveries.delete(request.discoveryId)
      for (const { record } of records) await this.applyInstalledOperationsLocked(record)
      await this.persistInstalledBestEffort()
      return { ok: true, snapshot: this.installedSnapshot() }
    })
  }

  setInstalledSkillEnabled(
    request: SetAgentCodeInstalledSkillEnabledRequest,
  ): Promise<AgentCodeInstalledSkillsMutationResult> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      const unavailable = this.installedMutationUnavailable(request.expectedRevision)
      if (unavailable) return unavailable
      const skill = this.document.installedSkills[request.skillId]
      if (!skill) return this.installedNotFound()
      if (skill.enabled === request.enabled) return { ok: true, snapshot: this.installedSnapshot() }
      if (!request.enabled) {
        return this.disableInstalledLocked(skill, this.document.revision + 1)
      }

      const prepared = await this.prepareInstalledMutation(true)
      if (!prepared.ok) return prepared.result
      try {
        await this.installedSkillPackageStore.verify(skill.snapshotDigest, skill.files)
      } catch (error) {
        return this.installedIoError(error)
      }
      const preflight = await this.preflightInstalledTargets(skill)
      if (preflight.some(item => !item.writable)) {
        const targets = preflight.map(item => this.installedPreflightStatus(item))
        this.installedTargetStatuses.set(skill.id, targets)
        return {
          ok: false,
          code: 'target-conflict',
          message: 'A personal skill with this name already exists or changed outside Agent Code.',
          snapshot: this.installedSnapshot(),
          targets,
        }
      }
      const next = structuredClone(this.document)
      next.revision += 1
      next.installedSkills[skill.id] = {
        ...skill,
        enabled: true,
        updatedAt: this.now().toISOString(),
      }
      for (const item of preflight) {
        next.installedPendingOperations[item.key] = this.pendingInstalledSync(skill, item)
      }
      try {
        await writeAgentCodeConventionsState(this.stateFilePath, next)
      } catch (error) {
        return this.installedIoError(error)
      }
      this.document = next
      await this.applyInstalledOperationsLocked(this.document.installedSkills[skill.id]!)
      await this.persistInstalledBestEffort()
      return { ok: true, snapshot: this.installedSnapshot() }
    })
  }

  async checkInstalledSkillForUpdates(
    skillId: string,
  ): Promise<AgentCodeInstalledSkillUpdateResult> {
    const current = await this.serialize(async () => {
      await this.ensureInitializedLocked()
      return this.document.installedSkills[skillId]
        ? structuredClone(this.document.installedSkills[skillId])
        : null
    })
    if (!current) return { ok: false, code: 'not-found', message: 'Installed skill not found.' }
    try {
      const payload = await this.githubSkillSource.discover(current.source.skillUrl)
      const candidate = payload.candidates.find(value =>
        value.candidate.name === current.name
        && value.candidate.source.path === current.source.path
        && value.candidate.source.requestedRef === current.source.requestedRef
        && value.candidate.source.requestedRefType === current.source.requestedRefType)
      if (!candidate) {
        return {
          ok: false,
          code: 'not-found',
          message: 'The exact skill path no longer exists upstream. Agent Code did not follow a rename.',
        }
      }
      if (candidate.snapshotDigest === current.snapshotDigest
        && candidate.candidate.source.resolvedCommit === current.source.resolvedCommit) {
        return { ok: true, kind: 'up-to-date' }
      }
      const discovery = this.stageInstalledDiscovery({ ...payload, candidates: [candidate] })
      return {
        ok: true,
        kind: 'update-available',
        discovery,
        candidate: candidate.candidate,
        changes: installedFileChanges(current.files, candidate.candidate.files),
      }
    } catch (error) {
      return installedDiscoveryError(error)
    }
  }

  applyInstalledSkillUpdate(
    request: ApplyAgentCodeInstalledSkillUpdateRequest,
  ): Promise<AgentCodeInstalledSkillsMutationResult> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      const unavailable = this.installedMutationUnavailable(request.expectedRevision)
      if (unavailable) return unavailable
      const skill = this.document.installedSkills[request.skillId]
      if (!skill) return this.installedNotFound()
      const staged = this.getStagedInstalledDiscovery(request.discoveryId)
      const candidate = staged?.candidates.get(request.candidateId)
      if (!candidate) {
        return { ok: false, code: 'expired', message: 'That reviewed update expired. Check again.' }
      }
      if (candidate.candidate.name !== skill.name
        || candidate.candidate.source.owner !== skill.source.owner
        || candidate.candidate.source.repository !== skill.source.repository
        || candidate.candidate.source.path !== skill.source.path
        || candidate.candidate.source.requestedRef !== skill.source.requestedRef
        || candidate.candidate.source.requestedRefType !== skill.source.requestedRefType) {
        return { ok: false, code: 'validation', message: 'The reviewed package is not an update for this skill.' }
      }
      const prepared = await this.prepareInstalledMutation(skill.enabled)
      if (!prepared.ok) return prepared.result
      const preflight = skill.enabled ? await this.preflightInstalledTargets(skill) : []
      if (preflight.some(item => !item.writable)) {
        const targets = preflight.map(item => this.installedPreflightStatus(item))
        this.installedTargetStatuses.set(skill.id, targets)
        return {
          ok: false,
          code: 'target-conflict',
          message: 'An installed copy changed outside Agent Code; the reviewed update was not applied.',
          snapshot: this.installedSnapshot(),
          targets,
        }
      }
      try {
        await this.installedSkillPackageStore.store(candidate)
      } catch (error) {
        return this.installedIoError(error)
      }
      const updated: AgentCodeInstalledSkillRecord = {
        ...skill,
        description: candidate.candidate.description,
        source: candidate.candidate.source,
        snapshotDigest: candidate.snapshotDigest,
        files: candidate.candidate.files,
        warnings: candidate.candidate.warnings,
        updatedAt: this.now().toISOString(),
      }
      const next = structuredClone(this.document)
      next.revision += 1
      next.installedSkills[skill.id] = updated
      for (const item of preflight) {
        next.installedPendingOperations[item.key] = this.pendingInstalledSync(updated, item)
      }
      try {
        await writeAgentCodeConventionsState(this.stateFilePath, next)
      } catch (error) {
        await this.removeUnreferencedInstalledSnapshots([candidate.snapshotDigest])
        return this.installedIoError(error)
      }
      this.document = next
      this.stagedInstalledDiscoveries.delete(request.discoveryId)
      if (updated.enabled) await this.applyInstalledOperationsLocked(updated)
      else this.installedTargetStatuses.set(
        updated.id,
        this.installedTargets(updated).targets.map(target => this.installedStatus(target, 'not-installed')),
      )
      await this.persistInstalledBestEffort()
      await this.removeUnreferencedInstalledSnapshots([skill.snapshotDigest])
      return { ok: true, snapshot: this.installedSnapshot() }
    })
  }

  deleteInstalledSkill(
    request: DeleteAgentCodeInstalledSkillRequest,
  ): Promise<AgentCodeInstalledSkillsMutationResult> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      const unavailable = this.installedMutationUnavailable(request.expectedRevision)
      if (unavailable) return unavailable
      let skill = this.document.installedSkills[request.skillId]
      if (!skill) return this.installedNotFound()
      if (skill.enabled || this.hasTrackedInstalledArtifacts(skill.id)) {
        const disabled = await this.disableInstalledLocked(skill, this.document.revision + 1)
        if (!disabled.ok) return disabled
        skill = this.document.installedSkills[request.skillId]!
      }
      const statuses = this.installedTargetStatuses.get(skill.id) ?? []
      const blockers = statuses.filter(status => status.state === 'conflict'
        || status.state === 'retired'
        || status.state === 'error')
      const approvals = new Map((request.abandonTargets ?? []).map(value => [value.targetId, value]))
      const unresolved = blockers.filter(status => {
        const approval = approvals.get(status.id)
        return !approval || !status.conflictFingerprint
          || approval.expectedConflictFingerprint !== status.conflictFingerprint
      })
      if (unresolved.length > 0) {
        return {
          ok: false,
          code: 'delete-blocked',
          message: 'External changes must be reviewed before Agent Code forgets this installed skill.',
          snapshot: this.installedSnapshot(),
          targets: blockers,
        }
      }
      const approvedAbandonmentKeys = new Set(blockers.flatMap(status => {
        if (status.state === 'error') return []
        const approval = approvals.get(status.id)
        if (!approval || approval.expectedConflictFingerprint !== status.conflictFingerprint) return []
        return [status.state === 'retired' ? status.id : installedArtifactKey(skill.id, status.id)]
      }))
      const stillOwnedKeys = [
        ...this.installedMaterializations(skill.id).map(([key]) => key),
        ...Object.entries(this.document.installedPendingOperations)
          .filter(([, operation]) => operation.skillId === skill.id)
          .map(([key]) => key),
      ]
      if (stillOwnedKeys.some(key => !approvedAbandonmentKeys.has(key))) {
        // WHY the journal itself is authoritative here: a status list is a UI
        // projection and can be incomplete after an I/O failure. Forgetting
        // ownership while any materialization or pending delete remains would
        // strand provider-visible bytes that Agent Code can no longer audit or
        // remove on retry.
        return {
          ok: false,
          code: 'delete-blocked',
          message: 'Agent Code could not remove every managed copy. Fix the filesystem error and retry removal.',
          snapshot: this.installedSnapshot(),
          targets: blockers,
        }
      }
      const removedDigest = skill.snapshotDigest
      const next = structuredClone(this.document)
      for (const [key, record] of Object.entries(next.installedMaterializations)) {
        if (record.skillId !== skill.id) continue
        delete next.installedMaterializations[key]
        delete next.installedPendingOperations[key]
      }
      for (const [key, operation] of Object.entries(next.installedPendingOperations)) {
        if (operation.skillId === skill.id) delete next.installedPendingOperations[key]
      }
      delete next.installedSkills[skill.id]
      next.revision += 1
      try {
        await writeAgentCodeConventionsState(this.stateFilePath, next)
      } catch (error) {
        return this.installedIoError(error)
      }
      this.document = next
      this.installedTargetStatuses.delete(skill.id)
      const referenced = new Set(Object.values(next.installedSkills).map(value => value.snapshotDigest))
      await this.installedSkillPackageStore.removeIfUnreferenced(removedDigest, referenced).catch(() => undefined)
      return { ok: true, snapshot: this.installedSnapshot() }
    })
  }

  async resolveInstalledSkillRevealTarget(
    skillId: string,
    targetId: string,
  ): Promise<string | null> {
    await this.initialize()
    const skill = this.document.installedSkills[skillId]
    if (!skill) return null
    const target = this.installedTargets(skill).targets.find(value => value.id === targetId)
    return target?.skillDirectory ?? null
  }

  async resolveInstalledSkillSource(skillId: string): Promise<string | null> {
    await this.initialize()
    const skill = this.document.installedSkills[skillId]
    if (!skill) return null
    return this.installedSkillPackageStore.resolveRevealDirectory(skill.snapshotDigest)
  }

  resetInstalledSkillsRecovery(): Promise<AgentCodeInstalledSkillsMutationResult> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      if (!this.recovery) return { ok: true, snapshot: this.installedSnapshot() }
      try {
        await resetAgentCodeConventionsState(this.stateFilePath)
      } catch (error) {
        return this.installedIoError(error)
      }
      this.document = createEmptyAgentCodeConventionsDocument()
      this.recovery = undefined
      this.targetStatuses = this.targets.targets.map(target => this.status(target, 'not-installed'))
      this.customTargetStatuses.clear()
      this.installedTargetStatuses.clear()
      return { ok: true, snapshot: this.installedSnapshot() }
    })
  }

  createCustomSkill(
    request: CreateAgentCodeCustomSkillRequest,
  ): Promise<AgentCodeCustomSkillsMutationResult> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      const unavailable = this.customMutationUnavailable(request.expectedRevision)
      if (unavailable) return unavailable
      if (Object.keys(this.document.customSkills).length >= AGENT_CODE_CUSTOM_SKILL_MAX_COUNT) {
        return {
          ok: false,
          code: 'validation',
          message: `Agent Code manages at most ${AGENT_CODE_CUSTOM_SKILL_MAX_COUNT} custom skills.`,
        }
      }
      const normalized = normalizeAgentCodeCustomSkill(request, {
        requireContent: request.enabled,
      })
      if (!normalized.ok) return { ok: false, code: 'validation', message: normalized.message }
      if (Object.values(this.document.customSkills).some(skill =>
        skill.name === normalized.value.name)
        || Object.values(this.document.installedSkills).some(skill =>
          skill.name === normalized.value.name)) {
        return { ok: false, code: 'validation', message: 'A managed custom skill already uses that name.' }
      }

      const targetsResolved = await this.prepareCustomMutation(request.enabled)
      if (!targetsResolved.ok) return targetsResolved.result
      const timestamp = this.now().toISOString()
      const skill: AgentCodeCustomSkillRecord = {
        id: this.operationId(),
        name: normalized.value.name,
        description: normalized.value.description,
        markdown: normalized.value.markdown,
        enabled: request.enabled,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const rendered = renderAgentCodeCustomSkill(skill)
      const desiredHash = sha256Text(rendered)
      const preflight = request.enabled ? await this.preflightCustomTargets(skill) : []
      const conflicts = preflight.filter(item => !this.canWriteCustomPreflight(item))
      if (conflicts.length > 0) {
        const statuses = preflight.map(item => this.customPreflightStatus(item, desiredHash))
        return {
          ok: false,
          code: 'target-conflict',
          message: 'A personal skill with this name already exists outside Agent Code.',
          snapshot: this.customSnapshot(),
          targets: statuses,
        }
      }

      const next = structuredClone(this.document)
      next.revision += 1
      next.customSkills[skill.id] = skill
      for (const item of preflight) {
        if (item.existing?.sha256 === desiredHash && item.inspection.kind === 'file'
          && item.inspection.sha256 === desiredHash) continue
        next.pendingOperations[item.key] = this.pendingCustomWrite(skill, item, desiredHash)
      }
      try {
        await writeAgentCodeConventionsState(this.stateFilePath, next)
      } catch (error) {
        return this.customIoError(error)
      }
      this.document = next
      const statuses: AgentCodeConventionsTargetStatus[] = []
      for (const item of preflight) {
        if (!next.pendingOperations[item.key]) statuses.push(this.customStatus(item.target, 'installed'))
        else statuses.push(await this.publishCustomTarget(skill, item, rendered, desiredHash))
      }
      this.customTargetStatuses.set(skill.id, request.enabled
        ? statuses
        : this.customTargets(skill).targets.map(target => this.customStatus(target, 'not-installed')))
      await this.persistBestEffort(statuses)
      return { ok: true, snapshot: this.customSnapshot() }
    })
  }

  updateCustomSkill(
    request: UpdateAgentCodeCustomSkillRequest,
  ): Promise<AgentCodeCustomSkillsMutationResult> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      const unavailable = this.customMutationUnavailable(request.expectedRevision)
      if (unavailable) return unavailable
      const existing = this.document.customSkills[request.skillId]
      if (!existing) return this.customNotFound()
      const normalized = normalizeAgentCodeCustomSkill({
        name: existing.name,
        description: request.description,
        markdown: request.markdown,
        enabled: request.enabled,
      }, { requireContent: request.enabled })
      if (!normalized.ok) return { ok: false, code: 'validation', message: normalized.message }

      const targetsResolved = await this.prepareCustomMutation(request.enabled)
      if (!targetsResolved.ok) return targetsResolved.result
      if (!request.enabled) {
        return this.saveDisabledCustomLocked(existing, {
          revision: request.expectedRevision + 1,
          description: normalized.value.description,
          markdown: normalized.value.markdown,
        })
      }

      const updated: AgentCodeCustomSkillRecord = {
        ...existing,
        description: normalized.value.description,
        markdown: normalized.value.markdown,
        enabled: true,
        updatedAt: this.now().toISOString(),
      }
      const rendered = renderAgentCodeCustomSkill(updated)
      const desiredHash = sha256Text(rendered)
      const preflight = await this.preflightCustomTargets(existing)
      const conflicts = preflight.filter(item => !this.canWriteCustomPreflight(item))
      if (conflicts.length > 0) {
        const statuses = preflight.map(item => this.customPreflightStatus(item, desiredHash))
        this.customTargetStatuses.set(existing.id, statuses)
        return {
          ok: false,
          code: 'target-conflict',
          message: 'An installed copy changed outside Agent Code; the external file was preserved.',
          snapshot: this.customSnapshot(),
          targets: statuses,
        }
      }

      const next = structuredClone(this.document)
      next.revision += 1
      next.customSkills[updated.id] = updated
      for (const item of preflight) {
        if (item.existing?.sha256 === desiredHash && item.inspection.kind === 'file'
          && item.inspection.sha256 === desiredHash) continue
        next.pendingOperations[item.key] = this.pendingCustomWrite(updated, item, desiredHash)
      }
      try {
        await writeAgentCodeConventionsState(this.stateFilePath, next)
      } catch (error) {
        return this.customIoError(error)
      }
      this.document = next
      const statuses: AgentCodeConventionsTargetStatus[] = []
      for (const item of preflight) {
        if (!next.pendingOperations[item.key]) statuses.push(this.customStatus(item.target, 'installed'))
        else statuses.push(await this.publishCustomTarget(updated, item, rendered, desiredHash))
      }
      this.customTargetStatuses.set(updated.id, statuses)
      await this.persistBestEffort(statuses)
      return { ok: true, snapshot: this.customSnapshot() }
    })
  }

  setCustomSkillEnabled(
    request: SetAgentCodeCustomSkillEnabledRequest,
  ): Promise<AgentCodeCustomSkillsMutationResult> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      const unavailable = this.customMutationUnavailable(request.expectedRevision)
      if (unavailable) return unavailable
      const skill = this.document.customSkills[request.skillId]
      if (!skill) return this.customNotFound()
      if (skill.enabled === request.enabled) return { ok: true, snapshot: this.customSnapshot() }
      if (request.enabled) {
        return this.enableCustomLocked(skill, request.expectedRevision + 1)
      }
      return this.disableCustomLocked(skill, {
        revision: request.expectedRevision + 1,
        description: skill.description,
        markdown: skill.markdown,
      })
    })
  }

  deleteCustomSkill(
    request: DeleteAgentCodeCustomSkillRequest,
  ): Promise<AgentCodeCustomSkillsMutationResult> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      const unavailable = this.customMutationUnavailable(request.expectedRevision)
      if (unavailable) return unavailable
      let skill = this.document.customSkills[request.skillId]
      if (!skill) return this.customNotFound()

      if (skill.enabled || this.hasTrackedCustomArtifacts(skill.id)) {
        const disabled = await this.disableCustomLocked(skill, {
          revision: this.document.revision + 1,
          description: skill.description,
          markdown: skill.markdown,
        })
        if (!disabled.ok) return disabled
        skill = this.document.customSkills[request.skillId]!
      }

      const statuses = await this.inspectRemainingCustomMaterializations(skill)
      const approvals = new Map((request.abandonTargets ?? []).map(value => [value.targetId, value]))
      const unresolved = statuses.filter(status => {
        const approval = approvals.get(status.id)
        return !approval || !status.conflictFingerprint
          || approval.expectedConflictFingerprint !== status.conflictFingerprint
      })
      if (unresolved.length > 0) {
        this.customTargetStatuses.set(skill.id, statuses)
        return {
          ok: false,
          code: 'delete-blocked',
          message: 'External changes must be reviewed before Agent Code forgets this skill.',
          snapshot: this.customSnapshot(),
          targets: statuses,
        }
      }

      const next = structuredClone(this.document)
      for (const status of statuses) this.abandonCustomStatus(next, skill, status.id)
      delete next.customSkills[skill.id]
      next.revision += 1
      try {
        await writeAgentCodeConventionsState(this.stateFilePath, next)
      } catch (error) {
        return this.customIoError(error)
      }
      this.document = next
      this.customTargetStatuses.delete(skill.id)
      return { ok: true, snapshot: this.customSnapshot() }
    })
  }

  async resolveCustomSkillRevealTarget(skillId: string, targetId: string): Promise<string | null> {
    await this.initialize()
    const skill = this.document.customSkills[skillId]
    if (!skill) return null
    const current = this.customTargets(skill).targets.find(target => target.id === targetId)
    if (current) return current.skillFile
    const historical = Object.entries(this.document.materializations).find(([key, record]) =>
      key === targetId && record.skillId === skill.id)
    return historical?.[1].path ?? null
  }

  resetCustomSkillsRecovery(): Promise<AgentCodeCustomSkillsMutationResult> {
    return this.serialize(async () => {
      await this.ensureInitializedLocked()
      if (!this.recovery) return { ok: true, snapshot: this.customSnapshot() }
      try {
        await resetAgentCodeConventionsState(this.stateFilePath)
      } catch (error) {
        return this.customIoError(error)
      }
      this.document = createEmptyAgentCodeConventionsDocument()
      this.recovery = undefined
      this.targetStatuses = this.targets.targets.map(target => this.status(target, 'not-installed'))
      this.customTargetStatuses.clear()
      this.installedTargetStatuses.clear()
      return { ok: true, snapshot: this.customSnapshot() }
    })
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
      if (targetsResolved) {
        this.rehomeMovedMaterializations()
        this.enterRecoveryForUnsafeOwnership()
        if (this.recovery) {
          return { ok: false, code: 'recovery-required', snapshot: this.snapshot() }
        }
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
      if (this.document.enabled || this.hasTrackedArtifacts(this.document)) {
        const disabled = await this.disableLocked({
          revision: nextRevision,
          markdown: this.document.markdown,
        })
        if (!disabled.ok) return disabled
      }

      const next = structuredClone(this.document)
      if (this.hasTrackedArtifacts(this.document)) {
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
            delete next.materializations[status.id]
            delete next.pendingOperations[status.id]
          }
        }
      }

      next.enabled = false
      next.markdown = ''
      next.updatedAt = this.now().toISOString()
      next.revision = Math.max(next.revision, nextRevision)
      try {
        await writeAgentCodeConventionsState(this.stateFilePath, next)
      } catch (error) {
        return this.ioError(error)
      }
      this.document = next
      this.targetStatuses = this.targets.targets.map(target => this.status(target, 'not-installed'))
      return { ok: true, snapshot: this.snapshot() }
    })
  }

  async resolveRevealTarget(targetId: string): Promise<string | null> {
    await this.initialize()
    const current = this.targets.targets.find(target => target.id === targetId)
    if (current) return current.skillFile
    const historical = this.document.materializations[targetId]
    return historical && this.ownershipPolicy.isCurrentMutationPath(
      targetId,
      historical.path,
      this.targets,
    )
      ? historical.path
      : null
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
      this.customTargetStatuses.clear()
      this.installedTargetStatuses.clear()
      return { ok: true, snapshot: this.snapshot() }
    })
  }

  private stageInstalledDiscovery(
    payload: GitHubSkillDiscoveryPayload,
  ): AgentCodeInstalledSkillDiscovery {
    this.pruneStagedInstalledDiscoveries()
    while (this.stagedInstalledDiscoveries.size >= AGENT_CODE_INSTALLED_SKILL_MAX_STAGED_DISCOVERIES) {
      const oldest = this.stagedInstalledDiscoveries.keys().next().value as string | undefined
      if (!oldest) break
      this.stagedInstalledDiscoveries.delete(oldest)
    }
    const discoveryId = this.operationId()
    const expiresAtMs = this.now().getTime() + AGENT_CODE_INSTALLED_SKILL_DISCOVERY_TTL_MS
    const discovery: AgentCodeInstalledSkillDiscovery = {
      discoveryId,
      repositoryUrl: payload.repositoryUrl,
      requestedRef: payload.requestedRef,
      requestedRefType: payload.requestedRefType,
      resolvedCommit: payload.resolvedCommit,
      expiresAt: new Date(expiresAtMs).toISOString(),
      candidates: payload.candidates.map(value => value.candidate),
      notices: payload.notices,
    }
    this.stagedInstalledDiscoveries.set(discoveryId, {
      discovery,
      candidates: new Map(payload.candidates.map(value => [value.candidate.candidateId, value])),
      expiresAtMs,
    })
    return discovery
  }

  private getStagedInstalledDiscovery(discoveryId: string): StagedInstalledDiscovery | null {
    this.pruneStagedInstalledDiscoveries()
    return this.stagedInstalledDiscoveries.get(discoveryId) ?? null
  }

  private pruneStagedInstalledDiscoveries(): void {
    const now = this.now().getTime()
    for (const [id, staged] of this.stagedInstalledDiscoveries) {
      if (staged.expiresAtMs <= now) this.stagedInstalledDiscoveries.delete(id)
    }
  }

  private managedSkillNames(): Set<string> {
    return new Set([
      'agent-code-conventions',
      ...Object.values(this.document.customSkills).map(skill => skill.name),
      ...Object.values(this.document.installedSkills).map(skill => skill.name),
    ])
  }

  private installedMutationUnavailable(
    expectedRevision: number,
  ): AgentCodeInstalledSkillsMutationResult | null {
    if (this.recovery) {
      return { ok: false, code: 'recovery-required', snapshot: this.installedSnapshot() }
    }
    if (expectedRevision !== this.document.revision) {
      return { ok: false, code: 'revision-conflict', snapshot: this.installedSnapshot() }
    }
    return null
  }

  private async prepareInstalledMutation(enabled: boolean): Promise<
    | { ok: true }
    | { ok: false; result: AgentCodeInstalledSkillsMutationResult }
  > {
    const targetsResolved = await this.resolveTargetsSafely()
    if (!targetsResolved && enabled) {
      return {
        ok: false,
        result: this.installedIoError(new Error(
          `Could not resolve provider skill targets: ${this.targetResolutionError ?? 'unknown error'}`,
        )),
      }
    }
    if (targetsResolved) {
      this.rehomeMovedMaterializations()
      this.enterRecoveryForUnsafeOwnership()
      if (this.recovery) {
        return {
          ok: false,
          result: { ok: false, code: 'recovery-required', snapshot: this.installedSnapshot() },
        }
      }
    }
    if (enabled && this.targets.unsupportedProviders.length > 0) {
      return {
        ok: false,
        result: { ok: false, code: 'unsupported', snapshot: this.installedSnapshot() },
      }
    }
    return { ok: true }
  }

  private async preflightInstalledTargets(
    skill: AgentCodeInstalledSkillRecord,
  ): Promise<InstalledPreflightTarget[]> {
    const result: InstalledPreflightTarget[] = []
    for (const target of this.installedTargets(skill).targets) {
      const key = installedArtifactKey(skill.id, target.id)
      const existing = this.document.installedMaterializations[key]
      const inspected = await this.installedSkillMaterializer.preflight(target, existing)
      result.push(inspected.kind === 'writable'
        ? { target, key, existing, writable: true }
        : {
            target,
            key,
            existing,
            writable: false,
            conflictMessage: inspected.message,
            conflictFingerprint: inspected.fingerprint,
          })
    }
    return result
  }

  private installedPreflightStatus(item: InstalledPreflightTarget): AgentCodeConventionsTargetStatus {
    if (item.writable) return this.installedStatus(item.target, 'missing')
    return {
      ...this.installedStatus(item.target, 'conflict', item.conflictMessage),
      conflictFingerprint: item.conflictFingerprint,
    }
  }

  private pendingInstalledSync(
    skill: AgentCodeInstalledSkillRecord,
    item: InstalledPreflightTarget,
  ): AgentCodeInstalledSkillPendingOperation {
    return {
      operationId: this.operationId(),
      skillId: skill.id,
      targetId: item.target.id,
      path: item.target.skillDirectory,
      kind: 'sync',
      previousSnapshotDigest: item.existing?.snapshotDigest ?? null,
      previousFiles: item.existing?.files ?? [],
      desiredSnapshotDigest: skill.snapshotDigest,
      desiredFiles: skill.files,
    }
  }

  private installedDeleteOperation(
    skill: AgentCodeInstalledSkillRecord,
    key: string,
  ): AgentCodeInstalledSkillPendingOperation | null {
    const pending = this.document.installedPendingOperations[key]
    if (pending?.kind === 'sync' && pending.desiredSnapshotDigest) {
      return {
        operationId: this.operationId(),
        skillId: skill.id,
        targetId: pending.targetId,
        path: pending.path,
        kind: 'delete',
        previousSnapshotDigest: pending.desiredSnapshotDigest,
        previousFiles: pending.desiredFiles,
        desiredSnapshotDigest: null,
        desiredFiles: [],
      }
    }
    const materialization = this.document.installedMaterializations[key]
    if (!materialization) return null
    return {
      operationId: this.operationId(),
      skillId: skill.id,
      targetId: materialization.targetId,
      path: materialization.path,
      kind: 'delete',
      previousSnapshotDigest: materialization.snapshotDigest,
      previousFiles: materialization.files,
      desiredSnapshotDigest: null,
      desiredFiles: [],
    }
  }

  private async disableInstalledLocked(
    skill: AgentCodeInstalledSkillRecord,
    revision: number,
  ): Promise<AgentCodeInstalledSkillsMutationResult> {
    const next = structuredClone(this.document)
    next.revision = revision
    next.installedSkills[skill.id] = {
      ...skill,
      enabled: false,
      updatedAt: this.now().toISOString(),
    }
    for (const target of this.installedTargets(skill).targets) {
      const key = installedArtifactKey(skill.id, target.id)
      const operation = this.installedDeleteOperation(skill, key)
      if (operation) next.installedPendingOperations[key] = operation
    }
    try {
      await writeAgentCodeConventionsState(this.stateFilePath, next)
    } catch (error) {
      return this.installedIoError(error)
    }
    this.document = next
    await this.applyInstalledOperationsLocked(this.document.installedSkills[skill.id]!)
    await this.persistInstalledBestEffort()
    return { ok: true, snapshot: this.installedSnapshot() }
  }

  private async reconcileInstalledSkillLocked(skill: AgentCodeInstalledSkillRecord): Promise<void> {
    const targets = this.installedTargets(skill)
    if (skill.enabled && targets.unsupportedProviders.length > 0) {
      this.installedTargetStatuses.set(skill.id, this.installedUnsupportedStatuses())
      return
    }
    if (skill.enabled) {
      try {
        await this.installedSkillPackageStore.verify(skill.snapshotDigest, skill.files)
      } catch (error) {
        this.installedTargetStatuses.set(
          skill.id,
          targets.targets.map(target => this.installedStatus(target, 'error', safeErrorMessage(error))),
        )
        return
      }
      const blocked: AgentCodeConventionsTargetStatus[] = []
      let journalChanged = false
      for (const target of targets.targets) {
        const key = installedArtifactKey(skill.id, target.id)
        if (this.document.installedPendingOperations[key]) continue
        const existing = this.document.installedMaterializations[key]
        const inspected = await this.installedSkillMaterializer.preflight(target, existing)
        if (inspected.kind === 'conflict') {
          blocked.push({
            ...this.installedStatus(target, 'conflict', inspected.message),
            conflictFingerprint: inspected.fingerprint,
          })
          continue
        }
        if (existing?.snapshotDigest === skill.snapshotDigest
          && JSON.stringify(existing.files) === JSON.stringify(skill.files)) continue
        this.document.installedPendingOperations[key] = this.pendingInstalledSync(skill, {
          target,
          key,
          existing,
          writable: true,
        })
        journalChanged = true
      }
      if (journalChanged) {
        try {
          await writeAgentCodeConventionsState(this.stateFilePath, this.document)
        } catch (error) {
          this.installedTargetStatuses.set(
            skill.id,
            targets.targets.map(target => this.installedStatus(target, 'error', safeErrorMessage(error))),
          )
          return
        }
      }
      await this.applyInstalledOperationsLocked(skill, blocked)
      await this.persistInstalledBestEffort()
      return
    }

    let journalChanged = false
    for (const target of targets.targets) {
      const key = installedArtifactKey(skill.id, target.id)
      if (this.document.installedPendingOperations[key]?.kind === 'delete') continue
      const operation = this.installedDeleteOperation(skill, key)
      if (!operation) continue
      this.document.installedPendingOperations[key] = operation
      journalChanged = true
    }
    if (journalChanged) {
      try {
        await writeAgentCodeConventionsState(this.stateFilePath, this.document)
      } catch (error) {
        this.installedTargetStatuses.set(
          skill.id,
          targets.targets.map(target => this.installedStatus(target, 'error', safeErrorMessage(error))),
        )
        return
      }
    }
    await this.applyInstalledOperationsLocked(skill)
    await this.persistInstalledBestEffort()
  }

  private async applyInstalledOperationsLocked(
    skill: AgentCodeInstalledSkillRecord,
    blockedStatuses: AgentCodeConventionsTargetStatus[] = [],
  ): Promise<void> {
    const targets = this.installedTargets(skill)
    const blockedIds = new Set(blockedStatuses.map(status => status.id))
    const statuses = [...blockedStatuses]
    for (const target of targets.targets) {
      if (blockedIds.has(target.id)) continue
      const key = installedArtifactKey(skill.id, target.id)
      const operation = this.document.installedPendingOperations[key]
      if (!operation) {
        const materialization = this.document.installedMaterializations[key]
        statuses.push(this.installedStatus(
          target,
          skill.enabled && materialization?.snapshotDigest === skill.snapshotDigest
            ? 'installed'
            : 'not-installed',
        ))
        continue
      }
      const result = await this.installedSkillMaterializer.apply(target, operation)
      if (result.ok) {
        if (result.materialization) {
          this.document.installedMaterializations[key] = result.materialization
          statuses.push(this.installedStatus(target, 'installed'))
        } else {
          delete this.document.installedMaterializations[key]
          statuses.push(this.installedStatus(target, 'not-installed'))
        }
        delete this.document.installedPendingOperations[key]
      } else {
        statuses.push({
          ...this.installedStatus(target, result.kind === 'conflict' ? 'conflict' : 'error', result.message),
          conflictFingerprint: result.fingerprint,
        })
      }
    }
    for (const [key, record] of this.installedMaterializations(skill.id)) {
      if (!this.installedOwnershipPolicy.isRetiredKey(key)) continue
      statuses.push({
        id: key,
        providers: [],
        displayPath: this.displayPath(record.path),
        state: 'retired',
        message: 'This historical provider-root package was preserved for manual review.',
        conflictFingerprint: this.installedOwnershipPolicy.retiredFingerprint(key, record),
      })
    }
    this.installedTargetStatuses.set(skill.id, statuses)
  }

  private installedMaterializations(skillId: string) {
    return Object.entries(this.document.installedMaterializations)
      .filter(([, record]) => record.skillId === skillId)
  }

  private hasTrackedInstalledArtifacts(skillId: string): boolean {
    return this.installedMaterializations(skillId).length > 0
      || Object.values(this.document.installedPendingOperations)
        .some(operation => operation.skillId === skillId)
  }

  private installedTargets(skill: AgentCodeInstalledSkillRecord): ResolvedAgentCodeConventionsTargets {
    return targetsForSkillName(this.targets, skill.name)
  }

  private async persistInstalledBestEffort(): Promise<void> {
    try {
      await writeAgentCodeConventionsState(this.stateFilePath, this.document)
    } catch (error) {
      for (const skill of Object.values(this.document.installedSkills)) {
        const statuses = this.installedTargetStatuses.get(skill.id) ?? []
        statuses.push({
          id: 'managed-skills-state',
          providers: [],
          displayPath: this.displayPath(this.stateFilePath),
          state: 'error',
          message: safeErrorMessage(error),
        })
        this.installedTargetStatuses.set(skill.id, statuses)
      }
    }
  }

  private async removeUnreferencedInstalledSnapshots(digests: string[]): Promise<void> {
    const referenced = new Set(
      Object.values(this.document.installedSkills).map(skill => skill.snapshotDigest),
    )
    await Promise.all([...new Set(digests)].map(digest =>
      this.installedSkillPackageStore.removeIfUnreferenced(digest, referenced).catch(() => undefined)))
  }

  private installedSnapshot(): AgentCodeInstalledSkillsSnapshot {
    return {
      revision: this.document.revision,
      skills: Object.values(this.document.installedSkills)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(skill => {
          const targets = this.installedTargetStatuses.get(skill.id) ?? []
          return {
            ...skill,
            totalBytes: skill.files.reduce((total, file) => total + file.bytes, 0),
            health: this.installedHealth(skill, targets),
            targets: [...targets],
          }
        }),
      unsupportedProviders: [...this.targets.unsupportedProviders],
      recovery: this.recovery,
    }
  }

  private installedHealth(
    skill: AgentCodeInstalledSkillRecord,
    statuses: AgentCodeConventionsTargetStatus[],
  ): AgentCodeConventionsSnapshot['health'] {
    if (this.recovery) return 'recovery-required'
    if (!skill.enabled) {
      if (statuses.some(status => status.state === 'conflict' || status.state === 'retired')) {
        return 'conflict'
      }
      if (statuses.some(status => status.state === 'error')) return 'degraded'
      return 'disabled'
    }
    if (this.targets.unsupportedProviders.length > 0) return 'unsupported'
    if (statuses.some(status => status.state === 'conflict' || status.state === 'retired')) {
      return 'conflict'
    }
    if (statuses.length === 0 || statuses.some(status => status.state !== 'installed')) {
      return 'degraded'
    }
    return 'active'
  }

  private installedUnsupportedStatuses(): AgentCodeConventionsTargetStatus[] {
    return this.targets.unsupportedProviders.map(provider => ({
      id: `unsupported:${provider}`,
      providers: [provider],
      displayPath: 'No personal skill directory',
      state: 'unsupported',
      message: `${provider} does not declare personal Agent Skills support.`,
    }))
  }

  private installedStatus(
    target: AgentCodeConventionsTarget,
    state: AgentCodeConventionsTargetStatus['state'],
    message?: string,
  ): AgentCodeConventionsTargetStatus {
    return {
      id: target.id,
      providers: [...target.providers],
      displayPath: this.displayPath(target.skillDirectory),
      state,
      message,
    }
  }

  private installedIoError(error: unknown): AgentCodeInstalledSkillsMutationResult {
    return {
      ok: false,
      code: 'io-error',
      message: safeErrorMessage(error),
      snapshot: this.installedSnapshot(),
    }
  }

  private installedNotFound(): AgentCodeInstalledSkillsMutationResult {
    return {
      ok: false,
      code: 'not-found',
      message: 'Installed skill not found.',
      snapshot: this.installedSnapshot(),
    }
  }

  private customMutationUnavailable(
    expectedRevision: number,
  ): AgentCodeCustomSkillsMutationResult | null {
    if (this.recovery) {
      return { ok: false, code: 'recovery-required', snapshot: this.customSnapshot() }
    }
    if (expectedRevision !== this.document.revision) {
      return { ok: false, code: 'revision-conflict', snapshot: this.customSnapshot() }
    }
    return null
  }

  private async prepareCustomMutation(enabled: boolean): Promise<
    | { ok: true }
    | { ok: false; result: AgentCodeCustomSkillsMutationResult }
  > {
    const targetsResolved = await this.resolveTargetsSafely()
    if (!targetsResolved && enabled) {
      return {
        ok: false,
        result: this.customIoError(new Error(
          `Could not resolve provider skill targets: ${this.targetResolutionError ?? 'unknown error'}`,
        )),
      }
    }
    if (targetsResolved) {
      this.rehomeMovedMaterializations()
      this.enterRecoveryForUnsafeOwnership()
      if (this.recovery) {
        return {
          ok: false,
          result: { ok: false, code: 'recovery-required', snapshot: this.customSnapshot() },
        }
      }
    }
    if (enabled && this.targets.unsupportedProviders.length > 0) {
      return {
        ok: false,
        result: { ok: false, code: 'unsupported', snapshot: this.customSnapshot() },
      }
    }
    return { ok: true }
  }

  private async enableCustomLocked(
    skill: AgentCodeCustomSkillRecord,
    revision: number,
  ): Promise<AgentCodeCustomSkillsMutationResult> {
    const normalized = normalizeAgentCodeCustomSkill(skill, { requireContent: true })
    if (!normalized.ok) return { ok: false, code: 'validation', message: normalized.message }
    const prepared = await this.prepareCustomMutation(true)
    if (!prepared.ok) return prepared.result
    const updated: AgentCodeCustomSkillRecord = {
      ...skill,
      description: normalized.value.description,
      markdown: normalized.value.markdown,
      enabled: true,
      updatedAt: this.now().toISOString(),
    }
    const rendered = renderAgentCodeCustomSkill(updated)
    const desiredHash = sha256Text(rendered)
    const preflight = await this.preflightCustomTargets(skill)
    const conflicts = preflight.filter(item => !this.canWriteCustomPreflight(item))
    if (conflicts.length > 0) {
      const statuses = preflight.map(item => this.customPreflightStatus(item, desiredHash))
      this.customTargetStatuses.set(skill.id, statuses)
      return {
        ok: false,
        code: 'target-conflict',
        message: 'A personal skill with this name already exists outside Agent Code.',
        snapshot: this.customSnapshot(),
        targets: statuses,
      }
    }

    const next = structuredClone(this.document)
    next.revision = revision
    next.customSkills[skill.id] = updated
    for (const item of preflight) {
      if (item.existing?.sha256 === desiredHash && item.inspection.kind === 'file'
        && item.inspection.sha256 === desiredHash) continue
      next.pendingOperations[item.key] = this.pendingCustomWrite(updated, item, desiredHash)
    }
    try {
      await writeAgentCodeConventionsState(this.stateFilePath, next)
    } catch (error) {
      return this.customIoError(error)
    }
    this.document = next
    const statuses: AgentCodeConventionsTargetStatus[] = []
    for (const item of preflight) {
      if (!next.pendingOperations[item.key]) statuses.push(this.customStatus(item.target, 'installed'))
      else statuses.push(await this.publishCustomTarget(updated, item, rendered, desiredHash))
    }
    this.customTargetStatuses.set(skill.id, statuses)
    await this.persistBestEffort(statuses)
    return { ok: true, snapshot: this.customSnapshot() }
  }

  private async saveDisabledCustomLocked(
    skill: AgentCodeCustomSkillRecord,
    options: { revision: number; description: string; markdown: string },
  ): Promise<AgentCodeCustomSkillsMutationResult> {
    if (skill.enabled || this.hasTrackedCustomArtifacts(skill.id)) {
      return this.disableCustomLocked(skill, options)
    }
    const next = structuredClone(this.document)
    next.revision = options.revision
    next.customSkills[skill.id] = {
      ...skill,
      enabled: false,
      description: options.description,
      markdown: options.markdown,
      updatedAt: this.now().toISOString(),
    }
    try {
      await writeAgentCodeConventionsState(this.stateFilePath, next)
    } catch (error) {
      return this.customIoError(error)
    }
    this.document = next
    this.customTargetStatuses.set(
      skill.id,
      this.customTargets(skill).targets.map(target => this.customStatus(target, 'not-installed')),
    )
    return { ok: true, snapshot: this.customSnapshot() }
  }

  private async disableCustomLocked(
    skill: AgentCodeCustomSkillRecord,
    options: { revision: number; description: string; markdown: string },
  ): Promise<AgentCodeCustomSkillsMutationResult> {
    const next = structuredClone(this.document)
    next.revision = options.revision
    const disabled = {
      ...skill,
      enabled: false,
      description: options.description,
      markdown: options.markdown,
      updatedAt: this.now().toISOString(),
    }
    next.customSkills[skill.id] = disabled
    this.adoptPendingCustomWritesForRemoval(next, disabled)
    for (const [key, record] of this.customMaterializations(next, skill.id)) {
      next.pendingOperations[key] = {
        operationId: this.operationId(),
        skillId: skill.id,
        targetId: record.targetId!,
        path: record.path,
        kind: 'delete',
        previousSha256: record.sha256,
        desiredSha256: null,
      }
    }
    try {
      await writeAgentCodeConventionsState(this.stateFilePath, next)
    } catch (error) {
      return this.customIoError(error)
    }
    this.document = next

    const statuses: AgentCodeConventionsTargetStatus[] = []
    for (const [key, record] of this.customMaterializations(next, skill.id)) {
      statuses.push(await this.removeCustomMaterialization(disabled, key, record))
    }
    for (const target of this.customTargets(disabled).targets) {
      if (!statuses.some(status => status.id === target.id)) {
        statuses.push(this.customStatus(target, 'not-installed'))
      }
    }
    this.customTargetStatuses.set(skill.id, statuses)
    await this.persistBestEffort(statuses)
    return { ok: true, snapshot: this.customSnapshot() }
  }

  private async saveDisabledLocked(
    markdown: string,
    expectedRevision: number,
  ): Promise<AgentCodeConventionsMutationResult> {
    if (this.document.enabled || this.hasTrackedArtifacts(this.document)) {
      return this.disableLocked({ revision: expectedRevision + 1, markdown })
    }
    const next = {
      ...this.document,
      revision: expectedRevision + 1,
      enabled: false,
      markdown,
      updatedAt: this.now().toISOString(),
    }
    try {
      await writeAgentCodeConventionsState(this.stateFilePath, next)
    } catch (error) {
      return this.ioError(error)
    }
    this.document = next
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
    this.adoptPendingWritesForRemoval(next)
    for (const [key, record] of Object.entries(next.materializations)) {
      if (record.skillId) continue
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
      if (record.skillId) continue
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
    await this.inspectJournaledWriteSidecars()
    if (this.document.enabled) await this.reconcileEnabledLocked()
    else await this.reconcileDisabledLocked()
    for (const skill of Object.values(this.document.customSkills)
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (skill.enabled) await this.reconcileCustomEnabledLocked(skill)
      else await this.reconcileCustomDisabledLocked(skill)
    }
    for (const skill of Object.values(this.document.installedSkills)
      .sort((left, right) => left.name.localeCompare(right.name))) {
      await this.reconcileInstalledSkillLocked(skill)
    }
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
      const journalCollision = this.journalWriteCollisions.get(target.id)
      if (journalCollision) {
        statuses.push(this.status(
          target,
          'conflict',
          `An unverified write sidecar was preserved at ${this.displayPath(journalCollision)}.`,
        ))
        continue
      }
      const inspection = await this.pathSafety.inspectTarget(target)
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
      if (record.skillId) continue
      if (!key.startsWith(RETIRED_CONVENTIONS_TARGET_PREFIX)) continue
      if (this.document.pendingOperations[key]?.kind !== 'delete') {
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
      const removed = await this.removeMaterialization(key, record)
      // A retired target that was successfully removed is historical cleanup,
      // not part of current deployment health. Reporting it as not-installed
      // made an otherwise complete enabled reconciliation look degraded.
      if (removed.state !== 'not-installed') statuses.push(removed)
    }
    this.targetStatuses = statuses
    await this.persistBestEffort(statuses)
  }

  private async reconcileDisabledLocked(): Promise<void> {
    const statuses: AgentCodeConventionsTargetStatus[] = []
    this.adoptPendingWritesForRemoval(this.document)
    for (const [key, record] of Object.entries(this.document.materializations)) {
      if (record.skillId) continue
      if (this.document.pendingOperations[key]?.kind !== 'delete') {
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

  private async reconcileCustomEnabledLocked(skill: AgentCodeCustomSkillRecord): Promise<void> {
    const targets = this.customTargets(skill)
    if (targets.unsupportedProviders.length > 0) {
      this.customTargetStatuses.set(skill.id, this.customUnsupportedStatuses())
      return
    }
    const normalized = normalizeAgentCodeCustomSkill(skill, { requireContent: true })
    if (!normalized.ok) {
      this.customTargetStatuses.set(
        skill.id,
        targets.targets.map(target => this.customStatus(target, 'error', normalized.message)),
      )
      return
    }
    const rendered = renderAgentCodeCustomSkill(normalized.value)
    const desiredHash = sha256Text(rendered)
    const statuses: AgentCodeConventionsTargetStatus[] = []

    for (const target of targets.targets) {
      const key = customArtifactKey(skill.id, target.id)
      const journalCollision = this.journalWriteCollisions.get(key)
      if (journalCollision) {
        statuses.push(this.customStatus(
          target,
          'conflict',
          `An unverified write sidecar was preserved at ${this.displayPath(journalCollision)}.`,
        ))
        continue
      }
      const inspection = await this.pathSafety.inspectTarget(target)
      const record = this.document.materializations[key]
      const pending = this.document.pendingOperations[key]
      if (inspection.kind === 'file' && inspection.sha256 === desiredHash) {
        if (record?.skillId === skill.id && record.sha256 === desiredHash || (
          pending?.skillId === skill.id
          && pending.kind === 'write'
          && pending.path === target.skillFile
          && pending.desiredSha256 === desiredHash
        )) {
          this.document.materializations[key] = {
            path: target.skillFile,
            sha256: desiredHash,
            skillId: skill.id,
            targetId: target.id,
          }
          delete this.document.pendingOperations[key]
          statuses.push(this.customStatus(target, 'installed'))
          continue
        }
        statuses.push(this.customConflictStatus(
          target,
          inspection.fingerprint,
          'A matching skill exists, but Agent Code has no write-ahead ownership proof.',
        ))
        continue
      }
      if (inspection.kind === 'file' && record?.skillId === skill.id
        && record.sha256 === inspection.sha256) {
        const item = { target, inspection, existing: record, key } satisfies CustomPreflightTarget
        this.document.pendingOperations[key] = this.pendingCustomWrite(skill, item, desiredHash)
        if (!await this.persistJournalBeforeExternalMutation(statuses, target)) continue
        statuses.push(await this.publishCustomTarget(skill, item, rendered, desiredHash))
        continue
      }
      if (inspection.kind === 'missing') {
        const item = { target, inspection, existing: record, key } satisfies CustomPreflightTarget
        this.document.pendingOperations[key] = this.pendingCustomWrite(skill, item, desiredHash)
        if (!await this.persistJournalBeforeExternalMutation(statuses, target)) continue
        statuses.push(await this.publishCustomTarget(skill, item, rendered, desiredHash))
        continue
      }
      if (inspection.kind === 'conflict') {
        statuses.push(this.customConflictStatus(
          target,
          inspection.fingerprint,
          inspection.message,
          false,
        ))
      } else {
        statuses.push(this.customConflictStatus(
          target,
          inspection.fingerprint,
          inspection.readError ?? 'The installed skill differs from Agent Code ownership state.',
          false,
        ))
      }
      delete this.document.pendingOperations[key]
    }

    for (const [key, record] of this.customMaterializations(this.document, skill.id)) {
      if (!this.customOwnershipPolicy.isRetiredKey(key)) continue
      if (this.document.pendingOperations[key]?.kind !== 'delete') {
        this.document.pendingOperations[key] = {
          operationId: this.operationId(),
          skillId: skill.id,
          targetId: record.targetId!,
          path: record.path,
          kind: 'delete',
          previousSha256: record.sha256,
          desiredSha256: null,
        }
        if (!await this.persistJournalBeforeExternalMutation(statuses)) continue
      }
      const removed = await this.removeCustomMaterialization(skill, key, record)
      if (removed.state !== 'not-installed') statuses.push(removed)
    }
    this.customTargetStatuses.set(skill.id, statuses)
    await this.persistBestEffort(statuses)
  }

  private async reconcileCustomDisabledLocked(skill: AgentCodeCustomSkillRecord): Promise<void> {
    const statuses: AgentCodeConventionsTargetStatus[] = []
    this.adoptPendingCustomWritesForRemoval(this.document, skill)
    for (const [key, record] of this.customMaterializations(this.document, skill.id)) {
      if (this.document.pendingOperations[key]?.kind !== 'delete') {
        this.document.pendingOperations[key] = {
          operationId: this.operationId(),
          skillId: skill.id,
          targetId: record.targetId!,
          path: record.path,
          kind: 'delete',
          previousSha256: record.sha256,
          desiredSha256: null,
        }
        if (!await this.persistJournalBeforeExternalMutation(statuses)) continue
      }
      statuses.push(await this.removeCustomMaterialization(skill, key, record))
    }
    for (const target of this.customTargets(skill).targets) {
      if (!statuses.some(status => status.id === target.id)) {
        statuses.push(this.customStatus(target, 'not-installed'))
      }
    }
    this.customTargetStatuses.set(skill.id, statuses)
    await this.persistBestEffort(statuses)
  }

  private async preflightCustomTargets(
    skill: AgentCodeCustomSkillRecord,
  ): Promise<CustomPreflightTarget[]> {
    const result: CustomPreflightTarget[] = []
    for (const target of this.customTargets(skill).targets) {
      const key = customArtifactKey(skill.id, target.id)
      result.push({
        target,
        key,
        inspection: await this.pathSafety.inspectTarget(target),
        existing: this.document.materializations[key],
      })
    }
    return result
  }

  private canWriteCustomPreflight(item: CustomPreflightTarget): boolean {
    if (item.inspection.kind === 'missing') return true
    if (item.inspection.kind === 'conflict') return false
    // Unlike Conventions, custom names are freely chosen and replacement is
    // never offered. Only the exact path/hash pair already present in app state
    // can make a non-empty destination writable.
    return item.existing?.path === item.target.skillFile
      && item.existing.sha256 === item.inspection.sha256
  }

  private customPreflightStatus(
    item: CustomPreflightTarget,
    desiredHash: string,
  ): AgentCodeConventionsTargetStatus {
    if (this.canWriteCustomPreflight(item)) {
      if (item.inspection.kind === 'file' && item.inspection.sha256 === desiredHash) {
        return this.customStatus(item.target, 'installed')
      }
      return this.customStatus(item.target, 'missing')
    }
    if (item.inspection.kind === 'conflict') {
      return this.customConflictStatus(
        item.target,
        item.inspection.fingerprint,
        item.inspection.message,
        false,
      )
    }
    if (item.inspection.kind === 'missing') return this.customStatus(item.target, 'missing')
    return this.customConflictStatus(
      item.target,
      item.inspection.fingerprint,
      item.inspection.readError ?? 'An unmanaged skill already exists at this path.',
      false,
    )
  }

  private pendingCustomWrite(
    skill: AgentCodeCustomSkillRecord,
    item: CustomPreflightTarget,
    desiredHash: string,
  ): AgentCodeConventionsPendingOperation {
    return {
      operationId: this.operationId(),
      skillId: skill.id,
      targetId: item.target.id,
      path: item.target.skillFile,
      kind: 'write',
      previousSha256: item.existing?.sha256 ?? null,
      desiredSha256: desiredHash,
    }
  }

  private async preflightTargets(
    resolutions: Map<string, AgentCodeConventionsConflictResolution>,
  ): Promise<PreflightTarget[]> {
    const result: PreflightTarget[] = []
    for (const target of this.targets.targets) {
      result.push({
        target,
        inspection: await this.pathSafety.inspectTarget(target),
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

  private async inspectJournaledWriteSidecars(): Promise<void> {
    this.journalWriteCollisions.clear()
    for (const [key, operation] of Object.entries(this.document.pendingOperations)) {
      if (operation.kind !== 'write') continue
      if (operation.skillId) {
        const skill = this.document.customSkills[operation.skillId]
        if (!skill || !this.customOwnershipPolicy.isCurrentMutationPath(
          key,
          operation,
          skill,
          this.customTargets(skill),
        )) continue
      } else if (!this.ownershipPolicy.isCurrentMutationPath(key, operation.path, this.targets)) {
        continue
      }
      const candidate = await this.journalWriteSidecar(operation)
      if (!candidate) continue
      // A journal proves that Agent Code intended to use a sidecar name; it
      // cannot prove who won that pathname before a crash. Preserve the
      // occupant and stop only this target until the user inspects it.
      this.journalWriteCollisions.set(key, candidate)
    }
  }

  private async journalWriteSidecar(
    operation: AgentCodeConventionsPendingOperation,
  ): Promise<string | null> {
    const candidates = [
      journalTemporaryPath(operation.path, operation.operationId),
      journalCaptureDirectory(operation.path, operation.operationId),
    ]
    for (const candidate of candidates) {
      if (await this.pathSafety.journaledPathExists(candidate)) return candidate
    }
    return null
  }

  private adoptPendingWritesForRemoval(document: AgentCodeConventionsDocument): void {
    for (const [key, operation] of Object.entries(document.pendingOperations)) {
      if (operation.skillId) continue
      if (operation.kind !== 'write' || document.materializations[key]) continue
      if (!operation.desiredSha256) continue
      // A pending write is the durable proof for a provider copy that may have
      // been published before the process died. Converting it to a normal
      // ownership record lets the existing hash-checked removal path decide
      // whether bytes exist; it never broadens authority beyond that journal.
      document.materializations[key] = {
        path: operation.path,
        sha256: operation.desiredSha256,
      }
    }
  }

  private hasTrackedArtifacts(document: AgentCodeConventionsDocument): boolean {
    return Object.values(document.materializations).some(record => !record.skillId)
      || Object.values(document.pendingOperations).some(operation => !operation.skillId)
  }

  private async publishTarget(
    item: PreflightTarget,
    rendered: string,
    desiredHash: string,
  ): Promise<AgentCodeConventionsTargetStatus> {
    try {
      const pending = this.document.pendingOperations[item.target.id]
      if (!pending || pending.kind !== 'write') {
        throw new Error('Missing write-ahead operation for conventions publication')
      }
      await this.pathSafety.ensureTargetDirectory(item.target)
      const expectedVersion = item.inspection.kind === 'file'
        ? item.inspection.version
        : null
      if (item.inspection.kind === 'conflict') {
        const current = await this.pathSafety.inspectTarget(item.target)
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
        temporaryPath: journalTemporaryPath(item.target.skillFile, pending.operationId),
        captureDirectory: journalCaptureDirectory(item.target.skillFile, pending.operationId),
        expectedSha256: item.inspection.kind === 'file'
          ? item.inspection.sha256 ?? undefined
          : undefined,
      })
      if (!result.ok) {
        const sidecar = await this.journalWriteSidecar(pending)
        if (sidecar) {
          this.journalWriteCollisions.set(item.target.id, sidecar)
          return this.status(
            item.target,
            'conflict',
            `An unverified write sidecar was preserved at ${this.displayPath(sidecar)}.`,
          )
        }
        delete this.document.pendingOperations[item.target.id]
        const current = await this.pathSafety.inspectTarget(item.target)
        return current.kind === 'file'
          ? this.conflictStatus(item.target, current.fingerprint, 'The file changed while Agent Code was saving.')
          : this.status(item.target, 'conflict', 'The target changed while Agent Code was saving.')
      }
      this.document.materializations[item.target.id] = {
        path: item.target.skillFile,
        sha256: desiredHash,
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
    if (!this.ownershipPolicy.isCurrentMutationPath(key, record.path, this.targets)) {
      delete this.document.pendingOperations[key]
      return {
        ...baseStatus(
          'retired',
          'This copy is not owned by its current provider target. Remove it manually or leave it when clearing.',
        ),
        conflictFingerprint: this.ownershipPolicy.retiredFingerprint(key, record),
      }
    }
    try {
      const pending = this.document.pendingOperations[key]
      if (!pending || pending.kind !== 'delete') {
        throw new Error('Missing write-ahead operation for conventions removal')
      }
      const quarantinePath = journalTemporaryPath(record.path, pending.operationId)
      const recovery = await this.pathSafety.recoverJournaledDelete(
        record.path,
        quarantinePath,
        record.sha256,
      )
      if (recovery === 'conflict') {
        return baseStatus('conflict', 'A journaled removal quarantine could not be restored safely.')
      }
      if (recovery === 'completed') {
        delete this.document.materializations[key]
        delete this.document.pendingOperations[key]
        return baseStatus('not-installed')
      }
      const inspected = await this.pathSafety.inspectExactFile(record.path)
      if (inspected.kind === 'missing') {
        delete this.document.materializations[key]
        delete this.document.pendingOperations[key]
        return baseStatus('not-installed')
      }
      if (inspected.kind !== 'file' || inspected.sha256 !== record.sha256) {
        delete this.document.pendingOperations[key]
        const fingerprint = inspected.fingerprint
        return {
          ...baseStatus(key.startsWith(RETIRED_CONVENTIONS_TARGET_PREFIX) ? 'retired' : 'conflict',
            inspected.kind === 'conflict'
              ? inspected.message
              : 'External changes were preserved; Agent Code did not delete this file.'),
          conflictFingerprint: fingerprint,
        }
      }
      const removal = await this.pathSafety.unlinkOwnedRegularFile(
        record.path,
        inspected.version,
        record.sha256,
        quarantinePath,
      )
      if (removal === 'changed') {
        delete this.document.pendingOperations[key]
        return {
          ...baseStatus('conflict', 'The file changed immediately before removal.'),
          conflictFingerprint: inspected.fingerprint,
        }
      }
      delete this.document.materializations[key]
      delete this.document.pendingOperations[key]
      return baseStatus('not-installed')
    } catch (error) {
      // Keep the journal on unexpected failure. In particular, a crash-safe
      // delete may have captured bytes in its operation-derived quarantine;
      // dropping the pending id would make that exact sidecar unrecoverable.
      return baseStatus('error', safeErrorMessage(error))
    }
  }

  private async publishCustomTarget(
    skill: AgentCodeCustomSkillRecord,
    item: CustomPreflightTarget,
    rendered: string,
    desiredHash: string,
  ): Promise<AgentCodeConventionsTargetStatus> {
    try {
      const pending = this.document.pendingOperations[item.key]
      if (!pending || pending.kind !== 'write' || pending.skillId !== skill.id) {
        throw new Error('Missing write-ahead operation for custom skill publication')
      }
      await this.pathSafety.ensureTargetDirectory(item.target)
      const expectedVersion = item.inspection.kind === 'file' ? item.inspection.version : null
      const result = await atomicWriteTextFile({
        absolutePath: item.target.skillFile,
        text: rendered,
        expectedVersion,
        maxBytes: AGENT_CODE_CONVENTIONS_COLLISION_MAX_BYTES,
        temporaryPath: journalTemporaryPath(item.target.skillFile, pending.operationId),
        captureDirectory: journalCaptureDirectory(item.target.skillFile, pending.operationId),
        expectedSha256: item.inspection.kind === 'file'
          ? item.inspection.sha256 ?? undefined
          : undefined,
      })
      if (!result.ok) {
        const sidecar = await this.journalWriteSidecar(pending)
        if (sidecar) {
          this.journalWriteCollisions.set(item.key, sidecar)
          return this.customStatus(
            item.target,
            'conflict',
            `An unverified write sidecar was preserved at ${this.displayPath(sidecar)}.`,
          )
        }
        delete this.document.pendingOperations[item.key]
        const current = await this.pathSafety.inspectTarget(item.target)
        return current.kind === 'file'
          ? this.customConflictStatus(
            item.target,
            current.fingerprint,
            'The file changed while Agent Code was saving.',
            false,
          )
          : this.customStatus(item.target, 'conflict', 'The target changed while Agent Code was saving.')
      }
      this.document.materializations[item.key] = {
        path: item.target.skillFile,
        sha256: desiredHash,
        skillId: skill.id,
        targetId: item.target.id,
      }
      delete this.document.pendingOperations[item.key]
      return this.customStatus(item.target, 'installed')
    } catch (error) {
      return this.customStatus(item.target, 'error', safeErrorMessage(error))
    }
  }

  private async removeCustomMaterialization(
    skill: AgentCodeCustomSkillRecord,
    key: string,
    record: AgentCodeConventionsMaterialization,
  ): Promise<AgentCodeConventionsTargetStatus> {
    const targets = this.customTargets(skill)
    const target = record.targetId
      ? targets.targets.find(value => value.id === record.targetId)
      : undefined
    const baseStatus = (state: AgentCodeConventionsTargetStatus['state'], message?: string) =>
      target
        ? this.customStatus(target, state, message)
        : {
            id: key,
            providers: [],
            displayPath: this.displayPath(record.path),
            state,
            message,
          }
    if (!this.customOwnershipPolicy.isCurrentMutationPath(key, record, skill, targets)) {
      delete this.document.pendingOperations[key]
      return {
        ...baseStatus(
          'retired',
          'This historical provider-root copy was preserved for manual review.',
        ),
        id: key,
        conflictFingerprint: this.customOwnershipPolicy.retiredFingerprint(key, record),
      }
    }
    try {
      const pending = this.document.pendingOperations[key]
      if (!pending || pending.kind !== 'delete' || pending.skillId !== skill.id) {
        throw new Error('Missing write-ahead operation for custom skill removal')
      }
      const quarantinePath = journalTemporaryPath(record.path, pending.operationId)
      const recovery = await this.pathSafety.recoverJournaledDelete(
        record.path,
        quarantinePath,
        record.sha256,
      )
      if (recovery === 'conflict') {
        return baseStatus('conflict', 'A journaled removal quarantine could not be restored safely.')
      }
      if (recovery === 'completed') {
        delete this.document.materializations[key]
        delete this.document.pendingOperations[key]
        return baseStatus('not-installed')
      }
      const inspected = await this.pathSafety.inspectExactFile(record.path)
      if (inspected.kind === 'missing') {
        delete this.document.materializations[key]
        delete this.document.pendingOperations[key]
        return baseStatus('not-installed')
      }
      if (inspected.kind !== 'file' || inspected.sha256 !== record.sha256) {
        delete this.document.pendingOperations[key]
        return {
          ...baseStatus(
            'conflict',
            inspected.kind === 'conflict'
              ? inspected.message
              : 'External changes were preserved; Agent Code did not delete this file.',
          ),
          conflictFingerprint: inspected.fingerprint,
        }
      }
      const removal = await this.pathSafety.unlinkOwnedRegularFile(
        record.path,
        inspected.version,
        record.sha256,
        quarantinePath,
      )
      if (removal === 'changed') {
        delete this.document.pendingOperations[key]
        return {
          ...baseStatus('conflict', 'The file changed immediately before removal.'),
          conflictFingerprint: inspected.fingerprint,
        }
      }
      delete this.document.materializations[key]
      delete this.document.pendingOperations[key]
      return baseStatus('not-installed')
    } catch (error) {
      return baseStatus('error', safeErrorMessage(error))
    }
  }

  private enterRecoveryForUnsafeOwnership(): void {
    const problem = this.ownershipPolicy.persistedOwnershipProblem(this.document, this.targets)
      ?? this.customOwnershipPolicy.persistedOwnershipProblem(
        this.document,
        this.document.customSkills,
        skill => this.customTargets(skill),
      )
      ?? this.installedOwnershipPolicy.persistedOwnershipProblem(
        this.document,
        this.document.installedSkills,
        skill => this.installedTargets(skill),
      )
    if (!problem) return
    // A syntactically valid state file can still contain a path that is too
    // broad to use as deletion authority. Treat it exactly like a newer schema:
    // preserve the original bytes, expose recovery, and perform no provider
    // mutation until the user deliberately resets the state.
    this.recovery = {
      message: `Managed skill ownership state is unsafe: ${problem} The original file was preserved.`,
      stateFilePath: this.stateFilePath,
    }
  }

  private rehomeMovedMaterializations(): void {
    this.ownershipPolicy.rehomeMovedMaterializations(this.document, this.targets)
    for (const skill of Object.values(this.document.customSkills)) {
      this.customOwnershipPolicy.rehomeMovedMaterializations(
        this.document,
        skill,
        this.customTargets(skill),
      )
    }
    for (const skill of Object.values(this.document.installedSkills)) {
      this.installedOwnershipPolicy.rehomeMovedMaterializations(
        this.document,
        skill,
        this.installedTargets(skill),
      )
    }
  }

  private async inspectRemainingMaterializations(): Promise<void> {
    const statuses: AgentCodeConventionsTargetStatus[] = []
    for (const [key, record] of Object.entries(this.document.materializations)) {
      if (record.skillId) continue
      const state = key.startsWith(RETIRED_CONVENTIONS_TARGET_PREFIX) ? 'retired' : 'conflict'
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
      if (!this.ownershipPolicy.isCurrentMutationPath(key, record.path, this.targets)) {
        status.message = 'Historical provider-root copy was preserved and must be handled manually.'
        status.conflictFingerprint = this.ownershipPolicy.retiredFingerprint(key, record)
      } else {
        const inspection = await this.pathSafety.inspectExactFile(record.path)
        if (inspection.kind === 'file' || inspection.kind === 'conflict') {
          status.conflictFingerprint = inspection.fingerprint
        }
      }
      statuses.push(status)
    }
    this.targetStatuses = statuses
  }

  private async inspectRemainingCustomMaterializations(
    skill: AgentCodeCustomSkillRecord,
  ): Promise<AgentCodeConventionsTargetStatus[]> {
    const targets = this.customTargets(skill)
    const statuses: AgentCodeConventionsTargetStatus[] = []
    for (const [key, record] of this.customMaterializations(this.document, skill.id)) {
      const target = record.targetId
        ? targets.targets.find(value => value.id === record.targetId)
        : undefined
      const retired = !this.customOwnershipPolicy.isCurrentMutationPath(key, record, skill, targets)
      const status: AgentCodeConventionsTargetStatus = target && !retired
        ? this.customStatus(target, 'conflict', 'External changes remain on disk.')
        : {
            id: key,
            providers: target?.providers ?? [],
            displayPath: this.displayPath(record.path),
            state: 'retired',
            message: 'Historical provider-root copy was preserved and must be handled manually.',
          }
      if (retired) {
        status.conflictFingerprint = this.customOwnershipPolicy.retiredFingerprint(key, record)
      } else {
        const inspection = await this.pathSafety.inspectExactFile(record.path)
        if (inspection.kind === 'file' || inspection.kind === 'conflict') {
          status.conflictFingerprint = inspection.fingerprint
        }
      }
      statuses.push(status)
    }
    return statuses
  }

  private abandonCustomStatus(
    document: AgentCodeConventionsDocument,
    skill: AgentCodeCustomSkillRecord,
    statusId: string,
  ): void {
    for (const [key, record] of this.customMaterializations(document, skill.id)) {
      if (key !== statusId && record.targetId !== statusId) continue
      delete document.materializations[key]
      delete document.pendingOperations[key]
    }
  }

  private adoptPendingCustomWritesForRemoval(
    document: AgentCodeConventionsDocument,
    skill: AgentCodeCustomSkillRecord,
  ): void {
    for (const [key, operation] of Object.entries(document.pendingOperations)) {
      if (operation.skillId !== skill.id || operation.kind !== 'write'
        || document.materializations[key] || !operation.desiredSha256) continue
      document.materializations[key] = {
        path: operation.path,
        sha256: operation.desiredSha256,
        skillId: skill.id,
        targetId: operation.targetId,
      }
    }
  }

  private customMaterializations(document: AgentCodeConventionsDocument, skillId: string) {
    return Object.entries(document.materializations).filter(([, record]) => record.skillId === skillId)
  }

  private hasTrackedCustomArtifacts(skillId: string): boolean {
    return Object.values(this.document.materializations).some(record => record.skillId === skillId)
      || Object.values(this.document.pendingOperations).some(operation => operation.skillId === skillId)
  }

  private customTargets(skill: AgentCodeCustomSkillRecord): ResolvedAgentCodeConventionsTargets {
    return targetsForSkillName(this.targets, skill.name)
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
      // A previous successful audit may have left every custom target marked
      // Installed. Once discovery itself fails, those paths are no longer a
      // trustworthy statement about the current provider configuration; keep
      // the desired definitions but invalidate deployment health together.
      for (const skill of Object.values(this.document.customSkills)) {
        this.customTargetStatuses.set(skill.id, [{
          id: 'provider-target-resolution',
          providers: [],
          displayPath: '',
          state: 'error',
          message: safeErrorMessage(error),
        }])
      }
      return false
    }
  }

  private async persistBestEffort(statuses: AgentCodeConventionsTargetStatus[]): Promise<void> {
    try {
      await writeAgentCodeConventionsState(this.stateFilePath, this.document)
    } catch (error) {
      statuses.push({
        id: 'managed-skills-state',
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
            id: 'managed-skills-state',
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

  private customSnapshot(): AgentCodeCustomSkillsSnapshot {
    return {
      revision: this.document.revision,
      unsupportedProviders: this.targets.unsupportedProviders,
      recovery: this.recovery,
      skills: Object.values(this.document.customSkills)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(skill => {
          const targets = [...(this.customTargetStatuses.get(skill.id) ?? [])]
            .sort((left, right) => left.id.localeCompare(right.id))
          return {
            ...skill,
            health: this.customHealth(skill, targets),
            targets,
          } satisfies AgentCodeCustomSkill
        }),
    }
  }

  private customHealth(
    skill: AgentCodeCustomSkillRecord,
    targets: AgentCodeConventionsTargetStatus[],
  ): AgentCodeCustomSkill['health'] {
    if (this.recovery) return 'recovery-required'
    if (skill.enabled && this.targets.unsupportedProviders.length > 0) return 'unsupported'
    if (targets.some(status => status.state === 'conflict' || status.state === 'retired')) {
      return 'conflict'
    }
    if (targets.some(status => status.state === 'error' || status.state === 'missing')) {
      return 'degraded'
    }
    if (!skill.enabled) return 'disabled'
    return targets.length > 0 && targets.every(status => status.state === 'installed')
      ? 'active'
      : 'degraded'
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

  private customUnsupportedStatuses(): AgentCodeConventionsTargetStatus[] {
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

  private customStatus(
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

  private customConflictStatus(
    target: AgentCodeConventionsTarget,
    fingerprint: string,
    message: string,
    canOverwrite = false,
  ): AgentCodeConventionsTargetStatus {
    return {
      ...this.customStatus(target, 'conflict', message),
      canOverwrite,
      conflictFingerprint: fingerprint,
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

  private customIoError(error: unknown): AgentCodeCustomSkillsMutationResult {
    return {
      ok: false,
      code: 'io-error',
      message: safeErrorMessage(error),
      snapshot: this.customSnapshot(),
    }
  }

  private customNotFound(): AgentCodeCustomSkillsMutationResult {
    return {
      ok: false,
      code: 'not-found',
      message: 'The custom skill no longer exists.',
      snapshot: this.customSnapshot(),
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
      this.rehomeMovedMaterializations()
      this.enterRecoveryForUnsafeOwnership()
      if (!this.recovery) await this.reconcileLocked()
    }
    this.initialized = true
  }
}

// Existing tests and the Conventions IPC imported this public name before the
// service became collection-shaped. Keep a source-compatible alias so the
// product can separate its managed-skill Settings experiences without forcing unrelated
// consumers to migrate in the same feature diff.
export { AgentCodeManagedSkillsService as AgentCodeConventionsService }

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Unknown filesystem error'
}

function installedDiscoveryError(error: unknown): {
  ok: false
  code: 'validation' | 'not-found' | 'git-unavailable' | 'network' | 'io-error'
  message: string
} {
  if (error instanceof GitHubSkillSourceError) {
    return { ok: false, code: error.code, message: error.message }
  }
  return { ok: false, code: 'io-error', message: safeErrorMessage(error) }
}

function installedFileChanges(
  previous: AgentCodeInstalledSkillRecord['files'],
  desired: AgentCodeInstalledSkillCandidate['files'],
): AgentCodeInstalledSkillFileChanges {
  const before = new Map(previous.map(file => [file.path, file]))
  const after = new Map(desired.map(file => [file.path, file]))
  const added = [...after.keys()].filter(path => !before.has(path)).sort()
  const removed = [...before.keys()].filter(path => !after.has(path)).sort()
  const changed = [...after.entries()]
    .filter(([path, file]) => {
      const old = before.get(path)
      return old !== undefined
        && (old.sha256 !== file.sha256 || old.executable !== file.executable)
    })
    .map(([path]) => path)
    .sort()
  return { added, changed, removed }
}
