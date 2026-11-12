import { computed, reactive, ref, watch } from 'vue'
import { CANVAS_SIZES } from '../core/constants'
import { exportAllFramesPng, exportFramePng } from '../core/exportPng'
import { addCustomColor, pushRecentColor } from '../core/paletteService'
import { compositeLayers } from '../core/pixelGrid'
import { createProject } from '../core/projectFactory'
import {
  blockCanvasRect,
  clampRectPosition,
  clearRect,
  copyPixels,
  normalizeRect,
  pasteClipboard as stampClipboard,
  rectContains,
  rectsEqual,
  stampBlock,
} from '../core/selection'
import {
  ensureDefaultProject,
  loadPreferences,
  loadProjects,
  removeProject,
  savePreferences,
  saveProjects,
  upsertProject,
} from '../core/storage'
import type {
  CanvasSize,
  Pixel,
  PixelClipboard,
  PixelProject,
  SelectionRect,
  ToolType,
} from '../core/types'
import { createAnimationPlayer } from './animationPlayer'
import {
  addFrameToProject,
  addLayerToActiveFrame,
  deleteFrameAt,
  deleteLayerAt,
  toggleLayerVisibility,
  withActiveLayer,
  withCanvasSize,
  withFrameLayers,
} from './projectCommands'
import { applyToolAt, cancelLineTool, type LinePending } from './toolController'

const projects = ref<PixelProject[]>(ensureDefaultProject(loadProjects()))
const prefs = reactive(loadPreferences())

const linePending = ref<LinePending | null>(null)
const selection = ref<SelectionRect | null>(null)
const clipboard = ref<PixelClipboard | null>(null)
const selectionDrag = ref<SelectionDragState | null>(null)
const isPlaying = ref(false)
const previewFrameIndex = ref<number | null>(null)

interface SelectionDragState {
  mode: 'new' | 'move'
  anchorX: number
  anchorY: number
  startX: number
  startY: number
  originRect: SelectionRect | null
  snapshot: Pixel[] | null
  snapshotWidth: number
  snapshotHeight: number
}

const player = createAnimationPlayer({ isPlaying, previewFrameIndex })

function persistProjects() {
  saveProjects(projects.value)
}

function persistPrefs() {
  savePreferences({ ...prefs })
}

const activeProject = computed(() => {
  const id = prefs.activeProjectId
  const found = projects.value.find((p) => p.id === id)
  return found ?? projects.value[0] ?? null
})

function syncActiveProjectId() {
  if (!activeProject.value && projects.value[0]) {
    prefs.activeProjectId = projects.value[0].id
    persistPrefs()
  } else if (activeProject.value && prefs.activeProjectId !== activeProject.value.id) {
    prefs.activeProjectId = activeProject.value.id
    persistPrefs()
  }
}

syncActiveProjectId()

function mutateProject(mutator: (p: PixelProject) => PixelProject) {
  const current = activeProject.value
  if (!current) return
  const updated = { ...mutator(current), updatedAt: Date.now() }
  projects.value = upsertProject(projects.value, updated)
  persistProjects()
}

const canvasSize = computed(() => activeProject.value?.canvasSize ?? 16)

const activeFrame = computed(() => {
  const p = activeProject.value
  if (!p) return null
  const idx = previewFrameIndex.value ?? p.activeFrameIndex
  return p.frames[idx] ?? null
})

const compositePixels = computed(() => {
  const frame = activeFrame.value
  if (!frame) return []
  return compositeLayers(frame.layers, canvasSize.value)
})

watch(
  () => prefs.activeProjectId,
  () => {
    linePending.value = null
    clearSelection()
    player.stop()
  },
)

function clearSelection() {
  selection.value = null
  selectionDrag.value = null
}

/** Begin a marquee drag: inside an existing selection it moves the block, elsewhere it starts a new one. */
function beginSelectionDrag(x: number, y: number) {
  const p = activeProject.value
  const frame = activeFrame.value
  if (!p || !frame || previewFrameIndex.value !== null) return
  if (x < 0 || y < 0 || x >= p.canvasSize || y >= p.canvasSize) return

  linePending.value = null
  const existing = selection.value
  const layer = frame.layers[p.activeLayerIndex]

  if (existing && rectContains(existing, x, y) && layer) {
    const snapshot = copyPixels(layer.pixels, p.canvasSize, existing)
    selectionDrag.value = {
      mode: 'move',
      anchorX: x,
      anchorY: y,
      startX: x,
      startY: y,
      originRect: { ...existing },
      snapshot: snapshot.pixels,
      snapshotWidth: snapshot.width,
      snapshotHeight: snapshot.height,
    }
    return
  }

  selection.value = { x, y, width: 1, height: 1 }
  selectionDrag.value = {
    mode: 'new',
    anchorX: x,
    anchorY: y,
    startX: x,
    startY: y,
    originRect: null,
    snapshot: null,
    snapshotWidth: 0,
    snapshotHeight: 0,
  }
}

