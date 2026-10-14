// Hermes skill discovery: none on this machine, by construction.
//
// Hermes' skills live on the Hermes HOST (`~/.hermes/skills` on the user's
// VPS, plus its built-in and hub skills), managed by Hermes itself: it
// creates and improves them from experience. Nothing Agent Code installs on
// this Mac reaches it. The skills a Hermes pane CAN use show up where Hermes
// lists them, which Agent Code does not show yet (no `/` completion in v1,
// #1489): a skill whose name the user knows runs when typed as `/<name>`
// (command.dispatch, recorded S13).

import type { AgentSkillDiscovery, AgentSkillDiscoveryContext } from '@shared/types/agentSkills.js'

export async function discoverHermesSkillRoots(_context: AgentSkillDiscoveryContext): Promise<AgentSkillDiscovery> {
  return { roots: [], notices: ['Hermes skills live on your Hermes server and are managed there. In a Hermes chat, run one by typing / followed by its name.'] }
}
