'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Controls, { DEFAULT_SETTINGS, type Settings } from './Controls'
import BoardCanvas from './Board'
import BranchLegend from './BranchLegend'
import BoardBar from './BoardBar'
import DiagnosticExport from './DiagnosticExport'
import SceneEditor from './SceneEditor'
import BenchmarkPanel from './BenchmarkPanel'
import { ArtifactStrip, StepLog } from './Panels'
import { aspectToSize, preparePlan, preparePlate, runCompose, sharedNodes } from '@/lib/pipeline/compose'
import { prepareSource, runDecompose } from '@/lib/pipeline/decompose'
import { getBoard, listBoards, loadSettings, newId, saveBoard, saveSettings } from '@/lib/history'
import { computeMetrics } from '@/lib/metrics'
import { fileToDataUrl, thumbnail } from '@/lib/matte'
import { sceneToPng } from '@/lib/export'
import { VARIANTS, resolveOptions } from '@/lib/benchmark'
import { DEFAULT_SELECTION } from '@/lib/benchmark'
import { setConcurrency } from '@/lib/pipeline/scheduler'
import type { NodeEmit, PipelineCtx } from '@/lib/pipeline/shared'
import type {
  Artifact,
  Board,
  BoardBranch,
  BoardMeta,
  BoardNode,
  ComposeOptions,
  DecomposeOptions,
  PipelineId,
  RunStep,
  Scene,
  ScenePlan,
} from '@/lib/types'

type Models = { image: string; vision: string; grounding: string }

type BranchPlan = {
  id: string
  label: string
  pipeline: PipelineId
  compose: ComposeOptions
  decompose: DecomposeOptions
}

/** A canvas is a document: it can be started fresh, reopened, or added to. */
type RunMode = 'new' | 'append'

