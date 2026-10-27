// Hermes connection metadata as the renderer sees it (#1482).

import type { HermesSshAccess } from './ssh.js'
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
  /**
   * Optional SSH route to the same server (#1528). Safe to show: a
   * destination, a port and a key PATH, never key material or a password.
   */
  ssh?: HermesSshAccess
}

export type HermesConnectionDraft = { name: string; baseUrl: string }

export type HermesTestResult =
  | { ok: true; version: string; authRequired: boolean; providers: string[] }
  | { ok: false; error: string }

/**
 * One messaging thread a Hermes pane can follow ("Change Telegram Thread…",
 * #1501). hermes-headless' LaneSummary minus `headId`: the renderer chooses a
 * THREAD, never a stored conversation id. The lane pins the routing key and
 * re-resolves the id itself (lane/lanes.ts), so handing out a head id would
 * only invite a caller to pin a row that a Telegram /new is about to end.
 */
export type HermesLaneChoice = {
  /** The gateway routing key, `agent:main:telegram:dm:<chat>[:<thread>]`. */
  sessionKey: string
  platform: string
  chatType: string | null
  /** A DM topic / forum thread: its own lane, separate from the plain chat. */
  threadId: string | null
  displayName: string | null
  /** Seconds, server clock. */
  lastActiveAt: number | null
}

/** A failed listing is a VALUE, so the picker can say why instead of an IPC rejection's "Error invoking remote method". */
export type HermesLaneListing =
  | { ok: true; lanes: HermesLaneChoice[] }
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
