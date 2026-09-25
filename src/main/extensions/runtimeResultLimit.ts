import { isExtensionJson } from '@shared/types/extensionJson.js'
import { MAX_NET_FETCH_RESULT_CHARACTERS } from './netFetch.js'

// The admission check for a background runtime's API RESULT, kept free of
// Electron imports so its contract is unit-testable (runtimeService itself
// needs a BrowserWindow harness).
//
// WHY ONE METHOD GETS A LARGER BOUND (#1151 design review, finding 3): the
// generic ExtensionJson bound is 128 Ki characters. A net.fetch result is
// already capped by the broker (256 KiB body, clamped metadata), but its
// base64 form is up to ~342 Ki characters, so a 100 KiB binary download
// succeeded in a VIEW (structured clone, no JSON bound) and failed in a
// RUNTIME behind identical API types. The allowance is derived from the
// broker's own cap (MAX_NET_FETCH_RESULT_CHARACTERS), so it can never admit
// more than the broker produces; the node-count/depth/shape checks inside
// isExtensionJson still apply. The result returns over ipcMain.handle, which
// imposes no smaller limit, and the runtime preload does not re-check replies.
// Every other method keeps the generic bound: do not add methods here for
// convenience, only for a result the host itself already bounds.
export function assertRuntimeApiResult(method: string, result: unknown): void {
  if (result === undefined) return
  const limit = method === 'net.fetch' ? MAX_NET_FETCH_RESULT_CHARACTERS : undefined
  if (!isExtensionJson(result, limit)) throw new Error('Extension API result exceeds the JSON limits.')
}
