import { getPixel, inBounds, indexFor } from './pixelGrid'
import type { Pixel, PixelClipboard, SelectionRect } from './types'

export interface PixelBlock {
  width: number
  height: number
  pixels: Pixel[]
}

/** Build a rect from two inclusive corners, regardless of drag direction. */
export function normalizeRect(x0: number, y0: number, x1: number, y1: number): SelectionRect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0) + 1,
    height: Math.abs(y1 - y0) + 1,
  }
}

export function rectContains(rect: SelectionRect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height
}

export function rectsEqual(a: SelectionRect | null, b: SelectionRect | null): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** Shift a rect so it stays fully on the canvas, keeping its size when possible. */
export function clampRectPosition(rect: SelectionRect, size: number): SelectionRect | null {
  const width = Math.min(rect.width, size)
  const height = Math.min(rect.height, size)
  if (width <= 0 || height <= 0) return null
  return {
    x: Math.max(0, Math.min(rect.x, size - width)),
    y: Math.max(0, Math.min(rect.y, size - height)),
    width,
    height,
  }
}

/** Snapshot a rectangle of pixels. Later edits to the source layer cannot touch it. */
export function copyPixels(pixels: Pixel[], size: number, rect: SelectionRect): PixelClipboard {
  const snapshot: Pixel[] = []
  for (let dy = 0; dy < rect.height; dy++) {
    for (let dx = 0; dx < rect.width; dx++) {
      const x = rect.x + dx
      const y = rect.y + dy
      snapshot.push(inBounds(x, y, size) ? getPixel(pixels, x, y, size) : null)
    }
  }
  return {
    width: rect.width,
    height: rect.height,
    pixels: snapshot,
    x: rect.x,
    y: rect.y,
  }
}

/** Clear every cell inside a rectangle (cut / move source). */
export function clearRect(pixels: Pixel[], size: number, rect: SelectionRect): Pixel[] {
  const next = pixels.slice()
  for (let dy = 0; dy < rect.height; dy++) {
    for (let dx = 0; dx < rect.width; dx++) {
      const x = rect.x + dx
      const y = rect.y + dy
      if (inBounds(x, y, size)) next[indexFor(x, y, size)] = null
    }
  }
  return next
}

/**
 * Stamp a pixel block onto a layer at (destX, destY).
 * Cells outside the canvas are dropped; null cells stay transparent (they overwrite).
 */
export function stampBlock(
  pixels: Pixel[],
  size: number,
  block: PixelBlock,
  destX: number,
  destY: number,
): Pixel[] {
  const next = pixels.slice()
  for (let dy = 0; dy < block.height; dy++) {
    for (let dx = 0; dx < block.width; dx++) {
      const x = destX + dx
      const y = destY + dy
      if (!inBounds(x, y, size)) continue
      const value = block.pixels[dy * block.width + dx]
      next[indexFor(x, y, size)] = value === undefined ? null : value
    }
  }
  return next
}

/** Paste a clipboard snapshot. Defaults to the position where it was captured. */
export function pasteClipboard(
  pixels: Pixel[],
  size: number,
  clipboard: PixelClipboard,
  destX = clipboard.x,
  destY = clipboard.y,
): Pixel[] {
  return stampBlock(pixels, size, clipboard, destX, destY)
}

/** The on-canvas intersection of a block placed at (destX, destY), or null when fully outside. */
export function blockCanvasRect(
  block: PixelBlock,
  destX: number,
  destY: number,
  size: number,
): SelectionRect | null {
  const x0 = Math.max(0, destX)
  const y0 = Math.max(0, destY)
  const x1 = Math.min(size, destX + block.width)
  const y1 = Math.min(size, destY + block.height)
  if (x1 <= x0 || y1 <= y0) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}
