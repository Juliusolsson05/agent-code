// Grok skill discovery.
//
// DELIBERATELY EMPTY TODAY, and that emptiness is evidence, not an omission:
// the controlled-runtime corpus records turns, permissions, questions and plan
// approvals, and none of it exercises a native Grok skill mechanism. Where
// OpenCode's discovery was written from its vendored source tree and Claude's
// from its documented home layout, Grok has NEITHER available here, and the
// decomposition plan forbids inventing provider behaviour an observation does
// not cover ("a capability that depends on an open gap stays explicitly
// unsupported until a recording exists").
//
// What users still see: Agent Code's own personal-agent skill locations are a
// provider-independent registry concept (see claude/opencode registry entries),
// so the Skills UI keeps working through those roots without this discovery
// claiming a native Grok layout it cannot prove.
//
// Reopen trigger: any recording or upstream statement of Grok's native skill
// directories — then mirror the shape of discoverOpencodeSkillRoots.

import type { AgentSkillDiscovery, AgentSkillDiscoveryContext } from '@shared/types/agentSkills.js'

export async function discoverGrokSkillRoots(_context: AgentSkillDiscoveryContext): Promise<AgentSkillDiscovery> {
  // A visible notice rather than silence: the Skills UI can explain why a
  // native Grok root list is empty instead of looking broken.
  return { roots: [], notices: ['Native Grok skill locations are not yet recorded; personal agent skills still appear from the shared locations.'] }
}
