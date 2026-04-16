import { useEffect, useMemo, useState } from 'react'

import { Feed } from '../../../src/renderer/src/feed/Feed'
import { useAppStore } from '../../../src/renderer/src/state/hooks'
import { applyTheme } from '../../../src/renderer/src/state/settings/theme'
import { DEFAULT_SETTINGS, THEME_MODES, type ThemeMode } from '../../../src/renderer/src/state/settings/types'
import { RENDERING_FIXTURES } from './fixtures'

export function RenderingHarnessApp() {
  const setSettings = useAppStore(state => state.setSettings)
  const settings = useAppStore(state => state.settings)
  const [selectedId, setSelectedId] = useState(RENDERING_FIXTURES[0]?.id ?? '')

  const fixture = useMemo(
    () => RENDERING_FIXTURES.find(item => item.id === selectedId) ?? RENDERING_FIXTURES[0],
    [selectedId],
  )

  useEffect(() => {
    setSettings({
      ...DEFAULT_SETTINGS,
      customRendering: false,
      useProxyStreaming: false,
    })
  }, [setSettings])

  useEffect(() => {
    applyTheme(settings)
  }, [settings])

  if (!fixture) return null

  return (
    <div className="h-screen bg-canvas text-ink font-code">
      <div className="grid h-full grid-cols-[320px_minmax(0,1fr)]">
        <aside className="border-r border-border bg-surface px-4 py-4 overflow-y-auto">
          <div className="text-[13px] text-ink">Rendering Harness</div>
          <div className="mt-1 text-[11px] text-muted">
            Isolated Electron surface for feed rendering fixtures.
          </div>

          <div className="mt-5">
            <div className="mb-2 text-[11px] uppercase tracking-[0.12em] text-muted">Fixture</div>
            <div className="flex flex-col gap-2">
              {RENDERING_FIXTURES.map(item => {
                const active = item.id === fixture.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className={`border px-3 py-3 text-left transition-colors ${
                      active
                        ? 'border-accent bg-accent/10 text-ink'
                        : 'border-border bg-canvas hover:border-border-hi text-ink-dim hover:text-ink'
                    }`}
                  >
                    <div className="text-[12px]">{item.title}</div>
                    <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted">
                      {item.provider}
                    </div>
                    <div className="mt-2 text-[11px] leading-5 text-muted">
                      {item.description}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="mt-6">
            <div className="mb-2 text-[11px] uppercase tracking-[0.12em] text-muted">Theme</div>
            <select
              value={settings.mode}
              onChange={e => setSettings({ mode: e.target.value as ThemeMode })}
              className="w-full border border-border bg-canvas px-3 py-2 text-[12px] outline-none"
            >
              {THEME_MODES.map(option => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-4 flex flex-col gap-2 text-[12px]">
            <label className="flex items-center gap-2 text-ink-dim">
              <input
                type="checkbox"
                checked={settings.customRendering}
                onChange={e => setSettings({ customRendering: e.target.checked })}
              />
              custom rendering
            </label>
            <label className="flex items-center gap-2 text-ink-dim">
              <input
                type="checkbox"
                checked={settings.contrast}
                onChange={e => setSettings({ contrast: e.target.checked })}
              />
              high contrast
            </label>
          </div>

          <div className="mt-6 border-t border-border pt-4 text-[11px] leading-5 text-muted">
            <div>Entries: {fixture.entries.length}</div>
            <div>Streaming: {fixture.streamingScreenMarkdown ? 'yes' : 'no'}</div>
          </div>
        </aside>

        <main className="min-w-0 min-h-0 overflow-hidden">
          <div className="border-b border-border bg-surface px-5 py-4">
            <div className="text-[14px] text-ink">{fixture.title}</div>
            <div className="mt-1 text-[11px] text-muted">{fixture.description}</div>
          </div>

          <div className="h-[calc(100vh-69px)] min-h-0 overflow-hidden">
            <Feed
              sessionId={`rendering-harness:${fixture.id}`}
              provider={fixture.provider}
              entries={fixture.entries}
              streamingScreen={fixture.streamingScreenMarkdown ?? null}
              streamingScreenMarkdown={fixture.streamingScreenMarkdown ?? null}
              streamingBaseline={fixture.streamingBaseline ?? null}
              activityStatus={fixture.activityStatus ?? null}
              tailMode={false}
              workspaceRoot={null}
            />
          </div>
        </main>
      </div>
    </div>
  )
}
