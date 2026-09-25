import { buttonVariants } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'

import { ACCENTS, THEME_MODES, isDarkThemeMode } from '@renderer/app-state/settings/types'
import type { AccentId, Settings, ThemeModeValue } from '@renderer/app-state/settings/types'
import { isSavedThemeId } from '@renderer/app-state/settings/savedThemes'

// Saved themes DO appear here, unlike the old 'custom' sentinel they replaced.
// That entry was excluded because selecting it opened a JSON editor and looked
// like a broken no-op in a compact popover, and because the default custom
// payload started life as a copy of the dark theme. Neither is true of a named
// saved theme — it is an ordinary one-click preset, and excluding it would
// only make this menu disagree with Settings about which themes exist.
// Creating and editing still live in Settings; this popover only selects.
//
// The accent and contrast controls stay hidden while a saved theme is active
// for the same reason they were hidden for custom mode: a saved theme writes
// all 81 tokens as inline properties, which outrank both the accent variables
// and the [data-contrast="high"] blocks, so those controls would do nothing.

type Props = {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

// WHY the shared DropdownMenu (keyboard-first plan M1): the old popover was a
// hand-rolled `role="menu"` div whose children were plain buttons, not menu
// items. It never moved focus into itself on open, had no arrow keys, and
// its Escape handler (a document listener) closed it without returning focus
// to the eye button — so a keyboard user opened it, and then Tab walked PAST
// it into the page. Radix gives focus entry, roving items across the whole
// panel (DOM order, so ↓ walks the mode grid left-to-right, then the
// swatches), typeahead on labels, and Escape back to the trigger.
//
// WHY `event.preventDefault()` in every onSelect: a menu closes on selection
// by default, but this one is a live preview — the user tries Nord, then
// Tokyo Night, then an accent. Closing after each pick would make comparing
// themes a reopen-per-click chore. Escape, a click outside, or Tab closes it.
export function AppearanceMenu({ settings, onChange }: Props) {
  const keepOpen = (event: Event) => event.preventDefault()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title="Appearance"
        // The settings bar's shared control look, square at the bar's 24px
        // height (ledger G-28; SettingsBar has the WHY). It was a 28px box
        // with its own border tokens, taller than its neighbours.
        className={buttonVariants({ variant: 'outline', size: 'xs', className: 'w-6 px-0 [-webkit-app-region:no-drag]' })}
      >
        <EyeIcon />
        <span className="sr-only">Appearance</span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[280px] p-0">
        <Section title="Mode">
          <DropdownMenuRadioGroup
            value={settings.mode}
            onValueChange={next => onChange({ mode: next as ThemeModeValue })}
            className="grid grid-cols-2 gap-1.5"
          >
            {[...THEME_MODES.map(mode => ({ id: mode.id as ThemeModeValue, label: mode.label })),
              ...settings.savedThemes.map(theme => ({ id: theme.id as ThemeModeValue, label: theme.name }))].map(mode => (
              <DropdownMenuRadioItem
                key={mode.id}
                value={mode.id}
                onSelect={keepOpen}
                className="justify-center border border-border px-3 py-1.5 text-[11px] uppercase tracking-wider data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-fg data-[highlighted]:border-border-hi"
              >
                {mode.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {isSavedThemeId(settings.mode) ? (
            <div className="rounded-slab mt-2 border border-border bg-canvas px-2 py-2 text-[10px] leading-4 text-muted">
              Saved theme colors are edited in Settings.
            </div>
          ) : null}
        </Section>

        {!isSavedThemeId(settings.mode) ? (
          <Section title="Accent">
            <DropdownMenuRadioGroup
              value={settings.accent}
              onValueChange={next => onChange({ accent: next as AccentId })}
              className="grid grid-cols-4 gap-1.5"
            >
              {ACCENTS.map(a => (
                <DropdownMenuRadioItem
                  key={a.id}
                  value={a.id}
                  onSelect={keepOpen}
                  // The swatch has no text, so the accessible name and the
                  // typeahead label both come from the accent's name.
                  aria-label={a.name}
                  textValue={a.name}
                  title={a.name}
                  className="aspect-square p-0 data-[state=checked]:ring-2 data-[state=checked]:ring-ink data-[state=checked]:ring-offset-2 data-[state=checked]:ring-offset-popover-bg data-[highlighted]:brightness-110 data-[highlighted]:outline data-[highlighted]:outline-1 data-[highlighted]:outline-focus-ring"
                  // Only reachable for built-in modes — the enclosing branch
                  // excludes saved themes, which carry their own accent token.
                  style={{ background: isDarkThemeMode(settings.mode) ? a.dark : a.light }}
                />
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuCheckboxItem
              checked={settings.contrast}
              onCheckedChange={checked => onChange({ contrast: checked === true })}
              onSelect={keepOpen}
              className="mt-3 border border-border px-2.5 py-2 text-[11px]"
            >
              High Contrast
            </DropdownMenuCheckboxItem>
          </Section>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-3 border-b border-border last:border-b-0">
      {/* 10px, not 9px (plan T5: legends/labels 10px). */}
      <div className="text-[10px] uppercase tracking-wider text-muted mb-2">
        {title}
      </div>
      {children}
    </div>
  )
}

function EyeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M1.5 8s2.3-4 6.5-4 6.5 4 6.5 4-2.3 4-6.5 4-6.5-4-6.5-4z" />
      <circle cx="8" cy="8" r="2.2" />
    </svg>
  )
}
