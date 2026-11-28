import { createServer, type IncomingMessage } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tldrHookServer } from '@providers/shared/runtime/tldrHooks.js'
import type { BuiltInMcpServerConfig } from '@mcp/shared/types.js'

type HookResult = { decision?: string; reason?: string; hookSpecificOutput?: { additionalContext?: string } }
type TurnActivity = (active: boolean, interrupted?: true) => void
type HookEvent = 'user-prompt-submit' | 'post-tool-use' | 'stop'

async function readHookInput(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('Hook input too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Translate the CLI's execution loop into Agent Code's reporting boundaries. A model
 * can make several invocations per user turn. Child conversations inherit workspace hooks. */
export function agyTurnObserver(getId: () => string | null, send: (event: HookEvent) => Promise<HookResult>, activity: TurnActivity) {
  let open: string | null = null
  return async (path: string, input: Record<string, unknown>) => {
    const id = getId()
    if (!id || input?.conversationId !== id) return {}
    if (path === '/pre' && open !== id) {
      open = id
      activity(true)
      let result: HookResult
      try {
        result = await send('user-prompt-submit')
      } catch (error) {
        open = null
        activity(false, true)
        throw error
      }
      const message = result.hookSpecificOutput?.additionalContext
      return message ? { injectSteps: [{ systemMessage: { systemMessage: message } }] } : {}
    }
    if (path === '/tool') {
      await send('post-tool-use')
    } else if (path === '/stop' && open === id && input.fullyIdle === true) {
      // An interruption is not a successful completion and must not schedule another
      // model turn. Clear local busy state so the user can type again.
      let continuing = false
      let interrupted = true
      try {
        if (input.terminationReason === 'model_stop') {
          const result = await send('stop')
          interrupted = false
          if (result.decision === 'block') {
            continuing = true
            return { decision: 'continue', reason: result.reason }
          }
        }
      } finally {
        if (!continuing) {
          open = null
          if (interrupted) activity(false, true)
          else activity(false)
        }
      }
    }
    return {}
  }
}

export async function openAgyTurnHooks(servers: readonly BuiltInMcpServerConfig[], getId: () => string | null, activity: TurnActivity = () => {}) {
  const host = tldrHookServer(servers)
  if (!host) return null
  // macOS AF_UNIX paths have a 104-byte limit; the per-user TMPDIR can use nearly
  // all of it. mkdtemp makes a private directory underneath the short system path.
  const root = await mkdtemp('/tmp/agent-code-agy-hooks-')
  const socketPath = join(root, 'hooks.sock')
  const workspace = join(root, 'workspace')
  const observe = agyTurnObserver(getId, async event => {
    const response = await fetch(`${host.tldrHooks.baseUrl}/${event}`, {
      method: 'POST', headers: { Authorization: `Bearer ${host.bearerToken}`, 'content-type': 'application/json' },
      // Keep the provider's prompt, transcript path, tool arguments, and outputs inside
      // its own hook process. The host only needs to know which boundary fired.
      body: '{}', redirect: 'error', signal: AbortSignal.timeout(4000),
    })
    if (!response.ok) throw new Error('Reporting hook unavailable')
    return await response.json() as HookResult
  }, activity)
  let pending = Promise.resolve()
  const listener = createServer(async (request, response) => {
    let result = {}
    try {
      if (request.method === 'POST') {
        const input = await readHookInput(request)
        // Serialize the state transition as well as the HTTP request. Two simultaneous
        // stop notifications must not schedule two continuations of one turn.
        const handled = pending.then(() => observe(request.url ?? '', input))
        pending = handled.then(() => {}, () => {})
        result = await handled
      }
    } catch { /* Reporting is best effort; an unavailable hook must never strand a turn. */ }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(result))
  })
  const close = async () => {
    listener.close()
    listener.closeAllConnections()
    await rm(root, { recursive: true, force: true, maxRetries: 2 }).catch(() => {})
  }
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(socketPath, resolve)
    })
    const handler = (path: string) => ({
      type: 'command', timeout: 6,
      command: `/usr/bin/curl --silent --max-time 5 --unix-socket '${socketPath}' --data-binary @- http://localhost/${path}`,
    })
    await mkdir(join(workspace, '.agents'), { recursive: true })
    await writeFile(join(workspace, '.agents', 'hooks.json'), JSON.stringify({
      'agent-code-reporting': {
        PreInvocation: [handler('pre')], PostToolUse: [{ matcher: '*', hooks: [handler('tool')] }], Stop: [handler('stop')],
      },
    }), { mode: 0o600 })
    return { workspace, close }
  } catch (error) {
    await close()
    throw error
  }
}
