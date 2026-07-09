import type { CliUpdateKind } from '@shared/types/cliUpdate.js'

// Latest-version discovery for the two provider CLIs.
//
// Two very different transport strategies because the two upstream
// registries have very different caching stories:
//
//   Codex → api.github.com/repos/openai/codex/releases/latest
//     GitHub's REST API supports proper conditional requests: send
//     `If-None-Match: <etag>` and get a 304 with no body when nothing
//     changed. Per GitHub docs, an authorized 304 does NOT count against
//     the primary rate limit. We're unauthenticated (no user token to
//     borrow) which caps us at 60 req/hr per IP for the ip anyway, but a
//     304 costs zero bytes of body regardless. Result: cheap enough to
//     hit on every app launch without any freshness TTL — the ETag IS
//     the cache-invalidation signal.
//
//   Claude → registry.npmjs.org/@anthropic-ai/claude-code?fields=dist-tags
//     Public npm registry famously does NOT honor conditional request
//     headers: `If-None-Match` / `If-Modified-Since` return 200 with the
//     full body every time. Reproduced in the wild multiple times
//     (tutorialpedia writeup, npm/registry discussions). BUT the
//     `?fields=dist-tags` route returns only the tag map — about 100
//     bytes — so unconditional-on-every-launch is still trivially cheap.
//     We use `dist-tags.stable`, not `.latest`: Claude ships ~30 releases/
//     month and `.latest` moves daily, which would nag every launch;
//     `.stable` is roughly a week behind and matches what Anthropic
//     intends third-party wrappers to key on.
//
// Both requests have a 5 s hard timeout — the point of the check is that
// it's fast enough to happen before the user starts working. If either
// fetch fails we return 'network' and the orchestrator degrades silently,
// falling back to whatever the last successful check stashed on disk.
//
// User-Agent must be a plausible identifier; the npm registry lately
// rejects requests without one, and GitHub logs are noisy when everything
// looks like `node/undici`. `agent-code/<version>` gives us grep-ability
// in registry access logs if we ever need it.

const AGENT_CODE_UA = 'agent-code (+https://github.com/Juliusolsson05/agent-code)'
const FETCH_TIMEOUT_MS = 5_000

const CLAUDE_PKG = '@anthropic-ai/claude-code'
const CODEX_REPO = 'openai/codex'

// The npm registry ?fields= projection is a private route (used by
// documented tooling but not enshrined in a spec version). If it ever
// breaks, fall back to `application/vnd.npm.install-v1+json` on the full
// package URL — same ~few-KB payload, and it also exposes dist-tags.
const NPM_URL = (pkg: string): string =>
  `https://registry.npmjs.org/${encodeURIComponent(pkg)}?fields=dist-tags`
const GITHUB_URL = (repo: string): string =>
  `https://api.github.com/repos/${repo}/releases/latest`

/** Result of a latest-version query. `notModified` covers the GitHub 304
 *  path — the caller reuses whatever version+etag it had cached. Everything
 *  else is a fresh answer (or the network failed). */
export type LatestVersionResult =
  | { ok: true; version: string; etag: string | null }
  | { ok: true; notModified: true }
  | { ok: false; reason: 'network' | 'unexpected' }

export async function queryLatestVersion(
  cli: CliUpdateKind,
  cachedEtag: string | null,
): Promise<LatestVersionResult> {
  if (cli === 'codex') return await queryLatestCodex(cachedEtag)
  return await queryLatestClaude()
}

