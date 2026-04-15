import { SETTING_CATEGORIES, type SettingCategoryId } from '../lib/settingsCategories'

type Props = {
  selectedCategory: SettingCategoryId | 'all'
  onSelectCategory: (category: SettingCategoryId | 'all') => void
  counts: Record<string, number>
}

export function SettingsSidebar({ selectedCategory, onSelectCategory, counts }: Props) {
  return (
    <aside className="hidden w-[220px] shrink-0 border-r border-border bg-surface md:block">
      <div className="border-b border-border px-4 py-3">
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted">Categories</div>
      </div>

      <div className="flex flex-col gap-1 p-2">
        <SidebarButton
          active={selectedCategory === 'all'}
          label="All Settings"
          count={counts.all ?? 0}
          onClick={() => onSelectCategory('all')}
        />
        {SETTING_CATEGORIES.map(category => (
          <SidebarButton
            key={category.id}
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
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-between border px-3 py-2 text-left text-[12px] ${
        active
          ? 'border-accent bg-accent text-accent-fg'
          : 'border-border text-ink-dim hover:border-border-hi hover:text-ink'
      }`}
    >
      <span>{label}</span>
      <span className={active ? 'text-accent-fg/80' : 'text-muted'}>{count}</span>
    </button>
  )
}
