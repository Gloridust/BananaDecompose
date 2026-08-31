'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Controls, { DEFAULT_SETTINGS, type Settings } from './Controls'
import BoardCanvas from './Board'
import BranchLegend from './BranchLegend'
import SceneEditor from './SceneEditor'
import BenchmarkPanel from './BenchmarkPanel'
import { ArtifactStrip, StepLog } from './Panels'
import { PROMPT_NODE, runCompose } from '@/lib/pipeline/compose'
import { runDecompose } from '@/lib/pipeline/decompose'
import { getBoard, listBoards, loadSettings, newId, saveBoard, saveSettings } from '@/lib/history'
import { computeMetrics } from '@/lib/metrics'
import { fileToDataUrl, thumbnail } from '@/lib/matte'
import { sceneToPng } from '@/lib/export'
import { VARIANTS, resolveOptions } from '@/lib/benchmark'
import { DEFAULT_SELECTION } from '@/lib/benchmark'
import type { NodeEmit, PipelineCtx } from '@/lib/pipeline/shared'
import type {
  Artifact,
  Board,
  BoardBranch,
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

export default function Workbench() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [hydrated, setHydrated] = useState(false)
  const [board, setBoard] = useState<Board | null>(null)
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
  // The board is mutated at high frequency while running; a ref avoids losing
  // node updates to React batching between concurrent element renders.
  const boardRef = useRef<Board | null>(null)

  useEffect(() => {
    setSettings(loadSettings(DEFAULT_SETTINGS))
    setHydrated(true)

    const boardId = new URLSearchParams(window.location.search).get('board')
    const target = boardId ?? listBoards()[0]?.id
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

  // ------------------------------------------------------- board writes

  const upsertNode = useCallback(
    (branchId: string, emitted: NodeEmit) => {
      const cur = boardRef.current
      if (!cur) return
      const nodes = [...cur.nodes]
      const i = nodes.findIndex((n) => n.id === emitted.id)
      if (i === -1) {
        nodes.push({ ...emitted, branches: [branchId] })
      } else {
        const prev = nodes[i]
        nodes[i] = {
          ...prev,
          ...emitted,
          // A shared node accumulates every branch that consumed it.
          branches: prev.branches.includes(branchId) ? prev.branches : [...prev.branches, branchId],
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
      shared: { plan?: ScenePlan; background?: string; source?: string },
      signal: AbortSignal,
    ) => {
      if (!models) return shared

      const collected: RunStep[] = []
      const collectedArtifacts: Artifact[] = []
      const branchTotals = { cost: 0, ms: 0 }

      const ctx: PipelineCtx = {
        signal,
        branchId: plan.id,
        totals: branchTotals,
        onStep: (step) => {
          const i = collected.findIndex((s) => s.id === step.id)
          if (i === -1) collected.push(step)
          else collected[i] = step
          setSteps([...collected])
        },
        onArtifact: (a) => {
          collectedArtifacts.push(a)
          setArtifacts([...collectedArtifacts])
        },
        onNode: (n) => upsertNode(plan.id, n),
      }

      patchBranch(plan.id, { status: 'running' })
      const startedAt = performance.now()
      const next = { ...shared }

      try {
        let scene: Scene
        let tailNodes: string[]

        if (plan.pipeline === 'compose') {
          const res = await runCompose(ctx, settings.prompt, plan.compose, models, {
            plan: shared.plan,
            background: shared.background,
          })
          scene = res.scene
          tailNodes = res.tailNodes
          if (!next.plan) next.plan = res.plan
          // Only a text-free plate is reusable; the baked arm bakes copy into its own.
          if (!next.background && plan.compose.text === 'live') next.background = res.background
        } else {
          const res = await runDecompose(
            ctx,
            { prompt: settings.prompt, sourceImage: shared.source },
            plan.decompose,
            models,
          )
          scene = res.scene
          tailNodes = res.tailNodes
          if (!next.source) next.source = res.source
        }

        const metrics = await computeMetrics(scene, collectedArtifacts, {
          matte: plan.pipeline === 'compose' ? plan.compose.matte : undefined,
          liveText: plan.pipeline === 'compose' && plan.compose.text === 'live',
        }).catch(() => undefined)

        const sceneNodeId = `n:${plan.id}:scene`
        const flattened = await sceneToPng(scene)
        upsertNode(plan.id, {
          id: sceneNodeId,
          kind: 'scene',
          label: plan.label,
          detail: `${scene.layers.length} 层 · ${scene.layers.filter((l) => l.type === 'text').length} 文字`,
          inputs: tailNodes,
          status: 'ok',
          ms: Math.round(performance.now() - startedAt),
          scene,
          metrics,
          images: [{ label: '合成结果', src: await thumbnail(flattened, 420) }],
        })

        patchBranch(plan.id, {
          status: 'ok',
          metrics,
          sceneNodeId,
          cost: branchTotals.cost,
          ms: Math.round(performance.now() - startedAt),
        })
      } catch (err) {
        const message = (err as Error).message
        const cancelled = (err as Error).name === 'Cancelled'
        if (!cancelled) setError(message)
        patchBranch(plan.id, {
          status: cancelled ? 'skipped' : 'error',
          error: cancelled ? undefined : message,
          cost: branchTotals.cost,
          ms: Math.round(performance.now() - startedAt),
        })
        if (cancelled) throw err
      }

      const cur = boardRef.current
      if (cur) {
        commit({
          ...cur,
          totalCost: cur.branches.reduce((a, b) => a + b.cost, 0),
          totalMs: cur.branches.reduce((a, b) => a + b.ms, 0),
          nodeCount: cur.nodes.length,
        })
      }

      return next
    },
    [models, settings.prompt, upsertNode, patchBranch, commit],
  )

  // ------------------------------------------------- run a whole board

  const runBoard = useCallback(
    async (plans: BranchPlan[]) => {
      if (!models || !plans.length) return
      const controller = new AbortController()
      abortRef.current = controller
      setRunning(true)
      setError(null)
      setSteps([])
      setArtifacts([])
      setHiddenBranches(new Set())
      setHiddenNodes(new Set())
      setSelectedNodeId(null)

      const fresh: Board = {
        id: newId(),
        createdAt: Date.now(),
        prompt: settings.prompt,
        branchCount: plans.length,
        nodeCount: 0,
        totalMs: 0,
        totalCost: 0,
        models,
        fromUpload: Boolean(sourceImage),
        branches: plans.map((p) => ({
          id: p.id,
          label: p.label,
          pipeline: p.pipeline,
          options: p.pipeline === 'compose' ? p.compose : p.decompose,
          status: 'skipped',
          cost: 0,
          ms: 0,
        })),
        nodes: [
          {
            id: PROMPT_NODE,
            kind: 'prompt',
            label: '提示词',
            branches: [],
            inputs: [],
            status: 'ok',
            summary: settings.prompt,
          },
        ],
      }
      commit(fresh)

      let shared: { plan?: ScenePlan; background?: string; source?: string } = {
        source: sourceImage ?? undefined,
      }

      try {
        for (let i = 0; i < plans.length; i++) {
          if (controller.signal.aborted) break
          setProgress({ label: plans[i].label, index: i + 1, total: plans.length })
          shared = await runBranch(plans[i], shared, controller.signal)
        }
      } catch {
        /* cancellation already recorded on the branch */
      } finally {
        setRunning(false)
        setProgress(null)
        abortRef.current = null
      }

      const done = boardRef.current
      if (done) {
        const sceneNode = done.nodes.find((n) => n.kind === 'scene' && n.images?.length)
        const finished: Board = { ...done, thumbnail: sceneNode?.images?.[0]?.src, nodeCount: done.nodes.length }
        commit(finished)
        await saveBoard(finished).catch(() => undefined)
      }
    },
    [models, settings.prompt, sourceImage, commit, runBranch],
  )

  const runSingle = useCallback(() => {
    const pipeline = settings.pipeline
    return runBoard([
      {
        id: 'single',
        label: pipeline === 'compose' ? `A · ${settings.compose.matte}` : `B · ${settings.decompose.useMasks ? '掩码' : 'bbox'}`,
        pipeline,
        compose: settings.compose,
        decompose: settings.decompose,
      },
    ])
  }, [runBoard, settings])

  const runBenchmark = useCallback(() => {
    const arms = VARIANTS.filter((v) => selection.includes(v.id))
    return runBoard(
      arms.map((arm) => {
        const opts = resolveOptions(arm, { compose: settings.compose, decompose: settings.decompose })
        return { id: arm.id, label: arm.label, pipeline: arm.pipeline, compose: opts.compose, decompose: opts.decompose }
      }),
    )
  }, [runBoard, selection, settings])

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
        <p className="hidden text-[11px] text-ink-400 md:block">节点画布 · 每条分支的每个中间产物</p>
        <div className="flex-1" />
        {hiddenNodes.size ? (
          <button onClick={() => setHiddenNodes(new Set())} className="font-mono text-[10px] text-ink-400 hover:text-banana-400">
            恢复 {hiddenNodes.size} 个隐藏节点
          </button>
        ) : null}
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
          第 {progress.index}/{progress.total} 条分支：{progress.label}
          <span className="ml-2 text-banana-400/70">节点会实时长到画布上</span>
        </div>
      ) : null}
      {error ? <div className="shrink-0 border-b border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs text-rose-200">{error}</div> : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_1fr]">
        <aside className="scrollbar-thin min-h-0 overflow-y-auto border-r border-ink-800 p-3">
          <Controls
            settings={settings}
            onChange={patchSettings}
            running={running}
            onRun={runSingle}
            onCancel={cancel}
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
              onRun={runBenchmark}
              composeElements={settings.compose.maxElements}
              decomposeElements={settings.decompose.maxElements}
              hasUpload={Boolean(sourceImage)}
            />
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-col">
          {board ? (
            <BranchLegend
              board={board}
              hidden={hiddenBranches}
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

          <div className="scrollbar-thin max-h-44 shrink-0 overflow-y-auto border-t border-ink-800 bg-ink-900">
            <div className="grid grid-cols-1 divide-y divide-ink-800 xl:grid-cols-2 xl:divide-x xl:divide-y-0">
              <div className="p-3">
                <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-400">当前分支步骤</h3>
                <StepLog steps={steps} />
              </div>
              <div className="min-w-0 p-3">
                <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-400">中间产物</h3>
                <ArtifactStrip artifacts={artifacts} />
              </div>
            </div>
          </div>
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
