import { AppearanceMenu } from '@renderer/features/feed/AppearanceMenu'
import { PerformanceMonitor } from '@renderer/features/performance-monitor/PerformanceMonitor'
import { UsageHeaderIndicator } from '@renderer/features/usage/ui/UsageHeaderIndicator'
import { useAppStore } from '@renderer/app-state/hooks'
import { useCaffeinateStore } from '@renderer/features/caffeinate/store'

// Settings bar — compact row under tabs holding app chrome.
// (Extracted verbatim from App.tsx by #494.)
export function SettingsBar() {
  const settings = useAppStore(state => state.settings)
  const setSettings = useAppStore(state => state.setSettings)
  const performancePanelOpen = useAppStore(state => state.performancePanelOpen)
  const togglePerformancePanel = useAppStore(state => state.togglePerformancePanel)
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
          className={`rounded-control
            px-2 py-1 border text-[10px] font-code transition-colors
            ${
              performancePanelOpen
                ? 'border-accent bg-accent text-accent-fg'
                : 'border-border bg-surface-hi text-muted hover:text-ink'
            }
          `}
        >
          performance
        </button>
        <button
          type="button"
          disabled={caffeinateStatus?.supported === false}
          onClick={() => void toggleCaffeinate()}
          title={
            caffeinateStatus?.supported === false
              ? 'Caffeinate is only available on macOS.'
              : caffeinateStatus?.active
                ? 'Caffeinate is active. Click to stop keeping the machine awake.'
                : 'Start caffeinate to prevent idle sleep during long-running agent work.'
          }
          className={`rounded-control
            px-2 py-1 border text-[10px] font-code transition-colors
            ${
              caffeinateStatus?.active
                ? 'border-accent bg-accent text-accent-fg'
                : caffeinateStatus?.supported === false
                  ? 'border-border bg-surface-hi text-muted/50 cursor-not-allowed'
                : 'border-border bg-surface-hi text-muted hover:text-ink'
            }
          `}
        >
          caff
        </button>
        {/* Mount owns only display polling; closing it leaves baseline collection running. */}
        {performancePanelOpen ? <PerformanceMonitor onClose={togglePerformancePanel} /> : null}
      </div>
    </div>
  )
}
