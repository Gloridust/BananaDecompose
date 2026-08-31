'use client'

import { useCallback, useMemo, useState } from 'react'
import Stage from './Stage'
import { Inspector, LayerList, Section } from './Panels'
import { MetricRow } from './Metrics'
import { download, downloadJson, downloadSvg, sceneToPng } from '@/lib/export'
import type { Layer, RunMetrics, Scene } from '@/lib/types'

/**
 * The layer editor, opened from a scene node on the board. Editing stays the
 * point of the whole demo — the board shows how each result was produced, this
 * is where you prove the result is actually editable.
 */
export default function SceneEditor({
  title,
  scene,
  metrics,
  onChange,
  onClose,
}: {
  title: string
  scene: Scene
  metrics?: RunMetrics
  onChange: (scene: Scene) => void
  onClose: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showOutlines, setShowOutlines] = useState(true)

  const updateLayer = useCallback(
    (id: string, patch: Partial<Layer>) => {
      onChange({ ...scene, layers: scene.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)) })
    },
    [scene, onChange],
  )

  const reorderLayer = useCallback(
    (id: string, dir: -1 | 1) => {
      const i = scene.layers.findIndex((l) => l.id === id)
      const j = i + dir
      if (i === -1 || j < 0 || j >= scene.layers.length) return
      const layers = [...scene.layers]
      ;[layers[i], layers[j]] = [layers[j], layers[i]]
      onChange({ ...scene, layers })
    },
    [scene, onChange],
  )

  const deleteLayer = useCallback(
    (id: string) => {
      onChange({ ...scene, layers: scene.layers.filter((l) => l.id !== id) })
      setSelectedId((cur) => (cur === id ? null : cur))
    },
    [scene, onChange],
  )

  const selected = useMemo(() => scene.layers.find((l) => l.id === selectedId) ?? null, [scene, selectedId])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-950/95 backdrop-blur-sm">
      <header className="flex shrink-0 items-center gap-3 border-b border-ink-800 px-4 py-2.5">
        <h2 className="font-mono text-xs text-banana-400">{title}</h2>
        <span className="font-mono text-[10px] text-ink-600">
          {scene.layers.length} 层 · 双击文字图层可直接改字
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setShowOutlines((v) => !v)}
          className="rounded border border-ink-700 px-2 py-1 font-mono text-[10px] text-ink-400 hover:text-banana-400"
        >
          {showOutlines ? '隐藏边框' : '显示边框'}
        </button>
        <button onClick={onClose} className="rounded border border-ink-700 px-2.5 py-1 text-[11px] text-ink-200 hover:border-rose-500 hover:text-rose-400">
          关闭
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_300px]">
        <div className="flex min-h-0 min-w-0 flex-col gap-2 p-3">
          <div className="min-h-0 flex-1">
            <Stage scene={scene} selectedId={selectedId} onSelect={setSelectedId} onChange={updateLayer} showOutlines={showOutlines} />
          </div>
          {metrics ? <MetricRow metrics={metrics} /> : null}
        </div>

        <aside className="scrollbar-thin min-h-0 overflow-y-auto border-l border-ink-800">
          <Section title="图层">
            <LayerList
              scene={scene}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onChange={updateLayer}
              onReorder={reorderLayer}
              onDelete={deleteLayer}
            />
          </Section>
          <Section title="属性">
            <Inspector layer={selected} onChange={(patch) => selectedId && updateLayer(selectedId, patch)} />
          </Section>
          <Section title="导出">
            <div className="grid grid-cols-3 gap-1.5">
              <ExportBtn onClick={async () => download(`banana-${Date.now()}.png`, await sceneToPng(scene))}>PNG</ExportBtn>
              <ExportBtn onClick={() => downloadSvg(`banana-${Date.now()}.svg`, scene)}>SVG</ExportBtn>
              <ExportBtn onClick={() => downloadJson(`banana-${Date.now()}.json`, scene)}>JSON</ExportBtn>
            </div>
            <p className="mt-2 text-[10px] leading-snug text-ink-400">
              SVG 里的文字是 <code className="font-mono">&lt;text&gt;</code> 节点，不是描边路径 —— 这是整个 demo 的验收标准。
            </p>
          </Section>
        </aside>
      </div>
    </div>
  )
}

function ExportBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded border border-ink-700 px-2 py-1.5 font-mono text-[10px] text-ink-200 transition hover:border-banana-500 hover:text-banana-400"
    >
      {children}
    </button>
  )
}
