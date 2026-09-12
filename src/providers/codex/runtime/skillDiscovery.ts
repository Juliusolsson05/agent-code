import { lstat, opendir, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
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
// `ext/skills/src/host_roots.rs` (which roots exist and in what order),
// `ext/skills/src/loader/` (how each root is walked and names are qualified),
// `core-plugins/src/{loader,manifest,agent_plugin_manifest,store}.rs` and
// `utils/plugins/src/` (plugin resolution), `config/src/skills_config.rs`.

/** ext/skills/src/loader/mod.rs MAX_SCAN_DEPTH: SKILL.md at most six segments below a root. */
const MAX_SCAN_DEPTH = 6
/** utils/plugins/src/plugin_namespace.rs: the only schema Codex accepts, and the prefix that claims a root plugin.json. */
const AGENT_PLUGIN_SCHEMA_URI = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const AGENT_PLUGIN_SCHEMA_PREFIX = 'https://agent-plugins.org/schemas/'
/** exec-server-protocol DISCOVERABLE_PLUGIN_MANIFEST_PATHS, in lookup order. */
const LEGACY_MANIFEST_DIRECTORIES = ['.codex-plugin', '.claude-plugin', '.cursor-plugin']
/** utils/plugins/src/lib.rs validate_plugin_version_segment. */
const VERSION_SEGMENT = /^[A-Za-z0-9_.+-]+$/
const MAX_CACHED_VERSIONS = 512

const isDirectory = (path: string) => stat(path).then(info => info.isDirectory(), () => false)
/** `symlink_metadata`: a missing entry is null; any other probe failure rejects, as Codex does. */
const inspectEntry = (path: string): Promise<Stats | null | 'error'> =>
  lstat(path).then(info => info, (error: unknown) => (missingSkillPath(error) ? null : 'error' as const))

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

/** core-plugins agent_plugin_manifest.rs is_valid_agent_plugin_name. */
function validAgentPluginName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && !name.includes('--') && !name.includes('..')
    && /^[a-z0-9.-]+$/.test(name) && /^[a-z0-9]/.test(name) && /[a-z0-9]$/.test(name)
}

/**
 * core-plugins/src/manifest.rs resolve_manifest_path: non-empty, `./`-relative,
 * not `./` itself, no `..` component, not absolute, and inside the plugin. The
 * round-two review showed a looser check walked a whole plugin for `"./"` and
 * accepted `./a/../b`, both of which Codex ignores. Components are split on `/`
 * only, matching Codex's POSIX path convention (packaged builds are macOS).
 */
function codexManifestPath(pluginRoot: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('./')) return null
  const relative = value.slice(2)
  if (relative === '' || relative.startsWith('/') || relative.split('/').includes('..')) return null
  return pathInsidePlugin(pluginRoot, relative)
}

type ManifestLookup =
  | { kind: 'agent' | 'legacy'; path: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'missing' }

/**
 * utils/plugins/src/plugin_namespace.rs find_plugin_manifest_path.
 *
 * A root `plugin.json` claims the plugin for the Agent Plugins format when its
 * `$schema` starts with the agent-plugins.org prefix (a regular, non-symlink
 * file only). Otherwise the first `.codex-plugin`/`.claude-plugin`/`.cursor-plugin`
 * manifest wins — but a manifest folder that is not a real directory, or a
 * manifest that is not a regular file, makes Codex reject the plugin instead of
 * trying the next location.
 */
async function findPluginManifest(pluginRoot: string): Promise<ManifestLookup> {
  const rootManifest = join(pluginRoot, 'plugin.json')
  const rootInfo = await inspectEntry(rootManifest)
  if (rootInfo === 'error') return { kind: 'rejected', reason: 'its plugin.json cannot be inspected' }
  if (rootInfo) {
    if (rootInfo.isSymbolicLink() || !rootInfo.isFile()) return { kind: 'rejected', reason: 'its plugin.json is not a regular file' }
    const schema = (await readJsonQuietly(rootManifest))?.$schema
    if (typeof schema === 'string' && schema.startsWith(AGENT_PLUGIN_SCHEMA_PREFIX)) return { kind: 'agent', path: rootManifest }
  }
  for (const directory of LEGACY_MANIFEST_DIRECTORIES) {
    const folder = await inspectEntry(join(pluginRoot, directory))
    if (folder === null) continue
    if (folder === 'error' || !folder.isDirectory()) return { kind: 'rejected', reason: `its ${directory} entry is not a directory` }
    const manifest = await inspectEntry(join(pluginRoot, directory, 'plugin.json'))
    if (manifest === null) continue
    if (manifest === 'error' || !manifest.isFile()) {
      return { kind: 'rejected', reason: `its ${directory}/plugin.json is not a regular file` }
    }
    return { kind: 'legacy', path: join(pluginRoot, directory, 'plugin.json') }
  }
  return { kind: 'missing' }
}

