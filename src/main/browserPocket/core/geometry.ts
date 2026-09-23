// Native element-picker geometry; action geometry is owned by Playwright.
export function sizeFromBoxModel(model: { width?: number; height?: number } | undefined): { width: number; height: number } | null {
  if (!model || typeof model.width !== 'number' || typeof model.height !== 'number') return null
  return { width: model.width, height: model.height }
}
