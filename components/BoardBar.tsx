'use client'

import { useEffect, useRef, useState } from 'react'
import type { Board, BoardMeta } from '@/lib/types'

/** The canvas is a document: name it, start a new one, switch between them. */
export default function BoardBar({
  board,
  boards,
  running,
  onNew,
  onOpen,
}: {
  board: Board | null
  boards: BoardMeta[]
  running: boolean
  onNew: () => void
  onOpen: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [open])

  const title = board ? board.prompt.slice(0, 28) : '空画布'

  return (
    <div ref={ref} className="relative flex min-w-0 items-center gap-1.5">
      <button
        onClick={onNew}
        disabled={running || !board}
        title="清空画布，开始新的一张"
        className="shrink-0 rounded border border-ink-700 px-2 py-1 text-[11px] text-ink-200 transition hover:border-banana-500 hover:text-banana-400 disabled:opacity-40 disabled:hover:border-ink-700 disabled:hover:text-ink-200"
      >
        + 新建画布
      </button>

      <button
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 items-center gap-1.5 rounded border border-ink-800 px-2 py-1 text-[11px] text-ink-400 transition hover:border-ink-600 hover:text-ink-200"
      >
        <span className="max-w-[220px] truncate">{title}</span>
        {board ? (
          <span className="shrink-0 font-mono text-[9px] text-ink-600">
            {board.rounds > 1 ? `${board.rounds} 轮 · ` : ''}
            {board.branches.length} 分支
          </span>
        ) : null}
        <span className="shrink-0 text-[9px]">▾</span>
      </button>

      {open ? (
        <div className="scrollbar-thin absolute left-0 top-full z-50 mt-1 max-h-[70vh] w-80 overflow-y-auto rounded-lg border border-ink-700 bg-ink-900 p-1 shadow-2xl shadow-black/60">
          {boards.length === 0 ? (
            <p className="px-2 py-3 text-[11px] text-ink-400">还没有画布。跑一次就有了。</p>
          ) : (
            boards.map((b) => (
              <button
                key={b.id}
                onClick={() => {
                  setOpen(false)
                  onOpen(b.id)
                }}
                className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition ${
                  b.id === board?.id ? 'bg-banana-500/10' : 'hover:bg-ink-800'
                }`}
              >
                <span className="checker mt-0.5 h-9 w-9 shrink-0 overflow-hidden rounded border border-ink-800">
                  {b.thumbnail ? <img src={b.thumbnail} alt="" className="h-full w-full object-contain" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[11px] ${b.id === board?.id ? 'text-banana-400' : 'text-ink-200'}`}>
                    {b.prompt}
                  </span>
                  <span className="block font-mono text-[9px] tabular-nums text-ink-600">
                    {b.branchCount} 分支 · {b.nodeCount} 节点 · ${b.totalCost.toFixed(4)} ·{' '}
                    {new Date(b.createdAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
