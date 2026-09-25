import { session } from 'electron'

import { isLoopbackHost } from '@shared/browserPocket/url.js'

import { POCKET_PARTITION_PREFIX } from './partitionName.js'

const safe = (id: string) => id.replace(/[^A-Za-z0-9-]/g, '_').slice(0, 80)

/**
 * The cookie jar a pocket uses.
 *
 * WHY one jar per pocket by default (D1): cookies ignore ports (RFC 6265
 * §8.5), so two worktrees serving localhost:3000 and :3001 from one jar log
 * each other out — Claude Code #53604, closed "not planned". 'project' is the
 * explicit opt-in to share logins across a project's lanes.
 *
 * Keyed by pocketId, never SessionId: reload / provider switch / rewind mint
 * new SessionIds and would silently log the user out.
 */
export function partitionFor(pocket: { pocketId: string; profile: 'lane' | 'project' }, projectId: string | undefined): string {
  if (pocket.profile === 'project' && projectId) return `${POCKET_PARTITION_PREFIX}project-${safe(projectId)}`
  return `${POCKET_PARTITION_PREFIX}${safe(pocket.pocketId)}`
}

/**
 * Electron GRANTS every permission when no handler is installed (security
 * checklist #5). Only clipboard writes are allowed: pages commonly offer "copy"
 * buttons, and that permission cannot read anything. Camera, mic, location,
 * notifications and clipboard READ stay denied (VS Code's agent browser makes
 * the same cut). Both handlers are needed: async clipboard is gated by the
 * CHECK handler, not the request handler (T3 BrowserSession.ts).
 */
const GRANTED = new Set(['clipboard-sanitized-write'])
const configured = new Set<string>()

export function configurePocketSession(partition: string): Electron.Session {
  const s = session.fromPartition(partition)
  if (configured.has(partition)) return s
  configured.add(partition)
  s.setPermissionRequestHandler((_wc, permission, callback) => callback(GRANTED.has(permission)))
  s.setPermissionCheckHandler((_wc, permission) => GRANTED.has(permission))
  // https dev servers use self-signed certificates constantly. Accept them for
  // loopback names only; everything else keeps Chromium's own verdict (-3).
  s.setCertificateVerifyProc((request, callback) => callback(isLoopbackHost(request.hostname) ? 0 : -3))
  // Downloads would write into the user's Downloads folder with no prompt from
  // an agent-driven page; refuse them in v1.
  s.on('will-download', event => event.preventDefault())
  return s
}

export async function clearPocketStorage(partition: string): Promise<void> {
  if (!partition.startsWith(POCKET_PARTITION_PREFIX)) throw new Error('Not a pocket partition')
  const s = session.fromPartition(partition)
  await s.clearStorageData()
  await s.clearCache()
}
