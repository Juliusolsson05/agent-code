import { buttonVariants } from '@renderer/components/ui/button'
import { AppearanceMenu } from '@renderer/features/feed/AppearanceMenu'
import { PerformanceMonitor } from '@renderer/features/performance-monitor/PerformanceMonitor'
import { UsageHeaderIndicator } from '@renderer/features/usage/ui/UsageHeaderIndicator'
import { useAppStore } from '@renderer/app-state/hooks'
import { useCaffeinateStore } from '@renderer/features/caffeinate/store'

// Settings bar — compact row under tabs holding app chrome.
// (Extracted verbatim from App.tsx by #494.)
//
// WHY every control here is `buttonVariants` outline xs (ledger G-28): the
// four controls in this one strip were drawn four ways. Usage was a square
// chip with no focus ring and an accent hover, Appearance a 28px icon box,
// and performance / caff ~22px chips with lowercase labels ("caff" named
// nothing). One height (24px), one border, one hover and one focus ring now,
// with Title Case labels per the casing ruling. The two toggles keep the
// accent fill for "on" (the Performance panel open, caffeinate active) — the
// same on-state the settings choice controls use — and their state is also
// in aria-expanded / aria-pressed, so the fill is never the only signal.
// The "on" fill for the two toggles. Hover classes restate the fill so the
// outline variant's hover (control fill, ink text) cannot wash out an active
// toggle while the pointer is over it; tailwind-merge drops the variant's
// conflicting ones.
const SETTINGS_BAR_ON = 'border-accent bg-accent text-accent-fg hover:border-accent hover:bg-accent hover:text-accent-fg'

export function SettingsBar() {
  const settings = useAppStore(state => state.settings)
  const setSettings = useAppStore(state => state.setSettings)
  const performancePanelOpen = useAppStore(state => state.performancePanelOpen)
  const togglePerformancePanel = useAppStore(state => state.togglePerformancePanel)
  const performancePanelRequest = useAppStore(state => state.performancePanelRequest)
  const consumePerformancePanelRequest = useAppStore(state => state.consumePerformancePanelRequest)
  const caffeinateStatus = useCaffeinateStore(state => state.status)
  const toggleCaffeinate = useCaffeinateStore(state => state.toggle)

  return (
    <div
      className="
        flex items-center justify-end gap-3
        px-3 py-1.5
        border-b border-border bg-surface
        flex-shrink-0
        [-webkit-app-region:drag]
      "
    >
      <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
        {/* Gating the MOUNT here (not inside the widget) is deliberate:
            unmounting is what tears down the widget's polling interval,
            so the disabled feature costs zero IPC. */}
        {settings.usageHeaderEnabled ? (
          <UsageHeaderIndicator level={settings.usageHeaderLevel} />
        ) : null}
        <AppearanceMenu settings={settings} onChange={setSettings} />
        <button
          type="button"
          onClick={togglePerformancePanel}
          aria-label="Open Performance Monitor"
          aria-expanded={performancePanelOpen}
          className={buttonVariants({
            variant: 'outline',
            size: 'xs',
            className: performancePanelOpen ? SETTINGS_BAR_ON : undefined,
          })}
        >
          Performance
        </button>
        <button
          type="button"
          disabled={caffeinateStatus?.supported === false}
          onClick={() => void toggleCaffeinate()}
          // An on/off toggle: the accent fill was its only state signal, and
          // the visible "caff" names nothing a screen reader user would
          // recognise, so both the state and a real name are spelled out
          // (ledger N18).
          aria-pressed={caffeinateStatus?.active === true}
          aria-label="Keep the machine awake (caffeinate)"
          title={
            caffeinateStatus?.supported === false
              ? 'Caffeinate is only available on macOS.'
              : caffeinateStatus?.active
                ? 'Caffeinate is active. Press to stop keeping the machine awake.'
                : 'Start caffeinate to prevent idle sleep during long-running agent work.'
          }
          className={buttonVariants({
            variant: 'outline',
            size: 'xs',
            // Unsupported (not macOS) keeps pointer events so the hover title
            // saying why still shows; the primitive's disabled style turns
            // them off.
            className: caffeinateStatus?.active
              ? SETTINGS_BAR_ON
              : caffeinateStatus?.supported === false
                ? 'disabled:pointer-events-auto disabled:cursor-not-allowed'
                : undefined,
          })}
        >
          Caffeinate
        </button>
        {/* Mount owns only display polling; closing it leaves baseline collection running. */}
        {performancePanelOpen ? <PerformanceMonitor onClose={togglePerformancePanel} request={performancePanelRequest} onRequestHandled={consumePerformancePanelRequest} /> : null}
      </div>
    </div>
  )
}
