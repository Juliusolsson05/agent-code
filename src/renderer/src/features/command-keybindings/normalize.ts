// Renderer and Electron's native extension input gate must use one grammar.
// Duplicating Option/physical-code normalization made customized chords diverge
// across documents; this compatibility export keeps existing imports stable.
export * from '@shared/keybindings'
