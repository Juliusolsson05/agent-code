// Build provenance for incident forensics (issue #374).
//
// WHY this exists: the crash-classifier investigation repeatedly could not
// prove WHICH source revision produced a given incident artifact — a stale
// local dev build was indistinguishable from current origin/main, which sent
// triage chasing already-fixed bugs. The fix is to stamp git SHA / branch /
// dirty-flag / build timestamp / mode / package version into every run
// manifest, startup event, and debug bundle, and this module is the single
// runtime accessor for that data.
//
// HOW the value gets here: electron.vite.config.ts computes the provenance at
// CONFIG-EVALUATION time (git commands run on the builder's checkout, never at
// app runtime — a packaged app has no .git to ask) and injects it via Vite's
// `define` as the bare identifier `__AGENT_CODE_BUILD_INFO__`. That identifier
// therefore only exists in Vite-built bundles (main). Under vitest — which
// imports main-process modules directly without the electron-vite define — the
// identifier is undeclared, so every read MUST go through the typeof guard
// below (typeof on an undeclared identifier is the one access that can't throw
// a ReferenceError). Consumers must never touch the raw global; they call
// getBuildInfo() and always receive a complete BuildInfo shape.

export type BuildInfo = {
  // `git rev-parse HEAD` of the checkout that built this bundle, or 'unknown'
  // (non-git checkout, e.g. a source tarball or a CI cache without .git).
  gitSha: string
  // `git rev-parse --abbrev-ref HEAD`; 'HEAD' means a detached checkout
  // (typical for CI building a tag), 'unknown' means git was unavailable.
  branch: string
  // Whether `git status --porcelain` reported ANY uncommitted change at build
  // time. This is the single most important field for triage: a dirty build
  // means the SHA alone does NOT identify the source, so a report from it can
  // never be confused with origin/main behavior. 'unknown' (not false!) when
  // git could not answer — absence of evidence must not read as "clean".
  dirty: boolean | 'unknown'
  // ISO-8601 wall-clock time when the Vite config was evaluated. For
  // `electron-vite dev` this is the dev-server start, which is exactly what
  // triage wants: "how stale is the code this dev run was executing?"
  buildTimestamp: string
  // electron-vite ConfigEnv.mode ('development' | 'production' | custom).
  // Distinguishes dev-server runs from packaged builds in the same field the
  // issue asked for; do not conflate with NODE_ENV.
  buildMode: string
  // package.json "version" read at config time. Redundant with the manifest's
  // appVersion (app.getVersion()) in packaged builds, but in dev
  // app.getVersion() reports Electron's own version, so this is the only
  // reliable app-version signal for dev runs.
  packageVersion: string
}

// Injected by the `define` block in electron.vite.config.ts (main config).
// `declare const` is module-scoped ambient: TS believes the binding exists,
// Vite's define replaces the identifier with an object literal at build time,
// and in un-defined contexts (vitest, tsc-only consumers) the typeof guard in
// readInjectedBuildInfo keeps the undeclared access safe.
declare const __AGENT_CODE_BUILD_INFO__: BuildInfo | undefined

// Every field individually 'unknown' rather than the whole object being
// undefined: downstream schemas (AppRunJournalManifest.build, debug-bundle
// manifests) want a CONSTANT shape so readers never branch on presence. An
// all-'unknown' build block in an artifact is itself a diagnostic signal
// ("this bundle came from a context without build injection — vitest or a
// misconfigured build"), which is strictly more information than a hole.
const FALLBACK_BUILD_INFO: BuildInfo = {
  gitSha: 'unknown',
  branch: 'unknown',
  dirty: 'unknown',
  buildTimestamp: 'unknown',
  buildMode: 'unknown',
  packageVersion: 'unknown',
}

function readInjectedBuildInfo(): BuildInfo | undefined {
  // typeof-guard, not a truthiness check: if the define was never applied the
  // identifier is UNDECLARED, and any direct evaluation would throw
  // ReferenceError. `typeof` is defined to return 'undefined' for undeclared
  // identifiers, so this is the only crash-proof probe. (When the define IS
  // applied, esbuild/rollup replace the identifier inside the typeof with the
  // injected object literal and this folds to a constant.)
  if (typeof __AGENT_CODE_BUILD_INFO__ === 'object' && __AGENT_CODE_BUILD_INFO__ !== null) {
    return __AGENT_CODE_BUILD_INFO__
  }
  return undefined
}

/**
 * The build provenance of the running bundle. Total function: always returns
 * a complete BuildInfo — never throws, never returns a partial shape — so
 * callers on crash/startup hot paths can use it without their own guards.
 */
export function getBuildInfo(): BuildInfo {
  const injected = readInjectedBuildInfo()
  // Spread over the fallback so a FUTURE field added to BuildInfo but not yet
  // emitted by an older cached define (stale .vite cache, mid-upgrade dev
  // server) still materializes as 'unknown' instead of undefined — the
  // constant-shape invariant above must hold even across version skew.
  return injected ? { ...FALLBACK_BUILD_INFO, ...injected } : FALLBACK_BUILD_INFO
}
