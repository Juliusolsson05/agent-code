import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * tailwind-merge resolves its `rounded-*` conflict group from Tailwind's OWN
 * scale (`none|sm|md|lg|xl|2xl|3xl|full`). Agent Code's four semantic radius
 * utilities — `chip` / `control` / `slab` / `float`, declared in the
 * `@theme inline` block of styles.css — are invisible to it, so out of the box
 * `twMerge('rounded-control', 'rounded-none')` returns BOTH classes.
 *
 * When both survive, the winner is decided by emission order in the compiled
 * stylesheet, which Tailwind v4 sorts alphabetically by suffix:
 *
 *     rounded < -chip < -control < -float < -full < -none < -slab
 *
 * That silently made the documented escape hatch a coin flip: `rounded-none`
 * happens to beat `rounded-control` (SettingsList's flush rows rely on this)
 * purely because "none" sorts after "control" — while the SAME opt-out against
 * `rounded-slab` would lose, and a caller-supplied `rounded-chip` could never
 * override a primitive's `rounded-control`. A styling escape hatch that works
 * 4 times out of 5 by alphabetical accident is worse than none, because the
 * failure is invisible in review.
 *
 * Registering the four names in the `rounded` class group makes the conflict
 * real, so last-one-wins holds for every combination and the opt-out documented
 * in styles.css is actually load-bearing. The side-scoped variants
 * (`rounded-l-control`, `rounded-b-float`, …) are handled by tailwind-merge's
 * existing per-side groups once the base names are known.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      rounded: [{ rounded: ['chip', 'control', 'slab', 'float'] }],
    },
  },
})

/**
 * Compose conditional classes and resolve conflicting Tailwind utilities.
 *
 * WHY this tiny helper is shared: locally owned shadcn-style components must
 * accept caller layout overrides without producing class-order accidents.
 * Keeping the conventional `cn` name also means upstream component diffs stay
 * recognizable. This is deliberately not a styling DSL or theme abstraction;
 * Agent Code's semantic CSS variables remain the source of truth.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
