'use client'

import { useMemo } from 'react'
import { VARIANTS, estimate } from '@/lib/benchmark'

export default function BenchmarkPanel({
  selection,
  onSelectionChange,
  running,
  onRun,
  composeElements,
  decomposeElements,
  hasUpload,
}: {
  selection: string[]
  onSelectionChange: (ids: string[]) => void
  running: boolean
  onRun: () => void
  composeElements: number
  decomposeElements: number
  hasUpload: boolean
}) {
  const est = useMemo(
    () => estimate(selection, composeElements, decomposeElements),
    [selection, composeElements, decomposeElements],
  )

  const toggle = (id: string) =>
    onSelectionChange(selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-[10px] uppercase tracking-widest text-ink-400">一键评测</h2>
        <button
          onClick={() => onSelectionChange(selection.length === VARIANTS.length ? [] : VARIANTS.map((v) => v.id))}
          className="font-mono text-[9px] text-ink-400 hover:text-banana-400"
        >
          {selection.length === VARIANTS.length ? '全不选' : '全选'}
        </button>
      </div>

      <p className="text-[10px] leading-relaxed text-ink-400">
        用同一条提示词把选中的方案挨个跑一遍。<strong className="text-ink-200">同管线的各组共享上游产物</strong>
        —— A 组复用同一份规划，B 组复用同一张平图 —— 所以表里每一行的差异只来自被测的那个变量。
      </p>

      <ul className="space-y-1">
        {VARIANTS.map((v) => {
          const on = selection.includes(v.id)
          return (
            <li key={v.id}>
              <button
                onClick={() => toggle(v.id)}
                disabled={running}
                className={`block w-full rounded border px-2 py-1.5 text-left transition disabled:opacity-50 ${
                  on ? 'border-banana-500/60 bg-banana-500/10' : 'border-ink-800 hover:border-ink-600'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className={`font-mono text-[11px] ${on ? 'text-banana-400' : 'text-ink-600'}`}>{on ? '[x]' : '[ ]'}</span>
                  <span className={`text-[11px] ${on ? 'text-banana-400' : 'text-ink-200'}`}>{v.label}</span>
                </span>
                <span className="mt-0.5 block pl-6 text-[10px] leading-snug text-ink-400">{v.note}</span>
              </button>
            </li>
          )
        })}
      </ul>

      <div className="rounded border border-ink-800 bg-ink-900 px-2 py-1.5 font-mono text-[10px] text-ink-400">
        {est.arms} 组 · 约 {est.images} 次出图 · 粗估 ${est.usd.toFixed(2)}
        <span className="mt-0.5 block text-[9px] text-ink-600">
          按 1K 图 $0.08/张估算，实际成本以每次运行记录为准。视觉调用未计入。
        </span>
      </div>

      {hasUpload ? (
        <p className="rounded border border-ink-800 bg-ink-900 px-2 py-1.5 text-[10px] leading-snug text-ink-400">
          已上传来源图 —— B 组会全部拆你这张图，不再另外生成。
        </p>
      ) : null}

      <button
        onClick={onRun}
        disabled={running || selection.length === 0}
        className="w-full rounded border border-banana-500 bg-banana-500/15 px-3 py-2 text-xs font-medium text-banana-400 transition hover:bg-banana-500/25 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {running ? '运行中…' : `一键评测 ${est.arms} 组方案`}
      </button>
    </div>
  )
}
