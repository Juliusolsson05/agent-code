import { lstat, opendir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse } from '@iarna/toml'
import { asRecord } from '@shared/lib/asRecord.js'
import type {
  AgentSkillDiscovery,
  AgentSkillDiscoveryContext,
  AgentSkillEnablementRule,
  AgentSkillRoot,
} from '@shared/types/agentSkills.js'
import {
  ancestorsThrough,
  findAncestorWithMarker,
  missingSkillPath,
  pathInsidePlugin,
  readSkillFile,
  readSkillJson,
} from '@providers/shared/runtime/skillDiscovery.js'
import { disabledExternalOperatorSkill } from '@providers/shared/runtime/externalControlExclusion.js'

// Source of truth is the vendored Codex tree (`vendor/codex-src/codex-rs`):
// `ext/skills/src/host_roots.rs` (which roots exist), `ext/skills/src/loader/`
// (how each root is walked), `core-plugins/src/{loader,manifest,store}.rs` and
// `utils/plugins/src/` (plugin resolution), `config/src/skills_config.rs`.

/** ext/skills/src/loader/mod.rs MAX_SCAN_DEPTH: SKILL.md at most six segments below a root. */
const MAX_SCAN_DEPTH = 6
/** utils/plugins/src/plugin_namespace.rs AGENT_PLUGIN_SCHEMA_PREFIX. */
const AGENT_PLUGIN_SCHEMA_PREFIX = 'https://agent-plugins.org/schemas/'
/** exec-server-protocol DISCOVERABLE_PLUGIN_MANIFEST_PATHS, in lookup order. */
const LEGACY_MANIFEST_DIRECTORIES = ['.codex-plugin', '.claude-plugin', '.cursor-plugin']
/** utils/plugins/src/lib.rs validate_plugin_version_segment. */
const VERSION_SEGMENT = /^[A-Za-z0-9_.+-]+$/
const MAX_CACHED_VERSIONS = 512

const isDirectory = (path: string) => stat(path).then(info => info.isDirectory(), () => false)

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right))
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * core-plugins/src/store.rs compare_plugin_versions: SemVer order when both
 * segments parse, otherwise plain string order.
 *
 * WHY implemented here: the first version refused to choose among several
 * cached versions and hid those plugins behind an "ambiguous" notice, but
 * Codex deterministically loads the highest one (`active_plugin_version`).
 * Lexical order is wrong for exactly the common case (`1.9.0` vs `1.10.0`).
 * A provider runtime module must not import `@main` helpers, and the only
 * semver comparator in the app lives in main's CLI updater.
 */
export function compareCodexPluginVersions(left: string, right: string): number {
  const a = SEMVER.exec(left)
  const b = SEMVER.exec(right)
  if (!a || !b) return left < right ? -1 : left > right ? 1 : 0
  for (const index of [1, 2, 3]) {
    const difference = compareIdentifiers(a[index]!, b[index]!)
    if (difference !== 0) return difference
  }
  // A release sorts above any prerelease of the same version.
  if (a[4] === undefined || b[4] === undefined) {
    if (a[4] !== b[4]) return a[4] === undefined ? 1 : -1
  } else {
    const leftParts = a[4].split('.')
    const rightParts = b[4].split('.')
    for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
      const difference = compareIdentifiers(leftParts[index]!, rightParts[index]!)
      if (difference !== 0) return difference
    }
    if (leftParts.length !== rightParts.length) return leftParts.length < rightParts.length ? -1 : 1
  }
  // Build metadata only breaks ties so the choice stays deterministic.
  const leftBuild = a[5] ?? ''
  const rightBuild = b[5] ?? ''
  return leftBuild < rightBuild ? -1 : leftBuild > rightBuild ? 1 : 0
}

/** store.rs active_plugin_version: prefer `local`, otherwise the highest version directory. */
async function activePluginVersion(pluginBase: string, id: string, notices: string[]): Promise<string | null> {
  const versions: string[] = []
  let inspected = 0
  try {
    for await (const entry of await opendir(pluginBase)) {
      if (++inspected > MAX_CACHED_VERSIONS) {
        notices.push(`Codex plugin ${id} has too many cached versions to inspect; its skills are not listed.`)
        return null
      }
      if (entry.isDirectory() && VERSION_SEGMENT.test(entry.name) && entry.name !== '.' && entry.name !== '..') {
        versions.push(entry.name)
      }
    }
  } catch (error) {
    if (!missingSkillPath(error)) notices.push(`Could not inspect installed Codex plugin: ${id}`)
    return null
  }
  if (versions.includes('local')) return 'local'
  return versions.sort(compareCodexPluginVersions).at(-1) ?? null
}

