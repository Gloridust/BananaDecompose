'use client'

import { METRIC_SPECS } from '@/lib/metrics'
import type { RunMetrics } from '@/lib/types'

/** Compact strip under the stage — the numbers behind the picture you just made. */
export function MetricRow({ metrics }: { metrics: RunMetrics }) {
  return (
    <div className="shrink-0 rounded-lg border border-ink-800 bg-ink-900 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-400">量化指标</span>
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-[9px] ${
            metrics.liveText ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'
          }`}
          title={metrics.liveText ? '文字从未进入像素' : '文字先烘焙进像素，再 OCR 回收'}
        >
          {metrics.liveText ? '文字未入像素' : '文字为回收'}
        </span>
        {METRIC_SPECS.map((spec) => {
          const raw = metrics[spec.key]
          const v = typeof raw === 'number' ? raw : null
          return (
            <span key={spec.key} className="font-mono text-[10px] tabular-nums" title={spec.hint}>
              <span className="text-ink-600">{spec.label} </span>
              <span className={v === null ? 'text-ink-700' : 'text-ink-50'}>{v === null ? '—' : spec.format(v)}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

/** Full table for the history page — one column per benchmark arm, best value bolded. */
export function MetricTable({ rows }: { rows: { label: string; metrics?: RunMetrics; cost: number; ms: number }[] }) {
  const best = new Map<string, number>()
  for (const spec of METRIC_SPECS) {
    if (spec.direction === 0) continue
    const vals = rows
      .map((r) => (typeof r.metrics?.[spec.key] === 'number' ? (r.metrics[spec.key] as number) : null))
      .filter((v): v is number => v !== null)
    if (vals.length > 1) best.set(spec.key, spec.direction === 1 ? Math.max(...vals) : Math.min(...vals))
  }

  return (
    <div className="scrollbar-thin overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-left font-mono text-[10px]">
        <thead>
          <tr className="border-b border-ink-800">
            <th className="py-1.5 pr-3 font-normal text-ink-600">指标</th>
            {rows.map((r, i) => (
              <th key={i} className="py-1.5 pr-3 font-normal text-ink-200">
                {r.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {METRIC_SPECS.map((spec) => (
            <tr key={spec.key} className="border-b border-ink-850">
              <th scope="row" className="py-1.5 pr-3 font-normal text-ink-600" title={spec.hint}>
                {spec.label}
                {spec.direction === 1 ? ' ↑' : spec.direction === -1 ? ' ↓' : ''}
              </th>
              {rows.map((r, i) => {
                const raw = r.metrics?.[spec.key]
                const v = typeof raw === 'number' ? raw : null
                const isBest = v !== null && best.get(spec.key) === v
                return (
                  <td
                    key={i}
                    className={`py-1.5 pr-3 tabular-nums ${
                      v === null ? 'text-ink-700' : isBest ? 'font-semibold text-emerald-300' : 'text-ink-200'
                    }`}
                  >
                    {v === null ? '—' : spec.format(v)}
                  </td>
                )
              })}
            </tr>
          ))}
          <tr className="border-b border-ink-850">
            <th scope="row" className="py-1.5 pr-3 font-normal text-ink-600">文字来源</th>
            {rows.map((r, i) => (
              <td key={i} className={`py-1.5 pr-3 ${r.metrics?.liveText ? 'text-emerald-300' : 'text-amber-300'}`}>
                {r.metrics ? (r.metrics.liveText ? '未入像素' : 'OCR 回收') : '—'}
              </td>
            ))}
          </tr>
          <tr className="border-b border-ink-850">
            <th scope="row" className="py-1.5 pr-3 font-normal text-ink-600">成本 ↓</th>
            {rows.map((r, i) => (
              <td key={i} className="py-1.5 pr-3 tabular-nums text-ink-200">
                ${r.cost.toFixed(4)}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className="py-1.5 pr-3 font-normal text-ink-600">耗时 ↓</th>
            {rows.map((r, i) => (
              <td key={i} className="py-1.5 pr-3 tabular-nums text-ink-200">
                {(r.ms / 1000).toFixed(1)}s
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  )
}