async function queryLatestClaude(): Promise<LatestVersionResult> {
  // Deliberately no If-None-Match — npm ignores it. Every launch we pay
  // ~100 bytes for the fresh dist-tags. That is the cheapest correct
  // answer for this registry.
  try {
    const parsed = await fetchJsonWithTimeout<{ 'dist-tags'?: Record<string, string> }>(
      NPM_URL(CLAUDE_PKG),
      {
        headers: {
          // Ask for the abbreviated metadata dialect even though we're
          // already down to ?fields=dist-tags — belt-and-braces: if the
          // ?fields= route disappears one day, this Accept header keeps
          // the payload small.
          Accept: 'application/vnd.npm.install-v1+json',
          'User-Agent': AGENT_CODE_UA,
        },
      },
    )
    if (!parsed.ok) return { ok: false, reason: 'network' }
    const body = parsed.body
    // WHY `stable`, not `latest`:
    //   Anthropic's `dist-tags` object exposes three channels — `latest`,
    //   `stable`, and `next`. Only `stable` matches the version Anthropic
    //   intends third parties to compare against — it lags `latest` by
    //   ~1 week, skipping releases with known regressions. `latest` moves
    //   daily and would trigger an auto-update on every launch, which is
    //   both noisy and racy against Anthropic pulling a broken publish.
    //   If `stable` isn't present (unlikely — it's been there since the
    //   dist-tags split in 2025), fall back to `latest` rather than giving
    //   up.
    const version = body['dist-tags']?.stable ?? body['dist-tags']?.latest
    if (!version) return { ok: false, reason: 'unexpected' }
    return { ok: true, version, etag: null }
  } catch {
    return { ok: false, reason: 'network' }
  }
}

async function queryLatestCodex(cachedEtag: string | null): Promise<LatestVersionResult> {
  try {
    const headers: Record<string, string> = {
      // GitHub's `application/vnd.github+json` is the current recommended
      // Accept. Without it we still get JSON but they reserve the right
      // to change the default format.
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': AGENT_CODE_UA,
    }
    if (cachedEtag) headers['If-None-Match'] = cachedEtag
    const result = await fetchJsonWithTimeout<{ tag_name?: string; name?: string }>(
      GITHUB_URL(CODEX_REPO),
      { headers },
    )
    // 304 Not Modified — nothing changed since last check. Zero body,
    // zero rate-limit impact for authenticated requests (we're unauth so
    // it still counts as one hit, but at 60/hr and once-per-launch we're
    // fine). This is why the Codex path is essentially free.
    if (!result.ok && result.reason === 'not-modified') return { ok: true, notModified: true }
    if (!result.ok) return { ok: false, reason: 'network' }
    // Codex tags look like `rust-v0.144.0`; we normalize the leading
    // `rust-v` off so the semver comparator can eat it. The CLI itself
    // does the same strip in codex-rs/tui/src/updates.rs
    // (`extract_version_from_latest_tag`), so we're matching its
    // canonical form.
    const raw = result.body.tag_name ?? result.body.name
    if (!raw) return { ok: false, reason: 'unexpected' }
    const version = raw.replace(/^rust-v/, '').replace(/^v/, '')
    return { ok: true, version, etag: result.etag }
  } catch {
    return { ok: false, reason: 'network' }
  }
}

// Node's global `fetch` has no built-in timeout — a hung server would keep
// the socket open and prevent the app from exiting cleanly. AbortController
// is the documented way to enforce a deadline on the platform fetch.
//
// WHY the timeout wraps BOTH headers AND body:
//   The naive shape (clear the timer as soon as `fetch()` resolves) only
//   covers the response-headers roundtrip. A malicious or slow proxy can
//   send 200 OK headers instantly and then stall the body forever, and
//   `response.json()` would hang indefinitely — which in our case leaves
//   the per-CLI mutex permanently held so the next launch's probe short-
//   circuits. Correctness review caught this. Solution: keep the
//   AbortController armed until body consumption completes (or fails,
//   which surfaces as an AbortError that our outer catch treats as
//   network failure).
type FetchJsonResult<T> =
  | { ok: true; body: T; etag: string | null }
  | { ok: false; reason: 'not-modified' | 'network' }

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
): Promise<FetchJsonResult<T>> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: ac.signal })
    if (response.status === 304) return { ok: false, reason: 'not-modified' }
    if (!response.ok) return { ok: false, reason: 'network' }
    const etag = response.headers.get('etag')
    // Await body consumption UNDER the same AbortController — a slow
    // body abort here throws AbortError which the caller's outer catch
    // classifies as 'network'.
    const body = (await response.json()) as T
    return { ok: true, body, etag: etag ?? null }
  } finally {
    clearTimeout(timer)
  }
}
