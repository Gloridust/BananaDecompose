'use client'

import { useState } from 'react'
import type { ImageLayer, Layer, RunStep, Scene, TextLayer } from '@/lib/types'
import { fontStack } from '@/lib/export'

export const FONT_CHOICES = [
  'Inter',
  'Playfair Display',
  'Space Grotesk',
  'Bebas Neue',
  'Noto Sans SC',
  'Noto Serif SC',
  'Georgia',
  'system-ui',
]

export function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-ink-800">
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="font-mono text-[10px] uppercase tracking-widest text-ink-400">{title}</h2>
        {right}
      </header>
      <div className="px-3 pb-3">{children}</div>
    </section>
  )
}

// ------------------------------------------------------------ layer list

export function LayerList({
  scene,
  selectedId,
  onSelect,
  onChange,
  onReorder,
  onDelete,
}: {
  scene: Scene
  selectedId: string | null
  onSelect: (id: string | null) => void
  onChange: (id: string, patch: Partial<Layer>) => void
  onReorder: (id: string, dir: -1 | 1) => void
  onDelete: (id: string) => void
}) {
  // Topmost first, the way every design tool shows it.
  const ordered = [...scene.layers].reverse()

  return (
    <ul className="space-y-1">
      {ordered.map((layer) => {
        const selected = layer.id === selectedId
        return (
          <li
            key={layer.id}
            onClick={() => onSelect(layer.id)}
            className={`group flex items-center gap-2 rounded border px-2 py-1.5 text-xs transition ${
              selected ? 'border-banana-500/60 bg-banana-500/10' : 'border-transparent bg-ink-850 hover:bg-ink-800'
            }`}
          >
            <button
              onClick={(e) => {
                e.stopPropagation()
                onChange(layer.id, { visible: !layer.visible })
              }}
              title={layer.visible ? '隐藏' : '显示'}
              className="w-4 shrink-0 text-center text-[11px] text-ink-400 hover:text-ink-50"
            >
              {layer.visible ? '◉' : '○'}
            </button>

            <span
              className={`shrink-0 rounded px-1 font-mono text-[9px] uppercase ${
                layer.type === 'text' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-sky-500/20 text-sky-300'
              }`}
            >
              {layer.type === 'text' ? 'T' : 'IMG'}
            </span>

            <span className="min-w-0 flex-1 truncate" title={layer.provenance}>
              {layer.name || layer.id}
            </span>

            <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
              <IconBtn label="上移" onClick={() => onReorder(layer.id, 1)}>↑</IconBtn>
              <IconBtn label="下移" onClick={() => onReorder(layer.id, -1)}>↓</IconBtn>
              <IconBtn label="删除" onClick={() => onDelete(layer.id)}>✕</IconBtn>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function IconBtn({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="rounded px-1 py-0.5 font-mono text-[10px] text-ink-400 hover:bg-ink-700 hover:text-ink-50"
    >
      {children}
    </button>
  )
}

// ------------------------------------------------------------- inspector

export function Inspector({
  layer,
  onChange,
  onRetype,
  onEditLayer,
}: {
  layer: Layer | null
  onChange: (patch: Partial<Layer>) => void
  onRetype?: (layer: ImageLayer, text: string) => Promise<void>
  onEditLayer?: (layer: ImageLayer, instruction: string) => Promise<void>
}) {
  if (!layer) {
    return <p className="px-1 py-2 text-xs text-ink-400">选中一个图层查看属性。双击文字图层可直接在画布上改字。</p>
  }

  return (
    <div className="space-y-3">
      {layer.provenance ? (
        <p className="rounded border border-ink-800 bg-ink-900 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink-400">
          {layer.provenance}
        </p>
      ) : null}

      <div className="grid grid-cols-4 gap-1.5">
        <Num label="X" value={layer.x} onChange={(v) => onChange({ x: v })} />
        <Num label="Y" value={layer.y} onChange={(v) => onChange({ y: v })} />
        <Num label="W" value={layer.w} onChange={(v) => onChange({ w: v })} />
        <Num label="H" value={layer.h} onChange={(v) => onChange({ h: v })} />
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <Num label="旋转" value={layer.rotation} onChange={(v) => onChange({ rotation: v })} />
        <Num label="不透明" value={layer.opacity} step={0.05} onChange={(v) => onChange({ opacity: Math.min(1, Math.max(0, v)) })} />
      </div>

      {layer.type === 'text' ? <TextControls layer={layer} onChange={onChange} /> : null}
      {layer.type === 'image' && layer.retype && onRetype ? <RetypeControls layer={layer} onRetype={onRetype} /> : null}
      {layer.type === 'image' && !layer.retype && onEditLayer && layer.id !== 'background' ? (
        <EditLayerControls layer={layer} onEdit={onEditLayer} />
      ) : null}
    </div>
  )
}

/** Rewrite one layer in place, using its own pixels as the reference. Same trip
 *  as the marquee edit, scoped to a layer that already has clean boundaries. */
function EditLayerControls({
  layer,
  onEdit,
}: {
  layer: ImageLayer
  onEdit: (layer: ImageLayer, instruction: string) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="space-y-2 border-t border-ink-800 pt-3">
      <p className="text-[10px] leading-snug text-ink-400">
        用 AI 改这个图层：把它自己的像素当参考重画，位置和尺寸不变。
      </p>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="例如：换成玻璃材质"
        className="w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs outline-none focus:border-banana-500"
      />
      <button
        disabled={!draft.trim() || busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            await onEdit(layer, draft.trim())
            setDraft('')
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
        className="w-full rounded border border-ink-700 px-2 py-1.5 text-[11px] text-ink-200 transition hover:border-banana-500 hover:text-banana-400 disabled:opacity-40"
      >
        {busy ? '重画中…' : '重画这个图层'}
      </button>
      {error ? <p className="text-[10px] leading-snug text-rose-400">{error}</p> : null}
    </div>
  )
}

/** Type kept as pixels cannot be edited in place — changing the words means
 *  redrawing them, so the control is a regenerate button rather than a caret. */
function RetypeControls({
  layer,
  onRetype,
}: {
  layer: ImageLayer
  onRetype: (layer: ImageLayer, text: string) => Promise<void>
}) {
  const [draft, setDraft] = useState(layer.retype!.text)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = draft.trim() !== layer.retype!.text && draft.trim().length > 0

  return (
    <div className="space-y-2 border-t border-ink-800 pt-3">
      <p className="text-[10px] leading-snug text-ink-400">
        这层是<span className="text-ink-200">原始笔画</span>，不是文本节点。改字要按原样式重绘一版（2 次出图调用）。
      </p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={2}
        className="w-full resize-y rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs outline-none focus:border-banana-500"
      />
      <button
        disabled={!dirty || busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            await onRetype(layer, draft.trim())
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
        className="w-full rounded border border-banana-500 bg-banana-500/15 px-2 py-1.5 text-[11px] text-banana-400 transition hover:bg-banana-500/25 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? '重绘中…' : dirty ? '按原样式重绘' : '改了字才能重绘'}
      </button>
      {error ? <p className="text-[10px] leading-snug text-rose-400">{error}</p> : null}
    </div>
  )
}

function TextControls({ layer, onChange }: { layer: TextLayer; onChange: (patch: Partial<Layer>) => void }) {
  return (
    <div className="space-y-2 border-t border-ink-800 pt-3">
      <textarea
        value={layer.text}
        onChange={(e) => onChange({ text: e.target.value } as Partial<Layer>)}
        rows={2}
        className="w-full resize-y rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs outline-none focus:border-banana-500"
        style={{ fontFamily: fontStack(layer.fontFamily) }}
      />

      <select
        value={layer.fontFamily}
        onChange={(e) => onChange({ fontFamily: e.target.value } as Partial<Layer>)}
        className="w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs outline-none focus:border-banana-500"
      >
        {FONT_CHOICES.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>

      <div className="grid grid-cols-3 gap-1.5">
        <Num label="字号" value={layer.fontSize} onChange={(v) => onChange({ fontSize: v } as Partial<Layer>)} />
        <Num label="字重" value={layer.fontWeight} step={100} onChange={(v) => onChange({ fontWeight: v } as Partial<Layer>)} />
        <Num label="字距" value={layer.letterSpacing} step={0.5} onChange={(v) => onChange({ letterSpacing: v } as Partial<Layer>)} />
      </div>

      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(layer.color) ? layer.color : '#ffffff'}
          onChange={(e) => onChange({ color: e.target.value } as Partial<Layer>)}
          className="h-7 w-9 cursor-pointer rounded border border-ink-700 bg-ink-900"
        />
        {(['left', 'center', 'right'] as const).map((a) => (
          <button
            key={a}
            onClick={() => onChange({ align: a } as Partial<Layer>)}
            className={`flex-1 rounded border px-1 py-1 font-mono text-[10px] ${
              layer.align === a ? 'border-banana-500 bg-banana-500/15 text-banana-400' : 'border-ink-700 text-ink-400 hover:text-ink-50'
            }`}
          >
            {a[0].toUpperCase()}
          </button>
        ))}
        <button
          onClick={() => onChange({ italic: !layer.italic } as Partial<Layer>)}
          className={`rounded border px-2 py-1 font-mono text-[10px] italic ${
            layer.italic ? 'border-banana-500 bg-banana-500/15 text-banana-400' : 'border-ink-700 text-ink-400 hover:text-ink-50'
          }`}
        >
          I
        </button>
      </div>
    </div>
  )
}

function Num({ label, value, step = 1, onChange }: { label: string; value: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="mb-0.5 block font-mono text-[9px] uppercase text-ink-400">{label}</span>
      <input
        type="number"
        step={step}
        value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded border border-ink-700 bg-ink-900 px-1.5 py-1 text-xs tabular-nums outline-none focus:border-banana-500"
      />
    </label>
  )
}

// -------------------------------------------------------------- step log

const STATUS_STYLE: Record<RunStep['status'], string> = {
  pending: 'text-ink-400',
  running: 'text-banana-400',
  ok: 'text-emerald-400',
  error: 'text-rose-400',
  skipped: 'text-ink-600',
}
const STATUS_GLYPH: Record<RunStep['status'], string> = {
  pending: '·',
  running: '◐',
  ok: '✓',
  error: '✕',
  skipped: '−',
}

export function StepLog({ steps }: { steps: RunStep[] }) {
  if (!steps.length) return <p className="px-1 text-xs text-ink-400">还没有运行过。</p>
  return (
    <ol className="space-y-1 font-mono text-[11px]">
      {steps.map((s) => (
        <li key={s.id} className="flex items-start gap-2">
          <span className={`w-3 shrink-0 ${STATUS_STYLE[s.status]} ${s.status === 'running' ? 'animate-pulse' : ''}`}>
            {STATUS_GLYPH[s.status]}
          </span>
          <span className="min-w-0 flex-1">
            <span className={s.status === 'skipped' ? 'text-ink-600' : 'text-ink-200'}>{s.label}</span>
            {s.detail ? <span className="block text-ink-400">{s.detail}</span> : null}
            {s.error ? <span className="block text-rose-400">{s.error}</span> : null}
          </span>
          <span className="shrink-0 tabular-nums text-ink-600">
            {s.ms != null ? `${(s.ms / 1000).toFixed(1)}s` : ''}
            {s.cost ? ` $${s.cost.toFixed(4)}` : ''}
          </span>
        </li>
      ))}
    </ol>
  )
}

// --------------------------------------------------------- artifact strip

export function ArtifactStrip({ artifacts }: { artifacts: { label: string; src: string }[] }) {
  if (!artifacts.length) return <p className="px-1 text-xs text-ink-400">中间产物会出现在这里：每次生成的原始底片、抠图结果、擦除后的背景板。</p>
  return (
    <div className="scrollbar-thin flex gap-2 overflow-x-auto pb-1">
      {artifacts.map((a, i) => (
        <figure key={`${a.label}-${i}`} className="w-24 shrink-0">
          <div className="checker overflow-hidden rounded border border-ink-800">
            <img src={a.src} alt={a.label} className="h-24 w-full object-contain" />
          </div>
          <figcaption className="mt-1 truncate font-mono text-[9px] text-ink-400" title={a.label}>
            {a.label}
          </figcaption>
        </figure>
      ))}
    </div>
  )
}
