import { join } from 'node:path'
import { reconcileExternalCodexConfig } from './externalCodexConfig'
import { assertOwnedSkill, ownedSkillBytes, readRegular, replaceObserved } from './externalOperatorFiles'

// This writer is intentionally separate from the all-provider skill manager:
// installing the operator into ~/.agents/skills would advertise it to the very
// agents it operates. Only the selected external Codex home receives this skill.
// Ownership proofs and the compare-before-replace writes live in
// externalOperatorFiles.ts, shared with the Claude integration.
export function createExternalCodexIntegration(codexHome: string, skillSource: string) {
  const configPath = join(codexHome, 'config.toml')
  const skillPath = join(codexHome, 'skills', 'agent-code-computer-execution', 'SKILL.md')
  const skill = ownedSkillBytes(skillSource)
  return {
    client: 'codex' as const,
    configPath, skillPath,
    async reconcile(connection: { url: string; token: string } | null): Promise<void> {
      const existing = await readRegular(configPath)
      const oldSkill = await readRegular(skillPath)
      assertOwnedSkill(oldSkill, skillPath)
      const next = reconcileExternalCodexConfig(existing ?? '', connection)
      // Validate both destinations before either mutation. On a later I/O failure
      // Settings stops the listener; the next retry recognizes any completed half.
      if (connection) await replaceObserved(skillPath, oldSkill, skill)
      if (next !== (existing ?? '')) await replaceObserved(configPath, existing, next)
      if (!connection && oldSkill !== null) await replaceObserved(skillPath, oldSkill, null)
    },
  }
}
