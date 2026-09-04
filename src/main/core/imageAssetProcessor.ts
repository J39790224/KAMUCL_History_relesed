import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import {
  MAX_IMAGE_FILE_BYTES,
  MAX_IMAGE_PIXELS,
  boundedImageSize,
  readImageDimensions,
  validateImageInput,
  type ImageDimensions,
  type ManagedImagePurpose
} from './imageAssetPolicy'

const HEADER_LIMIT = 1024 * 1024

export interface InspectedImage {
  path: string
  bytes: number
  dimensions: ImageDimensions
}

export interface EncodedManagedImage {
  data: Buffer
  extension: '.png' | '.jpg'
  width: number
  height: number
}

function readHeader(filePath: string, size: number): Buffer {
  const length = Math.min(size, HEADER_LIMIT)
  const buffer = Buffer.alloc(length)
  const fd = fs.openSync(filePath, 'r')
  try {
    const read = fs.readSync(fd, buffer, 0, length, 0)
    return buffer.subarray(0, read)
  } finally {
    fs.closeSync(fd)
  }
}

/** 在任何像素解码前校验路径、文件大小、格式头与声明尺寸。 */
export function inspectImageFile(sourcePath: string): InspectedImage {
  const source = fs.realpathSync(path.resolve(sourcePath))
  const stat = fs.statSync(source)
  if (!stat.isFile()) throw new Error('所选路径不是图片文件')
  const dimensions = validateImageInput(
    source,
    stat.size,
    readImageDimensions(readHeader(source, stat.size))
  )
  return { path: source, bytes: stat.size, dimensions }
}

/**
 * 在 libvips 工作线程中完成真实格式校验、EXIF 校正、限像素解码与等比缩放。
 * WebP 会转换为受 Chromium/Electron 跨平台稳定支持的 PNG/JPEG 缓存。
 */
export async function encodeManagedImage(
  sourcePath: string,
  purpose: ManagedImagePurpose
): Promise<EncodedManagedImage> {
  const inspected = inspectImageFile(sourcePath)
  const data = await fs.promises.readFile(inspected.path)
  return encodeManagedImageBuffer(data, inspected.path, purpose)
}

/** Buffer 入口用于把输入固定为一次快照，也便于不依赖文件系统地验证真实编解码。 */
export async function encodeManagedImageBuffer(
  data: Buffer,
  sourceName: string,
  purpose: ManagedImagePurpose
): Promise<EncodedManagedImage> {
  validateImageInput(sourceName, data.length, readImageDimensions(data.subarray(0, HEADER_LIMIT)))
  const decoder = sharp(data, {
    failOn: 'error',
    limitInputPixels: MAX_IMAGE_PIXELS,
    sequentialRead: true,
    pages: 1
  })
  const metadata = await decoder.metadata()
  const extension = path.extname(sourceName).toLowerCase()
  const expectedFormat = extension === '.png'
    ? 'png'
    : ['.jpg', '.jpeg'].includes(extension)
      ? 'jpeg'
      : 'webp'
  if (metadata.format !== expectedFormat) throw new Error('图片扩展名与实际格式不一致')
  if (!metadata.width || !metadata.height) throw new Error('图片没有有效像素')
  validateImageInput(sourceName, data.length, {
    width: metadata.width,
    height: metadata.height
  })

  const swapsAxes = metadata.orientation !== undefined && metadata.orientation >= 5
  const orientedDimensions = swapsAxes
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height }
  const target = boundedImageSize(orientedDimensions, purpose)
  let pipeline = decoder
    .rotate()
    .resize({
      width: target.width,
      height: target.height,
      fit: 'inside',
      withoutEnlargement: true,
      fastShrinkOnLoad: true
    })

  // 保留透明通道；其余图片转 JPEG 并移除 EXIF/XMP，兼顾隐私、磁盘与解码内存。
  const preserveAlpha = metadata.hasAlpha === true
  const outputExtension = preserveAlpha ? '.png' : '.jpg'
  pipeline = preserveAlpha
    ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
    : pipeline.jpeg({ quality: 88, mozjpeg: true })
  const encoded = await pipeline.toBuffer({ resolveWithObject: true })
  if (!encoded.data.length) throw new Error('图片缓存生成失败')
  if (encoded.data.length > MAX_IMAGE_FILE_BYTES) throw new Error('优化后的图片仍超过 32MB')
  return {
    data: encoded.data,
    extension: outputExtension,
    width: encoded.info.width,
    height: encoded.info.height
  }
}
