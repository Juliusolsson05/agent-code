import type { MutableRefObject } from 'react'

import { UndoCloseStack } from '@renderer/lib/undoClose'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// The minimal honest WorkspaceRefs the IPC subscription handlers actually
// touch. It is NOT a full workspace. Shared by the subscription tests so a
// change to WorkspaceRefs breaks one helper instead of drifting across copies.
//
// Plain object refs are fine outside React's render cycle — the hook only ever
// reads and writes `.current`.
export function makeWorkspaceRefsForTest(state: WorkspaceState): WorkspaceRefs {
  const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value })
  return {
    stateRef: ref(state),
    latestStateRef: ref(state),
    latestRuntimesRef: ref({}),
    latestTileTabsRef: ref(null),
    dangerousAgentsRef: ref(false),
    useProxyStreamingRef: ref(false),
    defaultBuiltInMcpDomainsRef: ref([]),
    seenUuidsRef: ref({}),
    latestScreenRef: ref({}),
    undoStackRef: ref(new UndoCloseStack()),
    bootstrapTimersRef: ref(new Map()),
    persistedFeedDebugIdRef: ref({}),
    inFlightFeedDebugIdRef: ref({}),
    paneToastTimers: ref({}),
    pendingAdoptionWindowIdsRef: ref<string[]>([]),
    saveTimerRef: ref(null),
    bootRef: ref(false),
  }
}
