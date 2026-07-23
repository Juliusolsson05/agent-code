import { basename, dirname, isAbsolute, resolve } from 'path'

import {
  AGENT_CODE_CONVENTIONS_SKILL_NAME,
  type AgentCodeConventionsDocument,
  type AgentCodeConventionsMaterialization,
} from '@shared/types/agentCodeConventions.js'
import { sha256Text } from './renderSkill.js'
import type { ResolvedAgentCodeConventionsTargets } from './targets.js'

export const RETIRED_CONVENTIONS_TARGET_PREFIX = 'retired:'

/**
 * Owns the pure relationship between untrusted persisted records and the live
 * provider registry. It deliberately performs no filesystem I/O: recognizing
 * historical state is not the same thing as authorizing a path mutation.
 */
export class AgentCodeConventionsOwnershipPolicy {
  rehomeMovedMaterializations(
    document: AgentCodeConventionsDocument,
    targets: ResolvedAgentCodeConventionsTargets,
  ): void {
    const currentTargets = new Map(targets.targets.map(target => [target.id, target]))
    for (const [key, record] of Object.entries(document.materializations)) {
      if (key.startsWith(RETIRED_CONVENTIONS_TARGET_PREFIX)) continue
      const target = currentTargets.get(key)
      if (target && resolve(record.path) === resolve(target.skillFile)) continue
      const retiredKey = this.retiredKey(key, record.path)
      document.materializations[retiredKey] = record
      delete document.materializations[key]
      const pending = document.pendingOperations[key]
      if (pending) {
        document.pendingOperations[retiredKey] = { ...pending, targetId: retiredKey }
        delete document.pendingOperations[key]
      }
    }
    for (const target of targets.targets) {
      if (document.materializations[target.id]) continue
      const retiredPrefix = `${RETIRED_CONVENTIONS_TARGET_PREFIX}${target.id}:`
      const returning = Object.entries(document.materializations).find(([key, record]) =>
        key.startsWith(retiredPrefix) && resolve(record.path) === resolve(target.skillFile))
      if (!returning) continue
      const [retiredKey, record] = returning
      // Provider roots can move A→B→A. The retired A record is still the exact
      // ownership proof for the newly-current path; promote it before enabled
      // reconciliation sees matching bytes as unmanaged or retired cleanup.
      document.materializations[target.id] = record
      delete document.materializations[retiredKey]
      const pending = document.pendingOperations[retiredKey]
      if (pending) {
        document.pendingOperations[target.id] = { ...pending, targetId: target.id }
        delete document.pendingOperations[retiredKey]
      }
    }
    for (const [key, pending] of Object.entries(document.pendingOperations)) {
      if (key.startsWith(RETIRED_CONVENTIONS_TARGET_PREFIX) || document.materializations[key]) {
        continue
      }
      const target = currentTargets.get(key)
      if (!target || resolve(pending.path) === resolve(target.skillFile)) continue
      if (pending.kind !== 'write' || !pending.desiredSha256) continue
      // A published-but-unfinalized write has no materialization yet. Turning
      // its journal into a retired tombstone preserves crash evidence across a
      // root move without ever making the historical path mutable.
      const retiredKey = this.retiredKey(key, pending.path)
      document.materializations[retiredKey] = {
        path: pending.path,
        sha256: pending.desiredSha256,
      }
      document.pendingOperations[retiredKey] = { ...pending, targetId: retiredKey }
      delete document.pendingOperations[key]
    }
  }

  persistedOwnershipProblem(
    document: AgentCodeConventionsDocument,
    targets: ResolvedAgentCodeConventionsTargets,
  ): string | null {
    const currentTargets = new Map(targets.targets.map(target => [target.id, target]))
    const currentPaths = new Set(targets.targets.map(target => resolve(target.skillFile)))
    const currentTargetIds = new Set(currentTargets.keys())

    for (const [key, record] of Object.entries(document.materializations)) {
      if (!this.isRecognizedPersistedPath(key, record.path, currentPaths, currentTargetIds)) {
        return `materialization ${key} points outside an allowed skill path.`
      }
    }
    for (const [key, operation] of Object.entries(document.pendingOperations)) {
      if (operation.targetId !== key) return `pending operation ${key} has a mismatched target id.`
      if (!this.isRecognizedPersistedPath(key, operation.path, currentPaths, currentTargetIds)) {
        return `pending operation ${key} points outside an allowed skill path.`
      }
      if (operation.kind === 'write') {
        const target = currentTargets.get(key)
        const record = document.materializations[key]
        const currentWrite = target && resolve(operation.path) === resolve(target.skillFile)
        const journaledHistoricalWrite = record
          && resolve(record.path) === resolve(operation.path)
          && (operation.previousSha256 === record.sha256
            || (key.startsWith(RETIRED_CONVENTIONS_TARGET_PREFIX)
              && operation.desiredSha256 === record.sha256))
        if ((!currentWrite && !journaledHistoricalWrite) || operation.desiredSha256 === null) {
          return `pending write ${key} does not match a current provider target.`
        }
        continue
      }
      const record = document.materializations[key]
      if (!record
        || resolve(record.path) !== resolve(operation.path)
        || operation.previousSha256 !== record.sha256
        || operation.desiredSha256 !== null) {
        return `pending delete ${key} does not match its ownership record.`
      }
    }
    return null
  }

  isCurrentMutationPath(
    path: string,
    targets: ResolvedAgentCodeConventionsTargets,
  ): boolean {
    const absolute = resolve(path)
    return targets.targets.some(target => resolve(target.skillFile) === absolute)
  }

  retiredFingerprint(key: string, record: AgentCodeConventionsMaterialization): string {
    // This token authorizes only forgetting app-owned state; it is never passed
    // to filesystem code. It still binds the user's confirmation to the exact
    // retained record so a stale renderer cannot clear changed state.
    return sha256Text(`${key}\0${record.path}\0${record.sha256}`)
  }

  private retiredKey(key: string, path: string): string {
    return `${RETIRED_CONVENTIONS_TARGET_PREFIX}${key}:${sha256Text(path).slice(0, 12)}`
  }

  private isRecognizedPersistedPath(
    key: string,
    path: string,
    currentPaths: Set<string>,
    currentTargetIds: Set<string>,
  ): boolean {
    if (!isAbsolute(path) || resolve(path) !== path) return false
    if (basename(path) !== 'SKILL.md'
      || basename(dirname(path)) !== AGENT_CODE_CONVENTIONS_SKILL_NAME
      || basename(dirname(dirname(path))) !== 'skills') return false
    const targetId = this.ownershipTargetId(key, currentTargetIds)
    if (!targetId) return false
    if (currentPaths.has(resolve(path))) return true
    // Historical paths may be preserved only when tied to a currently known
    // stable location id. This recognition never authorizes I/O; callers must
    // separately require `isCurrentMutationPath` before touching disk.
    return currentTargetIds.has(targetId)
  }

  private ownershipTargetId(key: string, currentTargetIds: Set<string>): string | null {
    if (currentTargetIds.has(key)) return key
    if (!key.startsWith(RETIRED_CONVENTIONS_TARGET_PREFIX)) return null
    const retired = key.slice(RETIRED_CONVENTIONS_TARGET_PREFIX.length)
    for (const targetId of [...currentTargetIds].sort((left, right) => right.length - left.length)) {
      const prefix = `${targetId}:`
      if (retired.startsWith(prefix) && /^[a-f0-9]{12}$/.test(retired.slice(prefix.length))) {
        return targetId
      }
    }
    return null
  }
}