export default function Workbench() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [hydrated, setHydrated] = useState(false)
  const [board, setBoard] = useState<Board | null>(null)
  const [boards, setBoards] = useState<BoardMeta[]>([])
  const [steps, setSteps] = useState<RunStep[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ label: string; index: number; total: number } | null>(null)
  const [selection, setSelection] = useState<string[]>(DEFAULT_SELECTION)
  const [hiddenBranches, setHiddenBranches] = useState<Set<string>>(new Set())
  const [hiddenNodes, setHiddenNodes] = useState<Set<string>>(new Set())
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [sourceImage, setSourceImage] = useState<string | null>(null)
  const [models, setModels] = useState<Models | null>(null)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Branches run concurrently and reuse step ids ('erase', 'flat', 'el-…'), so the
  // shared log keys on branch + step and carries a label. Without this, whichever
  // branch reported last would blank out every other branch's steps.
  const stepsRef = useRef<RunStep[]>([])
  const artifactsRef = useRef<Artifact[]>([])
  // The board is mutated at high frequency while running; a ref avoids losing
  // node updates to React batching between concurrent element renders.
  const boardRef = useRef<Board | null>(null)

  useEffect(() => {
    setSettings(loadSettings(DEFAULT_SETTINGS))
    setHydrated(true)

    const list = listBoards()
    setBoards(list)
    const boardId = new URLSearchParams(window.location.search).get('board')
    const target = boardId ?? list[0]?.id
    if (target) {
      getBoard(target).then((prev) => {
        if (!prev) return
        boardRef.current = prev
        setBoard(prev)
        setSettings((cur) => ({ ...cur, prompt: prev.prompt }))
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

  const patchSettings = useCallback((patch: Partial<Settings>) => setSettings((p) => ({ ...p, ...patch })), [])

  const commit = useCallback((next: Board) => {
    boardRef.current = next
    setBoard(next)
  }, [])

  const pushStep = useCallback((branchLabel: string, branchId: string, step: RunStep) => {
    const id = `${branchId}:${step.id}`
    const entry: RunStep = { ...step, id, label: `${branchLabel} · ${step.label}` }
    const i = stepsRef.current.findIndex((x) => x.id === id)
    if (i === -1) stepsRef.current = [...stepsRef.current, entry]
    else {
      const next = [...stepsRef.current]
      next[i] = entry
      stepsRef.current = next
    }
    setSteps(stepsRef.current)
  }, [])

  const pushArtifact = useCallback((a: Artifact) => {
    artifactsRef.current = [...artifactsRef.current, a]
    setArtifacts(artifactsRef.current)
  }, [])

  // ------------------------------------------------------- board writes

  const upsertNode = useCallback(
    (attribution: string[], emitted: NodeEmit) => {
      const cur = boardRef.current
      if (!cur) return
      const nodes = [...cur.nodes]
      const i = nodes.findIndex((n) => n.id === emitted.id)
      if (i === -1) {
        nodes.push({ ...emitted, branches: [...attribution] })
      } else {
        const prev = nodes[i]
        nodes[i] = {
          ...prev,
          ...emitted,
          // A shared node accumulates every branch that consumed it.
          branches: [...new Set([...prev.branches, ...attribution])],
          // Never let a later reuse blank out payload the first producer supplied.
          images: emitted.images ?? prev.images,
          summary: emitted.summary ?? prev.summary,
          scene: emitted.scene ?? prev.scene,
          metrics: emitted.metrics ?? prev.metrics,
          cost: (prev.cost ?? 0) + (emitted.cost ?? 0) || undefined,
        }
      }
      commit({ ...cur, nodes })
    },
    [commit],
  )

  const patchBranch = useCallback(
    (branchId: string, patch: Partial<BoardBranch>) => {
      const cur = boardRef.current
      if (!cur) return
      commit({ ...cur, branches: cur.branches.map((b) => (b.id === branchId ? { ...b, ...patch } : b)) })
    },
    [commit],
  )

  // ---------------------------------------------------- run one branch

  const runBranch = useCallback(
    async (
      plan: BranchPlan,
      shared: { plan?: ScenePlan; background?: string; source?: string; prepared?: boolean },
      runKey: string,
      signal: AbortSignal,
    ) => {
      if (!models) return

      const collectedArtifacts: Artifact[] = []
      const branchTotals = { cost: 0, ms: 0 }

      const ctx: PipelineCtx = {
        signal,
        branchId: plan.id,
        runKey,
        totals: branchTotals,
        onStep: (step) => pushStep(plan.label, plan.id, step),
        onArtifact: (a) => {
          collectedArtifacts.push(a)
          pushArtifact(a)
        },
        onNode: (n) => upsertNode([plan.id], n),
      }

      patchBranch(plan.id, { status: 'running', startedAt: performance.now() })
      const startedAt = performance.now()

      try {
        let scene: Scene
        let tailNodes: string[]
        let warnings: string[]

        if (plan.pipeline === 'compose') {
          const res = await runCompose(ctx, settings.prompt, plan.compose, models, {
            plan: shared.plan,
            background: shared.background,
          })
          scene = res.scene
          tailNodes = res.tailNodes
          warnings = res.warnings
        } else {
          const res = await runDecompose(
            ctx,
            { prompt: settings.prompt, sourceImage: shared.source, prepared: shared.prepared },
            plan.decompose,
            models,
          )
          scene = res.scene
          tailNodes = res.tailNodes
          warnings = res.warnings
        }

        const metrics = await computeMetrics(scene, collectedArtifacts, {
          matte: plan.pipeline === 'compose' ? plan.compose.matte : undefined,
          liveText: plan.pipeline === 'compose' && plan.compose.text === 'live',
        }).catch(() => undefined)

        const sceneNodeId = `n:${plan.id}:scene`
        const flattened = await sceneToPng(scene)
        const pathMs = Math.round(performance.now() - startedAt)
        upsertNode([plan.id], {
          id: sceneNodeId,
          kind: 'scene',
          label: plan.label,
          detail: `${scene.layers.length} 层 · ${scene.layers.filter((l) => l.type === 'text').length} 文字`,
          error: warnings.length ? warnings.join('；') : undefined,
          inputs: tailNodes,
          status: 'ok',
          ms: pathMs,
          scene,
          metrics,
          images: [{ label: '合成结果', src: await thumbnail(flattened, 420) }],
        })

        patchBranch(plan.id, {
          status: 'ok',
          metrics,
          sceneNodeId,
          cost: branchTotals.cost,
          ms: pathMs,
          endedAt: performance.now(),
        })
      } catch (err) {
        const message = (err as Error).message
        const cancelled = (err as Error).name === 'Cancelled'
        // A single branch failing is data, not a session-level error — the node
        // and the legend dot already say so, so no global banner.
        patchBranch(plan.id, {
          status: cancelled ? 'skipped' : 'error',
          error: cancelled ? undefined : message,
          cost: branchTotals.cost,
          ms: Math.round(performance.now() - startedAt),
          endedAt: performance.now(),
        })
      }

      const cur = boardRef.current
      if (cur) {
        commit({
          ...cur,
          totalCost: cur.branches.reduce((a, b) => a + b.cost, 0),
          serialMs: cur.prepMs + cur.branches.reduce((a, b) => a + b.ms, 0),
          nodeCount: cur.nodes.length,
        })
      }
    },
    [models, settings.prompt, upsertNode, patchBranch, commit, pushStep, pushArtifact],
  )

  // ------------------------------------------------- run a whole board

  const runBoard = useCallback(
    async (plans: BranchPlan[], mode: RunMode) => {
      if (!models || !plans.length) return
      const controller = new AbortController()
      abortRef.current = controller
      setConcurrency(settings.concurrency)
      setRunning(true)
      setError(null)
      stepsRef.current = []
      artifactsRef.current = []
      setSteps([])
      setArtifacts([])
      setSelectedNodeId(null)

      const existing = mode === 'append' ? boardRef.current : null
      // Each round gets its own key so a canvas can hold several: shared upstream
      // merges within a round, never across them, and two runs of the same arm
      // stay distinct branches.
      const round = existing ? existing.rounds + 1 : 1
      const runKey = `r${round}`
      const scoped = plans.map((p) => ({ ...p, id: `${runKey}:${p.id}`, label: existing ? `${p.label} ·${round}` : p.label }))
      const N = sharedNodes(runKey)

      if (mode === 'new') {
        setHiddenBranches(new Set())
        setHiddenNodes(new Set())
      }

      const boardStart = performance.now()
      const promptNode: BoardNode = {
        id: N.prompt,
        kind: 'prompt',
        label: existing ? `提示词 ·${round}` : '提示词',
        branches: [],
        inputs: [],
        status: 'ok',
        summary: settings.prompt,
      }

      const base: Board = existing
        ? {
            ...existing,
            rounds: round,
            prompt: settings.prompt,
            branchCount: existing.branches.length + scoped.length,
            branches: [
              ...existing.branches,
              ...scoped.map((p) => ({
                id: p.id,
                label: p.label,
                pipeline: p.pipeline,
                options: p.pipeline === 'compose' ? p.compose : p.decompose,
                status: 'skipped' as const,
                cost: 0,
                ms: 0,
              })),
            ],
            nodes: [...existing.nodes, promptNode],
          }
        : {
            id: newId(),
            createdAt: Date.now(),
            prompt: settings.prompt,
            rounds: 1,
            branchCount: scoped.length,
            nodeCount: 0,
            totalMs: 0,
            serialMs: 0,
            prepMs: 0,
            totalCost: 0,
            concurrency: settings.concurrency,
            models,
            fromUpload: Boolean(sourceImage),
            branches: scoped.map((p) => ({
              id: p.id,
              label: p.label,
              pipeline: p.pipeline,
              options: p.pipeline === 'compose' ? p.compose : p.decompose,
              status: 'skipped' as const,
              cost: 0,
              ms: 0,
            })),
            nodes: [promptNode],
          }
      commit(base)

      const composeArms = scoped.filter((p) => p.pipeline === 'compose')
      const decomposeArms = scoped.filter((p) => p.pipeline === 'decompose')
      // Only text-free plates are shareable; the baked arm renders its own copy in.
      const plateArms = composeArms.filter((p) => p.compose.text === 'live')

      const shared: { plan?: ScenePlan; background?: string; source?: string; prepared?: boolean } = {
        source: sourceImage ?? undefined,
        prepared: false,
      }
      const prepTotals = { cost: 0, ms: 0 }

      /** A context whose nodes are credited to every branch that will consume them. */
      const prepCtx = (attribution: string[]): PipelineCtx => ({
        signal: controller.signal,
        branchId: `${runKey}-shared`,
        runKey,
        attribution,
        totals: prepTotals,
        onStep: (step) => pushStep('共享', `${runKey}-shared`, step),
        onArtifact: pushArtifact,
        onNode: (n) => upsertNode(attribution, n),
      })

      try {
        // ── phase 0: shared upstream, produced once. The two pipelines have no
        // dependency on each other, so their prep runs concurrently.
        setProgress({ label: '共享上游：规划 / 背景板 / 来源图', index: 0, total: scoped.length })
        await Promise.all([
          (async () => {
            if (!composeArms.length) return
            const ctx = prepCtx(composeArms.map((p) => p.id))
            const opts = composeArms[0].compose
            shared.plan = await preparePlan(ctx, settings.prompt, opts, aspectToSize(opts.aspectRatio, opts.resolution))
            if (plateArms.length) {
              shared.background = await preparePlate(prepCtx(plateArms.map((p) => p.id)), shared.plan, opts, models)
            }
          })(),
          (async () => {
            if (!decomposeArms.length || shared.source) return
            const ctx = prepCtx(decomposeArms.map((p) => p.id))
            shared.source = await prepareSource(ctx, settings.prompt, decomposeArms[0].decompose, models)
            shared.prepared = true
          })(),
        ])
      } catch (err) {
        if ((err as Error).name !== 'Cancelled') setError(`共享上游失败：${(err as Error).message}`)
      }

      const prepMs = Math.round(performance.now() - boardStart)

      // ── phase 1: every branch at once. The global scheduler bounds total load,
      // so branch count no longer multiplies into a request storm.
      if (shared.plan || shared.source || !composeArms.length) {
        let done = 0
        await Promise.all(
          scoped.map(async (p) => {
            await runBranch(p, shared, runKey, controller.signal)
            done++
            setProgress({ label: p.label, index: done, total: scoped.length })
          }),
        )
      }

      setRunning(false)
      setProgress(null)
      abortRef.current = null

      const finishedBoard = boardRef.current
      if (finishedBoard) {
        const sceneNode = [...finishedBoard.nodes].reverse().find((n) => n.kind === 'scene' && n.images?.length)
        const finished: Board = {
          ...finishedBoard,
          thumbnail: sceneNode?.images?.[0]?.src ?? finishedBoard.thumbnail,
          nodeCount: finishedBoard.nodes.length,
          prepMs: finishedBoard.prepMs + prepMs,
          totalMs: (existing?.totalMs ?? 0) + Math.round(performance.now() - boardStart),
          serialMs: prepMs + finishedBoard.branches.reduce((a, b) => a + b.ms, 0),
          totalCost: prepTotals.cost + finishedBoard.branches.reduce((a, b) => a + b.cost, 0),
          // Nodes record what a step produced; only the log records why one
          // produced nothing, which is exactly what a failed run needs.
          steps: stepsRef.current,
        }
        commit(finished)
        await saveBoard(finished).catch(() => undefined)
        setBoards(listBoards())
      }
    },
    [models, settings.prompt, settings.concurrency, sourceImage, commit, runBranch, upsertNode, pushStep, pushArtifact],
  )

  const runSingle = useCallback(
    (mode: RunMode) => {
      const pipeline = settings.pipeline
      return runBoard(
        [
          {
            id: 'single',
            label:
              pipeline === 'compose'
                ? `A · ${settings.compose.matte}`
                : `B · ${settings.decompose.textMode === 'pixel' ? '原始笔画' : '重排'}`,
            pipeline,
            compose: settings.compose,
            decompose: settings.decompose,
          },
        ],
        mode,
      )
    },
    [runBoard, settings],
  )

  const runBenchmark = useCallback(
    (mode: RunMode) => {
      const arms = VARIANTS.filter((v) => selection.includes(v.id))
      return runBoard(
        arms.map((arm) => {
          const opts = resolveOptions(arm, { compose: settings.compose, decompose: settings.decompose })
          return { id: arm.id, label: arm.label, pipeline: arm.pipeline, compose: opts.compose, decompose: opts.decompose }
        }),
        mode,
      )
    },
    [runBoard, selection, settings],
  )

  const newBoard = useCallback(() => {
    boardRef.current = null
    setBoard(null)
    setSteps([])
    setArtifacts([])
    setSelectedNodeId(null)
    setHiddenBranches(new Set())
    setHiddenNodes(new Set())
    stepsRef.current = []
    artifactsRef.current = []
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname)
  }, [])

  const openBoard = useCallback(async (id: string) => {
    const found = await getBoard(id)
    if (!found) return
    boardRef.current = found
    setBoard(found)
    setSelectedNodeId(null)
    setHiddenBranches(new Set())
    setHiddenNodes(new Set())
    setSettings((cur) => ({ ...cur, prompt: found.prompt }))
    window.history.replaceState(null, '', `${window.location.pathname}?board=${id}`)
  }, [])

  const cancel = useCallback(() => abortRef.current?.abort(), [])

  // ------------------------------------------------------------- edit

  const editingNode = useMemo(
    () => (editing ? (board?.nodes.find((n) => n.id === editing) ?? null) : null),
    [editing, board],
  )

  const saveSceneEdit = useCallback(
    async (nodeId: string, scene: Scene) => {
      const cur = boardRef.current
      if (!cur) return
      const next: Board = { ...cur, nodes: cur.nodes.map((n) => (n.id === nodeId ? { ...n, scene } : n)) }
      commit(next)
      await saveBoard(next).catch(() => undefined)
    },
    [commit],
  )

  const toggleBranch = useCallback((id: string) => {
    setHiddenBranches((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const soloBranch = useCallback(
    (id: string) => {
      const others = (board?.branches ?? []).filter((b) => b.id !== id).map((b) => b.id)
      setHiddenBranches((prev) => (prev.size === others.length && others.every((o) => prev.has(o)) ? new Set() : new Set(others)))
    },
    [board],
  )

  const toggleNode = useCallback((id: string) => {
    setHiddenNodes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const openScene = useCallback((node: BoardNode) => {
    if (node.scene) setEditing(node.id)
  }, [])

  // -------------------------------------------------------------- ui

  return (
    <main className="flex h-screen flex-col bg-ink-950">
      <header className="flex shrink-0 items-center gap-4 border-b border-ink-800 px-4 py-2.5">
        <h1 className="font-mono text-sm font-semibold tracking-tight">
          <span className="text-banana-400">Banana</span>Decompose
        </h1>
        <BoardBar
          board={board}
          boards={boards}
          running={running}
          onNew={newBoard}
          onOpen={openBoard}
        />
        <div className="flex-1" />
        {hiddenNodes.size ? (
          <button onClick={() => setHiddenNodes(new Set())} className="font-mono text-[10px] text-ink-400 hover:text-banana-400">
            恢复 {hiddenNodes.size} 个隐藏节点
          </button>
        ) : null}
        <DiagnosticExport board={board} disabled={running} />
        <Link href="/history" className="rounded border border-ink-700 px-2.5 py-1 text-[11px] text-ink-200 hover:border-banana-500 hover:text-banana-400">
          历史画布
        </Link>
      </header>

      {configured === false ? (
        <div className="shrink-0 border-b border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs text-rose-200">
          没读到 <code className="font-mono">OPENROUTER_API_KEY</code>。把 <code className="font-mono">.env.local.example</code> 复制成{' '}
          <code className="font-mono">.env.local</code> 填上 key，然后重启 dev server。
        </div>
      ) : null}
      {progress ? (
        <div className="shrink-0 border-b border-banana-500/40 bg-banana-500/10 px-4 py-2 text-xs text-banana-200">
          {progress.index === 0 ? progress.label : `已完成 ${progress.index}/${progress.total} 条分支 · 最近：${progress.label}`}
          <span className="ml-2 text-banana-400/70">所有分支同时在跑，节点实时长到画布上</span>
        </div>
      ) : null}
      {error ? <div className="shrink-0 border-b border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs text-rose-200">{error}</div> : null}

      <div
        className="grid min-h-0 flex-1 grid-cols-1"
        style={{ gridTemplateColumns: settings.panels.left ? '320px 1fr' : '36px 1fr' }}
      >
        {!settings.panels.left ? (
          <aside className="flex min-h-0 flex-col items-center gap-2 border-r border-ink-800 py-2">
            <PanelToggle
              title="展开设置面板"
              onClick={() => patchSettings({ panels: { ...settings.panels, left: true } })}
            >
              ▸
            </PanelToggle>
            <span className="mt-1 select-none font-mono text-[9px] leading-tight text-ink-600" style={{ writingMode: 'vertical-rl' }}>
              设置 / 评测
            </span>
          </aside>
        ) : (
        <aside className="scrollbar-thin relative min-h-0 overflow-y-auto border-r border-ink-800 p-3">
          <div className="mb-2 flex justify-end">
            <PanelToggle
              title="收起设置面板，把画布放大"
              onClick={() => patchSettings({ panels: { ...settings.panels, left: false } })}
            >
              ◂
            </PanelToggle>
          </div>
          <Controls
            settings={settings}
            onChange={patchSettings}
            running={running}
            onRun={() => runSingle(board ? 'append' : 'new')}
            onCancel={cancel}
            appending={Boolean(board)}
            onUpload={async (file) => setSourceImage(await fileToDataUrl(file))}
            sourceImage={sourceImage}
            onClearSource={() => setSourceImage(null)}
            models={models}
          />
          <div className="mt-4 border-t border-ink-800 pt-4">
            <BenchmarkPanel
              selection={selection}
              onSelectionChange={setSelection}
              running={running}
              onRun={() => runBenchmark(board ? 'append' : 'new')}
              appending={Boolean(board)}
              composeElements={settings.compose.maxElements}
              decomposeElements={settings.decompose.maxElements}
              hasUpload={Boolean(sourceImage)}
            />
          </div>
        </aside>
        )}

        <div className="flex min-h-0 min-w-0 flex-col">
          {board ? (
            <BranchLegend
              board={board}
              hidden={hiddenBranches}
              running={running}
              onToggle={toggleBranch}
              onSolo={soloBranch}
              onShowAll={() => setHiddenBranches(new Set())}
            />
          ) : null}

          <div className="min-h-0 flex-1 p-3">
            {board ? (
              <BoardCanvas
                board={board}
                hiddenBranches={hiddenBranches}
                hiddenNodes={hiddenNodes}
                onToggleNode={toggleNode}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
                onOpenScene={openScene}
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-lg border border-ink-800">
                <p className="max-w-sm px-6 text-center text-xs leading-relaxed text-ink-400">
                  左边写提示词跑一次，或者直接一键评测。<br />
                  每条分支的每个中间产物都会作为节点长到这张画布上，共享的上游只画一次。
                </p>
              </div>
            )}
          </div>

          {settings.panels.bottom ? (
            <div className="scrollbar-thin max-h-44 shrink-0 overflow-y-auto border-t border-ink-800 bg-ink-900">
              <div className="grid grid-cols-1 divide-y divide-ink-800 xl:grid-cols-2 xl:divide-x xl:divide-y-0">
                <div className="p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="font-mono text-[10px] uppercase tracking-widest text-ink-400">步骤（所有分支交错）</h3>
                    <PanelToggle
                      title="收起底部面板，把画布放大"
                      onClick={() => patchSettings({ panels: { ...settings.panels, bottom: false } })}
                    >
                      ▾
                    </PanelToggle>
                  </div>
                  <StepLog steps={steps} />
                </div>
                <div className="min-w-0 p-3">
                  <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-400">中间产物</h3>
                  <ArtifactStrip artifacts={artifacts} />
                </div>
              </div>
            </div>
          ) : (
            <button
              onClick={() => patchSettings({ panels: { ...settings.panels, bottom: true } })}
              className="flex shrink-0 items-center gap-2 border-t border-ink-800 bg-ink-900 px-3 py-1.5 text-left font-mono text-[10px] text-ink-400 transition hover:text-banana-400"
            >
              <span>▴</span>
              <span>步骤与中间产物</span>
              {steps.length ? <span className="text-ink-600">{steps.length} 步</span> : null}
              {artifacts.length ? <span className="text-ink-600">· {artifacts.length} 张中间图</span> : null}
            </button>
          )}
        </div>
      </div>

      {editingNode?.scene ? (
        <SceneEditor
          title={editingNode.label}
          scene={editingNode.scene}
          metrics={editingNode.metrics}
          onChange={(scene) => saveSceneEdit(editingNode.id, scene)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </main>
  )
}

/** Collapse control for the side and bottom panels — the canvas is the point,
 *  so everything around it has to be able to get out of the way. */
function PanelToggle({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="rounded border border-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-500 transition hover:border-banana-500 hover:text-banana-400"
    >
      {children}
    </button>
  )
}
