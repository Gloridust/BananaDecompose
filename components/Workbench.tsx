'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Controls, { DEFAULT_SETTINGS, type Settings } from './Controls'
import Stage from './Stage'
import { ArtifactStrip, Inspector, LayerList, Section, StepLog } from './Panels'
import { download, downloadJson, downloadSvg, sceneToPng } from '@/lib/export'
import { getRun, loadSettings, newRunId, saveRun, saveSettings } from '@/lib/history'
import { fileToDataUrl, thumbnail } from '@/lib/matte'
import { runCompose } from '@/lib/pipeline/compose'
import { runDecompose } from '@/lib/pipeline/decompose'
import type { PipelineCtx } from '@/lib/pipeline/shared'
import type { Layer, Run, RunStep, Scene } from '@/lib/types'

type Models = { image: string; vision: string; grounding: string }

export default function Workbench() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [hydrated, setHydrated] = useState(false)
  const [scene, setScene] = useState<Scene | null>(null)
  const [steps, setSteps] = useState<RunStep[]>([])
  const [artifacts, setArtifacts] = useState<{ label: string; src: string }[]>([])
  const [running, setRunning] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sourceImage, setSourceImage] = useState<string | null>(null)
  const [showOutlines, setShowOutlines] = useState(true)
  const [totals, setTotals] = useState({ cost: 0, ms: 0 })
  const [models, setModels] = useState<Models | null>(null)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    setSettings(loadSettings(DEFAULT_SETTINGS))
    setHydrated(true)

    // Deep link from the history page: /?run=<id> reopens a past run for editing.
    const runId = new URLSearchParams(window.location.search).get('run')
    if (runId) {
      getRun(runId).then((prev) => {
        if (!prev) return
        setScene(prev.scene)
        setSteps(prev.steps)
        setArtifacts(prev.artifacts)
        setTotals({ cost: prev.totalCost, ms: prev.totalMs })
        setSettings((cur) => ({ ...cur, pipeline: prev.pipeline, prompt: prev.prompt }))
      })
    }

    fetch('/api/models')
      .then((r) => r.json())
      .then((j) => {
        setModels(j.models)
        setConfigured(Boolean(j.configured))
      })
      .catch(() => setConfigured(false))
  }, [])

  useEffect(() => {
    if (hydrated) saveSettings(settings)
  }, [settings, hydrated])

  const patchSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }, [])

  // ------------------------------------------------------------- run

  const run = useCallback(async () => {
    if (!models) return
    const controller = new AbortController()
    abortRef.current = controller

    setRunning(true)
    setError(null)
    setSteps([])
    setArtifacts([])
    setScene(null)
    setSelectedId(null)
    setTotals({ cost: 0, ms: 0 })

    const collected: RunStep[] = []
    const collectedArtifacts: { label: string; src: string }[] = []
    const runTotals = { cost: 0, ms: 0 }

    const ctx: PipelineCtx = {
      signal: controller.signal,
      totals: runTotals,
      onStep: (step) => {
        const i = collected.findIndex((s) => s.id === step.id)
        if (i === -1) collected.push(step)
        else collected[i] = step
        setSteps([...collected])
        setTotals({ ...runTotals })
      },
      onArtifact: (a) => {
        collectedArtifacts.push(a)
        setArtifacts([...collectedArtifacts])
      },
    }

    const startedAt = performance.now()
    let produced: Scene | null = null
    let failed = false

    try {
      produced =
        settings.pipeline === 'compose'
          ? await runCompose(ctx, settings.prompt, settings.compose, models)
          : await runDecompose(ctx, { prompt: settings.prompt, sourceImage: sourceImage ?? undefined }, settings.decompose, models)
      setScene(produced)
    } catch (err) {
      failed = true
      const msg = (err as Error).message
      if ((err as Error).name !== 'Cancelled') setError(msg)
    } finally {
      setRunning(false)
      abortRef.current = null
    }

    if (produced) {
      try {
        const flattened = await sceneToPng(produced)
        const thumb = await thumbnail(flattened, 400)
        const record: Run = {
          id: newRunId(),
          createdAt: Date.now(),
          pipeline: settings.pipeline,
          prompt: sourceImage && settings.pipeline === 'decompose' ? `${settings.prompt} (上传图)` : settings.prompt,
          thumbnail: thumb,
          layerCount: produced.layers.length,
          textLayerCount: produced.layers.filter((l) => l.type === 'text').length,
          totalMs: Math.round(performance.now() - startedAt),
          totalCost: runTotals.cost,
          options: settings.pipeline === 'compose' ? settings.compose : settings.decompose,
          models,
          failed,
          scene: produced,
          steps: collected,
          artifacts: collectedArtifacts,
        }
        await saveRun(record)
      } catch {
        /* history is a convenience, never block the result on it */
      }
    }
  }, [models, settings, sourceImage])

  const cancel = useCallback(() => abortRef.current?.abort(), [])

  // ---------------------------------------------------------- editing

  const updateLayer = useCallback((id: string, patch: Partial<Layer>) => {
    setScene((prev) =>
      prev ? { ...prev, layers: prev.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)) } : prev,
    )
  }, [])

  const reorderLayer = useCallback((id: string, dir: -1 | 1) => {
    setScene((prev) => {
      if (!prev) return prev
      const i = prev.layers.findIndex((l) => l.id === id)
      const j = i + dir
      if (i === -1 || j < 0 || j >= prev.layers.length) return prev
      const layers = [...prev.layers]
      ;[layers[i], layers[j]] = [layers[j], layers[i]]
      return { ...prev, layers }
    })
  }, [])

  const deleteLayer = useCallback(
    (id: string) => {
      setScene((prev) => (prev ? { ...prev, layers: prev.layers.filter((l) => l.id !== id) } : prev))
      setSelectedId((cur) => (cur === id ? null : cur))
    },
    [],
  )

  const selected = useMemo(() => scene?.layers.find((l) => l.id === selectedId) ?? null, [scene, selectedId])

  const exportPng = useCallback(async () => {
    if (!scene) return
    download(`banana-${Date.now()}.png`, await sceneToPng(scene))
  }, [scene])

  // -------------------------------------------------------------- ui

  return (
    <main className="flex h-screen flex-col bg-ink-950">
      <header className="flex shrink-0 items-center gap-4 border-b border-ink-800 px-4 py-2.5">
        <h1 className="font-mono text-sm font-semibold tracking-tight">
          <span className="text-banana-400">Banana</span>Decompose
        </h1>
        <p className="hidden text-[11px] text-ink-400 md:block">Nano Banana 2 → 可编辑图层 + 真实文字</p>
        <div className="flex-1" />
        {totals.cost > 0 || totals.ms > 0 ? (
          <span className="font-mono text-[10px] tabular-nums text-ink-400">
            ${totals.cost.toFixed(4)} · {(totals.ms / 1000).toFixed(1)}s
          </span>
        ) : null}
        <Link href="/history" className="rounded border border-ink-700 px-2.5 py-1 text-[11px] text-ink-200 hover:border-banana-500 hover:text-banana-400">
          历史与对比
        </Link>
      </header>

      {configured === false ? (
        <div className="shrink-0 border-b border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs text-rose-200">
          没读到 <code className="font-mono">OPENROUTER_API_KEY</code>。把 <code className="font-mono">.env.local.example</code> 复制成{' '}
          <code className="font-mono">.env.local</code> 填上 key，然后重启 dev server。
        </div>
      ) : null}
      {error ? (
        <div className="shrink-0 border-b border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs text-rose-200">{error}</div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_1fr_300px]">
        {/* left: controls */}
        <aside className="scrollbar-thin min-h-0 overflow-y-auto border-r border-ink-800 p-3">
          <Controls
            settings={settings}
            onChange={patchSettings}
            running={running}
            onRun={run}
            onCancel={cancel}
            onUpload={async (file) => setSourceImage(await fileToDataUrl(file))}
            sourceImage={sourceImage}
            onClearSource={() => setSourceImage(null)}
            models={models}
          />
        </aside>

        {/* centre: stage + log */}
        <div className="flex min-h-0 min-w-0 flex-col gap-2 p-3">
          <div className="min-h-0 flex-1">
            {scene ? (
              <Stage
                scene={scene}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onChange={updateLayer}
                showOutlines={showOutlines}
              />
            ) : (
              <div className="checker flex h-full items-center justify-center rounded-lg border border-ink-800">
                <p className="max-w-sm px-6 text-center text-xs leading-relaxed text-ink-400">
                  {running ? '正在跑管线，中间产物会实时出现在下面…' : '左边写提示词，选一条管线，点运行。'}
                </p>
              </div>
            )}
          </div>

          <div className="scrollbar-thin max-h-56 shrink-0 overflow-y-auto rounded-lg border border-ink-800 bg-ink-900">
            <div className="grid grid-cols-1 divide-y divide-ink-800 xl:grid-cols-2 xl:divide-x xl:divide-y-0">
              <div className="p-3">
                <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-400">管线步骤</h3>
                <StepLog steps={steps} />
              </div>
              <div className="min-w-0 p-3">
                <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-400">中间产物</h3>
                <ArtifactStrip artifacts={artifacts} />
              </div>
            </div>
          </div>
        </div>

        {/* right: layers + inspector */}
        <aside className="scrollbar-thin min-h-0 overflow-y-auto border-l border-ink-800">
          <Section
            title="图层"
            right={
              <button
                onClick={() => setShowOutlines((v) => !v)}
                className="font-mono text-[9px] text-ink-400 hover:text-banana-400"
              >
                {showOutlines ? '隐藏边框' : '显示边框'}
              </button>
            }
          >
            {scene ? (
              <LayerList
                scene={scene}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onChange={updateLayer}
                onReorder={reorderLayer}
                onDelete={deleteLayer}
              />
            ) : (
              <p className="text-xs text-ink-400">还没有图层。</p>
            )}
          </Section>

          <Section title="属性">
            <Inspector layer={selected} onChange={(patch) => selectedId && updateLayer(selectedId, patch)} />
          </Section>

          <Section title="导出">
            <div className="grid grid-cols-3 gap-1.5">
              <ExportBtn disabled={!scene} onClick={exportPng}>PNG</ExportBtn>
              <ExportBtn disabled={!scene} onClick={() => scene && downloadSvg(`banana-${Date.now()}.svg`, scene)}>SVG</ExportBtn>
              <ExportBtn disabled={!scene} onClick={() => scene && downloadJson(`banana-${Date.now()}.json`, scene)}>JSON</ExportBtn>
            </div>
            <p className="mt-2 text-[10px] leading-snug text-ink-400">
              SVG 里的文字是 <code className="font-mono">&lt;text&gt;</code> 节点，不是描边路径 —— 这是整个 demo 的验收标准。
            </p>
          </Section>
        </aside>
      </div>
    </main>
  )
}

function ExportBtn({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="rounded border border-ink-700 px-2 py-1.5 font-mono text-[10px] text-ink-200 transition hover:border-banana-500 hover:text-banana-400 disabled:opacity-40 disabled:hover:border-ink-700 disabled:hover:text-ink-200"
    >
      {children}
    </button>
  )
}
