import { basename, dirname, isAbsolute, resolve } from 'path'

import type {
  AgentCodeConventionsDocument,
  AgentCodeConventionsMaterialization,
  AgentCodeCustomSkillRecord,
} from '@shared/types/agentCodeConventions.js'
import { sha256Text } from './renderSkill.js'
import type { ResolvedAgentCodeConventionsTargets } from './targets.js'

const RETIRED_CUSTOM_ARTIFACT_PREFIX = 'retired-custom:'

export function customArtifactKey(skillId: string, targetId: string): string {
  // IDs remain explicit inside the record. The map key is intentionally
  // opaque so a future provider id containing separators cannot become a
  // pathname-like grammar that ownership code later parses differently.
  return `custom:${sha256Text(`${skillId}\0${targetId}`)}`
}

export class AgentCodeCustomSkillOwnershipPolicy {
  rehomeMovedMaterializations(
    document: AgentCodeConventionsDocument,
    skill: AgentCodeCustomSkillRecord,
    targets: ResolvedAgentCodeConventionsTargets,
  ): void {
    const currentTargets = new Map(targets.targets.map(target => [target.id, target]))
    for (const [key, record] of this.materializations(document, skill.id)) {
      if (key.startsWith(RETIRED_CUSTOM_ARTIFACT_PREFIX)) continue
      const target = record.targetId ? currentTargets.get(record.targetId) : undefined
      if (target && key === customArtifactKey(skill.id, target.id)
        && resolve(record.path) === resolve(target.skillFile)) continue
      const retiredKey = this.retiredKey(skill.id, record.targetId ?? 'unknown', record.path)
      document.materializations[retiredKey] = record
      delete document.materializations[key]
      const pending = document.pendingOperations[key]
      if (pending) {
        document.pendingOperations[retiredKey] = pending
        delete document.pendingOperations[key]
      }
    }

    for (const [key, pending] of this.pendingOperations(document, skill.id)) {
      if (key.startsWith(RETIRED_CUSTOM_ARTIFACT_PREFIX) || document.materializations[key]) continue
      const target = currentTargets.get(pending.targetId)
      if (target && key === customArtifactKey(skill.id, target.id)
        && resolve(pending.path) === resolve(target.skillFile)) continue
      if (pending.kind !== 'write' || !pending.desiredSha256) continue
      const retiredKey = this.retiredKey(skill.id, pending.targetId, pending.path)
      document.materializations[retiredKey] = {
        path: pending.path,
        sha256: pending.desiredSha256,
        skillId: skill.id,
        targetId: pending.targetId,
      }
      document.pendingOperations[retiredKey] = pending
      delete document.pendingOperations[key]
    }

    for (const target of targets.targets) {
      const currentKey = customArtifactKey(skill.id, target.id)
      if (document.materializations[currentKey]) continue
      const returning = this.materializations(document, skill.id).find(([key, record]) =>
        key.startsWith(RETIRED_CUSTOM_ARTIFACT_PREFIX)
        && record.targetId === target.id
        && resolve(record.path) === resolve(target.skillFile))
      if (!returning) continue
      const [retiredKey, record] = returning
      document.materializations[currentKey] = record
      delete document.materializations[retiredKey]
      const pending = document.pendingOperations[retiredKey]
      if (pending) {
        document.pendingOperations[currentKey] = pending
        delete document.pendingOperations[retiredKey]
      }
    }
  }

