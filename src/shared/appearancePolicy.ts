import type { BackgroundSettings, LaunchThumbnailSettings } from './types'

export const MAX_CAROUSEL_IMAGES = 20
export function carouselDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(120, value)) : 6.5
}
export function carouselTiming(settings: Partial<LaunchThumbnailSettings>) {
  const allowed = new Set(carouselImages(settings))
  return { intervalSeconds: carouselDuration(settings.intervalSeconds), durations: Object.fromEntries(Object.entries(settings.durations ?? {}).filter(([image]) => allowed.has(image)).map(([image, value]) => [image, carouselDuration(value)])) }
}
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
