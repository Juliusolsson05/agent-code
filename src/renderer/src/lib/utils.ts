import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

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
