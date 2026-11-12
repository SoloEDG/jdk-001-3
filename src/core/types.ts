export type CanvasSize = 16 | 32 | 64

export type Pixel = string | null

export type ToolType = 'brush' | 'eraser' | 'bucket' | 'eyedropper' | 'line' | 'select'

export interface SelectionRect {
  x: number
  y: number
  width: number
  height: number
}

/** Row-major snapshot of a rectangle. Independent from the layer it was copied from. */
export interface PixelClipboard {
  width: number
  height: number
  pixels: Pixel[]
  /** Canvas coordinate of the block's top-left corner when it was captured. */
  x: number
  y: number
}

export interface Layer {
  id: string
  name: string
  visible: boolean
  pixels: Pixel[]
}

export interface Frame {
  id: string
  name: string
  layers: Layer[]
}

export interface PixelProject {
  id: string
  name: string
  canvasSize: CanvasSize
  frames: Frame[]
  activeFrameIndex: number
  activeLayerIndex: number
  frameDelayMs: number
  recentColors: string[]
  customColors: string[]
  updatedAt: number
}

export interface EditorPreferences {
  activeColor: string
  activeTool: ToolType
  activeProjectId: string | null
}
