import { createContext, useContext } from 'react'

// The toast CONTRACT, apart from any toast PRESENTATION (#1177).
//
// WHY a module of its own: rows the phone also mounts (AskUserQuestionRow,
// SafeMarkdownLink, SafeInlineCode) raise toasts. The desktop provider in
// GlobalToast.tsx reads the app store and subscribes to extension IPC, so
// the phone used to alias the whole module away and re-declare this context
// in its own file — two contexts that merely looked alike, kept in step by
// hand. Now there is ONE context: the desktop's GlobalToastProvider and the
// phone's ToastHostProvider both provide it, and every row imports the hook
// from here, which pulls in nothing host-specific.
//
// The default is a no-op on purpose: a row rendered with no toast host
// (replay, a renderer test) must not throw for want of a banner.

export type GlobalToastContextValue = {
  showToast: (message: string, durationMs?: number) => void
}

export const GlobalToastContext = createContext<GlobalToastContextValue>({
  showToast: () => {},
})

export function useGlobalToast(): GlobalToastContextValue {
  return useContext(GlobalToastContext)
}
