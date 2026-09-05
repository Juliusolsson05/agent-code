import type { CommandDispatchOutcome } from './executeCommand'

export type CommandExecutionRequest = { token: string; commandId: string; expectedSessionId?: string }
export class CommandExecutionTimeout extends Error {
  constructor(readonly started: boolean) { super(started ? 'Command dispatch did not finish; inspect state before retrying' : 'The command host did not claim this request; it will not execute later') }
}
export class CommandExecutionBusy extends Error {
  constructor() { super('Another external command is pending; inspect its result before issuing another') }
}

// The native menu/keybinding path already mounts the heavy command context
// only on demand. This independent, tiny rendezvous lets other callers await
// that same domain dispatcher without putting callbacks in persisted app state
// or keeping an invisible context subscribed to every agent token.
let pending: CommandExecutionRequest | null = null
let claimed = false
let finish: ((outcome: CommandDispatchOutcome) => void) | undefined
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }
export const commandExecutionRequests = {
  snapshot: () => pending,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  request(input: Omit<CommandExecutionRequest, 'token'>): Promise<CommandDispatchOutcome> {
    if (pending) return Promise.reject(new CommandExecutionBusy())
    return new Promise((resolve, reject) => {
      const token = crypto.randomUUID()
      const timeout = setTimeout(() => {
        if (pending?.token !== token) return
        const started = claimed
        pending = null; finish = undefined; claimed = false; notify()
        reject(new CommandExecutionTimeout(started))
      }, 20_000)
      finish = result => { clearTimeout(timeout); resolve(result) }
      claimed = false; pending = { token, ...input }; notify()
    })
  },
  claim(token: string) {
    if (pending?.token !== token || claimed) return false
    claimed = true; return true
  },
  complete(token: string, outcome: CommandDispatchOutcome) {
    if (pending?.token !== token) return
    const resolve = finish
    pending = null; finish = undefined; claimed = false
    resolve?.(outcome); notify()
  },
}
