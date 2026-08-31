'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { KIND_COLOR, KIND_LABEL, edgePath, layout, visibleNodes } from '@/lib/board'
import type { Board, BoardNode } from '@/lib/types'

export default function BoardCanvas({
  board,
  hiddenBranches,
  hiddenNodes,
  onToggleNode,
  selectedNodeId,
  onSelectNode,
  onOpenScene,
}: {
  board: Board
  hiddenBranches: Set<string>
  hiddenNodes: Set<string>
  onToggleNode: (id: string) => void
  selectedNodeId: string | null
  onSelectNode: (id: string | null) => void
  onOpenScene: (node: BoardNode) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const [panning, setPanning] = useState<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const [fitted, setFitted] = useState<string | null>(null)

  const branchOrder = useMemo(() => board.branches.map((b) => b.id), [board.branches])
  const shown = useMemo(() => visibleNodes(board, hiddenBranches, hiddenNodes), [board, hiddenBranches, hiddenNodes])
  const l = useMemo(() => layout(shown, branchOrder), [shown, branchOrder])

  /** Returns false when the host has not been measured yet — on that pass the
   *  available space is negative, which would otherwise mirror the whole canvas. */
  const fit = useCallback(() => {
    const host = hostRef.current
    if (!host || !l.width || !l.height) return false
    const pad = 56
    const availW = host.clientWidth - pad
    const availH = host.clientHeight - pad
    if (availW <= 0 || availH <= 0) return false

    const k = Math.max(0.05, Math.min(1.15, availW / l.width, availH / l.height))
    setView({ k, x: (host.clientWidth - l.width * k) / 2, y: (host.clientHeight - l.height * k) / 2 })
    return true
  }, [l.width, l.height])

  // Auto-fit once per board, then leave the viewport under the user's control.
  // Retried on resize because the first pass can land before the host has a size.
  useLayoutEffect(() => {
    if (fitted === board.id || !l.width) return
    if (fit()) setFitted(board.id)
  }, [board.id, fitted, fit, l.width])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(() => {
      if (fitted !== board.id && fit()) setFitted(board.id)
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [board.id, fitted, fit])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()

      // Trackpad convention, the same one Figma and tldraw use: a two-finger
      // drag arrives as a plain wheel event and pans, while a pinch arrives with
      // ctrlKey synthesised by the browser and zooms. Cmd+wheel zooms too, for
      // anyone on a mouse.
      if (!e.ctrlKey && !e.metaKey) {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
        return
      }

      const rect = host.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      // Pinch deltas are far coarser than a wheel notch, so they need a gentler factor.
      const factor = e.ctrlKey ? 0.01 : 0.0016
      setView((v) => {
        const k = Math.min(2.5, Math.max(0.08, v.k * Math.exp(-e.deltaY * factor)))
        // Keep the point under the cursor fixed while zooming.
        return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k }
      })
    }

    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    if (!panning) return
    const move = (e: PointerEvent) =>
      setView((v) => ({ ...v, x: panning.vx + (e.clientX - panning.x), y: panning.vy + (e.clientY - panning.y) }))
    const up = () => setPanning(null)

    // A drag across cards would otherwise start a text selection, which both
    // looks broken and steals the subsequent pointer events.
    const prevSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      document.body.style.userSelect = prevSelect
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [panning])

  const edges = useMemo(() => {
    const out: { d: string; key: string; dim: boolean }[] = []
    for (const p of l.placed) {
      for (const input of p.node.inputs) {
        const from = l.byId.get(input)
        if (!from) continue
        out.push({
          d: edgePath(from, p),
          key: `${input}->${p.node.id}`,
          dim: selectedNodeId !== null && selectedNodeId !== p.node.id && selectedNodeId !== input,
        })
      }
    }
    return out
  }, [l, selectedNodeId])

  return (
    <div
      ref={hostRef}
      className="relative h-full w-full overflow-hidden rounded-lg border border-ink-800 bg-ink-950"
      style={{
        backgroundImage: 'radial-gradient(circle, #23232c 1px, transparent 1px)',
        backgroundSize: `${24 * view.k}px ${24 * view.k}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
        cursor: panning ? 'grabbing' : 'grab',
        // Let the wheel handler own every gesture; the browser's own pan/zoom
        // would fight it on a trackpad.
        touchAction: 'none',
        overscrollBehavior: 'contain',
      }}
      onPointerDown={(e) => {
        // Middle-drag pans from anywhere, the way it does in every canvas tool.
        const fromBackground = e.target === e.currentTarget
        if (!fromBackground && e.button !== 1) return
        if (fromBackground) onSelectNode(null)
        setPanning({ x: e.clientX, y: e.clientY, vx: view.x, vy: view.y })
      }}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
      >
        <svg
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
          width={Math.max(1, l.width)}
          height={Math.max(1, l.height)}
        >
          {edges.map((e) => (
            <path
              key={e.key}
              d={e.d}
              fill="none"
              stroke={e.dim ? '#2a2a34' : '#4a4a5c'}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          ))}
        </svg>

        {l.placed.map((p) => (
          <NodeCard
            key={p.node.id}
            node={p.node}
            x={p.x}
            y={p.y}
            w={p.w}
            h={p.h}
            selected={selectedNodeId === p.node.id}
            dimmed={selectedNodeId !== null && selectedNodeId !== p.node.id}
            onSelect={() => onSelectNode(p.node.id)}
            onHide={() => onToggleNode(p.node.id)}
            onOpenScene={() => onOpenScene(p.node)}
          />
        ))}
      </div>

      {!shown.length ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="max-w-sm px-6 text-center text-xs leading-relaxed text-ink-400">
            画布是空的。左边写提示词跑一次，或者直接一键评测 —— 每条分支的每个中间产物都会作为节点落到这张画布上。
          </p>
        </div>
      ) : null}

      <div className="pointer-events-none absolute bottom-2 left-2 select-none font-mono text-[9px] leading-relaxed text-ink-700">
        双指拖动平移 · 双指捏合或 ⌘+滚轮缩放 · 拖空白处也可平移
      </div>

      <div className="absolute bottom-2 right-2 flex select-none items-center gap-1">
        <button onClick={fit} className="rounded border border-ink-700 bg-ink-900/90 px-2 py-1 font-mono text-[10px] text-ink-400 hover:text-banana-400">
          适应画布
        </button>
        <span className="rounded border border-ink-800 bg-ink-900/90 px-2 py-1 font-mono text-[10px] tabular-nums text-ink-600">
          {Math.round(view.k * 100)}%
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- card

const STATUS_RING: Record<BoardNode['status'], string> = {
  running: 'border-banana-500 animate-pulse',
  ok: 'border-ink-700',
  error: 'border-rose-500/70',
  skipped: 'border-ink-800',
}

function NodeCard({
  node,
  x,
  y,
  w,
  h,
  selected,
  dimmed,
  onSelect,
  onHide,
  onOpenScene,
}: {
  node: BoardNode
  x: number
  y: number
  w: number
  h: number
  selected: boolean
  dimmed: boolean
  onSelect: () => void
  onHide: () => void
  onOpenScene: () => void
}) {
  const accent = KIND_COLOR[node.kind]
  const isScene = node.kind === 'scene'

  return (
    <article
      onPointerDown={(e) => {
        e.stopPropagation()
        onSelect()
      }}
      className={`absolute select-none overflow-hidden rounded-lg border bg-ink-900 transition-opacity ${
        selected ? 'border-banana-400 ring-1 ring-banana-400/40' : STATUS_RING[node.status]
      } ${dimmed ? 'opacity-45' : 'opacity-100'}`}
      style={{ left: x, top: y, width: w, height: h }}
    >
      <header className="flex items-center gap-1.5 border-b border-ink-800 px-2 py-1" style={{ borderTopColor: accent }}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: accent }} />
        <span className="truncate font-mono text-[9px] uppercase tracking-wide" style={{ color: accent }}>
          {KIND_LABEL[node.kind]}
        </span>
        {node.branches.length > 1 ? (
          <span className="shrink-0 rounded bg-ink-800 px-1 font-mono text-[8px] text-ink-400" title={`被 ${node.branches.length} 条分支共用`}>
            共享 ×{node.branches.length}
          </span>
        ) : null}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onHide()
          }}
          title="从画布上隐藏"
          className="ml-auto shrink-0 px-0.5 font-mono text-[10px] text-ink-600 hover:text-rose-400"
        >
          ✕
        </button>
      </header>

      <div className="flex h-[calc(100%-24px)] flex-col px-2 py-1.5">
        <p className="truncate text-[10px] text-ink-200" title={node.label}>
          {node.label}
        </p>
        {node.detail ? (
          <p className="mt-0.5 line-clamp-2 text-[9px] leading-snug text-ink-400" title={node.detail}>
            {node.detail}
          </p>
        ) : null}
        {node.error ? (
          // A finished node carrying a message is reporting a degradation, not a
          // failure — amber, so a real error stays visually distinct.
          <p
            className={`mt-0.5 line-clamp-3 text-[9px] leading-snug ${
              node.status === 'ok' ? 'text-amber-400' : 'text-rose-400'
            }`}
            title={node.error}
          >
            {node.status === 'ok' ? '⚠ ' : ''}
            {node.error}
          </p>
        ) : null}

        <div className="mt-1.5 min-h-0 flex-1">
          {isScene && node.scene ? (
            <ScenePreview node={node} onOpen={onOpenScene} />
          ) : node.images?.length ? (
            <ImageStrip images={node.images} />
          ) : node.summary ? (
            <p className="scrollbar-thin h-full overflow-y-auto whitespace-pre-line text-[9px] leading-relaxed text-ink-400">
              {node.summary}
            </p>
          ) : node.status === 'running' ? (
            <div className="checker h-full rounded border border-ink-800" />
          ) : null}
        </div>

        {(node.ms != null || node.cost) && !isScene ? (
          <p className="mt-1 shrink-0 font-mono text-[8px] tabular-nums text-ink-600">
            {node.ms != null ? `${(node.ms / 1000).toFixed(1)}s` : ''}
            {node.cost ? ` · $${node.cost.toFixed(4)}` : ''}
          </p>
        ) : null}
      </div>
    </article>
  )
}

function ImageStrip({ images }: { images: { label: string; src: string }[] }) {
  if (images.length === 1) {
    return (
      <div className="checker h-full overflow-hidden rounded border border-ink-800">
        <img src={images[0].src} alt={images[0].label} className="h-full w-full object-contain" />
      </div>
    )
  }
  return (
    <div className="scrollbar-thin flex h-full gap-1 overflow-x-auto">
      {images.map((img, i) => (
        <div key={i} className="checker h-full shrink-0 overflow-hidden rounded border border-ink-800" style={{ width: 56 }} title={img.label}>
          <img src={img.src} alt={img.label} className="h-full w-full object-contain" />
        </div>
      ))}
    </div>
  )
}

function ScenePreview({ node, onOpen }: { node: BoardNode; onOpen: () => void }) {
  const scene = node.scene!
  const preview = node.images?.[0]?.src

  return (
    <div className="flex h-full flex-col gap-1">
      {node.ms != null ? (
        <p className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-banana-400" title="这条路径从分支开始到成品的墙钟耗时">
          ⏱ {(node.ms / 1000).toFixed(1)}s
        </p>
      ) : null}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
        className="checker group relative min-h-0 flex-1 overflow-hidden rounded border border-ink-800 hover:border-banana-500"
        title="打开图层编辑器"
      >
        {preview ? <img src={preview} alt="" className="h-full w-full object-contain" /> : null}
        <span className="absolute inset-0 flex items-center justify-center bg-ink-950/70 text-[9px] text-banana-400 opacity-0 transition group-hover:opacity-100">
          打开图层编辑器
        </span>
      </button>
      <p className="shrink-0 font-mono text-[8px] text-ink-600">
        {scene.layers.length} 层 · {scene.layers.filter((x) => x.type === 'text').length} 文字
        {node.metrics?.liveText ? ' · 未入像素' : node.metrics ? ' · OCR 回收' : ''}
      </p>
    </div>
  )
}