function updateSelectionDrag(x: number, y: number) {
  const drag = selectionDrag.value
  if (!drag) return
  const size = canvasSize.value

  if (drag.mode === 'new') {
    const cx = Math.max(0, Math.min(x, size - 1))
    const cy = Math.max(0, Math.min(y, size - 1))
    selection.value = normalizeRect(drag.anchorX, drag.anchorY, cx, cy)
    return
  }

  if (!drag.originRect) return
  const target = clampRectPosition(
    {
      x: drag.originRect.x + (x - drag.startX),
      y: drag.originRect.y + (y - drag.startY),
      width: drag.originRect.width,
      height: drag.originRect.height,
    },
    size,
  )
  if (target) selection.value = target
}

/** Finish a drag. A moved block is written to the active layer of the active frame. */
function endSelectionDrag() {
  const drag = selectionDrag.value
  selectionDrag.value = null
  if (!drag || drag.mode !== 'move' || !drag.originRect || !drag.snapshot) return

  const target = selection.value
  if (!target || rectsEqual(target, drag.originRect)) return

  const p = activeProject.value
  const frame = activeFrame.value
  if (!p || !frame || previewFrameIndex.value !== null) return

  const origin = drag.originRect
  const snapshot = drag.snapshot
  const snapshotWidth = drag.snapshotWidth
  const snapshotHeight = drag.snapshotHeight

  mutateProject((proj) => {
    const fr = proj.frames[proj.activeFrameIndex]
    const active = fr?.layers[proj.activeLayerIndex]
    if (!fr || !active) return proj
    const cleared = clearRect(active.pixels, proj.canvasSize, origin)
    const moved = stampBlock(
      cleared,
      proj.canvasSize,
      { width: snapshotWidth, height: snapshotHeight, pixels: snapshot },
      target.x,
      target.y,
    )
    const layers = fr.layers.map((l, i) =>
      i === proj.activeLayerIndex ? { ...l, pixels: moved } : l,
    )
    return withFrameLayers(proj, proj.activeFrameIndex, layers)
  })
}

/** Snapshot the selected block from the active layer. Source pixels stay untouched. */
function copySelection() {
  const p = activeProject.value
  const frame = activeFrame.value
  const current = selection.value
  if (!p || !frame || !current) return
  const layer = frame.layers[p.activeLayerIndex]
  if (!layer) return
  clipboard.value = copyPixels(layer.pixels, p.canvasSize, current)
}

/** Snapshot the selected block and clear it from the active layer. */
function cutSelection() {
  const p = activeProject.value
  const frame = activeFrame.value
  const current = selection.value
  if (!p || !frame || !current || previewFrameIndex.value !== null) return
  const layer = frame.layers[p.activeLayerIndex]
  if (!layer) return

  clipboard.value = copyPixels(layer.pixels, p.canvasSize, current)
  mutateProject((proj) => {
    const fr = proj.frames[proj.activeFrameIndex]
    const active = fr?.layers[proj.activeLayerIndex]
    if (!fr || !active) return proj
    const layers = fr.layers.map((l, i) =>
      i === proj.activeLayerIndex
        ? { ...l, pixels: clearRect(l.pixels, proj.canvasSize, current) }
        : l,
    )
    return withFrameLayers(proj, proj.activeFrameIndex, layers)
  })
}

/**
 * Paste the clipboard snapshot onto the active layer of the current frame.
 * A live selection provides the destination position, otherwise the snapshot's origin is used.
 * Out-of-canvas cells are clipped and transparent cells stay transparent.
 */
function pasteSelection() {
  const p = activeProject.value
  const frame = activeFrame.value
  const clip = clipboard.value
  if (!p || !frame || !clip || previewFrameIndex.value !== null) return

  const destX = selection.value ? selection.value.x : clip.x
  const destY = selection.value ? selection.value.y : clip.y
  const pastedRect = blockCanvasRect(clip, destX, destY, p.canvasSize)

  mutateProject((proj) => {
    const fr = proj.frames[proj.activeFrameIndex]
    const active = fr?.layers[proj.activeLayerIndex]
    if (!fr || !active) return proj
    const layers = fr.layers.map((l, i) =>
      i === proj.activeLayerIndex
        ? { ...l, pixels: stampClipboard(l.pixels, proj.canvasSize, clip, destX, destY) }
        : l,
    )
    return withFrameLayers(proj, proj.activeFrameIndex, layers)
  })

  selection.value = pastedRect
}

function recordColorUse(color: string) {
  mutateProject((p) => ({
    ...p,
    recentColors: pushRecentColor(p.recentColors, color),
  }))
}

function setActiveColor(color: string) {
  prefs.activeColor = color
  persistPrefs()
  recordColorUse(color)
}

function setTool(tool: ToolType) {
  if (prefs.activeTool !== tool) clearSelection()
  prefs.activeTool = tool
  if (tool !== 'line') linePending.value = null
  persistPrefs()
}

function setCanvasSize(size: CanvasSize) {
  if (!CANVAS_SIZES.includes(size)) return
  clearSelection()
  mutateProject((p) => withCanvasSize(p, size))
}

