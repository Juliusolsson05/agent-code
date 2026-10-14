import { renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { resetSetupStoreForTests, useMissingProviders, useSetupStore } from '@renderer/features/setup/store'
import type { SetupCheckResult } from '@shared/types/setup'

afterEach(() => resetSetupStoreForTests())

// Review a #9 (#1482): the setup check only ever lists LOCAL CLIs as usable,
// so subtracting it from every provider kind marked Hermes "Not installed ·
// File › Setup…" in every picker, even when signed in, pointing at a Setup
// panel that has no Hermes row.
it('never marks a remote provider as a missing CLI', () => {
  useSetupStore.setState({ check: { usableProviders: ['claude'] } as unknown as SetupCheckResult })
  const { result } = renderHook(() => useMissingProviders())
  expect(result.current.has('codex')).toBe(true)
  expect(result.current.has('hermes')).toBe(false)
})
