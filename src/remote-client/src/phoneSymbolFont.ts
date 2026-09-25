// The phone's font stack: the app's chosen stack with the phone's own symbol
// face in FRONT of it (#1194). The face itself, and every reason for its
// shape (self-hosted, unicode-range-scoped, phone only), is documented at its
// @font-face in ./styles.css.
//
// WHY first and not appended: WebKit expands `ui-monospace` (in every app
// stack) into a system cascade that reaches Apple Color Emoji before any face
// listed after it, so an appended symbol face never wins on iOS. First is
// safe because the face's unicode-range covers only the app's own symbols;
// every other character falls straight through to the app's stack.
export const PHONE_SYMBOL_FONT_FAMILY = 'Agent Code Symbols'

export function withPhoneSymbolFont(appFontStack: string): string {
  return `'${PHONE_SYMBOL_FONT_FAMILY}', ${appFontStack}`
}