function onCanvasPointer(x: number, y: number) {
  const p = activeProject.value
  const frame = activeFrame.value
  if (!p || !frame || previewFrameIndex.value !== null) return

  const result = applyToolAt(
    {
      size: p.canvasSize,
      layers: frame.layers,
      activeLayerIndex: p.activeLayerIndex,
      activeColor: prefs.activeColor,
      tool: prefs.activeTool,
      linePending: linePending.value,
    },
    x,
    y,
  )
  if (!result.consumed) return

  linePending.value = result.linePending
  if (result.activeColor) setActiveColor(result.activeColor)

  if (result.layers !== frame.layers) {
    mutateProject((proj) =>
      withFrameLayers(proj, proj.activeFrameIndex, result.layers),
    )
    if (prefs.activeTool === 'brush' || prefs.activeTool === 'bucket' || prefs.activeTool === 'line') {
      recordColorUse(prefs.activeColor)
    }
  }
}

function setActiveLayer(index: number) {
  mutateProject((p) => withActiveLayer(p, index))
}

function toggleLayerVisible(index: number) {
  mutateProject((p) => toggleLayerVisibility(p, index))
}

function deleteLayer(index: number) {
  mutateProject((p) => deleteLayerAt(p, index))
}

function addLayer() {
  mutateProject((p) => addLayerToActiveFrame(p) ?? p)
}

function setActiveFrame(index: number) {
  previewFrameIndex.value = null
  clearSelection()
  mutateProject((p) => ({ ...p, activeFrameIndex: index }))
  linePending.value = cancelLineTool()
}

function addFrame() {
  clearSelection()
  mutateProject((p) => addFrameToProject(p) ?? p)
}

function deleteFrame(index: number) {
  clearSelection()
  mutateProject((p) => deleteFrameAt(p, index))
}

function setFrameDelay(ms: number) {
  const clamped = Math.max(50, Math.min(5000, Math.round(ms)))
  mutateProject((p) => ({ ...p, frameDelayMs: clamped }))
}

function togglePlayback() {
  clearSelection()
  player.toggle(activeProject.value)
}

watch(
  () => activeProject.value?.frameDelayMs,
  (delay) => {
    if (!isPlaying.value || delay === undefined) return
    player.stop()
    player.toggle(activeProject.value)
  },
)

function saveCurrentProject() {
  const p = activeProject.value
  if (!p) return
  projects.value = upsertProject(projects.value, { ...p, updatedAt: Date.now() })
  persistProjects()
}

function createNewProject(name?: string) {
  const project = createProject(name?.trim() || `项目 ${projects.value.length + 1}`)
  projects.value = [...projects.value, project]
  prefs.activeProjectId = project.id
  persistProjects()
  persistPrefs()
  linePending.value = null
  clearSelection()
  player.stop()
}

function loadProject(id: string) {
  prefs.activeProjectId = id
  persistPrefs()
  linePending.value = null
  clearSelection()
  player.stop()
}

function deleteProject(id: string) {
  projects.value = removeProject(projects.value, id)
  if (projects.value.length === 0) {
    const fallback = createProject('未命名项目')
    projects.value = [fallback]
    prefs.activeProjectId = fallback.id
  } else if (prefs.activeProjectId === id) {
    prefs.activeProjectId = projects.value[0]!.id
  }
  persistProjects()
  persistPrefs()
  clearSelection()
  player.stop()
}

function addCustomPaletteColor(color: string) {
  mutateProject((p) => ({
    ...p,
    customColors: addCustomColor(p.customColors, color),
  }))
  setActiveColor(color)
}

function exportCurrentFrame() {
  const p = activeProject.value
  const frame = activeFrame.value
  if (!p || !frame) return
  exportFramePng(frame, p.canvasSize, `${p.name}_当前帧.png`)
}

function exportAllFrames() {
  const p = activeProject.value
  if (!p) return
  exportAllFramesPng(p.frames, p.canvasSize, p.name)
}

let editorStore: ReturnType<typeof buildEditorStore> | null = null

function buildEditorStore() {
  return reactive({
    projects,
    prefs,
    activeProject,
    canvasSize,
    activeFrame,
    compositePixels,
    linePending,
    selection,
    clipboard,
    selectionDrag,
    isPlaying,
    previewFrameIndex,
    setActiveColor,
    setTool,
    setCanvasSize,
    onCanvasPointer,
    beginSelectionDrag,
    updateSelectionDrag,
    endSelectionDrag,
    clearSelection,
    copySelection,
    cutSelection,
    pasteSelection,
    setActiveLayer,
    toggleLayerVisible,
    deleteLayer,
    addLayer,
    setActiveFrame,
    addFrame,
    deleteFrame,
    setFrameDelay,
    togglePlayback,
    stopPlayback: player.stop,
    saveCurrentProject,
    createNewProject,
    loadProject,
    deleteProject,
    addCustomPaletteColor,
    exportCurrentFrame,
    exportAllFrames,
  })
}

export function useEditorStore() {
  if (!editorStore) editorStore = buildEditorStore()
  return editorStore
}
