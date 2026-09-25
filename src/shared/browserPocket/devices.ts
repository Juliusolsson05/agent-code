// Device presets for the pocket's viewport emulation. Dimensions are the CSS
// viewport sizes browsers' own device toolbars ship for these devices; only
// the CSS viewport changes, never the user agent (rewriting the UA breaks
// Cloudflare Turnstile, T3 Code #5002).
export const DEVICE_PRESETS = {
  'iphone-15': { label: 'iPhone 15', width: 393, height: 852, mobile: true },
  'pixel-8': { label: 'Pixel 8', width: 412, height: 915, mobile: true },
  'ipad': { label: 'iPad', width: 820, height: 1180, mobile: true },
  'desktop-1280': { label: 'Desktop 1280', width: 1280, height: 800, mobile: false },
  'desktop-1440': { label: 'Desktop 1440', width: 1440, height: 900, mobile: false },
} as const

export type DevicePresetId = keyof typeof DEVICE_PRESETS

export function viewportSize(viewport: { mode: 'preset'; preset: string; landscape?: boolean } | { mode: 'free'; width: number; height: number }): { width: number; height: number; mobile: boolean } | null {
  if (viewport.mode === 'free') return { width: viewport.width, height: viewport.height, mobile: viewport.width < 600 }
  const preset = DEVICE_PRESETS[viewport.preset as DevicePresetId]
  if (!preset) return null
  return viewport.landscape
    ? { width: preset.height, height: preset.width, mobile: preset.mobile }
    : { width: preset.width, height: preset.height, mobile: preset.mobile }
}
