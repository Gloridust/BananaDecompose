'use client'

import type { Board } from '@/lib/types'

const STATUS_DOT: Record<string, string> = {
  running: 'bg-banana-400 animate-pulse',
  ok: 'bg-emerald-400',
  error: 'bg-rose-400',
  skipped: 'bg-ink-600',
}

/** Branch switches. Turning branches off is how the board becomes a comparison:
 *  leave two on and everything unrelated disappears, edges included. */
export default function BranchLegend({
  board,
  hidden,
  onToggle,
  onSolo,
  onShowAll,
}: {
  board: Board
  hidden: Set<string>
  onToggle: (id: string) => void
  onSolo: (id: string) => void
  onShowAll: () => void
}) {
  if (!board.branches.length) return null
  const anyHidden = hidden.size > 0

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-ink-800 bg-ink-900 px-3 py-2">
      <span className="font-mono text-[9px] uppercase tracking-widest text-ink-400">分支</span>
      {board.branches.map((b) => {
        const off = hidden.has(b.id)
        return (
          <span key={b.id} className="group flex items-center">
            <button
              onClick={() => onToggle(b.id)}
              className={`flex items-center gap-1.5 rounded-l border py-1 pl-2 pr-1.5 text-[10px] transition ${
                off ? 'border-ink-800 text-ink-600' : 'border-ink-700 text-ink-200 hover:border-ink-600'
              }`}
              title={off ? '显示这条分支' : '隐藏这条分支'}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${off ? 'bg-ink-700' : STATUS_DOT[b.status] ?? 'bg-ink-600'}`} />
              <span className={off ? 'line-through' : ''}>{b.label}</span>
              {b.metrics?.liveText === false ? <span className="font-mono text-[8px] text-amber-400/70">OCR</span> : null}
            </button>
            <button
              onClick={() => onSolo(b.id)}
              title="只看这一条"
              className={`rounded-r border border-l-0 px-1.5 py-1 font-mono text-[9px] transition ${
                off ? 'border-ink-800 text-ink-700' : 'border-ink-700 text-ink-600 hover:text-banana-400'
              }`}
            >
              ◎
            </button>
          </span>
        )
      })}
      {anyHidden ? (
        <button onClick={onShowAll} className="ml-1 font-mono text-[9px] text-ink-400 hover:text-banana-400">
          全部显示
        </button>
      ) : null}
      <span className="ml-auto font-mono text-[9px] tabular-nums text-ink-600">
        {board.nodes.length} 节点 · ${board.totalCost.toFixed(4)} · {(board.totalMs / 1000).toFixed(1)}s
      </span>
    </div>
  )
}
