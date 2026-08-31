'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Layer, Scene } from '@/lib/types'
import { fontStack } from '@/lib/export'

type Drag =
  | { kind: 'move'; id: string; startX: number; startY: number; origin: Layer }
  | { kind: 'resize'; id: string; corner: Corner; startX: number; startY: number; origin: Layer }
  | null

type Corner = 'nw' | 'ne' | 'sw' | 'se'
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

export default function Stage({
  scene,
  selectedId,
  onSelect,
  onChange,
  showOutlines,
}: {
  scene: Scene
  selectedId: string | null
  onSelect: (id: string | null) => void
  onChange: (id: string, patch: Partial<Layer>) => void
  showOutlines: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [drag, setDrag] = useState<Drag>(null)
  const [editingId, setEditingId] = useState<string | null>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const fit = () => {
      const pad = 48
      const availW = host.clientWidth - pad
      const availH = host.clientHeight - pad
      if (availW <= 0 || availH <= 0) return
      setScale(Math.min(1, availW / scene.canvas.width, availH / scene.canvas.height))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(host)
    return () => ro.disconnect()
  }, [scene.canvas.width, scene.canvas.height])

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!drag) return
      const dx = (e.clientX - drag.startX) / scale
      const dy = (e.clientY - drag.startY) / scale

      if (drag.kind === 'move') {
        onChange(drag.id, { x: drag.origin.x + dx, y: drag.origin.y + dy })
        return
      }

      const o = drag.origin
      let { x, y, w, h } = o
      if (drag.corner === 'se') {
        w = Math.max(8, o.w + dx)
        h = Math.max(8, o.h + dy)
      } else if (drag.corner === 'sw') {
        w = Math.max(8, o.w - dx)
        h = Math.max(8, o.h + dy)
        x = o.x + (o.w - w)
      } else if (drag.corner === 'ne') {
        w = Math.max(8, o.w + dx)
        h = Math.max(8, o.h - dy)
        y = o.y + (o.h - h)
      } else {
        w = Math.max(8, o.w - dx)
        h = Math.max(8, o.h - dy)
        x = o.x + (o.w - w)
        y = o.y + (o.h - h)
      }

      const patch: Partial<Layer> = { x, y, w, h }
      // Type scales with its box, the way it would in a real design tool.
      if (o.type === 'text' && o.h > 0) {
        ;(patch as Partial<Extract<Layer, { type: 'text' }>>).fontSize = Math.max(6, o.fontSize * (h / o.h))
      }
      onChange(drag.id, patch)
    },
    [drag, onChange, scale],
  )

  useEffect(() => {
    if (!drag) return
    const up = () => setDrag(null)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', up)
    }
  }, [drag, onPointerMove])

  return (
    <div
      ref={hostRef}
      className="checker relative flex h-full w-full items-center justify-center overflow-hidden rounded-lg border border-ink-800"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onSelect(null)
      }}
    >
      <div
        className="relative shadow-2xl shadow-black/60"
        style={{
          width: scene.canvas.width,
          height: scene.canvas.height,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
          background: scene.canvas.background,
        }}
      >
        {scene.layers.map((layer, index) => {
          if (!layer.visible) return null
          const selected = layer.id === selectedId
          const common: React.CSSProperties = {
            position: 'absolute',
            left: layer.x,
            top: layer.y,
            width: layer.w,
            height: layer.h,
            opacity: layer.opacity,
            transform: layer.rotation ? `rotate(${layer.rotation}deg)` : undefined,
            zIndex: index + 1,
            cursor: layer.locked ? 'default' : 'move',
            outline: selected
              ? `${Math.max(1, 2 / scale)}px solid var(--color-banana-400)`
              : showOutlines
                ? `${Math.max(1, 1 / scale)}px dashed rgba(255,210,74,.35)`
                : undefined,
          }

          const start = (e: React.PointerEvent) => {
            if (layer.locked) return
            e.stopPropagation()
            onSelect(layer.id)
            if (editingId === layer.id) return
            setDrag({ kind: 'move', id: layer.id, startX: e.clientX, startY: e.clientY, origin: layer })
          }

          return (
            <div key={layer.id} style={common} onPointerDown={start} data-layer={layer.id}>
              {/* objectFit 'fill' keeps the stage identical to sceneToPng()'s drawImage. */}
              {layer.type === 'image' ? (
                <img
                  src={layer.src}
                  alt={layer.name}
                  draggable={false}
                  className="pointer-events-none h-full w-full select-none"
                  style={{ objectFit: 'fill' }}
                />
              ) : (
                <div
                  contentEditable={editingId === layer.id}
                  suppressContentEditableWarning
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    setEditingId(layer.id)
                    setTimeout(() => (e.target as HTMLElement).focus(), 0)
                  }}
                  onBlur={(e) => {
                    setEditingId(null)
                    const next = e.currentTarget.innerText.replace(/\n$/, '')
                    if (next !== layer.text) onChange(layer.id, { text: next } as Partial<Layer>)
                  }}
                  style={{
                    width: '100%',
                    height: '100%',
                    color: layer.color,
                    fontFamily: fontStack(layer.fontFamily),
                    fontSize: layer.fontSize,
                    fontWeight: layer.fontWeight,
                    fontStyle: layer.italic ? 'italic' : 'normal',
                    lineHeight: layer.lineHeight,
                    letterSpacing: layer.letterSpacing,
                    textAlign: layer.align,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    cursor: editingId === layer.id ? 'text' : 'move',
                  }}
                >
                  {layer.text}
                </div>
              )}

              {selected && !layer.locked
                ? CORNERS.map((corner) => (
                    <span
                      key={corner}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        setDrag({ kind: 'resize', id: layer.id, corner, startX: e.clientX, startY: e.clientY, origin: layer })
                      }}
                      style={{
                        position: 'absolute',
                        width: 12 / scale,
                        height: 12 / scale,
                        background: 'var(--color-banana-400)',
                        border: `${1 / scale}px solid #000`,
                        borderRadius: 2 / scale,
                        left: corner.includes('w') ? -6 / scale : undefined,
                        right: corner.includes('e') ? -6 / scale : undefined,
                        top: corner.includes('n') ? -6 / scale : undefined,
                        bottom: corner.includes('s') ? -6 / scale : undefined,
                        cursor: `${corner}-resize`,
                      }}
                    />
                  ))
                : null}
            </div>
          )
        })}
      </div>

      <div className="pointer-events-none absolute bottom-2 right-3 font-mono text-[10px] text-ink-400">
        {scene.canvas.width}×{scene.canvas.height} · {Math.round(scale * 100)}%
      </div>
    </div>
  )
}
