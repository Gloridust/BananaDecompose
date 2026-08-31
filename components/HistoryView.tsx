'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { clearRuns, deleteRun, getRun, listRuns } from '@/lib/history'
import { StepLog } from './Panels'
import { MetricTable } from './Metrics'
import type { ComposeOptions, DecomposeOptions, Run, RunMeta } from '@/lib/types'

const MAX_COMPARE = 3

type Group = { id: string; runs: RunMeta[]; createdAt: number; prompt: string }

export default function HistoryView() {
  const [runs, setRuns] = useState<RunMeta[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [loaded, setLoaded] = useState<Record<string, Run>>({})
  const [openGroup, setOpenGroup] = useState<string | null>(null)

  useEffect(() => {
    setRuns(listRuns())
    const target = new URLSearchParams(window.location.search).get('benchmark')
    if (target) setOpenGroup(target)
  }, [])

  const groups = useMemo<Group[]>(() => {
    const byId = new Map<string, RunMeta[]>()
    for (const run of runs) {
      if (!run.benchmark) continue
      const list = byId.get(run.benchmark.id) ?? []
      list.push(run)
      byId.set(run.benchmark.id, list)
    }
    return [...byId.entries()]
      .map(([id, list]) => {
        const ordered = [...list].sort((a, b) => (a.benchmark!.index ?? 0) - (b.benchmark!.index ?? 0))
        return { id, runs: ordered, createdAt: Math.max(...list.map((r) => r.createdAt)), prompt: ordered[0]?.prompt ?? '' }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }, [runs])

  const need = useMemo(() => {
    const ids = new Set(picked)
    const group = groups.find((g) => g.id === openGroup)
    for (const r of group?.runs ?? []) ids.add(r.id)
    return [...ids]
  }, [picked, groups, openGroup])

  useEffect(() => {
    let cancelled = false
    for (const id of need) {
      if (loaded[id]) continue
      getRun(id).then((run) => {
        if (run && !cancelled) setLoaded((prev) => (prev[id] ? prev : { ...prev, [id]: run }))
      })
    }
    return () => {
      cancelled = true
    }
  }, [need, loaded])

  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : prev.length >= MAX_COMPARE ? prev : [...prev, id]))

  const removeRun = useCallback(async (id: string) => {
    await deleteRun(id)
    setRuns(listRuns())
    setPicked((p) => p.filter((x) => x !== id))
  }, [])

  const comparing = useMemo(() => picked.map((id) => loaded[id]).filter(Boolean) as Run[], [picked, loaded])
  const activeGroup = groups.find((g) => g.id === openGroup)

  return (
    <main className="min-h-screen bg-ink-950">
      <header className="flex items-center gap-4 border-b border-ink-800 px-4 py-2.5">
        <Link href="/" className="font-mono text-sm font-semibold tracking-tight hover:text-banana-400">
          ← <span className="text-banana-400">Banana</span>Decompose
        </Link>
        <p className="hidden text-[11px] text-ink-400 md:block">
          索引存在 localStorage，图层数据存在 IndexedDB。
        </p>
        <div className="flex-1" />
        {runs.length ? (
          <button
            onClick={async () => {
              if (!confirm(`删除全部 ${runs.length} 条运行记录？无法恢复。`)) return
              await clearRuns()
              setRuns([])
              setPicked([])
              setLoaded({})
              setOpenGroup(null)
            }}
            className="rounded border border-ink-700 px-2.5 py-1 text-[11px] text-ink-400 hover:border-rose-500 hover:text-rose-400"
          >
            清空
          </button>
        ) : null}
      </header>

      {/* ---------------- benchmark groups ---------------- */}
      {groups.length ? (
        <section className="border-b border-ink-800 p-4">
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-ink-400">评测组 · {groups.length}</h2>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {groups.map((g) => (
              <button
                key={g.id}
                onClick={() => setOpenGroup(openGroup === g.id ? null : g.id)}
                className={`rounded border px-2.5 py-1 text-left text-[10px] transition ${
                  openGroup === g.id ? 'border-banana-500 bg-banana-500/10 text-banana-400' : 'border-ink-700 text-ink-200 hover:border-ink-600'
                }`}
              >
                <span className="font-mono">{g.runs.length} 组</span>
                <span className="ml-1.5 text-ink-400">{new Date(g.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
              </button>
            ))}
          </div>

          {activeGroup ? <BenchmarkCompare group={activeGroup} loaded={loaded} /> : (
            <p className="text-[11px] text-ink-400">点一个评测组展开对比表。</p>
          )}
        </section>
      ) : null}

      {/* ---------------- ad-hoc comparison ---------------- */}
      {comparing.length ? (
        <section className="border-b border-ink-800 bg-ink-900 p-4">
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-ink-400">
            自选对比 · 最多 {MAX_COMPARE} 条
          </h2>
          <MetricTable
            rows={comparing.map((r) => ({
              label: r.benchmark?.label ?? (r.pipeline === 'compose' ? 'A 生成即分层' : 'B 事后拆解'),
              metrics: r.metrics,
              cost: r.totalCost,
              ms: r.totalMs,
            }))}
          />
          <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: `repeat(${comparing.length}, minmax(0, 1fr))` }}>
            {comparing.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        </section>
      ) : null}

      {/* ---------------- all runs ---------------- */}
      <div className="p-4">
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-ink-400">全部运行 · {runs.length}</h2>
        {runs.length === 0 ? (
          <p className="text-xs text-ink-400">
            还没有记录。回到 <Link href="/" className="text-banana-400 underline">工作台</Link> 跑一次，或者直接点一键评测。
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {runs.map((run) => (
              <RunTile key={run.id} run={run} picked={picked.includes(run.id)} onToggle={() => toggle(run.id)} onDelete={() => removeRun(run.id)} />
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}

// ---------------------------------------------------------- benchmark

function BenchmarkCompare({ group, loaded }: { group: Group; loaded: Record<string, Run> }) {
  const runs = group.runs.map((m) => loaded[m.id]).filter(Boolean) as Run[]
  const pending = group.runs.length - runs.length

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900 p-3">
      <p className="mb-3 text-[11px] leading-snug text-ink-200">{group.prompt}</p>

      {runs.length ? (
        <>
          <div className="mb-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${runs.length}, minmax(0, 1fr))` }}>
            {runs.map((run) => (
              <figure key={run.id} className="min-w-0">
                <div className="checker overflow-hidden rounded border border-ink-800">
                  {run.thumbnail ? <img src={run.thumbnail} alt="" className="aspect-square w-full object-contain" /> : null}
                </div>
                <figcaption className="mt-1 truncate text-[10px] text-ink-200" title={run.benchmark?.label}>
                  {run.benchmark?.label}
                </figcaption>
                <Link href={`/?run=${run.id}`} className="font-mono text-[9px] text-ink-600 hover:text-banana-400">
                  在工作台打开 →
                </Link>
              </figure>
            ))}
          </div>

          <MetricTable
            rows={runs.map((r) => ({
              label: r.benchmark?.label ?? r.id,
              metrics: r.metrics,
              cost: r.totalCost,
              ms: r.totalMs,
            }))}
          />

          <p className="mt-2 text-[10px] leading-snug text-ink-400">
            绿色是该行最优。<span className="text-ink-600">—</span> 表示这一项对该方案不适用：重建 PSNR/L1 需要一张原图做参照，只有拆解管线有；
            底色残留需要一个彩色键，双渲染没有单一键色。
          </p>
        </>
      ) : (
        <p className="text-[11px] text-ink-400">加载中…</p>
      )}
      {pending > 0 && runs.length ? <p className="mt-2 text-[10px] text-ink-600">还有 {pending} 组在加载…</p> : null}
    </div>
  )
}

// -------------------------------------------------------------- cards

function RunCard({ run }: { run: Run }) {
  return (
    <article className="min-w-0 rounded-lg border border-ink-800 bg-ink-950">
      <div className="checker aspect-square rounded-t-lg">
        {run.thumbnail ? <img src={run.thumbnail} alt="" className="h-full w-full object-contain" /> : null}
      </div>
      <div className="space-y-2 p-3">
        <p className="text-[11px] leading-snug text-ink-200">{run.prompt}</p>
        <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[10px]">
          <Row k="管线" v={run.pipeline === 'compose' ? 'A 生成即分层' : 'B 事后拆解'} />
          {optionRows(run).map(([k, v]) => (
            <Row key={k} k={k} v={v} />
          ))}
          <Row k="vision" v={run.models.vision.split('/').pop() ?? ''} />
          <Row k="grounding" v={run.models.grounding.split('/').pop() ?? ''} />
        </dl>
        <details className="border-t border-ink-800 pt-2">
          <summary className="cursor-pointer font-mono text-[10px] text-ink-400 hover:text-ink-200">步骤明细</summary>
          <div className="mt-2">
            <StepLog steps={run.steps} />
          </div>
        </details>
        <details>
          <summary className="cursor-pointer font-mono text-[10px] text-ink-400 hover:text-ink-200">
            中间产物 · {run.artifacts.length}
          </summary>
          <div className="scrollbar-thin mt-2 flex gap-1.5 overflow-x-auto">
            {run.artifacts.map((a, i) => (
              <figure key={i} className="w-16 shrink-0">
                <div className="checker overflow-hidden rounded border border-ink-800">
                  <img src={a.src} alt={a.label} className="h-16 w-full object-contain" />
                </div>
                <figcaption className="mt-0.5 truncate font-mono text-[8px] text-ink-600" title={a.label}>
                  {a.label}
                </figcaption>
              </figure>
            ))}
          </div>
        </details>
      </div>
    </article>
  )
}

function RunTile({ run, picked, onToggle, onDelete }: { run: RunMeta; picked: boolean; onToggle: () => void; onDelete: () => void }) {
  return (
    <li
      onClick={onToggle}
      className={`group cursor-pointer overflow-hidden rounded-lg border transition ${
        picked ? 'border-banana-500 ring-1 ring-banana-500/40' : 'border-ink-800 hover:border-ink-600'
      }`}
    >
      <div className="checker aspect-square">
        {run.thumbnail ? (
          <img src={run.thumbnail} alt="" className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-[10px] text-ink-600">缩略图已清理</div>
        )}
      </div>
      <div className="space-y-1 p-2">
        <div className="flex items-center gap-1.5">
          <span
            className={`rounded px-1 font-mono text-[9px] ${
              run.pipeline === 'compose' ? 'bg-sky-500/20 text-sky-300' : 'bg-violet-500/20 text-violet-300'
            }`}
          >
            {run.pipeline === 'compose' ? 'A' : 'B'}
          </span>
          {run.failed ? <span className="rounded bg-rose-500/20 px-1 font-mono text-[9px] text-rose-300">失败</span> : null}
          <span className="ml-auto font-mono text-[9px] tabular-nums text-ink-600">
            {run.layerCount}L / {run.textLayerCount}T
          </span>
        </div>
        {run.benchmark ? (
          <p className="truncate rounded bg-banana-500/10 px-1 font-mono text-[9px] text-banana-400" title={run.benchmark.label}>
            {run.benchmark.label}
          </p>
        ) : null}
        <p className="line-clamp-2 text-[10px] leading-snug text-ink-200">{run.prompt}</p>
        <p className="font-mono text-[9px] tabular-nums text-ink-600">
          ${run.totalCost.toFixed(4)} · {(run.totalMs / 1000).toFixed(1)}s
        </p>
        <div className="flex gap-1 pt-0.5">
          <Link
            href={`/?run=${run.id}`}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 rounded border border-ink-700 py-0.5 text-center font-mono text-[9px] text-ink-400 hover:border-banana-500 hover:text-banana-400"
          >
            打开
          </Link>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="rounded border border-ink-700 px-1.5 py-0.5 font-mono text-[9px] text-ink-400 hover:border-rose-500 hover:text-rose-400"
          >
            ✕
          </button>
        </div>
      </div>
    </li>
  )
}

function optionRows(run: Run): [string, string][] {
  if (run.pipeline === 'compose') {
    const o = run.options as ComposeOptions
    return [
      ['抠图', o.matte],
      ['文字', o.text === 'live' ? '不入像素' : '烘焙回收'],
      ['比例', `${o.aspectRatio} ${o.resolution}`],
    ]
  }
  const o = run.options as DecomposeOptions
  return [
    ['掩码', o.useMasks ? '开' : '关'],
    ['重绘背景', o.inpaintBackground ? '开' : '关'],
    ['比例', `${o.aspectRatio} ${o.resolution}`],
  ]
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="truncate text-ink-600">{k}</dt>
      <dd className="truncate text-right text-ink-200">{v}</dd>
    </>
  )
}
