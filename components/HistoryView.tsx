'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { clearBoards, deleteBoard, getBoard, listBoards } from '@/lib/history'
import { MetricTable } from './Metrics'
import type { Board, BoardMeta, ComposeOptions, DecomposeOptions } from '@/lib/types'

/** Each record is one whole canvas: every branch, every node, every intermediate. */
export default function HistoryView() {
  const [boards, setBoards] = useState<BoardMeta[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Record<string, Board>>({})

  useEffect(() => {
    const list = listBoards()
    setBoards(list)
    const target = new URLSearchParams(window.location.search).get('board') ?? list[0]?.id ?? null
    setOpenId(target)
  }, [])

  useEffect(() => {
    if (!openId || loaded[openId]) return
    let cancelled = false
    getBoard(openId).then((b) => {
      if (b && !cancelled) setLoaded((prev) => ({ ...prev, [openId]: b }))
    })
    return () => {
      cancelled = true
    }
  }, [openId, loaded])

  const remove = useCallback(
    async (id: string) => {
      await deleteBoard(id)
      const next = listBoards()
      setBoards(next)
      setOpenId((cur) => (cur === id ? (next[0]?.id ?? null) : cur))
    },
    [],
  )

  const open = openId ? loaded[openId] : undefined

  return (
    <main className="min-h-screen bg-ink-950">
      <header className="flex items-center gap-4 border-b border-ink-800 px-4 py-2.5">
        <Link href="/" className="font-mono text-sm font-semibold tracking-tight hover:text-banana-400">
          ← <span className="text-banana-400">Banana</span>Decompose
        </Link>
        <p className="hidden text-[11px] text-ink-400 md:block">
          一条记录 = 一整张画布。索引存 localStorage，节点数据存 IndexedDB。
        </p>
        <div className="flex-1" />
        {boards.length ? (
          <button
            onClick={async () => {
              if (!confirm(`删除全部 ${boards.length} 张画布？无法恢复。`)) return
              await clearBoards()
              setBoards([])
              setOpenId(null)
              setLoaded({})
            }}
            className="rounded border border-ink-700 px-2.5 py-1 text-[11px] text-ink-400 hover:border-rose-500 hover:text-rose-400"
          >
            清空
          </button>
        ) : null}
      </header>

      <div className="p-4">
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-ink-400">画布 · {boards.length}</h2>
        {boards.length === 0 ? (
          <p className="text-xs text-ink-400">
            还没有记录。回到 <Link href="/" className="text-banana-400 underline">工作台</Link> 跑一次，或者直接一键评测。
          </p>
        ) : (
          <ul className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {boards.map((b) => (
              <BoardTile
                key={b.id}
                meta={b}
                active={openId === b.id}
                onOpen={() => setOpenId(b.id)}
                onDelete={() => remove(b.id)}
              />
            ))}
          </ul>
        )}

        {open ? <BoardDetail board={open} /> : openId ? <p className="text-xs text-ink-400">加载中…</p> : null}
      </div>
    </main>
  )
}

function BoardTile({
  meta,
  active,
  onOpen,
  onDelete,
}: {
  meta: BoardMeta
  active: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <li
      onClick={onOpen}
      className={`group cursor-pointer overflow-hidden rounded-lg border transition ${
        active ? 'border-banana-500 ring-1 ring-banana-500/40' : 'border-ink-800 hover:border-ink-600'
      }`}
    >
      <div className="checker aspect-square">
        {meta.thumbnail ? (
          <img src={meta.thumbnail} alt="" className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-[10px] text-ink-600">无预览</div>
        )}
      </div>
      <div className="space-y-1 p-2">
        <div className="flex items-center gap-1.5 font-mono text-[9px]">
          <span className="rounded bg-banana-500/15 px-1 text-banana-400">{meta.branchCount} 分支</span>
          <span className="text-ink-600">{meta.nodeCount} 节点</span>
          {meta.fromUpload ? <span className="text-violet-300">上传</span> : null}
        </div>
        <p className="line-clamp-2 text-[10px] leading-snug text-ink-200">{meta.prompt}</p>
        <p className="font-mono text-[9px] tabular-nums text-ink-600">
          ${meta.totalCost.toFixed(4)} · {(meta.totalMs / 1000).toFixed(1)}s
        </p>
        <div className="flex gap-1 pt-0.5">
          <Link
            href={`/?board=${meta.id}`}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 rounded border border-ink-700 py-0.5 text-center font-mono text-[9px] text-ink-400 hover:border-banana-500 hover:text-banana-400"
          >
            在画布打开
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

function BoardDetail({ board }: { board: Board }) {
  const scenes = useMemo(
    () => board.branches.map((b) => ({ branch: b, node: board.nodes.find((n) => n.id === b.sceneNodeId) })),
    [board],
  )
  const shared = useMemo(() => board.nodes.filter((n) => n.branches.length > 1), [board])

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900 p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <h3 className="font-mono text-[10px] uppercase tracking-widest text-ink-400">画布详情</h3>
        <p className="min-w-0 flex-1 truncate text-[11px] text-ink-200">{board.prompt}</p>
        <Link href={`/?board=${board.id}`} className="shrink-0 font-mono text-[10px] text-banana-400 hover:underline">
          在画布上打开 →
        </Link>
      </div>

      {scenes.some((s) => s.node) ? (
        <div className="mb-4 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(scenes.length, 7)}, minmax(0, 1fr))` }}>
          {scenes.map(({ branch, node }) => (
            <figure key={branch.id} className="min-w-0">
              <div className="checker aspect-square overflow-hidden rounded border border-ink-800">
                {node?.images?.[0] ? (
                  <img src={node.images[0].src} alt="" className="h-full w-full object-contain" />
                ) : (
                  <div className="flex h-full items-center justify-center px-1 text-center font-mono text-[8px] text-ink-600">
                    {branch.status === 'error' ? '失败' : '无结果'}
                  </div>
                )}
              </div>
              <figcaption className="mt-1 truncate text-[10px] text-ink-200" title={branch.label}>
                {branch.label}
              </figcaption>
              <p className="truncate font-mono text-[8px] text-ink-600">{optionSummary(branch.options, branch.pipeline)}</p>
            </figure>
          ))}
        </div>
      ) : null}

      <MetricTable
        rows={board.branches.map((b) => ({ label: b.label, metrics: b.metrics, cost: b.cost, ms: b.ms }))}
      />

      {shared.length ? (
        <p className="mt-3 text-[10px] leading-snug text-ink-400">
          <span className="text-ink-200">共享上游 {shared.length} 个节点</span>：
          {shared.map((n) => `${n.label}（${n.branches.length} 条分支共用）`).join('、')}
          。这些只生成了一次 —— 所以表里每一行的差异只来自被测的那个变量。
        </p>
      ) : null}

      <p className="mt-2 text-[10px] leading-snug text-ink-400">
        绿色是该行最优。<span className="text-ink-600">—</span> 表示不适用：重建 PSNR/L1 需要原图做参照，只有拆解管线有；
        底色残留需要一个彩色键，双渲染没有单一键色。
      </p>
    </section>
  )
}

function optionSummary(options: ComposeOptions | DecomposeOptions, pipeline: string) {
  if (pipeline === 'compose') {
    const o = options as ComposeOptions
    return `${o.matte} · ${o.text === 'live' ? '文字未入像素' : '文字回收'}`
  }
  const o = options as DecomposeOptions
  return `掩码${o.useMasks ? '开' : '关'} · ${o.fitGlyphs ? '字形贴合' : '模型框'} · ${o.textMode === 'pixel' ? '原始笔画' : '重排'}`
}
