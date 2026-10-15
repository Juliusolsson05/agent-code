import { commandTarget } from '@renderer/features/command-palette/commandTarget'
import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import type { HermesConnectionInfo } from '@shared/hermes/types'

// Open VPS Terminal / Open Hermes Terminal (#1528): an ordinary terminal pane
// that types the ssh line main built for a Hermes connection.
//
// WHY type into a normal shell instead of spawning ssh as the pane's process
// (plan Ruling 1): spawn, recovery, tmux and persistence stay untouched;
// when ssh exits or fails its words stay on screen in a local shell where
// ↑⏎ reconnects; the user sees the exact command; tmux keeps it all alive
// across an app restart.
//
// Not configured → Settings opens on Providers, where the Hermes card's SSH
// block lives. A thrown error would only toast "Command failed: …" (the
// dispatcher drops the message), and the user needs the form, not a reason.

/**
 * Which connection (plan Ruling 2): the focused Hermes pane's, if it has SSH
 * access; otherwise the first connection that has it. Palette commands take
 * no arguments, and the common case is one Hermes server.
 */
export function pickSshConnection(connections: HermesConnectionInfo[], focusedConnectionId: string | null): HermesConnectionInfo | null {
  const focused = focusedConnectionId ? connections.find((connection) => connection.id === focusedConnectionId) : undefined
  if (focused?.ssh) return focused
  return connections.find((connection) => connection.ssh) ?? null
}

export async function openHermesShell(ctx: CommandContext, target: 'vps' | 'hermes'): Promise<void> {
  const { workspace, ui } = ctx
  const focusedId = commandTarget(ctx)
  const focused = focusedId ? workspace.state.sessions[focusedId] : null
  const connection = pickSshConnection(await window.api.hermesList(), focused?.kind === 'hermes' ? focused.remoteConnectionId ?? null : null)
  if (!connection) {
    ui.openSettings('providers')
    return
  }
  const line = await window.api.hermesShellCommand(connection.id, target)
  if (!line.ok) {
    // Only reachable for `hermes` without a known location: the user has to
    // Detect or type the container, which is in the same Settings card.
    ui.openSettings('providers')
    return
  }
  const sessionId = await workspace.splitFocused('terminal')
  // null: no project to put the shell in, or the spawn failed; splitFocused
  // has already told the user why.
  if (!sessionId) return
  // `\r` is Enter in a PTY. The shell may still be starting; the line waits
  // in the PTY's input queue and the shell reads it at its first prompt.
  await window.api.sendInput(sessionId, `${line.command}\r`)
}

export const hermesShellCommands: CommandDef[] = [
  {
    id: 'hermes-open-vps-terminal',
    category: 'create',
    surface: 'app',
    title: 'Open VPS Terminal',
    description: '**What it does:** Opens a terminal with an **SSH session to the server** your Hermes runs on.\n\n**Use when:** You need the server itself: Docker, logs, files, updates.\n\n**Notes:** Uses the SSH access saved on the Hermes connection (Settings → Providers → Hermes Connections) and your own ssh keys and ~/.ssh/config. With several connections, the focused Hermes pane\'s server wins.',
    keywords: ['hermes', 'vps', 'server', 'ssh', 'terminal', 'shell', 'console', 'remote', 'docker'],
    run: (ctx) => openHermesShell(ctx, 'vps'),
  },
  {
    id: 'hermes-open-hermes-terminal',
    category: 'create',
    surface: 'app',
    title: 'Open Hermes Terminal',
    description: '**What it does:** Opens a terminal over SSH **where the `hermes` command works**: on the server, or inside the Docker container Hermes runs in.\n\n**Use when:** You want `hermes config`, `hermes mcp`, `hermes setup` and the like.\n\n**Notes:** Detect where Hermes runs once in Settings → Providers → Hermes Connections.',
    keywords: ['hermes', 'cli', 'config', 'setup', 'container', 'docker exec', 'ssh', 'terminal', 'shell', 'console'],
    run: (ctx) => openHermesShell(ctx, 'hermes'),
  },
]
