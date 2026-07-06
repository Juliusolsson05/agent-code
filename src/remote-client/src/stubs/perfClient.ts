// Phone substitute for @renderer/performance/client (aliased in
// vite.config.ts). The desktop client ships spans/metrics over IPC into
// the app's OpenTelemetry pipeline; the phone has neither the IPC nor the
// pipeline, and remote rendering performance is observable from the
// desktop side (the server sees every frame it sends). No-ops preserve
// the full call-shape so Feed.tsx and friends compile unchanged.

export function mark(_name: string, _data?: Record<string, unknown>): void {}
export function metric(
  _name: string,
  _value: number,
  _unit?: string,
  _data?: Record<string, unknown>,
): void {}
export function count(_name: string, _value = 1, _data?: Record<string, unknown>): void {}
export function gauge(_name: string, _value: number, _data?: Record<string, unknown>): void {}
export function error(_name: string, _err: unknown, _data?: Record<string, unknown>): void {}
export function span(
  _name: string,
  _data?: Record<string, unknown>,
): { end: (data?: Record<string, unknown>) => void; fail: (err: unknown) => void } {
  return { end: () => {}, fail: () => {} }
}
export async function initializePerformance(): Promise<{ enabled: boolean }> {
  return { enabled: false }
}
export function getPerformanceConfig(): { enabled: boolean } {
  return { enabled: false }
}
