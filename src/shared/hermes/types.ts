// Hermes connection metadata as the renderer sees it (#1482).
//
// WHY no token, ever, in these types: credentials live in main only
// (src/main/hermes/tokenStore.ts, safeStorage-encrypted). The renderer can
// list, add, sign in, test and remove connections, and it learns the outcome
// as a state; it never needs the bearer to render any of that. A type that
// cannot carry a token is how "tokens never cross IPC" stays true when the
// next field is added.

export type HermesConnectionState =
  /** No usable tokens: never signed in, signed out, or the session expired. */
  | 'signed-out'
  /** The system browser is open on Hermes' sign-in page. */
  | 'signing-in'
  /** Signed in; the last check reached the backend. */
  | 'ready'
  /** Signed in, but the backend did not answer (network, VPN, server down). */
  | 'unreachable'

export type HermesBackendCompatibility = 'tested' | 'skew' | 'unsupported'

export type HermesConnectionInfo = {
  id: string
  /** User-chosen, unique ("Homelab", "Work VPS"). Shown in pane headers. */
  name: string
  /** Normalized base URL (`https://host[/prefix]`), the identity tokens are bound to. */
  baseUrl: string
  createdAt: number
  state: HermesConnectionState
  /** Who the backend says we are, after sign-in (`user_id`, auth provider). */
  identity: { userId: string; provider: string } | null
  /**
   * What the backend reported. `version` is from /api/health (`unknown` for a
   * source install); `desktopContract` is Hermes' wire contract number, the
   * one signal compatibility is judged on (hermes-headless version.ts).
   */
  backend: { version: string; desktopContract: number | null; compatibility: HermesBackendCompatibility | null } | null
  /** The last failure in words the user can act on; null when healthy. */
  lastError: string | null
}

export type HermesConnectionDraft = { name: string; baseUrl: string }

export type HermesTestResult =
  | { ok: true; version: string; authRequired: boolean; providers: string[] }
  | { ok: false; error: string }

/**
 * Validate a draft before it reaches main's store. Pure so both the Settings
 * form (live validation) and main (authoritative) run the same rule.
 */
export function validateHermesConnectionName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Give the connection a name.'
  if (trimmed.length > 60) return 'Keep the name under 60 characters.'
  return null
}
