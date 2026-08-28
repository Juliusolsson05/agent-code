import { basename, dirname, isAbsolute, resolve } from 'node:path'

import type {
  AgentCodeConventionsDocument,
  AgentCodeInstalledSkillMaterialization,
  AgentCodeInstalledSkillRecord,
} from '@shared/types/agentCodeConventions.js'
import { sha256Text } from './renderSkill.js'
import type { ResolvedAgentCodeConventionsTargets } from './targets.js'

const RETIRED_INSTALLED_ARTIFACT_PREFIX = 'retired-installed:'

export function installedArtifactKey(skillId: string, targetId: string): string {
  return `installed:${sha256Text(`${skillId}\0${targetId}`)}`
}

export class AgentCodeInstalledSkillOwnershipPolicy {
  rehomeMovedMaterializations(
    document: AgentCodeConventionsDocument,
    skill: AgentCodeInstalledSkillRecord,
    targets: ResolvedAgentCodeConventionsTargets,
  ): void {
    const currentTargets = new Map(targets.targets.map(target => [target.id, target]))
    for (const [key, record] of this.materializations(document, skill.id)) {
      if (this.isRetiredKey(key)) continue
      const target = currentTargets.get(record.targetId)
      if (target && key === installedArtifactKey(skill.id, target.id)
        && resolve(record.path) === resolve(target.skillDirectory)) continue
      const retiredKey = this.retiredKey(skill.id, record.targetId, record.path)
      document.installedMaterializations[retiredKey] = record
      delete document.installedMaterializations[key]
      const pending = document.installedPendingOperations[key]
      if (pending) {
        document.installedPendingOperations[retiredKey] = pending
        delete document.installedPendingOperations[key]
      }
    }

    for (const [key, pending] of this.pendingOperations(document, skill.id)) {
      if (this.isRetiredKey(key) || document.installedMaterializations[key]) continue
      const target = currentTargets.get(pending.targetId)
      if (target && key === installedArtifactKey(skill.id, target.id)
        && resolve(pending.path) === resolve(target.skillDirectory)) continue
      // A pending sync may have published some or all reviewed files before a
      // provider root moved. Preserve its desired manifest as historical
      // ownership evidence; deletion still re-verifies every file hash.
      if (pending.kind !== 'sync' || !pending.desiredSnapshotDigest) continue
      const retiredKey = this.retiredKey(skill.id, pending.targetId, pending.path)
      document.installedMaterializations[retiredKey] = {
        skillId: skill.id,
        targetId: pending.targetId,
        path: pending.path,
        snapshotDigest: pending.desiredSnapshotDigest,
        files: pending.desiredFiles,
      }
      document.installedPendingOperations[retiredKey] = pending
      delete document.installedPendingOperations[key]
    }

    for (const target of targets.targets) {
      const currentKey = installedArtifactKey(skill.id, target.id)
      if (document.installedMaterializations[currentKey]) continue
      const returning = this.materializations(document, skill.id).find(([key, record]) =>
        this.isRetiredKey(key)
        && record.targetId === target.id
        && resolve(record.path) === resolve(target.skillDirectory))
      if (!returning) continue
      const [retiredKey, record] = returning
      document.installedMaterializations[currentKey] = record
      delete document.installedMaterializations[retiredKey]
      const pending = document.installedPendingOperations[retiredKey]
      if (pending) {
        document.installedPendingOperations[currentKey] = pending
        delete document.installedPendingOperations[retiredKey]
      }
    }
  }

  persistedOwnershipProblem(
    document: AgentCodeConventionsDocument,
    skills: Record<string, AgentCodeInstalledSkillRecord>,
    targetsForSkill: (skill: AgentCodeInstalledSkillRecord) => ResolvedAgentCodeConventionsTargets,
  ): string | null {
    for (const [key, record] of Object.entries(document.installedMaterializations)) {
      const skill = skills[record.skillId]
      if (!skill) return `installed materialization ${key} has no managed skill identity.`
      if (!this.isRecognizedPath(key, record, skill, targetsForSkill(skill))) {
        return `installed materialization ${key} points outside an allowed skill path.`
      }
    }
    for (const [key, operation] of Object.entries(document.installedPendingOperations)) {
      const skill = skills[operation.skillId]
      if (!skill) return `installed pending operation ${key} has no managed skill identity.`
      if (!this.isRecognizedPath(key, operation, skill, targetsForSkill(skill))) {
        return `installed pending operation ${key} points outside an allowed skill path.`
      }
      const record = document.installedMaterializations[key]
      if (operation.kind === 'delete') {
        if (!record
          || record.snapshotDigest !== operation.previousSnapshotDigest
          || JSON.stringify(record.files) !== JSON.stringify(operation.previousFiles)) {
          return `installed pending delete ${key} does not match its ownership record.`
        }
      } else if (!operation.desiredSnapshotDigest || operation.desiredFiles.length === 0) {
        return `installed pending sync ${key} has no reviewed desired snapshot.`
      }
    }
    return null
  }

  isCurrentMutationPath(
    key: string,
    record: { skillId: string; targetId: string; path: string },
    skill: AgentCodeInstalledSkillRecord,
    targets: ResolvedAgentCodeConventionsTargets,
  ): boolean {
    if (this.isRetiredKey(key)
      || record.skillId !== skill.id
      || key !== installedArtifactKey(skill.id, record.targetId)) return false
    const target = targets.targets.find(value => value.id === record.targetId)
    return target !== undefined && resolve(target.skillDirectory) === resolve(record.path)
  }

  isRetiredKey(key: string): boolean {
    return key.startsWith(RETIRED_INSTALLED_ARTIFACT_PREFIX)
  }

  retiredFingerprint(key: string, record: AgentCodeInstalledSkillMaterialization): string {
    return sha256Text(`${key}\0${record.path}\0${record.snapshotDigest}`)
  }

  private materializations(document: AgentCodeConventionsDocument, skillId: string) {
    return Object.entries(document.installedMaterializations)
      .filter(([, record]) => record.skillId === skillId)
  }

  private pendingOperations(document: AgentCodeConventionsDocument, skillId: string) {
    return Object.entries(document.installedPendingOperations)
      .filter(([, operation]) => operation.skillId === skillId)
  }

  private retiredKey(skillId: string, targetId: string, path: string): string {
    return `${RETIRED_INSTALLED_ARTIFACT_PREFIX}${sha256Text(`${skillId}\0${targetId}\0${path}`)}`
  }

  private isRecognizedPath(
    key: string,
    record: { skillId: string; targetId: string; path: string },
    skill: AgentCodeInstalledSkillRecord,
    targets: ResolvedAgentCodeConventionsTargets,
  ): boolean {
    if (!isAbsolute(record.path) || resolve(record.path) !== record.path) return false
    if (record.skillId !== skill.id) return false
    if (basename(record.path) !== skill.name || basename(dirname(record.path)) !== 'skills') return false
    // Retired records intentionally outlive a provider registry location. The
    // exact derived key and fixed `<skills>/<name>` suffix remain verifiable
    // even when that target id is no longer advertised; requiring a current
    // target here would turn every legitimate provider removal into global
    // recovery and erase the purpose of retirement evidence.
    if (this.isRetiredKey(key)) {
      return key === this.retiredKey(skill.id, record.targetId, record.path)
    }
    const target = targets.targets.find(value => value.id === record.targetId)
    if (!target) return false
    if (key === installedArtifactKey(skill.id, record.targetId)) {
      return resolve(record.path) === resolve(target.skillDirectory)
    }
    return false
  }
}