  persistedOwnershipProblem(
    document: AgentCodeConventionsDocument,
    skills: Record<string, AgentCodeCustomSkillRecord>,
    targetsForSkill: (skill: AgentCodeCustomSkillRecord) => ResolvedAgentCodeConventionsTargets,
  ): string | null {
    for (const [key, record] of Object.entries(document.materializations)) {
      if (!record.skillId) continue
      const skill = skills[record.skillId]
      if (!skill || !record.targetId) return `custom materialization ${key} has no managed skill identity.`
      const targets = targetsForSkill(skill)
      if (!this.isRecognizedPath(key, record.path, record.targetId, skill, targets)) {
        return `custom materialization ${key} points outside an allowed skill path.`
      }
    }
    for (const [key, operation] of Object.entries(document.pendingOperations)) {
      if (!operation.skillId) continue
      const skill = skills[operation.skillId]
      if (!skill) return `custom pending operation ${key} has no managed skill identity.`
      const targets = targetsForSkill(skill)
      if (!this.isRecognizedPath(key, operation.path, operation.targetId, skill, targets)) {
        return `custom pending operation ${key} points outside an allowed skill path.`
      }
      const record = document.materializations[key]
      if (operation.kind === 'write') {
        const target = targets.targets.find(value => value.id === operation.targetId)
        const currentWrite = key === customArtifactKey(skill.id, operation.targetId)
          && target !== undefined
          && resolve(target.skillFile) === resolve(operation.path)
        const historicalWrite = record
          && record.skillId === skill.id
          && resolve(record.path) === resolve(operation.path)
          && operation.desiredSha256 === record.sha256
        if ((!currentWrite && !historicalWrite) || operation.desiredSha256 === null) {
          return `custom pending write ${key} does not match a current provider target.`
        }
      } else if (!record
        || record.skillId !== skill.id
        || resolve(record.path) !== resolve(operation.path)
        || record.sha256 !== operation.previousSha256
        || operation.desiredSha256 !== null) {
        return `custom pending delete ${key} does not match its ownership record.`
      }
    }
    return null
  }

  isCurrentMutationPath(
    key: string,
    record: { skillId?: string; targetId?: string; path: string },
    skill: AgentCodeCustomSkillRecord,
    targets: ResolvedAgentCodeConventionsTargets,
  ): boolean {
    if (key.startsWith(RETIRED_CUSTOM_ARTIFACT_PREFIX)
      || record.skillId !== skill.id
      || !record.targetId
      || key !== customArtifactKey(skill.id, record.targetId)) return false
    const target = targets.targets.find(value => value.id === record.targetId)
    return target !== undefined && resolve(target.skillFile) === resolve(record.path)
  }

  retiredFingerprint(key: string, record: AgentCodeConventionsMaterialization): string {
    return sha256Text(`${key}\0${record.path}\0${record.sha256}`)
  }

  isRetiredKey(key: string): boolean {
    return key.startsWith(RETIRED_CUSTOM_ARTIFACT_PREFIX)
  }

  private materializations(document: AgentCodeConventionsDocument, skillId: string) {
    return Object.entries(document.materializations).filter(([, record]) => record.skillId === skillId)
  }

  private pendingOperations(document: AgentCodeConventionsDocument, skillId: string) {
    return Object.entries(document.pendingOperations).filter(([, operation]) =>
      operation.skillId === skillId)
  }

  private retiredKey(skillId: string, targetId: string, path: string): string {
    return `${RETIRED_CUSTOM_ARTIFACT_PREFIX}${sha256Text(
      `${skillId}\0${targetId}\0${path}`,
    )}`
  }

  private isRecognizedPath(
    key: string,
    path: string,
    targetId: string,
    skill: AgentCodeCustomSkillRecord,
    targets: ResolvedAgentCodeConventionsTargets,
  ): boolean {
    if (!isAbsolute(path) || resolve(path) !== path) return false
    if (basename(path) !== 'SKILL.md'
      || basename(dirname(path)) !== skill.name
      || basename(dirname(dirname(path))) !== 'skills') return false
    const target = targets.targets.find(value => value.id === targetId)
    if (!target) return false
    if (key === customArtifactKey(skill.id, targetId)) {
      return resolve(path) === resolve(target.skillFile)
    }
    return key.startsWith(RETIRED_CUSTOM_ARTIFACT_PREFIX)
  }
}
