// Raw CDP events → the bounded console / network buffers the `browser_*`
// tools report (decomposition Stage 2). Pure: the controller feeds it every
// `debugger.on('message')` and reads the rings back.
//
// Shapes are from __fixtures__/cdp-events.*.jsonl (real Chrome). Two of them
// shaped this file:
// - Every failed resource is reported TWICE: once as Network.responseReceived
//   (status ≥ 400) or Network.loadingFailed, and again as Log.entryAdded with
//   `source: "network"`. Network-sourced log entries are therefore dropped from
//   the console ring; otherwise a single 404 shows up in both buffers.
// - Network.loadingFailed carries NO url, only a requestId, so the URL is
//   joined from the earlier Network.requestWillBeSent.

export type ConsoleEntry = { level: 'error' | 'warning' | 'log' | 'info' | 'debug'; text: string; url?: string; at: number }
export type NetworkEntry = { url: string; method?: string; status: number | null; error?: string; resourceType?: string; at: number }

export type CdpBuffers = {
  console: ConsoleEntry[]
  network: NetworkEntry[]
  /** requestId → { url, method }, bounded like the rings. */
  requests: Map<string, { url: string; method?: string }>
}

// 200 per ring: T3 Code's bound, large enough for a noisy dev page's startup
// and small enough that `browser_console` output stays readable.
export const RING_SIZE = 200
const REQUEST_INDEX_SIZE = 1000

export function emptyBuffers(): CdpBuffers {
  return { console: [], network: [], requests: new Map() }
}

export function reduceCdpEvent(buffers: CdpBuffers, method: string, params: any, at: number): void {
  switch (method) {
    case 'Network.requestWillBeSent': {
      buffers.requests.set(params.requestId, { url: params.request?.url ?? '', method: params.request?.method })
      if (buffers.requests.size > REQUEST_INDEX_SIZE) buffers.requests.delete(buffers.requests.keys().next().value!)
      return
    }
    case 'Network.responseReceived': {
      const status = params.response?.status
      // Recorded on every page: Chrome itself fetches /favicon.ico (type
      // "Other") and a dev app without one answers 404. Reporting that to the
      // agent on every snapshot is pure noise, and it is not the page's request.
      if (params.type === 'Other' && /\/favicon\.ico(\?|$)/.test(params.response?.url ?? '')) return
      if (typeof status === 'number' && status >= 400) {
        push(buffers.network, { url: params.response.url, method: buffers.requests.get(params.requestId)?.method, status, resourceType: params.type, at })
      }
      return
    }
    case 'Network.loadingFailed': {
      // A cancelled request (navigation away, aborted fetch) is not a failure
      // worth reporting to an agent.
      if (params.canceled) return
      const req = buffers.requests.get(params.requestId)
      push(buffers.network, { url: req?.url ?? '(unknown url)', method: req?.method, status: null, error: params.errorText, resourceType: params.type, at })
      return
    }
    case 'Runtime.consoleAPICalled': {
      const level = normaliseLevel(params.type)
      push(buffers.console, { level, text: (params.args ?? []).map(renderArg).join(' '), url: params.stackTrace?.callFrames?.[0]?.url, at })
      return
    }
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails ?? {}
      // `description` carries "Error: message\n    at …"; `text` alone is only
      // "Uncaught" / "Uncaught (in promise)" (recorded).
      const description = d.exception?.description ?? d.exception?.value
      push(buffers.console, { level: 'error', text: description ? `${d.text}: ${firstLine(String(description))}` : String(d.text ?? 'Uncaught exception'), url: d.url, at })
      return
    }
    case 'Log.entryAdded': {
      const e = params.entry ?? {}
      if (e.source === 'network') return // duplicate of the network ring (see header)
      push(buffers.console, { level: normaliseLevel(e.level), text: String(e.text ?? ''), url: e.url, at })
      return
    }
  }
}

/** Entries at or after `since` (ms). Used for "since your last snapshot". */
export function entriesSince<T extends { at: number }>(ring: T[], since: number | undefined): T[] {
  return since === undefined ? ring.slice() : ring.filter(e => e.at >= since)
}

function push<T>(ring: T[], entry: T): void {
  ring.push(entry)
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE)
}

function normaliseLevel(value: unknown): ConsoleEntry['level'] {
  switch (value) {
    case 'error': case 'assert': return 'error'
    case 'warning': case 'warn': return 'warning'
    case 'info': return 'info'
    case 'debug': case 'verbose': return 'debug'
    default: return 'log'
  }
}

/** Recorded arg shapes: primitives carry `value`; objects carry a `preview`
 * with properties, or at least a `description`. */
function renderArg(arg: any): string {
  if (arg == null) return ''
  if ('value' in arg) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
  if (arg.preview?.properties) {
    const body = arg.preview.properties.map((p: any) => `${p.name}: ${p.value}`).join(', ')
    return arg.preview.subtype === 'array' ? `[${body}]` : `{${body}}`
  }
  return String(arg.description ?? arg.type ?? '')
}

function firstLine(text: string): string {
  return text.split('\n')[0]!
}
