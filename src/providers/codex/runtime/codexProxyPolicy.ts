import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parse as parseToml } from '@iarna/toml'
import type { CodexAuthMode } from 'codex-headless'

import { hasCorporateProxyEnv } from '@providers/shared/runtime/proxyEnv.js'

/**
 * Compatibility and upstream-resolution policy for Codex's local
 * `ResponsesProxy` (#1552).
 *
 * WHY this runs BEFORE `ResponsesProxy.create()`:
 *   1. Node's built-in `fetch()` inside `ResponsesProxy` does not honor
 *      `HTTPS_PROXY` / `HTTP_PROXY`. In corporate proxy environments, routing
 *      Codex through `ResponsesProxy` breaks outbound requests that Codex's
 *      own Rust HTTP client would have proxied cleanly.
 *   2. `CodexSession` injects `--config openai_base_url=...`, which only
 *      redirects the built-in `openai` provider. If the user configured a
 *      custom `model_provider`, a named `profile`, or a custom
 *      `chatgpt_base_url` in `$CODEX_HOME/config.toml`, we cannot safely
 *      predict the effective upstream and skip the proxy.
 *   3. Vendored Codex CLI (`codex-rs/core/src/config/mod.rs` and
 *      `login/src/auth/manager.rs`) does NOT read `env.OPENAI_BASE_URL` or
 *      `env.OPENAI_API_KEY` for TUI auth. Inferring `apikey` from
 *      `env.OPENAI_API_KEY` when `auth.json` is absent would misroute
 *      developers who authenticate Codex via macOS Keychain (ChatGPT) while
 *      exporting `OPENAI_API_KEY` for unrelated tools, causing 401s against
 *      `api.openai.com`. Similarly, `cli_auth_credentials_store = "keyring"`
 *      means any `auth.json` on disk may be stale. When we cannot prove the
 *      upstream/auth mode from Codex's own config/auth files, skipping the
 *      proxy is strictly safer than guessing.
 */

export type CodexProxyDecision =
  | {
      useProxy: true
      upstreamBaseUrl?: string
      authMode?: CodexAuthMode
    }
  | {
      useProxy: false
      reason:
        | 'corporate-proxy-env'
        | 'custom-model-provider'
        | 'custom-config-profile'
        | 'custom-chatgpt-base-url'
        | 'keyring-credential-store'
        | 'invalid-config'
        | 'indeterminate-auth-mode'
      detail: string
    }

const CHATGPT_AUTH_MODES = new Set([
  'chatgpt',
  'chatgptAuthTokens',
  'headers',
  'agentIdentity',
  'personalAccessToken',
])

