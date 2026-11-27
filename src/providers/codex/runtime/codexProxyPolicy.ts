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
 *      custom `model_provider` in `$CODEX_HOME/config.toml`, spinning up
 *      `ResponsesProxy` is wasted work (and risks interfering with config).
 *   3. `ResponsesProxy`'s default fallback when `~/.codex/auth.json` is absent
 *      is `apikey` → `https://api.openai.com/v1`. On macOS Keychain / keyring /
 *      `auto` credential stores (or before a user has logged in), `auth.json`
 *      does not exist even for ChatGPT-authenticated users — guessing
 *      `api.openai.com` sends a ChatGPT JWT to the wrong host and causes 401s.
 *      When we cannot prove the upstream/auth mode, skipping the proxy is
 *      strictly safer than guessing.
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

  // 1. Inspect $CODEX_HOME/config.toml for model_provider and openai_base_url.
  let configBaseUrl: string | undefined
  try {
    const configFile = await readOptionalFile(join(codexHome, 'config.toml'))
    if (configFile.exists && configFile.content !== null) {
      const parsed = parseToml(configFile.content) as Record<string, unknown>
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
      if (typeof parsed.openai_base_url === 'string' && parsed.openai_base_url.trim().length > 0) {
        configBaseUrl = parsed.openai_base_url.trim()
      }
    }
  } catch (err) {
    return {
      useProxy: false,
      reason: 'invalid-config',
      detail: `Unable to read/parse Codex config.toml (${err instanceof Error ? err.message : String(err)}); skipping local ResponsesProxy.`,
    }
  }

  const envBaseUrl = env.OPENAI_BASE_URL?.trim() || undefined
  const upstreamBaseUrl = configBaseUrl ?? envBaseUrl
  if (upstreamBaseUrl) {
    return {
      useProxy: true,
      upstreamBaseUrl,
    }
  }

  // 2. No explicit upstream URL: inspect $CODEX_HOME/auth.json and OPENAI_API_KEY
  //    to determine whether traffic belongs on chatgpt.com or api.openai.com.
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

  const envApiKey = typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.trim().length > 0
  const fileApiKey =
    typeof authData?.OPENAI_API_KEY === 'string' && authData.OPENAI_API_KEY.trim().length > 0
  const authModeRaw = typeof authData?.auth_mode === 'string' ? authData.auth_mode.trim() : ''
  const hasTokens = Boolean(authData?.tokens)

  if (CHATGPT_AUTH_MODES.has(authModeRaw) || (hasTokens && !fileApiKey && !envApiKey)) {
    return { useProxy: true, authMode: 'chatgpt' }
  }

  if (authModeRaw === 'apikey' || fileApiKey || envApiKey) {
    return { useProxy: true, authMode: 'apikey' }
  }

  return {
    useProxy: false,
    reason: 'indeterminate-auth-mode',
    detail:
      'Neither $CODEX_HOME/auth.json nor OPENAI_API_KEY indicates the Codex auth mode; skipping local ResponsesProxy to avoid misrouting.',
  }
}
