import { join, resolve } from 'node:path'
import type { AgentSkillDiscovery, AgentSkillDiscoveryContext, AgentSkillRoot } from '@shared/types/agentSkills.js'
import { ancestorsThrough, findAncestorWithMarker } from '@providers/shared/runtime/skillDiscovery.js'

// Mirrors `truthy()` in OpenCode's core/src/flag/flag.ts. OpenCode lowercases
// first, so `OPENCODE_DISABLE_EXTERNAL_SKILLS=TRUE` disables skills too; the
// first version of this adapter compared case-sensitively and missed that.
function flag(environment: AgentSkillDiscoveryContext['environment'], key: string): boolean {
  const value = environment[key]?.toLowerCase()
  return value === 'true' || value === '1'
}

/**
 * OpenCode skill roots.
 *
 * Source of truth (vendored, since OpenCode's docs summarize but omit several
 * roots): `vendor/in_progress/opencode/packages/opencode/src/skill/index.ts`
 * `discoverSkills`, and `config/paths.ts` `directories`.
 *
 * - External compatibility folders (`.claude`, `.agents`) use the pattern
 *   `skills/**\/SKILL.md` with `dot: true`: unbounded depth, hidden folders
 *   included. `.claude` is dropped by OPENCODE_DISABLE_CLAUDE_CODE or
 *   OPENCODE_DISABLE_CLAUDE_CODE_SKILLS; all external folders by
 *   OPENCODE_DISABLE_EXTERNAL_SKILLS.
 * - Config directories use `{skill,skills}/**\/SKILL.md` without `dot`, so the
 *   singular `skill/` folder counts and hidden folders do not. Those directories
 *   are the global XDG config dir, project `.opencode` folders (unless
 *   OPENCODE_DISABLE_PROJECT_CONFIG), `~/.opencode`, and OPENCODE_CONFIG_DIR.
 * - Every glob follows symlinks (`symlink: true`).
 */
export async function discoverOpencodeSkillRoots(context: AgentSkillDiscoveryContext): Promise<AgentSkillDiscovery> {
  const { cwd, homeDirectory: home, environment } = context
  // OpenCode walks project folders from the session directory up to its
  // worktree (`fsys.up({ start: directory, stop: worktree })`). Outside a git
  // repository that walk is not stopped early, so it reaches the filesystem
  // root; roots that coincide with the home-level ones are deduplicated by
  // physical path in the collector, where the global (listed-first) label wins.
  const worktree = await findAncestorWithMarker(cwd, ['.git'])
  const projectDirectories = ancestorsThrough(cwd, worktree)
  const roots: AgentSkillRoot[] = []

  if (!flag(environment, 'OPENCODE_DISABLE_EXTERNAL_SKILLS')) {
    const external = [
      ...(flag(environment, 'OPENCODE_DISABLE_CLAUDE_CODE') || flag(environment, 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS')
        ? [] : ['.claude']),
      '.agents',
    ]
    for (const name of external) {
      roots.push({ path: join(home, name, 'skills'), source: 'personal', layout: 'recursive', includeHidden: true })
    }
    for (const directory of projectDirectories) {
      for (const name of external) {
        roots.push({ path: join(directory, name, 'skills'), source: 'project', layout: 'recursive', includeHidden: true })
      }
    }
  }

  // Global config directories are listed before project `.opencode` folders so
  // a directory reachable both ways (a project walk that passes through home)
  // keeps its personal label.
  const personalConfig = [
    join(environment.XDG_CONFIG_HOME || join(home, '.config'), 'opencode'),
    join(home, '.opencode'),
    ...(environment.OPENCODE_CONFIG_DIR ? [resolve(environment.OPENCODE_CONFIG_DIR)] : []),
  ]
  const projectConfig = flag(environment, 'OPENCODE_DISABLE_PROJECT_CONFIG')
    ? [] : projectDirectories.map(directory => join(directory, '.opencode'))
  for (const [directories, source] of [[personalConfig, 'personal'], [projectConfig, 'project']] as const) {
    for (const directory of directories) {
      for (const folder of ['skill', 'skills']) {
        roots.push({ path: join(directory, folder), source, layout: 'recursive' })
      }
    }
  }

  return {
    roots,
    // `skills.paths` needs OpenCode's full layered JSONC config resolution and
    // `skills.urls` is a network pull; reproducing either here would be a second,
    // drifting implementation of OpenCode's config loader.
    notices: ['OpenCode skills added through `skills.paths` or `skills.urls` in opencode.json are not included.'],
  }
}
