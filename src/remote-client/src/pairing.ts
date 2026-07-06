// Pairing + token persistence for the phone client.
//
// The desktop QR encodes `${url}/#code=XXXXXXXX`. Opening it lands here:
// readPairingCodeFromHash() finds the one-time code, redeemPairingCode()
// trades it for a durable device token over POST /pair, and the token lands
// in localStorage. The hash is scrubbed immediately after a successful
// redeem so a bookmarked/reloaded URL doesn't retry a dead code (codes are
// single-use — the retry would fail and look like a broken app).
//
// localStorage over cookies ON PURPOSE: the token must ride the WS query
// string (RemoteServer checks it at upgrade), so cookie semantics buy
// nothing, and an explicit read/write keeps the auth story greppable.

const TOKEN_KEY = 'agent-code-remote-token'

export function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export function readPairingCodeFromHash(): string | null {
  const match = /(?:^|[#&])code=([A-Z0-9]+)/.exec(window.location.hash)
  return match ? match[1] : null
}

export function scrubPairingCodeFromHash(): void {
  // replaceState (not location.hash = '') avoids adding a history entry —
  // Back should leave the app, not step through pairing states.
  history.replaceState(null, '', window.location.pathname)
}

export async function redeemPairingCode(
  code: string,
  deviceName: string,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  try {
    const res = await fetch('/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName }),
    })
    if (!res.ok) {
      return {
        ok: false,
        error:
          res.status === 403
            ? 'Code rejected — it may have expired or been used. Generate a new one on the desktop.'
            : `Pairing failed (HTTP ${res.status}).`,
      }
    }
    const body = (await res.json()) as { token?: string }
    if (!body.token) return { ok: false, error: 'Malformed pairing response.' }
    saveToken(body.token)
    return { ok: true, token: body.token }
  } catch {
    return { ok: false, error: 'Could not reach the desktop. Same Wi-Fi?' }
  }
}

/** Best-effort human default so the desktop device list reads like an
 *  inventory ("iPhone", "Android") instead of "Unnamed device". */
export function defaultDeviceName(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android phone'
  return 'Phone'
}
