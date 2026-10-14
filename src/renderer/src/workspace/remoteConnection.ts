import { isRemoteProviderKind, type SessionKind } from '@shared/types/providerKind'

/**
 * Which Hermes connection (Settings → Hermes) a remote pane talks to (#1482).
 *
 * Resolution, in order:
 *   1. the pane's own persisted choice (`SessionMeta.remoteConnectionId`), so
 *      a reload, recovery or Reload Agent reopens the conversation on the
 *      SAME server it lives on;
 *   2. otherwise the first signed-in connection, then any connection;
 *   3. otherwise none: main refuses the spawn with a sentence that says to
 *      add a connection (RemoteProviderNotConnectedError).
 *
 * WHY a default instead of always asking (UNCONFIRMED product call, plan
 * Decision 6): most users have one Hermes server, and every generic spawn
 * path (split chords, the New Agent picker, MCP create_agent) passes only a
 * kind. Picking the first signed-in connection makes all of them work without
 * a second picker; a user with several servers chooses per pane in the
 * connection picker the "New Hermes Chat…" command shows.
 */
export async function resolveRemoteConnectionId(
  kind: SessionKind | undefined,
  preferred: string | undefined,
): Promise<string | undefined> {
  if (!isRemoteProviderKind(kind)) return undefined
  if (preferred) return preferred
  try {
    const connections = await window.api.hermesList()
    return (connections.find((connection) => connection.state === 'ready') ?? connections[0])?.id
  } catch {
    return undefined
  }
}
