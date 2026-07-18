import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Provider import boundaries (Phase 1 of the evidence-first rendering plan,
// PR #554 — "Import rules, non-negotiable").
//
// The rules this test enforces, verbatim from the plan:
//   1. providers/claude/**   never imports Codex/OpenCode renderer code.
//   2. providers/codex/**    never imports Claude/OpenCode renderer code.
//   3. providers/opencode/** never imports Claude/Codex renderer code.
//   4. providers/shared/renderer/** never imports a specific provider.
//   5. features/feed/** selects capabilities through the registry but never
//      imports a provider's renderer modules directly.
//
// WHY a filesystem-scanning test and not an ESLint plugin/dep-cruiser
// config: the plan explicitly asks for "one narrow boundary test with a
// clear failure message — not a bespoke framework", and the repo's
// anti-enforcement-bloat convention says the same. A test is visible in the
// suite, breaks loudly in CI, and needs no new tooling.
//
// WHY these rules exist at all: PR #524 died on cross-provider coupling —
// its shared fileEdit.tsx imported BOTH Claude and Codex extractors, and a
// change to one provider's wire format put every provider's rendering in the
// blast radius. Providers may meet only BELOW interpretation, in narrow
// shared visual protocols (providers/shared/renderer/**) that never name a
// provider.
// ---------------------------------------------------------------------------

const testDir = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolve(testDir, '..') // src/
const PROVIDERS = ['claude', 'codex', 'opencode'] as const
type Provider = (typeof PROVIDERS)[number]

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      out.push(...listSourceFiles(full))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    // Test files may legitimately cross providers (e.g. a shared ownership
    // test replaying fixtures from several providers) — the rules govern
    // shipped renderer code.
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue
    out.push(full)
  }
  return out
}

/** Static + dynamic + SIDE-EFFECT import specifiers, plus require(). A
 *  regex is enough: the codebase uses plain string literals for module
 *  specifiers (enforced de facto by Vite's static analysis), so an AST
 *  parser would be bespoke-framework overkill. The side-effect form
 *  (`import '@providers/x/renderer/y'`) was a review-caught false negative
 *  — it registers modules and is exactly how a cross-provider dependency
 *  would most plausibly sneak in. Known accepted noise: a specifier-shaped
 *  string inside a comment matches too; that fails LOUD (a human deletes
 *  the comment), which is the right failure direction for a boundary. */
function importSpecifiers(source: string): string[] {
  const out: string[] = []
  // WHY static `import` accepts zero whitespace: `import"./side-effect"` is
  // legal JavaScript. Requiring `import\s+` left exactly the registration-only
  // form most likely to hide a cross-provider dependency outside this gate.
  // The quote immediately after optional space keeps `important`/`import.meta`
  // from becoming false matches; dynamic import remains its own parenthesized
  // alternative.
  const re = /(?:from\s*|import\s*\(\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
  for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1])
  return out
}

/**
 * Which provider's RENDERER code does this specifier reach?
 * Handles both the alias form (@providers/<p>/renderer/…) and relative
 * escapes (resolved against the importing file, so `../../codex/renderer/x`
 * cannot sneak past an alias-only check).
 */
function targetsProviderRenderer(specifier: string, fromFile: string): Provider | null {
  for (const p of PROVIDERS) {
    if (specifier === `@providers/${p}/renderer` || specifier.startsWith(`@providers/${p}/renderer/`)) {
      return p
    }
  }
  if (specifier.startsWith('.')) {
    const resolved = resolve(dirname(fromFile), specifier)
    for (const p of PROVIDERS) {
      const rendererRoot = join(srcRoot, 'providers', p, 'renderer')
      // A provider barrel import resolves to the renderer directory itself, without the trailing
      // separator that a child module has. Treat both forms identically; otherwise adding index.ts
      // would create a relative-import escape hatch while the equivalent alias import still failed.
      if (resolved === rendererRoot || resolved.startsWith(rendererRoot + sep)) return p
    }
  }
  return null
}

type Violation = { file: string; specifier: string; rule: string }

function relToSrc(file: string): string {
  return file.slice(srcRoot.length + 1).split(sep).join('/')
}

function scan(dir: string, rule: string, forbidden: (target: Provider) => boolean): Violation[] {
  const violations: Violation[] = []
  for (const file of listSourceFiles(dir)) {
    const rel = relToSrc(file)
    const source = readFileSync(file, 'utf-8')
    for (const specifier of importSpecifiers(source)) {
      const target = targetsProviderRenderer(specifier, file)
      if (!target || !forbidden(target)) continue
      violations.push({ file: rel, specifier, rule })
    }
  }
  return violations
}

function formatViolations(violations: Violation[]): string {
  return violations
    .map(
      v =>
        `\n  ${v.file}\n    imports ${v.specifier}\n    breaks: ${v.rule}\n` +
        `    fix: move the shared part below providers/shared/renderer/ (a narrow\n` +
        `    provider-neutral protocol/primitive), or route through the provider\n` +
        `    capability registry — never import another provider's interpretation.`,
    )
    .join('\n')
}

describe('provider renderer import boundaries (plan PR #554, rules 1–5)', () => {
  it('extracts every supported literal import spelling, including no-space side effects', () => {
    expect(importSpecifiers(`
      import"../../codex/renderer"
      import '@providers/claude/renderer/register'
      import value from "@providers/opencode/renderer/value"
      const lazy = import("@providers/codex/renderer/lazy")
      const legacy = require('@providers/claude/renderer/legacy')
      const unrelated = "important'not-an-import'"
    `)).toEqual([
      '../../codex/renderer',
      '@providers/claude/renderer/register',
      '@providers/opencode/renderer/value',
      '@providers/codex/renderer/lazy',
      '@providers/claude/renderer/legacy',
    ])
  })

  it('resolves both a provider renderer directory and one of its children', () => {
    const fromClaudeFile = join(srcRoot, 'providers', 'claude', 'feature.ts')
    expect(targetsProviderRenderer('./renderer', fromClaudeFile)).toBe('claude')
    expect(targetsProviderRenderer('../codex/renderer', fromClaudeFile)).toBe('codex')
    expect(targetsProviderRenderer('../codex/renderer/rows/dispatch', fromClaudeFile)).toBe('codex')
    expect(targetsProviderRenderer('../shared/renderer', fromClaudeFile)).toBeNull()
  })

  it.each(PROVIDERS)('rule: providers/%s never imports another provider’s renderer code', provider => {
    const violations = scan(
      join(srcRoot, 'providers', provider),
      `providers/${provider}/** must not import another provider's renderer`,
      target => target !== provider,
    )
    expect(violations, formatViolations(violations)).toEqual([])
  })

  it('rule: providers/shared/renderer never imports a specific provider', () => {
    const violations = scan(
      join(srcRoot, 'providers', 'shared', 'renderer'),
      'providers/shared/renderer/** must stay provider-neutral',
      () => true,
    )
    expect(violations, formatViolations(violations)).toEqual([])
  })

  it('rule: features/feed selects capabilities via the registry, never provider renderer imports', () => {
    const violations = scan(
      join(srcRoot, 'renderer', 'src', 'features', 'feed'),
      'features/feed/** must reach providers only through the capability registry',
      () => true,
    )
    expect(violations, formatViolations(violations)).toEqual([])
  })

})
