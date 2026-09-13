// Identifies hidden extension runtime windows at the moment Electron emits
// `browser-window-created`. That event fires synchronously INSIDE the
// BrowserWindow constructor, before the caller can tag the returned object, so a
// tag set afterwards (or a WeakSet of created windows) is always too late.
//
// Main-process observers of every window use this to skip runtime windows. The
// renderer freeze watchdog was the concrete casualty: a runtime window never
// sends the application renderer heartbeat, so every running extension produced
// a false "renderer freeze" snapshot every 30 s, and an extension renderer crash
// was recorded as an application renderer crash in incident classification.
//
// Deliberately a leaf module with no imports, so the incident hooks can depend
// on it without pulling the extension runtime service into their import graph.
let creatingRuntimeWindow = 0

export function createExtensionRuntimeWindow<T>(create: () => T): T {
  creatingRuntimeWindow += 1
  try { return create() } finally { creatingRuntimeWindow -= 1 }
}

export function isCreatingExtensionRuntimeWindow(): boolean {
  return creatingRuntimeWindow > 0
}
