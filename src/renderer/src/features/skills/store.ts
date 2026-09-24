import { useEffect } from 'react'
import { create } from 'zustand'

import {
  AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT,
  announceAgentCodeManagedSkillsChange,
  type AgentCodeManagedSkillsChange,
} from '@renderer/features/settings/lib/agentCodeManagedSkillsEvents'
import type {
  AgentCodeCustomSkillsMutationResult,
  AgentCodeCustomSkillsSnapshot,
} from '@shared/types/agentCodeCustomSkills'
import type {
  AgentCodeInstalledSkillsMutationResult,
  AgentCodeInstalledSkillsSnapshot,
  AgentCodeInstalledSkillUpdateResult,
} from '@shared/types/agentCodeInstalledSkills'
import type { ExternalAgentSkillsSnapshot } from '@shared/types/agentSkills'

/**
 * What the Skills page knows about one installed skill's upstream (#1161).
 * Only explicit checks produce this — there are no background checks.
 */
export type SkillUpdateState =
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'error'; message: string }
  | Extract<AgentCodeInstalledSkillUpdateResult, { kind: 'update-available' }>

type SkillsState = {
  installed: AgentCodeInstalledSkillsSnapshot | null
  custom: AgentCodeCustomSkillsSnapshot | null
  external: ExternalAgentSkillsSnapshot | null
  updates: Record<string, SkillUpdateState>
  loadError: string | null
}

/**
 * Non-persisted mirror of main's managed-skill document for Settings → Skills
 * and the Add dialog (#1161).
 *
 * WHY one store for the grid and the dialog: the dialog installs, and the grid
 * must show the result without a second fetch racing the first. Main stays
 * the only truth (snapshots carry its revision); nothing here is persisted.
 */
export const useSkillsStore = create<SkillsState>(() => ({
  installed: null,
  custom: null,
  external: null,
  updates: {},
  loadError: null,
}))

/**
 * Loads all three sources. `audit` reconciles provider roots first (the old
 * rows' behaviour when Settings opens); later refreshes skip it so a click
 * does not rescan every provider folder.
 */
export async function refreshSkills(options: { audit?: boolean } = {}): Promise<void> {
  try {
    const [installed, custom, external] = await Promise.all([
      options.audit ? window.api.auditAgentCodeInstalledSkills() : window.api.getAgentCodeInstalledSkills(),
      options.audit ? window.api.auditAgentCodeCustomSkills() : window.api.getAgentCodeCustomSkills(),
      window.api.listExternalAgentSkills().catch(() => ({ skills: [], notices: ['Could not scan for other skills.'] })),
    ])
    useSkillsStore.setState({ installed, custom, external, loadError: null })
  } catch (cause) {
    useSkillsStore.setState({ loadError: cause instanceof Error ? cause.message : 'Could not load skills.' })
  }
}

/** Applies a mutation's snapshot and returns its failure message, if any. */
export function applyInstalledSkillsResult(result: AgentCodeInstalledSkillsMutationResult): string | null {
  if ('snapshot' in result) {
    useSkillsStore.setState({ installed: result.snapshot })
    // Sibling surfaces (the Conventions row) share main's revision counter.
    announceAgentCodeManagedSkillsChange({ source: 'installed-skills', revision: result.snapshot.revision })
  }
  if (result.ok) return null
  if ('message' in result) return result.message
  if (result.code === 'revision-conflict') return 'Skills changed elsewhere. The list was refreshed; try again.'
  if (result.code === 'unsupported') return 'No enabled provider supports personal skills.'
  return 'Managed skill state needs recovery before it can be changed.'
}

export function applyCustomSkillsResult(result: AgentCodeCustomSkillsMutationResult): string | null {
  if ('snapshot' in result) {
    useSkillsStore.setState({ custom: result.snapshot })
    announceAgentCodeManagedSkillsChange({ source: 'custom-skills', revision: result.snapshot.revision })
  }
  if (result.ok) return null
  if ('message' in result) return result.message
  if (result.code === 'revision-conflict') return 'Skills changed elsewhere. The list was refreshed; try again.'
  if (result.code === 'unsupported') return 'No enabled provider supports personal skills.'
  return 'Managed skill state needs recovery before it can be changed.'
}

export async function checkSkillForUpdates(skillId: string): Promise<void> {
  useSkillsStore.setState(state => ({ updates: { ...state.updates, [skillId]: { kind: 'checking' } } }))
  let next: SkillUpdateState
  try {
    const result = await window.api.checkAgentCodeInstalledSkillForUpdates(skillId)
    next = !result.ok
      ? { kind: 'error', message: result.message }
      : result.kind === 'up-to-date' ? { kind: 'up-to-date' } : result
  } catch (cause) {
    next = { kind: 'error', message: cause instanceof Error ? cause.message : 'Could not check for updates.' }
  }
  useSkillsStore.setState(state => ({ updates: { ...state.updates, [skillId]: next } }))
}

/**
 * Checks every installed skill, a few at a time.
 *
 * WHY bounded concurrency instead of Promise.all: each check is a GitHub
 * ref advertisement plus a tree request, and unauthenticated GitHub API
 * limits are per IP. A user with a hundred skills should see results fill in,
 * not a burst of rate-limit errors.
 */
export async function checkAllSkillsForUpdates(): Promise<void> {
  const skills = useSkillsStore.getState().installed?.skills ?? []
  const queue = [...skills.map(skill => skill.id)]
  const worker = async () => {
    while (queue.length > 0) await checkSkillForUpdates(queue.shift()!)
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
}

export function clearSkillUpdate(skillId: string): void {
  useSkillsStore.setState(state => {
    const { [skillId]: _removed, ...rest } = state.updates
    return { updates: rest }
  })
}

/**
 * Initial audit plus refresh on every change another surface or an agent
 * makes. Mounted by the Skills grid; the store outlives it so reopening
 * Settings shows the last state instantly while the audit runs.
 */
export function useSkillsSync(): void {
  useEffect(() => {
    void refreshSkills({ audit: true })
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<AgentCodeManagedSkillsChange>).detail
      const state = useSkillsStore.getState()
      const known = Math.max(state.installed?.revision ?? -1, state.custom?.revision ?? -1)
      if (!change || change.revision <= known) return
      void refreshSkills()
    }
    window.addEventListener(AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT, onChanged)
    const unsubscribeAgent = window.api.onManagedSkillsAgentChange?.(() => void refreshSkills())
    return () => {
      window.removeEventListener(AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT, onChanged)
      unsubscribeAgent?.()
    }
  }, [])
}
