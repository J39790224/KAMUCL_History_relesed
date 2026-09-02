/**
 * 皮肤渲染工具：用 canvas 把 64×64 皮肤 PNG 渲染为 2D 人偶正面图。
 * 含外层 hat/装甲层叠加，最近邻缩放保持像素风；失败返回空字符串由 UI 兜底。
 */

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // textures.minecraft.net 带 CORS *，dataUrl 本地加载，均可安全绘制
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = src
  })
}

/** 部件：[源x, 源y, 宽, 高, 目标x, 目标y]，单位均为皮肤像素 */
type Part = [number, number, number, number, number, number]

/** 人偶画布为 16×32 皮肤像素（头 8 + 躯干 12 + 腿 12；臂 4 + 躯干 8 + 臂 4） */
const BASE_PARTS: Part[] = [
  [8, 8, 8, 8, 4, 0], // 头
  [20, 20, 8, 12, 4, 8], // 躯干
  [44, 20, 4, 12, 0, 8], // 右臂
  [36, 52, 4, 12, 12, 8], // 左臂
  [4, 20, 4, 12, 4, 20], // 右腿
  [20, 52, 4, 12, 8, 20] // 左腿
]

/** 外层（hat / 衣袖 / 裤腿 / 外套），叠加在对应基础层之上 */
const OVERLAY_PARTS: Part[] = [
  [40, 8, 8, 8, 4, 0], // 头外层
  [20, 36, 8, 12, 4, 8], // 躯干外层
  [44, 36, 4, 12, 0, 8], // 右臂外层
  [52, 52, 4, 12, 12, 8], // 左臂外层
  [4, 36, 4, 12, 4, 20], // 右腿外层
  [4, 52, 4, 12, 8, 20] // 左腿外层
]

function drawParts(img: HTMLImageElement, parts: Part[], ctx: CanvasRenderingContext2D, scale: number) {
  for (const [sx, sy, sw, sh, dx, dy] of parts) {
    ctx.drawImage(img, sx, sy, sw, sh, dx * scale, dy * scale, sw * scale, sh * scale)
  }
}

/**
 * 渲染 64×64 皮肤正面人偶，返回 dataURL；失败返回 ''。
 * source 可为 https url（textures.minecraft.net）/ dataUrl / 已加载的 HTMLImageElement。
 */
export async function renderSkinFront(
  source: HTMLImageElement | string,
  scale = 10
): Promise<string> {
  try {
    const img = typeof source === 'string' ? await loadImage(source) : source
    const canvas = document.createElement('canvas')
    canvas.width = 16 * scale
    canvas.height = 32 * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    ctx.imageSmoothingEnabled = false
    drawParts(img, BASE_PARTS, ctx, scale)
    drawParts(img, OVERLAY_PARTS, ctx, scale)
    return canvas.toDataURL('image/png')
  } catch {
    return ''
  }
}

/**
 * 渲染皮肤方块头像：裁头部基础层 (8,8) 8×8 + 外层 hat (40,8) 8×8 叠加，
 * 最近邻放大到 scale，返回 dataURL；失败返回 ''。
 */
export async function renderSkinHead(
  source: HTMLImageElement | string,
  scale = 64
): Promise<string> {
  try {
    const img = typeof source === 'string' ? await loadImage(source) : source
    const canvas = document.createElement('canvas')
    canvas.width = scale
    canvas.height = scale
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(img, 8, 8, 8, 8, 0, 0, scale, scale)
    ctx.drawImage(img, 40, 8, 8, 8, 0, 0, scale, scale)
    return canvas.toDataURL('image/png')
  } catch {
    return ''
  }
}

/**
 * 渲染披风正面外观图，返回 dataURL；失败返回 ''。
 * 标准披风纹理为 64×32，正面区域 (1,1) 10×16；源尺寸比例不同则按 10:16 裁剪中央区域。
 * 最近邻放大到 w×h，保持像素风。
 */
export async function renderCape(
  source: HTMLImageElement | string,
  w = 100,
  h = 160
): Promise<string> {
  try {
    const img = typeof source === 'string' ? await loadImage(source) : source
    const iw = img.naturalWidth || img.width
    const ih = img.naturalHeight || img.height
    if (!iw || !ih) return ''
    let sx = 1
    let sy = 1
    let sw = 10
    let sh = 16
    if (iw !== 64 || ih !== 32) {
      // 非标准尺寸：按 10:16 比例从中央裁剪
      const target = 10 / 16
      if (iw / ih > target) {
        sh = ih
        sw = ih * target
        sx = (iw - sw) / 2
        sy = 0
      } else {
        sw = iw
        sh = iw / target
        sx = 0
        sy = (ih - sh) / 2
      }
    }
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h)
    return canvas.toDataURL('image/png')
  } catch {
    return ''
  }
}