async function readJsonQuietly(path: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readSkillFile(path, 1024 * 1024)
    return text === null ? null : asRecord(JSON.parse(text))
  } catch {
    return null
  }
}

/**
 * Skill roots for one installed plugin version.
 *
 * Manifest lookup (find_plugin_manifest_path): a regular, non-symlink root
 * `plugin.json` with an agent-plugins.org `$schema` is an agent plugin, whose
 * skills are direct children only. A symlinked or non-file root `plugin.json`
 * makes Codex reject the plugin outright. Otherwise the first of
 * `.codex-plugin/`, `.claude-plugin/`, `.cursor-plugin/` `plugin.json` wins —
 * the first version only knew `.codex-plugin` and lost every skill of plugins
 * shipped with the other two manifests — and those skills are walked
 * recursively like host roots, plus migrated legacy command skills.
 *
 * Manifest `skills` paths (manifest.rs resolve_manifest_path) must start with
 * `./` and stay inside the plugin. Valid declared paths REPLACE the default
 * `skills/` folder (loader.rs plugin_skill_roots); only when none resolve does
 * the default apply.
 */
async function pluginSkillRoots(pluginRoot: string, pluginName: string, notices: string[]): Promise<AgentSkillRoot[]> {
  let agentPlugin = false
  let manifestPath: string | null = null
  const rootManifest = join(pluginRoot, 'plugin.json')
  const rootManifestInfo = await lstat(rootManifest).catch(() => null)
  if (rootManifestInfo && (rootManifestInfo.isSymbolicLink() || !rootManifestInfo.isFile())) {
    notices.push(`Codex rejects the ${pluginName} plugin because its plugin.json is not a regular file; its skills are not listed.`)
    return []
  }
  if (rootManifestInfo) {
    const schema = (await readJsonQuietly(rootManifest))?.$schema
    if (typeof schema === 'string' && schema.startsWith(AGENT_PLUGIN_SCHEMA_PREFIX)) {
      agentPlugin = true
      manifestPath = rootManifest
    }
  }
  if (!manifestPath) {
    for (const directory of LEGACY_MANIFEST_DIRECTORIES) {
      const candidate = join(pluginRoot, directory, 'plugin.json')
      if (await stat(candidate).then(info => info.isFile(), () => false)) {
        manifestPath = candidate
        break
      }
    }
  }
  if (!manifestPath) {
    notices.push(`The ${pluginName} Codex plugin has no plugin manifest; its skills are not listed.`)
    return []
  }

  const manifest = await readSkillJson(manifestPath, notices)
  const declared = typeof manifest.skills === 'string' ? [manifest.skills]
    : Array.isArray(manifest.skills) ? manifest.skills : []
  const paths: string[] = []
  let rejected = 0
  for (const value of declared) {
    const inside = typeof value === 'string' && value.startsWith('./') ? pathInsidePlugin(pluginRoot, value.slice(2)) : null
    if (inside) paths.push(inside)
    else rejected += 1
  }
  if (rejected > 0) {
    notices.push(`Ignored ${rejected} skill path(s) in the ${pluginName} Codex plugin manifest that Codex also rejects.`)
  }
  if (paths.length === 0 && await isDirectory(join(pluginRoot, 'skills'))) paths.push(join(pluginRoot, 'skills'))
  if (!agentPlugin) {
    const migrated = join(pluginRoot, '.codex-plugin', 'migrated-command-skills')
    if (await isDirectory(migrated)) paths.push(migrated)
  }

  const base = { source: 'plugin' as const, sourceLabel: pluginName }
  return [...new Set(paths)].map(path => agentPlugin
    ? { ...base, path, layout: 'children' as const }
    : { ...base, path, layout: 'recursive' as const, maxDepth: MAX_SCAN_DEPTH })
}