/** Skill roots for one installed plugin version. */
async function pluginSkillRoots(pluginRoot: string, pluginName: string, notices: string[]): Promise<AgentSkillRoot[]> {
  const lookup = await findPluginManifest(pluginRoot)
  if (lookup.kind === 'rejected') {
    notices.push(`Codex rejects the ${pluginName} plugin because ${lookup.reason}; its skills are not listed.`)
    return []
  }
  if (lookup.kind === 'missing') {
    notices.push(`The ${pluginName} Codex plugin has no plugin manifest; its skills are not listed.`)
    return []
  }
  const base = { source: 'plugin' as const, sourceLabel: pluginName }

  if (lookup.kind === 'agent') {
    // agent_plugin_manifest.rs parse_agent_plugin_manifest_uri: an unsupported
    // schema or invalid name is a load error, and the manifest cannot choose
    // skill folders — unknown fields (including `skills`) are dropped and the
    // skills path is always `./skills`. The Codex extension/overlay replaces
    // only apps, hooks and interface. Agent plugins scan direct children only.
    const manifest = await readJsonQuietly(lookup.path) ?? {}
    if (manifest.$schema !== AGENT_PLUGIN_SCHEMA_URI) {
      notices.push(`Codex rejects the ${pluginName} plugin because it declares an unsupported Agent Plugins schema; its skills are not listed.`)
      return []
    }
    if (typeof manifest.name !== 'string' || !validAgentPluginName(manifest.name)) {
      notices.push(`Codex rejects the ${pluginName} plugin because its Agent Plugins name is invalid; its skills are not listed.`)
      return []
    }
    return [{ ...base, path: join(pluginRoot, 'skills'), layout: 'children', namespace: manifest.name }]
  }

  // Legacy manifests: valid declared `skills` paths REPLACE the default
  // `skills/` folder (loader.rs plugin_skill_roots); only when none resolve does
  // the default apply. Migrated legacy command skills are an extra root.
  const manifest = await readSkillJson(lookup.path, notices)
  const namespace = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : pluginName
  const declared = typeof manifest.skills === 'string' ? [manifest.skills]
    : Array.isArray(manifest.skills) ? manifest.skills : []
  const paths: string[] = []
  let rejected = 0
  for (const value of declared) {
    const inside = codexManifestPath(pluginRoot, value)
    if (inside) paths.push(inside)
    else rejected += 1
  }
  if (rejected > 0) {
    notices.push(`Ignored ${rejected} skill path(s) in the ${pluginName} Codex plugin manifest that Codex also rejects.`)
  }
  if (paths.length === 0 && await isDirectory(join(pluginRoot, 'skills'))) paths.push(join(pluginRoot, 'skills'))
  const migrated = join(pluginRoot, '.codex-plugin', 'migrated-command-skills')
  if (await isDirectory(migrated)) paths.push(migrated)
  return [...new Set(paths)].map(path => ({ ...base, path, layout: 'recursive' as const, maxDepth: MAX_SCAN_DEPTH, namespace }))
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
  // Root ORDER mirrors resolve_skill_roots_with_home_dir, whose path dedupe
  // keeps the first entry: config-layer roots high to low (project `.codex`,
  // then user, then system/admin), then plugin roots, then repo `.agents/skills`
  // last. Listing repo roots first labelled `~/.agents/skills` as Project for an
  // agent launched in home without a repository (round-two review).
  const roots: AgentSkillRoot[] = []
  // Project config layers (`.codex/`, loader/mod.rs discover_project_layers)
  // contribute `.codex/skills`. A `.codex` that IS CODEX_HOME is the user layer.
  // `all_layers_high_to_low` includes disabled (untrusted) layers, so no trust
  // check applies to the skill roots they contribute.
  for (const directory of projectDirectories) {
    const dotCodex = join(directory, '.codex')
    if (dotCodex !== codexHome && await isDirectory(dotCodex)) roots.push(tree(join(dotCodex, 'skills'), 'project'))
  }
  roots.push(tree(join(codexHome, 'skills'), 'personal'))
  roots.push(tree(join(home, '.agents', 'skills'), 'personal'))
  // skills_config.rs bundled_skills_enabled_from_stack: `[skills.bundled]
  // enabled = false` removes the embedded System-scope skills. System scope
  // ignores folder symlinks; Admin (`/etc/codex/skills`) follows them.
  if (asRecord(skillsConfig?.bundled)?.enabled !== false) {
    roots.push({ ...tree(join(codexHome, 'skills', '.system'), 'system', 'Codex defaults'), followDirectorySymlinks: false })
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

  for (const directory of projectDirectories) roots.push(tree(join(directory, '.agents', 'skills'), 'project'))

  // skills_config.rs SkillConfigRules: user `[[skills.config]]` entries in
  // order, then the SessionFlags layer. An entry needs exactly one selector
  // (both or neither is ignored) and name selectors are trimmed and non-empty
  // (skill_config_rule_selector). Agent Code's own launch flags disable the
  // external-operator skill for every Codex session it starts
  // (externalControlExclusion.ts), so the panel must not present that skill as
  // usable just because its file sits in CODEX_HOME.
  const enablementRules: AgentSkillEnablementRule[] = []
  for (const entry of Array.isArray(skillsConfig?.config) ? skillsConfig.config : []) {
    const rule = asRecord(entry)
    if (!rule || typeof rule.enabled !== 'boolean') continue
    const hasPath = rule.path !== undefined
    const hasName = rule.name !== undefined
    if (hasPath && !hasName && typeof rule.path === 'string') {
      enablementRules.push({ path: resolve(codexHome, rule.path), enabled: rule.enabled })
    } else if (hasName && !hasPath && typeof rule.name === 'string' && rule.name.trim()) {
      enablementRules.push({ name: rule.name.trim(), enabled: rule.enabled })
    }
  }
  enablementRules.push({ path: disabledExternalOperatorSkill(codexHome).path, enabled: false })

  notices.push('Codex plugins from a remote catalog and plugin or skill settings in project .codex/config.toml files may change what a session loads beyond this list.')
  return { roots, notices, enablementRules }
}
