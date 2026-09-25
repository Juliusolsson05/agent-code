import { SETTING_CATEGORIES } from '@renderer/features/settings/lib/settingsCategories'
import type { SettingCategoryId } from '@renderer/features/settings/lib/settingsCategories'

type Props = {
  selectedCategory: SettingCategoryId | 'all'
  onSelectCategory: (category: SettingCategoryId | 'all') => void
  counts: Record<string, number>
}

// The category list is a vertical TABLIST (plan S45/N14): one Tab stop,
// ↑↓ and Home/End move focus AND select (a category switch is cheap and
// reversible — unlike a live settings radio, see SettingsList), wrapping.
// It was a column of ordinary buttons, every one a Tab stop, with the
// selection shown by colour alone.
export function SettingsSidebar({ selectedCategory, onSelectCategory, counts }: Props) {
  const ids: Array<SettingCategoryId | 'all'> = ['all', ...SETTING_CATEGORIES.map(category => category.id)]
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = Math.max(0, ids.indexOf(selectedCategory))
    const next =
      event.key === 'ArrowDown' ? index + 1
        : event.key === 'ArrowUp' ? index - 1
          : event.key === 'Home' ? 0
            : event.key === 'End' ? ids.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    const id = ids[(next + ids.length) % ids.length]!
    onSelectCategory(id)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-category="${id}"]`)?.focus()
  }
  return (
    <aside className="hidden w-[220px] shrink-0 border-r border-border bg-surface md:block">
      <div className="border-b border-border px-4 py-3">
        <div className="text-[10px] uppercase tracking-wider text-muted">Categories</div>
      </div>

      <div className="flex flex-col gap-1 p-2" role="tablist" aria-orientation="vertical" aria-label="Setting categories" onKeyDown={onKeyDown}>
        <SidebarButton
          id="all"
          active={selectedCategory === 'all'}
          label="All Settings"
          count={counts.all ?? 0}
          onClick={() => onSelectCategory('all')}
        />
        {SETTING_CATEGORIES.map(category => (
          <SidebarButton
            key={category.id}
            id={category.id}
            active={selectedCategory === category.id}
            label={category.label}
            count={counts[category.id] ?? 0}
            onClick={() => onSelectCategory(category.id)}
          />
        ))}
      </div>
    </aside>
  )
}

function SidebarButton({
  id,
  active,
  label,
  count,
  onClick,
}: {
  id: string
  active: boolean
  label: string
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-category={id}
      onClick={onClick}
      className={`rounded-control flex items-center justify-between border px-3 py-2 text-left text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ${
        active
          ? 'border-control-active-bg bg-control-active-bg text-control-active-fg'
          : 'border-control-border bg-control-bg text-control-fg hover:border-control-border-hover hover:bg-control-hover-bg hover:text-ink'
      }`}
    >
      <span>{label}</span>
      <span className={active ? 'text-control-active-fg/80' : 'text-muted'}>{count}</span>
    </button>
  )
}
