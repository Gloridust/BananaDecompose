'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { clearRuns, deleteRun, getRun, listRuns } from '@/lib/history'
import { StepLog } from './Panels'
import type { ComposeOptions, DecomposeOptions, Run, RunMeta } from '@/lib/types'

const MAX_COMPARE = 3

export default function HistoryView() {
  const [runs, setRuns] = useState<RunMeta[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [loaded, setLoaded] = useState<Record<string, Run>>({})

  useEffect(() => setRuns(listRuns()), [])

  useEffect(() => {
    let cancelled = false
    for (const id of picked) {
      if (loaded[id]) continue
      getRun(id).then((run) => {
        if (run && !cancelled) setLoaded((prev) => ({ ...prev, [id]: run }))
      })
    }
    return () => {
      cancelled = true
    }
  }, [picked, loaded])

  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : prev.length >= MAX_COMPARE ? prev : [...prev, id]))

  const comparing = useMemo(() => picked.map((id) => loaded[id]).filter(Boolean) as Run[], [picked, loaded])

  return (
    <main className="min-h-screen bg-ink-950">
      <header className="flex items-center gap-4 border-b border-ink-800 px-4 py-2.5">
        <Link href="/" className="font-mono text-sm font-semibold tracking-tight hover:text-banana-400">
          ← <span className="text-banana-400">Banana</span>Decompose
        </Link>
        <p className="hidden text-[11px] text-ink-400 md:block">
          勾选最多 {MAX_COMPARE} 条运行记录并排对比。索引存在 localStorage，图层数据存在 IndexedDB。
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
            }}
            className="rounded border border-ink-700 px-2.5 py-1 text-[11px] text-ink-400 hover:border-rose-500 hover:text-rose-400"
          >
            清空
          </button>
        ) : null}
      </header>

      {comparing.length ? <Compare runs={comparing} /> : null}

      <div className="p-4">
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-ink-400">全部运行 · {runs.length}</h2>
        {runs.length === 0 ? (
          <p className="text-xs text-ink-400">
            还没有记录。回到 <Link href="/" className="text-banana-400 underline">工作台</Link> 跑一次。
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {runs.map((run) => {
              const on = picked.includes(run.id)
              return (
                <li
                  key={run.id}
                  onClick={() => toggle(run.id)}
                  className={`group cursor-pointer overflow-hidden rounded-lg border transition ${
                    on ? 'border-banana-500 ring-1 ring-banana-500/40' : 'border-ink-800 hover:border-ink-600'
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
                        onClick={async (e) => {
                          e.stopPropagation()
                          await deleteRun(run.id)
                          setRuns(listRuns())
                          setPicked((p) => p.filter((id) => id !== run.id))
                        }}
                        className="rounded border border-ink-700 px-1.5 py-0.5 font-mono text-[9px] text-ink-400 hover:border-rose-500 hover:text-rose-400"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </main>
  )
}

function Compare({ runs }: { runs: Run[] }) {
  return (
    <div className="border-b border-ink-800 bg-ink-900 p-4">
      <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-ink-400">并排对比</h2>
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${runs.length}, minmax(0, 1fr))` }}>
        {runs.map((run) => (
          <article key={run.id} className="min-w-0 rounded-lg border border-ink-800 bg-ink-950">
            <div className="checker aspect-square rounded-t-lg">
              {run.thumbnail ? <img src={run.thumbnail} alt="" className="h-full w-full object-contain" /> : null}
            </div>
            <div className="space-y-2 p-3">
              <p className="text-[11px] leading-snug text-ink-200">{run.prompt}</p>

              <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[10px]">
                <Row k="管线" v={run.pipeline === 'compose' ? 'A 生成即分层' : 'B 事后拆解'} />
                <Row k="图层" v={`${run.layerCount}`} />
                <Row k="文字层" v={`${run.textLayerCount}`} />
                <Row k="耗时" v={`${(run.totalMs / 1000).toFixed(1)}s`} />
                <Row k="成本" v={`$${run.totalCost.toFixed(4)}`} />
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
        ))}
      </div>
    </div>
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