function resolveCodexHome(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.CODEX_HOME?.trim()
  return configured ? configured : join(homedir(), '.codex')
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

async function readOptionalFile(path: string): Promise<{ exists: boolean; content: string | null }> {
  try {
    const content = await readFile(path, 'utf8')
    return { exists: true, content }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') return { exists: false, content: null }
    throw err
  }
}

export async function resolveCodexProxyDecision(
  env: Readonly<Record<string, string | undefined>>,
): Promise<CodexProxyDecision> {
  if (hasCorporateProxyEnv(env)) {
    return {
      useProxy: false,
      reason: 'corporate-proxy-env',
      detail: 'Existing HTTP(S)_PROXY environment variable detected; skipping local ResponsesProxy.',
    }
  }

  const codexHome = resolveCodexHome(env)

  // 1. Inspect $CODEX_HOME/config.toml for provider/profile/store overrides and
  //    explicit openai_base_url.
  let configBaseUrl: string | undefined
  try {
    const configFile = await readOptionalFile(join(codexHome, 'config.toml'))
    if (configFile.exists && configFile.content !== null) {
      const parsed = parseToml(configFile.content) as Record<string, unknown>

      if (typeof parsed.profile === 'string' && parsed.profile.trim().length > 0) {
        return {
          useProxy: false,
          reason: 'custom-config-profile',
          detail: `Codex config.toml selects profile=${JSON.stringify(parsed.profile.trim())}; skipping local ResponsesProxy.`,
        }
      }

      const modelProvider = parsed.model_provider
      if (
        typeof modelProvider === 'string' &&
        modelProvider.trim().length > 0 &&
        modelProvider.trim() !== 'openai'
      ) {
        return {
          useProxy: false,
          reason: 'custom-model-provider',
          detail: `Codex config.toml uses model_provider=${JSON.stringify(modelProvider.trim())}; skipping local ResponsesProxy.`,
        }
      }

      if (typeof parsed.chatgpt_base_url === 'string' && parsed.chatgpt_base_url.trim().length > 0) {
        return {
          useProxy: false,
          reason: 'custom-chatgpt-base-url',
          detail: 'Codex config.toml sets chatgpt_base_url; skipping local ResponsesProxy.',
        }
      }

      if (
        typeof parsed.cli_auth_credentials_store === 'string' &&
        parsed.cli_auth_credentials_store.trim().toLowerCase() === 'keyring'
      ) {
        return {
          useProxy: false,
          reason: 'keyring-credential-store',
          detail: 'Codex config.toml sets cli_auth_credentials_store="keyring"; skipping local ResponsesProxy because auth.json may be stale.',
        }
      }

      if (typeof parsed.openai_base_url === 'string' && parsed.openai_base_url.trim().length > 0) {
        const candidate = parsed.openai_base_url.trim()
        if (!isValidHttpUrl(candidate)) {
          return {
            useProxy: false,
            reason: 'invalid-config',
            detail: `Codex config.toml openai_base_url is not a valid http(s) URL; skipping local ResponsesProxy.`,
          }
        }
        configBaseUrl = candidate
      }
    }
  } catch (err) {
    return {
      useProxy: false,
      reason: 'invalid-config',
      detail: `Unable to read/parse Codex config.toml (${err instanceof Error ? err.message : String(err)}); skipping local ResponsesProxy.`,
    }
  }

  if (configBaseUrl) {
    return {
      useProxy: true,
      upstreamBaseUrl: configBaseUrl,
    }
  }

  // 2. No explicit config.toml openai_base_url: inspect $CODEX_HOME/auth.json
  //    to determine whether traffic belongs on chatgpt.com or api.openai.com.
  //    Do NOT fall back to env.OPENAI_API_KEY: Codex TUI does not use it for
  //    auth, so consulting it would misroute Keychain ChatGPT users.
  let authData: Record<string, unknown> | null = null
  try {
    const authFile = await readOptionalFile(join(codexHome, 'auth.json'))
    if (authFile.exists && authFile.content !== null) {
      const parsed = JSON.parse(authFile.content) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        authData = parsed as Record<string, unknown>
      }
    }
  } catch {
    // Unreadable or malformed auth.json: treat as indeterminate below rather
    // than crashing or guessing the wrong upstream.
    authData = null
  }

  const fileApiKey =
    typeof authData?.OPENAI_API_KEY === 'string' && authData.OPENAI_API_KEY.trim().length > 0
  const authModeRaw = typeof authData?.auth_mode === 'string' ? authData.auth_mode.trim() : ''
  const hasTokens = Boolean(authData?.tokens)

  if (CHATGPT_AUTH_MODES.has(authModeRaw) || (hasTokens && !fileApiKey)) {
    return { useProxy: true, authMode: 'chatgpt' }
  }

  if (authModeRaw === 'apikey' || fileApiKey) {
    return { useProxy: true, authMode: 'apikey' }
  }

  return {
    useProxy: false,
    reason: 'indeterminate-auth-mode',
    detail:
      '$CODEX_HOME/auth.json does not indicate the Codex auth mode; skipping local ResponsesProxy to avoid misrouting.',
  }
}
