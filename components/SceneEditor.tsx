'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import Stage, { type Region } from './Stage'
import { Inspector, LayerList, Section } from './Panels'
import { MetricRow } from './Metrics'
import { download, downloadJson, downloadSvg, sceneToPng } from '@/lib/export'
import { retypeLayer } from '@/lib/retype'
import { editLayer, editRegion } from '@/lib/edit-region'
import type { ImageLayer, Layer, RunMetrics, Scene } from '@/lib/types'

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
  const [marquee, setMarquee] = useState(false)
  const [region, setRegion] = useState<Region | null>(null)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const promptRef = useRef<HTMLInputElement>(null)

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

  const applyRegionEdit = useCallback(async () => {
    if (!region || !instruction.trim()) return
    setBusy(true)
    setEditError(null)
    try {
      const { layer } = await editRegion(scene, region, instruction.trim())
      // The patch lands as its own layer: an edit you cannot switch off or move
      // afterwards is not an edit in a layered file, it is a commit.
      onChange({ ...scene, layers: [...scene.layers, layer] })
      setSelectedId(layer.id)
      setRegion(null)
      setInstruction('')
      setMarquee(false)
    } catch (err) {
      setEditError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [region, instruction, scene, onChange])

  const handleLayerEdit = useCallback(
    async (layer: ImageLayer, text: string) => {
      const { src } = await editLayer(layer, text)
      updateLayer(layer.id, { src, provenance: `AI 改写 · 「${text}」` } as Partial<Layer>)
    },
    [updateLayer],
  )

  const handleRetype = useCallback(
    async (layer: ImageLayer, text: string) => {
      const next = await retypeLayer(layer, text)
      updateLayer(layer.id, {
        src: next.src,
        x: next.x,
        y: next.y,
        w: next.w,
        h: next.h,
        name: text.slice(0, 24),
        retype: { ...layer.retype!, text },
        provenance: `原始笔画 · 已按原样式重绘为「${text}」`,
      } as Partial<Layer>)
    },
    [updateLayer],
  )

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-950/95 backdrop-blur-sm">
      <header className="flex shrink-0 items-center gap-3 border-b border-ink-800 px-4 py-2.5">
        <h2 className="font-mono text-xs text-banana-400">{title}</h2>
        <span className="font-mono text-[10px] text-ink-600">
          {scene.layers.length} 层 · 双击文字图层可直接改字
        </span>
        <div className="flex-1" />
        <button
          onClick={() => {
            setMarquee((v) => !v)
            setRegion(null)
            setEditError(null)
          }}
          className={`rounded border px-2 py-1 font-mono text-[10px] transition ${
            marquee ? 'border-banana-500 bg-banana-500/15 text-banana-400' : 'border-ink-700 text-ink-400 hover:text-banana-400'
          }`}
          title="在画面上圈一块交给 AI 重画"
        >
          ⌗ 圈选重绘
        </button>
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
            <Stage
              scene={scene}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onChange={updateLayer}
              showOutlines={showOutlines}
              marquee={marquee}
              onMarquee={(r) => {
                setRegion(r)
                setTimeout(() => promptRef.current?.focus(), 0)
              }}
            />
          </div>

          {marquee ? (
            <div className="shrink-0 rounded-lg border border-banana-500/50 bg-ink-900 px-3 py-2">
              {region ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[10px] tabular-nums text-ink-400">
                    {Math.round(region.w)}×{Math.round(region.h)}
                  </span>
                  <input
                    ref={promptRef}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !busy) applyRegionEdit()
                      if (e.key === 'Escape') setRegion(null)
                    }}
                    placeholder="这块要改成什么？例如：把壶换成玻璃材质"
                    className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs outline-none focus:border-banana-500"
                  />
                  <button
                    onClick={applyRegionEdit}
                    disabled={busy || !instruction.trim()}
                    className="rounded bg-banana-500 px-3 py-1.5 text-[11px] font-medium text-ink-950 transition hover:bg-banana-400 disabled:opacity-40"
                  >
                    {busy ? '重画中…' : '重画这块'}
                  </button>
                  <button
                    onClick={() => setRegion(null)}
                    className="rounded border border-ink-700 px-2 py-1.5 text-[11px] text-ink-400 hover:text-ink-50"
                  >
                    重新圈
                  </button>
                </div>
              ) : (
                <p className="text-[11px] text-ink-400">
                  在画面上拖一个框，圈出要改的区域。裁片会带一圈周边一起送过去 —— 模型需要看到邻域才能把光照和风格接上。
                </p>
              )}
              {editError ? <p className="mt-1.5 text-[10px] text-rose-400">{editError}</p> : null}
            </div>
          ) : null}
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
            <Inspector
              layer={selected}
              onChange={(patch) => selectedId && updateLayer(selectedId, patch)}
              onRetype={handleRetype}
              onEditLayer={handleLayerEdit}
            />
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
