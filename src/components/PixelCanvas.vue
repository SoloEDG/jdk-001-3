<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { rectContains } from '../core/selection'
import type { Pixel } from '../core/types'
import { useEditorStore } from '../editor/useEditorStore'

const store = useEditorStore()

const gridEl = ref<HTMLDivElement | null>(null)
const displaySize = computed(() => {
  const size = store.canvasSize
  const cell = Math.floor(Math.min(512 / size, 24))
  return { size, cell, px: size * cell }
})

function onCellClick(x: number, y: number) {
  if (store.isPlaying) return
  // Marquee gestures are handled by pointer events, not by the click shortcut.
  if (store.prefs.activeTool === 'select') return
  store.onCanvasPointer(x, y)
}

function pointerCell(event: PointerEvent) {
  const el = gridEl.value
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const c = displaySize.value.cell
  // getBoundingClientRect includes the grid border; cells start at the padding edge.
  return {
    x: Math.floor((event.clientX - rect.left - el.clientLeft) / c),
    y: Math.floor((event.clientY - rect.top - el.clientTop) / c),
  }
}

function onGridPointerDown(event: PointerEvent) {
  if (store.isPlaying) return
  if (store.prefs.activeTool !== 'select') return
  const point = pointerCell(event)
  if (!point) return
  if (!inCanvas(point.x, point.y)) return
  event.preventDefault()
  gridEl.value?.setPointerCapture(event.pointerId)
  store.beginSelectionDrag(point.x, point.y)
}

function onGridPointerMove(event: PointerEvent) {
  if (!store.selectionDrag) return
  const point = pointerCell(event)
  if (!point) return
  store.updateSelectionDrag(point.x, point.y)
}

function onGridPointerUp(event: PointerEvent) {
  if (!store.selectionDrag) return
  store.endSelectionDrag()
  if (gridEl.value?.hasPointerCapture(event.pointerId)) {
    gridEl.value.releasePointerCapture(event.pointerId)
  }
}

function inCanvas(x: number, y: number) {
  const size = displaySize.value.size
  return x >= 0 && y >= 0 && x < size && y < size
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

function onKeyDown(event: KeyboardEvent) {
  if (store.prefs.activeTool !== 'select') return
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return
  if (isTypingTarget(event.target)) return

  const key = event.key.toLowerCase()
  if (key === 'c' && store.selection) {
    event.preventDefault()
    store.copySelection()
  } else if (key === 'x' && store.selection) {
    event.preventDefault()
    store.cutSelection()
  } else if (key === 'v' && store.clipboard) {
    event.preventDefault()
    store.pasteSelection()
  }
}

onMounted(() => window.addEventListener('keydown', onKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onKeyDown))

const selectionBoxStyle = computed(() => {
  const selection = store.selection
  if (!selection) return null
  const c = displaySize.value.cell
  return {
    left: `${selection.x * c}px`,
    top: `${selection.y * c}px`,
    width: `${selection.width * c}px`,
    height: `${selection.height * c}px`,
  }
})

/** Origin cells are hidden while a block is being dragged. */
const movingSourceRect = computed(() => {
  const drag = store.selectionDrag
  const selection = store.selection
  if (!drag || drag.mode !== 'move' || !drag.originRect || !selection) return null
  if (selection.x === drag.originRect.x && selection.y === drag.originRect.y) return null
  return drag.originRect
})

const floatingPixels = computed<Pixel[]>(() => {
  const drag = store.selectionDrag
  if (!drag || drag.mode !== 'move' || !drag.snapshot) return []
  return drag.snapshot
})

/** Live preview of the block while it is being dragged. */
const floatingStyle = computed(() => {
  const drag = store.selectionDrag
  const selection = store.selection
  if (!drag || drag.mode !== 'move' || !drag.snapshot || !drag.originRect) return null
  if (!selection) return null
  if (selection.x === drag.originRect.x && selection.y === drag.originRect.y) return null
  const c = displaySize.value.cell
  return {
    left: `${selection.x * c}px`,
    top: `${selection.y * c}px`,
    width: `${drag.snapshotWidth * c}px`,
    height: `${drag.snapshotHeight * c}px`,
    gridTemplateColumns: `repeat(${drag.snapshotWidth}, ${c}px)`,
    gridAutoRows: `${c}px`,
  }
})

function checkerColor(x: number, y: number) {
  return (x + y) % 2 === 0 ? '#2a2d35' : '#24272e'
}

function cellStyle(index: number) {
  const color = store.compositePixels[index]
  const size = displaySize.value.size
  const x = index % size
  const y = Math.floor(index / size)
  const source = movingSourceRect.value
  if (source && rectContains(source, x, y)) {
    return { backgroundColor: checkerColor(x, y) }
  }
  if (color === null || color === undefined) {
    return { backgroundColor: checkerColor(x, y) }
  }
  return { backgroundColor: color }
}

function floatingCellStyle(index: number) {
  const pixels = floatingPixels.value
  const color = pixels[index]
  if (color === null || color === undefined) {
    return { backgroundColor: checkerColor(index, 0) }
  }
  return { backgroundColor: color }
}
</script>

<template>
  <main class="canvas-area">
    <div class="canvas-meta">
      <span>{{ store.canvasSize }}×{{ store.canvasSize }}</span>
      <span v-if="store.isPlaying" class="badge playing">动画预览中</span>
      <span v-else-if="store.previewFrameIndex !== null" class="badge">预览帧</span>
    </div>
    <div
      ref="gridEl"
      class="pixel-grid"
      :style="{
        gridTemplateColumns: `repeat(${displaySize.size}, ${displaySize.cell}px)`,
        width: `${displaySize.px}px`,
        height: `${displaySize.px}px`,
      }"
      @pointerdown="onGridPointerDown"
      @pointermove="onGridPointerMove"
      @pointerup="onGridPointerUp"
      @pointercancel="onGridPointerUp"
    >
      <button
        v-for="(_, index) in store.compositePixels"
        :key="index"
        type="button"
        class="pixel-cell"
        :style="cellStyle(index)"
        :aria-label="`像素 ${index}`"
        @click="onCellClick(index % displaySize.size, Math.floor(index / displaySize.size))"
      />
      <div v-if="floatingStyle" class="selection-floating" :style="floatingStyle">
        <span
          v-for="(_, index) in floatingPixels"
          :key="index"
          class="floating-cell"
          :style="floatingCellStyle(index)"
        />
      </div>
      <div v-if="selectionBoxStyle" class="selection-marquee" :style="selectionBoxStyle" />
    </div>
    <p v-if="store.prefs.activeTool === 'select'" class="canvas-hint">
      拖动框选一块区域；在选区内拖动可整体移动
    </p>
  </main>
</template>
