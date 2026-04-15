import type { Settings } from '../../../state/settings/types'

type Props = {
  onClose: () => void
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onReset: () => void
}

export function SettingsPage({ onClose, settings, onChange, onReset }: Props) {
  return (
    <div className="h-full min-h-0 min-w-0 overflow-auto bg-canvas">
      <div className="mx-auto w-full max-w-4xl px-8 py-8">
        <div className="flex items-center justify-between border-b border-border pb-4">
          <div>
            <div className="text-[18px] font-semibold text-ink">Settings</div>
            <div className="text-[12px] text-muted mt-1">
              App preferences and workflow defaults.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onReset}
              className="px-3 py-1.5 text-[12px] border border-border text-ink-dim hover:text-ink hover:border-border-hi"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-[12px] border border-border text-ink-dim hover:text-ink hover:border-border-hi"
            >
              Back
            </button>
          </div>
        </div>

        <div className="pt-6 flex flex-col gap-4">
          <Section
            title="Workspace"
            description="Behavior that affects how sessions are rendered and restarted."
          >
            <Toggle
              label="Custom rendering"
              hint="Enable richer widgets for recognized tool output instead of generic rows."
              value={settings.customRendering}
              onChange={value => onChange({ customRendering: value })}
            />
            <Toggle
              label="Dangerous agents by default"
              hint="Start Claude and Codex sessions with the dangerous bypass flags enabled."
              value={settings.dangerousAgentsEnabled}
              onChange={value => onChange({ dangerousAgentsEnabled: value })}
            />
            <Toggle
              label="Proxy-streamed semantic rendering (Claude)"
              hint="Spawn each Claude session through a local mitmproxy and render the ReaderView from decrypted Anthropic stream events instead of screen-scraping. Requires mitmproxy installed (run `npm run proxy-demo-bootstrap`). Experimental."
              value={settings.useProxyStreaming}
              onChange={value => onChange({ useProxyStreaming: value })}
            />
          </Section>

          <Section
            title="Appearance"
            description="Theme mode and accent are now handled from the eye menu in the top-right header."
          >
            <div className="text-[11px] text-muted leading-5">
              Appearance settings stay available in the header for faster access.
              Deprecated options like high contrast, live terminal preview, and
              system events have been removed from the app.
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="border border-border bg-canvas px-4 py-4">
      <div className="text-[12px] text-ink mb-1">{title}</div>
      <div className="text-[11px] text-muted leading-5 mb-4">{description}</div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  )
}

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="w-full border border-border px-3 py-3 text-left hover:border-border-hi"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[12px] text-ink">{label}</div>
          <div className="text-[11px] text-muted leading-5 mt-1">{hint}</div>
        </div>
        <span
          className={`
            flex-shrink-0 w-3.5 h-3.5 border
            ${value ? 'bg-accent border-accent' : 'bg-transparent border-border-hi'}
          `}
        />
      </div>
    </button>
  )
}
