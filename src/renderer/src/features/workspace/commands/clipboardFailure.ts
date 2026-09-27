// What a copy command says when the clipboard refused the write (#1250 row 9).
//
// WHY fixed words: the rejection is a DOMException whose message is browser
// text ("Document is not focused."), and user-visible text is curated (q22).
// WHY this advice: Electron's clipboard write needs a focused document, and
// the usual cause is focus left elsewhere by the palette or a context menu.
export const CLIPBOARD_WRITE_FAILED = "Couldn't copy to the clipboard. Click into the app and try again."
