'use client'

import { useState } from 'react'
import { DEFAULT_BUNDLE, buildDiagnosticBundle, type BundleOptions } from '@/lib/diagnostics'
import { download } from '@/lib/export'
import type { Board } from '@/lib/types'

/** Package a whole board — every node image, every layer, every config — so a
 *  wrong-looking result can be handed to someone else intact. */
export default function DiagnosticExport({ board, disabled }: { board: Board | null; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [opts, setOpts] = useState<BundleOptions>(DEFAULT_BUNDLE)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    if (!board) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const blob = await buildDiagnosticBundle(board, opts, (done, total) => setProgress({ done, total }))
      const url = URL.createObjectURL(blob)
      download(`banana-diag-${board.id}.zip`, url)
      setTimeout(() => URL.revokeObjectURL(url), 8000)
      setResult(`${(blob.size / 1024 / 1024).toFixed(1)} MB`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!board) return null

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="把这张画布的所有节点图片和配置打成 zip"
        className="rounded border border-ink-700 px-2.5 py-1 text-[11px] text-ink-200 transition hover:border-banana-500 hover:text-banana-400 disabled:opacity-40"
      >
        导出诊断包
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-ink-700 bg-ink-900 p-3 shadow-2xl shadow-black/60">
          <p className="mb-2 text-[10px] leading-relaxed text-ink-400">
            打包 <span className="text-ink-200">{board.nodes.length}</span> 个节点的图片、
            <span className="text-ink-200">{board.branches.length}</span> 条分支的逐层拆解、
            以及全部配置与指标。图片是真文件不是 JSON 里的 data URI，解开就能翻。
          </p>

          <label className="mb-2 block">
            <span className="mb-1 flex items-baseline justify-between font-mono text-[9px] uppercase text-ink-400">
              <span>图片最长边</span>
              <span className="text-ink-200">{opts.maxDim === 0 ? '原始分辨率' : `${opts.maxDim}px`}</span>
            </span>
            <input
              type="range"
              min={0}
              max={2048}
              step={256}
              value={opts.maxDim}
              onChange={(e) => setOpts((o) => ({ ...o, maxDim: Number(e.target.value) }))}
              className="w-full accent-banana-500"
            />
          </label>

          <button
            onClick={() => setOpts((o) => ({ ...o, compressOpaque: !o.compressOpaque }))}
            className={`mb-2 block w-full rounded border px-2 py-1.5 text-left transition ${
              opts.compressOpaque ? 'border-banana-500/60 bg-banana-500/10' : 'border-ink-800 hover:border-ink-600'
            }`}
          >
            <span className="flex items-center gap-2">
              <span className={`font-mono text-[11px] ${opts.compressOpaque ? 'text-banana-400' : 'text-ink-600'}`}>
                {opts.compressOpaque ? '[x]' : '[ ]'}
              </span>
              <span className={`text-[11px] ${opts.compressOpaque ? 'text-banana-400' : 'text-ink-200'}`}>
                不透明图转 JPEG
              </span>
            </span>
            <span className="mt-0.5 block pl-6 text-[10px] leading-snug text-ink-400">
              带透明的一律保持 PNG —— JPEG 会把抠好的 alpha 悄悄压平。
            </span>
          </button>

          <button
            onClick={run}
            disabled={busy}
            className="w-full rounded bg-banana-500 px-3 py-1.5 text-[11px] font-medium text-ink-950 transition hover:bg-banana-400 disabled:opacity-50"
          >
            {busy
              ? progress.total
                ? `打包中… ${progress.done}/${progress.total}`
                : '打包中…'
              : '生成并下载 zip'}
          </button>

          {result ? <p className="mt-2 text-[10px] text-emerald-400">已下载 · {result}</p> : null}
          {error ? <p className="mt-2 text-[10px] leading-snug text-rose-400">{error}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
