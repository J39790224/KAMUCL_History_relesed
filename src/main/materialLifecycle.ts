/** 重建 DWM 材质需等原生 WM_SIZE/样式更新结束，不能在同步事件中完成。 */
export function trackMaterialLifecycle(
  window: { on(event: string, listener: () => void): unknown; isDestroyed(): boolean; setBackgroundMaterial(material: 'none' | 'acrylic'): void },
  report: (message: string) => void,
  restoreFrame: () => void = () => {}
): void {
  let pending: ReturnType<typeof setTimeout> | undefined
  const refresh = () => {
    clearTimeout(pending)
    pending = setTimeout(() => {
      if (window.isDestroyed()) return
      try {
        window.setBackgroundMaterial('none')
        window.setBackgroundMaterial('acrylic')
        restoreFrame()
      } catch (error) { report(`Desktop acrylic refresh failed: ${String(error)}`) }
    }, 80)
  }
  for (const event of ['maximize', 'unmaximize', 'restore', 'show', 'leave-full-screen']) window.on(event, refresh)
  window.on('closed', () => clearTimeout(pending))
}
