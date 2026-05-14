import { useCallback, useEffect, useRef, useState } from 'react'

// Shared splitter drag controller.
//
// WHY this lives in features/shared instead of being inlined in each
// caller:
//
// We now have three splitters that all want the same drag behavior:
//   - GlobalEditorShell: outer editor/workspace split (ratio-based)
//   - GlobalEditorShell: inner file-tree/Monaco split (width-based)
//   - DispatchLayout: agent-list/active-agent split (ratio-based)
//
// They share three subtle correctness properties that are easy to get
// wrong if every call site reimplements them:
//
//   1. Window-level mousemove capture during a drag. If the move
//      handler lives on the splitter element, fast drags can let the
//      cursor outrun the element and onMouseMove stops firing — the
//      splitter "freezes" mid-drag. We attach the listener to window
//      with capture:true so it keeps receiving events even when the
//      cursor crosses non-splitter children below.
//   2. Cursor stability while dragging. As the splitter moves under
//      the pointer, the cursor would flicker between col-resize and
//      whatever the underlying element specifies. We slap a global
//      `* { cursor: col-resize !important; }` style tag during the
//      drag so the cursor stays locked.
//   3. preventDefault on mousedown. Text selection and image drag
//      both try to take over a mousedown that isn't strictly inside
//      a focusable control. Without preventDefault the user gets a
//      text-selection ghost trail as they drag the splitter across
//      content.
//
// The hook abstracts the drag mechanics but leaves the actual ratio
// computation to the caller, because the caller knows what its
// container's bounding rect is and whether it wants ratio (0..1) or
// pixel width as the output. The caller passes an `onDrag` callback
// that receives the raw clientX (or clientY for future vertical
// splitters — currently we only ship horizontal-split callers).

type Options = {
  /** Whether this splitter should respond to drags at all. Lets the
   *  caller turn the splitter off when its host component is in a
   *  state where resizing doesn't make sense (e.g. file tree hidden).
   *  Defaults to true. */
  enabled?: boolean
  /** Called on every mousemove during a drag with the raw clientX.
   *  Caller converts that into whatever ratio / pixel value it
   *  persists. */
  onDrag: (clientX: number) => void
}

type Controller = {
  /** Whether a drag is currently in progress. Use this to drive the
   *  splitter's visual highlight (e.g. switch bg color while
   *  dragging). */
  dragging: boolean
  /** Attach to the splitter element's onMouseDown. */
  onMouseDown: (e: React.MouseEvent) => void
  /** Render this fragment into your component so the global
   *  cursor-lock style appears only while dragging. We expose it
   *  rather than rendering it ourselves because the hook can't own
   *  DOM. Caller does `{splitter.cursorLock}` in its JSX. */
  cursorLock: React.ReactNode
}

export function useResizableSplitter({ enabled = true, onDrag }: Options): Controller {
  const [dragging, setDragging] = useState(false)
  // The onDrag callback is captured into a ref so the move-listener
  // effect doesn't tear down + re-add on every callback identity
  // change. Otherwise typing into a quickly-updating store while
  // dragging would flicker the listener registration.
  const onDragRef = useRef(onDrag)
  useEffect(() => {
    onDragRef.current = onDrag
  }, [onDrag])

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!enabled) return
      e.preventDefault()
      setDragging(true)
    },
    [enabled],
  )

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      onDragRef.current(e.clientX)
    }
    const onUp = () => setDragging(false)
    // capture:true so we win against any drag-prevention on the
    // panes underneath (xterm.js panes mouse-capture aggressively;
    // Monaco does its own selection handling).
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
    return () => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
    }
  }, [dragging])

  const cursorLock = dragging ? (
    // While dragging, force the col-resize cursor everywhere so the
    // user doesn't see it change when the pointer crosses pane
    // boundaries. Removed automatically when dragging ends.
    <style>{`* { cursor: col-resize !important; }`}</style>
  ) : null

  return { dragging, onMouseDown, cursorLock }
}
