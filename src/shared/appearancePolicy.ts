import type { BackgroundSettings, LaunchThumbnailSettings } from './types'

export const MAX_CAROUSEL_IMAGES = 20
/** `images` is authoritative, including []; old single-image settings remain readable. */
export function carouselImages(thumbnail?: Partial<LaunchThumbnailSettings>): string[] {
  const values = Array.isArray(thumbnail?.images) ? thumbnail.images : [thumbnail?.image]
  return [...new Set(values.filter((s): s is string => typeof s === 'string' && !!s.trim()))].slice(0, MAX_CAROUSEL_IMAGES)
}

export function backgroundImageEffect(bg: Pick<BackgroundSettings, 'opacity' | 'blur'>) {
  const opacity = Math.max(0, Math.min(1, Number.isFinite(bg.opacity) ? bg.opacity : .5))
  const blur = Math.max(0, Math.min(40, Number.isFinite(bg.blur) ? bg.blur : 0))
  return { opacity: String(opacity), filter: blur > 0 ? `blur(${blur}px)` : 'none' }
}