export async function discoverCodexSkillRoots(context: AgentSkillDiscoveryContext): Promise<AgentSkillDiscovery> {
  const { homeDirectory: home, environment } = context
  const cwd = resolve(context.cwd)
  const codexHome = resolve(environment.CODEX_HOME || join(home, '.codex'))
  const notices: string[] = []

  let config: Record<string, unknown> = {}
  try {
    const text = await readSkillFile(join(codexHome, 'config.toml'), 1024 * 1024)
    config = text ? asRecord(parse(text)) ?? {} : {}
  } catch {
    notices.push('Could not read Codex configuration; its plugin and skill settings are not applied here.')
  }
  const skillsConfig = asRecord(config.skills)

  // host_roots.rs repo_agents_skill_roots: the project root is the nearest
  // ancestor holding a `project_root_markers` entry (default `.git`); an empty
  // marker list means the cwd alone. Codex falls back to the cwd when no marker
  // exists, instead of walking to the filesystem root.
  const configuredMarkers = config.project_root_markers
  const markers = Array.isArray(configuredMarkers) && configuredMarkers.every(marker => typeof marker === 'string')
    ? configuredMarkers as string[]
    : ['.git']
  const projectRoot = markers.length === 0 ? cwd : await findAncestorWithMarker(cwd, markers) ?? cwd
  const projectDirectories = ancestorsThrough(cwd, projectRoot)

  // Host roots are walked recursively with hidden folders skipped below the
  // root (loader/host.rs HiddenDirectoryPolicy::Skip), which is why the
  // `.system` defaults need a root of their own.
  const tree = (path: string, source: AgentSkillRoot['source'], sourceLabel?: string): AgentSkillRoot =>
    ({ path, source, layout: 'recursive', maxDepth: MAX_SCAN_DEPTH, ...(sourceLabel ? { sourceLabel } : {}) })
  const roots: AgentSkillRoot[] = []
  // Project config layers (`.codex/`, loader/mod.rs discover_project_layers)
  // contribute `.codex/skills`; the first version omitted them. A `.codex`
  // that IS CODEX_HOME is the user layer, not a project one. codex-headless
  // pre-trusts the spawn directory, so these layers are active for Agent Code
  // sessions.
  for (const directory of projectDirectories) {
    const dotCodex = join(directory, '.codex')
    if (dotCodex !== codexHome && await isDirectory(dotCodex)) roots.push(tree(join(dotCodex, 'skills'), 'project'))
  }
  for (const directory of projectDirectories) roots.push(tree(join(directory, '.agents', 'skills'), 'project'))
  roots.push(tree(join(codexHome, 'skills'), 'personal'))
  roots.push(tree(join(home, '.agents', 'skills'), 'personal'))
  // skills_config.rs bundled_skills_enabled_from_stack: `[skills.bundled]
  // enabled = false` removes the embedded system skills.
  if (asRecord(skillsConfig?.bundled)?.enabled !== false) {
    roots.push(tree(join(codexHome, 'skills', '.system'), 'system', 'Codex defaults'))
  }
  roots.push(tree('/etc/codex/skills', 'system'))

  for (const [id, value] of Object.entries(asRecord(config.plugins) ?? {})) {
    const settings = asRecord(value)
    // config/src/types.rs PluginConfig: `enabled` defaults to true, so a table
    // without the key is an enabled plugin (the first version skipped it).
    if (!settings || settings.enabled === false) continue
    const match = id.match(/^([A-Za-z0-9_-][A-Za-z0-9._-]*)@([A-Za-z0-9_-][A-Za-z0-9._-]*)$/)
    if (!match) {
      notices.push('A configured Codex plugin has an unsupported identifier.')
      continue
    }
    const pluginBase = join(codexHome, 'plugins', 'cache', match[2]!, match[1]!)
    const version = await activePluginVersion(pluginBase, id, notices)
    if (!version) {
      notices.push(`Codex plugin ${id} is enabled but not installed locally; its skills are not listed.`)
      continue
    }
    roots.push(...await pluginSkillRoots(join(pluginBase, version), match[1]!, notices))
  }

  // skills_config.rs SkillConfigRules: user `[[skills.config]]` entries in
  // order, then the SessionFlags layer. Agent Code's own launch flags disable
  // the external-operator skill for every Codex session it starts
  // (externalControlExclusion.ts), so the panel must not present that skill as
  // usable just because its file sits in CODEX_HOME.
  const enablementRules: AgentSkillEnablementRule[] = []
  for (const entry of Array.isArray(skillsConfig?.config) ? skillsConfig.config : []) {
    const rule = asRecord(entry)
    if (!rule || typeof rule.enabled !== 'boolean') continue
    if (typeof rule.path === 'string') enablementRules.push({ path: resolve(codexHome, rule.path), enabled: rule.enabled })
    else if (typeof rule.name === 'string') enablementRules.push({ name: rule.name, enabled: rule.enabled })
  }
  enablementRules.push({ path: disabledExternalOperatorSkill(codexHome).path, enabled: false })

  notices.push('Codex plugins from a remote catalog and plugin or skill settings in project .codex/config.toml files may change what a session loads beyond this list.')
  return { roots, notices, enablementRules }
}
